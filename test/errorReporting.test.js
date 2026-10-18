// @vitest-environment happy-dom
//
// The early-capture window.
//
// Sentry installs its own global handlers inside init(), which is deferred to
// idle so the SDK stays out of the initial download. That leaves a gap at cold
// start where an unhandled rejection reaches nothing at all — the boot window,
// where the router guard, the Clerk load and the first fetches live.
//
// captureEarlyErrors() stands in for that window. The half worth pinning is the
// handover: these listeners must come off once the SDK is live, or every error
// gets reported twice, and a duplicate is the kind of regression nobody notices
// until they are reading the same stack trace in two issues.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  captureEarlyErrors,
  isExpectedOfflineFailure,
  startErrorReporting,
} from '../src/lib/errorReporting'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('captureEarlyErrors', () => {
  it('listens for both kinds of unhandled failure', () => {
    const add = vi.spyOn(window, 'addEventListener')

    const stop = captureEarlyErrors()

    const events = add.mock.calls.map(([name]) => name)
    expect(events).toContain('error')
    expect(events).toContain('unhandledrejection')

    stop()
  })

  it('hands over cleanly, so nothing is reported twice', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')

    const stop = captureEarlyErrors()
    stop()

    // Same handler identities on the way out as on the way in: a removal that
    // passes a different function silently leaves the listener attached, which
    // is the exact shape of the double-reporting bug this guards.
    const added = add.mock.calls.filter(([n]) => n === 'error' || n === 'unhandledrejection')
    const removed = remove.mock.calls.filter(([n]) => n === 'error' || n === 'unhandledrejection')
    expect(removed).toHaveLength(added.length)
    for (const [name, handler] of added) {
      expect(removed.some(([n, h]) => n === name && h === handler)).toBe(true)
    }
  })

  it('ignores resource load failures, which are not exceptions', () => {
    const stop = captureEarlyErrors()

    // A 404 on an <img> raises an 'error' event with no `error` property. It is
    // not a thrown exception and reporting it would only add noise.
    expect(() => window.dispatchEvent(new Event('error'))).not.toThrow()

    stop()
  })

  // Without a DSN the SDK never loads, so startErrorReporting resolves straight
  // away — and main.ts drops the stand-ins on that resolution. This is the dev,
  // CI and test path: it must not leave listeners behind.
  it('is released immediately when there is no DSN to load', async () => {
    // The DSN has to be stubbed off. Vitest loads .env like Vite does, so
    // VITE_SENTRY_DSN is populated here, and without this the call takes the
    // real path: a dynamic import of the whole SDK, five seconds, and a flake
    // against the default 5s timeout. The branch being pinned is the other one.
    vi.stubEnv('VITE_SENTRY_DSN', '')

    const remove = vi.spyOn(window, 'removeEventListener')
    const stop = captureEarlyErrors()

    await startErrorReporting({}, {}).finally(stop)

    const removed = remove.mock.calls.map(([n]) => n)
    expect(removed).toContain('error')
    expect(removed).toContain('unhandledrejection')
  })
})

// Clerk's plugin install fetches its UI bundle from clerk.accounts.dev, and
// `app.use(clerkPlugin, ...)` returns before that lands, so a failure surfaces
// as an unhandled rejection with nothing at the call site able to catch it.
//
// Offline that is not a fault: the app has an offline route it deliberately
// boots into, and a remote script that cannot be fetched with no network is the
// expected outcome, not news. Online it is the opposite: that person cannot
// sign in, and it is the one report worth keeping.
//
// Both halves are pinned here because the bug this replaces was reported five
// times from a device sitting on /offline, and "just filter Clerk out" would
// have silenced the one event that mattered along with them.
describe('isExpectedOfflineFailure', () => {
  // Exactly the shape Sentry recorded on Android, minified class name and all.
  const clerkUiFailure = {
    exception: {
      values: [
        { type: 'e', value: 'Clerk: Failed to load Clerk UI\n\n(code="failed_to_load_clerk_ui")' },
      ],
    },
  }

  it('drops a Clerk UI load failure raised while offline', () => {
    expect(isExpectedOfflineFailure(clerkUiFailure, true)).toBe(true)
  })

  it('drops the clerk-js bundle failing to load while offline too', () => {
    const jsFailure = {
      exception: { values: [{ type: 'e', value: 'Clerk: Failed to load Clerk JS\n\n(code="failed_to_load_clerk_js")' }] },
    }
    expect(isExpectedOfflineFailure(jsFailure, true)).toBe(true)
    expect(isExpectedOfflineFailure(jsFailure, false)).toBe(false)
  })

  it('keeps the same failure when the device is online', () => {
    expect(isExpectedOfflineFailure(clerkUiFailure, false)).toBe(false)
  })

  // The variant seen from a real user on an old WebView: same cause, but the
  // script URL is appended, so a match on the exact string would miss it.
  it('recognises the variant that names the script it could not fetch', () => {
    const withUrl = {
      exception: {
        values: [
          {
            type: 'e',
            value:
              'Clerk: Failed to load Clerk UI, failed to load script: '
              + 'https://needed-bass-4.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js',
          },
        ],
      },
    }
    expect(isExpectedOfflineFailure(withUrl, true)).toBe(true)
  })

  it('keeps an unrelated error even when offline', () => {
    const other = {
      exception: {
        values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'title')" }],
      },
    }
    expect(isExpectedOfflineFailure(other, true)).toBe(false)
  })

  it('survives an event carrying no exception at all', () => {
    expect(isExpectedOfflineFailure({}, true)).toBe(false)
  })
})
