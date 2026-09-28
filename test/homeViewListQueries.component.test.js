// @vitest-environment happy-dom
//
// The list emoji arrived in 003_lists_and_members.sql, but the client kept reading it
// through two "the column might not be migrated yet" fallbacks: a second
// `lists` select per loadListHeader(), and an UNFILTERED `lists` select
// per loadLists(). loadListHeader runs on init, on focus, on reconnect, on
// every realtime list/member event and on every 30s watchdog tick while the
// socket is down — so the spare round trip was paid over and over for a column
// that has been there all along.
//
// These pin the query shape rather than the feature: the emoji still has to
// arrive, and it has to arrive inside the queries that were already being made.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import AppNavBar from '../src/components/AppNavBar.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { markTourSeen } from '../src/lib/onboarding'
import { __setOnlineForTest } from '../src/lib/connectivity'

const mocks = vi.hoisted(() => ({ db: null, userId: null, isLoaded: null, captured: [] }))

vi.mock('../src/lib/errorReporting', async (importOriginal) => ({
  ...(await importOriginal()),
  captureException: (error) => mocks.captured.push(error),
}))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => mocks.catalogDb ?? null,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('../src/lib/listRealtime', () => ({
  useListRealtime: () => ({
    realtimeHealthy: { value: false },
    setupRealtimeSubscriptions: async () => {},
    cleanupRealtimeSubscriptions: () => {},
  }),
}))

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  mocks.userId = ref('user-1')
  mocks.isLoaded = ref(true)
  return {
    useAuth: () => ({ userId: mocks.userId, isLoaded: mocks.isLoaded, getToken: ref(async () => 't') }),
    useUser: () => ({ user: ref(null) }),
  }
})

const wrappers = []

// One list, carrying an emoji, reachable only through the queries the view is
// allowed to make.
function seedHandlers(db) {
  db.handlers['profiles.upsert'] = () => ({ data: null, error: null })
  db.handlers['list_members.select'] = (q) =>
    q.filters.user_id
      ? // loadLists: the membership list, with the list embedded.
        { data: [{ list_id: 'fam-1', lists: { name: 'Gorcea', emoji: '🏠' } }], error: null }
      : // loadListHeader: the roster for the active list.
        { data: [{ user_id: 'user-1', role: 'moderator', profiles: { display_name: 'Radu' } }], error: null }
  db.handlers['lists.select'] = () => ({
    data: {
      name: 'Gorcea',
      invite_code: 'ABCD2345',
      created_by: 'user-1',
      max_items_per_member: 50,
      emoji: '🏠',
    },
    error: null,
  })
  db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
  db.handlers['purchase_history.select'] = () => ({ data: [], error: null })
}

const listSelects = (db) => db.calls.filter((c) => c.table === 'lists' && c.op === 'select')

beforeEach(() => {
  localStorage.clear()
  markTourSeen(localStorage)
  mocks.db = createFakeDb()
  seedHandlers(mocks.db)
  mocks.userId.value = 'user-1'
  mocks.isLoaded.value = true
  __setOnlineForTest(true)
  mocks.captured.length = 0
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
  vi.restoreAllMocks()
})

async function bootHome() {
  const wrapper = mount(HomeView, { shallow: true })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('the list header and switcher queries', () => {
  it('reads the active list exactly once, emoji included', async () => {
    const db = mocks.db
    await bootHome()

    const selects = listSelects(db)
    expect(selects).toHaveLength(1)
    expect(selects[0].columns).toContain('emoji')
  })

  it('never selects lists unfiltered', async () => {
    const db = mocks.db
    await bootHome()

    // An unfiltered select leans entirely on RLS to scope the result; every
    // read here names the list it wants.
    for (const call of listSelects(db)) {
      expect(call.filters.id).toBeTruthy()
    }
  })

  it('brings the switcher emoji back through the membership embed', async () => {
    const db = mocks.db
    await bootHome()

    const membership = db.calls.find(
      (c) => c.table === 'list_members' && c.op === 'select' && c.filters.user_id,
    )
    expect(membership.columns).toBe('list_id, lists(name, emoji)')
  })

  it('still surfaces the emoji to the topbar', async () => {
    const wrapper = await bootHome()

    const topbar = wrapper.findComponent(AppNavBar)
    expect(topbar.props('listEmoji')).toBe('🏠')
    expect(topbar.props('lists')[0].emoji).toBe('🏠')
  })

  // Found by the bot swarm: every member removed from a list, and everyone
  // with a list open when it was deleted, filed a Sentry report. Their next
  // header read finds no row, because the list is no longer theirs to see;
  // that is the removal itself, which the members channel already acts on.
  it('does not report the list header vanishing, but does report a real failure', async () => {
    const wrapper = await bootHome()

    mocks.db.handlers['lists.select'] = () => ({
      data: null,
      error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object', details: 'The result contains 0 rows' },
    })
    await wrapper.vm.loadListHeader()
    expect(mocks.captured).toHaveLength(0)

    mocks.db.handlers['lists.select'] = () => ({ data: null, error: { code: '500', message: 'boom' } })
    await wrapper.vm.loadListHeader()
    expect(mocks.captured).toHaveLength(1)
  })
})
