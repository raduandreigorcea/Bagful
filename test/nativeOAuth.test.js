// Unit tests for the native OAuth round-trip: Clerk hands us an external
// verification URL, the system browser runs it, and the deep-link callback
// (or the user closing the tab) decides how the attempt ends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startNativeOAuth,
  NATIVE_SSO_CALLBACK_URL,
  NATIVE_SSO_BOUNCE_URL,
} from '../src/lib/nativeOAuth'

const mocks = vi.hoisted(() => ({
  listeners: {},
  removedListeners: [],
  browserOpen: vi.fn(),
  browserClose: vi.fn(),
}))

function fakeListenerPlugin(extra = {}) {
  return {
    addListener: async (name, callback) => {
      mocks.listeners[name] = callback
      return {
        remove: async () => {
          mocks.removedListeners.push(name)
        },
      }
    },
    ...extra,
  }
}

vi.mock('@capacitor/app', () => ({ App: fakeListenerPlugin() }))
vi.mock('@capacitor/browser', () => ({
  Browser: fakeListenerPlugin({
    open: (...args) => mocks.browserOpen(...args),
    close: (...args) => mocks.browserClose(...args),
  }),
}))

// The flow awaits plugin setup before the browser opens; drain those
// microtasks so the fake events find their listeners registered.
async function untilBrowserOpened() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  expect(mocks.browserOpen).toHaveBeenCalledTimes(1)
}

function fakeSignIn(overrides = {}) {
  return {
    status: null,
    createdSessionId: null,
    firstFactorVerification: {
      status: null,
      externalVerificationRedirectURL: new URL('https://clerk.example/v1/oauth'),
    },
    create: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    ...overrides,
  }
}

function fakeSignUp(overrides = {}) {
  return {
    status: null,
    createdSessionId: null,
    create: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  mocks.listeners = {}
  mocks.removedListeners = []
  mocks.browserOpen.mockReset().mockResolvedValue(undefined)
  mocks.browserClose.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startNativeOAuth', () => {
  it('completes a returning user and hands back the session id', async () => {
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.status = 'complete'
      signIn.createdSessionId = 'sess_returning'
    })
    const signUp = fakeSignUp()

    const result = startNativeOAuth(signIn, signUp, 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.appUrlOpen({
      url: `${NATIVE_SSO_CALLBACK_URL}?rotating_token_nonce=nonce-7`,
    })

    await expect(result).resolves.toBe('sess_returning')
    // Clerk gets the https bounce page (custom schemes are refused), while
    // the deep link below is what actually re-enters the app.
    expect(signIn.create).toHaveBeenCalledWith({
      strategy: 'oauth_google',
      redirectUrl: NATIVE_SSO_BOUNCE_URL,
    })
    expect(signIn.reload).toHaveBeenCalledWith({ rotatingTokenNonce: 'nonce-7' })
    expect(signUp.create).not.toHaveBeenCalled()
    // The abandoned-flow guards: both listeners detached, tab dismissed.
    expect(mocks.removedListeners).toContain('appUrlOpen')
    expect(mocks.removedListeners).toContain('browserFinished')
    expect(mocks.browserClose).toHaveBeenCalled()
  })

  it('converts a first-time provider account through the sign-up transfer', async () => {
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.firstFactorVerification.status = 'transferable'
    })
    const signUp = fakeSignUp()
    signUp.create.mockImplementation(async () => {
      signUp.status = 'complete'
      signUp.createdSessionId = 'sess_new_user'
    })

    const result = startNativeOAuth(signIn, signUp, 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.appUrlOpen({
      url: `${NATIVE_SSO_CALLBACK_URL}?rotating_token_nonce=nonce-9`,
    })

    await expect(result).resolves.toBe('sess_new_user')
    expect(signUp.create).toHaveBeenCalledWith({ transfer: true })
  })

  it('resolves null when the user closes the browser without finishing', async () => {
    vi.useFakeTimers()
    const signIn = fakeSignIn()

    const result = startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.browserFinished()
    await vi.advanceTimersByTimeAsync(1500)

    await expect(result).resolves.toBeNull()
    expect(signIn.reload).not.toHaveBeenCalled()
  })

  it('lets a callback that raced the tab closing win over the cancellation', async () => {
    vi.useFakeTimers()
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.status = 'complete'
      signIn.createdSessionId = 'sess_raced'
    })

    const result = startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')
    await untilBrowserOpened()
    // Android dismisses the tab as the deep link foregrounds the app: the
    // close event lands first, the callback follows within the grace window.
    mocks.listeners.browserFinished()
    mocks.listeners.appUrlOpen({
      url: `${NATIVE_SSO_CALLBACK_URL}?rotating_token_nonce=nonce-4`,
    })
    await vi.advanceTimersByTimeAsync(1500)

    await expect(result).resolves.toBe('sess_raced')
  })

  it('reloads without a nonce when the callback carries none', async () => {
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.status = 'complete'
      signIn.createdSessionId = 'sess_nonceless'
    })

    const result = startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.appUrlOpen({ url: NATIVE_SSO_CALLBACK_URL })

    await expect(result).resolves.toBe('sess_nonceless')
    expect(signIn.reload).toHaveBeenCalledWith()
  })

  it('ignores unrelated deep links while waiting', async () => {
    vi.useFakeTimers()
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.status = 'complete'
      signIn.createdSessionId = 'sess_late'
    })

    const result = startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.appUrlOpen({ url: 'bagful://something-else' })
    mocks.listeners.appUrlOpen({
      url: `${NATIVE_SSO_CALLBACK_URL}?rotating_token_nonce=nonce-2`,
    })

    await expect(result).resolves.toBe('sess_late')
  })

  it('throws when Clerk returns no verification URL, without opening a browser', async () => {
    const signIn = fakeSignIn()
    signIn.firstFactorVerification.externalVerificationRedirectURL = null

    await expect(startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')).rejects.toThrow(
      'no verification URL',
    )
    expect(mocks.browserOpen).not.toHaveBeenCalled()
  })

  it('throws when the attempt comes back unfinished and untransferable', async () => {
    const signIn = fakeSignIn()
    signIn.reload.mockImplementation(async () => {
      signIn.status = 'needs_first_factor'
    })

    const result = startNativeOAuth(signIn, fakeSignUp(), 'oauth_google')
    await untilBrowserOpened()
    mocks.listeners.appUrlOpen({ url: `${NATIVE_SSO_CALLBACK_URL}?rotating_token_nonce=x` })

    // Asserts the diagnostic, not the prose. The whole point of this error is
    // that it names the state the attempt got stuck in — that is what separates
    // "allowlist the redirect URL in Clerk" from a bug in startNativeOAuth. The
    // wording around it is copy and may change; the stuck state may not.
    await expect(result).rejects.toThrow('attempt: needs_first_factor')
  })
})
