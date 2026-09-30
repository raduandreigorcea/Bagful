// @vitest-environment happy-dom
//
// "Check for updates", under Settings → About.
//
// It exists because every other route to the update offer is designed to stay
// quiet: the startup check waits out an interval, and Back on the update dialog
// declines that version for good. Without this, changing your mind meant waiting
// for the next release. So the two things worth pinning are that it appears only
// where it can do something, and that finding an update gets the settings
// dialogs out of the way rather than burying the offer under them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppSettingsModal from '../src/components/AppSettingsModal.vue'
import AppButton from '../src/components/AppButton.vue'
import { updateCheckKey } from '../src/lib/updatePrompt'

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ userId: ref('user-1'), getToken: ref(async () => 't') }) }
})

const native = vi.hoisted(() => ({ canSelfUpdate: true }))

vi.mock('../src/lib/nativeUpdate', async (importOriginal) => ({
  ...(await importOriginal()),
  canSelfUpdate: () => native.canSelfUpdate,
}))

const wrappers = []

function mountSettings({ check } = {}) {
  const w = mount(AppSettingsModal, {
    props: { open: true },
    global: {
      stubs: { AppModal: false },
      provide: check ? { [updateCheckKey]: check } : {},
    },
  })
  wrappers.push(w)
  return w
}

// The About dialog is behind a row in the main settings body.
async function openAbout(wrapper) {
  const about = wrapper.findAll('.app-settings__row').find((row) => row.text().includes('About'))
  await about.trigger('click')
  return wrapper
}

const updateButton = (wrapper) =>
  wrapper.findAllComponents(AppButton).find((button) => /Check for updates|Checking/.test(button.text()))

beforeEach(() => {
  localStorage.clear()
  native.canSelfUpdate = true
})

afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
})

describe('Check for updates', () => {
  it('is offered where the app can install its own updates', async () => {
    const wrapper = await openAbout(mountSettings({ check: vi.fn() }))
    expect(updateButton(wrapper)).toBeTruthy()
  })

  it('is absent in a browser, which has nothing to install', async () => {
    // The web app is already replaced behind the user's back by the service
    // worker; a button offering to check would have nothing to offer.
    native.canSelfUpdate = false
    const wrapper = await openAbout(mountSettings({ check: vi.fn() }))
    expect(updateButton(wrapper)).toBeUndefined()
  })

  it('is absent where nothing provided a check to run', async () => {
    // The setup screen mounts the topbar without HomeView above it.
    const wrapper = await openAbout(mountSettings())
    expect(updateButton(wrapper)).toBeUndefined()
  })

  it('says so when there is nothing newer', async () => {
    const wrapper = await openAbout(mountSettings({ check: async () => 'up-to-date' }))
    await updateButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Bagful is up to date')
  })

  it('does not call a failed check a clean bill of health', async () => {
    const wrapper = await openAbout(mountSettings({ check: async () => 'failed' }))
    await updateButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain("Couldn't reach GitHub")
    expect(wrapper.text()).not.toContain('up to date')
  })

  it('gets out of the way when it finds one', async () => {
    // The offer belongs to the view behind these dialogs. Leaving them open
    // would stack it under two overlays.
    const wrapper = await openAbout(mountSettings({ check: async () => 'found' }))
    await updateButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('cannot be run twice at once', async () => {
    let resolve
    const check = vi.fn(() => new Promise((r) => { resolve = r }))
    const wrapper = await openAbout(mountSettings({ check }))

    await updateButton(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    expect(updateButton(wrapper).text()).toContain('Checking')

    await updateButton(wrapper).trigger('click')
    expect(check).toHaveBeenCalledTimes(1)

    resolve('up-to-date')
  })
})
