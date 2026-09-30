// Tests for the OneSignal-backed push client. The web SDK is faked by draining
// the window.OneSignalDeferred queue the module pushes its commands into — the
// same contract the real CDN script fulfils when it loads.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPushSupported,
  enablePushNotifications,
  disablePushNotifications,
  getNotificationPreference,
  setNotificationPreference,
  syncPushUser,
} from '../src/lib/pushNotifications'

function fakeSdk({ permission = 'granted' } = {}) {
  const sdk = {
    init: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    User: {
      PushSubscription: {
        optIn: vi.fn(async () => {}),
        optOut: vi.fn(async () => {}),
      },
    },
    // Part of the OneSignalWebSdk interface all along, but only reached once
    // the SDK stopped being fetched at boot: the init command that registers
    // the foreground suppressor is now queued by whichever path first needs
    // the SDK, so draining the queue in these tests runs it.
    Notifications: { addEventListener: vi.fn() },
  }
  vi.stubGlobal('Notification', { permission })
  return sdk
}

// A window/navigator pair that passes isPushSupported()'s feature checks.
function stubPushCapableBrowser() {
  const win = { PushManager: function () {}, Notification: function () {}, OneSignalDeferred: [] }
  vi.stubGlobal('window', win)
  vi.stubGlobal('navigator', { serviceWorker: {} })
  return win
}

// Resolve the module's queued SDK commands the way the loaded script would.
function drainDeferred(win, sdk) {
  while (win.OneSignalDeferred.length) win.OneSignalDeferred.shift()(sdk)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('environment guards', () => {
  it('reports unsupported outside a push-capable browser', async () => {
    // Node test environment: no PushManager. The toggle must degrade to a
    // saved preference instead of throwing.
    expect(isPushSupported()).toBe(false)
    expect(await enablePushNotifications('user-1')).toBe('unsupported')
  })

  it('reports not-configured when no OneSignal app id is set', async () => {
    // Force-empty: vitest loads .env, which carries the real app id.
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', '')
    stubPushCapableBrowser()
    expect(await enablePushNotifications('user-1')).toBe('not-configured')
  })

  it('rejects an empty user id before touching any SDK', async () => {
    expect(await enablePushNotifications('')).toBe('error')
  })
})

// Nightly has its own OneSignal app. A device is keyed by its Clerk id and Clerk
// is shared by both channels, so a nightly build on the production app would
// receive that person's real notifications. The dangerous fallback is the easy
// one: .env carries the production id in every mode.
describe('which OneSignal app', () => {
  async function moduleOn(nightly) {
    vi.resetModules()
    vi.doMock('../src/lib/appChannel', async (importOriginal) => ({
      ...(await importOriginal()),
      IS_NIGHTLY: nightly,
    }))
    const push = await import('../src/lib/pushNotifications')
    vi.doUnmock('../src/lib/appChannel')
    return push
  }

  it('gives nightly the nightly app', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'prod-app')
    vi.stubEnv('VITE_ONESIGNAL_NIGHTLY_APP_ID', 'nightly-app')
    expect((await moduleOn(true)).getOneSignalAppId()).toBe('nightly-app')
  })

  it('leaves nightly without push rather than on the production app', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'prod-app')
    vi.stubEnv('VITE_ONESIGNAL_NIGHTLY_APP_ID', '')
    expect((await moduleOn(true)).getOneSignalAppId()).toBe('')
  })

  it('gives production the production app', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'prod-app')
    vi.stubEnv('VITE_ONESIGNAL_NIGHTLY_APP_ID', 'nightly-app')
    expect((await moduleOn(false)).getOneSignalAppId()).toBe('prod-app')
  })
})

describe('boot cost', () => {
  // Fresh module per test: whether the SDK has been asked for is module state,
  // and these two tests are entirely about that flag's starting value.
  async function freshModule() {
    vi.resetModules()
    return import('../src/lib/pushNotifications')
  }

  it('does not fetch the web SDK at startup', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const push = await freshModule()

    push.initPushNotifications()

    // Nothing queued means nothing fetched. Until somebody turns notifications
    // on there is nothing for the SDK to do, and this used to download ~100KB
    // from a third-party CDN on every cold start for every visitor — including
    // the desktop users the app deliberately never even prompts.
    expect(win.OneSignalDeferred).toHaveLength(0)
  })

  it('fetches it the moment somebody turns notifications on', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()
    const push = await freshModule()

    const pending = push.enablePushNotifications('user-1')
    // The init command is queued by the path that needs the SDK now, not by boot.
    expect(win.OneSignalDeferred.length).toBeGreaterThan(0)
    drainDeferred(win, sdk)
    await pending

    expect(sdk.init).toHaveBeenCalled()
  })
})

describe('web enable via OneSignal', () => {
  it('logs in with the user id, opts in, and reports subscribed', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk({ permission: 'granted' })

    const pending = enablePushNotifications('user-1')
    drainDeferred(win, sdk)

    expect(await pending).toBe('subscribed')
    expect(sdk.login).toHaveBeenCalledWith('user-1')
    expect(sdk.User.PushSubscription.optIn).toHaveBeenCalled()
  })

  it('reports permission-denied when the browser refuses', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk({ permission: 'denied' })

    const pending = enablePushNotifications('user-1')
    drainDeferred(win, sdk)

    expect(await pending).toBe('permission-denied')
  })

  it('reports error when the SDK throws for a non-permission reason', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk({ permission: 'granted' })
    sdk.User.PushSubscription.optIn.mockRejectedValue(new Error('boom'))

    const pending = enablePushNotifications('user-1')
    drainDeferred(win, sdk)

    expect(await pending).toBe('error')
  })
})

describe('disable', () => {
  it('opts the web subscription out', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    const pending = disablePushNotifications()
    drainDeferred(win, sdk)
    await pending

    expect(sdk.User.PushSubscription.optOut).toHaveBeenCalled()
  })

  it('is a silent no-op when push is not configured', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', '')
    stubPushCapableBrowser()
    await expect(disablePushNotifications()).resolves.toBeUndefined()
  })
})

// Both of these reach the SDK through a module instance that has never fetched
// it — which is the state of any session that never ran syncPushUser, and that
// is more reachable than it looks: syncPushUser is called from HomeView alone,
// while AppNavBar (and so the settings dialog and sign-out) also renders on
// ListSetupView.
//
// The 'opts the web subscription out' test above cannot catch this. It shares
// one module instance with the enable tests that run before it, so the SDK is
// always already loaded by the time it asks — the flag it depends on is set by
// its neighbours rather than by anything it does.
describe('turning off and signing out without the SDK already loaded', () => {
  async function freshModule() {
    vi.resetModules()
    return import('../src/lib/pushNotifications')
  }

  // Skipping the opt-out here saves a download and leaves the device
  // subscribed: the toggle reads Off and the pushes keep arriving, which is the
  // one outcome this whole toggle exists to prevent.
  it('opts out even when nothing has fetched the SDK yet', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()
    const push = await freshModule()

    const pending = push.disablePushNotifications()
    drainDeferred(win, sdk)
    await pending

    expect(sdk.User.PushSubscription.optOut).toHaveBeenCalled()
  })

  // Same shape on the way out: a device left bound to the account that just
  // signed out is exactly the detached-binding failure syncPushUser was written
  // to repair, arrived at from the other end.
  it('detaches the device on sign-out even when nothing has fetched the SDK yet', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()
    const push = await freshModule()

    const pending = push.logoutPushUser()
    drainDeferred(win, sdk)
    await pending

    expect(sdk.logout).toHaveBeenCalled()
  })
})

describe('notification preference', () => {
  function fakeStorage(initial = {}) {
    const data = { ...initial }
    return {
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => { data[key] = value },
      removeItem: (key) => { delete data[key] },
      read: () => data,
    }
  }

  it('reports null when the user has never decided', () => {
    expect(getNotificationPreference(fakeStorage(), 'user_a')).toBe(null)
  })

  it('round-trips an explicit decision', () => {
    const storage = fakeStorage()
    setNotificationPreference(storage, 'user_a', 'on')
    expect(getNotificationPreference(storage, 'user_a')).toBe('on')
    setNotificationPreference(storage, 'user_a', 'off')
    expect(getNotificationPreference(storage, 'user_a')).toBe('off')
  })

  it('treats a corrupted stored value as undecided', () => {
    expect(
      getNotificationPreference(fakeStorage({ 'bagful-notifications:user_a': 'maybe' }), 'user_a'),
    ).toBe(null)
  })

  // The bug this keying exists for: one account's standing answer must not
  // become another account's, which is how somebody ended up subscribed to
  // push on a shared device without ever being asked.
  it('keeps one account decision away from another account', () => {
    const storage = fakeStorage()
    setNotificationPreference(storage, 'user_a', 'on')
    expect(getNotificationPreference(storage, 'user_b')).toBe(null)
    expect(getNotificationPreference(storage, 'user_a')).toBe('on')
  })

  // Deliberately not migrated: it carries no account, so adopting it for
  // whoever is signed in now is the same bug narrowed to one device.
  // A consent has no account recorded beside it, so a device-wide value must
  // never be adopted by whoever happens to be signed in.
  it('ignores a device-wide value', () => {
    const storage = fakeStorage({ 'bagful-notifications': 'on' })
    expect(getNotificationPreference(storage, 'user_a')).toBe(null)
  })

  it('has nothing to store for a caller with no account', () => {
    const storage = fakeStorage()
    setNotificationPreference(storage, '', 'on')
    expect(getNotificationPreference(storage, '')).toBe(null)
  })
})

// The device-to-account binding.
//
// login() is what ties a device to a Clerk id, and it used to run only when
// somebody switched notifications on. Signing out detaches the device and
// nothing put it back, so a device could stay subscribed to OneSignal while
// belonging to nobody. Nothing on the client showed it: the toggle reads from a
// separate local preference, so it still said On. It only surfaced at the far
// end, as an empty notification id with a non-zero targeted count.
describe('re-binding the device on boot', () => {
  const storage = (value) => ({ getItem: (key) => (key.startsWith('bagful-notifications:') ? value : null) })

  it('logs the device back in when notifications are on', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    const done = syncPushUser('user_42', storage('on'))
    drainDeferred(win, sdk)
    await done

    expect(sdk.login).toHaveBeenCalledWith('user_42')
  })

  // The repair must not override a decision. Someone who turned notifications
  // off is not re-subscribed just by opening the app.
  it('does nothing when notifications were turned off', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    await syncPushUser('user_42', storage('off'))
    drainDeferred(win, sdk)

    expect(sdk.login).not.toHaveBeenCalled()
  })

  it('does nothing before the user has ever been asked', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    await syncPushUser('user_42', storage(null))
    drainDeferred(win, sdk)

    expect(sdk.login).not.toHaveBeenCalled()
  })

  it('does nothing without a signed-in user', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-123')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    await syncPushUser('', storage('on'))
    drainDeferred(win, sdk)

    expect(sdk.login).not.toHaveBeenCalled()
  })

  it('does nothing when push is not configured', async () => {
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', '')
    const win = stubPushCapableBrowser()
    const sdk = fakeSdk()

    await syncPushUser('user_42', storage('on'))
    drainDeferred(win, sdk)

    expect(sdk.login).not.toHaveBeenCalled()
  })
})
