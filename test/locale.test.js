// The storage contract behind the language choice, pinned the way theme.test
// pins the theme's — except this one has two keys instead of one, and the
// interesting cases are all about the seam between them.
//
// The seam matters because the scoped key is the truth and the device key is
// what the login screen reads before there is an account to be the truth
// about. Getting either half wrong is invisible until somebody signs out.
import { describe, it, expect } from 'vitest'
import {
  LOCALES,
  LOCALE_DEVICE_KEY,
  LOCALE_PREFIX,
  detectDeviceLocale,
  hasUserLocale,
  isLocale,
  loadDeviceLocale,
  loadUserLocale,
  resolveBootLocale,
  saveLocale,
} from '../src/lib/locale'
import { clearUserScopedKeys, userScopedKey } from '../src/lib/perUserStorage'
import { makeStorage } from './support/fakeStorage.js'

const scoped = (userId) => userScopedKey(LOCALE_PREFIX, userId)

describe('detectDeviceLocale', () => {
  it('matches on the primary subtag, so a region never costs a match', () => {
    expect(detectDeviceLocale(['ro-RO'])).toBe('ro')
    expect(detectDeviceLocale(['de-AT'])).toBe('de')
    expect(detectDeviceLocale(['es-419'])).toBe('es')
    expect(detectDeviceLocale(['EN-GB'])).toBe('en')
  })

  it('walks the list in order, since that order is the stated preference', () => {
    // Hungarian is not supported; Romanian is, and beats the English after it.
    expect(detectDeviceLocale(['hu', 'ro', 'en'])).toBe('ro')
    expect(detectDeviceLocale(['pt-BR', 'fr'])).toBe('fr')
  })

  it('falls back to English for a language we do not have', () => {
    expect(detectDeviceLocale(['ja', 'ko'])).toBe('en')
  })

  it('falls back to English for an empty or absent list', () => {
    expect(detectDeviceLocale([])).toBe('en')
    expect(detectDeviceLocale(undefined)).toBe('en')
  })
})

describe('isLocale', () => {
  it('accepts every locale we ship and nothing else', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true)
    for (const value of ['EN', 'ro-RO', 'ja', '', null, undefined, 7]) {
      expect(isLocale(value)).toBe(false)
    }
  })
})

describe('saveLocale', () => {
  it('writes both keys, so the next boot and the next sign-in agree', () => {
    const storage = makeStorage()
    saveLocale(storage, 'user-1', 'ro')
    expect(storage.map.get(LOCALE_DEVICE_KEY)).toBe('ro')
    expect(storage.map.get(scoped('user-1'))).toBe('ro')
  })

  it('still records the device hint when nobody is signed in', () => {
    const storage = makeStorage()
    saveLocale(storage, '', 'de')
    expect(storage.map.get(LOCALE_DEVICE_KEY)).toBe('de')
    expect([...storage.map.keys()]).toEqual([LOCALE_DEVICE_KEY])
  })

  it('swallows a refused write — the language just does not persist', () => {
    const storage = {
      setItem() {
        throw new Error('quota')
      },
    }
    expect(() => saveLocale(storage, 'user-1', 'fr')).not.toThrow()
  })
})

describe('loadUserLocale and hasUserLocale', () => {
  it('reads back what save wrote, per account', () => {
    const storage = makeStorage()
    saveLocale(storage, 'user-1', 'it')
    saveLocale(storage, 'user-2', 'es')
    expect(loadUserLocale(storage, 'user-1')).toBe('it')
    expect(loadUserLocale(storage, 'user-2')).toBe('es')
  })

  it('reports null for an account that has never chosen', () => {
    const storage = makeStorage({ [LOCALE_DEVICE_KEY]: 'ro' })
    expect(loadUserLocale(storage, 'user-1')).toBeNull()
    expect(hasUserLocale(storage, 'user-1')).toBe(false)
  })

  it('treats English as a real answer, not as the absence of one', () => {
    // The setup step keys off hasUserLocale, so an English speaker who picked
    // English must not be asked again on the next fresh install.
    const storage = makeStorage()
    saveLocale(storage, 'user-1', 'en')
    expect(hasUserLocale(storage, 'user-1')).toBe(true)
  })

  it('reports null with no user id rather than reading the device key', () => {
    const storage = makeStorage({ [LOCALE_DEVICE_KEY]: 'ro' })
    expect(loadUserLocale(storage, '')).toBeNull()
  })

  it('ignores a value no build ever wrote', () => {
    const storage = makeStorage({ [scoped('user-1')]: 'sepia' })
    expect(loadUserLocale(storage, 'user-1')).toBeNull()
  })

  it('returns null when storage is unusable rather than throwing', () => {
    const storage = {
      getItem() {
        throw new Error('storage disabled')
      },
    }
    expect(loadUserLocale(storage, 'user-1')).toBeNull()
    expect(loadDeviceLocale(storage)).toBeNull()
  })
})

describe('resolveBootLocale', () => {
  it('prefers what this device last applied over what the device is set to', () => {
    const storage = makeStorage({ [LOCALE_DEVICE_KEY]: 'ro' })
    expect(resolveBootLocale(storage, ['de-DE'])).toBe('ro')
  })

  it('falls through to detection on a device that has never applied one', () => {
    // This is what makes the first-run step a confirmation rather than an
    // interrogation: the screen asking the question is already in Romanian.
    expect(resolveBootLocale(makeStorage(), ['ro-RO', 'en'])).toBe('ro')
  })

  it('lands on English when neither the hint nor the device offers anything', () => {
    expect(resolveBootLocale(makeStorage(), ['ja'])).toBe('en')
  })
})

describe('the seam between the two keys', () => {
  it('leaves the device hint standing when every account is swept', () => {
    // The prefix and the device key are the same string; only the colon in
    // `bagful-locale:` keeps an unscoped sweep off the hint. If that ever
    // stops being true, the login screen starts reverting to English.
    const storage = makeStorage()
    saveLocale(storage, 'user-1', 'ro')
    saveLocale(storage, 'user-2', 'de')

    clearUserScopedKeys(storage, LOCALE_PREFIX)

    expect(loadUserLocale(storage, 'user-1')).toBeNull()
    expect(loadUserLocale(storage, 'user-2')).toBeNull()
    expect(loadDeviceLocale(storage)).toBe('de')
  })

  it('leaves the other account and the hint alone when one account is swept', () => {
    const storage = makeStorage()
    saveLocale(storage, 'user-1', 'ro')
    saveLocale(storage, 'user-2', 'de')

    clearUserScopedKeys(storage, LOCALE_PREFIX, 'user-1')

    expect(loadUserLocale(storage, 'user-1')).toBeNull()
    expect(loadUserLocale(storage, 'user-2')).toBe('de')
    expect(loadDeviceLocale(storage)).toBe('de')
  })
})
