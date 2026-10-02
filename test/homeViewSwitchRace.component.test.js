// @vitest-environment happy-dom
//
// Switching list twice in quick succession.
//
// Every list-scoped loader reads listId.value when it builds its
// query and then assigns the answer unconditionally when it comes back. Nothing
// in between checks that the list it was asked about is still the one on
// screen, so two overlapping loads settle in completion order rather than in
// call order — and the slower, older one wins.
//
// The suggestions composable already solved exactly this for its own fetches
// (suggestRequestId in lib/productSuggestions.ts). The list loaders were
// never given the same treatment, which is what these pin.
//
// It is not only a double tap. loadListHeader also runs from the reconnect
// handler, from each realtime subscribe acknowledgement, and from the watchdog
// every 30 seconds while the socket is down — so a refresh already in flight for
// the list being left is the ordinary case, not a contrived one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import AppNavBar from '../src/components/AppNavBar.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { markTourSeen } from '../src/lib/onboarding'
import { __setOnlineForTest } from '../src/lib/connectivity'

const mocks = vi.hoisted(() => ({ db: null, userId: null, isLoaded: null }))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => null,
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

// A promise whose resolution this test controls, so one list's answer can
// be held open across another list's whole round trip.
function deferred() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const NAMES = { 'fam-1': 'One', 'fam-2': 'Two', 'fam-3': 'Three' }

// Three lists, and a per-list gate on the `lists` read so the
// test can decide which answer lands first.
function seedHandlers(db, gates) {
  db.handlers['profiles.upsert'] = () => ({ data: null, error: null })
  db.handlers['list_members.select'] = (q) =>
    q.filters.user_id
      ? {
          data: Object.keys(NAMES).map((id) => ({
            list_id: id,
            lists: { name: NAMES[id], emoji: '' },
          })),
          error: null,
        }
      : { data: [{ user_id: 'user-1', role: 'owner', profiles: { display_name: 'Radu' } }], error: null }

  db.handlers['lists.select'] = (q) => {
    const id = q.filters.id
    const answer = {
      data: {
        name: NAMES[id],
        invite_code: 'ABCD2345',
        created_by: 'user-1',
        max_items_per_member: 50,
        emoji: '',
      },
      error: null,
    }
    const gate = gates[id]
    return gate ? gate.promise.then(() => answer) : answer
  }

  // One row per list, so an answer can be told apart by what came back.
  db.handlers['shopping_list_items.select'] = (q) => {
    const id = q.filters.list_id
    const answer = {
      data: q.filters.checked
        ? []
        : [
            {
              id: `item-${id}`,
              list_id: id,
              name: `${NAMES[id]} milk`,
              quantity: 1,
              checked: false,
              created_at: '2026-01-01T00:00:00.000Z',
              added_by: 'user-1',
            },
          ],
      error: null,
    }
    const gate = itemGates[id]
    return gate ? gate.promise.then(() => answer) : answer
  }
  db.handlers['purchase_history.select'] = () => ({ data: [], error: null })
}

let gates
let itemGates

beforeEach(() => {
  localStorage.clear()
  markTourSeen(localStorage)
  gates = {}
  itemGates = {}
  mocks.db = createFakeDb()
  seedHandlers(mocks.db, gates)
  mocks.userId.value = 'user-1'
  mocks.isLoaded.value = true
  __setOnlineForTest(true)
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

describe('switching list while a load for the previous one is still in flight', () => {
  it('does not let the abandoned list header paint over the current one', async () => {
    const wrapper = await bootHome()
    const navBar = wrapper.findComponent(AppNavBar)
    expect(navBar.props('listName')).toBe('One')

    // fam-2's header is held open; fam-3's answers immediately.
    gates['fam-2'] = deferred()

    navBar.vm.$emit('switch-list', 'fam-2')
    await Promise.resolve()
    navBar.vm.$emit('switch-list', 'fam-3')
    await flushPromises()

    // fam-3 is the list on screen and its header has landed.
    expect(navBar.props('listId')).toBe('fam-3')
    expect(navBar.props('listName')).toBe('Three')

    // Now the abandoned fam-2 read comes home. It must be discarded: the user
    // is looking at fam-3.
    gates['fam-2'].release()
    await flushPromises()

    expect(navBar.props('listId')).toBe('fam-3')
    expect(navBar.props('listName')).toBe('Three')
  })

  it('does not let the abandoned list paint over the current one', async () => {
    const wrapper = await bootHome()
    const navBar = wrapper.findComponent(AppNavBar)
    const shoppingList = wrapper.findComponent({ name: 'ShoppingList' })
    expect(shoppingList.props('items').map((i) => i.name)).toEqual(['One milk'])

    // Not a second tap this time. The reconnect handler re-reads the list for
    // the list that is current when it starts, and that read is what the
    // switch below overtakes — the same thing the watchdog does every 30
    // seconds while the socket is down.
    itemGates['fam-1'] = deferred()
    window.dispatchEvent(new Event('online'))
    await flushPromises()

    // The reconnect read for fam-1 is now on the wire and held there.
    navBar.vm.$emit('switch-list', 'fam-3')
    await flushPromises()
    expect(shoppingList.props('items').map((i) => i.name)).toEqual(['Three milk'])

    // fam-1's rows belong to a list the user has left. Showing them under
    // fam-3's name is the cross-list mixing the whole RLS design exists to
    // prevent, arriving from the client side instead.
    itemGates['fam-1'].release()
    await flushPromises()

    expect(shoppingList.props('items').map((i) => i.name)).toEqual(['Three milk'])
  })
})

// A stepper tap waits out a short window before it is sent. Switching inside
// that window cleared the list before the send looked the row up, so the tap
// found no row and was dropped: the number went back up on the next visit.
describe('switching list with a quantity tap still waiting to be sent', () => {
  it('sends the tap for the list being left', async () => {
    const wrapper = await bootHome()
    mocks.db.handlers['rpc.add_item_quantity'] = () => ({ data: null, error: null })
    const shoppingList = wrapper.findComponent({ name: 'ShoppingList' })
    const row = shoppingList.props('items')[0]

    shoppingList.vm.$emit('set-quantity', { item: row, quantity: 4 })
    await flushPromises()
    wrapper.findComponent(AppNavBar).vm.$emit('switch-list', 'fam-2')
    await flushPromises()

    const update = mocks.db.calls.find((q) => q.op === 'add_item_quantity')
    expect(update?.params).toEqual({ p_id: 'item-fam-1', p_delta: 3 })
  })
})
