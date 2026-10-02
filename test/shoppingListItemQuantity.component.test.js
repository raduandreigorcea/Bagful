// @vitest-environment happy-dom
//
// Quantity on the row. It used to be picked in the add form, before the product
// it counted had been named, and was then frozen for the item's whole life: the
// row printed x2 as plain text, so a wrong number meant deleting the item and
// adding it back.
//
// The thing worth pinning hardest is the collision. The row's face is a button
// whose tap toggles the item checked — so every control added inside it has to
// swallow its own pointer and click events, or changing a quantity also ticks
// the thing off the list. That is silent when it breaks: the number still moves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Transition } from 'vue'
import { mount } from '@vue/test-utils'
import ShoppingListItem from '../src/components/ShoppingListItem.vue'

const item = (over = {}) => ({
  id: 'item-1',
  name: 'Milk',
  maker: null,
  quantity: 2,
  checked: false,
  added_by: 'user-1',
  ...over,
})

function mountRow(props = {}) {
  return mount(ShoppingListItem, {
    props: { item: item(), avatarName: 'Radu', ...props },
  })
}

describe('ShoppingListItem quantity', () => {
  it('shows the count as a control, closed by default', () => {
    const wrapper = mountRow()
    expect(wrapper.find('.item-qty').text()).toBe('x2')
    expect(wrapper.find('.item-qty').classes()).not.toContain('item-qty--open')
  })

  // One element in both states, not two that swap: a swap could only be animated
  // with mode="out-in", and that serialised pair is what made the add form's
  // stepper feel slow. The buttons are present all along and grow out of the
  // number's sides -- so while closed they must be unreachable by tab and by
  // click, or the row carries two invisible hit targets.
  it('keeps the buttons mounted but out of reach while closed', () => {
    const wrapper = mountRow()
    const steps = wrapper.findAll('.item-qty__step')

    expect(steps).toHaveLength(2)
    for (const step of steps) {
      expect(step.attributes('tabindex')).toBe('-1')
      expect(step.attributes('aria-hidden')).toBe('true')
    }
  })

  // Without this there is nothing to press on the rows most likely to need
  // raising, and "press the number" stops being a rule that holds.
  it('still offers the control on a row of one', () => {
    const wrapper = mountRow({ item: item({ quantity: 1 }) })
    const badge = wrapper.find('.item-qty')
    expect(badge.exists()).toBe(true)
    // The x is collapsed by CSS rather than unmounted, so the text still carries
    // it; what matters is that the row of one is marked as such.
    expect(wrapper.find('.item-qty__value').text()).toBe('1')
    expect(badge.classes()).toContain('item-qty--one')
  })

  it('asks the parent to open it rather than opening itself', async () => {
    const wrapper = mountRow()
    await wrapper.find('.item-qty__face').trigger('click')

    expect(wrapper.emitted('open-quantity')).toEqual([['item-1']])
    // Still closed: which row is open is the list's to decide, so that only one
    // ever is.
    expect(wrapper.find('.item-qty').classes()).not.toContain('item-qty--open')
  })

  it('opens when the parent says this is the open row', () => {
    const wrapper = mountRow({ qtyOpen: true })
    const badge = wrapper.find('.item-qty')

    expect(badge.classes()).toContain('item-qty--open')
    expect(wrapper.find('.item-qty__value').text()).toBe('2')
    for (const step of wrapper.findAll('.item-qty__step')) {
      expect(step.attributes('tabindex')).toBe('0')
      expect(step.attributes('aria-hidden')).toBeUndefined()
    }
  })

  // The row's own face is the check toggle, so the control cannot be dismissed
  // by pressing past it. Pressing the number again is the way out.
  it('closes on a second press of the number', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    await wrapper.find('.item-qty__face').trigger('click')

    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
    expect(wrapper.emitted('open-quantity')).toBeUndefined()
  })

  it('reports the resulting quantity, not a delta', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    const [minus, plus] = wrapper.findAll('.item-qty__step')

    await plus.trigger('click')
    await minus.trigger('click')

    expect(wrapper.emitted('set-quantity')).toEqual([
      [{ item: wrapper.props('item'), quantity: 3 }],
      [{ item: wrapper.props('item'), quantity: 1 }],
    ])
  })

  it('cannot go below one', async () => {
    const wrapper = mountRow({ item: item({ quantity: 1 }), qtyOpen: true })
    const minus = wrapper.findAll('.item-qty__step')[0]

    expect(minus.attributes('disabled')).toBeDefined()
    await minus.trigger('click')
    expect(wrapper.emitted('set-quantity')).toBeUndefined()
  })

  it('cannot go past the ceiling', async () => {
    const wrapper = mountRow({ item: item({ quantity: 99 }), qtyOpen: true })
    const plus = wrapper.findAll('.item-qty__step')[1]

    expect(plus.attributes('disabled')).toBeDefined()
    await plus.trigger('click')
    expect(wrapper.emitted('set-quantity')).toBeUndefined()
  })

  // The collision. A row's tap toggles it checked, so a quantity press that
  // reaches the face would tick the item off while changing its number.
  it('never toggles the item while its quantity is being changed', async () => {
    const closed = mountRow()
    await closed.find('.item-qty__face').trigger('click')
    expect(closed.emitted('toggle')).toBeUndefined()

    const open = mountRow({ qtyOpen: true })
    for (const btn of open.findAll('.item-qty__step')) await btn.trigger('click')
    await open.find('.item-qty').trigger('click')
    expect(open.emitted('toggle')).toBeUndefined()
  })

  // A tap on the row itself still has to work, or the guard above has been
  // written by breaking the thing it protects.
  it('still toggles on a tap that did not start on the quantity', async () => {
    const wrapper = mountRow()
    await wrapper.find('.item-toggle').trigger('click')

    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  // The avatar is not a control of its own, so a tap on it ticks the row.
  it('toggles on a tap on the avatar', async () => {
    const wrapper = mountRow()
    await wrapper.find('.item-avatar').trigger('click')

    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  // A photo is an <img>, which a mouse drags as an image by default: the
  // browser starts its own drag-and-drop, cancels the pointer, and the swipe
  // that began on the face snaps back instead of ticking or removing the row.
  it('does not let the photo be dragged as an image', () => {
    const wrapper = mountRow({ avatarUrl: 'https://img.clerk.com/face.png' })
    expect(wrapper.find('img.item-avatar').attributes('draggable')).toBe('false')
  })

  // A keyboard can remove a row as well as tick it; the list's Undo toast
  // covers a slip either way.
  it('asks to be removed on the Delete key', async () => {
    const wrapper = mountRow()
    await wrapper.find('.item-toggle').trigger('keydown', { key: 'Delete' })
    expect(wrapper.emitted('delete')).toHaveLength(1)
  })

  // Every row says who added it, yours included.
  it('shows the face of whoever added it', () => {
    expect(mountRow().find('.item-avatar').exists()).toBe(true)
  })

  it('carries the count in the row label, where the badge is only a picture', () => {
    const label = mountRow().find('.item-toggle').attributes('aria-label')
    expect(label).toContain('quantity 2')
  })

  // The marks are the shipped assets, not shapes drawn in CSS: a bar and a
  // rotated bar look like a minus and a plus until something in the icon set
  // moves and they are the only two that did not.
  it('draws its marks from the icon assets', () => {
    const wrapper = mountRow({ qtyOpen: true })
    const glyphs = wrapper.findAll('.item-qty__glyph')

    expect(glyphs).toHaveLength(2)
    for (const glyph of glyphs) expect(glyph.find('svg').exists()).toBe(true)
    // lucide-minus is one path; lucide-plus is two.
    expect(glyphs[0].findAll('path')).toHaveLength(1)
    expect(glyphs[1].findAll('path')).toHaveLength(2)
  })
})

// Counting up sends the digits upward and counting down sends them down, so the
// direction of a change is legible without reading the number.
describe('ShoppingListItem quantity direction', () => {
  const slideName = (wrapper) => wrapper.findComponent(Transition).props('name')

  it('starts out counting up', () => {
    expect(slideName(mountRow({ qtyOpen: true }))).toBe('qty-up')
  })

  it('sends the number down when the count goes down', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    await wrapper.findAll('.item-qty__step')[0].trigger('click')

    expect(slideName(wrapper)).toBe('qty-down')
  })

  it('sends it back up on the next increase', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    await wrapper.findAll('.item-qty__step')[0].trigger('click')
    await wrapper.findAll('.item-qty__step')[1].trigger('click')

    expect(slideName(wrapper)).toBe('qty-up')
  })

  // A press that cannot move the number must not leave the direction pointing
  // the wrong way for the change that comes after it.
  it('leaves the direction alone when the press changed nothing', async () => {
    const wrapper = mountRow({ item: item({ quantity: 99 }), qtyOpen: true })
    await wrapper.findAll('.item-qty__step')[0].trigger('click')
    expect(slideName(wrapper)).toBe('qty-down')

    // Plus is disabled at the ceiling, so this cannot repoint it upward.
    await wrapper.findAll('.item-qty__step')[1].trigger('click')
    expect(slideName(wrapper)).toBe('qty-down')
  })
})

// Left alone, it puts itself away. The countdown measures inactivity rather than
// how long the control has been open: counting 1 up to 6 is six taps, and timing
// out on the fourth would be worse than never closing at all.
describe('ShoppingListItem quantity idle timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes itself after two seconds untouched', async () => {
    const wrapper = mountRow({ qtyOpen: true })

    vi.advanceTimersByTime(1999)
    expect(wrapper.emitted('close-quantity')).toBeUndefined()

    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
  })

  it('starts the countdown when it opens, not when it mounts', async () => {
    const wrapper = mountRow()

    vi.advanceTimersByTime(5000)
    expect(wrapper.emitted('close-quantity')).toBeUndefined()

    await wrapper.setProps({ qtyOpen: true })
    vi.advanceTimersByTime(2000)
    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
  })

  it('restarts the countdown on every press inside it', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    const plus = wrapper.findAll('.item-qty__step')[1]

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1500)
      await plus.trigger('click')
    }

    // Six seconds of steady tapping, and it has not closed once.
    expect(wrapper.emitted('close-quantity')).toBeUndefined()
    expect(wrapper.emitted('set-quantity')).toHaveLength(4)

    vi.advanceTimersByTime(2000)
    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
  })

  // A disabled button dispatches no click, so a press on it is not activity the
  // control can see: at 1, jabbing minus does not hold the countdown open, and
  // the control closes from where it already was. Pinned because it reads as a
  // bug from the outside — the finger moved and the thing went away anyway — and
  // the fix would have to be something other than a button handler.
  it('cannot see a press on a disabled button, so it keeps counting', async () => {
    const wrapper = mountRow({ item: item({ quantity: 1 }), qtyOpen: true })

    vi.advanceTimersByTime(1500)
    await wrapper.findAll('.item-qty__step')[0].trigger('click')
    vi.advanceTimersByTime(500)

    expect(wrapper.emitted('set-quantity')).toBeUndefined()
    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
  })

  // The other half of that: the enabled button is activity, at any quantity.
  it('restarts the countdown from a press on the button that still works', async () => {
    const wrapper = mountRow({ item: item({ quantity: 1 }), qtyOpen: true })

    vi.advanceTimersByTime(1500)
    await wrapper.findAll('.item-qty__step')[1].trigger('click')
    vi.advanceTimersByTime(1500)

    expect(wrapper.emitted('set-quantity')).toHaveLength(1)
    expect(wrapper.emitted('close-quantity')).toBeUndefined()
  })

  it('stops counting once it is closed', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    await wrapper.setProps({ qtyOpen: false })

    vi.advanceTimersByTime(5000)
    expect(wrapper.emitted('close-quantity')).toBeUndefined()
  })

  // A row can leave while its control is open — checked out, deleted, filtered
  // away — and a timer outliving the component would emit into nothing.
  it('drops the timer when the row unmounts', () => {
    const wrapper = mountRow({ qtyOpen: true })
    wrapper.unmount()

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
  })
})

// A checked item is in the cart with its count settled — the next thing that
// happens to it is a checkout, which copies the quantity into purchase history.
describe('ShoppingListItem quantity on a checked row', () => {
  const checked = (over = {}) => item({ checked: true, ...over })

  it('still shows the count', () => {
    const wrapper = mountRow({ item: checked() })
    expect(wrapper.find('.item-qty__value').text()).toBe('2')
  })

  it('will not open', async () => {
    const wrapper = mountRow({ item: checked() })
    const face = wrapper.find('.item-qty__face')

    expect(face.attributes('disabled')).toBeDefined()
    await face.trigger('click')
    expect(wrapper.emitted('open-quantity')).toBeUndefined()
  })

  it('drops the "change it" half of its label', () => {
    const label = mountRow({ item: checked() }).find('.item-qty__face').attributes('aria-label')
    expect(label).toBe('Quantity 2')
    expect(label).not.toContain('Change')
  })

  // Ticking a row does not always go through the swipe that closes the stepper:
  // a tap on the face toggles it, and so does another member's device.
  it('comes down when the row is ticked underneath it', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    expect(wrapper.emitted('close-quantity')).toBeUndefined()

    await wrapper.setProps({ item: checked() })

    expect(wrapper.emitted('close-quantity')).toHaveLength(1)
  })

  it('stays put when an unchecked row changes for other reasons', async () => {
    const wrapper = mountRow({ qtyOpen: true })
    await wrapper.setProps({ item: item({ quantity: 3 }) })

    expect(wrapper.emitted('close-quantity')).toBeUndefined()
  })
})


// The row's face used to be role="button" with the tap and the keyboard on it,
// which made every control inside it an interactive descendant of a button --
// markup a screen reader may flatten, and the quantity stepper is what it would
// flatten away. The button is a real button now, sibling to the stepper, and the
// face is only the surface the finger drags.
//
// None of the gestures had any coverage before this, so the restructure had
// nothing holding it in place.
describe('ShoppingListItem gestures', () => {
  const face = (wrapper) => wrapper.find('.item-face')

  async function drag(wrapper, { dx = 0, dy = 0 } = {}) {
    const el = face(wrapper)
    await el.trigger('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
    await el.trigger('pointermove', { pointerId: 1, clientX: dx, clientY: dy })
    await el.trigger('pointerup', { pointerId: 1, clientX: dx, clientY: dy })
  }

  it('exposes one button per action, none of them inside another', () => {
    const wrapper = mountRow({ qtyOpen: true })

    expect(face(wrapper).attributes('role')).toBeUndefined()
    expect(face(wrapper).attributes('tabindex')).toBeUndefined()
    // The toggle and the two stepper buttons are siblings, not nested.
    expect(wrapper.find('.item-toggle').element.tagName).toBe('BUTTON')
    expect(wrapper.find('.item-toggle .item-qty__step').exists()).toBe(false)
  })

  it('says whether the item is checked, on the control that checks it', async () => {
    const wrapper = mountRow()
    expect(wrapper.find('.item-toggle').attributes('aria-pressed')).toBe('false')

    await wrapper.setProps({ item: item({ checked: true }) })
    expect(wrapper.find('.item-toggle').attributes('aria-pressed')).toBe('true')
  })

  it('commits a check on a swipe right past the trigger', async () => {
    const wrapper = mountRow()
    await drag(wrapper, { dx: 80 })

    expect(wrapper.emitted('toggle')).toHaveLength(1)
    expect(wrapper.emitted('delete')).toBeUndefined()
  })

  // Deliberately further than a check: a wrong check costs one tap to undo.
  it('commits a delete only on the longer swipe left', async () => {
    const short = mountRow()
    await drag(short, { dx: -80 })
    expect(short.emitted('delete')).toBeUndefined()

    const long = mountRow()
    await drag(long, { dx: -110 })
    expect(long.emitted('delete')).toHaveLength(1)
  })

  // The swipe ends over the toggle, so the browser fires a click at it. Without
  // the guard, checking an item by swiping would immediately uncheck it again.
  it('swallows the click a swipe leaves behind', async () => {
    const wrapper = mountRow()
    await drag(wrapper, { dx: 80 })
    expect(wrapper.emitted('toggle')).toHaveLength(1)

    await wrapper.find('.item-toggle').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('lets the next real tap through again', async () => {
    const wrapper = mountRow()
    await drag(wrapper, { dx: 80 })
    await wrapper.find('.item-toggle').trigger('click')

    await wrapper.find('.item-toggle').trigger('pointerdown', { pointerId: 2, clientX: 5, clientY: 5 })
    await wrapper.find('.item-toggle').trigger('click')

    expect(wrapper.emitted('toggle')).toHaveLength(2)
  })

  // A shallow diagonal belongs to the scroller. Releasing after dragging the
  // list past a row must not tick that row off.
  it('leaves a vertical drag to the scroller', async () => {
    const wrapper = mountRow()
    await drag(wrapper, { dx: 4, dy: 60 })

    expect(wrapper.emitted('toggle')).toBeUndefined()
    expect(wrapper.emitted('delete')).toBeUndefined()
  })
})
