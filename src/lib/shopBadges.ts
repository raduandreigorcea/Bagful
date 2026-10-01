import { ref, watch, type Ref } from 'vue'
import { getCatalogSupabase } from '../supabase'
import { productKey } from './productSearch'
import type { Market } from './region'

// Which shop each product on the list came from.
//
// A shopping list row is a row in the APP's database. It knows a name and a
// maker and nothing else, and it has no idea the catalog exists -- which is
// correct, and is why a list still works with no catalog configured at all.
// Suggestions carry `retailers` because they came from the catalog a moment ago;
// a row that was added last Tuesday does not.
//
// So this is a lookup, and one for the whole list at once. Twenty rows must not
// mean twenty round trips.
//
// EVERY FAILURE PATH RETURNS AN EMPTY MAP. This draws a decoration; a shopping list must not degrade because a second database is slow, and
// the caller renders nothing for a product it has no answer for anyway.

/** name + maker, folded, to the shops carrying it. */
export type ShopMap = Map<string, string[]>

// Read back out of storage and used as an icon name and a label. AppIcon
// resolves against a fixed set and yields nothing for an unknown name, and the
// label is text-bound, so neither is a hole -- but a slug that is not a slug is
// a sign the entry is junk, and dropping it is cheaper than reasoning about it.
const SLUG = /^[a-z0-9-]{1,40}$/

// ─── the shops themselves ────────────────────────────────────────────────────
// Read from the catalog rather than hardcoded, so the next retailer starts being
// offered as a filter the moment it has a row -- the same day it starts producing
// products, without a release. Mega Image arrived that way.
//
// The display names stay here because they are TYPOGRAPHY, not data: the
// catalog stores a slug, and "Mega Image" is not what capitalising `mega-image`
// produces. A shop with no entry falls back to its slug, which is ugly and
// readable, and is the right failure for a retailer added before anybody wrote
// its name down.
const SHOP_NAMES: Record<string, string> = {
  aldi: 'Aldi',
  auchan: 'Auchan',
  carrefour: 'Carrefour',
  delhaize: 'Delhaize',
  hofer: 'Hofer',
  kaufland: 'Kaufland',
  lidl: 'Lidl',
  'mega-image': 'Mega Image',
  mpreis: 'MPreis',
  penny: 'Penny',
}

/**
 * The chain a shop belongs to: `lidl-de` is Lidl. One chain in several countries
 * is one scraper configured per country, each with a slug of its own, and it is
 * still one name and one logo. Only a suffix that is a market code counts, so
 * `mega-image` stays itself.
 */
export function shopBrand(slug: string): string {
  return /^(.+)-(ro|md|de|at|ch|es|fr|be|it|gb|ie)$/.exec(slug)?.[1] ?? slug
}

export function shopLabel(slug: string): string {
  return SHOP_NAMES[slug] ?? SHOP_NAMES[shopBrand(slug)] ?? slug
}

// v2 stores the country with each slug; a v1 list of bare slugs cannot be
// filtered, so it is simply not read.
const SHOPS_KEY = 'bagful.shops.v2'

interface ShopEntry {
  slug: string
  country: string | null
  /** The site the scraper reads, e.g. `lidl.de`; the About credit links to it. */
  domain: string | null
}

// Read from the catalog and put into an href, so it is checked for being a bare
// hostname: letters, digits and dashes in dot-separated labels, nothing that
// could carry a scheme, a path or a script.
const DOMAIN = /^(?=.{4,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/

let shopRows: ShopEntry[] | null = null

// Only the shops of the phone's country. Ten Lidls are one Lidl to a person in
// one of them, and a chip for Lidl Italy in Romania is a filter that returns
// nothing. No market means every shop, the same way search reads it.
function forMarket(rows: ShopEntry[], market: Market | null): string[] {
  return rows.filter((r) => market === null || r.country === market).map((r) => r.slug)
}

/**
 * Every enabled shop in this market, for the filters to offer.
 *
 * A handful of rows, once a session, and cached across sessions so the filter
 * button is there on the first paint rather than appearing a moment later. On any
 * failure it answers with what it last knew, and with nothing at all if it has
 * never known anything -- which HIDES the filter. That is the safe direction:
 * no filter is a working app, and a filter offering shops that do not exist is
 * one that returns nothing and looks broken.
 */
export async function fetchShopList(market: Market | null = null): Promise<string[]> {
  return forMarket(await loadShops(), market)
}

export interface ShopCredit {
  name: string
  url: string | null
}

/**
 * The shops this market's product data comes from, for the About credit: one
 * entry per chain, by display name, linked to the site its scraper reads. Empty
 * when the catalog has never answered, which hides the credit rather than
 * naming shops that may not be the source.
 */
export async function fetchShopCredits(market: Market | null = null): Promise<ShopCredit[]> {
  const rows = (await loadShops()).filter((r) => market === null || r.country === market)
  const byName = new Map<string, ShopCredit>()
  for (const row of rows) {
    const name = shopLabel(row.slug)
    if (!byName.has(name)) byName.set(name, { name, url: row.domain ? `https://${row.domain}` : null })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function loadShops(): Promise<ShopEntry[]> {
  if (shopRows) return shopRows

  const cached = readShopCache()
  const catalogDb = getCatalogSupabase()
  if (!catalogDb) return cached

  try {
    const { data, error } = await catalogDb
      .from('catalog_retailers')
      .select('slug, country, domain')
      .eq('enabled', true)
      .order('slug')
    if (error || !Array.isArray(data)) return cached

    const rows = cleanEntries(data)
    if (rows.length === 0) return cached

    shopRows = rows
    try {
      localStorage.setItem(SHOPS_KEY, JSON.stringify(rows))
    } catch {
      // Same posture as the badge cache below: a filter's convenience must
      // never be the thing that throws.
    }
    return rows
  } catch {
    return cached
  }
}

function cleanEntries(raw: unknown[]): ShopEntry[] {
  return raw
    .map((row) => row as { slug?: unknown; country?: unknown; domain?: unknown })
    .filter((row) => typeof row.slug === 'string' && SLUG.test(row.slug))
    .map((row) => ({
      slug: row.slug as string,
      country: typeof row.country === 'string' ? row.country : null,
      // A cache written before domains were read has none: the credit then
      // names that shop without a link until the next fetch.
      domain: typeof row.domain === 'string' && DOMAIN.test(row.domain) ? row.domain : null,
    }))
}

function readShopCache(): ShopEntry[] {
  try {
    const raw = localStorage.getItem(SHOPS_KEY)
    if (!raw) return []
    const stored = JSON.parse(raw) as unknown
    return Array.isArray(stored) ? cleanEntries(stored) : []
  } catch {
    return []
  }
}

// For tests: forget what was learned this session.
//
// Not called on a list switch: the shop list comes from catalog_retailers and
// belongs to nobody -- the same handful of rows whichever list you are in --
// unlike the suggestions and the filters that resetForList does clear.
export function resetShopList(): void {
  shopRows = null
}

interface ShopRow {
  name?: unknown
  maker?: unknown
  retailers?: unknown
}

function shopsEnabled(): boolean {
  return getCatalogSupabase() !== null
}

// ─── remembering the answer ──────────────────────────────────────────────────
// The list paints from the snapshot cache with no network at all, while this
// lookup is a round trip to a SECOND database, so uncached the badges would
// arrive a beat after the rows.
//
// So the answer is cached the same way the list is. On a warm start the badges
// paint with the rows, and the fetch below still runs and replaces them, which
// is what keeps a shop that dropped a product from showing forever.
//
// Nothing here is private: it is which shops sell a product, which every signed
// in user can read anyway. It is keyed by version alone rather than by user, and
// a list's product NAMES are the only thing about it that came from them --
// the same names already sitting in the snapshot cache next to it.
//
// That comparison only holds because of clearCachedShops below: the snapshot
// cache is also DROPPED when its account signs out; without it the names
// would outlive the session on a shared device.
const CACHE_KEY = 'bagful.shop-badges.v1'
// Enough for a big list several times over. A cap at all is what stops a cache
// that is only ever added to from growing until a browser refuses to write it.
const CACHE_MAX = 500

export function loadCachedShops(storage: Storage = localStorage): ShopMap {
  const map: ShopMap = new Map()
  try {
    const raw = storage.getItem(CACHE_KEY)
    if (!raw) return map
    const stored = JSON.parse(raw) as unknown
    if (!Array.isArray(stored)) return map
    for (const entry of stored) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [key, shops] = entry as [unknown, unknown]
      if (typeof key !== 'string' || !Array.isArray(shops)) continue
      const clean = shops.filter((x): x is string => typeof x === 'string' && SLUG.test(x))
      if (clean.length > 0) map.set(key, clean)
    }
  } catch {
    // A private window, cleared site data, a quota error, or something that is
    // not JSON. Every one of them means "no cache", which is the state this
    // started in.
  }
  return map
}

export function saveCachedShops(map: ShopMap, storage: Storage = localStorage): void {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify([...map.entries()].slice(0, CACHE_MAX)))
  } catch {
    // Writing a decoration's cache must never be the thing that breaks a list.
  }
}

/**
 * Drop the cache on sign-out. Called from lib/session's list, not from here.
 *
 * The key above is deliberately device-wide and stays that way: which shops
 * sell a product belongs to nobody, and sharing one copy across accounts is
 * what keeps the badges painting in the same frame as the rows. The header
 * there argues that a list's product NAMES are the only part that came
 * from a user, and that they already sit in the snapshot cache beside this one.
 *
 * True — but that cache is keyed per account AND cleared when its account
 * leaves, and this one was neither, so the names outlived the session that
 * produced them on a shared device. Clearing is the half that was missing; the
 * shared key is the half that was right.
 */
export function clearCachedShops(storage: Storage = localStorage): void {
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // Storage disabled — nothing to clear.
  }
}

/**
 * @param market where this phone is. A list in Italy wears Italian shops only,
 *   and the catalog answers under the name a shop there uses -- the name the
 *   row carries, since it was picked from a search that sent the same market.
 *   Null sends no market, which means every shop, as search reads it.
 */
export async function fetchShopsFor(names: string[], market: Market | null = null): Promise<ShopMap> {
  const empty: ShopMap = new Map()
  if (!shopsEnabled()) return empty

  const catalogDb = getCatalogSupabase()
  if (!catalogDb) return empty

  // Deduplicated and capped before it leaves. The RPC caps at 200 too; doing it
  // here as well keeps the request small rather than relying on the far side to
  // throw the excess away.
  const wanted = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))].slice(0, 200)
  if (wanted.length === 0) return empty

  try {
    // Spread rather than null: PostgREST resolves an RPC by the keys it is sent.
    const { data, error } = await catalogDb.rpc('catalog_shops_for', {
      p_names: wanted,
      ...(market ? { p_markets: [market] } : {}),
    })
    if (error || !Array.isArray(data)) return empty

    const map: ShopMap = new Map()
    for (const row of data as ShopRow[]) {
      const name = typeof row.name === 'string' ? row.name : ''
      if (!name) continue
      const maker = typeof row.maker === 'string' ? row.maker : null
      const shops = Array.isArray(row.retailers)
        ? row.retailers.filter((s): s is string => typeof s === 'string')
        : []
      if (shops.length === 0) continue

      // Keyed both ways on purpose. The catalog answers with ITS canonical name
      // and brand, and the row on the list carries whatever the person picked --
      // often a shop's own wording, and sometimes with no maker at all because
      // they typed it themselves. Keying on the name alone as well is what makes
      // the second case resolve.
      map.set(productKey(name, maker), shops)
      if (!map.has(productKey(name, null))) map.set(productKey(name, null), shops)
    }
    saveCachedShops(map)
    return map
  } catch {
    return empty
  }
}

/**
 * Which shop each product on the list came from, for the list's badges.
 *
 * Without it, a scraped product and one somebody typed in render identically
 * on the list.
 *
 * Resolved for the WHOLE list in one call, because a row is a row in this
 * database and knows nothing about the catalog -- it cannot look itself up, and
 * twenty rows must not mean twenty round trips.
 *
 * Keyed on the set of names rather than on `items` itself, so checking something
 * off, reordering, or a realtime update to a quantity does not re-ask. Only a
 * name arriving or leaving does.
 * Seeded from the cache SYNCHRONOUSLY, so the badges paint in the same frame as
 * the rows the snapshot cache paints. The fetch below still runs and replaces
 * this, which is what stops a shop that dropped a product from showing forever.
 */
export function useShopMap(
  items: Ref<{ name: string }[]>,
  region: () => Market | null,
): Ref<ShopMap> {
  const shopMap = ref<ShopMap>(loadCachedShops())

  watch(
    () => (shopsEnabled() ? JSON.stringify([...new Set(items.value.map((i) => i.name))].sort()) : ''),
    async (key) => {
      if (!key) {
        shopMap.value = new Map()
        return
      }
      // Not guarded by a request id: the answer is a decoration, the calls are
      // rare, and a stale one resolves to the same map as the fresh one for every
      // name both of them asked about.
      //
      // Assigned only if it found something. An empty answer here means the
      // catalog was unreachable, not that nothing is sold anywhere, and replacing
      // a good cache with that would blank every badge on a flaky connection.
      const fresh = await fetchShopsFor(items.value.map((i) => i.name), region())
      if (fresh.size > 0) shopMap.value = fresh
    },
    { immediate: true },
  )

  return shopMap
}
