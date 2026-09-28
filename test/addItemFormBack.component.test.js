// @vitest-environment happy-dom
//
// What Android's Back button does to the add-item search.
//
// The press itself is handled in lib/nativeBack, which asks lib/modalStack to
// close whatever is in front of the page and only leaves the app when there is
// nothing. The form is not an AppModal and not a PopoverMenu, so it fell through
// both registration paths and the press went straight past it to exitApp() —
// closing the app from under a half-typed search. This pins the registration
// that fixes that: focus puts the form on the stack, blur takes it off.
//
// Its own file rather than a block in addItemForm.component.test.js because the
// stack is module state and that file leaves forms mounted; a separate file gets
// a fresh module registry and can assert on an empty stack.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AddItemForm from '../src/components/AddItemForm.vue'
import { closeTopModal, hasOpenModal } from '../src/lib/modalStack'

const PRODUCTS = [
  { name: 'Apa Plata 2L', maker: 'Dorna' },
  { name: 'Banane 1kg', maker: null },
]

// Unmounted after every test, so no layer outlives the form that opened it.
let wrapper = null

function mountForm(props = {}) {
  wrapper = mount(AddItemForm, {
    props: { name: 'apa', suggestions: PRODUCTS, ...props },
  })
  return wrapper
}

afterEach(() => {
  if (wrapper) wrapper.unmount()
  wrapper = null
})

describe('the add form and the Back press', () => {
  it('is not something Back closes until the field is focused', async () => {
    mountForm()
    await flushPromises()

    // Nothing painted over the page, so the press falls through to the router —
    // which on Home means leaving, and correctly so.
    expect(hasOpenModal()).toBe(false)
    expect(closeTopModal()).toBe(false)
  })

  it('becomes the thing Back closes as soon as the field is focused', async () => {
    mountForm()
    await wrapper.find('input').trigger('focus')
    await flushPromises()

    expect(hasOpenModal()).toBe(true)
  })

  it('takes the press itself rather than letting the app exit', async () => {
    mountForm()
    await wrapper.find('input').trigger('focus')
    await flushPromises()

    // true is what nativeBack reads as "handled" — the one thing standing
    // between a focused field and App.exitApp().
    expect(closeTopModal()).toBe(true)
    await flushPromises()

    expect(document.activeElement).not.toBe(wrapper.find('input').element)
    expect(wrapper.find('.suggestions-wrap').exists()).toBe(false)
  })

  it('stops being the press\'s business once the field is blurred by hand', async () => {
    mountForm()
    await wrapper.find('input').trigger('focus')
    await flushPromises()
    await wrapper.find('input').trigger('blur')
    await flushPromises()

    expect(hasOpenModal()).toBe(false)
  })

  it('leaves nothing on the stack when the form goes away', async () => {
    mountForm()
    await wrapper.find('input').trigger('focus')
    await flushPromises()
    expect(hasOpenModal()).toBe(true)

    wrapper.unmount()
    wrapper = null

    // A layer outliving its component could never be closed again — Back would
    // call into a dead form for the rest of the session.
    expect(hasOpenModal()).toBe(false)
  })

  // The lifted phone screen is the case this was written for: full screen, over
  // the list, with the keyboard up and a query typed into it.
  describe('on a phone, where the form is a whole screen', () => {
    let realMatchMedia

    beforeEach(() => {
      realMatchMedia = window.matchMedia
      window.matchMedia = (query) => ({
        matches: query.includes('899.98px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })
    })

    afterEach(() => {
      window.matchMedia = realMatchMedia
    })

    // Back is the ONLY way out of the sheet now — blur does not dismiss it and
    // neither does the surface behind it — so the registration has to survive
    // the keyboard going away. Keyed on focus, as it once was, a tap on
    // anything unfocusable inside the search would have quietly handed the next
    // Back press to Home's root-route case, which exits the app with a
    // half-typed search still on screen.
    it('stays the press\'s business when the keyboard goes away', async () => {
      mountForm({ expanded: true })
      await wrapper.find('input').trigger('focus')
      await flushPromises()
      expect(hasOpenModal()).toBe(true)

      await wrapper.find('input').trigger('blur')
      await flushPromises()

      expect(hasOpenModal()).toBe(true)
      expect(closeTopModal()).toBe(true)
    })

    // Found by the bot swarm: Escape only listened on the search box, so after a
    // tap on a shop chip (or anything else in the sheet) it did nothing, and
    // the keyboard had no way out of a whole-screen search.
    it('closes on Escape when the search box does not have focus', async () => {
      mountForm({ expanded: true })
      await wrapper.find('input').trigger('focus')
      await wrapper.find('input').trigger('blur')
      await flushPromises()

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()

      expect(wrapper.emitted('update:expanded').at(-1)).toEqual([false])
      expect(hasOpenModal()).toBe(false)
    })

    it('puts the search screen away instead of the app', async () => {
      // Raised the way the bar raises it, then focused, which is the order the
      // component itself uses on the way up.
      mountForm({ expanded: true })
      await wrapper.find('input').trigger('focus')
      await flushPromises()
      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')

      expect(closeTopModal()).toBe(true)
      await flushPromises()

      // Dismissed at once. The sheet is still drawn, because it is travelling
      // back down, but nobody is searching any more and Back has been answered.
      expect(wrapper.emitted('update:expanded').at(-1)).toEqual([false])
      expect(wrapper.find('.add-form').classes()).toContain('add-form--closing')
      // And the press is spent: a second one has nothing left to close and falls
      // through to the router, which is how Back gets you out of the app from
      // the list itself.
      expect(closeTopModal()).toBe(false)
    })
  })
})
