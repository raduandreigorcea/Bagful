import { describe, it, expect, vi, beforeEach } from 'vitest'

const ph = vi.hoisted(() => ({
  init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn(), register: vi.fn(),
  startSessionRecording: vi.fn(), stopSessionRecording: vi.fn(),
}))
vi.mock('posthog-js', () => ({ default: ph }))
vi.mock('posthog-js/dist/recorder', () => ({}))

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
    }))
    expect(ph.capture.mock.calls).toEqual([
      ['onboarding_completed', undefined],
      ['item_added', { source: 'barcode' }],
    ])
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
