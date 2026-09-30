// @vitest-environment happy-dom
//
// Deciding whether the Android app is out of date.
//
// The two things worth pinning here are the ones that fail quietly rather than
// loudly. Version ordering is string comparison's classic trap — "0.1.9" sorts
// above "0.1.10", and the patch number moves on every commit, so that boundary
// is days away rather than years. And every gate around the check exists to stop
// the dialog either nagging (a version already declined) or never appearing
// again (a failed request that still counted as a check).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const platform = vi.hoisted(() => ({ native: true, name: 'android' }))

// Production unless a case says otherwise: the updater exists for the published
// app, and every other case here is about that one.
const channel = vi.hoisted(() => ({ nightly: false }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  get IS_NIGHTLY() {
    return channel.nightly
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: () => ({}),
}))

const { canSelfUpdate, compareVersions, fetchLatestRelease, findUpdate, skipVersion } = await import(
  '../src/lib/nativeUpdate'
)

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

function releaseResponse(name, assets = [{ name: 'Bagful.apk', browser_download_url: 'https://x/Bagful.apk' }]) {
  return {
    ok: true,
    json: async () => ({ name, assets }),
  }
}

beforeEach(() => {
  platform.native = true
  platform.name = 'android'
  channel.nightly = false
})

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    // The one that matters: 9 → 10 is where a string comparison starts lying,
    // and the patch field crosses it within a fortnight of shipping.
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('treats equal versions as equal, whatever is tacked on the end', () => {
    expect(compareVersions('0.1.23', '0.1.23')).toBe(0)
    expect(compareVersions('Bagful v0.1.23', '0.1.23')).toBe(0)
  })

  it('sorts an unparseable version below everything', () => {
    expect(compareVersions('nonsense', '0.0.1')).toBe(-1)
  })
})

describe('fetchLatestRelease', () => {
  it('reads the version out of the release name and the APK out of the assets', async () => {
    const result = await fetchLatestRelease(async () => releaseResponse('Bagful v0.1.24'))
    expect(result).toEqual({ version: '0.1.24', apkUrl: 'https://x/Bagful.apk' })
  })

  it('gives up rather than guessing when the release carries no version', async () => {
    // If the workflow's release name ever stops containing a version, the right
    // outcome is no prompt — not a comparison against a made-up number.
    expect(await fetchLatestRelease(async () => releaseResponse('Bagful latest build'))).toBeNull()
  })

  it('gives up when the release has no APK attached', async () => {
    expect(await fetchLatestRelease(async () => releaseResponse('Bagful v0.1.24', []))).toBeNull()
  })

  it('is silent about a network failure', async () => {
    // A phone on a train says nothing about whether the app is out of date.
    await expect(
      fetchLatestRelease(async () => {
        throw new Error('offline')
      }),
    ).resolves.toBeNull()
  })

  it('is silent about a rate-limit or error response', async () => {
    expect(await fetchLatestRelease(async () => ({ ok: false, json: async () => ({}) }))).toBeNull()
  })
})

describe('findUpdate', () => {
  const fetchLatest = (version) => async () => releaseResponse(`Bagful v${version}`)

  it('offers a newer version', async () => {
    const update = await findUpdate({
      currentVersion: '0.1.23',
      storage: fakeStorage(),
      fetchImpl: fetchLatest('0.1.24'),
    })
    expect(update?.version).toBe('0.1.24')
  })

  it('says nothing when the installed version is already the newest', async () => {
    const update = await findUpdate({
      currentVersion: '0.1.24',
      storage: fakeStorage(),
      fetchImpl: fetchLatest('0.1.24'),
    })
    expect(update).toBeNull()
  })

  it('never offers anything off Android', async () => {
    // On the web the service worker has already swapped the build out; there is
    // no APK to install and no plugin to install it with.
    platform.native = false
    const fetchImpl = vi.fn(fetchLatest('9.9.9'))
    expect(
      await findUpdate({ currentVersion: '0.1.23', storage: fakeStorage(), fetchImpl }),
    ).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stays quiet about a version the user has already declined', async () => {
    const storage = fakeStorage()
    skipVersion(storage, '0.1.24')
    expect(
      await findUpdate({
        currentVersion: '0.1.23',
        storage,
        fetchImpl: fetchLatest('0.1.24'),
      }),
    ).toBeNull()
  })

  it('speaks up again when a version newer than the declined one lands', async () => {
    const storage = fakeStorage()
    skipVersion(storage, '0.1.24')
    const update = await findUpdate({
      currentVersion: '0.1.23',
      storage,
      fetchImpl: fetchLatest('0.1.25'),
    })
    expect(update?.version).toBe('0.1.25')
  })

  it('does not ask GitHub again straight away when there was nothing new', async () => {
    const storage = fakeStorage()
    const fetchImpl = vi.fn(fetchLatest('0.1.23'))
    const now = 1_000_000_000

    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now })
    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now: now + 60_000 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks again once the interval has passed', async () => {
    const storage = fakeStorage()
    const fetchImpl = vi.fn(fetchLatest('0.1.23'))
    const now = 1_000_000_000

    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now })
    await findUpdate({
      currentVersion: '0.1.23',
      storage,
      fetchImpl,
      now: now + 5 * 60 * 60 * 1000,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps offering a known update rather than going quiet for hours', async () => {
    // Backing out of the system installer decides nothing. The interval is for
    // the case where there is nothing to say; while a newer version is sitting
    // there unrefused, every launch should say so.
    const storage = fakeStorage()
    const fetchImpl = vi.fn(fetchLatest('0.1.24'))
    const now = 1_000_000_000

    expect((await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now }))?.version).toBe(
      '0.1.24',
    )
    const second = await findUpdate({
      currentVersion: '0.1.23',
      storage,
      fetchImpl,
      now: now + 1000,
    })

    expect(second?.version).toBe('0.1.24')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('still goes quiet for a version that was actually declined', async () => {
    // The difference that matters: "Later" is a decision, a cancelled install
    // is not.
    const storage = fakeStorage()
    const fetchImpl = vi.fn(fetchLatest('0.1.24'))
    const now = 1_000_000_000

    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now })
    skipVersion(storage, '0.1.24')

    expect(
      await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now: now + 1000 }),
    ).toBeNull()
  })

  it('does not let a failed check start the clock', async () => {
    // Ten seconds without signal must not put the next check four hours out.
    const storage = fakeStorage()
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('offline')
      })
      .mockImplementationOnce(fetchLatest('0.1.24'))
    const now = 1_000_000_000

    expect(await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now })).toBeNull()
    const update = await findUpdate({
      currentVersion: '0.1.23',
      storage,
      fetchImpl,
      now: now + 1000,
    })

    expect(update?.version).toBe('0.1.24')
  })

  it('re-checks when the clock has moved backwards', async () => {
    // A timezone edit or an NTP correction would otherwise park the next check
    // arbitrarily far in the future.
    const storage = fakeStorage()
    const fetchImpl = vi.fn(fetchLatest('0.1.24'))
    const now = 1_000_000_000

    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now })
    await findUpdate({ currentVersion: '0.1.23', storage, fetchImpl, now: now - 60_000 })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

})

// ─── What a published version BELOW a declined one does ──────────────────────
//
// The decline record is permanent by design, and that is safe only while
// versions go up: "not this one" is answered by the next build, which is always
// higher. Publish something lower than a version already declined and that
// premise is gone -- every build from there on compares at or below the record,
// so the automatic check goes quiet and stays quiet. The manual check is the
// only way back, because it is the one route that ignores the record.
describe('a release published below a declined version', () => {
  const declined = { 'famcart-update-skipped-version': '0.3.0' }

  it('is never offered, however long the phone waits', async () => {
    const storage = fakeStorage(declined)
    const fetchImpl = vi.fn(async () => releaseResponse('Bagful v0.2.1'))

    const found = await findUpdate({
      currentVersion: '0.2.0',
      storage,
      fetchImpl,
      // A year later, so no interval can be the reason it stayed quiet.
      now: Date.now() + 365 * 24 * 60 * 60 * 1000,
    })

    // 0.2.1 is genuinely newer than the 0.2.0 installed here -- the only thing
    // stopping it is the 0.3.0 that was declined while it was published.
    expect(compareVersions('0.2.1', '0.2.0')).toBe(1)
    expect(found).toBeNull()
  })

  it('starts working again as soon as a build clears the declined version', async () => {
    const storage = fakeStorage(declined)
    const fetchImpl = vi.fn(async () => releaseResponse('Bagful v0.3.1'))

    const found = await findUpdate({ currentVersion: '0.2.0', storage, fetchImpl })

    expect(found).toEqual({ version: '0.3.1', apkUrl: 'https://x/Bagful.apk' })
  })
})

describe('canSelfUpdate', () => {
  it('is on for the published Android app', () => {
    expect(canSelfUpdate()).toBe(true)
  })

  it('is off anywhere there is nothing to install', () => {
    platform.native = false
    expect(canSelfUpdate()).toBe(false)
  })

  // The rolling GitHub release holds the PRODUCTION APK, under a different
  // application id and therefore a different app. Offered to a nightly build it
  // would not update anything: at best Android installs production alongside it,
  // at worst the user thinks the nightly one just updated. Nightly has no
  // release feed of its own yet, so the honest answer is that it cannot update.
  it('is off on a nightly build, which has nothing to update from', () => {
    channel.nightly = true
    expect(canSelfUpdate()).toBe(false)
  })

  it('keeps findUpdate quiet on nightly rather than offering a production APK', async () => {
    channel.nightly = true
    const fetchImpl = vi.fn(async () => releaseResponse('Bagful v9.9.9'))

    const found = await findUpdate({ currentVersion: '0.5.0', storage: fakeStorage(), fetchImpl })

    expect(found).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
