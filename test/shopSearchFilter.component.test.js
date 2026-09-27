// @vitest-environment happy-dom
//
// Narrowing the search to one shop -- "I am in Lidl, what of this can I buy
// here".
//
// The load-bearing half is not the argument sent to the catalog. It is the two
// sources that must go QUIET while the filter is on: this list's own
// product_catalog and its purchase history. Neither has retailers and neither
// ever will -- they hold what people typed in -- so answering with them under a
// "Lidl" filter would offer products that have nothing to do with Lidl, and a
// row from either carries no shops to render, so nothing on screen would say so.
// A filter that quietly shows you the wrong shop's products is worse than no
// filter, and it fails silently in exactly the direction nobody checks.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createFakeDb } from './support/fakeSupabase.js'

const channel = vi.hoisted(() => ({ nightly: true }))
const catalog = vi.hoisted(() => ({ db: null }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  get IS_NIGHTLY() {
    return channel.nightly
  },
}))

vi.mock('../src/supabase', () => ({
  getCatalogSupabase: () => catalog.db,
}))

const { useProductSuggestions } = await import('../src/lib/productSuggestions')
const { resetShopList } = await import('../src/lib/shopBadges')

let db
let catalogCalls

const CATALOG_ROW = {
  name: 'Lapte Zuzu 1L',
  maker: 'Zuzu',
  popularity: 10,
  retailers: ['lidl'],
}
// A row from the app database's own search_catalog: this list's own
// contribution, and the reason the filter has to silence that leg.
const LOCAL_ROW = { name: 'Lapte de casa', maker: null, popularity: 3 }

beforeEach(() => {
  channel.nightly = true
  // The shop list is memoised for the life of the module -- three rows, once a
  // session -- so without this the second case in this file gets the first
  // one's answer.
  resetShopList()
  localStorage.clear()
  catalogCalls = []
  db = createFakeDb()
  db.handlers['rpc.search_catalog'] = () => ({ data: [LOCAL_ROW], error: null })
  db.handlers['purchase_history.select'] = () => ({ data: [], error: null })

  catalog.db = {
    rpc: (fn, args) => {
      catalogCalls.push({ fn, args })
      return Promise.resolve({ data: fn === 'search_catalog' ? [CATALOG_ROW] : [], error: null })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          // A shop in another country, which a phone in Romania must not be
          // offered: one catalog serves every market.
          order: () =>
            Promise.resolve({
              data: [
                { slug: 'auchan', country: 'RO' },
                { slug: 'lidl', country: 'RO' },
                { slug: 'lidl-it', country: 'IT' },
              ],
              error: null,
            }),
        }),
      }),
    }),
  }
})

function mountSuggestions() {
  const query = ref('')
  let api
  const Harness = defineComponent({
    setup() {
      api = useProductSuggestions({
        db,
        listId: ref('hh-a'),
        items: ref([]),
        query,
        isOffline: () => false,
        region: () => 'RO',
        locale: () => 'ro',
      })
      return () => null
    },
  })
  const wrapper = mount(Harness)
  return { api, query, wrapper }
}

/** Type, wait out the 300ms debounce, and let both legs settle. */
async function search(query, text) {
  vi.useFakeTimers()
  query.value = text
  await flushPromises()
  await vi.advanceTimersByTimeAsync(400)
  vi.useRealTimers()
  await flushPromises()
}

const searchArgs = () => catalogCalls.filter((c) => c.fn === 'search_catalog').map((c) => c.args)

describe('the shops the filter can offer', () => {
  it('reads them from the catalog rather than holding a list, for this country only', async () => {
    // A fourth shop starts being offered the day it has a row, with no release --
    // and Lidl Italy, in the same table, is not offered to a phone in Romania.
    const { api } = mountSuggestions()
    await flushPromises()
    expect(api.shopOptions.value).toEqual(['auchan', 'lidl'])
  })

  it('offers none when there is no catalog at all', async () => {
    catalog.db = null
    const { api } = mountSuggestions()
    await flushPromises()
    expect(api.shopOptions.value).toEqual([])
  })
})

describe('searching with no shop chosen', () => {
  it('asks both databases and sends no shop', async () => {
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')

    expect(searchArgs()[0]).not.toHaveProperty('p_retailers')
    // Omitting the key entirely is what makes "no shop" mean "no filter":
    // PostgREST resolves an RPC by the argument names in the body, so sending
    // p_retailers: null would still be sending it.
    expect(db.calls.filter((c) => c.table === 'rpc' && c.op === 'search_catalog')).toHaveLength(1)
    expect(api.suggestions.value.map((s) => s.name)).toContain('Lapte de casa')
  })
})

describe('searching with a shop chosen', () => {
  it('sends the shop to the catalog', async () => {
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    api.setSearchShop('lidl')
    await flushPromises()

    expect(searchArgs().at(-1).p_retailers).toEqual(['lidl'])
  })

  it('STOPS ASKING THE APP DATABASE', async () => {
    // The whole point. Its rows have no shops and never will.
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    const before = db.calls.filter((c) => c.table === 'rpc' && c.op === 'search_catalog').length

    api.setSearchShop('lidl')
    await flushPromises()

    expect(db.calls.filter((c) => c.table === 'rpc' && c.op === 'search_catalog')).toHaveLength(
      before,
    )
    expect(api.suggestions.value.map((s) => s.name)).not.toContain('Lapte de casa')
    expect(api.suggestions.value.map((s) => s.name)).toContain('Lapte Zuzu 1L')
  })

  it('re-asks immediately rather than waiting for the debounce', async () => {
    // A tap is one deliberate event, not a burst of them, and the answer on
    // screen has just been invalidated. Nothing here advances a timer.
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    const before = searchArgs().length

    api.setSearchShop('lidl')
    await flushPromises()

    expect(searchArgs().length).toBe(before + 1)
  })

  it('does nothing when the shop has not actually changed', async () => {
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    api.setSearchShop('lidl')
    await flushPromises()
    const before = searchArgs().length

    api.setSearchShop('lidl')
    await flushPromises()
    expect(searchArgs().length).toBe(before)
  })

  it('goes back to both databases when the shop is cleared', async () => {
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    api.setSearchShop('lidl')
    await flushPromises()

    api.setSearchShop(null)
    await flushPromises()

    expect(searchArgs().at(-1)).not.toHaveProperty('p_retailers')
    expect(api.suggestions.value.map((s) => s.name)).toContain('Lapte de casa')
  })

  it('searches nothing while the box is too short to be a question', async () => {
    const { api } = mountSuggestions()
    await flushPromises()
    api.setSearchShop('lidl')
    await flushPromises()
    expect(searchArgs()).toHaveLength(0)
    expect(api.suggestions.value).toEqual([])
  })
})

describe('a list switch', () => {
  it('clears the shop, and does not fire a search into the new list', async () => {
    // A narrowed search is a question about the list just left. Carrying it
    // over would answer the first search in the new list with a filter
    // nobody set and no visible reason for the gaps.
    //
    // The "does not fire" half is why this is a function rather than a watcher:
    // Vue queues watchers, so a flag saying "this clear was the reset" is
    // already stale by the time the callback reads it.
    const { api, query } = mountSuggestions()
    await search(query, 'lapte')
    api.setSearchShop('lidl')
    await flushPromises()
    const before = searchArgs().length

    api.resetForList()
    await flushPromises()

    expect(api.searchShop.value).toBeNull()
    expect(searchArgs().length).toBe(before)
  })
})
