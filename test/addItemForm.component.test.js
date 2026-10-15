// @vitest-environment happy-dom
//
// The suggestions dropdown: what it shows, and that picking never races the
// input's blur (the options use mousedown, not click, for exactly that reason).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AddItemForm from '../src/components/AddItemForm.vue'

const PRODUCTS = [
  { name: 'Apa Plata 2L', maker: 'Dorna' },
  { name: 'Banane 1kg', maker: null },
]

// What the phone search screen opens on before anything is typed.
const RECENTS = [
  { name: 'Paine Alba', maker: 'Vel Pitar' },
  { name: 'Oua M 10 buc', maker: null },
]

async function mountForm(props = {}) {
  const wrapper = mount(AddItemForm, {
    props: {
      name: 'apa',
      quantity: 1,
      suggestions: [],
      suggestionsLoading: false,
      canAddCustom: false,
      ...props,
    },
  })
  // The dropdown only exists while the input has focus.
  await wrapper.find('input').trigger('focus')
  return wrapper
}

const hatch = (wrapper) => wrapper.find('.suggestion--custom')

describe('AddItemForm suggestions', () => {
  it('stays closed when there is nothing to offer', async () => {
    const wrapper = await mountForm()
    expect(wrapper.find('.suggestions-wrap').exists()).toBe(false)
  })

  it('stays closed while the input is not focused', () => {
    const wrapper = mount(AddItemForm, {
      props: { name: 'apa', quantity: 1, suggestions: PRODUCTS, canAddCustom: true },
    })
    expect(wrapper.find('.suggestions-wrap').exists()).toBe(false)
  })

  it('lists the matches with their makers', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    const names = wrapper.findAll('.suggestion-name').map((n) => n.text())
    expect(names).toEqual(['Apa Plata 2L', 'Banane 1kg'])
    expect(wrapper.findAll('.suggestion-maker').map((m) => m.text())).toEqual(['Dorna'])
  })

  // A focused field is a search in progress, so the page behind it is blurred
  // from the moment of focus, matches or not, and not a moment after.
  it('blurs the page while the field is focused, matches or not', async () => {
    const wrapper = await mountForm()
    expect(wrapper.find('.add-dim').exists()).toBe(true)
    expect(wrapper.find('.add-slot').classes()).toContain('add-slot--dim')

    await wrapper.setProps({ suggestions: PRODUCTS })
    expect(wrapper.find('.add-dim').exists()).toBe(true)

    await wrapper.find('input').trigger('blur')
    expect(wrapper.find('.add-dim').exists()).toBe(false)
  })

  it('does not blur a field nobody is using', () => {
    const wrapper = mount(AddItemForm, {
      props: { name: '', quantity: 1, suggestions: PRODUCTS, canAddCustom: true },
    })
    expect(wrapper.find('.add-dim').exists()).toBe(false)
  })

  // The blur sits inside the lifted slot, so it must come before the form: in
  // that stacking context, DOM order is what keeps the field above the blur.
  it('draws the blur underneath the field, not over it', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    const slot = wrapper.find('.add-slot').element
    const children = [...slot.children]
    expect(children.indexOf(slot.querySelector('.add-dim'))).toBeLessThan(
      children.indexOf(slot.querySelector('.add-form')),
    )
  })

  it('reports the picked product rather than filling the input', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await wrapper.findAll('.suggestion')[0].trigger('mousedown')

    expect(wrapper.emitted('select')[0][0]).toEqual(PRODUCTS[0])
    // Picking must not touch the input's value — the parent adds it outright.
    expect(wrapper.emitted('update:name')).toBeUndefined()
  })

  it('opens for the escape hatch alone when nothing matched', async () => {
    const wrapper = await mountForm({ suggestions: [], canAddCustom: true })

    expect(wrapper.find('.suggestions-wrap').exists()).toBe(true)
    expect(wrapper.findAll('.suggestion')).toHaveLength(1)
    expect(hatch(wrapper).text()).toContain('Add “apa”')
  })

  it('puts the typed name last, whether or not a match is exactly it', async () => {
    for (const name of ['apa', 'banane 1kg']) {
      const wrapper = await mountForm({ name, suggestions: PRODUCTS, canAddCustom: true })

      const rows = wrapper.findAll('.suggestion')
      expect(rows).toHaveLength(3)
      expect(rows[2].classes()).toContain('suggestion--custom')
    }
  })

  it('hides the escape hatch when the parent says the query is too short', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS, canAddCustom: false })
    expect(hatch(wrapper).exists()).toBe(false)
  })

  it('asks the parent to open the custom-product modal', async () => {
    const wrapper = await mountForm({ suggestions: [], canAddCustom: true })
    await hatch(wrapper).trigger('mousedown')
    expect(wrapper.emitted('add-custom')).toHaveLength(1)
  })

  // The input and the results have to be announced as a pair, or they are two
  // unrelated elements that happen to sit near each other.
  describe('combobox wiring', () => {
    it('points the input at the listbox while it is open', async () => {
      const wrapper = await mountForm({ suggestions: PRODUCTS })
      const input = wrapper.find('input')

      expect(input.attributes('role')).toBe('combobox')
      expect(input.attributes('aria-expanded')).toBe('true')
      expect(input.attributes('aria-controls')).toBe(wrapper.find('ul').attributes('id'))
    })

    it('reports itself collapsed when there is nothing to offer', async () => {
      const wrapper = await mountForm()

      expect(wrapper.find('input').attributes('aria-expanded')).toBe('false')
      expect(wrapper.find('input').attributes('aria-controls')).toBeUndefined()
    })

    // A listbox may only own options; a plain list item in between takes the
    // options out of the accessibility tree with it.
    it('lets the listbox own every option directly', async () => {
      const wrapper = await mountForm({ suggestions: PRODUCTS, canAddCustom: true })

      const children = wrapper.findAll('ul.suggestions > li')
      expect(children.length).toBeGreaterThan(0)
      for (const li of children) expect(li.attributes('role')).toBe('presentation')
      // Products and the escape hatch alike.
      expect(wrapper.findAll('[role="option"]')).toHaveLength(3)
    })
  })

  // The rows commit on mousedown so the tap cannot steal focus from the input.
  // That alone leaves the keyboard with no way in, because Enter and Space raise
  // click and never mousedown — so both are bound, and `detail` is what keeps a
  // pointer press from counting twice.
  describe('keyboard activation', () => {
    it('picks a product on Enter, which arrives as a click with no click count', async () => {
      const wrapper = await mountForm({ suggestions: PRODUCTS })
      await wrapper.findAll('.suggestion')[0].trigger('click', { detail: 0 })

      expect(wrapper.emitted('select')).toHaveLength(1)
      expect(wrapper.emitted('select')[0][0]).toEqual(PRODUCTS[0])
    })

    it('opens the custom-product modal on Enter', async () => {
      const wrapper = await mountForm({ suggestions: [], canAddCustom: true })
      await hatch(wrapper).trigger('click', { detail: 0 })

      expect(wrapper.emitted('add-custom')).toHaveLength(1)
    })

    it('adds a pointer-picked product once, not twice', async () => {
      const wrapper = await mountForm({ suggestions: PRODUCTS })
      // What a real mouse sends: mousedown, then a click carrying the count.
      const row = wrapper.findAll('.suggestion')[0]
      await row.trigger('mousedown')
      await row.trigger('click', { detail: 1 })

      expect(wrapper.emitted('select')).toHaveLength(1)
    })

    it('opens the custom-product modal once on a pointer press', async () => {
      const wrapper = await mountForm({ suggestions: [], canAddCustom: true })
      await hatch(wrapper).trigger('mousedown')
      await hatch(wrapper).trigger('click', { detail: 1 })

      expect(wrapper.emitted('add-custom')).toHaveLength(1)
    })
  })

  // While a search is running the dropdown must not answer the question it is
  // still asking: no stale matches, and above all no "Can't find it?".
  describe('while a search is running', () => {
    it('opens with skeleton rows before any match has arrived', async () => {
      const wrapper = await mountForm({ suggestions: [], suggestionsLoading: true })

      expect(wrapper.find('.suggestions-wrap').exists()).toBe(true)
      expect(wrapper.findAll('.suggestion-skeleton').length).toBeGreaterThan(0)
    })

    it('does not offer the escape hatch mid-search', async () => {
      const wrapper = await mountForm({ suggestions: [], suggestionsLoading: true, canAddCustom: true })
      expect(hatch(wrapper).exists()).toBe(false)
    })

    it('hides the previous query matches rather than passing them off as this one', async () => {
      const wrapper = await mountForm({ suggestions: PRODUCTS, suggestionsLoading: true, canAddCustom: true })

      expect(wrapper.findAll('.suggestion')).toHaveLength(0)
      expect(wrapper.findAll('.suggestion-skeleton').length).toBeGreaterThan(0)
    })

    it('marks the list busy for screen readers', async () => {
      const wrapper = await mountForm({ suggestions: [], suggestionsLoading: true })
      expect(wrapper.find('.suggestions').attributes('aria-busy')).toBe('true')
    })

    it('swaps the skeletons for the real rows once the search settles', async () => {
      const wrapper = await mountForm({ suggestions: [], suggestionsLoading: true, canAddCustom: true })
      await wrapper.setProps({ suggestions: PRODUCTS, suggestionsLoading: false })

      expect(wrapper.findAll('.suggestion-skeleton')).toHaveLength(0)
      expect(wrapper.findAll('.suggestion-name').map((n) => n.text())).toEqual([
        'Apa Plata 2L',
        'Banane 1kg',
        'Add “apa”',
      ])
      expect(wrapper.find('.suggestions').attributes('aria-busy')).toBe('false')
    })
  })

  // Every control in the add row swallows mousedown to hold focus in the input.
  // preventDefault there suppresses the focus move and nothing else, so the
  // button stays an ordinary submit button and the browser submits on click.
  // happy-dom does not implement implicit form submission, so this pins the two
  // halves it can see; the click path itself is browser spec.
  it('leaves the add button submitting the form', async () => {
    const wrapper = await mountForm()

    expect(wrapper.find('.add-btn').attributes('type')).toBe('submit')

    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  // The button at the end of the row does two jobs, because with nothing typed
  // there is nothing to add and it would otherwise sit there disabled — which is
  // the state it is in every time the form comes back after an add.
  describe('the button at the end of the row', () => {
    const scanIcon = (wrapper) => wrapper.find('.scan-icon')
    const addIcon = (wrapper) => wrapper.find('.add-icon')
    // Both icons stay mounted and the current job is the one that is not faded
    // out, so "which icon is showing" is a class rather than an existence check.
    const showing = (icon) => icon.exists() && !icon.classes('add-btn__icon--off')

    // The button is the primary action of the app, and the swap it does on the
    // first keystroke used to be a <Transition mode="out-in"> -- which renders
    // nothing at all between unmounting one icon and mounting the other, and
    // leaves it that way for good if the leave never resolves. Whatever else is
    // true of this button, it always draws exactly one icon.
    it('always draws an icon, in either job', async () => {
      const wrapper = await mountForm({ name: '', canScan: true })
      expect(wrapper.findAll('.add-btn__icon').filter(showing)).toHaveLength(1)

      await wrapper.setProps({ name: 'apa' })
      expect(wrapper.findAll('.add-btn__icon').filter(showing)).toHaveLength(1)

      await wrapper.setProps({ name: '' })
      expect(wrapper.findAll('.add-btn__icon').filter(showing)).toHaveLength(1)
    })

    it('offers the scan when the field is empty', async () => {
      const wrapper = await mountForm({ name: '', canScan: true })

      expect(showing(scanIcon(wrapper))).toBe(true)
      expect(showing(addIcon(wrapper))).toBe(false)
      expect(wrapper.find('.add-btn').attributes('aria-label')).toBe('Scan a barcode')
      // Live, unlike the add button it replaces. That is the whole point.
      expect(wrapper.find('.add-btn').attributes('disabled')).toBeUndefined()
      // And never a submit button, or Enter in the field would open the camera.
      expect(wrapper.find('.add-btn').attributes('type')).toBe('button')
    })

    it('hands the button back to Add as soon as there is something to add', async () => {
      const wrapper = await mountForm({ name: '', canScan: true })

      await wrapper.setProps({ name: 'apa' })

      expect(showing(scanIcon(wrapper))).toBe(false)
      expect(showing(addIcon(wrapper))).toBe(true)
      expect(wrapper.find('.add-btn').attributes('type')).toBe('submit')
      expect(wrapper.find('.add-btn').attributes('aria-label')).toBe('Add')
    })

    it('treats a field holding only spaces as empty', async () => {
      const wrapper = await mountForm({ name: '   ', canScan: true })

      expect(showing(scanIcon(wrapper))).toBe(true)
    })

    it('stays the plain add button on a device that cannot scan', async () => {
      // A control that would fail is worse than no control: the browser is never
      // offered a camera it does not have.
      const wrapper = await mountForm({ name: '', canScan: false })

      // Absent outright, not merely faded: canScan cannot change under the
      // user's fingers, so there is nothing to animate between.
      expect(scanIcon(wrapper).exists()).toBe(false)
      expect(showing(addIcon(wrapper))).toBe(true)
      expect(wrapper.find('.add-btn').attributes('type')).toBe('submit')
      expect(wrapper.find('.add-btn').attributes('disabled')).toBeDefined()
    })

    it('asks for the scanner and never submits the form', async () => {
      const wrapper = await mountForm({ name: '', canScan: true })

      await wrapper.find('.add-btn').trigger('click')

      expect(wrapper.emitted('scan')).toHaveLength(1)
      expect(wrapper.emitted('submit')).toBeUndefined()
    })

    it('does not ask for the scanner when it is the add button', async () => {
      const wrapper = await mountForm({ name: 'apa', canScan: true })

      await wrapper.find('.add-btn').trigger('click')

      expect(wrapper.emitted('scan')).toBeUndefined()
    })

    // Pressing Add puts the row on a list this screen is covering, and the field
    // keeps its text, so the press had nothing to show for itself. The button
    // answers for it: the plus becomes a tick and then goes back.
    describe('once the add has landed', () => {
      const confirmIcon = (wrapper) => wrapper.find('.confirm-icon')

      beforeEach(() => {
        vi.useFakeTimers()
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('turns the plus into a tick, and still draws exactly one icon', async () => {
        const wrapper = await mountForm({ name: 'apa', canScan: true })

        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })

        expect(showing(confirmIcon(wrapper))).toBe(true)
        expect(showing(addIcon(wrapper))).toBe(false)
        expect(wrapper.findAll('.add-btn__icon').filter(showing)).toHaveLength(1)
      })

      it('goes back to the plus on its own', async () => {
        const wrapper = await mountForm({ name: 'apa', canScan: true })
        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })

        vi.advanceTimersByTime(2000)
        await nextTick()

        expect(showing(confirmIcon(wrapper))).toBe(false)
        expect(showing(addIcon(wrapper))).toBe(true)
      })

      // The parent clears lastAdded when the insert did not land after all. A
      // tick for a row that never reached the list is worse than no tick.
      it('takes the tick back when the add is taken back', async () => {
        const wrapper = await mountForm({ name: 'apa', canScan: true })
        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })

        await wrapper.setProps({ lastAdded: null })

        expect(showing(confirmIcon(wrapper))).toBe(false)
        expect(showing(addIcon(wrapper))).toBe(true)
      })

      // With an empty field the button is the scanner, and a tick flashing over
      // the camera glyph would be a different control taking the credit.
      it('leaves the scan button alone', async () => {
        const wrapper = await mountForm({ name: '', canScan: true })

        await wrapper.setProps({ lastAdded: { name: 'Paine Alba', maker: 'Vel Pitar' } })

        expect(showing(confirmIcon(wrapper))).toBe(false)
        expect(showing(scanIcon(wrapper))).toBe(true)
      })

      it('drops the tick as soon as the next name is typed', async () => {
        const wrapper = await mountForm({ name: 'apa', canScan: true })
        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })

        await wrapper.setProps({ name: 'lapte' })

        expect(showing(confirmIcon(wrapper))).toBe(false)
        expect(showing(addIcon(wrapper))).toBe(true)
      })
    })
  })

  it('keeps focus in the input when a row is pressed, so blur cannot beat it', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS, canAddCustom: true })

    for (const row of wrapper.findAll('.suggestion')) {
      const event = new Event('mousedown', { bubbles: true, cancelable: true })
      row.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
  })

  // On a phone the form lifts to the top of the screen so the dropdown gets the
  // whole screen rather than the slot between the topbar and the keyboard.
  // Above 600px none of this happens, which every test above relies on.
  describe('on a phone', () => {
    let realMatchMedia

    const stubViewport = (isPhone) => {
      window.matchMedia = (query) => ({
        matches: isPhone && query.includes('899.98px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })
    }

    beforeEach(() => {
      realMatchMedia = window.matchMedia
      stubViewport(true)
    })

    afterEach(() => {
      window.matchMedia = realMatchMedia
    })

    // Below the bar boundary this form has no place in the flow, so focusing it
    // is not how it opens any more: the bar's centre button raises the sheet by
    // setting the parent's `expanded` model, and the field is focused because
    // the sheet is open rather than the other way round. mountForm's focus
    // stands in for the focus the component gives itself on the way up.
    const mountSheet = (props = {}) => mountForm({ expanded: true, ...props })

    // Dismissing is reported at once, and the sheet is then marked as leaving
    // and stays drawn for the length of its travel. Both halves matter: the
    // model going false immediately is what lets the bar raise it again, and
    // the sheet outliving it is what there is to animate.
    const dismissed = (wrapper) =>
      wrapper.emitted('update:expanded').at(-1)[0] === false &&
      wrapper.find('.add-form').classes().includes('add-form--closing')

    // The sheet brings its own opaque cover; the desktop blur must not stack a
    // second layer under it.
    it('does not blur behind the sheet', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      expect(wrapper.find('.add-dim').exists()).toBe(false)
    })

    it('is a raised sheet covering the list, sized to the viewport', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')
      expect(wrapper.find('.add-cover').exists()).toBe(true)
    })

    // Opening it is the parent's to do, and closing it has to be reported back
    // or the bar could never raise it a second time.
    it('reports closing back to whoever opened it', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      await wrapper.find('.back-btn').trigger('click')
      await flushPromises()

      expect(wrapper.emitted('update:expanded').at(-1)).toEqual([false])
    })

    it('sizes the screen to the viewport rather than capping the list', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      await flushPromises()

      // The screen is measured; the list simply fills what is left of it, so
      // nothing caps the rows themselves any more.
      expect(wrapper.find('.add-form').attributes('style')).toMatch(/height:\s*\d+px/)
      expect(wrapper.find('.suggestions').attributes('style')).toBeUndefined()
    })

    it('offers a way out that the keyboard cannot cover', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      const back = wrapper.find('.back-btn')
      expect(back.exists()).toBe(true)

      // Same contract as the option rows: pressing it must not move focus first.
      const event = new Event('mousedown', { bubbles: true, cancelable: true })
      back.element.dispatchEvent(event)
      await flushPromises()

      expect(event.defaultPrevented).toBe(true)
      expect(dismissed(wrapper)).toBe(true)
    })

    // Enter on a focused back button sends click, never mousedown.
    it('also closes from the keyboard', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      await wrapper.find('.back-btn').trigger('click')

      expect(dismissed(wrapper)).toBe(true)
    })

    // The band used to have to vanish the instant the screen did: the field flew
    // home on its own while the band stayed put, so a band outliving it by even
    // a frame took ordinary layout above the field and shoved it back down.
    //
    // Nothing travels alone now — the whole sheet leaves as one object — so the
    // band rides down with it and fades on the way, and the thing to hold onto
    // is that it is still there to do that.
    it('carries the way out down with it rather than dropping it first', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      expect(wrapper.find('.back-btn').exists()).toBe(true)

      await wrapper.find('.back-btn').trigger('click')
      await flushPromises()

      expect(dismissed(wrapper)).toBe(true)
      expect(wrapper.find('.add-head__bar').exists()).toBe(true)
    })

    // The row used to open with a stepper in front of the field, asking how many
    // before anything had said of what — and it could never be corrected once the
    // item existed. Quantity belongs to the row on the list now.
    it('offers no quantity control at all', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      expect(wrapper.find('.qty-picker').exists()).toBe(false)
      expect(wrapper.findAll('.qty-btn')).toHaveLength(0)
    })

    it('stays open while the add button is pressed', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      // The press must not move focus off the input, or the blur would put the
      // whole screen away mid-flow.
      const event = new Event('mousedown', { bubbles: true, cancelable: true })
      wrapper.find('.add-btn').element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)

      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')
    })

    it('stays open when the add button is pressed', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      const event = new Event('mousedown', { bubbles: true, cancelable: true })
      wrapper.find('.add-btn').element.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')
    })

    // The list is behind the screen, so the tap has no other visible result.
    describe('confirming an add', () => {
      const added = (wrapper) =>
        wrapper.findAll('.suggestion').filter((row) => row.classes().includes('suggestion--added'))

      // The confirmation used to be a band above the results restating the
      // product. It said the same thing twice and said it away from the thing.
      it('marks the row that was tapped, with no band above the list', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })

        expect(wrapper.find('.added-row').exists()).toBe(false)
        expect(added(wrapper)).toHaveLength(1)
        expect(added(wrapper)[0].text()).toContain('Banane 1kg')
      })

      // Two makers' versions of the same product are two rows, and only the one
      // that was added is on the list.
      it('marks by product and maker, not by name alone', async () => {
        const wrapper = await mountSheet({
          suggestions: [
            { name: 'Lapte 1L', maker: 'Napolact' },
            { name: 'Lapte 1L', maker: 'Zuzu' },
          ],
        })
        await wrapper.setProps({ lastAdded: { name: 'Lapte 1L', maker: 'Zuzu' } })

        expect(added(wrapper)).toHaveLength(1)
        expect(added(wrapper)[0].text()).toContain('Zuzu')
      })

      it('keeps marking every product added from one search', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })

        // Not just the latest: the results double as a record of what this
        // search has already contributed.
        expect(added(wrapper)).toHaveLength(2)
      })

      // The tick is decoration; the state has to reach the accessible name too.
      it('says so in the option, not only in colour', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })

        expect(added(wrapper)[0].text()).toContain('on your list')
      })

      it('announces it to a screen reader', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        const region = wrapper.find('p.added-announce')

        // The live region has to pre-exist the news for it to be announced.
        expect(region.exists()).toBe(true)
        expect(region.attributes('aria-live')).toBe('polite')

        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        expect(wrapper.find('p.added-announce').text()).toBe('Banane 1kg added to your list')
      })

      // The parent clears lastAdded only when the add did not land after all, so
      // the mark has to come off with it — otherwise a failed add leaves a
      // product ticked as on a list it never reached.
      const lit = (wrapper) =>
        wrapper
          .findAll('.suggestion')
          .filter((row) =>
            row.classes().some((c) => c === 'suggestion--lit-a' || c === 'suggestion--lit-b'),
          )

      const litClass = (wrapper) =>
        lit(wrapper)[0].classes().find((c) => c.startsWith('suggestion--lit-'))

      it('flashes the row that was tapped, and only that row', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })

        expect(lit(wrapper)).toHaveLength(1)
        expect(lit(wrapper)[0].text()).toContain('Banane 1kg')
      })

      // Adding three of something is three taps on one row, and each one has to
      // be visible. The row is already wearing the flash class by the second tap,
      // so re-applying it would change nothing in the DOM and the animation would
      // never restart — hence two rules that differ only in name.
      it('flashes again on every further tap of the same row', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })

        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        const first = litClass(wrapper)

        // A fresh object each time, exactly as reportAdded sends it.
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        const second = litClass(wrapper)

        expect(second).not.toBe(first)
        expect(lit(wrapper)).toHaveLength(1)

        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        expect(litClass(wrapper)).toBe(first)
      })

      // Tapping a row again adds another of that product. The flash says a tap
      // landed; the counter says how many, thrown off the spot that was pressed.
      const tapRow = (wrapper, index) =>
        wrapper.findAll('.suggestion')[index].trigger('mousedown', {
          clientX: 120,
          clientY: 200,
        })

      it('says nothing on the first tap, where one is just one', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await tapRow(wrapper, 0)

        expect(wrapper.findAll('.pop')).toHaveLength(0)
        expect(wrapper.emitted('select')).toHaveLength(1)
      })

      it('counts each further tap of the same row', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await tapRow(wrapper, 0)
        await tapRow(wrapper, 0)
        expect(wrapper.findAll('.pop').map((p) => p.text())).toEqual(['x2'])

        await tapRow(wrapper, 0)
        expect(wrapper.findAll('.pop').map((p) => p.text())).toEqual(['x2', 'x3'])
      })

      // Each one lands somewhere of its own: three in the same place would read
      // as one badge being replaced, which is what the count exists to disprove.
      it('throws them in scattered directions', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        for (let i = 0; i < 6; i++) await tapRow(wrapper, 0)

        const drifts = wrapper.findAll('.pop').map((p) => p.attributes('style'))
        expect(drifts).toHaveLength(5)
        expect(new Set(drifts).size).toBeGreaterThan(1)
      })

      it('counts each product separately', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await tapRow(wrapper, 0)
        await tapRow(wrapper, 0)
        await tapRow(wrapper, 1)

        // The second row is still on its first tap.
        expect(wrapper.findAll('.pop').map((p) => p.text())).toEqual(['x2'])
      })

      // Decorative: the count is already in the row's tick and the announcement.
      it('keeps the counters out of the reader and out of the way', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await tapRow(wrapper, 0)
        await tapRow(wrapper, 0)

        expect(wrapper.find('.pop-layer').attributes('aria-hidden')).toBe('true')
      })

      it('takes the mark back when the add turns out to have failed', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        expect(added(wrapper)).toHaveLength(1)

        await wrapper.setProps({ lastAdded: null })
        expect(added(wrapper)).toHaveLength(0)
      })

      it('takes back only the one that failed', async () => {
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })
        await wrapper.setProps({ lastAdded: { name: 'Apa Plata 2L', maker: 'Dorna' } })
        await wrapper.setProps({ lastAdded: null })

        expect(added(wrapper)).toHaveLength(1)
        expect(added(wrapper)[0].text()).toContain('Banane 1kg')
      })

      // The band was phone-only: on a wider screen the list is in plain sight
      // below the dropdown, so a notice about it was redundant. A mark on the
      // row is not a notice — it is the row's own state, and it is worth just as
      // much here.
      it('marks the row on a wider screen too, where the band never showed', async () => {
        stubViewport(false)
        const wrapper = await mountSheet({ suggestions: PRODUCTS })
        await wrapper.setProps({ lastAdded: { name: 'Banane 1kg', maker: null } })

        expect(wrapper.find('.added-row').exists()).toBe(false)
        expect(added(wrapper)).toHaveLength(1)
      })
    })

    it('opens on what the list buys before anything is typed', async () => {
      const wrapper = await mountSheet({ name: '', suggestions: [], recents: RECENTS })

      expect(wrapper.find('.suggestions-label').text()).toBe('Buy again')
      expect(wrapper.findAll('.suggestion-name').map((n) => n.text())).toEqual([
        'Paine Alba',
        'Oua M 10 buc',
      ])
    })

    it('drops the usuals the moment there is a query to answer', async () => {
      const wrapper = await mountSheet({ name: 'apa', suggestions: PRODUCTS, recents: RECENTS })

      expect(wrapper.find('.suggestions-label').exists()).toBe(false)
      expect(wrapper.findAll('.suggestion-name').map((n) => n.text())).toEqual([
        'Apa Plata 2L',
        'Banane 1kg',
      ])
    })

    it('tells a list with no history what to do with the empty screen', async () => {
      const wrapper = await mountSheet({ name: '', suggestions: [], recents: [] })

      expect(wrapper.find('.suggestions-hint').text()).toBe('Type a product name to search.')
      expect(wrapper.find('.suggestions-label').exists()).toBe(false)
    })

    // An empty focused field on the desktop column is the same "what do we
    // usually get" moment as the phone sheet; it used to show nothing at all.
    it('offers the usuals under the desktop field too', async () => {
      stubViewport(false)
      const wrapper = await mountForm({ name: '', suggestions: [], recents: RECENTS })

      expect(wrapper.find('.suggestions-label').exists()).toBe(true)
    })

    // The slot froze its own height while the form was lifted out of it, so the
    // list below could not jump up into the gap. There is no gap now: below the
    // bar boundary the form has no place in the flow to leave.
    it('takes up no room in the list it covers', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      expect(wrapper.find('.add-slot').attributes('style')).toBeUndefined()
      expect(wrapper.find('.add-slot').classes()).toContain('add-slot--open')
    })

    // A sheet raised on purpose is dismissed on purpose. Losing focus is not
    // that: anything unfocusable inside the screen — the shop-filter chips, the
    // gap under a short list, a scroll begun on the padding — took the keyboard
    // down, and used to take the screen and whatever had been typed with it.
    it('stays up when the field loses focus, keyboard and all', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      await wrapper.find('input').trigger('blur')
      await flushPromises()

      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')
      expect(wrapper.find('.add-form').classes()).not.toContain('add-form--closing')
      expect(wrapper.emitted('update:expanded')).toBeUndefined()
    })

    // The results are the screen's body, not a dropdown hanging off a focused
    // field, so a dropped keyboard must not empty them.
    it('keeps the results up with the keyboard gone', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      await wrapper.find('input').trigger('blur')
      await flushPromises()

      expect(wrapper.find('.suggestions-wrap').exists()).toBe(true)
      expect(wrapper.findAll('.suggestion-name')).toHaveLength(2)
    })

    it('puts the form back on Escape', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })
      await wrapper.find('input').trigger('keydown.esc')

      expect(dismissed(wrapper)).toBe(true)
    })

    // The cover is the surface the sheet sits on, not a dismissal target. On a
    // phone it is the whole screen, so a stray tap on it closing the search was
    // the largest misclick target in the app.
    it('does not close when the surface behind it is pressed', async () => {
      const wrapper = await mountSheet({ suggestions: PRODUCTS })

      const event = new Event('mousedown', { bubbles: true, cancelable: true })
      wrapper.find('.add-cover').element.dispatchEvent(event)
      await flushPromises()

      expect(wrapper.find('.add-form').classes()).toContain('add-form--expanded')
      expect(wrapper.emitted('update:expanded')).toBeUndefined()
    })

    it('leaves a wider screen entirely alone', async () => {
      stubViewport(false)
      const wrapper = await mountForm({ suggestions: PRODUCTS })

      expect(wrapper.find('.add-form').classes()).not.toContain('add-form--expanded')
      expect(wrapper.find('.add-cover').exists()).toBe(false)
      expect(wrapper.find('.suggestions').attributes('style')).toBeUndefined()
    })
  })
})

// The input carries role="combobox" and the rows carry role="option", which is
// a promise that Down/Up walk the list and aria-activedescendant says where you
// are. These cover that promise being kept.
describe('AddItemForm keyboard navigation', () => {
  const input = (wrapper) => wrapper.find('input')
  const active = (wrapper) => wrapper.find('.suggestion--active')

  it('opens on the first option with Down and reports it as the active descendant', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    expect(input(wrapper).attributes('aria-activedescendant')).toBeUndefined()

    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })

    const first = wrapper.findAll('.suggestion')[0]
    expect(active(wrapper).text()).toContain('Apa Plata 2L')
    expect(input(wrapper).attributes('aria-activedescendant')).toBe(first.attributes('id'))
    expect(first.attributes('aria-selected')).toBe('true')
  })

  it('opens on the last option with Up, so either key gets you in', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await input(wrapper).trigger('keydown', { key: 'ArrowUp' })
    expect(active(wrapper).text()).toContain('Banane 1kg')
  })

  it('wraps around both ends rather than dead-ending', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    expect(active(wrapper).text()).toContain('Banane 1kg')

    // Past the last row, back to the first.
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    expect(active(wrapper).text()).toContain('Apa Plata 2L')
  })

  it('walks onto the add-your-own hatch, which is an option like any other', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS, canAddCustom: true })
    // Down from nothing lands on the first option; the hatch is the last, so it
    // takes one press per product and one more.
    for (let i = 0; i < PRODUCTS.length + 1; i++) {
      await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    }
    expect(hatch(wrapper).classes()).toContain('suggestion--active')

    await input(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('add-custom')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('commits the highlighted row on Enter instead of submitting the typed text', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await input(wrapper).trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('select')[0][0]).toMatchObject({ name: 'Apa Plata 2L' })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('leaves Enter alone when nothing is highlighted, so the typed text still submits', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await input(wrapper).trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('select')).toBeUndefined()
    // The form's own submit handler owns this case; the key was not swallowed.
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('drops the highlight when a new set of matches arrives', async () => {
    const wrapper = await mountForm({ suggestions: PRODUCTS })
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    expect(active(wrapper).exists()).toBe(true)

    // A later keystroke's results replace the ones that were being walked.
    await wrapper.setProps({ suggestions: [{ name: 'Apa Minerala', maker: null }] })
    expect(active(wrapper).exists()).toBe(false)
    expect(input(wrapper).attributes('aria-activedescendant')).toBeUndefined()
  })
})
