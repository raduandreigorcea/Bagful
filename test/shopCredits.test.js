import { describe, it, expect, vi, beforeEach } from 'vitest'

const catalog = vi.hoisted(() => ({ rows: [] }))
vi.mock('../src/supabase', () => ({
  getCatalogSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: async () => ({ data: catalog.rows, error: null }) }) }),
    }),
  }),
}))

const { fetchShopCredits, resetShopList } = await import('../src/lib/shopBadges')

beforeEach(() => resetShopList())

describe('the shops credited in About', () => {
  it('names each chain in this market once, linked to the site its scraper reads', async () => {
    catalog.rows = [
      { slug: 'lidl', country: 'RO', domain: 'lidl.ro' },
      { slug: 'mega-image', country: 'RO', domain: 'mega-image.ro' },
      { slug: 'lidl-de', country: 'DE', domain: 'lidl.de' },
      { slug: 'auchan', country: 'RO', domain: 'auchan.ro' },
    ]
    expect(await fetchShopCredits('RO')).toEqual([
      { name: 'Auchan', url: 'https://auchan.ro' },
      { name: 'Lidl', url: 'https://lidl.ro' },
      { name: 'Mega Image', url: 'https://mega-image.ro' },
    ])
  })

  it('never turns something that is not a bare hostname into a link', async () => {
    catalog.rows = [
      { slug: 'auchan', country: 'RO', domain: 'javascript:alert(1)' },
      { slug: 'lidl', country: 'RO', domain: 'evil.example/path' },
      { slug: 'penny', country: 'RO', domain: null },
    ]
    const credits = await fetchShopCredits('RO')
    expect(credits.map((c) => c.url)).toEqual([null, null, null])
  })
})
