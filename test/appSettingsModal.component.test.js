// @vitest-environment happy-dom
//
// Appearance and notifications moved out of the account dialog into App
// Settings, because they are settings for the app on this device rather than
// for the person signed in. The logic came across unchanged, so what these pin
// is that it still works from its new home — and in particular that the theme
// is still applied on mount, not only when the dialog is opened. The component
// stays mounted inside the topbar precisely so that boot-time apply happens.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppSettingsModal from '../src/components/AppSettingsModal.vue'

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ userId: ref('user-1'), getToken: ref(async () => 't') }) }
})

const push = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn() }))
vi.mock('../src/lib/pushNotifications', async (importOriginal) => ({
  ...(await importOriginal()),
  enablePushNotifications: push.enable,
  disablePushNotifications: push.disable,
}))

const wrappers = []
function mountModal(open = true) {
  const w = mount(AppSettingsModal, { global: { stubs: { AppModal: false } }, props: { open } })
  wrappers.push(w)
  return w
}

const themeButtons = (w) => w.findAll('.segmented').at(0).findAll('.segmented__btn')

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  push.enable.mockReset().mockResolvedValue('ok')
  push.disable.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('appearance', () => {
  it('applies and persists the chosen theme', async () => {
    const wrapper = mountModal()
    await themeButtons(wrapper)[0].trigger('click') // Light

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('bagful-theme')).toBe('light')

    await themeButtons(wrapper)[1].trigger('click') // Dark
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('bagful-theme')).toBe('dark')
  })

  it('marks the active choice, and only that one', async () => {
    const wrapper = mountModal()
    await themeButtons(wrapper)[1].trigger('click')

    const active = themeButtons(wrapper).filter((b) =>
      b.classes().includes('segmented__btn--active'),
    )
    expect(active).toHaveLength(1)
    expect(active[0].text()).toContain('Dark')
  })

  // The reason this component is mounted eagerly rather than lazily: a saved
  // theme has to be on the document from boot, not from the first time someone
  // opens this dialog.
  it('applies the saved theme on mount, before it is ever opened', () => {
    localStorage.setItem('bagful-theme', 'dark')
    mountModal(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('resolves "system" from the OS preference rather than storing a colour', async () => {
    const wrapper = mountModal()
    await themeButtons(wrapper)[2].trigger('click') // System

    expect(localStorage.getItem('bagful-theme')).toBe('system')
    // happy-dom reports no dark preference, so system resolves to light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('notifications', () => {
  const notifyButtons = (w) => w.findAll('.segmented').at(1).findAll('.segmented__btn')

  // nextTick because the sync happens in onMounted, which lands after the first
  // render — the initial paint shows the ref's default and is corrected on the
  // next flush. Invisible in the app, since the dialog is mounted closed and
  // re-syncs when it opens.
  it('shows Off when the user has never opted in', async () => {
    const wrapper = mountModal()
    await wrapper.vm.$nextTick()

    const active = notifyButtons(wrapper).filter((b) =>
      b.classes().includes('segmented__btn--active'),
    )
    expect(active).toHaveLength(1)
    expect(active[0].text()).toContain('Off')
  })

  it('falls back to Off when the browser refuses permission', async () => {
    push.enable.mockResolvedValue('permission-denied')
    const wrapper = mountModal()

    await notifyButtons(wrapper)[0].trigger('click') // On
    await new Promise((r) => setTimeout(r, 0))

    // The toggle must reflect reality rather than claim a subscription that
    // does not exist.
    const active = notifyButtons(wrapper).filter((b) =>
      b.classes().includes('segmented__btn--active'),
    )
    expect(active[0].text()).toContain('Off')
    expect(wrapper.text()).not.toBe('')
  })
})
