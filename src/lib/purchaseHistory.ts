// Pure helpers for the checkout-history view. Kept free of Vue/Supabase so the
// grouping logic can be unit-tested.

// One archived row. The grouping below only reads the first three, but the rest
// are what the history view renders, and leaving them to the index signature
// made every one of them `unknown` at the point of use.
export interface CheckoutEntry {
  purchased_at: string
  checkout_id?: string | null
  purchased_by?: string | null
  id?: string
  name?: string
  maker?: string | null
  quantity?: number
  added_by_name?: string | null
  added_by_image_url?: string | null
  [key: string]: unknown
}

export interface Checkout {
  key: string
  checkoutId: string | null
  purchasedBy: string | null
  purchasedAt: string
  items: CheckoutEntry[]
}

/**
 * Which day a group of checkouts belongs to, as data rather than as rendered
 * text. The view turns this into words.
 *
 * Not a formatted label: that would make a pure, unit-tested grouping function
 * depend on the display language, and grouping BY a string would merge two
 * different days that happen to format identically. Grouping is by
 * start-of-day, and the label is the view's business.
 */
export type DayLabel =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'date'; iso: string }

export interface DayGroup {
  /** Stable identity for :key, independent of language. */
  day: number
  label: DayLabel
  checkouts: Checkout[]
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Rows share a checkout_id when bought in one action; legacy rows without one
// fall back to grouping by purchaser + timestamp, which was one checkout.
function checkoutKey(entry: CheckoutEntry): string {
  return entry.checkout_id
    ? `c:${entry.checkout_id}`
    : `t:${entry.purchased_by ?? ''}@${entry.purchased_at}`
}

// A row-capped query can cut the oldest checkout in half: some of its items
// fall past the cap. When the result fills the cap, drop the trailing rows of
// that possibly-partial checkout so every checkout shown is complete. If all
// rows belong to a single checkout, keep them — a partial view beats an empty
// one.
export function trimPartialTail(entries: CheckoutEntry[], limit: number): CheckoutEntry[] {
  // Nothing was cut off if nothing came back. Its own clause rather than part of
  // the comparison below, which does not cover it: a limit of zero or less makes
  // `0 < limit` false and sends an empty list on to index -1.
  if (entries.length === 0) return entries
  if (entries.length < limit) return entries
  const lastKey = checkoutKey(entries[entries.length - 1]!)
  let cut = entries.length
  while (cut > 0 && checkoutKey(entries[cut - 1]!) === lastKey) cut--
  return cut === 0 ? entries : entries.slice(0, cut)
}

// Collapse purchase rows into checkout events (all items bought together), then
// bucket those events under day headers ("Today", "Yesterday", or a date).
// Input is assumed newest-first (as the query returns it); that order is
// preserved throughout. Rows with an unparseable timestamp are dropped.
export function groupCheckouts(
  entries: CheckoutEntry[],
  now: number = Date.now(),
): DayGroup[] {
  const events: Checkout[] = []
  const byKey = new Map<string, Checkout>()

  for (const entry of entries) {
    if (Number.isNaN(new Date(entry.purchased_at).getTime())) continue

    const key = checkoutKey(entry)
    let event = byKey.get(key)
    if (!event) {
      event = {
        key,
        checkoutId: entry.checkout_id ?? null,
        purchasedBy: entry.purchased_by ?? null,
        purchasedAt: entry.purchased_at,
        items: [],
      }
      byKey.set(key, event)
      events.push(event)
    }
    event.items.push(entry)
  }

  const today = startOfDay(now)
  const dayMs = 86_400_000
  const days: DayGroup[] = []
  const byDay = new Map<number, DayGroup>()

  for (const event of events) {
    const day = startOfDay(new Date(event.purchasedAt).getTime())
    const label: DayLabel =
      day === today
        ? { kind: 'today' }
        : day === today - dayMs
          ? { kind: 'yesterday' }
          : { kind: 'date', iso: event.purchasedAt }

    let group = byDay.get(day)
    if (!group) {
      group = { day, label, checkouts: [] }
      byDay.set(day, group)
      days.push(group)
    }
    group.checkouts.push(event)
  }

  // Items inside one checkout were archived in a single statement, so their
  // timestamps are identical and carry no order. Alphabetical is stable across
  // fetches and devices, and easy to scan.
  for (const event of events) {
    event.items.sort((a, b) =>
      // Pinned to 'en' rather than left to the device. The comment above claims
      // this order is stable across devices, and with `undefined` it quietly
      // was not: collation differs per locale (ro sorts 'ș' after 's', de folds
      // 'ö' with 'o'), so two members of one list could see the same
      // checkout in different orders. The pin is what makes the claim true.
      // It is a tie-breaker on catalog data, so no user-visible language is
      // involved either way.
      String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', { sensitivity: 'base' }),
    )
  }

  return days
}
