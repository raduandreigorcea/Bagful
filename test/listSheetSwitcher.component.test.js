// @vitest-environment happy-dom
//
// The switcher half of the list sheet. A list is a card that says how much is
// left and who is in it, so you can tell three lists apart without opening them.
// What is worth pinning is what the card says in the three states a list can be
// in (some left, all done, empty) and that the two halves of the sheet stay apart.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ListSheet from '../src/components/ListSheet.vue'

const lists = [
  {
    id: 'a',
    name: 'Weekend',
    emoji: '🏠',
    ownerId: 'me',
    members: [{ user_id: 'me', display_name: 'Radu' }],
    total: 8,
    done: 2,
  },
  { id: 'b', name: 'Party', emoji: '🎉', ownerId: 'x', members: [], total: 4, done: 4 },
  { id: 'c', name: 'Empty', emoji: '📦', ownerId: 'x', members: [], total: 0, done: 0 },
]

function mountSheet(props = {}) {
  return mount(ListSheet, {
    global: { stubs: { AppModal: false } },
    props: { open: true, lists, listId: 'a', currentUserId: 'me', mode: 'lists', ...props },
  })
}

const cards = (w) => w.findAll('.list-card')

describe('the list switcher cards', () => {
  it('says what is left, that it is all done, or that it is empty', () => {
    const meta = cards(mountSheet()).map((c) => c.find('.list-card__meta').text())
    expect(meta).toEqual(['6 to buy', "Everything's in the cart", 'Nothing here yet'])
  })

  it('draws progress only where there is something to count', () => {
    const bars = cards(mountSheet()).map((c) => c.find('.list-card__fill').exists())
    expect(bars).toEqual([true, true, false])
    expect(cards(mountSheet())[0].find('.list-card__fill').attributes('style')).toContain('25%')
  })

  it('marks the list you are on, and leaves the owner badge off the cards', () => {
    const [current, other] = cards(mountSheet())
    expect(current.attributes('aria-checked')).toBe('true')
    expect(other.attributes('aria-checked')).toBe('false')
    expect(current.find('.list-card__owner').exists()).toBe(false)
  })

  it('switches to a list it is not on, and closes either way', async () => {
    const wrapper = mountSheet()
    await cards(wrapper)[1].trigger('click')
    expect(wrapper.emitted('switch-list')).toEqual([['b']])
    await cards(wrapper)[0].trigger('click')
    expect(wrapper.emitted('switch-list')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
  it('shows the members in the full sheet and not in the switcher', () => {
    expect(mountSheet({ mode: 'all' }).find('.members-card').exists()).toBe(true)
    expect(mountSheet({ mode: 'lists' }).find('.members-card').exists()).toBe(false)
  })

  describe('held on a card', () => {
    afterEach(() => vi.useRealTimers())

    it('opens the members of that list over the sheet, without switching or closing', async () => {
      vi.useFakeTimers()
      const wrapper = mountSheet()
      const card = cards(wrapper)[1]
      await card.trigger('pointerdown')
      vi.advanceTimersByTime(500)
      await card.trigger('pointerup')
      await card.trigger('click')
      expect(wrapper.find('.members-card').exists()).toBe(true)
      expect(wrapper.find('.member__invite').exists()).toBe(false)
      expect(wrapper.emitted('switch-list')).toBeUndefined()
      expect(wrapper.emitted('close')).toBeUndefined()
    })

    it('is an ordinary tap when released early', async () => {
      vi.useFakeTimers()
      const wrapper = mountSheet()
      const card = cards(wrapper)[1]
      await card.trigger('pointerdown')
      vi.advanceTimersByTime(200)
      await card.trigger('pointerup')
      vi.advanceTimersByTime(500)
      await card.trigger('click')
      expect(wrapper.find('.members-card').exists()).toBe(false)
      expect(wrapper.emitted('switch-list')).toEqual([['b']])
    })
  })
})
