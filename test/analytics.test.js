import { describe, it, expect, vi, beforeEach } from 'vitest'

const ph = vi.hoisted(() => ({
  init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn(), register: vi.fn(),
  startSessionRecording: vi.fn(), stopSessionRecording: vi.fn(),
}))
vi.mock('posthog-js', () => ({ default: ph }))
vi.mock('posthog-js/dist/recorder', () => ({}))

// A rejecting dynamic import() of 'posthog-js' (startAnalytics's try/catch
// around the SDK load) is not covered here: vi.mock resolves 'posthog-js' to
// one cached module record for the whole file, the same way native ESM
// caches a module after its first successful resolution. Every other test
// below imports it successfully, so a factory that starts throwing after
// that point is never reached, and a factory that throws before it would
// poison the cache for the rest of the file instead of just one test. Doing
// this properly needs vi.resetModules() plus a fresh dynamic import of
// analytics.ts itself, isolated from the module-level state (queue, client,
// pendingUserId) every other test in this file shares -- awkward enough that
// the try/catch is verified by reading, not by a test.

import {
  posthogKey, apiHost, scrubUrl, scrubEvent, track, startAnalytics,
  identifyAnalytics, replayEnabled, setReplayEnabled, __resetAnalyticsForTests,
} from '../src/lib/analytics'

function memoryStorage() {
  const s = new Map()
  return { getItem: (k) => s.get(k) ?? null, setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) }
}

describe('posthogKey', () => {
  it('uses the nightly key on nightly and never falls back to production', () => {
    expect(posthogKey('nightly', { prod: 'P', nightly: 'N' })).toBe('N')
    expect(posthogKey('nightly', { prod: 'P' })).toBe('')
  })
  it('uses the production key on production', () => {
    expect(posthogKey('production', { prod: 'P', nightly: 'N' })).toBe('P')
  })
  it('sends nothing from the dev server', () => {
    expect(posthogKey('nightly', { prod: 'P', nightly: 'N', dev: true })).toBe('')
    expect(posthogKey('production', { prod: 'P', nightly: 'N', dev: true })).toBe('')
  })
})

describe('apiHost', () => {
  it('goes through the Vercel rewrite on the web', () => {
    expect(apiHost(false, 'https://famcart-app.vercel.app')).toBe('https://famcart-app.vercel.app/ingest')
  })
  it('goes direct from the APK, whose origin is the phone itself', () => {
    expect(apiHost(true, 'https://localhost')).toBe('https://eu.i.posthog.com')
  })
})

describe('scrubEvent', () => {
  it('drops query and hash, where invite codes and Clerk params live', () => {
    expect(scrubUrl('https://x.app/list-setup?code=ABC123#t')).toBe('https://x.app/list-setup')
    expect(scrubUrl('/?__clerk_status=verified')).toBe('/')
    expect(scrubUrl('https://x.app/#frag')).toBe('https://x.app/')
    expect(scrubUrl(42)).toBe(42)
  })
  it('scrubs every URL property PostHog attaches, and leaves the rest', () => {
    const out = scrubEvent({ properties: {
      $current_url: 'https://x.app/?code=A', $referrer: 'https://x.app/?code=B',
      $pathname: '/?code=C', $initial_current_url: 'https://x.app/?code=D',
      $initial_referrer: 'https://x.app/?code=E', item: 1,
    } })
    expect(out.properties).toEqual({
      $current_url: 'https://x.app/', $referrer: 'https://x.app/',
      $pathname: '/', $initial_current_url: 'https://x.app/',
      $initial_referrer: 'https://x.app/', item: 1,
    })
  })
  it('scrubs $set and $set_once, and the session-entry and click keys PostHog actually sends there', () => {
    // A realistic capture: $set_once carries the first-touch URLs
    // (get_initial_props), properties carries the once-per-session entry URL
    // and an autocapture click on an outbound link -- none of these are the
    // $current_url/$referrer/$pathname the previous test already covers.
    const out = scrubEvent({
      properties: {
        $session_entry_url: 'https://x.app/list-setup?code=ABC#t',
        $external_click_url: 'https://partner.example/?ref=xyz',
        item: 1,
      },
      $set: { $referrer: 'https://x.app/?code=A' },
      $set_once: {
        $initial_current_url: 'https://x.app/list-setup?code=DEF',
        $initial_referrer: 'https://x.app/?code=B',
      },
    })
    expect(out.properties).toEqual({
      $session_entry_url: 'https://x.app/list-setup', $external_click_url: 'https://partner.example/', item: 1,
    })
    expect(out.$set).toEqual({ $referrer: 'https://x.app/' })
    expect(out.$set_once).toEqual({
      $initial_current_url: 'https://x.app/list-setup', $initial_referrer: 'https://x.app/',
    })
  })
  it('passes null and property-less events through', () => {
    expect(scrubEvent(null)).toBe(null)
    expect(scrubEvent({})).toEqual({})
  })
})

describe('track', () => {
  beforeEach(() => { vi.unstubAllEnvs(); __resetAnalyticsForTests(); vi.clearAllMocks() })

  it('is a silent no-op with no key', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', '')
    track('item_checked')
    await startAnalytics()
    track('item_checked')
    expect(ph.init).not.toHaveBeenCalled()
    expect(ph.capture).not.toHaveBeenCalled()
  })

  it('never uses the production key on a nightly build', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'nightly')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_prod')
    vi.stubEnv('VITE_POSTHOG_NIGHTLY_KEY', '')
    await startAnalytics()
    expect(ph.init).not.toHaveBeenCalled()
  })

  it('queues events sent before the SDK loads, then flushes them in order', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    track('onboarding_completed')
    track('item_added', { source: 'barcode' })
    await startAnalytics()
    expect(ph.init).toHaveBeenCalledWith('phc_test', expect.objectContaining({
      persistence: 'memory', mask_all_text: true, disable_session_recording: true,
      mask_all_element_attributes: true, disable_external_dependency_loading: true,
      api_host: expect.any(String), before_send: scrubEvent,
    }))
    expect(ph.capture.mock.calls).toEqual([
      ['onboarding_completed', undefined],
      ['item_added', { source: 'barcode' }],
    ])
  })

  it('applies a sign-in made before the SDK loads, before the queued events flush', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    identifyAnalytics('user_a')
    track('item_checked')
    await startAnalytics()
    expect(ph.identify).toHaveBeenCalledWith('user_a')
    expect(ph.identify.mock.invocationCallOrder[0]).toBeLessThan(ph.capture.mock.invocationCallOrder[0])
  })

  it('stops replay and resets identity on sign-out', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    await startAnalytics()
    identifyAnalytics('user_a')
    expect(ph.identify).toHaveBeenCalledWith('user_a')
    identifyAnalytics(null)
    expect(ph.stopSessionRecording).toHaveBeenCalled()
    expect(ph.reset).toHaveBeenCalled()
  })

  // Production had events arriving with no channel, so the admin page (which
  // filters on it) showed nothing. reset() drops every registered property,
  // and App.vue reports "nobody signed in" on the login screen.
  it('does not reset a visitor who never signed in, so channel survives', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    await startAnalytics()
    identifyAnalytics(null)
    expect(ph.reset).not.toHaveBeenCalled()
  })

  it('registers channel and version again after a real sign-out', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    await startAnalytics()
    identifyAnalytics('user_a')
    identifyAnalytics(null)
    expect(ph.register).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'production' }))
    expect(ph.register.mock.invocationCallOrder.at(-1)).toBeGreaterThan(ph.reset.mock.invocationCallOrder[0])
  })

  it('does not reset a sign-out made before the SDK loads, when nobody was signed in', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    identifyAnalytics(null)
    await startAnalytics()
    expect(ph.reset).not.toHaveBeenCalled()
  })

  it('starts and stops replay through the settings toggle, for the identified account', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_APP_CHANNEL', 'production')
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
    await startAnalytics()
    identifyAnalytics('user_a')
    const storage = memoryStorage()
    setReplayEnabled(storage, 'user_a', true)
    // setReplayEnabled fires the recorder's dynamic import without awaiting
    // it (a settings toggle has nothing to await it for), so the assertion
    // has to poll rather than assume one microtask is enough.
    await vi.waitFor(() => expect(ph.startSessionRecording).toHaveBeenCalled())
    setReplayEnabled(storage, 'user_a', false)
    expect(ph.stopSessionRecording).toHaveBeenCalled()
  })
})

describe('replay preference', () => {
  it('is per account and off by default', () => {
    const storage = memoryStorage()
    expect(replayEnabled(storage, 'user_a')).toBe(false)
    setReplayEnabled(storage, 'user_a', true)
    expect(replayEnabled(storage, 'user_a')).toBe(true)
    expect(replayEnabled(storage, 'user_b')).toBe(false)
    setReplayEnabled(storage, 'user_a', false)
    expect(replayEnabled(storage, 'user_a')).toBe(false)
  })
})
