// @vitest-environment happy-dom
//
// Does the update offer actually reach the screen on a normal boot?
//
// lib/updatePrompt and lib/firstRunGreeting are each covered on their own, but
// nothing covered the seam between them and HomeView -- and the offer only ever
// runs through that seam: the view hands the greeting an onSettled, the greeting
// calls it when it has nothing left to show, and only then does the check run.
// A returning user with the tour seen and notifications answered is the ordinary
// case, and it is the one that has to work.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import UpdateAvailableModal from '../src/components/UpdateAvailableModal.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { __setOnlineForTest } from '../src/lib/connectivity'

const mocks = vi.hoisted(() => ({ db: null, routerReplace: () => {} }))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => mocks.catalogDb ?? null,
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: (...args) => mocks.routerReplace(...args) }),
}))
vi.mock('../src/lib/listRealtime', () => ({
  useListRealtime: () => ({
    realtimeHealthy: { value: false },
    setupRealtimeSubscriptions: async () => {},
    cleanupRealtimeSubscriptions: () => {},
  }),
}))
vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return {
    useAuth: () => ({
      userId: ref('user-1'),
      isLoaded: ref(true),
      getToken: ref(async () => 'token'),
    }),
    useUser: () => ({ user: ref({ fullName: 'Test User', imageUrl: null }) }),
  }
})

// The APK, which is the only build that can install another one over itself.
vi.mock('@capacitor/core', async () => {
  const actual = await vi.importActual('@capacitor/core')
  return {
    ...actual,
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    },
    registerPlugin: () => ({
      canInstall: async () => ({ granted: true }),
      openInstallSettings: async () => {},
      downloadAndInstall: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    }),
  }
})

const RELEASE = {
  name: 'FamCart v9.9.9',
  assets: [{ name: 'FamCart.apk', browser_download_url: 'https://example.test/FamCart.apk' }],
}

const mountedWrappers = []

async function mountHome() {
  mocks.db = createFakeDb()
  mocks.routerReplace = vi.fn()
  mocks.db.handlers['list_members.select'] = (q) =>
    q.filters.user_id
      ? { data: [{ list_id: 'fam-1', lists: { id: 'fam-1', name: 'Fam' } }], error: null }
      : { data: [{ user_id: 'user-1', display_name: 'Test User', image_url: null, role: 'moderator' }], error: null }
  mocks.db.handlers['lists.select'] = () => ({
    data: { name: 'Fam', invite_code: 'ABCDEFGH', created_by: 'user-1', max_items_per_member: 50 },
    error: null,
  })
  mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
  mocks.db.handlers['purchase_history.select'] = () => ({ data: [], error: null })

  const wrapper = mount(HomeView, { shallow: true })
  mountedWrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  await flushPromises()
  return wrapper
}

const offer = (wrapper) => wrapper.findComponent(UpdateAvailableModal)

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  localStorage.clear()
  __setOnlineForTest(true)
  // A returning user: the tour is behind them and the notifications question is
  // answered, so the first-run sequence has nothing to show and settles at once.
  localStorage.setItem('famcart_tour_seen_v4', '1')
  localStorage.setItem('famcart-notifications:user-1', 'off')
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => RELEASE }))
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop().unmount()
  __setOnlineForTest(null)
  vi.restoreAllMocks()
})

describe('the update offer on a normal boot', () => {
  it('asks GitHub whether there is a newer build', async () => {
    await mountHome()

    expect(globalThis.fetch).toHaveBeenCalled()
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/releases/latest')
  })

  it('puts the offer on screen when there is one', async () => {
    const wrapper = await mountHome()

    expect(offer(wrapper).props('open')).toBe(true)
    expect(offer(wrapper).props('version')).toBe('9.9.9')
  })
})
