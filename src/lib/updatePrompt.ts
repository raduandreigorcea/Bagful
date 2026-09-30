import { nextTick, ref, type InjectionKey, type Ref } from 'vue'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { hasOpenModal } from './modalStack'
import {
  AppInstallerPlugin,
  RELEASES_PAGE_URL,
  compareVersions,
  fetchLatestRelease,
  findUpdate,
  skipVersion,
  type AvailableUpdate,
} from './nativeUpdate'

// The dialog state around lib/nativeUpdate: what the user sees while an APK is
// being fetched and handed to Android's installer.
//
// It is a small state machine rather than a boolean because the install can stop
// in a place that is nobody's fault and needs a different sentence: Android has
// not been told Bagful may install packages, and that consent lives on a
// settings screen rather than in a dialog we can raise. Treating that as an
// error would tell the user something is broken when the truth is that one
// switch is off, so it gets its own phase and its own button.
//
// Same shape as lib/firstRunGreeting: this owns the state, the view renders it.

// How Settings reaches the check without four layers of props between them.
// HomeView owns the prompt; the row that runs it lives in AppSettingsModal,
// which is two components down inside AppNavBar. Provided rather than passed,
// because nothing in between has any business knowing about app updates.
export const updateCheckKey = Symbol('famcart-update-check') as InjectionKey<
  () => Promise<'found' | 'up-to-date' | 'failed'>
>

export type UpdatePhase =
  // A new version exists; the user has not answered yet.
  | 'available'
  // Android needs "install unknown apps" for Bagful before this can go on.
  | 'permission'
  | 'downloading'
  // Handed over. The installer is on screen and this process is about to be
  // replaced, so there is no later phase than this one.
  | 'installing'
  | 'error'

export interface UpdatePrompt {
  updateOpen: Ref<boolean>
  updatePhase: Ref<UpdatePhase>
  updateVersion: Ref<string>
  /** 0–1 through the download, or -1 when the server sent no Content-Length. */
  updateProgress: Ref<number>
  /** Look for a newer release and open the dialog if there is one. */
  start: () => Promise<void>
  /**
   * The same look, asked for by hand from Settings.
   *
   * Reports what happened rather than just opening a dialog, because a check the
   * user pressed a button for owes them an answer either way — and "you're up to
   * date" is a lie when the truth is that GitHub could not be reached.
   */
  checkNow: () => Promise<'found' | 'up-to-date' | 'failed'>
  install: () => Promise<void>
  openInstallSettings: () => Promise<void>
  openReleasesPage: () => Promise<void>
  dismiss: () => void
}

export function useUpdatePrompt(options: {
  currentVersion: string
  storage?: Storage
}): UpdatePrompt {
  const storage = options.storage ?? localStorage

  const updateOpen = ref(false)
  const updatePhase = ref<UpdatePhase>('available')
  const updateVersion = ref('')
  const updateProgress = ref(-1)

  let pending: AvailableUpdate | null = null
  let resumeListener: { remove: () => Promise<void> } | null = null

  async function start(): Promise<void> {
    // Never interrupt an install already under way — start() runs whenever the
    // list finishes loading, which includes the reload after a list switch.
    if (updateOpen.value) return

    // The caller runs this the moment the first-run sequence settles, which is
    // typically the same tick as the last of its dialogs being told to close.
    // AppModal leaves the modal stack on a watcher, so without waiting for that
    // flush the stack still holds a dialog that is on its way out, and the guard
    // below would stand down for a screen that is about to be empty.
    await nextTick()

    // Something genuinely on screen — a dialog the user opened themselves, or
    // the error dialog the notifications ask can end on. Nothing is recorded, so
    // the next check offers again.
    if (hasOpenModal()) return

    const update = await findUpdate({
      currentVersion: options.currentVersion,
      storage,
    })
    if (!update) return
    // Raced with a dialog opened while the release was being fetched. Nothing is
    // recorded as declined, so the next check offers it again.
    if (hasOpenModal()) return

    offer(update)
  }

  function offer(update: AvailableUpdate): void {
    pending = update
    updateVersion.value = update.version
    updatePhase.value = 'available'
    updateProgress.value = -1
    updateOpen.value = true
  }

  async function checkNow(): Promise<'found' | 'up-to-date' | 'failed'> {
    // Deliberately not findUpdate(): every gate that one applies is a reason to
    // stay quiet, and there is nothing to stay quiet about when the user has just
    // asked. The interval does not apply, and neither does a version they
    // declined earlier — pressing this is how someone changes their mind.
    const latest = await fetchLatestRelease()
    if (!latest) return 'failed'
    if (compareVersions(latest.version, options.currentVersion) <= 0) return 'up-to-date'

    offer(latest)
    return 'found'
  }

  async function install(): Promise<void> {
    if (!pending) return

    // Ask before downloading 30 MB the user may not be able to install at the
    // end of it. The check is cheap; the download is not.
    try {
      const { granted } = await AppInstallerPlugin.canInstall()
      if (!granted) {
        updatePhase.value = 'permission'
        return
      }
    } catch {
      // No plugin — an old APK running new web assets, which is exactly the
      // situation this feature exists to end. Send them to the releases page.
      updatePhase.value = 'error'
      return
    }

    updatePhase.value = 'downloading'
    updateProgress.value = -1

    const listener = await AppInstallerPlugin.addListener('downloadProgress', (event) => {
      updateProgress.value = event.total > 0 ? event.loaded / event.total : -1
    }).catch(() => null)

    // Registered before the handover, because the resume it is waiting for can
    // arrive the moment the installer closes.
    await watchForAbandonedInstall()

    try {
      await AppInstallerPlugin.downloadAndInstall({ url: pending.apkUrl })
      // The installer is up. Everything from here is Android's, including
      // whether the user goes through with it — so the dialog stays put rather
      // than closing.
      updatePhase.value = 'installing'
    } catch {
      updatePhase.value = 'error'
      await stopWatchingForAbandonedInstall()
    } finally {
      await listener?.remove().catch(() => {})
    }
  }

  /**
   * Put the offer back when the user backs out of the system installer.
   *
   * There is no callback for that — handing the APK to Android is the end of
   * what this app is told. But a *completed* install replaces this process, so
   * it never returns here at all: being resumed while still on 'installing' can
   * only mean the install did not happen. Without this the dialog sits there
   * claiming Android is taking over, offering nothing but a Close button, when
   * nothing is happening and the app is still on the old version.
   */
  async function watchForAbandonedInstall(): Promise<void> {
    if (resumeListener) return
    resumeListener = await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive || updatePhase.value !== 'installing') return
      updatePhase.value = 'available'
      updateProgress.value = -1
      void stopWatchingForAbandonedInstall()
    }).catch(() => null)
  }

  async function stopWatchingForAbandonedInstall(): Promise<void> {
    const listener = resumeListener
    resumeListener = null
    await listener?.remove().catch(() => {})
  }

  async function openInstallSettings(): Promise<void> {
    try {
      await AppInstallerPlugin.openInstallSettings()
      // Back on the dialog after granting, the button they came from is the one
      // to press again — so return to the offer rather than to the explanation.
      updatePhase.value = 'available'
    } catch {
      updatePhase.value = 'error'
    }
  }

  async function openReleasesPage(): Promise<void> {
    try {
      await Browser.open({ url: RELEASES_PAGE_URL })
    } catch {
      // noopener so the opened tab gets no window.opener handle back into this
      // one. The URL is a constant pointing at our own releases page, so this is
      // hygiene rather than a hole being closed — but a fallback path is exactly
      // where a URL stops being a constant one day.
      window.open(RELEASES_PAGE_URL, '_blank', 'noopener,noreferrer')
    }
  }

  function dismiss(): void {
    updateOpen.value = false
    // Only a deliberate "Later" silences a version. Closing the dialog after an
    // install has been launched must not: if the user then backs out of the
    // system installer they are still on the old build, and nothing would ever
    // offer them this version again.
    if (updatePhase.value === 'available' && pending) {
      skipVersion(storage, pending.version)
    }
  }

  return {
    updateOpen,
    updatePhase,
    updateVersion,
    updateProgress,
    start,
    checkNow,
    install,
    openInstallSettings,
    openReleasesPage,
    dismiss,
  }
}
