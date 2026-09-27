// @vitest-environment happy-dom
//
// Filtering the list by shop, which is the filter that can hide something you
// need while you are standing in the shop.
//
// The rule the whole thing rests on: WE HIDE A ROW ONLY ON POSITIVE EVIDENCE
// THAT IT IS SOMEWHERE ELSE. Most rows have no shop against them -- typed by
// hand, or in a corner of the catalog no scraper has reached -- and treating
// "we do not know" as "not here" would take a shopper's own item off their
// screen with nothing to say why. That is the case this file exists for; it
// looks like an edge case and is in fact the common one.
//
// The rest is what stops the filter lying: a shop is only offered if something
// on this list is sold there, the counts beside the shops are what picking one
// would really leave, and none of it renders on production.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ShoppingList from '../src/components/ShoppingList.vue'
import ListSortMenu from '../src/components/ListSortMenu.vue'
import { productKey } from '../src/lib/productSearch'

const channel = vi.hoisted(() => ({ nightly: true }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  get IS_NIGHTLY() {
    return channel.nightly
  },
}))

const item = (id, name, maker = null, checked = false) => ({
  id,
  name,
  maker,
  checked,
  quantity: 1,
  added_by: 'user-1',
})

// Four rows and three situations: sold at one shop, sold at two, and -- the one
// that matters -- sold nowhere we know of.
const ITEMS = [
  item('a', 'Lapte Zuzu 1L', 'Zuzu'),
  item('b', 'Apa plata Dorna 2L', 'Dorna'),
  item('c', 'Paine de casa'),
  item('d', 'Oua de tara', null, true),
]

const SHOP_MAP = new Map([
  [productKey('Lapte Zuzu 1L', 'Zuzu'), ['lidl']],
  [productKey('Apa plata Dorna 2L', 'Dorna'), ['auchan', 'carrefour']],
])

const mounted = []
const realMatchMedia = window.matchMedia

afterEach(() => {
  while (mounted.length) mounted.pop().unmount()
  document.body.innerHTML = ''
  window.matchMedia = realMatchMedia
  channel.nightly = true
})

function mountList(props = {}) {
  const wrapper = mount(ShoppingList, {
    props: { items: ITEMS, shopMap: SHOP_MAP, loading: false, ...props },
  })
  mounted.push(wrapper)
  return wrapper
}

const names = (wrapper) => wrapper.findAll('.item-name').map((n) => n.text())

describe('filtering the list by shop', () => {
  it('shows everything when no shop is chosen', () => {
    expect(names(mountList())).toEqual([
      'Lapte Zuzu 1L',
      'Apa plata Dorna 2L',
      'Paine de casa',
      'Oua de tara',
    ])
  })

  it('KEEPS A ROW IT KNOWS NOTHING ABOUT', () => {
    // The load-bearing case. Bread and eggs are sold at Lidl in real life; the
    // catalog has simply never seen them. Hiding them here would tell a shopper
    // standing in Lidl that they do not need bread.
    expect(names(mountList({ shopFilter: 'lidl' }))).toEqual([
      'Lapte Zuzu 1L',
      'Paine de casa',
      'Oua de tara',
    ])
  })

  it('hides only what it knows is sold somewhere else', () => {
    // The water is the one row with positive evidence against it: we have seen
    // it at Auchan and Carrefour and not at Lidl.
    expect(names(mountList({ shopFilter: 'lidl' }))).not.toContain('Apa plata Dorna 2L')
  })

  it('keeps a row sold at the chosen shop among others', () => {
    const shown = names(mountList({ shopFilter: 'carrefour' }))
    expect(shown).toContain('Apa plata Dorna 2L')
    // And drops the one seen only at Lidl.
    expect(shown).not.toContain('Lapte Zuzu 1L')
  })

  it('says which shop emptied the list, not which state did', () => {
    // A shop filter can empty a list nobody expected to be empty, so it is the
    // one named. "Everything here is checked" would be a lie and a dead end.
    const wrapper = mountList({ items: [ITEMS[1]], shopFilter: 'lidl' })
    expect(wrapper.find('.filter-empty').text()).toContain('Lidl')
  })
})

describe('which shops the menu offers', () => {
  const shopsOffered = (wrapper) =>
    wrapper
      .findComponent(ListSortMenu)
      .props('shops')

  it('offers only shops something on this list is sold at', () => {
    // Never a shop that would empty the list. The catalog knows dozens; this
    // list touches three.
    expect(shopsOffered(mountList())).toEqual(['auchan', 'carrefour', 'lidl'])
  })

  it('offers none at all when nothing on the list has a shop', () => {
    expect(shopsOffered(mountList({ shopMap: new Map() }))).toEqual([])
  })

  it('counts what picking a shop would really leave, unknowns included', () => {
    // The count has to agree with the filter or the menu is lying about its own
    // rows. Lidl: milk, plus the two we know nothing about.
    const counts = mountList().findComponent(ListSortMenu).props('shopCounts')
    expect(counts).toEqual({ lidl: 3, auchan: 3, carrefour: 3 })
  })

  it('counts differently once a row is known somewhere else', () => {
    // With only the water and the bread, Lidl leaves the bread alone.
    const counts = mountList({ items: [ITEMS[1], ITEMS[2]] })
      .findComponent(ListSortMenu)
      .props('shopCounts')
    expect(counts.lidl).toBeUndefined()
    expect(counts.auchan).toBe(2)
  })
})

describe('the menu itself', () => {
  const menuItems = () => [...document.querySelectorAll('.menu-item')]

  function openMenu(props = {}) {
    const wrapper = mount(ListSortMenu, {
      props: { items: ITEMS, modelValue: 'added', ...props },
      attachTo: document.body,
    })
    mounted.push(wrapper)
    return wrapper
  }

  it('shows no shop section when there are no shops', async () => {
    const wrapper = openMenu()
    await wrapper.find('.filter-btn').trigger('click')
    expect(menuItems()).toHaveLength(2)
    expect(document.querySelector('.filter-group')).toBeNull()
  })

  it('adds the shops below the order, under their own heading', async () => {
    const wrapper = openMenu({ shops: ['auchan', 'lidl'], shopCounts: { auchan: 2, lidl: 3 } })
    await wrapper.find('.filter-btn').trigger('click')
    // Two orders, "Any shop", and the two shops.
    expect(menuItems()).toHaveLength(5)
    expect(document.querySelector('.filter-group').textContent.trim()).toBe('Shop')
  })

  it('names each shop, so a logo is never the only thing said', async () => {
    const wrapper = openMenu({ shops: ['auchan', 'lidl'] })
    await wrapper.find('.filter-btn').trigger('click')
    const text = menuItems().map((i) => i.textContent)
    expect(text.some((t) => t.includes('Auchan'))).toBe(true)
    expect(text.some((t) => t.includes('Lidl'))).toBe(true)
  })

  it('picks a shop and closes', async () => {
    const wrapper = openMenu({ shops: ['auchan', 'lidl'] })
    await wrapper.find('.filter-btn').trigger('click')
    await menuItems()[4].click()
    expect(wrapper.emitted('update:shop').at(-1)).toEqual(['lidl'])
  })

  it('lets the chosen shop be pressed again to clear it', async () => {
    // Radios do not normally untoggle, but there are only ever a handful of
    // shops and reaching back up to "Any shop" to undo a mistap is the kind of
    // small friction that makes a filter feel like a trap.
    const wrapper = openMenu({ shops: ['lidl'], shop: 'lidl' })
    await wrapper.find('.filter-btn').trigger('click')
    await menuItems().at(-1).click()
    expect(wrapper.emitted('update:shop').at(-1)).toEqual([null])
  })

  it('marks the button as filtering when only a shop is set', async () => {
    // The dot is what stops a filtered list reading as the whole list. An
    // invisible filter is how items get declared missing.
    const wrapper = openMenu({ shops: ['lidl'], shop: 'lidl', modelValue: 'added' })
    expect(wrapper.find('.filter-btn--on').exists()).toBe(true)
    expect(wrapper.find('.filter-btn__dot').exists()).toBe(true)
  })
})
