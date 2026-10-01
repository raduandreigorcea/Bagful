// @vitest-environment happy-dom
//
// A boot whose first read fails with a server error (not "offline") never
// finished, and nothing ran it again: the reconnect handler skips an unbooted
// view and the error could only be dismissed. The app sat empty until killed.
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import ErrorModal from '../src/components/ErrorModal.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { __setOnlineForTest } from '../src/lib/connectivity'
import { markTourSeen } from '../src/lib/onboarding'
import { t } from '../src/lib/i18n'

const mocks = vi.hoisted(() => ({ db: null }))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => null,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
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
    useAuth: () => ({ userId: ref('user-1'), isLoaded: ref(true), getToken: ref(async () => 'token') }),
    useUser: () => ({ user: ref({ fullName: 'Test User', imageUrl: null }) }),
  }
})

let wrapper
let listsDown

beforeEach(() => {
  localStorage.clear()
  markTourSeen(localStorage)
  __setOnlineForTest(true)
  listsDown = true
  mocks.db = createFakeDb()
  mocks.db.handlers['list_members.select'] = (q) => {
    if (!q.filters.user_id) {
      return { data: [{ user_id: 'user-1', role: 'moderator', profiles: { display_name: 'Test User' } }], error: null }
    }
    return listsDown
      ? { data: null, error: { code: 'PGRST000', message: 'server unavailable' } }
      : { data: [{ list_id: 'fam-1', lists: { name: 'Fam' } }], error: null }
  }
  mocks.db.handlers['lists.select'] = () => ({
    data: { name: 'Fam', invite_code: 'ABCDEFGH', created_by: 'user-1', max_items_per_member: 50 },
    error: null,
  })
  mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
  mocks.db.handlers['purchase_history.select'] = () => ({ data: [], error: null })
})

afterEach(() => {
  wrapper?.unmount()
  __setOnlineForTest(null)
})

const itemReads = () =>
  mocks.db.calls.filter((c) => c.table === 'shopping_list_items' && c.op === 'select').length

async function bootIntoFailure() {
  wrapper = mount(HomeView, { shallow: true })
  await flushPromises()
  await flushPromises()
  expect(wrapper.findComponent(ErrorModal).props('message')).toBe(t('error.loadListsFailed'))
  expect(itemReads()).toBe(0)
  listsDown = false
}

it('tries the boot again when the error is dismissed', async () => {
  await bootIntoFailure()

  wrapper.findComponent(ErrorModal).vm.$emit('dismiss')
  await flushPromises()
  await flushPromises()

  expect(itemReads()).toBeGreaterThan(0)
  expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
})

it('tries the boot again on reconnect', async () => {
  await bootIntoFailure()

  __setOnlineForTest(false)
  window.dispatchEvent(new Event('online'))
  __setOnlineForTest(true)
  await flushPromises()
  await flushPromises()

  expect(itemReads()).toBeGreaterThan(0)
})
