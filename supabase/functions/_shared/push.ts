// The decisions behind the push fan-out, separated from the runtime that
// delivers it.
//
// WHY THIS FILE EXISTS
//
// push-on-item-insert/index.ts is deployed code that nothing in this repo could
// check. tsconfig.json includes only `src/**`, so vue-tsc never sees it; eslint
// reads it but typescript-eslint turns off no-undef, so `Deno.env` and the
// `npm:` specifier pass without ever being resolved; and it could not be
// unit-tested, because importing it runs `Deno.serve` and `createClient` at
// module scope. So the one piece of the product that decides what every
// notification SAYS had no coverage of any kind.
//
// Splitting it is the same move the catalog repo already makes with
// catalog/supabase/functions/_shared, and it is a deployment constraint rather
// than taste: a Supabase edge function may only import files inside
// supabase/functions, because that is the directory the CLI uploads. `_shared`
// is Supabase's own convention for the part that several places need.
//
// So: no Deno APIs, no Node built-ins, no npm imports. Everything here is
// standard and runs unchanged under Deno, under Node and under vitest. Deno
// resolves imports by full path, which is why index.ts asks for `push.ts` with
// its extension.

/** A shopping_list_items row, as the webhook delivers it. */
export interface ItemRecord {
  id: string
  list_id: string
  name: string
  quantity: number | null
  added_by: string
}

/** A purchase_history row, as the webhook delivers it. */
export interface PurchaseRecord {
  checkout_id: string
  list_id: string
  purchased_by: string
}

/** Enough of a purchase_history row to name it in a message. */
export interface PurchasedItem {
  name: string
  quantity: number | null
}

/**
 * One product as it appears in a notification.
 *
 * A quantity of 1 is not worth saying: "Radu added Milk" reads as a sentence
 * and "Radu added Milk ×1" reads as a database row. Anything unparseable or
 * missing falls back to 1 for the same reason, since the alternative is
 * "Milk ×NaN" on somebody's lock screen.
 */
export function itemLabel(name: string, quantity: number | null): string {
  const qty = Number(quantity) || 1
  return qty > 1 ? `${name} ×${qty}` : name
}

/**
 * The six languages the app speaks, and the copy each of them gets.
 *
 * WHY THIS TABLE IS HERE AND NOT IN src/locales.
 *
 * A Supabase edge function may only import files under supabase/functions —
 * that is the directory the CLI uploads — so it cannot read the app's own
 * catalogs even though they hold the same six languages. The duplication is a
 * deployment constraint, not a choice, and it is small and self-contained for
 * that reason: three sentences per language and no interpolation the app's
 * `t()` would do better.
 *
 * `en` is the fallback and must stay complete: OneSignal falls back to it for
 * any subscriber whose language is not a key here.
 *
 * THE COUNT IS OFTEN ONE, which is the trap in the counted branch. It is
 * `labels.length - 2`, so a three-item checkout — much the commonest kind —
 * spells it "and 1 more". English and Spanish read the same either way; German,
 * French and Italian do not, and "et 1 autres" is the kind of wrong that makes
 * an app look machine-translated. So `andMore` branches on the count in the
 * three languages that need it, and Intl.PluralRules is deliberately not
 * reached for: two forms over a number that is always a positive integer is
 * what a ternary is for, and the plural machinery belongs in lib/i18n where
 * there are hundreds of strings to justify it.
 *
 * Two known cosmetic limits, named so they are not mistaken for oversights.
 * Spanish turns "y" into "e" before a word starting with i- or hi-, and Italian
 * turns "e" into "ed" before a vowel; both depend on the next word, which here
 * is an arbitrary product name. Getting them right means a phonetic rule over
 * user data for one conjunction on a lock screen, which is not worth the code.
 */
export type PushLocale = 'en' | 'ro' | 'de' | 'es' | 'fr' | 'it'

export const PUSH_LOCALES: PushLocale[] = ['en', 'ro', 'de', 'es', 'fr', 'it']

interface PushCopy {
  /** Who did it, when their profile has no name. */
  someone: string
  /** "{who} added {item}" */
  added: (who: string, item: string) => string
  /** "{who} bought {list}" */
  bought: (who: string, list: string) => string
  /** Exactly two products named in full. */
  pair: (a: string, b: string) => string
  /** Two named, the rest counted. */
  andMore: (a: string, b: string, rest: number) => string
}

const COPY: Record<PushLocale, PushCopy> = {
  en: {
    someone: 'Someone',
    added: (who, item) => `${who} added ${item}`,
    bought: (who, list) => `${who} bought ${list}`,
    pair: (a, b) => `${a} and ${b}`,
    andMore: (a, b, rest) => `${a}, ${b} and ${rest} more`,
  },
  ro: {
    someone: 'Cineva',
    added: (who, item) => `${who} a adăugat ${item}`,
    bought: (who, list) => `${who} a cumpărat ${list}`,
    pair: (a, b) => `${a} și ${b}`,
    andMore: (a, b, rest) => `${a}, ${b} și încă ${rest}`,
  },
  de: {
    someone: 'Jemand',
    added: (who, item) => `${who} hat ${item} hinzugefügt`,
    bought: (who, list) => `${who} hat ${list} gekauft`,
    pair: (a, b) => `${a} und ${b}`,
    // "weiteres" agrees with the neuter Produkt that is implied but not said.
    andMore: (a, b, rest) =>
      rest === 1 ? `${a}, ${b} und 1 weiteres` : `${a}, ${b} und ${rest} weitere`,
  },
  es: {
    someone: 'Alguien',
    added: (who, item) => `${who} añadió ${item}`,
    bought: (who, list) => `${who} compró ${list}`,
    pair: (a, b) => `${a} y ${b}`,
    andMore: (a, b, rest) => `${a}, ${b} y ${rest} más`,
  },
  fr: {
    someone: "Quelqu'un",
    added: (who, item) => `${who} a ajouté ${item}`,
    bought: (who, list) => `${who} a acheté ${list}`,
    pair: (a, b) => `${a} et ${b}`,
    andMore: (a, b, rest) =>
      rest === 1 ? `${a}, ${b} et 1 autre` : `${a}, ${b} et ${rest} autres`,
  },
  it: {
    someone: 'Qualcuno',
    added: (who, item) => `${who} ha aggiunto ${item}`,
    bought: (who, list) => `${who} ha comprato ${list}`,
    pair: (a, b) => `${a} e ${b}`,
    andMore: (a, b, rest) =>
      rest === 1 ? `${a}, ${b} e 1 altro` : `${a}, ${b} e altri ${rest}`,
  },
}

function copyFor(locale: PushLocale): PushCopy {
  return COPY[locale] ?? COPY.en
}

/**
 * The list of products in a checkout notification.
 *
 * Named in full up to two, then counted, because a lock screen truncates and
 * the useful half of the sentence is the beginning. "Bread, Milk and 4 more"
 * says what happened; six names elided mid-word do not.
 */
export function summariseCheckout(labels: string[], locale: PushLocale = 'en'): string {
  const copy = copyFor(locale)
  // Nothing to name. The caller already refuses to send for an empty checkout,
  // so this is unreachable from the handler -- but it was not unreachable from
  // the type, and the counted branch below would have read
  // "undefined, undefined and -2 more" on somebody's lock screen. A guard is
  // cheaper than relying on one caller to keep being careful.
  if (labels.length === 0) return ''
  // Beyond here the indices are guarded by the length checks, which is what the
  // assertions are recording.
  if (labels.length === 1) return labels[0]!
  if (labels.length === 2) return copy.pair(labels[0]!, labels[1]!)
  return copy.andMore(labels[0]!, labels[1]!, labels.length - 2)
}

/** "Radu added Milk ×2" */
export function itemAddedBody(who: string | null, item: ItemRecord, locale: PushLocale = 'en'): string {
  const copy = copyFor(locale)
  return copy.added(who || copy.someone, itemLabel(item.name, item.quantity))
}

/** "Radu bought Bread, Milk and 4 more" */
export function checkoutBody(
  who: string | null,
  items: PurchasedItem[],
  locale: PushLocale = 'en',
): string {
  const labels = items.map((i) => itemLabel(i.name, i.quantity))
  const copy = copyFor(locale)
  return copy.bought(who || copy.someone, summariseCheckout(labels, locale))
}

/**
 * Every language's version of one message, in the shape OneSignal's `contents`
 * field takes.
 *
 * This is what makes push multilingual without this function knowing anything
 * about who is receiving it. OneSignal holds a language per subscription — the
 * app sets it from the language the user actually reads, see
 * setPushLanguage() in src/lib/pushNotifications.ts — and picks the matching
 * key at delivery, falling back to `en`. So one REST call serves a list
 * whose members read three different languages, which is the common case here
 * and the reason this is not a per-recipient loop.
 */
export function localisedContents(build: (locale: PushLocale) => string): Record<string, string> {
  const contents: Record<string, string> = {}
  for (const locale of PUSH_LOCALES) contents[locale] = build(locale)
  return contents
}

/**
 * Who hears about it: every member except whoever did it.
 *
 * The exclusion is the whole point. Without it the person who just added the
 * milk gets a notification telling them they added the milk, which is the
 * fastest way to have somebody turn notifications off for good.
 *
 * Tolerates a null member list, because that is what a failed-but-unchecked
 * select hands over.
 */
export function recipientsFor(
  members: { user_id: string }[] | null | undefined,
  actorId: string,
): string[] {
  return (members ?? []).map((m) => m.user_id).filter((id) => id !== actorId)
}

/**
 * Whether the webhook presented the right shared secret.
 *
 * This is the ONLY thing standing between an unauthenticated POST and a push to
 * every member of a list: verify_jwt is off for this function, because a
 * database webhook carries no user JWT.
 *
 * Digests are compared rather than the strings themselves. A plain `===`
 * short-circuits on the first differing byte, so the time it takes leaks how
 * much of a guess was correct, and a secret can be recovered a character at a
 * time. Hashing first makes every comparison the same length and the same
 * shape, and the loop below is written without an early exit for the same
 * reason.
 */
export async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (given === null) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  // Both digests are SHA-256, so both are exactly 32 bytes and every index in
  // range hits on each. No early exit, deliberately -- see above.
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!
  return diff === 0
}

/** What a webhook payload asks this function to do, or null for nothing. */
export type PushJob =
  | { kind: 'item'; record: ItemRecord }
  | { kind: 'checkout'; record: PurchaseRecord }
  | null

/**
 * Read a webhook payload and decide which fan-out it is asking for.
 *
 * Only INSERT, and only the two tables that have triggers. Everything else is
 * skipped rather than refused: a webhook pointed at one more table by mistake
 * should do nothing quietly, not return an error the sender will retry.
 *
 * Split out from the request handler because the routing is the part most
 * likely to be got wrong by an edit and the part least likely to be noticed
 * when it is — a mis-typed table name here does not fail, it silently stops
 * notifying.
 */
export function routePayload(payload: unknown): PushJob {
  if (!payload || typeof payload !== 'object') return null
  const { type, table, record } = payload as {
    type?: string
    table?: string
    record?: unknown
  }
  if (type !== 'INSERT' || !record) return null
  if (table === 'shopping_list_items') return { kind: 'item', record: record as ItemRecord }
  if (table === 'purchase_history') return { kind: 'checkout', record: record as PurchaseRecord }
  return null
}
