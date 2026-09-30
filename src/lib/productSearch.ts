// Product suggestion search and ranking.
//
// normalizeSearchText is ONE OF FOUR COPIES of the fold, and the other three
// live where this file cannot call them. All of them lowercase, strip
// diacritics and collapse whitespace, so "apă" typed with or without accents
// matches the stored "apa plata 2l dorna".
//
//   • catalog_normalize() in the catalog's 002_catalog.sql — the authority for
//     the reference catalog, and the only one whose answer is ever stored.
//   • product_search_text() in 006_product_catalog.sql — the same rule over the
//     app database's own rows.
//   • fold() in catalog/src/core/normalize.ts, used by the scrapers.
//   • this one, for the client-side dedupe key when both projects return the
//     same product.
//
// THIS COPY IS THE ODD ONE OUT, knowingly. Postgres folds with unaccent, which
// is a DICTIONARY; NFD plus a combining-mark strip is an ALGORITHM, and an
// algorithm can only remove marks. So this returns ß, œ, æ, đ, ½, ® and ×
// untouched where the database answers ss, oe, ae, d, 1/2, (r) and *. The
// catalog's TypeScript copy carries a generated expansion table to close that
// gap; this one does not, because the cost here is at most a duplicated line in
// a dropdown and the benefit is that this function stays four lines long.
//
// A drift costs a duplicate row in a dropdown rather than data: the database is
// the only copy that writes.
//
// Ranking (see rankSuggestions) puts what THIS list actually buys first and
// only falls back to the global catalog ordering for products they have never
// bought. The global signal is a cold-start default; a list's own history is
// the real answer to "what did they mean by 'apa'".
//
// The split of responsibility matters: the catalog is the only SOURCE of
// suggestions, and history only ORDERS them. Purchase history records whatever
// was typed into the list, so treating it as a source would offer a bare "apa"
// as if it were a product — and, being a purchase, it would outrank every real
// one and entrench itself by being picked again. Such an entry simply keys to no
// catalog product and drops out.

export interface ProductSuggestion {
  name: string
  maker: string | null
  // Global cross-list score from product_catalog (006_product_catalog.sql).
  popularity?: number

  // ─── what the catalog project's search_catalog adds ────────────────────────
  //
  // Present only on rows from the CATALOG project. The app database's own
  // search_catalog returns three columns, and rows recovered from list
  // history have none of this, so every one of these is optional and nothing
  // may depend on it being there.
  //
  // None of them changes behaviour. They are here so a ranking that is
  // otherwise very hard to argue with can be explained -- a wrong result looks
  // exactly like a catalog that does not stock something.
  quantity?: number | null
  quantity_unit?: string | null
  retailers?: string[] | null
  min_price?: number | null
  currency?: string | null
  available?: boolean | null
  match_type?: string | null
  relevance_score?: number | null
}

// One product a list has bought, folded across all its purchase_history rows.
export interface ListProductStat {
  name: string
  maker: string | null
  // Purchase occasions, not units: buying "apa x6" once says less about habit
  // than buying it on six separate trips.
  count: number
  lastPurchasedAt: number
}

export interface PurchaseHistoryRow {
  name?: string | null
  maker?: string | null
  purchased_at?: string | null
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// Identity of a product across the catalog and a list's history. Name + maker,
// normalized the same way search_text is, so "Apă Plată"/"Apa Plata" and a null
// vs empty maker collapse together — matching how the DB's merge key and
// bump_product_popularity() pair a product with itself.
//
// The parts join on NUL, which normalizeSearchText can never emit, so
// ("Apa Plata", "Dorna") and ("Apa", "Plata Dorna") stay distinct products.
export function productKey(name: string | null | undefined, maker: string | null | undefined): string {
  return `${normalizeSearchText(String(name ?? ''))}\u0000${normalizeSearchText(String(maker ?? ''))}`
}

// Fold a list's purchase_history rows into per-product stats.
//
// purchase_history is pruned to 60 checkouts / 30 days (005_purchase_history.sql), so this
// is inherently a rolling window of recent behaviour: no decay maths needed, the
// retention policy already forgets for us.
export function buildListProductStats(rows: PurchaseHistoryRow[]): Map<string, ListProductStat> {
  const stats = new Map<string, ListProductStat>()

  for (const row of rows || []) {
    const name = String(row?.name ?? '').trim()
    if (!name) continue

    const maker = row?.maker ? String(row.maker).trim() || null : null
    const purchasedAt = new Date(String(row?.purchased_at ?? '')).getTime()
    const key = productKey(name, maker)

    const existing = stats.get(key)
    if (existing) {
      existing.count += 1
      if (Number.isFinite(purchasedAt) && purchasedAt > existing.lastPurchasedAt) {
        existing.lastPurchasedAt = purchasedAt
      }
      continue
    }

    stats.set(key, {
      name,
      maker,
      count: 1,
      lastPurchasedAt: Number.isFinite(purchasedAt) ? purchasedAt : 0,
    })
  }

  return stats
}

// Catalog matches this list has bought, recovered without a second query.
//
// The catalog pool the caller fetches is capped and ordered by GLOBAL
// popularity, which was harmless while the catalog was a few hundred curated
// rows: everything that matched fit in the pool, and rankSuggestions could sort
// it. Once the catalog is imported at scale, a two-character prefix matches
// thousands of products, and a list's own weekly staple can be crowded out of
// the pool by globally-popular strangers before ranking ever sees it.
// rankSuggestions can only reorder what it is handed.
//
// This is the other half of the pool: the list's stats are already in memory
// and already keyed the same way, so matching them here costs no network.
//
// It does make purchase history a SOURCE of suggestions, which the note at the
// top of this file warns against. Two things contain that:
//
//   1. rankSuggestions dedupes by productKey, first candidate wins, and the
//      caller appends these AFTER the catalog rows. So whenever the catalog did
//      return the product, the catalog's row -- canonical spelling, real
//      popularity -- wins and the history copy is discarded. Only the rows the
//      pool starved out survive, which is exactly the gap being filled.
//   2. requireSpecific is the guard the warning asks for. A maker is only ever
//      set by picking a catalog suggestion or by filling in the custom-product
//      modal, so it is a strong "this is a real product" signal. A hand-typed
//      bare "apa" has no maker and one word and can never be offered back; an
//      "Apa Plata 2L" / "Dorna" can.
export function matchListStats(
  query: string,
  listStats: Map<string, ListProductStat>,
  options: { limit: number; requireSpecific?: boolean },
): ProductSuggestion[] {
  const needle = normalizeSearchText(String(query ?? ''))
  if (needle.length < 2) return []

  const requireSpecific = options?.requireSpecific !== false
  const limit = Math.max(0, Number(options?.limit) || 0)
  if (limit === 0) return []

  const matches: ListProductStat[] = []
  for (const stat of listStats?.values() ?? []) {
    if (requireSpecific && !stat.maker && stat.name.trim().split(/\s+/).length < 2) continue
    // The same haystack product_search_text() builds, so "contains" means the
    // same thing here as it does in the server's ilike.
    const haystack = normalizeSearchText(`${stat.name} ${stat.maker ?? ''}`)
    if (haystack.includes(needle)) matches.push(stat)
  }

  return matches
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      if (a.lastPurchasedAt !== b.lastPurchasedAt) return b.lastPurchasedAt - a.lastPurchasedAt
      // Pinned to 'en', not the device or the app language: this is a
      // tie-breaker over catalog data, and a locale-dependent collation
      // would order the same list differently on two phones for no gain.
      return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    })
    .slice(0, limit)
    // popularity 0 rather than undefined so these take exactly the same path
    // through rankSuggestions' Number(x) || 0 comparison as a catalog row.
    .map((stat) => ({ name: stat.name, maker: stat.maker, popularity: 0 }))
}

// Order catalog matches, dropping any duplicate product:
//   1. products this list buys — most often, then most recently
//   2. global popularity, for everything they have never bought
//   3. name, so the order is stable
//
// A history entry only participates by matching a candidate's key, so anything
// typed by hand that is not a catalog product (a bare "apa", a typo) contributes
// nothing and can never be suggested. The first candidate for a key wins.
export function rankSuggestions(
  candidates: ProductSuggestion[],
  listStats: Map<string, ListProductStat>,
  limit: number,
): ProductSuggestion[] {
  // Decorate before sorting, rather than resolving each row inside the
  // comparator.
  //
  // This is the search box's keystroke path, and the pool it is handed is large:
  // SUGGEST_POOL is 100 from each of two projects, plus whatever the list's
  // own history matched. The comparator ran productKey TWICE per comparison, and
  // productKey is an NFD normalize, two regex passes, a lowercase and a trim,
  // for the name and again for the maker — so a sort of a few hundred rows spent
  // thousands of Unicode normalizations, on a phone, between one keypress and
  // the next. The dedupe loop directly above had already computed the identical
  // key and thrown it away.
  //
  // Resolving the stat here rather than the key alone, because the stat is all
  // the comparator ever wanted the key for. Same output, O(n) normalizations
  // instead of O(n log n).
  interface Ranked {
    candidate: ProductSuggestion
    stat: ListProductStat | undefined
  }

  const unique = new Map<string, Ranked>()
  for (const candidate of candidates || []) {
    const name = String(candidate?.name ?? '').trim()
    if (!name) continue
    const key = productKey(name, candidate.maker)
    // The key normalizes its inputs, so trimming the name above changes no key.
    if (!unique.has(key)) unique.set(key, { candidate, stat: listStats.get(key) })
  }

  return [...unique.values()]
    .sort((a, b) => {
      const sa = a.stat
      const sb = b.stat

      // Bought before beats never bought, whatever the world thinks of it.
      if (Boolean(sa) !== Boolean(sb)) return sa ? -1 : 1
      if (sa && sb) {
        if (sa.count !== sb.count) return sb.count - sa.count
        if (sa.lastPurchasedAt !== sb.lastPurchasedAt) return sb.lastPurchasedAt - sa.lastPurchasedAt
      }

      const pa = Number(a.candidate.popularity) || 0
      const pb = Number(b.candidate.popularity) || 0
      if (pa !== pb) return pb - pa

      // Pinned to 'en', not the device or the app language: this is a
      // tie-breaker over catalog data, and a locale-dependent collation
      // would order the same list differently on two phones for no gain.
      // The raw name, as before — not the trimmed one used for the key.
      return a.candidate.name.localeCompare(b.candidate.name, 'en', { sensitivity: 'base' })
    })
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

// "6 ouă", "6x ouă", "ouă x6": a count typed in with the name, split off so the
// row says Ouă ×6 rather than a product called "6 ouă".
//
// Deliberately narrow. A leading number is how people write a count; a trailing
// one usually is not ("Cola 2", "Vitamina B12", "Pampers 4" is a nappy size),
// so a trailing count needs its x. Anything that does not match is the name as
// typed, quantity 1 -- a missed count costs a tap on the row's stepper, while a
// wrong one would silently rename a product.
const LEADING_QTY = /^(\d{1,3})\s*[x×]?\s+(\S.*)$/iu
const TRAILING_QTY = /^(.*\S)\s+[x×]\s?(\d{1,3})$/iu

export function parseQuantity(text: string, max = 999): { name: string; quantity: number } {
  const trimmed = text.trim()
  const lead = LEADING_QTY.exec(trimmed)
  const trail = lead ? null : TRAILING_QTY.exec(trimmed)
  const count = lead ? Number(lead[1]) : trail ? Number(trail[2]) : NaN
  const name = lead ? lead[2]! : trail ? trail[1]! : trimmed
  if (!Number.isInteger(count) || count < 1 || count > max) return { name: trimmed, quantity: 1 }
  return { name: name.trim(), quantity: count }
}
