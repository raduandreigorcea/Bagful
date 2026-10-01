import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The client is built lazily now, so importing this module no longer calls
// createClient — but the stubs stay: they keep the test exercising
// fetchWithRetry alone, and CI has no VITE_SUPABASE_* env to build one from.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))
vi.mock('@clerk/vue', () => ({ useAuth: () => ({}) }))

import { fetchWithRetry, fetchWithFreshToken, resolveRealtimeToken, setSupabaseTokenResolver } from '../src/supabase'

const networkError = () => Object.assign(new TypeError('Failed to fetch'), {})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchWithRetry', () => {
  it('retries GETs that fail at the network layer, then succeeds', async () => {
    fetch
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce('response')

    await expect(fetchWithRetry('https://x/rest')).resolves.toBe('response')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after exhausting the retry budget', async () => {
    fetch.mockRejectedValue(networkError())

    await expect(fetchWithRetry('https://x/rest', { method: 'GET' })).rejects.toThrow('Failed to fetch')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('never retries mutations', async () => {
    fetch.mockRejectedValue(networkError())

    await expect(fetchWithRetry('https://x/rest', { method: 'POST' })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns HTTP error responses without retrying', async () => {
    const errorResponse = { ok: false, status: 500 }
    fetch.mockResolvedValue(errorResponse)

    await expect(fetchWithRetry('https://x/rest')).resolves.toBe(errorResponse)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry aborted requests', async () => {
    fetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))

    await expect(fetchWithRetry('https://x/rest')).rejects.toThrow('aborted')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('removes the listener it adds to the caller\'s signal once each attempt ends', async () => {
    fetch
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce('response')
    const signal = new AbortController().signal
    const add = vi.spyOn(signal, 'addEventListener')
    const remove = vi.spyOn(signal, 'removeEventListener')

    await fetchWithRetry('https://x/rest', { signal })

    expect(add).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  // The listener only hears an abort that happens later, so a signal aborted
  // before the call reached fetch through a controller that never was.
  it('honours a signal that was aborted before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    fetch.mockImplementation((_url, options) =>
      options.signal.aborted
        ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        : Promise.resolve('response'),
    )

    await expect(fetchWithRetry('https://x/rest', { signal: controller.signal })).rejects.toThrow('aborted')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // Found by the bot swarm: a read that never got an answer left the app on
  // its loading screen for good, because nothing gave up on it. A request that
  // hangs until the server rejects it once it is abandoned, the way fetch does.
  const hangs = (url, options) =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal.reason))
    })

  it('gives up on a read that never answers, and tries again', async () => {
    vi.useFakeTimers()
    try {
      fetch.mockImplementationOnce(hangs).mockResolvedValueOnce('response')
      const result = fetchWithRetry('https://x/rest')

      await vi.advanceTimersByTimeAsync(15_000 + 250)
      expect(fetch).toHaveBeenCalledTimes(2)
      await expect(result).resolves.toBe('response')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never abandons a write, which may already have been applied', async () => {
    vi.useFakeTimers()
    try {
      let settle
      fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
        settle = resolve
        options?.signal?.addEventListener('abort', () => reject(new Error('abandoned')))
      }))
      const result = fetchWithRetry('https://x/rest', { method: 'POST' })

      await vi.advanceTimersByTimeAsync(60_000)
      settle('late but applied')
      await expect(result).resolves.toBe('late but applied')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchWithFreshToken', () => {
  const jwtRejected = (message) =>
    new Response(JSON.stringify({ code: 'PGRST303', message }), { status: 401 })

  it('resends a request whose token expired with a token that skips the cache', async () => {
    const resolve = vi.fn().mockResolvedValue('fresh')
    setSupabaseTokenResolver(resolve)
    fetch.mockResolvedValueOnce(jwtRejected('JWT expired')).mockResolvedValueOnce(new Response('ok'))

    const res = await fetchWithFreshToken('https://x/rest', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer stale' },
    })

    expect(await res.text()).toBe('ok')
    expect(resolve).toHaveBeenCalledWith({ skipCache: true })
    expect(fetch.mock.calls[1][1].headers.get('Authorization')).toBe('Bearer fresh')
  })

  it('leaves other 401s alone', async () => {
    setSupabaseTokenResolver(vi.fn().mockResolvedValue('fresh'))
    const denied = new Response(JSON.stringify({ code: '42501' }), { status: 401 })
    fetch.mockResolvedValue(denied)

    await expect(fetchWithFreshToken('https://x/rest')).resolves.toBe(denied)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('resolveRealtimeToken', () => {
  // A JWT whose only claim that matters here is exp, seconds from now.
  const tokenExpiringIn = (seconds) =>
    `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.s`

  it('keeps a cached token that outlives the next realtime heartbeat', async () => {
    const cached = tokenExpiringIn(55)
    const resolve = vi.fn().mockResolvedValue(cached)
    setSupabaseTokenResolver(resolve)

    await expect(resolveRealtimeToken()).resolves.toBe(cached)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('mints a fresh token when the cached one would expire before the next heartbeat', async () => {
    const fresh = tokenExpiringIn(60)
    const resolve = vi.fn().mockResolvedValueOnce(tokenExpiringIn(20)).mockResolvedValueOnce(fresh)
    setSupabaseTokenResolver(resolve)

    await expect(resolveRealtimeToken()).resolves.toBe(fresh)
    expect(resolve).toHaveBeenLastCalledWith({ skipCache: true })
  })

  it('passes through a token it cannot read, and a missing one', async () => {
    setSupabaseTokenResolver(vi.fn().mockResolvedValue('not-a-jwt'))
    await expect(resolveRealtimeToken()).resolves.toBe('not-a-jwt')
    setSupabaseTokenResolver(vi.fn().mockResolvedValue(null))
    await expect(resolveRealtimeToken()).resolves.toBeNull()
  })
})
