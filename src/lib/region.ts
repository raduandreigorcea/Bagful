// Where the phone is, guessed from its timezone and never asked for.
//
// Nearly every catalog product names the markets it is sold in. Without telling
// the catalog where the searcher is, a list in Romania would rank every
// country's products together, by a popularity measured across all of Europe.
//
// NOBODY IS ASKED: there is no picker, no storage, and no `userId` in any
// signature here. What a person notices is product names they cannot read, and
// search_catalog ranks on product_catalog.name_lang first, fed by the language
// the app is already in, so the readable name comes up without a setting.
//
// LANGUAGE IS NOT LOCATION -- someone can run their phone in English and do
// their shopping in Bucharest. The timezone is the one signal a phone carries
// that tracks where its owner IS rather than what they read, and it stays the
// input to p_markets. Language says whether you can read a product, market says
// whether you can buy it, and search_catalog ranks on both in that order.
//
// THE ONE THING MISSING is a manual override. A traveller, a VPN, or a phone
// on a factory-default timezone has no way to correct the guess. That is
// affordable only because the guess does not decide much:
// getting the market wrong reorders within a language, and the language is
// read from the app itself and cannot be wrong the same way.
//
// Deliberately Vue-free and catalog-free, the same shape as lib/locale and
// lib/theme: pure functions with nothing injected but their arguments, so
// nothing here needs a DOM to test and no screen owns the state.

/**
 * The markets the catalog can actually speak about.
 *
 * These eleven MUST stay in step with whatever writes product_catalog.markets
 * in the catalog project. A code detected here that the importer never writes
 * would match no product at all, so a phone in that timezone would have the
 * entire catalog demoted.
 *
 * test/catalog/markets.test.js pins this list against the catalog's own.
 */
export const MARKETS = ['RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE'] as const

export type Market = (typeof MARKETS)[number]

/**
 * IANA zones to markets.
 *
 * navigator.languages says 'en-US' for an English phone in Bucharest;
 * Europe/Bucharest says Romania. See the header.
 *
 * Only zones belonging to the eleven markets are listed, and several countries
 * own more than one: Spain has the Canaries and Ceuta, Germany has Busingen
 * (the enclave inside Switzerland, which keeps its own zone). Anything else
 * returns null, which means no market is sent at all -- see
 * detectRegionFromTimeZone.
 */
const TIMEZONE_MARKETS: Record<string, Market> = {
  'Europe/Bucharest': 'RO',
  'Europe/Chisinau': 'MD',
  'Europe/Tiraspol': 'MD',
  'Europe/Berlin': 'DE',
  'Europe/Busingen': 'DE',
  'Europe/Vienna': 'AT',
  'Europe/Zurich': 'CH',
  'Europe/Madrid': 'ES',
  'Africa/Ceuta': 'ES',
  'Atlantic/Canary': 'ES',
  'Europe/Paris': 'FR',
  'Europe/Brussels': 'BE',
  'Europe/Rome': 'IT',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
}

export function isMarket(value: unknown): value is Market {
  return typeof value === 'string' && (MARKETS as readonly string[]).includes(value)
}

/**
 * The market a timezone implies, or null for one we do not cover.
 *
 * Fails open, exactly as marketCodes() does in the importer and for the same
 * reason: a null here means no p_markets is sent, the catalog ranks on language
 * and popularity alone, and somebody in Poland or Brazil is no worse off than
 * they were yesterday. Guessing a neighbour would be worse than not guessing.
 *
 * Takes the zone as an argument rather than reading Intl itself, so the tests
 * never depend on the machine they run on -- same posture as detectDeviceLocale
 * taking its language list.
 */
export function detectRegionFromTimeZone(timeZone: string | undefined): Market | null {
  if (!timeZone) return null
  return TIMEZONE_MARKETS[timeZone] ?? null
}

/**
 * This device's timezone, or undefined where Intl is unavailable or throws.
 *
 * The one impure function here, kept apart from everything above so the rest of
 * the module stays testable without stubbing globals.
 */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/**
 * What to send as p_markets, or null when the timezone answers nothing.
 *
 * Fails open: null means no p_markets is sent and the catalog ranks on language
 * and popularity alone, which is strictly better than guessing a neighbouring
 * country.
 *
 * STILL TAKES THE ZONE, even though it now has only one caller and that caller
 * always passes deviceTimeZone(). Closing over Intl here instead would read
 * better and would quietly break every test above it: the component suite fakes
 * deviceTimeZone through the module export, and a call made from inside this
 * module binds the real one, so the assertions would start depending on the
 * clock of whatever machine ran them -- Europe/Bucharest on this developer's
 * box, UTC on CI, and "no market is sent" passing or failing on the difference.
 * detectRegionFromTimeZone says the same thing one function up; this is the
 * seam that makes it true from the outside.
 */
export function resolveRegion(timeZone: string | undefined): Market | null {
  return detectRegionFromTimeZone(timeZone)
}
