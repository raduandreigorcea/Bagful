// Telling the Android app that a newer build exists, and installing it.
//
// The web app updates itself — a deploy lands, the service worker picks it up
// and lib/appUpdate.ts reloads the page (see the note there). The APK cannot do
// any of that. Its web assets are baked into the package, so the only way to a
// newer version is a new APK, and until now the only way to a new APK was to
// know that releases exist, open GitHub on a phone, and find the download.
//
// WHERE "NEWEST" COMES FROM
//
// The Android APK workflow publishes every master build to one rolling release
// tagged `latest`, whose *name* carries the version ("Bagful v0.1.23") and
// whose asset is Bagful.apk. That release is therefore the only honest answer
// to "is there a newer app": it exists exactly when a downloadable APK exists.
//
// Deliberately NOT the version deployed to the web app, which is the other thing
// we could have asked. The web deploy and the APK build are triggered by the
// same push but are not the same job — a web deploy that succeeds while the APK
// build fails would advertise a version with no APK behind it, and the update
// button would 404.
//
// api.github.com answers with `Access-Control-Allow-Origin: *`, so the WebView
// can make this call directly with no proxy of our own in between. The APK
// download itself is done natively (see AppInstallerPlugin.java) where CORS does
// not apply at all.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { IS_NIGHTLY } from './appChannel'

const RELEASE_API_URL =
  'https://api.github.com/repos/raduandreigorcea/Bagful/releases/latest'

// The releases page, offered as a way out when the in-app install cannot run.
export const RELEASES_PAGE_URL =
  'https://github.com/raduandreigorcea/Bagful/releases/latest'

// A version the user said "Later" to. Re-prompting on the next launch for a
// version already declined is nagging; a *newer* version than the declined one
// is news, so this stores the version rather than a boolean.
//
// Kebab-case like every other key this app writes (bagful-theme,
// bagful-last-user, bagful-offline-queue, bagful-household-snapshot). These
// two were the only snake_case ones, which meant the storage surface needed two
// grep patterns to enumerate — and the pair was duly missed when auditing what
// signing out clears.
const SKIPPED_VERSION_KEY = 'bagful-update-skipped-version'

// The GitHub API allows 60 unauthenticated requests an hour per IP, shared by
// everyone in the house behind one router. Checking on every single app open
// would be well inside that in practice and pointlessly close to it in theory —
// builds land a few times a day at most, so a few hours between checks loses
// nothing a user would notice.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

// When the last check found nothing — deliberately not "when we last checked".
// A check that turns up a newer version does not write this at all, because the
// interval exists to keep quiet, not to sit on news (see findUpdate).
//
// Renamed from bagful_update_last_check, which recorded the other fact. Any
// value left under the old name is stale by definition and is simply ignored,
// which is the point of moving rather than reusing it.
//
// Kebab now, for the reason above. No fallback read for this one, deliberately:
// all it can say is "we looked recently and found nothing", and losing that
// costs exactly one extra release check on one launch. Carrying a migration for
// it would be more machinery than the fact is worth.
const QUIET_SINCE_KEY = 'bagful-update-quiet-since'

export interface AvailableUpdate {
  version: string
  apkUrl: string
}

/** The native half: downloads the APK and hands it to Android's installer. */
export interface AppInstaller {
  /**
   * Whether Android will let Bagful install a package right now. Since Android
   * 8 "install unknown apps" is granted per app rather than device-wide, and it
   * cannot be requested from a dialog — only by sending the user to a settings
   * screen.
   */
  canInstall(): Promise<{ granted: boolean }>
  /** Opens that settings screen for Bagful. */
  openInstallSettings(): Promise<void>
  /**
   * Downloads `url` and launches the system installer for it. Resolves when the
   * installer has been handed the package, not when the install finishes — from
   * that point on the app is being replaced and this process is about to die.
   */
  downloadAndInstall(options: { url: string }): Promise<void>
  addListener(
    eventName: 'downloadProgress',
    handler: (event: { loaded: number; total: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

export const AppInstallerPlugin = registerPlugin<AppInstaller>('AppInstaller')

/**
 * Ordering for `major.minor.patch`, ignoring anything after it.
 *
 * String comparison is wrong here in a way that only shows up later: "0.1.9" >
 * "0.1.10". The patch number moves on every commit (see .githooks/pre-commit),
 * so that boundary is crossed within days of shipping, not eventually.
 */
export function compareVersions(a: string, b: string): number {
  // Typed as a triple rather than number[], so the loop below indexes something
  // the compiler agrees is always there. All three groups are unconditional in
  // the pattern, so a match that succeeded has all of them.
  const parse = (value: string): [number, number, number] => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(value)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
  }
  // Destructured rather than indexed in a loop. A tuple indexed by a general
  // `number` is still `number | undefined` to the compiler, which is right --
  // it cannot see that the bound is 3 -- and three named comparisons say what
  // the loop said without asserting anything away.
  const [aMajor, aMinor, aPatch] = parse(a)
  const [bMajor, bMinor, bPatch] = parse(b)
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1
  return 0
}

/**
 * The version and APK of the current `latest` release, or null if the release
 * cannot be read.
 *
 * Every failure here is a null rather than a throw. Not being able to reach
 * GitHub is the normal state of a phone on a train, and it says nothing about
 * whether the app is out of date — so the caller has nothing to tell the user
 * either way, and the next launch asks again.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableUpdate | null> {
  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return null
    const release = (await response.json()) as {
      name?: string
      assets?: { name?: string; browser_download_url?: string }[]
    }

    // The version lives in the release NAME because the tag cannot carry it: the
    // tag stays `latest` forever so the download URL never moves. The workflow
    // that writes that name and this regex are one contract in two files.
    const version = /(\d+\.\d+\.\d+)/.exec(release.name ?? '')?.[1]
    if (!version) return null

    const apkUrl = (release.assets ?? []).find((asset) =>
      asset.name?.toLowerCase().endsWith('.apk'),
    )?.browser_download_url
    if (!apkUrl) return null

    return { version, apkUrl }
  } catch {
    // Offline, DNS, a rate-limit body that isn't JSON. Nothing to report.
    return null
  }
}

function readSkippedVersion(storage: Storage): string {
  try {
    return storage.getItem(SKIPPED_VERSION_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Remember that this version was declined, so only a newer one asks again. */
export function skipVersion(storage: Storage, version: string): void {
  try {
    storage.setItem(SKIPPED_VERSION_KEY, version)
  } catch {
    // Storage disabled: the prompt reappears next launch. Mildly annoying,
    // never broken.
  }
}

function dueForCheck(storage: Storage, now: number): boolean {
  try {
    const last = Number(storage.getItem(QUIET_SINCE_KEY))
    if (!Number.isFinite(last) || last <= 0) return true
    // A clock that has moved backwards (timezone edit, NTP correction) would
    // otherwise park the next check arbitrarily far in the future.
    if (last > now) return true
    return now - last >= CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

function markChecked(storage: Storage, now: number): void {
  try {
    storage.setItem(QUIET_SINCE_KEY, String(now))
  } catch {
    // Without a record we check on every launch. Still correct, just chattier.
  }
}

/** Whether this build can install another one over itself. */
export function canSelfUpdate(): boolean {
  // Android only. On the web there is nothing to install — the service worker
  // already replaced the build behind the user's back — and on a desktop browser
  // the plugin does not exist.
  //
  // And production only. The release this module reads holds the production
  // APK, which carries a different application id than the nightly build and so
  // cannot update it; Android would install it as a second app while the user
  // believed they had just updated this one. The nightly channel has no release
  // feed of its own yet, so it does not offer updates at all: the About dialog
  // drops its check row with this, since canCheckForUpdates is built on it.
  return !IS_NIGHTLY && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * The update worth showing a dialog about on startup, or null.
 *
 * Every gate here is a reason to stay quiet, which is right for a check nobody
 * asked for. A check the user pressed a button for wants none of them, and goes
 * through fetchLatestRelease directly instead — see checkNow in lib/updatePrompt.
 */
export async function findUpdate(options: {
  currentVersion: string
  storage?: Storage
  fetchImpl?: typeof fetch
  now?: number
}): Promise<AvailableUpdate | null> {
  const storage = options.storage ?? localStorage
  const now = options.now ?? Date.now()

  if (!canSelfUpdate()) return null
  if (!dueForCheck(storage, now)) return null

  const latest = await fetchLatestRelease(options.fetchImpl ?? fetch)
  // Only a check that got an answer counts. Marking a failed one would put the
  // next attempt four hours out for a phone that was offline for ten seconds.
  if (!latest) return null

  // The interval is for the quiet case only. Once a newer version is known to
  // exist, waiting is the wrong instinct: someone who backs out of the system
  // installer, or force-quits mid-download, has not decided anything, and four
  // hours of silence afterwards is four hours of running a version they were
  // already trying to replace. Declining is what silences a version, and that is
  // remembered separately and permanently.
  if (compareVersions(latest.version, options.currentVersion) <= 0) {
    markChecked(storage, now)
    return null
  }

  if (compareVersions(latest.version, readSkippedVersion(storage)) <= 0) return null

  return latest
}
