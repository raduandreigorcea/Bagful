// @vitest-environment happy-dom
//
// The session-replay switch is only offered where analytics can send anything.
// On the dev server, a build with no key, or a nightly without its own key,
// PostHog is never started, so a switch there would promise a recording that
// cannot happen.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AppSettingsModal from '../src/components/AppSettingsModal.vue'

const analytics = vi.hoisted(() => ({ available: true }))

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ userId: ref('user-1') }) }
})

vi.mock('../src/lib/pushNotifications', () => ({
  enablePushNotifications: vi.fn(async () => 'ok'),
  disablePushNotifications: vi.fn(async () => undefined),
  getNotificationPreference: () => null,
  setNotificationPreference: () => {},
  setPushLanguage: vi.fn(async () => undefined),
}))

vi.mock('../src/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal()),
  analyticsAvailable: () => analytics.available,
}))

const replaySwitch = (wrapper) => wrapper.find('[aria-labelledby="app-replay-label"]')

function mountModal() {
  return mount(AppSettingsModal, { global: { stubs: { AppModal: false } }, props: { open: true } })
}

describe('the session replay switch', () => {
  it('is offered where analytics sends events', () => {
    analytics.available = true
    expect(replaySwitch(mountModal()).exists()).toBe(true)
  })

  it('is not offered where analytics sends nothing', () => {
    analytics.available = false
    expect(replaySwitch(mountModal()).exists()).toBe(false)
  })
})
