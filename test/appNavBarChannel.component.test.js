// @vitest-environment happy-dom
//
// The nightly build has to announce itself. Production must not: the badge is
// only meaningful if its absence means something.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import AppNavBar from '../src/components/AppNavBar.vue'

const channel = vi.hoisted(() => ({ nightly: false }))

vi.mock('../src/lib/appChannel', async (importOriginal) => ({
  ...(await importOriginal()),
  // A getter, not a value: the component reads the binding on every render, so
  // one mocked module serves both cases.
  get IS_NIGHTLY() {
    return channel.nightly
  },
}))

vi.mock('@clerk/vue', () => ({
  useUser: () => ({ user: ref(null) }),
  useClerk: () => ref({ openUserProfile: vi.fn(), signOut: vi.fn() }),
  useAuth: () => ({ userId: ref(null), getToken: ref(async () => null) }),
}))

vi.mock('../src/supabase', () => ({
  useSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
  getCatalogSupabase: () => null,
}))

vi.mock('../src/lib/errorReporting', () => ({
  captureException: vi.fn(),
  identifyUser: vi.fn(),
}))

const wrappers = []
function mountHeader() {
  const w = mount(AppNavBar, { props: { listName: 'Home' } })
  wrappers.push(w)
  return w
}

function mountBar() {
  const w = mount(AppNavBar, { props: { layout: 'bar', listName: 'Home' } })
  wrappers.push(w)
  return w
}

beforeEach(() => {
  channel.nightly = false
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('AppNavBar channel badge', () => {
  it('shows nothing on a production build', () => {
    expect(mountHeader().find('.channel-badge').exists()).toBe(false)
  })

  it('marks a nightly build in the header', () => {
    channel.nightly = true
    const badge = mountHeader().find('.channel-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('NIGHTLY')
  })

  // The stamp is pinned to the top edge by CSS; what must not come back is the old ribbon over the list.
  it('no longer floats a ribbon over the list', () => {
    channel.nightly = true
    expect(mountBar().find('.channel-ribbon').exists()).toBe(false)
  })
})
