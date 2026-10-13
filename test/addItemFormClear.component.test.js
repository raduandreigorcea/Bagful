// @vitest-environment happy-dom
//
// The wipe button in the add field. Typing a long product name and wanting to start
// again meant holding backspace; this puts one tap in the field, left of the green
// button. What would regress silently: the button showing on an empty field (a dead
// control), the tap dropping the keyboard (it must keep focus so the next word can be
// typed at once), or the green button staying on Add after the field is emptied
// instead of going back to the scanner.
import { describe, it, expect, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AddItemForm from '../src/components/AddItemForm.vue'

let wrapper = null

function mountForm(props = {}) {
  // Attached, so focus() has a document to move focus within.
  wrapper = mount(AddItemForm, { props: { suggestions: [], canScan: true, ...props }, attachTo: document.body })
  return wrapper
}

afterEach(() => {
  if (wrapper) wrapper.unmount()
  wrapper = null
})

describe('the clear button in the add field', () => {
  it('is not there while the field is empty', () => {
    mountForm({ name: '' })
    expect(wrapper.find('.add-clear').exists()).toBe(false)
  })

  it('appears as soon as there is text', () => {
    mountForm({ name: 'lapte' })
    expect(wrapper.find('.add-clear').exists()).toBe(true)
  })

  it('empties the field and tells the parent', async () => {
    mountForm({ name: 'lapte' })
    await wrapper.find('.add-clear').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:name').at(-1)).toEqual([''])
    expect(wrapper.find('input').element.value).toBe('')
    expect(wrapper.find('.add-clear').exists()).toBe(false)
  })

  it('keeps focus on the field, so the keyboard stays up', async () => {
    mountForm({ name: 'lapte' })
    await wrapper.find('.add-clear').trigger('click')

    expect(document.activeElement).toBe(wrapper.find('input').element)
  })

  it('hands the green button back to scanning', async () => {
    mountForm({ name: 'lapte' })
    const action = () => wrapper.find('.add-btn').attributes('aria-label')
    const typing = action()

    await wrapper.find('.add-clear').trigger('click')
    await flushPromises()

    expect(action()).not.toBe(typing)
  })

  it('has a label for screen readers', () => {
    mountForm({ name: 'lapte' })
    expect(wrapper.find('.add-clear').attributes('aria-label')).toBeTruthy()
  })
})
