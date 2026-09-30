import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { AppClient } from '../supabase'
import {
  buildListProductStats,
  matchListStats,
  productKey,
  rankSuggestions,
  type ListProductStat,
  type ProductSuggestion,
} from './productSearch'
import { barcodeCandidates } from './barcodeScanner'
import { getCatalogSupabase } from '../supabase'
import type { AddedProduct } from './shoppingListActions'
import { topListProducts } from './productRecents'
import { fetchShopList } from './shopBadges'
import type { Market } from './region'
import type { ShoppingItemRow } from './listRealtime'
import { track } from './analytics'

// An explicit null for a defaulted RPC argument. The generated types mark such
// an argument optional and never nullable, but the app database's RPCs are
// sent null on purpose rather than omitted: an omitted argument lets PostgREST
// match an older overload a database may still hold (006_product_catalog.sql
// drops the three-argument add_custom_product, and an edited migration never
// reaches production). Null on the wire, typed as absent.
const SQL_NULL = null as unknown as undefined

// Everything behind the add form's search box: what the catalog is asked, what
// this list's history does to the order, and what the screen offers before
// anything is typed.
//
// The catalog is the only SOURCE of suggestions; history only decides their
// order. History is not a catalog — it holds whatever anyone typed into the
// list, so a lazy "apa" entry would otherwise be offered as a product, outrank
// every real one, and entrench itself by being picked again.
//
// Extracted from HomeView, where it sat among six other concerns. It brings the
// purchase-history fold with it, because the same numbers rank the suggestions
// and answer "has this list ever shopped" for the empty list.

export interface ProductSuggestions {
  suggestions: Ref<ProductSuggestion[]>
  suggestionsLoading: Ref<boolean>
  /** Why the matches may be partial: offline, or a source errored. */
  searchNote: Ref<'offline' | 'degraded' | null>
  /** The catalog row the user picked, whose maker rides along with the item. */
  selectedProduct: Ref<ProductSuggestion | null>
  /** True while the phone's full-screen search is up, which earns more rows. */
  searchExpanded: Ref<boolean>
  /**
   * Narrow the search to one shop, or null for all of them. The catalog is a
   * fraction of what the shops actually stock, so "nothing at Lidl" usually
   * means "not scraped yet", not that the shop is out of it.
   *
   * Read here, written through setSearchShop -- never assigned directly. A
   * watcher would have to tell a tap apart from the reset that clears this on a
   * list switch, and Vue's watchers are queued rather than synchronous, so
   * the flag saying which it was is already stale by the time one runs.
   */
  searchShop: Ref<string | null>
  /**
   * Narrow to a shop, or pass null for all of them, and re-ask the current
   * question immediately -- no debounce, because a tap is one deliberate event
   * rather than a burst, and the user is already looking at an answer they have
   * just invalidated.
   */
  setSearchShop: (shop: string | null) => void
  /** The shops it may be set to. Empty hides the control. */
  shopOptions: Ref<string[]>
  canAddCustomProduct: Ref<boolean>
  /** This list's purchase habits: the ranking signal, and the empty state's answer. */
  listProductStats: Ref<Map<string, ListProductStat>>
  /** Whether the fold has run. An empty map means "none" only once it has. */
  productStatsLoaded: Ref<boolean>
  loadListProductStats: () => Promise<void>
  /**
   * Forget everything scoped to the list being left, before the next one
   * loads.
   *
   * Owned here rather than done by the caller. HomeView used to clear
   * listProductStats and productStatsLoaded itself on a switch, which meant
   * this composable's reset rule lived at a call site that could not see the
   * rest of its state — and did not: recentsExcluded, a picked product and the
   * last-added confirmation all belonged to the previous list and all
   * survived the switch. The second of those had already caused a visible bug
   * once (an empty list in a new list reading "All bought"), which is the
   * kind that comes back every time state is added here and not there.
   */
  resetForList: () => void
  /** The regulars, for the search screen before anything is typed. */
  recentProducts: Ref<ProductSuggestion[]>
  /** The same list, shorter, for the empty list's one-tap adds. */
  restartProducts: Ref<ProductSuggestion[]>
  /** Find the product a scanned barcode names, or null if the catalog has none. */
  lookupBarcode: (code: string) => Promise<ProductSuggestion | null>
  lastAdded: Ref<{ name: string; maker: string | null } | null>
  reportAdded: (name: string, maker?: string | null) => void
  /** Take the confirmation back when the add turns out not to have landed. */
  clearLastAdded: () => void
  recordProductAdd: (product: AddedProduct) => void
  clearSuggestions: () => void
}

// Long enough to mean "stopped typing" on a phone. Thumb-typing runs ~300-400ms
// per character, so a shorter pause elapses between ordinary keystrokes and
// every character would cost its own request.
const SUGGEST_DEBOUNCE_MS = 300
const SUGGEST_MIN_CHARS = 2
const SUGGEST_LIMIT = 6
// Below the bar boundary the search is a full-screen sheet, so the results get
// the whole screen instead of the dropdown's 275px cap. Twice the room is
// worth twice the matches; the pool below already dwarfs both numbers, so this
// costs nothing but stops throwing ranked matches away.
const SUGGEST_LIMIT_EXPANDED = 12
// Wide enough that a common two-character prefix does not fill the pool with
// globally-popular strangers before this list's own products get a look in.
// The trigram index does the filtering either way, so the cost is the sort and
// the payload, not the match.
const SUGGEST_POOL = 100
const RECENT_LIMIT = 8
const RESTART_LIMIT = 6

export function useProductSuggestions(options: {
  db: AppClient
  listId: Ref<string | null>
  items: Ref<ShoppingItemRow[]>
  /** What is currently typed into the add form. */
  query: Ref<string>
  isOffline: () => boolean
  /**
   * Where this person shops, detected from the device timezone, or null when
   * the timezone is one the catalog does not cover.
   *
   * A getter rather than a ref, and read fresh on every search, for the same
   * reason isOffline is a function: it is a question with a current answer
   * rather than a value to keep in step. A phone that crosses a border is
   * answering differently by the next keystroke, with no plumbing between.
   */
  region: () => Market | null
  /**
   * The language this person reads, which is the one the app is in.
   *
   * A getter for the same reason as region, and it matters more here: setLocale
   * takes effect immediately, so switching the app to Romanian must reorder the
   * next search rather than the next session.
   */
  locale: () => string
}): ProductSuggestions {
  const { db, listId, items, query, isOffline, region, locale } = options

  const suggestions = ref<ProductSuggestion[]>([])
  const suggestionsLoading = ref(false)
  // Why the matches on screen may be incomplete: 'offline' (only this
  // list's own history was searched) or 'degraded' (a source errored).
  // Null when the answer is the whole answer.
  const searchNote = ref<'offline' | 'degraded' | null>(null)
  const searchShop = ref<string | null>(null)
  const shopOptions = ref<string[]>([])
  // Set on the way out, and checked by every async path that resolves into a
  // ref. The search and the stats fetch each have a sharper guard of their own
  // (a request id, a pinned list id) because they also have to reject a
  // STALE answer, not merely a late one; this only has to know the view is gone.
  let disposed = false
  // Best-effort and unawaited: three rows from the catalog, and an empty answer
  // simply means the control never appears. Nothing on this path may delay a
  // keystroke.
  // The phone's own country only: ten Lidls are one Lidl to a person in one.
  void fetchShopList(region()).then((shops) => {
    if (disposed) return
    shopOptions.value = shops
  })
  const selectedProduct = ref<ProductSuggestion | null>(null)
  const searchExpanded = ref(false)
  const listProductStats = ref<Map<string, ListProductStat>>(new Map())
  const productStatsLoaded = ref(false)
  const lastAdded = ref<{ name: string; maker: string | null } | null>(null)

  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  let suggestRequestId = 0

  // Which project each suggestion currently on screen came from, keyed the way
  // productSearch identifies a product. recordProductAdd reads it to send the
  // popularity bump to the database holding the row; an unknown key means the
  // product came from purchase history rather than from a search, and both get
  // asked. See the note there.
  const suggestionOrigins = new Map<string, 'catalog' | 'local'>()

  const suggestLimit = computed(() =>
    searchExpanded.value ? SUGGEST_LIMIT_EXPANDED : SUGGEST_LIMIT,
  )

  // The escape hatch, offered as soon as the query is long enough to have been
  // searched for — including when nothing matched, which is when it matters most.
  const canAddCustomProduct = computed(() => query.value.trim().length >= SUGGEST_MIN_CHARS)

  // What the search screen opens on before anything is typed, and what the empty
  // list offers as one-tap adds. Groceries are mostly repeats, so the most useful
  // thing either space can hold is the shortcut past typing altogether.
  // listProductStats is already loaded for ranking, so this costs no query.
  // What was already on the list when the search screen opened, frozen there.
  //
  // The exclusion itself is right -- something already on the list is not much of
  // a shortcut -- but reading it live made the row you had just tapped stop
  // qualifying and disappear out from under your finger. That was coherent while
  // adding cleared the query and put the screen away; it is not now that the
  // query, the results and the tapped row all stay, with a tick on it, so a
  // second tap can ask for a second one.
  //
  // Frozen at open rather than never applied: the answer to "is this worth
  // offering" belongs to the moment the offer is made, and nothing the user does
  // inside that screen should rearrange the things they are choosing between.
  const recentsExcluded = ref<string[]>([])

  watch(searchExpanded, (open) => {
    if (open) {
      recentsExcluded.value = items.value.map((item) =>
        productKey(item.name, item.maker as string | null),
      )
    }
  })

  const recentProducts = computed(() =>
    topListProducts(listProductStats.value, {
      limit: RECENT_LIMIT,
      exclude: recentsExcluded.value,
    }),
  )

  // The same list, shorter, for the empty state's one-tap adds. Live rather than
  // frozen: it is drawn under an empty list, so there is nothing to exclude, and
  // it has no screen of its own to hold still -- a chip whose product lands on the
  // list has done its job and the list is right there showing it.
  const restartProducts = computed(() =>
    topListProducts(listProductStats.value, {
      limit: RESTART_LIMIT,
      exclude: items.value.map((item) => productKey(item.name, item.maker as string | null)),
    }),
  )

  // What just landed, for the search screen to confirm — while it is up, the list
  // is behind it and a tap would otherwise have no visible result. Reported at
  // the point the row is actually on the list rather than when the tap happened,
  // so a rejected add never claims to have worked. A fresh object each time, so
  // adding the same product twice reads as two adds.
  function reportAdded(name: string, maker?: string | null): void {
    lastAdded.value = { name, maker: maker ?? null }
  }

  function clearLastAdded(): void {
    lastAdded.value = null
  }

  function clearSuggestions(): void {
    suggestions.value = []
  }

  // See the note on the interface. Ordered as: what the next list has to
  // re-answer, then what the previous one had already answered.
  function resetForList(): void {
    listProductStats.value = new Map()
    // Deliberately false rather than left alone: an empty map reads as "never
    // shopped" until the refetch lands, which is what made a new list's
    // empty list flash "Nothing here yet" before turning into "All bought".
    productStatsLoaded.value = false
    // Frozen from the previous list when its search screen opened.
    recentsExcluded.value = []
    // All three describe the catalog query, the pick and the add that belonged
    // to the list being left. A stale one is not merely useless here, it is
    // about a different list.
    suggestions.value = []
    suggestionsLoading.value = false
    selectedProduct.value = null
    lastAdded.value = null
    // A narrowed search is a question about the list you were just looking at.
    // Carrying it into another list would answer the first search there
    // with a filter nobody set and no visible reason for the gaps.
    searchShop.value = null
    // A response already on the wire must not land in the new list's
    // dropdown; bumping the id is what makes fetchSuggestions discard it.
    suggestRequestId++
    if (suggestTimer) {
      clearTimeout(suggestTimer)
      suggestTimer = null
    }
  }

  async function fetchSuggestions(text: string): Promise<void> {
    searchNote.value = null
    if (isOffline()) {
      // No network is not no answer: what this list has bought before is
      // already on the device, and in a basement supermarket it is most of what
      // anyone types. The note says why the catalog is missing from it.
      suggestions.value = rankSuggestions(
        matchListStats(text, listProductStats.value, { limit: suggestLimit.value }),
        listProductStats.value,
        suggestLimit.value,
      )
      searchNote.value = 'offline'
      suggestionsLoading.value = false
      return
    }
    const requestId = ++suggestRequestId
    try {
      // Two catalogs, asked at once.
      //
      // The global reference catalog is its own Supabase project, shared live by
      // production and development; this list's contributed products and
      // anything promoted out of them stay in the app database. So a full answer
      // is the union of two searches, and they go out concurrently rather than
      // in sequence: the slower of the two is the wait, not their sum.
      //
      // Both are the same RPC by name, and neither is a filter chain, which is
      // what buys word-order independence ("borsec apa" and "apa borsec" find
      // the same thing) and matching against search_blob, so a category alias
      // reaches a product in a language it is not named in.
      //
      // allSettled, not all: a rejecting Promise.all would throw away the
      // list's own products because a third project was slow. One source
      // failing must cost only that source.
      const catalogDb = getCatalogSupabase()

      // Two signals about this person, sent to the reference catalog only.
      //
      // MARKET NOW FILTERS RATHER THAN DEMOTES, and that reversal came with the
      // catalog rebuild. The old rule existed because market came from Open Food
      // Facts country tags, which were unreliable enough that treating them as
      // fact produced empty dropdowns. The catalog is now built from retailer
      // listings, and Auchan Romania stocking something is a hard fact about
      // where you can buy it. Offering it to a phone in Germany is offering a
      // shop they cannot reach; they get nothing from the catalog and fall back
      // to this list's own product_catalog, which is the right answer.
      //
      // LANGUAGE NO LONGER RANKS ANYTHING. Every product in the catalog is
      // Romanian, because every retailer in it is, so there is no second
      // language to prefer. p_langs is still sent and still accepted, because
      // dropping an argument is the same silent break as renaming one.
      //
      // Spread rather than `p_markets: null`, because PostgREST resolves an RPC
      // by the argument names in the body. Omitting the key entirely is what
      // makes "no region" mean "no filter" rather than "match nothing".
      const markets = region()
      const langs = locale()

      // Neither is sent to the app database, which has no markets or name_lang
      // column and wants none. Its rows are this list's own contributions
      // plus the curated seed, and its search_catalog already sorts them above
      // popularity. There is nothing there that should ever be demoted for
      // being foreign — the list typed it in themselves, in whatever
      // language they typed it in.
      // THE SHOP FILTER SILENCES THE APP DATABASE, and that is the whole of why
      // it is not simply another argument. This list's own product_catalog
      // has no retailers and never will -- its rows are things somebody typed
      // in. Asking it while the filter says "Lidl" would answer with products
      // that have nothing to do with Lidl, and they would be indistinguishable
      // from real ones, because a row from there carries no shops to render.
      // A filter that quietly shows you the wrong shop's products is worse than
      // no filter.
      const shop = searchShop.value

      // Whether an answer arriving now may still touch the dropdown.
      //
      // Stale: a newer keystroke queried already, and that request owns the
      // dropdown now — including when its skeleton stops. Late: the input was
      // cleared or a product picked meanwhile, so these matches must not reopen
      // the list.
      const stale = () => requestId !== suggestRequestId
      const owns = () =>
        !stale() && !selectedProduct.value && query.value.trim().length >= SUGGEST_MIN_CHARS

      // A source that errored answers with nothing, and says so: without the
      // flag, a catalog outage looks exactly like "no shop sells this".
      let degraded = false
      const rowsOf = (res: { data: unknown; error: unknown }): ProductSuggestion[] => {
        if (res.error) {
          degraded = true
          return []
        }
        return (res.data ?? []) as ProductSuggestion[]
      }

      // The pool is capped and ordered globally, so a product this list buys
      // every week can be crowded out of it entirely by a catalog this large.
      // listProductStats is already loaded, so recovering those matches costs
      // no network — which is also why they can be on screen before either
      // database has answered.
      //
      // The history fold is silenced by the shop filter for the same reason the
      // app database is: it is drawn from what this list has bought, which
      // says nothing at all about which shops carry it.
      const historyRows = shop
        ? []
        : matchListStats(text, listProductStats.value, { limit: suggestLimit.value })
      let globalRows: ProductSuggestion[] = []
      let localRows: ProductSuggestion[] = []

      // EACH SOURCE LANDS ON ITS OWN. This used to await both, so every search
      // was as slow as the slower one, and the slower one is the catalog project:
      // a small instance that swaps, measured at 230-870ms of server time for a
      // word nobody had searched yet, on top of the network. A list's own
      // rows had no reason to sit behind that.
      //
      // `done` is false while a source is still out. Until then an empty answer
      // publishes nothing and the skeleton stays: an empty list offering "Can't
      // find it?", replaced a moment later by the catalog's matches, would be a
      // claim the search had not yet earned.
      const publish = (done: boolean): void => {
        const candidates = [...globalRows, ...localRows, ...historyRows]
        if (!done && !candidates.length) return

        // Which project each product came from, so the popularity bump goes to
        // the row the user actually saw. Rebuilt per publish: it only ever
        // describes what is on screen now, which also keeps it from growing all
        // session.
        suggestionOrigins.clear()
        for (const row of globalRows) suggestionOrigins.set(productKey(row.name, row.maker), 'catalog')
        // Local second, so a product in both is remembered as local: its row is
        // the one carrying this list's own add_count, and the app database
        // is where a promoted row keeps earning.
        for (const row of localRows) suggestionOrigins.set(productKey(row.name, row.maker), 'local')

        // Catalog rows go first: rankSuggestions dedupes first-wins, so the
        // catalog's spelling and popularity win wherever it did return the
        // product — including over a duplicate of it promoted in the app
        // database. Which means a catalog answer arriving second can replace a
        // row already on screen with the same product under its own spelling.
        suggestions.value = rankSuggestions(candidates, listProductStats.value, suggestLimit.value)
        suggestionsLoading.value = false
      }

      publish(false)

      const catalogLeg = Promise.resolve(
        catalogDb
          ? catalogDb.rpc('search_catalog', {
              p_query: text,
              p_limit: SUGGEST_POOL,
              ...(markets ? { p_markets: [markets] } : {}),
              ...(langs ? { p_langs: [langs] } : {}),
              ...(shop ? { p_retailers: [shop] } : {}),
            })
          : { data: [], error: null },
      ).then((res) => {
        if (!owns()) return
        globalRows = rowsOf(res)
        publish(false)
      })
      const localLeg = Promise.resolve(
        shop
          ? { data: [], error: null }
          : db.rpc('search_catalog', {
              p_query: text,
              p_list_id: listId.value || SQL_NULL,
              p_limit: SUGGEST_POOL,
            }),
      ).then((res) => {
        if (!owns()) return
        localRows = rowsOf(res)
        publish(false)
      })

      // allSettled, so one source failing costs only that source (see above).
      const settled = await Promise.allSettled([catalogLeg, localLeg])
      if (!owns()) return
      if (degraded || settled.some((r) => r.status === 'rejected')) searchNote.value = 'degraded'
      publish(true)
      // Once per settled search, after the debounce: a count, never the text.
      track('search_performed', { results: suggestions.value.length })

      // THERE IS NO COLD PATH ANY MORE. This used to fall through to a
      // `discover` edge function that queried Open Food Facts live, on the
      // keystroke path, whenever the local rows did not look like an answer.
      //
      // The catalog it fed is gone and so is the reason for it: the catalog is
      // now what real shops actually list, so an empty result means "no shop we
      // read sells this", which is TRUE and useful. The old empty result meant
      // "we have not heard of it yet", which is why it went looking.
    } catch {
      // Suggestions are a convenience; a failed lookup changes nothing.
    } finally {
      // Only the newest request may stop the skeleton. A superseded one
      // returning early must leave it spinning for the request that replaced it,
      // or the dropdown would flash "Can't find it?" mid-search.
      if (requestId === suggestRequestId) suggestionsLoading.value = false
    }
  }

  // ─── scanning ──────────────────────────────────────────────────────────────
  // A barcode is an exact key, so this is the one lookup that does not go near
  // search_text, ranking, or the debounce: there is nothing to rank and nothing
  // to guess at. Scoped the same way fetchSuggestions is — the global catalog
  // plus this list's own contributions — which is what lets a product this
  // list named after a miss be found by the next scan.
  //
  // Ordered so a global row wins over a scoped one carrying the same code. The
  // global is the canonical spelling; the scoped row is what this list
  // called it before the catalog caught up.
  //
  // "Exact key" is doing less work than it looks. buildLoadPlan merges products
  // whose names normalize alike, so one row can answer to several codes, and
  // before alt_barcodes existed the merged-away codes answered to nothing at
  // all — 4,468 products that scanned to an empty result. lookup_barcode() is
  // what makes the key exact again.
  async function lookupBarcode(code: string): Promise<ProductSuggestion | null> {
    const candidates = barcodeCandidates(code)
    if (!candidates.length || isOffline()) return null
    try {
      const catalogDb = getCatalogSupabase()
      // Both projects, at once, for the same reason the search asks both: the
      // code may name an imported product or one this list named after a
      // scan that missed. allSettled so an unreachable catalog project still
      // lets the list's own row answer.
      const [globalRes, localRes] = await Promise.allSettled([
        // An RPC on the reference catalog, where the app database below is
        // still a plain select, and the asymmetry is real rather than untidy.
        // Only the catalog has alt_barcodes — the codes of products that
        // collapsed onto one row because their names normalize alike. A scan
        // has to match either column, and a printed barcode has to beat an
        // absorbed one, which is an ordering across two columns that belongs
        // beside them rather than in a PostgREST filter chain here.
        // The market, for the same reason search sends it: a scan in Italy must
        // not find a product only a Romanian shop sells, and should read the
        // name an Italian shop uses. Spread rather than null, so "no region"
        // stays "no filter" (PostgREST resolves an RPC by the keys it is sent).
        catalogDb
          ? (() => {
              const market = region()
              return catalogDb.rpc('lookup_barcode', {
                p_codes: candidates,
                ...(market ? { p_markets: [market] } : {}),
              })
            })()
          : Promise.resolve({ data: [], error: null }),
        (listId.value
          ? db
              .from('product_catalog')
              .select('name, maker, popularity')
              .in('barcode', candidates)
              .or(`list_id.is.null,list_id.eq.${listId.value}`)
          : db
              .from('product_catalog')
              .select('name, maker, popularity')
              .in('barcode', candidates)
              .is('list_id', null)
        )
          .order('list_id', { ascending: true, nullsFirst: true })
          .order('popularity', { ascending: false })
          .limit(1),
      ])

      const firstOf = (
        settled: PromiseSettledResult<{ data: unknown; error: unknown }>,
      ): ProductSuggestion | null =>
        settled.status === 'fulfilled' && !settled.value.error
          ? (((settled.value.data ?? []) as ProductSuggestion[])[0] ?? null)
          : null

      // The imported row wins over a list's own, which is the same rule the
      // single-database version applied when it ordered globals first: the
      // catalog holds the canonical spelling, the scoped row holds what this
      // list called it before the catalog caught up.
      const global = firstOf(globalRes)
      const local = firstOf(localRes)
      const found = global ?? local
      if (found) {
        suggestionOrigins.set(productKey(found.name, found.maker), global ? 'catalog' : 'local')
        return found
      }

      // Neither database has ever seen this code, and there is nowhere else to
      // ask. A scan used to fall through to the `discover` edge function, which
      // looked the barcode up in Open Food Facts; that catalog is gone, and a
      // barcode no configured retailer lists is a barcode this catalog cannot
      // resolve.
      //
      // The user goes to the naming path, their answer lands in the app
      // database with the code attached, and the NEXT scan of it is answered
      // from there. That loop still works and is now the only one.
      return null
    } catch {
      // Treated as "the catalog does not have it", which puts the user on the
      // naming path rather than on an error they can do nothing about.
      return null
    }
  }

  // Ask the current question, however it came to be asked.
  //
  // The two callers below differ in ONE thing -- whether the dispatch waits out
  // the typing debounce -- and used to spell the other four steps out twice. The
  // steps are not obvious enough to duplicate safely: clearing the matches
  // before raising the skeleton is what stops the dropdown offering "Can't find
  // it?" mid-search, and the pending timer has to be cancelled whichever way the
  // question changed. A guard added to one copy and not the other is the drift
  // this prevents.
  function startSearch(text: string, options: { debounce: boolean }): void {
    if (suggestTimer) {
      clearTimeout(suggestTimer)
      suggestTimer = null
    }
    if (text.length < SUGGEST_MIN_CHARS || selectedProduct.value) {
      suggestions.value = []
      suggestionsLoading.value = false
      return
    }
    // The last question's matches are not this question's answers, so drop them
    // and show the skeleton from the first keystroke -- across the debounce as
    // well as the request, since both are time the user spends waiting.
    suggestions.value = []
    suggestionsLoading.value = true
    if (!options.debounce) {
      void fetchSuggestions(text)
      return
    }
    suggestTimer = setTimeout(() => void fetchSuggestions(text), SUGGEST_DEBOUNCE_MS)
  }

  watch(query, (value) => {
    const text = value.trim()
    // Editing away from a picked suggestion drops its maker; retyping the exact
    // product name without re-picking keeps it (same product, same subtitle).
    if (selectedProduct.value && text !== selectedProduct.value.name) {
      selectedProduct.value = null
    }
    // The note describes the answer on screen, and a new question has none yet.
    searchNote.value = null
    startSearch(text, { debounce: true })
  })

  // Changing the shop re-asks the SAME question, so it skips the debounce that
  // exists for typing.
  //
  // A function rather than a watcher on searchShop, which is what this was
  // first. resetForList also clears the filter, and that is not somebody
  // asking the question again -- there is a new list loading and nothing to
  // answer yet -- so a watcher would have needed a flag to tell the two apart.
  // Vue queues watchers rather than running them synchronously, so the flag was
  // already false by the time the callback read it: the guard looked right and
  // did nothing. Here the two callers simply do different things.
  function setSearchShop(shop: string | null): void {
    if (searchShop.value === shop) return
    searchShop.value = shop
    if (shop) track('shop_filter_used', { shop })
    startSearch(query.value.trim(), { debounce: false })
  }

  // Fold this list's recent purchases into the ranking signal. Best-effort: on
  // failure suggestions just fall back to the global catalog order. Retention
  // (005_purchase_history.sql) already caps history at 60 checkouts / 30 days, so this is a
  // small, naturally-recent window and can be fetched whole.
  async function loadListProductStats(): Promise<void> {
    // Pinned before the await: this fetch can span a list switch, and a
    // response is only an answer for the list it was asked about. The
    // suggestions fetch guards the same race with suggestRequestId; here the
    // id itself is the request's identity.
    const requestedListId = listId.value
    if (!requestedListId || isOffline()) {
      // Nothing is coming, so stop the empty list waiting on an answer it will
      // never get.
      productStatsLoaded.value = true
      return
    }
    try {
      const { data, error } = await db
        .from('purchase_history')
        .select('name, maker, purchased_at')
        .eq('list_id', requestedListId)
      // Stale: the list changed while this was in flight. Its rows would
      // become the new list's ranking signal — and its `finally` below
      // would claim the new list's still-pending answer has arrived,
      // which is what turns a fresh empty list into a false "All bought".
      if (listId.value !== requestedListId) return
      if (error) return
      listProductStats.value = buildListProductStats(data ?? [])
    } catch {
      // No stats just means suggestions rank globally, which is the old behaviour.
    } finally {
      // Every path resolves the question, including the failures above: a list
      // whose history we could not read is not a list that never shopped, but
      // it is one we cannot hold a blank screen for. Only for the list that
      // asked, though — a stale response answers nothing.
      if (listId.value === requestedListId) productStatsLoaded.value = true
    }
  }

  // A catalog product just gets its popularity bumped. A custom one is
  // contributed to the catalog scoped to this list — suggested back to them
  // straight away, and promoted to a global suggestion only once enough other
  // lists have added the same product (006_product_catalog.sql), so one list's
  // spelling cannot leak into everyone else's dropdown.
  //
  // A custom product named after a scan carries its barcode into that
  // contribution, which is what closes the scanning loop: the code missed once,
  // was named once, and every later scan of the same package — by anyone in the
  // list — finds it. The server validates the format and ignores anything
  // that is not a barcode, so nothing here has to.
  //
  // Best-effort either way: fire-and-forget, never blocks or errors the add, and
  // skipped offline (neither is part of the offline queue). Both RPCs are
  // throttled server-side as well (002_security_audit.sql).
  function recordProductAdd(product: AddedProduct): void {
    if (!product || isOffline()) return

    const ignore = (promise: PromiseLike<unknown>): void => {
      void promise.then(
        () => {},
        () => {},
      )
    }

    // A contribution is user data and always belongs to the app database. The
    // catalog project has no list column to scope it by, and the promotion
    // rule that eventually turns three lists' contributions into one global
    // row runs there too.
    if (product.custom) {
      if (!listId.value) return
      ignore(
        db.rpc('add_custom_product', {
          p_list_id: listId.value,
          p_name: product.name,
          p_maker: product.maker ?? SQL_NULL,
          p_barcode: product.barcode ?? SQL_NULL,
        }),
      )
      return
    }

    // A bump has to reach the database holding the row, and the two projects
    // each carry a copy of this RPC with a different signature — the app's takes
    // a list to scope by, the catalog's has nothing to scope.
    //
    // An unknown origin means the product came from purchase history rather than
    // from either search, and history does not record where a product was found.
    // Both are asked in that case: each is a no-op where the row is not, they
    // are fire-and-forget already, and the rate limits are counted per project
    // so one add can never spend two of anything. Guessing instead would quietly
    // stop counting exactly the products this list buys most.
    const origin = suggestionOrigins.get(productKey(product.name, product.maker))
    const catalogDb = getCatalogSupabase()

    if (origin !== 'local' && catalogDb) {
      ignore(
        catalogDb.rpc('bump_product_popularity', {
          p_name: product.name,
          p_maker: product.maker ?? undefined,
        }),
      )
    }
    if (origin !== 'catalog') {
      ignore(
        db.rpc('bump_product_popularity', {
          p_name: product.name,
          p_maker: product.maker ?? SQL_NULL,
          p_list_id: listId.value ?? SQL_NULL,
        }),
      )
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    if (suggestTimer) clearTimeout(suggestTimer)
    // And retire the request id, which closes every query already past the
    // debounce. Clearing suggestTimer only stops the ones that have not
    // started; a search in flight still resolves and still writes into a ref
    // nobody is rendering. Every guard in this file is
    // `requestId !== suggestRequestId`, so moving the id past all of them
    // closes them at once — the same mechanism resetForList uses for a
    // list switch.
    suggestRequestId++
  })

  return {
    suggestions,
    suggestionsLoading,
    searchNote,
    selectedProduct,
    searchExpanded,
    canAddCustomProduct,
    listProductStats,
    productStatsLoaded,
    loadListProductStats,
    searchShop,
    setSearchShop,
    shopOptions,
    resetForList,
    recentProducts,
    restartProducts,
    lookupBarcode,
    lastAdded,
    reportAdded,
    clearLastAdded,
    recordProductAdd,
    clearSuggestions,
  }
}
