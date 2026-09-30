// Looking a string up in the language the app is currently in.
//
// Hand-rolled rather than vue-i18n, and the deciding argument was the test
// suite. Around forty test files mount a component with a bare
// `mount(Component, …)` and no `global.plugins` — appSettingsModal's helper is
// the typical shape — and vue-i18n's `$t` only exists after `app.use(i18n)`.
// Adopting it would mean editing every one of those files and remembering to
// wire the plugin into every future one. A plain exported `t()` imported in
// `<script setup>` is auto-exposed to the template by the SFC compiler and
// needs no app context at all, so the suite kept passing untouched.
//
// The same property is why `t()` works in plain .ts — shoppingListActions,
// purchaseHistory, the router guard — with no useI18n()/setup-context rule to
// remember. That is the shape setSupabaseTokenResolver already uses in
// supabase.ts: module-scope state installed once at boot, read from anywhere.
//
// Romanian is the other half of the argument. It has three cardinal plural
// categories where English has two, and Intl.PluralRules knows them natively,
// whereas vue-i18n's default pluralization is positional and would need a
// custom rule per language — the part we would have had to replace anyway.
//
// ── THE ONE TRAP ──────────────────────────────────────────────────────────
// A `t()` call at MODULE SCOPE runs once at import and never updates:
//
//     const OFFLINE_MESSAGE = t('error.offline')   // WRONG — frozen forever
//
// It has to be inside a function, a computed, or the template. Reactivity here
// comes from `t()` reading `messages.value` during render, which subscribes
// whatever is rendering; a value captured into a module const was never
// rendering. Grep a file for top-level string constants before translating it.
//
// ── WHAT IS DELIBERATELY NOT TRANSLATED ───────────────────────────────────
// Written down because a later "finish the i18n pass" sweep will otherwise
// treat each of these as an oversight:
//
//   • Product names and makers. Catalog data, largely Romanian, and not ours
//     to restate: they arrive already normalised by whatever fills the
//     catalog.
//   • List names, member display names, invite codes. User data.
//   • nativeOAuth.ts's thrown Error text. It is a plain Error, so userMessage
//     replaces it before it can reach a screen; its whole value is being a
//     greppable string in Sentry.
//   • errorReporting.ts breadcrumbs and tags, issueReport.ts payload fields.
//     Read by us, not by users, and worth less once they vary by language.
//
// ── THE ONE CATALOG THAT IS NOT HERE ──────────────────────────────────────
// Push notification copy IS translated, and deliberately not from this file.
// It lives in supabase/functions/_shared/push.ts, because a Supabase edge
// function may only import from under supabase/functions — the directory the
// CLI uploads — so it cannot reach src/locales however much it would like to.
// Six languages, three sentences each. If a seventh language is ever added
// here, that table is the other place it has to be added, and nothing will say
// so: a missing key there is a silent fall back to English rather than an
// error. lib/pushNotifications' setPushLanguage() is the half that tells
// OneSignal which of them to deliver.
//   • android/app/src/main/res/values/strings.xml. Two brand names and two
//     identifiers, one of which is the bagful:// scheme Clerk's OAuth return
//     leg matches — see CLAUDE.md.
//   • index.html's <meta name="description">. Static markup served before any
//     of this has run, for the same reason vite.config.js pins the manifest to
//     lang: 'en': localising it means shipping six copies and swapping them at
//     runtime, which is not what a description tag is worth.
//   • MEMBER_FALLBACK_NAME in userIdentity.ts. It looks like display copy and
//     is not: the same string is the profiles column default and what
//     buy_items() and join_list_with_code() write in 003/005, so it has
//     to read the same to every member's device. memberDisplayName() beside it
//     IS translated, and the comment there marks exactly where the two part.
//   • The localeCompare(…, 'en') pins in productSuggestions, productRecents,
//     purchaseHistory and HomeView. Sorting by the reader's language would
//     order one list differently on two phones; the pin is what
//     makes "same order everywhere" true. They are tie-breakers over catalog
//     data, so no translated word is involved either way.

import { ref, shallowRef } from 'vue'
import en from '../locales/en'
import { isLocale, resolveBootLocale, saveLocale, loadUserLocale } from './locale'
import type { Locale } from './locale'

/**
 * A pluralized message. `other` is required and is the fallback for every
 * category a language does not supply, so a catalog can carry only the forms
 * that language actually distinguishes.
 */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

export type MessageKey = keyof typeof en

/**
 * The shape every catalog must have, derived from English so the two can never
 * drift silently: a key English spells as a string must be a string
 * everywhere, and a plural entry must be a plural entry everywhere.
 */
export type Catalog = {
  [K in MessageKey]: (typeof en)[K] extends string ? string : PluralForms
}

/** Keys whose value is a plural entry — the ones tn() accepts. */
export type PluralKey = {
  [K in MessageKey]: (typeof en)[K] extends string ? never : K
}[MessageKey]

/** Keys whose value is a plain string — the ones t() accepts. */
export type TextKey = {
  [K in MessageKey]: (typeof en)[K] extends string ? K : never
}[MessageKey]

export type MessageParams = Record<string, string | number>

// English is imported statically: it is the fallback, the type source, and the
// only catalog a test or an offline first paint can count on being present.
// The other five are code-split, so a build ships one small chunk per language
// instead of all six in the entry bundle. Vite's precache glob already covers
// them, so the service worker has them before they are ever asked for.
const loaders = import.meta.glob<{ default: Catalog }>('../locales/*.ts')

const currentLocale = ref<Locale>('en')

// shallowRef, not ref: the catalog is swapped wholesale and never mutated in
// place, so there is nothing for deep reactivity to buy — and it would walk a
// few hundred keys on every change to buy it.
const messages = shallowRef<Catalog>(en)

// Resolves once the boot locale's catalog is in. The router guard awaits this,
// which is what keeps any view from rendering against the wrong language.
let ready: Promise<void> = Promise.resolve()

const catalogCache = new Map<Locale, Catalog>([['en', en]])
const pluralRulesCache = new Map<Locale, Intl.PluralRules>()
const dateFormatCache = new Map<string, Intl.DateTimeFormat>()

export function getLocale(): Locale {
  return currentLocale.value
}

async function loadCatalog(locale: Locale): Promise<Catalog> {
  const cached = catalogCache.get(locale)
  if (cached) return cached
  const load = loaders[`../locales/${locale}.ts`]
  // A missing chunk means a failed lazy import (a stale deploy asking for a
  // hash that no longer exists — see the vite:preloadError handler in main.ts)
  // or a locale in LOCALES with no file. Neither is worth a white screen when
  // English is sitting right here.
  if (!load) return en
  try {
    const mod = await load()
    catalogCache.set(locale, mod.default)
    return mod.default
  } catch {
    return en
  }
}

/**
 * Put a language on the page and remember it.
 *
 * Everything that renders re-renders, because every `t()` call made during a
 * render subscribed to `messages`. No plugin, no provide/inject, no remount —
 * which is what lets the setup step switch the screen under itself the instant
 * a row is tapped.
 */
export async function setLocale(
  locale: Locale,
  storage?: Pick<Storage, 'setItem'>,
  userId = '',
): Promise<void> {
  const next = isLocale(locale) ? locale : 'en'
  messages.value = await loadCatalog(next)
  currentLocale.value = next
  applyDocumentLanguage(next)
  if (storage) saveLocale(storage, userId, next)
}

/**
 * Stamp the language on the root element, the same way applyResolvedTheme
 * stamps data-theme. Screen readers pick their pronunciation from it and
 * `:lang()` selectors key off it.
 *
 * index.html stays `lang="en"`: that is the correct answer for the document
 * before any JavaScript has run, and this overwrites it in the same tick the
 * theme is applied.
 *
 * No `dir` handling, deliberately. All six languages are left-to-right. RTL is
 * not one attribute — it is mirrored layouts, flipped icons and logical CSS
 * properties throughout — so a lone `dir` stamp would be the appearance of
 * support rather than support. If Arabic or Hebrew is ever added, that is the
 * work, and it starts here.
 */
function applyDocumentLanguage(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('lang', locale)
}

/**
 * Clerk's own copy for the boot language, or undefined for English.
 *
 * The sign-in UI here is entirely custom, so Clerk renders no chrome of its
 * own — the single thing this affects is the error text LoginView surfaces
 * from `clerkErrors[0].longMessage`. That is worth translating anyway, because
 * on a sign-in screen "that code has expired" is a great deal more useful than
 * the generic fallback, and a wrong-language sentence is the only alternative.
 *
 * Fetched lazily and only when it is needed: English readers never download it,
 * and the bundle is ~30 KB for anyone else. A failure resolves to undefined,
 * leaving Clerk's English default, because a missing translation must not stop
 * anyone signing in.
 *
 * Clerk's plugin reads this once at app.use(), so a language changed later in
 * Settings does not re-localize it. Accepted: by the time that control is
 * reachable the user is signed in and past every string this covers.
 */
async function loadClerkLocalization(locale: Locale): Promise<object | undefined> {
  if (locale === 'en') return undefined
  // Deep per-locale imports, NOT `import('@clerk/localizations')`. The barrel
  // re-exports every language Clerk ships, and importing it produced a single
  // 3.67 MB chunk — over the service worker's 2 MB precache limit, which is
  // how it was caught. Each subpath is ~20 KB.
  //
  // Written out as a literal map rather than a template path: a fully dynamic
  // `import(...)` specifier makes the bundler include every file that could
  // match, which is the same problem again.
  try {
    switch (locale) {
      case 'ro':
        return (await import('@clerk/localizations/ro-RO')).roRO
      case 'de':
        return (await import('@clerk/localizations/de-DE')).deDE
      case 'es':
        return (await import('@clerk/localizations/es-ES')).esES
      case 'fr':
        return (await import('@clerk/localizations/fr-FR')).frFR
      case 'it':
        return (await import('@clerk/localizations/it-IT')).itIT
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

let clerkLocalization: object | undefined

/** The Clerk copy for the boot language. Only meaningful after initLocale. */
export function getClerkLocalization(): object | undefined {
  return clerkLocalization
}

/**
 * Pick the boot language and start fetching its catalog. Called pre-mount from
 * main.ts, beside the theme, and deliberately NOT awaited there: nothing is on
 * screen that early and index.html carries no static splash markup, so waiting
 * would buy a blank frame. The router guard awaits `whenLocaleReady()` instead,
 * which puts the wait behind AppSplash where there is already something to look
 * at.
 *
 * No user id at this point — Clerk has not resolved. See resolveBootLocale for
 * what stands in until applyUserLocale runs.
 */
export function initLocale(
  storage: Pick<Storage, 'getItem'>,
  languages: readonly string[] | undefined,
): Promise<void> {
  const boot = resolveBootLocale(storage, languages)
  // Stamped synchronously so the attribute is right from the first paint even
  // though the catalog behind it is still in flight.
  applyDocumentLanguage(boot)
  currentLocale.value = boot
  // Clerk's copy is fetched alongside our own, not after it, so the two share
  // one wait behind the splash instead of taking two.
  ready = Promise.all([loadCatalog(boot), loadClerkLocalization(boot)]).then(
    ([catalog, clerk]) => {
      messages.value = catalog
      clerkLocalization = clerk
    },
  )
  return ready
}

/** Awaited as the first line of the router guard. */
export function whenLocaleReady(): Promise<void> {
  return ready
}

/**
 * Reconcile the device's guess with the account's actual choice, once Clerk
 * has said who this is. Called from HomeView beside rememberUser.
 *
 * An account with no stored choice is one that predates this feature — it
 * never saw the setup step. Rather than ambush a returning user with a startup
 * question, it adopts whatever this device is already showing and files that
 * under the account. Wrong at most once, and changeable in two taps.
 */
export async function applyUserLocale(storage: Storage, userId: string): Promise<void> {
  if (!userId) return
  const chosen = loadUserLocale(storage, userId)
  if (chosen) {
    await setLocale(chosen, storage, userId)
    return
  }
  saveLocale(storage, userId, currentLocale.value)
}

/**
 * Substitute `{name}` placeholders.
 *
 * An unsupplied placeholder is left standing rather than blanked. A visible
 * `{count}` on screen is a bug report; a silent gap is a mystery, and the
 * catalog-parity test exists to catch the case before either happens.
 */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

/**
 * The string for `key` in the current language.
 *
 * An unknown key returns the key itself and never throws. That is not
 * politeness: App.vue's onErrorCaptured boundary is the last thing between a
 * bug and a white page, and a typo in a translation key must not be what takes
 * the app down. A key rendered on screen is loud enough.
 */
export function t(key: TextKey, params?: MessageParams): string {
  return interpolate(rawMessage(key), params)
}

/** The catalog template for `key`, placeholders still standing. */
function rawMessage(key: TextKey): string {
  const entry = messages.value[key] as string | PluralForms | undefined
  if (typeof entry === 'string') return entry
  // Wrong shape or missing: fall back to English before falling back to the
  // key, so a gap in one catalog reads as English rather than as debug output.
  const fallback = (en as Record<string, unknown>)[key]
  if (typeof fallback === 'string') return fallback
  return key
}

function pluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRulesCache.set(locale, rules)
  }
  return rules
}

/**
 * Which plural form `n` takes in `locale`. Exported so the catalog test can
 * ask the same question the runtime will.
 */
export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  return pluralRules(locale).select(n)
}

/**
 * The plural string for `n`, with `{n}` already substituted.
 *
 * The categories differ per language and are not a matter of taste:
 * English and German distinguish one/other; Romanian needs one (1),
 * few (0 and 2-19) and other (20+, which also takes the "de" — "20 de
 * produse"); Spanish, French and Italian add a `many` that only appears at
 * exact millions, which a shopping list will never reach, so their catalogs
 * carry one/other and let this function's `other` fallback cover it.
 */
export function tn(key: PluralKey, n: number, params: MessageParams = {}): string {
  const entry = messages.value[key] as PluralForms | undefined
  const forms = entry ?? ((en as Record<string, unknown>)[key] as PluralForms | undefined)
  if (!forms) return key
  const form = forms[pluralCategory(currentLocale.value, n)] ?? forms.other
  return interpolate(form, { n, ...params })
}

/**
 * The string for `key`, split on its `[accent]` marker into before/accent/after.
 *
 * The setup headings wrap one word in `.heading--accent`. Splitting that into
 * a `titleLead` key and a `titleAccent` key would pin the accented word to a
 * fixed position, which German will not tolerate — the noun can land at the
 * end. A marker inside one string lets each translator put it where their
 * sentence puts it.
 *
 * The split happens on the catalog template and the fragments are interpolated
 * afterwards, which is the whole reason this takes a key rather than a finished
 * string. Interpolating first would let a bracket inside a value decide where
 * the accent lands — a list named `Home]s` would cut the bolded run short.
 * Only the translator's own brackets can be seen from here.
 *
 * No marker returns the whole string as the lead, so a translator who drops
 * the brackets gets an unstyled but correct heading rather than nothing.
 */
export function tAccent(key: TextKey, params?: MessageParams): [string, string, string] {
  const raw = rawMessage(key)
  const match = /^(.*?)\[(.+?)\](.*)$/s.exec(raw)
  // All three groups are unconditional in the pattern above -- none sits behind
  // a `?` or an alternation -- so a match that succeeded captured all three.
  const parts: [string, string, string] = match
    ? [match[1]!, match[2]!, match[3]!]
    : [raw, '', '']
  return [
    interpolate(parts[0], params),
    interpolate(parts[1], params),
    interpolate(parts[2], params),
  ]
}

function dateFormat(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // Cached because PurchaseHistoryModal formats once per row, and constructing
  // an Intl.DateTimeFormat is the expensive part of doing so.
  const cacheKey = `${locale}|${JSON.stringify(options)}`
  let formatter = dateFormatCache.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    dateFormatCache.set(cacheKey, formatter)
  }
  return formatter
}

/** A date in the app's language, rather than in whatever the device is set to. */
export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions): string {
  return dateFormat(currentLocale.value, options).format(new Date(value))
}

/** A time in the app's language. 12h vs 24h follows the language, not the device. */
export function formatTime(value: string | number | Date): string {
  return dateFormat(currentLocale.value, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  )
}

// Re-exported so a component needs one import for the whole subject rather
// than remembering which half of it lives where.
export { LOCALES, LOCALE_ENDONYMS } from './locale'
export type { Locale } from './locale'
