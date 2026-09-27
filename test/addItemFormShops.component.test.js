// @vitest-environment happy-dom
//
// Which shop a suggestion came from.
//
// "Did this come from a real shop or from something this list typed in?" is
// the one question you cannot answer by looking at the row.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AddItemForm from '../src/components/AddItemForm.vue'

const channel = vi.hoisted(() => ({ nightly: false }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  // A getter, not a value: the component reads the binding on every render, so
  // one mocked module serves both cases.
  get IS_NIGHTLY() {
    return channel.nightly
  },
}))

// Two shops, one shop, and a row from the app database's own search_catalog --
// which returns no `retailers` at all, because those products came from a
// list rather than from a scrape.
const SUGGESTIONS = [
  { name: 'Apa plata Dorna 2L', maker: 'Dorna', retailers: ['auchan', 'carrefour'] },
  { name: 'Ciocolata', maker: 'Ritter SPORT', retailers: ['lidl'] },
  { name: 'Ceva scris de mana', maker: null },
]

async function mountForm(nightly) {
  channel.nightly = nightly
  const wrapper = mount(AddItemForm, {
    props: { name: 'apa', suggestions: SUGGESTIONS, canAddCustom: false },
  })
  await wrapper.find('input').trigger('focus')
  return wrapper
}

// The visible mark is a logo now, so the assertion reads the accessible name
// rather than the rendered text -- which is also the thing that would break if
// the logo were shown with nothing to say what it is.
const shops = (wrapper) => wrapper.findAll('.shop-badge__name').map((s) => s.text())
const discs = (wrapper) => wrapper.findAll('.shop-badge')

describe('the shop a suggestion came from', () => {
  it('names every shop carrying it', async () => {
    const wrapper = await mountForm(true)
    expect(shops(wrapper)).toEqual(['Auchan', 'Carrefour', 'Lidl'])
  })

  it('draws every known shop as its own mark, in its own colours', async () => {
    const wrapper = await mountForm(true)
    expect(wrapper.findAll('.shop-badge svg')).toHaveLength(3)
    // Not the theme's colours: a recoloured Carrefour blue is not Carrefour, so
    // these are the one place in this app where a mark is not tinted by
    // currentColor.
    expect(wrapper.html()).toContain('#ec1c24')
    expect(wrapper.html()).toContain('#004e9f')
  })

  it("keeps the colours in Lidl's mark, which are what make it readable", async () => {
    // The icon-set version was flattened to a single blue and became a faint
    // ring with four unreadable letters. This asset is Lidl's OWN favicon, which
    // they ship for a 16-pixel browser tab, so the yellow and red do the work
    // that the lettering cannot at this size.
    const wrapper = await mountForm(true)
    const html = wrapper.html()
    expect(html).toContain('#fff000')
    expect(html).toContain('#e60a14')
    expect(html).toContain('#0050aa')
  })

  it('lets a mark that is its own disc fill the disc', async () => {
    const wrapper = await mountForm(true)
    expect(wrapper.findAll('.shop-badge--bleed')).toHaveLength(1)
  })

  it('falls back to an initial for a shop whose logo nobody has drawn', async () => {
    // A fourth retailer is one line in a registry; its logo is a separate job.
    // An initial is legible in the meantime, where a missing asset is a blank
    // circle that looks like a bug.
    const wrapper = mount(AddItemForm, {
      props: {
        name: 'x',
        suggestions: [{ name: 'Ceva', maker: null, retailers: ['profi'] }],
        canAddCustom: false,
      },
    })
    await wrapper.find('input').trigger('focus')
    expect(wrapper.findAll('.shop-badge__letter').map((l) => l.text())).toEqual(['P'])
  })

  it('still says which shop it is for anything that cannot see the logo', async () => {
    const wrapper = await mountForm(true)
    expect(discs(wrapper)[0].attributes('title')).toBe('Auchan')
  })

  it('leaves a row with no shops alone rather than drawing an empty chip', async () => {
    // A product from the app database's own catalog has no `retailers` key.
    // Absent is meaningful here -- it says a list typed this in -- so it
    // has to render as nothing, not as a blank tag.
    const wrapper = await mountForm(true)
    const rows = wrapper.findAll('.suggestion-text')
    expect(rows[2].findAll('.shop-badge')).toHaveLength(0)
  })

  it('keeps the maker, which is a different fact from the shop', async () => {
    // Auchan sells products branded Auchan, so these two are routinely the same
    // word and must not render alike.
    const wrapper = await mountForm(true)
    const first = wrapper.findAll('.suggestion-text')[0]
    expect(first.find('.suggestion-maker').text()).toBe('Dorna')
    expect(first.findAll('.shop-badge__name').map((s) => s.text())).toEqual(['Auchan', 'Carrefour'])
  })

  it('still renders the sub-line for a row that has shops but no maker', async () => {
    channel.nightly = true
    const wrapper = mount(AddItemForm, {
      props: {
        name: 'x',
        suggestions: [{ name: 'Banane', maker: null, retailers: ['auchan'] }],
        canAddCustom: false,
      },
    })
    await wrapper.find('input').trigger('focus')
    expect(shops(wrapper)).toEqual(['Auchan'])
    expect(wrapper.find('.suggestion-maker').exists()).toBe(false)
  })
})

// ─── narrowing the search to one shop ────────────────────────────────────────
// The chips above the results. Same channel gate as the badges below them, and
// the same reason: the catalog is a fraction of what the shops really stock, so
// "nothing at Lidl" would usually mean "not scraped yet" and read to a shopper
// as the shop being empty.
describe('the shop filter chips', () => {
  async function mountWithChips(props = {}) {
    channel.nightly = true
    const wrapper = mount(AddItemForm, {
      props: {
        name: 'apa',
        suggestions: SUGGESTIONS,
        canAddCustom: false,
        shopOptions: ['auchan', 'lidl'],
        ...props,
      },
    })
    await wrapper.find('input').trigger('focus')
    return wrapper
  }

  const chips = (wrapper) => wrapper.findAll('.shop-filter__chip')

  it('offers every shop, plus a way back to all of them', async () => {
    const wrapper = await mountWithChips()
    expect(chips(wrapper).map((c) => c.text())).toEqual(['All shops', 'Auchan', 'Lidl'])
  })

  it('marks the chosen one, and only that one', async () => {
    // A radiogroup rather than a set of toggles: exactly one at a time, "All"
    // included. Pressed buttons would suggest several could be on at once and
    // leave the none-chosen state with no name.
    const wrapper = await mountWithChips({ searchShop: 'lidl' })
    expect(chips(wrapper).map((c) => c.attributes('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })

  it('marks "All shops" when nothing is chosen', async () => {
    const wrapper = await mountWithChips()
    expect(chips(wrapper)[0].attributes('aria-checked')).toBe('true')
  })

  it('asks for a shop when one is pressed', async () => {
    const wrapper = await mountWithChips()
    await chips(wrapper)[2].trigger('click')
    expect(wrapper.emitted('select-shop').at(-1)).toEqual(['lidl'])
  })

  it('lets the chosen chip be pressed again to clear it', async () => {
    const wrapper = await mountWithChips({ searchShop: 'lidl' })
    await chips(wrapper)[2].trigger('click')
    expect(wrapper.emitted('select-shop').at(-1)).toEqual([null])
  })

  it('renders nothing when there are no shops to offer', async () => {
    // No catalog configured, or a catalog with no retailers yet. A filter with
    // one option is not a filter.
    const wrapper = await mountWithChips({ shopOptions: [] })
    expect(chips(wrapper)).toHaveLength(0)
  })

  it('stays out of the way of the recents list', async () => {
    // Recents come from what this list has bought, which says nothing
    // about which shops carry it -- so the chips would sit above rows they
    // cannot narrow, and the one that did nothing would look broken.
    const wrapper = await mountWithChips({
      name: '',
      suggestions: [],
      recents: [{ name: 'Lapte', maker: null }],
      expanded: true,
    })
    // The recents really are on screen, or this would pass by the panel simply
    // being shut.
    expect(wrapper.find('.suggestions-label').exists()).toBe(true)
    expect(chips(wrapper)).toHaveLength(0)
  })
})
