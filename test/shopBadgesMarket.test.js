// The shop badges on a list are that country's shops.
//
// catalog_shops_for used to take names alone, so a list in Italy would have worn
// Romanian badges for a product both countries sell, and badges for a product no
// Italian shop sells at all. The market goes with the names now, and like every
// other catalog call it is OMITTED rather than sent as null when the phone is
// somewhere the catalog does not cover: PostgREST resolves an RPC by the keys in
// the body, and no key is what means "every shop".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ calls: [], rows: [] }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  IS_NIGHTLY: true,
}))

vi.mock('../src/supabase', () => ({
  getCatalogSupabase: () => ({
    rpc: async (fn, params) => {
      state.calls.push({ fn, params })
      return { data: state.rows, error: null }
    },
  }),
}))

const { fetchShopsFor, shopBrand, shopLabel } = await import('../src/lib/shopBadges')
const { productKey } = await import('../src/lib/productSearch')

beforeEach(() => {
  // The answer is cached in localStorage on the way out, and node has none: the
  // ReferenceError lands in fetchShopsFor's catch and every call returns empty.
  const memory = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  })
  state.calls = []
  state.rows = [{ name: 'Acqua naturale Dorna 2L', maker: 'Dorna', retailers: ['esselunga'] }]
})

describe('one chain in several countries', () => {
  // Lidl Germany is `lidl-de` in the catalog and Lidl to a person: one name, one
  // logo. Only a market-code suffix is a country, so Mega Image stays itself.
  it('reads the chain out of a country slug', () => {
    expect(shopBrand('lidl-de')).toBe('lidl')
    expect(shopBrand('lidl-gb')).toBe('lidl')
    expect(shopBrand('lidl')).toBe('lidl')
    expect(shopBrand('mega-image')).toBe('mega-image')
  })

  it('names every country of a chain by the chain', () => {
    expect(shopLabel('lidl-it')).toBe('Lidl')
    expect(shopLabel('aldi-gb')).toBe('Aldi')
    expect(shopLabel('carrefour-it')).toBe('Carrefour')
    expect(shopLabel('mpreis')).toBe('MPreis')
    expect(shopLabel('kaufland')).toBe('Kaufland')
    expect(shopLabel('delhaize')).toBe('Delhaize')
    expect(shopLabel('mega-image')).toBe('Mega Image')
  })

  it('keeps a chain that trades under its own name in one country as itself', () => {
    // Aldi is Hofer in Austria, and a person there knows it as Hofer.
    expect(shopBrand('hofer')).toBe('hofer')
    expect(shopLabel('hofer')).toBe('Hofer')
  })
})

describe('fetchShopsFor', () => {
  it('sends the market with the names', async () => {
    await fetchShopsFor(['Acqua naturale Dorna 2L'], 'IT')
    expect(state.calls[0]).toEqual({
      fn: 'catalog_shops_for',
      params: { p_names: ['Acqua naturale Dorna 2L'], p_markets: ['IT'] },
    })
  })

  it('omits the market when there is none', async () => {
    await fetchShopsFor(['Acqua naturale Dorna 2L'], null)
    expect('p_markets' in state.calls[0].params).toBe(false)
  })

  it('keys the answer by the name the catalog gave for that market', async () => {
    const map = await fetchShopsFor(['Acqua naturale Dorna 2L'], 'IT')
    expect(map.get(productKey('Acqua naturale Dorna 2L', 'Dorna'))).toEqual(['esselunga'])
  })
})
