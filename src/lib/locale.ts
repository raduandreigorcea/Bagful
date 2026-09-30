// Which language the app is in: the list of them, where the choice is stored,
// and how a device's own languages map onto that list.
//
// Deliberately Vue-free and catalog-free. This half is pure functions over a
// `storage` handed in, the same shape as lib/theme — which is what lets the
// boot path, the settings dialog and the setup step all agree on one key
// without any of them owning the state. lib/i18n owns the reactive half and
// imports from here; nothing goes the other way.
//
// TWO keys, where theme needed one, and the reason is boot ordering. Theme is
// a property of the device, so it is readable before anyone signs in. A
// language is a property of the person — but AppSplash and LoginView both
// render before Clerk has resolved, and there is no user id to scope by yet.
// So the scoped key is the truth and the device key is a hint about what to
// show until the truth arrives, which is exactly the division
// 'bagful-last-user' makes in lib/session for the same reason.

import { userScopedKey } from './perUserStorage'

export const LOCALES = ['en', 'ro', 'de', 'es', 'fr', 'it'] as const

export type Locale = (typeof LOCALES)[number]

/**
 * What each language calls itself. Endonyms, not English names: someone who
 * needs this screen is by definition not reading the English one, and
 * "Romanian" is no help to a person looking for "Română".
 */
export const LOCALE_ENDONYMS: Record<Locale, string> = {
  en: 'English',
  ro: 'Română',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
}

// The device hint: what this device last applied, for any account or none.
// Read pre-mount and by the login screen, where no user id exists yet.
export const LOCALE_DEVICE_KEY = 'bagful-locale'

// The truth, once an account is known: `bagful-locale:<userId>`.
//
// Note the prefix and the device key are the same string, which is safe and
// only just so. `clearUserScopedKeys(storage, LOCALE_PREFIX)` sweeps keys
// starting with `bagful-locale:` — the colon is in the pattern — so an
// unscoped sweep takes every account's and leaves the device hint standing.
// That is the behaviour we want, but it is a near-collision of exactly the
// kind perUserStorage's own comment warns about, so it is stated rather than
// left to be rediscovered.
export const LOCALE_PREFIX = 'bagful-locale'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** What this device last applied, or null when it has never applied anything. */
export function loadDeviceLocale(storage: Pick<Storage, 'getItem'>): Locale | null {
  try {
    const saved = storage.getItem(LOCALE_DEVICE_KEY)
    return isLocale(saved) ? saved : null
  } catch {
    return null
  }
}

/**
 * This account's choice, or null when it has never made one.
 *
 * Null is load-bearing beyond "no value": it is how the setup step knows to
 * ask. Same trick as the notification preference, and the same caveat — a
 * locale of 'en' is a real answer somebody gave, not the absence of one.
 */
export function loadUserLocale(storage: Pick<Storage, 'getItem'>, userId: string): Locale | null {
  if (!userId) return null
  try {
    const saved = storage.getItem(userScopedKey(LOCALE_PREFIX, userId))
    return isLocale(saved) ? saved : null
  } catch {
    return null
  }
}

/** Whether this account has ever chosen, which is what gates the setup step. */
export function hasUserLocale(storage: Pick<Storage, 'getItem'>, userId: string): boolean {
  return loadUserLocale(storage, userId) !== null
}

/**
 * Record a choice under both keys.
 *
 * The device key is written even with no user id, because the point of it is
 * the screens that render before there is one. The scoped key is what survives
 * somebody else signing in on this device.
 */
export function saveLocale(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  locale: Locale,
): void {
  try {
    storage.setItem(LOCALE_DEVICE_KEY, locale)
    if (userId) storage.setItem(userScopedKey(LOCALE_PREFIX, userId), locale)
  } catch {
    // Storage disabled — the language applies now and simply won't persist.
  }
}

/**
 * The best match for a device's own language preferences, or 'en'.
 *
 * Matches on the primary subtag only, so 'ro-RO', 'de-AT' and 'es-419' all
 * land somewhere useful. The list is walked in order because that order is the
 * user's stated preference: someone with ['hu', 'ro', 'en'] should get
 * Romanian rather than English, even though we have neither Hungarian nor
 * their first choice.
 *
 * Takes the list as an argument rather than reading `navigator` so it is a
 * pure function, testable without a DOM — same posture as loadThemeMode taking
 * its storage.
 */
export function detectDeviceLocale(languages: readonly string[] | undefined): Locale {
  for (const tag of languages ?? []) {
    const primary = String(tag).toLowerCase().split('-')[0]
    if (isLocale(primary)) return primary
  }
  return 'en'
}

/**
 * What to show before Clerk has told us who this is.
 *
 * Device hint first, then detection, then English. Falling through to
 * detection rather than straight to English is what makes the first-run
 * language step feel like a confirmation instead of an interrogation: a
 * Romanian phone arrives at that screen already reading Romanian.
 */
export function resolveBootLocale(
  storage: Pick<Storage, 'getItem'>,
  languages: readonly string[] | undefined,
): Locale {
  return loadDeviceLocale(storage) ?? detectDeviceLocale(languages)
}
