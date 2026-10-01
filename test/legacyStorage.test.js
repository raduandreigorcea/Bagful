import { describe, it, expect } from 'vitest'
import { migrateLegacyKeys } from '../src/lib/legacyStorage'

function fakeStorage(entries) {
  const data = new Map(Object.entries(entries))
  return {
    get length() {
      return data.size
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    dump: () => Object.fromEntries(data),
  }
}

describe('carrying settings over from old key names', () => {
  it('moves every famcart key to its bagful name', () => {
    const storage = fakeStorage({
      'famcart-theme': 'dark',
      'famcart-locale:user-1': 'ro',
      'famcart.shops.v2': '[]',
      famcart_tour_seen_v4: '1',
    })
    migrateLegacyKeys(storage)
    expect(storage.dump()).toEqual({
      'bagful-theme': 'dark',
      'bagful-locale:user-1': 'ro',
      'bagful.shops.v2': '[]',
      bagful_tour_seen_v4: '1',
    })
  })

  it('moves the household cache keys to their list names, from either old prefix', () => {
    const storage = fakeStorage({
      'bagful-household-snapshot:user-1': 'snap-1',
      'bagful-active-household:user-1': 'fam-1',
      'famcart-household-snapshot:user-2': 'snap-2',
      'famcart-active-household:user-2': 'fam-2',
    })
    migrateLegacyKeys(storage)
    expect(storage.dump()).toEqual({
      'bagful-list-snapshot:user-1': 'snap-1',
      'bagful-active-list:user-1': 'fam-1',
      'bagful-list-snapshot:user-2': 'snap-2',
      'bagful-active-list:user-2': 'fam-2',
    })
  })

  it('keeps a value set under the new name, which is the newer answer', () => {
    const storage = fakeStorage({ 'famcart-theme': 'dark', 'bagful-theme': 'light' })
    migrateLegacyKeys(storage)
    expect(storage.dump()).toEqual({ 'bagful-theme': 'light' })
  })

  it('leaves everything else alone', () => {
    const storage = fakeStorage({ 'bagful-theme': 'dark', 'ph_phc_key_posthog': 'x' })
    migrateLegacyKeys(storage)
    expect(storage.dump()).toEqual({ 'bagful-theme': 'dark', 'ph_phc_key_posthog': 'x' })
  })

  it('does not throw when storage does', () => {
    const storage = {
      get length() {
        throw new Error('SecurityError')
      },
    }
    expect(() => migrateLegacyKeys(storage)).not.toThrow()
  })
})
