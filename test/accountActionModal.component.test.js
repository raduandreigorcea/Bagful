// @vitest-environment happy-dom
//
// The identity card is the way to the profile screen. It used to be a passive
// block of name and email sitting above a "Profile" row hinted "Name, photo,
// password" — two elements for one idea, since the card was already showing the
// name and the photo the row offered to change. The row is gone and the card
// carries the action.
//
// Worth pinning because the merge moved an emit onto an element that had never
// been a control: nothing else in the app opens AccountProfileModal, so if the
// card stops emitting, editing your profile becomes unreachable rather than
// merely awkward.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AccountActionModal from '../src/components/AccountActionModal.vue'

function mountModal(props = {}) {
  return mount(AccountActionModal, {
    global: { stubs: { AppModal: false } },
    props: {
      open: true,
      displayName: 'Radu',
      email: 'radu@example.com',
      initial: 'R',
      ...props,
    },
  })
}

const card = (w) => w.find('.account-user-card')

describe('AccountActionModal identity card', () => {
  it('opens the profile when the card is pressed', async () => {
    const wrapper = mountModal()
    await card(wrapper).trigger('click')
    expect(wrapper.emitted('edit-account')).toHaveLength(1)
  })

  it('is a real button, so Enter and Space reach it and focus lands on it', () => {
    expect(card(mountModal()).element.tagName).toBe('BUTTON')
  })

  // The card shows a name and an email, which describe the person rather than
  // what pressing does. Without an explicit label a screen reader announces
  // "Radu radu@example.com, button" and never says where it goes.
  it('names the action for screen readers, not the person', () => {
    expect(card(mountModal()).attributes('aria-label')).toBe(
      'Edit your profile: name, photo, delete account',
    )
  })

  // The avatar sits inside the labelled button, so announcing it again would
  // only pad the label.
  it('leaves the avatar out of the accessible name', () => {
    const wrapper = mountModal({ avatarUrl: 'https://example.test/a.png' })
    expect(wrapper.find('.account-user-card__avatar').attributes('alt')).toBe('')
  })

  it('still shows who is signed in', () => {
    const wrapper = mountModal()
    expect(wrapper.find('.account-user-card__identity h4').text()).toBe('Radu')
    expect(wrapper.find('.account-user-card__identity p').text()).toBe('radu@example.com')
  })

  it('says so rather than showing a blank line when there is no email', () => {
    const wrapper = mountModal({ email: '' })
    expect(wrapper.find('.account-user-card__identity p').text()).toBe('No email available')
  })

  // The row the card replaced. Its absence is the space saved, so it is the
  // thing a regression would quietly restore.
  it('no longer carries a separate Profile row', () => {
    const labels = mountModal()
      .findAll('.account-menu-item__label')
      .map((el) => el.text())
    expect(labels).not.toContain('Profile')
  })
})

// The list is not here at all: its members, the invite, switching and
// its settings are the sheet the list name opens. This dialog is about the
// person and the device.
describe('AccountActionModal and the list', () => {
  const labels = (w) => w.findAll('.account-menu-item__label').map((el) => el.text())

  it('carries no list rows', () => {
    const shown = labels(mountModal())
    expect(shown.some((l) => l.includes('Manage list'))).toBe(false)
    expect(shown.some((l) => l.includes('Invite people'))).toBe(false)
  })

  it('keeps the rows about you and this device', () => {
    const shown = labels(mountModal())
    expect(shown.some((l) => l.includes('App settings'))).toBe(true)
    expect(shown.some((l) => l.includes('Report'))).toBe(true)
    expect(shown.some((l) => l.includes('Sign out'))).toBe(true)
  })
})
