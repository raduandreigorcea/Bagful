// @vitest-environment happy-dom
//
// What the update dialog does between "there's a new version" and the system
// installer taking over.
//
// The cases that earn their place are the ones where the obvious behaviour is
// wrong. Downloading 30 MB before finding out Android won't allow the install.
// Recording "don't ask again" when the dialog closes after an install was
// launched — a user who then backs out of the installer would never be offered
// that version again. And opening over a first-run dialog that is mid-sequence.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUpdatePrompt } from '../src/lib/updatePrompt'

const native = vi.hoisted(() => ({
  update: null,
  latest: null,
  granted: true,
  canInstallThrows: false,
  installThrows: false,
  progressHandler: null,
  resumeHandler: null,
  listenerRemoved: false,
  skipped: [],
  settingsOpened: 0,
}))

const modals = vi.hoisted(() => ({ open: false }))

vi.mock('../src/lib/modalStack', () => ({
  hasOpenModal: () => modals.open,
}))

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (_event, handler) => {
      native.resumeHandler = handler
      return {
        remove: async () => {
          native.resumeHandler = null
        },
      }
    },
  },
}))

vi.mock('../src/lib/nativeUpdate', async () => ({
  // The real ordering rather than a stand-in: checkNow decides what to report
  // with it, and a hand-written copy here could agree with a wrong answer.
  compareVersions: (await vi.importActual('../src/lib/nativeUpdate')).compareVersions,
  RELEASES_PAGE_URL: 'https://releases.test',
  findUpdate: async () => native.update,
  fetchLatestRelease: async () => native.latest,
  skipVersion: (_storage, version) => native.skipped.push(version),
  AppInstallerPlugin: {
    canInstall: async () => {
      if (native.canInstallThrows) throw new Error('no plugin')
      return { granted: native.granted }
    },
    openInstallSettings: async () => {
      native.settingsOpened += 1
    },
    downloadAndInstall: async () => {
      if (native.installThrows) throw new Error('download failed')
    },
    addListener: async (_event, handler) => {
      native.progressHandler = handler
      return {
        remove: async () => {
          native.listenerRemoved = true
        },
      }
    },
  },
}))

function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

function makePrompt() {
  return useUpdatePrompt({ currentVersion: '0.1.23', storage: fakeStorage() })
}

beforeEach(() => {
  native.update = { version: '0.1.24', apkUrl: 'https://x/Bagful.apk' }
  native.latest = { version: '0.1.24', apkUrl: 'https://x/Bagful.apk' }
  native.granted = true
  native.canInstallThrows = false
  native.installThrows = false
  native.progressHandler = null
  native.resumeHandler = null
  native.listenerRemoved = false
  native.skipped = []
  native.settingsOpened = 0
  modals.open = false
})

describe('useUpdatePrompt', () => {
  it('opens on a newer version', async () => {
    const prompt = makePrompt()
    await prompt.start()
    expect(prompt.updateOpen.value).toBe(true)
    expect(prompt.updateVersion.value).toBe('0.1.24')
    expect(prompt.updatePhase.value).toBe('available')
  })

  it('stays shut when there is nothing newer', async () => {
    native.update = null
    const prompt = makePrompt()
    await prompt.start()
    expect(prompt.updateOpen.value).toBe(false)
  })

  it('stands down while another dialog is on screen', async () => {
    // The first-run tour and the notifications ask are a sequence a new user is
    // in the middle of. Nothing is recorded, so the next check offers again.
    modals.open = true
    const prompt = makePrompt()
    await prompt.start()
    expect(prompt.updateOpen.value).toBe(false)
    expect(native.skipped).toEqual([])
  })

  it('waits out a dialog that is already closing', async () => {
    // AppModal leaves the modal stack on a Vue watcher, so in the tick where the
    // first-run sequence hands over, the dialog it just closed is still on the
    // stack. Reading the stack in that tick is what made the offer stand down
    // for a screen that was about to be empty.
    modals.open = true
    Promise.resolve().then(() => {
      modals.open = false
    })

    const prompt = makePrompt()
    await prompt.start()
    expect(prompt.updateOpen.value).toBe(true)
  })

  it('does not reopen over an install already running', async () => {
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()
    expect(prompt.updatePhase.value).toBe('installing')

    await prompt.start()
    expect(prompt.updatePhase.value).toBe('installing')
  })

  it('puts the offer back when the user backs out of the installer', async () => {
    // Android tells the app nothing about a cancelled install. But a completed
    // one replaces the process, so being resumed while still on 'installing' can
    // only mean it did not happen — and the dialog must stop claiming otherwise.
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()
    expect(prompt.updatePhase.value).toBe('installing')

    native.resumeHandler?.({ isActive: true })

    expect(prompt.updatePhase.value).toBe('available')
    expect(prompt.updateOpen.value).toBe(true)
    // Nothing was declined, so the offer is still live rather than silenced.
    expect(native.skipped).toEqual([])
  })

  it('ignores the app merely being backgrounded', async () => {
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()

    native.resumeHandler?.({ isActive: false })

    expect(prompt.updatePhase.value).toBe('installing')
  })

  it('asks for the install permission before downloading anything', async () => {
    native.granted = false
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()

    expect(prompt.updatePhase.value).toBe('permission')
    // The download never started: no progress listener was ever attached.
    expect(native.progressHandler).toBeNull()
  })

  it('returns to the offer after sending the user to settings', async () => {
    native.granted = false
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()
    await prompt.openInstallSettings()

    expect(native.settingsOpened).toBe(1)
    expect(prompt.updatePhase.value).toBe('available')
  })

  it('reports progress and hands over to the installer', async () => {
    const prompt = makePrompt()
    await prompt.start()

    const installing = prompt.install()
    // The listener is attached before the download is awaited, so a progress
    // event mid-download lands while the dialog is still on 'downloading'.
    await Promise.resolve()
    native.progressHandler?.({ loaded: 50, total: 200 })
    expect(prompt.updateProgress.value).toBeCloseTo(0.25)

    await installing
    expect(prompt.updatePhase.value).toBe('installing')
    expect(native.listenerRemoved).toBe(true)
  })

  it('marks progress unknown when the server sent no size', async () => {
    const prompt = makePrompt()
    await prompt.start()
    const installing = prompt.install()
    await Promise.resolve()
    native.progressHandler?.({ loaded: 50, total: 0 })
    expect(prompt.updateProgress.value).toBe(-1)
    await installing
  })

  it('offers a way out when the download fails', async () => {
    native.installThrows = true
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()

    expect(prompt.updatePhase.value).toBe('error')
    expect(native.listenerRemoved).toBe(true)
  })

  it('falls back to the releases page when the plugin is missing', async () => {
    // An old APK running new web assets — the exact situation this feature is
    // meant to end, and the one where it cannot help itself.
    native.canInstallThrows = true
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()
    expect(prompt.updatePhase.value).toBe('error')
  })

  describe('checking by hand', () => {
    it('opens the offer and says so', async () => {
      const prompt = makePrompt()
      expect(await prompt.checkNow()).toBe('found')
      expect(prompt.updateOpen.value).toBe(true)
      expect(prompt.updateVersion.value).toBe('0.1.24')
      expect(prompt.updatePhase.value).toBe('available')
    })

    it('reports being up to date', async () => {
      native.latest = { version: '0.1.23', apkUrl: 'https://x/Bagful.apk' }
      const prompt = makePrompt()
      expect(await prompt.checkNow()).toBe('up-to-date')
      expect(prompt.updateOpen.value).toBe(false)
    })

    it('does not claim you are up to date when it could not ask', async () => {
      // The distinction the automatic check has no use for and this one does:
      // "nothing newer" and "could not reach GitHub" are different answers, and
      // only one of them is reassuring.
      native.latest = null
      const prompt = makePrompt()
      expect(await prompt.checkNow()).toBe('failed')
      expect(prompt.updateOpen.value).toBe(false)
    })

    it('is the way back from a dismissal', async () => {
      // Back on the dialog declines a version for good. This is the only route
      // that ignores that, which is the whole reason it exists.
      const prompt = makePrompt()
      await prompt.start()
      prompt.dismiss()
      expect(native.skipped).toEqual(['0.1.24'])

      expect(await prompt.checkNow()).toBe('found')
      expect(prompt.updateOpen.value).toBe(true)
    })

    it('ignores a screen that is busy, unlike the startup check', async () => {
      modals.open = true
      const prompt = makePrompt()
      expect(await prompt.checkNow()).toBe('found')
      expect(prompt.updateOpen.value).toBe(true)
    })
  })

  it('remembers a deliberate "Later"', async () => {
    const prompt = makePrompt()
    await prompt.start()
    prompt.dismiss()

    expect(prompt.updateOpen.value).toBe(false)
    expect(native.skipped).toEqual(['0.1.24'])
  })

  it('does not silence a version just because the dialog closed after handover', async () => {
    // Backing out of the system installer leaves the user on the old build. If
    // closing the dialog had recorded a decline, nothing would ever offer this
    // version again.
    const prompt = makePrompt()
    await prompt.start()
    await prompt.install()
    prompt.dismiss()

    expect(native.skipped).toEqual([])
  })
})
