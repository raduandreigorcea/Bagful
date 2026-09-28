// @vitest-environment happy-dom
//
// The one-time first-run tour and its "seen" flag. Covers the flag helpers, the
// six-step walk-through, and the two things the redesign rests on: the pictures
// are the real list row driven by a script, and the card holds one height.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import OnboardingTour from '../src/components/OnboardingTour.vue'
import ShoppingListItem from '../src/components/ShoppingListItem.vue'
import { hasSeenTour, markTourSeen } from '../src/lib/onboarding'

afterEach(() => {
  vi.useRealTimers()
})

async function goTo(wrapper, n) {
  for (let i = 0; i < n; i++) await wrapper.find('.tour-next').trigger('click')
}

describe('onboarding tour flag', () => {
  it('starts unseen and flips once marked', () => {
    localStorage.clear()
    expect(hasSeenTour(localStorage)).toBe(false)
    markTourSeen(localStorage)
    expect(hasSeenTour(localStorage)).toBe(true)
  })
})

describe('OnboardingTour', () => {
  it('renders nothing while closed', () => {
    const wrapper = mount(OnboardingTour, { props: { open: false } })
    expect(wrapper.find('.tour-card').exists()).toBe(false)
  })

  it('walks the six steps and closes on the last', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true, inviteCode: 'ABCDEFGH' } })
    // First step, no Back yet. Back is the shared BackButton, hence .back-btn.
    expect(wrapper.find('.back-btn').exists()).toBe(false)
    expect(wrapper.find('.tour-next').text()).toBe('Next')

    await goTo(wrapper, 5) // → invite (last)
    expect(wrapper.find('.tour-next').text()).toBe('Start shopping')
    // The invite step surfaces the list's code.
    expect(wrapper.find('.art-code__value').text()).toBe('ABCDEFGH')

    await wrapper.find('.tour-next').trigger('click') // finish
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // Every beat's words are laid out in one grid cell and only the current one is
  // shown, which is what keeps the card one height from the first beat to the
  // last. Rendering only the current step's text would let it grow and shrink.
  it('lays out every step’s text at once and shows only the current one', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    expect(wrapper.findAll('.tour-copy__step')).toHaveLength(6)
    expect(wrapper.findAll('.tour-copy__step--on')).toHaveLength(1)
    expect(wrapper.find('.tour-copy__step--on').text()).toContain('Search for anything')

    await goTo(wrapper, 1)
    expect(wrapper.findAll('.tour-copy__step')).toHaveLength(6)
    expect(wrapper.find('.tour-copy__step--on').text()).toContain('Or just scan it')
    // One title carries the dialog's name, not six.
    expect(wrapper.findAll('#tour-title')).toHaveLength(1)
  })

  it('types a search and adds the first match', async () => {
    vi.useFakeTimers()
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await vi.advanceTimersByTimeAsync(700 + 4 * 170 + 50)
    expect(wrapper.find('.art-field__text').text()).toContain('mozz')
    expect(wrapper.find('.art-results--on').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1300)
    expect(wrapper.find('.art-result--added').text()).toContain('Mozzarella')
  })

  // The quantity beat mounts the real row and presses its real buttons, so the
  // count and the idle close are the component's own behaviour.
  it('opens the real stepper and counts up on it', async () => {
    vi.useFakeTimers()
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await goTo(wrapper, 2) // → quantity
    await vi.advanceTimersByTimeAsync(400) // out-in step transition
    expect(wrapper.findAllComponents(ShoppingListItem)).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(3500)
    const kiwi = wrapper.find('[data-demo="q2"]')
    expect(kiwi.find('.item-qty--open').exists()).toBe(true)
    expect(kiwi.find('.item-qty__value').text()).toBe('3')
  })

  // The real bar's shape: a 56px knob standing proud of a 53px track, carrying
  // the list's own label, not a smaller stand-in with its own words.
  it('shows the real buy bar under real checked rows', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await goTo(wrapper, 4) // → check out
    await new Promise((r) => setTimeout(r, 400)) // out-in step transition
    expect(wrapper.findAllComponents(ShoppingListItem).every((c) => c.props('item').checked)).toBe(true)
    expect(wrapper.find('.art-buy__thumb').exists()).toBe(true)
    expect(wrapper.find('.art-buy__label').text()).toBe('Slide to check out 2 items')
  })

  // Every row carries a placeholder face, not the fallback initial.
  it('gives the sample rows avatars', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await goTo(wrapper, 3) // → swipe
    await new Promise((r) => setTimeout(r, 400))
    expect(wrapper.findAll('img.item-avatar')).toHaveLength(3)
    expect(wrapper.find('.item-avatar--fallback').exists()).toBe(false)
  })

  it('can be skipped from any step', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await wrapper.find('.tour-skip').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('steps back with the shared BackButton', async () => {
    const wrapper = mount(OnboardingTour, { props: { open: true } })
    await goTo(wrapper, 1)

    const back = wrapper.find('.back-btn')
    expect(back.exists()).toBe(true)
    await back.trigger('click')

    // Returned to the first step, so Back is gone again.
    expect(wrapper.find('.back-btn').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

// The hook the swipe beat plays through. It must move the face and arm at the
// real thresholds, and never check or delete anything on its own.
describe('ShoppingListItem demoOffset', () => {
  const item = { id: 'x', name: 'Kiwi', checked: false, quantity: 1, created_at: '' }

  it('follows the offset, arms past the threshold, and settles without emitting', async () => {
    const wrapper = mount(ShoppingListItem, { props: { item } })
    await wrapper.setProps({ demoOffset: 40 })
    expect(wrapper.find('.item-face').attributes('style')).toContain('translateX(40px)')
    expect(wrapper.find('.item-action--armed').exists()).toBe(false)

    await wrapper.setProps({ demoOffset: 100 })
    expect(wrapper.find('.item-action--check.item-action--armed').exists()).toBe(true)

    await wrapper.setProps({ demoOffset: null })
    expect(wrapper.find('.item-face').attributes('style')).toContain('translateX(0px)')
    expect(wrapper.emitted('toggle')).toBeUndefined()
    expect(wrapper.emitted('delete')).toBeUndefined()
  })
})
