// @vitest-environment happy-dom
//
// Component tests for HomeView's optimistic mutation paths: the UI updates
// first, and every DB failure mode must either roll back or fold into the
// surviving row. These flows (insert races, 23505 handling, merge-on-uncheck)
// are the riskiest code in the app and regress silently without coverage.
import { dismissToast, triggerToastAction } from '../src/lib/useToast'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import AddItemForm from '../src/components/AddItemForm.vue'
import CustomProductModal from '../src/components/CustomProductModal.vue'
import ShoppingList from '../src/components/ShoppingList.vue'
import AppNavBar from '../src/components/AppNavBar.vue'
import ConfirmModal from '../src/components/ConfirmModal.vue'
import ErrorModal from '../src/components/ErrorModal.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { saveListSnapshot } from '../src/lib/listCache'
import { loadOfflineQueue, enqueueOfflineMutation } from '../src/lib/offlineQueue'
import { __setOnlineForTest } from '../src/lib/connectivity'
import { setLocale } from '../src/lib/i18n'

const mocks = vi.hoisted(() => ({
  db: null,
  routerReplace: () => {},
}))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => mocks.catalogDb ?? null,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: (...args) => mocks.routerReplace(...args) }),
}))

// Realtime lifecycle is owned by its own composable (tested separately); here
// it must simply not interfere.
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
    useUser: () => ({
      user: ref({ fullName: 'Test User', imageUrl: null }),
    }),
  }
})

function makeItem(overrides = {}) {
  return {
    id: overrides.id ?? `item-${Math.random().toString(36).slice(2)}`,
    list_id: 'fam-1',
    name: 'Milk',
    quantity: 1,
    checked: false,
    added_by: 'user-1',
    added_by_name: 'Test User',
    added_by_image_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setDefaultHandlers(db, { items = [], maxItemsPerMember = 50 } = {}) {
  db.handlers['list_members.select'] = (q) =>
    q.filters.user_id
      ? { data: [{ list_id: 'fam-1', lists: { id: 'fam-1', name: 'Fam' } }], error: null }
      : {
          data: [{ user_id: 'user-1', display_name: 'Test User', image_url: null, role: 'moderator' }],
          error: null,
        }
  db.handlers['lists.select'] = () => ({
    data: {
      name: 'Fam',
      invite_code: 'ABCDEFGH',
      created_by: 'user-1',
      max_items_per_member: maxItemsPerMember,
    },
    error: null,
  })
  db.handlers['shopping_list_items.select'] = (q) => ({
    data: items.filter((i) => i.checked === q.filters.checked),
    error: null,
  })
}

const mountedWrappers = []

function trackMount(...args) {
  const wrapper = mount(...args)
  mountedWrappers.push(wrapper)
  return wrapper
}

async function mountHome({ items = [], maxItemsPerMember = 50 } = {}) {
  mocks.db = createFakeDb()
  mocks.routerReplace = vi.fn()
  setDefaultHandlers(mocks.db, { items, maxItemsPerMember })
  const wrapper = trackMount(HomeView, { shallow: true })
  await flushPromises()
  await flushPromises()
  return wrapper
}

function listedItems(wrapper) {
  return wrapper.findComponent(ShoppingList).props('items')
}

// One add is one item. The form no longer carries a quantity — it is set on the
// row afterwards, or reached by adding the same product again, which sums.
async function submitAdd(wrapper, name) {
  const form = wrapper.findComponent(AddItemForm)
  form.vm.$emit('update:name', name)
  await wrapper.vm.$nextTick()
  form.vm.$emit('submit')
  await flushPromises()
}

// The row stepper's write, as HomeView receives it.
// A stepper is held down, not clicked once, so the write waits out a short
// window and taps inside it collapse into one UPDATE. Mirrors
// QUANTITY_WRITE_DEBOUNCE_MS in shoppingListActions.
const QUANTITY_DEBOUNCE_MS = 300

// One tap. Moves the number; does not send anything yet.
async function tapQuantity(wrapper, item, quantity) {
  wrapper.findComponent(ShoppingList).vm.$emit('set-quantity', { item, quantity })
  await flushPromises()
}

// Waits out the window so whatever was tapped actually goes to the server.
async function settleQuantity() {
  await new Promise((resolve) => setTimeout(resolve, QUANTITY_DEBOUNCE_MS + 60))
  await flushPromises()
}

async function setQuantity(wrapper, item, quantity) {
  await tapQuantity(wrapper, item, quantity)
  await settleQuantity()
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // The snapshot cache persists across mounts; isolate each test.
  localStorage.clear()
})

afterEach(() => {
  // Unmount so each HomeView's reconnect handler is removed; a leaked
  // handler from an earlier test would flush the offline queue against that
  // test's stale fake db.
  while (mountedWrappers.length) mountedWrappers.pop().unmount()
  // Reset the connectivity singleton to online (after unmount, so no detached
  // reconnect handler fires) — otherwise an offline test would leak into the
  // next, whose isOffline() would then always report offline.
  __setOnlineForTest(true)
  vi.restoreAllMocks()
})

function goOffline() {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
}

function goOnline() {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
  // The offline-to-online edge, which is what lib/connectivity reports as a
  // reconnect (it folds the browser's own 'online' event into the same signal).
  __setOnlineForTest(false)
  __setOnlineForTest(true)
}

describe('cached snapshot', () => {
  it('paints the cached list instantly while the real fetches are still in flight', async () => {
    saveListSnapshot(localStorage, 'user-1', {
      listId: 'fam-1',
      listName: 'Fam',
      listInviteCode: 'ABCDEFGH',
      listOwnerId: 'user-1',
      listItemLimit: 50,
      listMembers: [{ user_id: 'user-1', display_name: 'Me', image_url: null, role: 'moderator' }],
      items: [makeItem({ id: 'cached-1', name: 'Milk' })],
    })

    mocks.db = createFakeDb()
    mocks.routerReplace = vi.fn()
    // Simulate a cold, slow network: nothing ever resolves.
    const never = () => new Promise(() => {})
    mocks.db.handlers['list_members.select'] = never
    mocks.db.handlers['lists.select'] = never
    mocks.db.handlers['shopping_list_items.select'] = never

    const wrapper = trackMount(HomeView, { shallow: true })
    await flushPromises()

    const list = wrapper.findComponent(ShoppingList)
    expect(list.props('items')).toHaveLength(1)
    expect(list.props('items')[0].id).toBe('cached-1')
    // Hydration must end the skeleton state even though no fetch completed.
    expect(list.props('loading')).toBe(false)
  })
})

// Tapping a suggestion is a complete statement of intent — which product, which
// maker — so it adds straight away instead of filling the input and waiting for
// a confirming tap.
describe('picking a suggestion', () => {
  async function pick(wrapper, product, { typed = '' } = {}) {
    const form = wrapper.findComponent(AddItemForm)
    form.vm.$emit('update:name', typed)
    await wrapper.vm.$nextTick()
    form.vm.$emit('select', product)
    await flushPromises()
  }

  it('adds the product immediately instead of putting it in the input', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await pick(wrapper, { name: 'Apa Plata 2L', maker: 'Dorna' }, { typed: 'apa' })

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Apa Plata 2L')
    // The maker comes from the pick, not from what was typed.
    expect(items[0].maker).toBe('Dorna')
    // The query stays, so the next kind of water is one more tap rather than
    // typing "apa" again. It is a query, not a draft item: nothing added it.
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('apa')
  })

  it('adds the picked product, not the text already in the input', async () => {
    const wrapper = await mountHome()
    const inserted = []
    mocks.db.handlers['shopping_list_items.insert'] = (q) => {
      inserted.push(q.payload)
      return { data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' }, error: null }
    }

    await pick(wrapper, { name: 'Lapte 3.5% 1L', maker: 'Napolact' }, { typed: 'lap' })

    expect(inserted).toHaveLength(1)
    expect(inserted[0].name).toBe('Lapte 3.5% 1L')
  })

  // Every pick lands one. Wanting three is three taps (which sum) or the row's
  // own stepper — never a number chosen before the product was named.
  it('adds one, whatever was picked before it', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await pick(wrapper, { name: 'Banane 1kg', maker: null }, { typed: 'ban' })

    expect(listedItems(wrapper)[0].quantity).toBe(1)
  })

  // The point of keeping the query. "milk" is usually two kinds of milk, and
  // getting the second one used to mean typing the word again.
  it('lets a second product be picked from the same search', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await pick(wrapper, { name: 'Lapte 3.5% 1L', maker: 'Napolact' }, { typed: 'lapte' })
    // No retyping: the field still holds the query, so the second pick is one tap.
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('lapte')
    wrapper.findComponent(AddItemForm).vm.$emit('select', { name: 'Lapte 1.5% 1L', maker: 'Zuzu' })
    await flushPromises()

    // Order is the list's business (creation time); what matters here is that
    // both landed, each keeping the maker from its own pick.
    const byName = new Map(listedItems(wrapper).map((i) => [i.name, i.maker]))
    expect(byName.get('Lapte 3.5% 1L')).toBe('Napolact')
    expect(byName.get('Lapte 1.5% 1L')).toBe('Zuzu')
    expect(byName.size).toBe(2)
  })

  // The maker rides on the pick, and the pick used to be dropped by the query
  // watcher when adding emptied the field. Nothing empties it now, so the add
  // has to spend the pick itself — otherwise typing nothing and pressing Add
  // again puts the QUERY on the list wearing the picked product's maker.
  it('does not leave the picked maker attached to the next typed add', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await pick(wrapper, { name: 'Apa Plata 2L', maker: 'Dorna' }, { typed: 'apa' })
    wrapper.findComponent(AddItemForm).vm.$emit('submit')
    await flushPromises()

    const typed = listedItems(wrapper).find((i) => i.name === 'apa')
    expect(typed).toBeTruthy()
    expect(typed.maker).toBeNull()
  })

  it('merges into the existing active row instead of duplicating it', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Apa Plata 2L', maker: 'Dorna', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await pick(wrapper, { name: 'Apa Plata 2L', maker: 'Dorna' }, { typed: 'apa' })

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(2)
  })

  it('restores the product into the form when the add fails', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { message: 'boom' },
    })

    await pick(wrapper, { name: 'Apa Plata 2L', maker: 'Dorna' }, { typed: 'apa' })

    // Nothing added, and the query is left exactly as typed -- it was never
    // taken away, so there is nothing to put back. The pick itself is restored
    // (below), which is what a retry actually needs.
    expect(listedItems(wrapper)).toHaveLength(0)
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('apa')
  })

  it('says to slow down (not "something went wrong") when the add is rate limited', async () => {
    const wrapper = await mountHome()
    // The hourly item ceiling in 004_shopping_list.sql.
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: {
        code: 'P0001',
        message: 'Too many items added in a short time. Try again shortly.',
        details: 'item_insert_rate_limit_exceeded',
      },
    })

    await pick(wrapper, { name: 'Apa Plata 2L', maker: 'Dorna' }, { typed: 'apa' })

    expect(listedItems(wrapper)).toHaveLength(0)
    // The add was valid and will work again shortly, so it gets a deliberate
    // message rather than the generic failure — and the product goes back into
    // the form so retrying is one tap.
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe(
      'You are adding items too quickly. Wait a minute and try again.',
    )
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('apa')
  })
})

// The way out when the catalog has nothing: describe the product yourself. It
// lands on the list like any other add — and never in product_catalog, which is
// global and read-only to clients.
describe('adding a custom product', () => {
  it('offers the escape hatch once the query is long enough to have been searched', async () => {
    const wrapper = await mountHome()
    const form = wrapper.findComponent(AddItemForm)

    expect(form.props('canAddCustom')).toBe(false)

    form.vm.$emit('update:name', 'a')
    await wrapper.vm.$nextTick()
    expect(form.props('canAddCustom')).toBe(false)

    form.vm.$emit('update:name', 'Branza de burduf')
    await wrapper.vm.$nextTick()
    expect(form.props('canAddCustom')).toBe(true)
  })

  // "Add 'x'" is one tap: the typed name goes on the list as it is, no dialog
  // in between, and the field empties for the next thing.
  it('adds what was typed in one tap, without a dialog', async () => {
    const wrapper = await mountHome()
    const inserted = []
    mocks.db.handlers['shopping_list_items.insert'] = (q) => {
      inserted.push(q.payload)
      return { data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' }, error: null }
    }
    mocks.db.handlers['rpc.add_custom_product'] = () => ({ data: null, error: null })

    const form = wrapper.findComponent(AddItemForm)
    form.vm.$emit('update:name', '2 Branza de burduf')
    await wrapper.vm.$nextTick()
    form.vm.$emit('add-custom')
    await flushPromises()

    expect(wrapper.findComponent(CustomProductModal).props('open')).toBe(false)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ name: 'Branza de burduf', quantity: 2, maker: null })
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('')
  })

  it('adds the described product with its maker attached', async () => {
    const wrapper = await mountHome()
    const inserted = []
    mocks.db.handlers['shopping_list_items.insert'] = (q) => {
      inserted.push(q.payload)
      return { data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' }, error: null }
    }

    // The dialog is reached from a barcode the catalog could not name; its
    // submit is the same whichever way it was opened.
    wrapper.findComponent(CustomProductModal).vm.$emit('submit', {
      name: 'Branza de burduf',
      maker: 'Piata Obor',
    })
    await flushPromises()

    expect(inserted).toHaveLength(1)
    expect(inserted[0].name).toBe('Branza de burduf')
    // A maker on a hand-typed item is only reachable through this modal.
    expect(inserted[0].maker).toBe('Piata Obor')

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].maker).toBe('Piata Obor')
    expect(wrapper.findComponent(CustomProductModal).props('open')).toBe(false)
  })

  it('reaches the catalog only through the RPC, never the table directly', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    const form = wrapper.findComponent(AddItemForm)
    form.vm.$emit('update:name', 'Branza')
    await wrapper.vm.$nextTick()
    form.vm.$emit('add-custom')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(CustomProductModal).vm.$emit('submit', {
      name: 'Branza de burduf',
      maker: 'Piata Obor',
    })
    await flushPromises()

    // The add really happened...
    expect(mocks.db.calls.some((c) => c.table === 'shopping_list_items' && c.op === 'insert')).toBe(true)
    // ...and the catalog itself saw nothing but reads. Contributing goes through
    // add_custom_product (see homeViewCustomProduct.component.test.js), which is
    // what scopes the product to this list and checks membership. RLS grants
    // SELECT and nothing else (006_product_catalog.sql), so a direct write here would be
    // rejected by the database anyway — this catches it at the source instead.
    expect(mocks.db.calls.filter((c) => c.table === 'product_catalog' && c.op !== 'select')).toEqual([])
  })

  it('closes without adding anything when cancelled', async () => {
    const wrapper = await mountHome()
    const form = wrapper.findComponent(AddItemForm)
    form.vm.$emit('update:name', 'Branza')
    await wrapper.vm.$nextTick()
    form.vm.$emit('add-custom')
    await wrapper.vm.$nextTick()

    wrapper.findComponent(CustomProductModal).vm.$emit('cancel')
    await flushPromises()

    expect(wrapper.findComponent(CustomProductModal).props('open')).toBe(false)
    expect(listedItems(wrapper)).toHaveLength(0)
    // The typed text survives a cancel: nothing happened, so nothing is lost.
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('Branza')
  })
})

describe('addItem', () => {
  it('shows the item optimistically, then swaps in the server row under the same id', async () => {
    const wrapper = await mountHome()

    let resolveInsert
    mocks.db.handlers['shopping_list_items.insert'] = (q) =>
      new Promise((resolve) => {
        resolveInsert = () =>
          resolve({ data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' }, error: null })
      })

    await submitAdd(wrapper, 'Milk')

    // Optimistic row is visible while the insert is still in flight, and the
    // form has been cleared.
    let items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Milk')
    expect(items[0].quantity).toBe(1)
    // The field empties once the row has landed, so Enter cannot add it twice.
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('')

    resolveInsert()
    await flushPromises()

    // Server row replaced the optimistic one in place: same id, server fields.
    items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].created_at).toBe('2026-02-02T00:00:00.000Z')
  })

  // The insert was the last write with no guard on it. For the length of its
  // round trip the row exists locally and nowhere else, so a refetch landing
  // inside that window rebuilds the array from a server answer that cannot
  // contain it — and the item the user just added vanishes from under them.
  //
  // Realtime's INSERT echo puts it back, which is why this was never reported;
  // but the echo is the part that is allowed to be late, and reconnect, the
  // watchdog and every subscribe acknowledgement all call loadItems.
  it('keeps the optimistic row when a refetch lands mid-insert', async () => {
    const wrapper = await mountHome()

    let resolveInsert
    mocks.db.handlers['shopping_list_items.insert'] = (q) =>
      new Promise((resolve) => {
        resolveInsert = () =>
          resolve({
            data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
            error: null,
          })
      })

    await submitAdd(wrapper, 'Milk')
    expect(listedItems(wrapper)).toHaveLength(1)

    // The server still knows nothing about it, so this refetch answers empty.
    // Substitution cannot help here — there is no fetched row to substitute —
    // which is why the guard is keyed on the insert being on the wire.
    await wrapper.vm.loadItems()
    expect(listedItems(wrapper).map((i) => i.name)).toEqual(['Milk'])

    resolveInsert()
    await flushPromises()

    // And once it lands, the server's own row is what stands — not a duplicate
    // beside the optimistic one, which is the other way this can go wrong.
    expect(listedItems(wrapper)).toHaveLength(1)
    expect(listedItems(wrapper)[0].created_at).toBe('2026-02-02T00:00:00.000Z')
  })

  // The other half of the same rule. A row taken off the list locally must NOT
  // come back just because a refetch overlapped a write on it: re-adding every
  // guarded row the fetch omitted would resurrect a row somebody else deleted.
  it('does not resurrect a row whose delete is already committed locally', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    dismissToast()
    await flushPromises()
    expect(listedItems(wrapper)).toHaveLength(0)

    // The server has it gone too, so the refetch is empty and stays empty.
    setDefaultHandlers(mocks.db, { items: [] })
    await wrapper.vm.loadItems()
    expect(listedItems(wrapper)).toHaveLength(0)
  })

  it('rolls back the optimistic row and restores the form when the insert fails', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { message: 'boom' },
    })

    await submitAdd(wrapper, 'Milk')

    expect(listedItems(wrapper)).toHaveLength(0)
    // One ErrorModal serves every channel now, so this is the add error itself.
    // The raw Postgres text ('boom') is masked on the way out.
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('Failed to add item.')
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('Milk')
  })

  it('bumps the quantity of an existing active item with the same name instead of inserting', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await submitAdd(wrapper, '  milk ')

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(2)

    await settleQuantity()
    const update = mocks.db.calls.find((q) => q.op === 'update')
    expect(update.payload).toEqual({ quantity: 2 })
    expect(update.filters.id).toBe('item-1')
    expect(mocks.db.calls.some((q) => q.op === 'insert')).toBe(false)
  })

  // The bug this was reported as: tap a product twenty times, go back to the
  // list, and the count is short. Three things conspired, and all three end in
  // "less".
  //
  // Every tap used to fire its own UPDATE carrying the absolute quantity it had
  // computed at tap time, unordered against the other nineteen, so the row
  // settled on whichever landed last rather than the highest.
  it('lands every one of twenty taps on the same product', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    for (let i = 0; i < 19; i++) await submitAdd(wrapper, 'Milk')

    expect(listedItems(wrapper)[0].quantity).toBe(20)

    await settleQuantity()

    // One UPDATE, carrying the number the user actually stopped on.
    const updates = mocks.db.calls.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ quantity: 20 })
  })

  // The second tap finds the row that the first tap only just pushed locally.
  // Its id is client-generated, so an UPDATE sent before the INSERT lands
  // matches nothing, reports no error, and loses the increment in silence.
  it('waits for a new row to exist before bumping it', async () => {
    const wrapper = await mountHome()
    let landInsert
    mocks.db.handlers['shopping_list_items.insert'] = (q) =>
      new Promise((resolve) => {
        landInsert = () =>
          resolve({
            data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
            error: null,
          })
      })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await submitAdd(wrapper, 'Milk')
    // Two more while the insert is still on the wire.
    await submitAdd(wrapper, 'Milk')
    await submitAdd(wrapper, 'Milk')
    await settleQuantity()

    // Nothing sent yet: the row does not exist server-side to be updated.
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)

    landInsert()
    await flushPromises()
    await flushPromises()

    const updates = mocks.db.calls.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ quantity: 3 })
    expect(listedItems(wrapper)[0].quantity).toBe(3)
  })

  // Unguarded, the merge write let realtime treat its own echo as someone else's
  // edit and paint the pre-write number back over the optimistic one.
  it('guards the row while the merged write is on the wire', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    let finishUpdate
    mocks.db.handlers['shopping_list_items.update'] = () =>
      new Promise((resolve) => {
        finishUpdate = () => resolve({ data: null, error: null })
      })

    await submitAdd(wrapper, 'Milk')
    await settleQuantity()

    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(true)

    finishUpdate()
    await flushPromises()
    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(false)
  })

  // Tapping fast, the row spends the whole debounce holding a number the server
  // has not been told about. An echo landing in that gap — a previous burst's
  // own write coming home, or another device — used to be merged as news, which
  // set the count backwards and, because the number keys the row's transition,
  // replayed the animation on the way down.
  it('guards the row from the tap, not from when the write leaves', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await submitAdd(wrapper, 'Milk')

    // Nothing on the wire yet, and already protected — this is the window the
    // guard used to leave open.
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)
    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(true)

    await settleQuantity()
    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(false)
  })

  // The guard is depth-counted, so a burst must raise it once and not once per
  // tap — twenty increments against a single release would pin the row guarded
  // for the rest of the session, and it would stop hearing the list at all.
  it('releases the guard after a long burst rather than pinning it', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    for (let i = 0; i < 20; i++) await submitAdd(wrapper, 'Milk')
    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(true)

    await settleQuantity()
    expect(wrapper.vm.pendingItemWrites.has('item-1')).toBe(false)
  })

  it('blocks adds past the per-member limit locally and opens the limit popup', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Bread', added_by: 'user-1' })
    const wrapper = await mountHome({ items: [existing], maxItemsPerMember: 1 })

    await submitAdd(wrapper, 'Milk')

    expect(wrapper.findComponent(ConfirmModal).props('open')).toBe(true)
    expect(mocks.db.calls.some((q) => q.op === 'insert')).toBe(false)
    expect(listedItems(wrapper)).toHaveLength(1)
  })

  it('folds the quantity into the winning row after losing an insert race (23505)', async () => {
    const wrapper = await mountHome()
    const serverRow = makeItem({ id: 'srv-1', name: 'Milk', quantity: 2 })
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    // The reconciliation fetch finds the row the concurrent add created.
    mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [serverRow], error: null })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await submitAdd(wrapper, 'Milk')

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('srv-1')
    expect(items[0].quantity).toBe(3)
    const update = mocks.db.calls.find((q) => q.op === 'update')
    expect(update.filters.id).toBe('srv-1')
  })

  // The fold above is a write like any other, and it was the one path that did
  // not take the guard. The winning row spends the round trip holding a summed
  // quantity the server has not seen, so an echo landing in that window is
  // merged as news and sets the count back — the same visible countdown the
  // stepper's own guard exists to prevent.
  it('guards the winning row while the folded quantity is on the wire', async () => {
    const wrapper = await mountHome()
    const serverRow = makeItem({ id: 'srv-1', name: 'Milk', quantity: 2 })
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [serverRow], error: null })
    let finishUpdate
    mocks.db.handlers['shopping_list_items.update'] = () =>
      new Promise((resolve) => {
        finishUpdate = () => resolve({ data: null, error: null })
      })

    await submitAdd(wrapper, 'Milk')

    expect(wrapper.vm.pendingItemWrites.has('srv-1')).toBe(true)

    finishUpdate()
    await flushPromises()
    expect(wrapper.vm.pendingItemWrites.has('srv-1')).toBe(false)
  })
})

describe('toggleItem', () => {
  it('rolls the checkbox back when the update fails', async () => {
    const existing = makeItem({ id: 'item-1' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'nope' },
    })

    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper)[0])
    await flushPromises()

    expect(listedItems(wrapper)[0].checked).toBe(false)
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('Could not update that item.')
  })

  // The one assertion in the suite that reads an error in another language.
  //
  // Everything else here runs in English, which is also what a bare string
  // returns, so a failure message that was never translated looks identical to
  // one that was. shoppingListActions writes eleven of them and lib/ is not
  // somewhere vue/no-bare-strings-in-template ever looks, so this is the only
  // thing standing between a t() call being removed and nobody noticing.
  it('shows that failure in the language the app is set to', async () => {
    const existing = makeItem({ id: 'item-1' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'nope' },
    })

    try {
      await setLocale('ro')
      wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper)[0])
      await flushPromises()

      expect(wrapper.findComponent(ErrorModal).props('message')).toBe(
        'Produsul nu a putut fi actualizat.',
      )
    } finally {
      // In a finally, not an afterEach: the catalog is module state shared by
      // every test file in the process, and leaving it Romanian would fail the
      // next file to assert on English rather than this one.
      await setLocale('en')
    }
  })

  it('merges an unchecked item into the existing active row with the same name', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    mocks.db.handlers['rpc.merge_items'] = () => ({ data: 5, error: null })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('item-b')
    expect(items[0].quantity).toBe(5)
    // One call, not an update and a delete: both halves land or neither does.
    const merge = mocks.db.calls.find((q) => q.op === 'merge_items')
    expect(merge.params).toEqual({ p_source: 'item-a', p_target: 'item-b' })
    expect(mocks.db.calls.some((q) => q.op === 'update' || q.op === 'delete')).toBe(false)
  })

  // The server sums the rows it holds. If another device changed the target in
  // the meantime, its answer is the truth and replaces the local guess.
  it('takes the merged quantity the server answers with', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    mocks.db.handlers['rpc.merge_items'] = () => ({ data: 7, error: null })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    expect(listedItems(wrapper)[0].quantity).toBe(7)
  })

  // A merge is the one path that can sum two large numbers. The optimistic
  // number is held at the database bound too, so the screen never shows a
  // quantity the server would refuse.
  it('holds a merged quantity at the database bound on screen', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 600, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 600 })
    const wrapper = await mountHome({ items: [active, checked] })
    let finish
    mocks.db.handlers['rpc.merge_items'] = () =>
      new Promise((resolve) => {
        finish = () => resolve({ data: 999, error: null })
      })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()
    expect(listedItems(wrapper)[0].quantity).toBe(999)

    finish()
    await flushPromises()
    expect(listedItems(wrapper)[0].quantity).toBe(999)
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
  })

  // Both rows are mid-write for the whole merge. The target holds a summed
  // quantity the server has not confirmed; the source has been taken off the
  // list while the server still has it, so an echo for it would find no local
  // row and fall through to a refetch that puts it straight back.
  it('guards both rows while the merge is on the wire', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    let finish
    mocks.db.handlers['rpc.merge_items'] = () =>
      new Promise((resolve) => {
        finish = () => resolve({ data: 5, error: null })
      })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    expect(wrapper.vm.pendingItemWrites.has('item-a')).toBe(true)
    expect(wrapper.vm.pendingItemWrites.has('item-b')).toBe(true)

    finish()
    await flushPromises()
    expect(wrapper.vm.pendingItemWrites.has('item-a')).toBe(false)
    expect(wrapper.vm.pendingItemWrites.has('item-b')).toBe(false)
  })

  it('restores both rows when the merge is refused', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    mocks.db.handlers['rpc.merge_items'] = () => ({
      data: null,
      error: { code: 'P0001', message: 'Nothing to merge.', details: 'merge_items_not_found' },
    })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    const items = listedItems(wrapper)
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.id === 'item-b').quantity).toBe(3)
    expect(items.find((i) => i.id === 'item-a')).toBeTruthy()
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('Could not merge those items.')
  })

  // Never reached the server, or its reply did not. The merge stays on screen
  // and both halves are queued; replaying a merge that did land is harmless,
  // because the quantity is absolute and the delete idempotent.
  it('queues both halves when the merge dies at the network', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    mocks.db.handlers['rpc.merge_items'] = () => ({ data: null, error: { message: 'Failed to fetch' } })

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    expect(listedItems(wrapper).map((i) => [i.id, i.quantity])).toEqual([['item-b', 5]])
    expect(loadOfflineQueue(localStorage, 'user-1')).toEqual([
      { kind: 'update', id: 'item-b', patch: { quantity: 5 } },
      { kind: 'delete', id: 'item-a' },
    ])
  })

  // The source is off the list for the whole round trip while the server still
  // has it, so a refetch landing in that window puts it back. The rollback used
  // to splice it in again at its old index regardless: the row twice.
  it('does not restore the merge source twice when a refetch already put it back', async () => {
    const checked = makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true })
    const active = makeItem({ id: 'item-b', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [active, checked] })
    mocks.db.handlers['rpc.merge_items'] = () => {
      listedItems(wrapper).push(makeItem({ id: 'item-a', name: 'Milk', quantity: 2, checked: true }))
      return { data: null, error: { code: 'P0001', message: 'Nothing to merge.' } }
    }

    const source = listedItems(wrapper).find((i) => i.id === 'item-a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', source)
    await flushPromises()

    expect(listedItems(wrapper).map((i) => i.id).sort()).toEqual(['item-a', 'item-b'])
  })

  it('moves a newly checked item to the top of the checked section', async () => {
    const older = makeItem({ id: 'older', name: 'Milk', checked: true, checked_at: '2026-01-01T00:00:00.000Z' })
    const active = makeItem({ id: 'active', name: 'Bread', checked: false })
    const wrapper = await mountHome({ items: [active, older] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper).find((i) => i.id === 'active'))
    await flushPromises()

    // Bread was just checked (now), so it sits above the older checked Milk.
    const checkedOrder = listedItems(wrapper).filter((i) => i.checked).map((i) => i.id)
    expect(checkedOrder).toEqual(['active', 'older'])
  })

  it('shows the limit popup (not a raw error) when unchecking would exceed the cap', async () => {
    const item = makeItem({ id: 'item-1', name: 'Milk', checked: true, checked_at: '2026-01-01T00:00:00.000Z' })
    const wrapper = await mountHome({ items: [item] })
    // The DB trigger (004_shopping_list.sql) now rejects an uncheck that breaks the cap.
    mocks.db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'You reached your limit of 50 active items.', details: 'member_active_item_limit_exceeded' },
    })

    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper)[0])
    await flushPromises()

    // Rolled back to checked, friendly popup instead of an error modal.
    expect(listedItems(wrapper)[0].checked).toBe(true)
    expect(wrapper.findComponent(ConfirmModal).props('open')).toBe(true)
    expect(wrapper.findComponent(ErrorModal).props('message')).toBeFalsy()
  })

  // Regression: the same tap that checks an item also wakes a reconnect/refetch.
  // While the checked=true write is still in flight, that refetch reads the
  // server's pre-write row (still unchecked) and used to overwrite the flip,
  // bouncing the item straight back to the active list. The in-flight write must
  // hold its ground.
  it('keeps a just-checked item checked when a refetch races the in-flight write', async () => {
    const server = [makeItem({ id: 'item-1', name: 'Milk', checked: false })]
    const wrapper = await mountHome({ items: server })

    // Refetches now hand back clones, so the view's optimistic flip cannot leak
    // into the "server" state the next select reads back — the real client/server
    // split this bug lives in.
    mocks.db.handlers['shopping_list_items.select'] = (q) => ({
      data: server.filter((i) => i.checked === q.filters.checked).map((i) => ({ ...i })),
      error: null,
    })
    goOnline()
    await flushPromises()

    // The checked=true write never lands (stays in flight), so the server row
    // stays unchecked — exactly the race window.
    let resolveUpdate
    mocks.db.handlers['shopping_list_items.update'] = () =>
      new Promise((resolve) => {
        resolveUpdate = () => resolve({ data: null, error: null })
      })

    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper).find((i) => i.id === 'item-1'))
    await flushPromises()
    expect(listedItems(wrapper).find((i) => i.id === 'item-1').checked).toBe(true)

    // A background refetch fires mid-write, as a reconnect/focus/watchdog would.
    // Without the guard this reverts the item to the server's unchecked row.
    __setOnlineForTest(false)
    __setOnlineForTest(true)
    await flushPromises()
    expect(listedItems(wrapper).find((i) => i.id === 'item-1').checked).toBe(true)

    resolveUpdate()
    await flushPromises()
  })

  // The same race for the two writes that REMOVE a row. The refetch reads the
  // server, which still has it, and the row came back until the realtime echo
  // took it away again.
  it.each([
    ['delete', 'shopping_list_items.delete', false],
    ['checkout', 'rpc.buy_items', true],
  ])('keeps a row gone when a refetch races its in-flight %s', async (action, handler, checked) => {
    const server = [makeItem({ id: 'item-1', name: 'Milk', checked })]
    const wrapper = await mountHome({ items: server })
    mocks.db.handlers['shopping_list_items.select'] = (q) => ({
      data: server.filter((i) => i.checked === q.filters.checked).map((i) => ({ ...i })),
      error: null,
    })

    let resolveWrite
    mocks.db.handlers[handler] = () =>
      new Promise((resolve) => {
        resolveWrite = () => resolve({ data: null, error: null })
      })

    const list = wrapper.findComponent(ShoppingList)
    if (action === 'delete') {
      list.vm.$emit('delete', listedItems(wrapper)[0])
      dismissToast()
    }
    else list.vm.$emit('checkout', ['item-1'])
    await flushPromises()
    expect(listedItems(wrapper).some((i) => i.id === 'item-1')).toBe(false)

    __setOnlineForTest(false)
    __setOnlineForTest(true)
    await flushPromises()
    expect(listedItems(wrapper).some((i) => i.id === 'item-1')).toBe(false)

    resolveWrite()
    await flushPromises()
  })
})

describe('list ordering', () => {
  // Regression: the optimistic row is appended with a client-clock created_at,
  // then the server echo swaps in the authoritative created_at. Without a re-sort
  // the row keeps its append position until some later background refetch suddenly
  // moves it — items appearing to "change rows on their own". The echo must settle
  // the canonical order right away.
  it('re-sorts a newly added item into created_at order once the server row lands', async () => {
    const existing = makeItem({ id: 'item-late', name: 'Zucchini', created_at: '2026-01-02T00:00:00.000Z' })
    const wrapper = await mountHome({ items: [existing] })
    // The server stamps the new row EARLIER than the existing one, so canonical
    // order puts it first — not at the append position.
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-01-01T00:00:00.000Z' },
      error: null,
    })

    await submitAdd(wrapper, 'Apple')

    expect(listedItems(wrapper).map((i) => i.name)).toEqual(['Apple', 'Zucchini'])
  })
})

describe('multiple lists', () => {
  it('loads every list and switches the active one from the topbar', async () => {
    mocks.db = createFakeDb()
    mocks.routerReplace = vi.fn()
    mocks.db.handlers['list_members.select'] = (q) =>
      q.filters.user_id
        ? {
            data: [
              { list_id: 'fam-1', lists: { id: 'fam-1', name: 'Home' } },
              { list_id: 'fam-2', lists: { id: 'fam-2', name: 'Parents' } },
            ],
            error: null,
          }
        : { data: [{ user_id: 'user-1', display_name: 'Me', image_url: null, role: 'moderator' }], error: null }
    mocks.db.handlers['lists.select'] = (q) => ({
      data: {
        name: q.filters.id === 'fam-2' ? 'Parents' : 'Home',
        invite_code: 'ABCDEFGH',
        created_by: 'user-1',
        max_items_per_member: 50,
      },
      error: null,
    })
    mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
    mocks.db.handlers['purchase_history.select'] = () => ({ data: [], error: null })

    const wrapper = trackMount(HomeView, { shallow: true })
    await flushPromises()
    await flushPromises()

    const topbar = wrapper.findComponent(AppNavBar)
    // Both lists reach the switcher, name-ordered, with the first active.
    expect(topbar.props('lists').map((f) => f.name)).toEqual(['Home', 'Parents'])
    expect(topbar.props('listName')).toBe('Home')

    topbar.vm.$emit('switch-list', 'fam-2')
    await flushPromises()

    // The active list (name + id) reloads to the chosen one.
    expect(topbar.props('listId')).toBe('fam-2')
    expect(topbar.props('listName')).toBe('Parents')
  })
})

// The row stepper's write. Adding the same product again has always summed
// quantities, which covers going up but never down — so before this, a wrong
// number could only be fixed by deleting the item and adding it back.
describe('setItemQuantity', () => {
  it('sends the resulting quantity and shows it without waiting for the round trip', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })
    let resolveUpdate
    mocks.db.handlers['shopping_list_items.update'] = () =>
      new Promise((resolve) => {
        resolveUpdate = () => resolve({ data: null, error: null })
      })

    const row = listedItems(wrapper)[0]
    await tapQuantity(wrapper, row, 5)

    // Already moved, before anything has been sent at all.
    expect(listedItems(wrapper)[0].quantity).toBe(5)
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)

    await settleQuantity()
    resolveUpdate()
    await flushPromises()

    const update = mocks.db.calls.find((q) => q.op === 'update')
    expect(update.payload).toEqual({ quantity: 5 })
    expect(update.filters.id).toBe('item-1')
  })

  it('puts the old number back when the write fails', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'boom' },
    })

    await setQuantity(wrapper, listedItems(wrapper)[0], 1)

    expect(listedItems(wrapper)[0].quantity).toBe(3)
  })

  it('queues the change instead of calling the network when offline', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })
    goOffline()

    await setQuantity(wrapper, listedItems(wrapper)[0], 4)

    expect(listedItems(wrapper)[0].quantity).toBe(4)
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)
  })

  it('writes nothing when the number did not actually change', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })

    await setQuantity(wrapper, listedItems(wrapper)[0], 2)

    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)
  })

  // The reason the debounce exists. Writing per tap put four UPDATEs on the wire
  // for one decision, and they do not necessarily come back in the order they
  // left — so the row settled on whichever echo landed last rather than on the
  // number under the thumb, and the count keys the row's transition, so the
  // animation replayed each time.
  it('collapses a burst of taps into one write carrying the final number', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 1 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    const row = listedItems(wrapper)[0]
    for (const n of [2, 3, 4, 5]) await tapQuantity(wrapper, row, n)

    // The number tracked every tap; the wire stayed quiet.
    expect(listedItems(wrapper)[0].quantity).toBe(5)
    expect(mocks.db.calls.filter((q) => q.op === 'update')).toHaveLength(0)

    await settleQuantity()

    const updates = mocks.db.calls.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ quantity: 5 })
  })

  it('says nothing at all when a burst ends where it started', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 3 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    const row = listedItems(wrapper)[0]
    await tapQuantity(wrapper, row, 4)
    await tapQuantity(wrapper, row, 3)
    await settleQuantity()

    expect(listedItems(wrapper)[0].quantity).toBe(3)
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)
  })

  // Rolling back one step would leave the row on a number nobody chose: the tap
  // before last. The whole burst is the unit that failed.
  it('rolls a failed burst back to where the burst began', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'boom' },
    })

    const row = listedItems(wrapper)[0]
    for (const n of [3, 4, 5]) await tapQuantity(wrapper, row, n)
    await settleQuantity()

    expect(listedItems(wrapper)[0].quantity).toBe(2)
  })

  // A refetch that overtakes a waiting write reads the server's older number and
  // paints over one the user is already looking at.
  it('sends a waiting change before a refetch can read past it', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await tapQuantity(wrapper, listedItems(wrapper)[0], 7)
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)

    // Whatever triggers a reload — reconnect, focus, the realtime watchdog.
    goOnline()
    await flushPromises()

    const updates = mocks.db.calls.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ quantity: 7 })
  })

  // The row refuses to open its stepper on a checked item, but a change can still
  // arrive from one that was open when the row was ticked from another device.
  // Same rule addItem's merge already follows: checked rows are left alone.
  it('refuses to change a checked item', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2, checked: true })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await setQuantity(wrapper, listedItems(wrapper)[0], 5)

    expect(listedItems(wrapper)[0].quantity).toBe(2)
    expect(mocks.db.calls.some((q) => q.op === 'update')).toBe(false)
  })

  // 004_shopping_list.sql only enforces >= 1; the ceiling is the app's, so it has
  // to hold here rather than relying on the stepper's disabled state.
  it('clamps to the allowed range', async () => {
    const existing = makeItem({ id: 'item-1', name: 'Milk', quantity: 2 })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    await setQuantity(wrapper, listedItems(wrapper)[0], 0)
    expect(listedItems(wrapper)[0].quantity).toBe(1)

    await setQuantity(wrapper, listedItems(wrapper)[0], 500)
    expect(listedItems(wrapper)[0].quantity).toBe(99)
  })
})

describe('deleteItem', () => {
  it('restores the row at its original position when the delete fails', async () => {
    const first = makeItem({ id: 'item-1', name: 'Milk' })
    const second = makeItem({ id: 'item-2', name: 'Eggs' })
    const wrapper = await mountHome({ items: [first, second] })
    mocks.db.handlers['shopping_list_items.delete'] = () => ({
      data: null,
      error: { message: 'cannot delete' },
    })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    dismissToast()
    await flushPromises()

    const items = listedItems(wrapper)
    expect(items.map((i) => i.id)).toEqual(['item-1', 'item-2'])
    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('Could not delete that item.')
  })

  it('removes the row optimistically when the delete succeeds', async () => {
    const existing = makeItem({ id: 'item-1' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    dismissToast()
    await flushPromises()

    expect(listedItems(wrapper)).toHaveLength(0)
  })
})

// Ticking a product that is already in the cart. The cart used to end up with
// two rows of the same thing, side by side, because only rows still to buy were
// ever merged.
describe('ticking a product already in the cart', () => {
  it('folds the cart row into the one being ticked, quantities summed', async () => {
    const wrapper = await mountHome({
      items: [makeItem({ id: 'a', checked: true, quantity: 2, checked_at: '2026-01-02T00:00:00.000Z' })],
    })
    mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
      data: { ...q.payload, checked: false, created_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })
    mocks.db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })
    mocks.db.handlers['rpc.merge_items'] = () => ({ data: 3, error: null })

    await submitAdd(wrapper, 'Milk')
    const fresh = listedItems(wrapper).find((i) => i.id !== 'a')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', fresh)
    await flushPromises()

    const rows = listedItems(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: fresh.id, checked: true, quantity: 3 })
    // The cart row goes INTO the new one: merge_items only accepts a target that
    // is still to buy, and at that moment the new row is.
    const merge = mocks.db.calls.find((c) => c.table === 'rpc' && c.op === 'merge_items')
    expect(merge.params).toEqual({ p_source: 'a', p_target: fresh.id })
  })
})

describe('undoing a delete', () => {
  // The delete waits for its toast. Undo inside that window must put the row
  // back and never reach the server; a delete that went out anyway would take
  // the item off every other member's list while this one shows it restored.
  it('restores the row and sends nothing when Undo is pressed', async () => {
    const wrapper = await mountHome({ items: [makeItem({ id: 'item-1', name: 'Milk' })] })
    mocks.db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    await flushPromises()
    expect(listedItems(wrapper)).toHaveLength(0)

    triggerToastAction()
    await flushPromises()
    expect(listedItems(wrapper).map((i) => i.id)).toEqual(['item-1'])
    expect(mocks.db.calls.some((q) => q.op === 'delete')).toBe(false)
  })

  // Found by the bot swarm: two members deleted the same row, the second one
  // pressed Undo after the first one's delete had gone through, and the row
  // came back on the second one's screen only, gone from the server and from
  // everyone else's list. Nothing ever took it away again.
  it('does not bring back a row another member deleted during the window', async () => {
    const server = [makeItem({ id: 'item-1', name: 'Milk' })]
    const wrapper = await mountHome({ items: server })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    await flushPromises()
    server.splice(0) // someone else's delete lands on the server meanwhile

    triggerToastAction()
    await flushPromises()
    expect(listedItems(wrapper)).toHaveLength(0)
  })

  it('keeps a held-back row off the list when a refetch lands during the window', async () => {
    const server = [makeItem({ id: 'item-1', name: 'Milk' })]
    const wrapper = await mountHome({ items: server })

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    await flushPromises()
    await wrapper.vm.loadItems()
    expect(listedItems(wrapper)).toHaveLength(0)
    triggerToastAction()
  })
})

describe('offline queue', () => {
  it('queues the add locally when offline instead of calling the network', async () => {
    const wrapper = await mountHome()
    goOffline()

    await submitAdd(wrapper, 'Milk')

    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Milk')
    expect(items[0].quantity).toBe(1)
    expect(mocks.db.calls.some((q) => q.op === 'insert')).toBe(false)
    const queue = loadOfflineQueue(localStorage, 'user-1')
    expect(queue).toHaveLength(1)
    expect(queue[0].kind).toBe('insert')
  })

  it('cancels the queued insert when the item is deleted while still offline', async () => {
    const wrapper = await mountHome()
    goOffline()

    await submitAdd(wrapper, 'Milk')
    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    dismissToast()
    await flushPromises()

    expect(listedItems(wrapper)).toHaveLength(0)
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(0)
    // The row never existed on the server, so nothing must go over the wire.
    expect(mocks.db.calls.some((q) => q.op === 'insert' || q.op === 'delete')).toBe(false)
  })

  it('flushes queued writes and re-fetches when connectivity returns', async () => {
    const wrapper = await mountHome()
    goOffline()
    await submitAdd(wrapper, 'Milk')
    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper)[0])
    await flushPromises()
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)

    const serverRow = makeItem({ id: 'ignored', name: 'Milk', quantity: 2, checked: true })
    mocks.db.handlers['shopping_list_items.insert'] = (q) => {
      serverRow.id = q.payload.id
      return { data: { ...q.payload, checked: true }, error: null }
    }
    mocks.db.handlers['shopping_list_items.select'] = (q) => ({
      data: [serverRow].filter((i) => i.checked === q.filters.checked),
      error: null,
    })
    goOnline()
    await flushPromises()

    // The queued insert (with the offline toggle folded into it) was replayed...
    const insert = mocks.db.calls.find((q) => q.op === 'insert')
    expect(insert.payload.name).toBe('Milk')
    expect(insert.payload.checked).toBe(true)
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(0)
    // ...and the re-fetch converged the list on the server's state.
    const items = listedItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].checked).toBe(true)
  })

  // Regression: a throttled replay is the first transient failure that happens
  // while the network is fine. The flush correctly keeps the mutation, but the
  // re-fetch that follows returns a list without it — so the row used to vanish
  // off the screen and sit invisibly in a queue that retries up to an hour later.
  it('keeps a throttled offline add on screen instead of losing it to the re-fetch', async () => {
    const wrapper = await mountHome()
    goOffline()
    await submitAdd(wrapper, 'Milk')
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)

    // Back online, but the server throttles the replay (004_shopping_list.sql).
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: {
        code: 'P0001',
        message: 'Too many items added in a short time. Try again shortly.',
        details: 'item_insert_rate_limit_exceeded',
      },
    })
    // The insert never landed, so the re-fetch legitimately has nothing.
    mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
    goOnline()
    await flushPromises()

    const items = listedItems(wrapper)
    expect(items.map((i) => i.name)).toEqual(['Milk'])
    expect(items[0].quantity).toBe(1)
    // Still queued, so it syncs once the window clears.
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)
    // And no error modal: the row is on screen and will send itself. A throttle
    // that heals on its own is not something to interrupt the user about.
    expect(wrapper.findComponent(ErrorModal).props('message')).toBeFalsy()
  })

  // The queue is keyed by user, not by list, and a user may belong to three.
  // A write still queued for another list must not surface in this one's list.
  it('never shows another list’s queued add in this list’s list', async () => {
    const wrapper = await mountHome()
    // A write queued while offline in a different list the user belongs to.
    enqueueOfflineMutation(localStorage, 'user-1', {
      kind: 'insert',
      id: 'other-fam-row',
      row: { id: 'other-fam-row', list_id: 'fam-2', name: 'Parents Milk', quantity: 1, added_by: 'user-1' },
    })
    // Throttled, so it stays queued rather than draining away.
    mocks.db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: 'P0001', details: 'item_insert_rate_limit_exceeded' },
    })
    mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
    goOnline()
    await flushPromises()

    // It is still queued for fam-2, and invisible here.
    expect(listedItems(wrapper)).toHaveLength(0)
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)
  })

  it('runs from the cached snapshot without an error banner when opened offline', async () => {
    saveListSnapshot(localStorage, 'user-1', {
      listId: 'fam-1',
      listName: 'Fam',
      listInviteCode: 'ABCDEFGH',
      listOwnerId: 'user-1',
      listItemLimit: 50,
      listMembers: [{ user_id: 'user-1', display_name: 'Me', image_url: null, role: 'moderator' }],
      items: [makeItem({ id: 'cached-1', name: 'Milk' })],
    })
    goOffline()

    mocks.db = createFakeDb()
    mocks.routerReplace = vi.fn()
    // The membership fetch dies at the network layer, like a dead connection.
    mocks.db.handlers['list_members.select'] = () => ({
      data: null,
      error: { message: 'TypeError: Failed to fetch' },
    })

    const wrapper = trackMount(HomeView, { shallow: true })
    await flushPromises()
    await flushPromises()

    expect(wrapper.findComponent(ErrorModal).props('message')).toBe('')
    expect(listedItems(wrapper)).toHaveLength(1)
    expect(listedItems(wrapper)[0].id).toBe('cached-1')
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })
})

// The device can lose connectivity while navigator.onLine still reports true
// (common in the Android WebView). A live write then fails with a raw
// "TypeError: Failed to fetch"; these must be treated exactly like offline —
// keep the optimistic state, queue the write, show no error modal. These tests
// deliberately stay in the default online state (no goOnline(): that dispatches
// a reconnect whose handleBackOnline reload would clobber the optimistic
// row we are asserting on) — only the DB handler fails.
describe('network failure while reported online', () => {
  const fetchError = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } })

  function anyErrorModalShown(wrapper) {
    return wrapper.findAllComponents(ErrorModal).some((m) => m.props('message'))
  }

  it('keeps the added item and queues it when the insert fails at the network layer', async () => {
    const wrapper = await mountHome()
    mocks.db.handlers['shopping_list_items.insert'] = fetchError

    await submitAdd(wrapper, 'Milk')

    expect(listedItems(wrapper)).toHaveLength(1)
    expect(anyErrorModalShown(wrapper)).toBe(false)
    const queue = loadOfflineQueue(localStorage, 'user-1')
    expect(queue).toHaveLength(1)
    expect(queue[0].kind).toBe('insert')
  })

  it('keeps the checkbox flipped and queues it when the toggle fails at the network layer', async () => {
    const existing = makeItem({ id: 'item-1' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.update'] = fetchError

    wrapper.findComponent(ShoppingList).vm.$emit('toggle', listedItems(wrapper)[0])
    await flushPromises()

    expect(listedItems(wrapper)[0].checked).toBe(true)
    expect(anyErrorModalShown(wrapper)).toBe(false)
    const queue = loadOfflineQueue(localStorage, 'user-1')
    expect(queue).toEqual([{ kind: 'update', id: 'item-1', patch: { checked: true } }])
  })

  it('keeps the row removed and queues it when the delete fails at the network layer', async () => {
    const existing = makeItem({ id: 'item-1' })
    const wrapper = await mountHome({ items: [existing] })
    mocks.db.handlers['shopping_list_items.delete'] = fetchError

    wrapper.findComponent(ShoppingList).vm.$emit('delete', listedItems(wrapper)[0])
    dismissToast()
    await flushPromises()

    expect(listedItems(wrapper)).toHaveLength(0)
    expect(anyErrorModalShown(wrapper)).toBe(false)
    const queue = loadOfflineQueue(localStorage, 'user-1')
    expect(queue).toEqual([{ kind: 'delete', id: 'item-1' }])
  })

  it('shows no error modal when the initial list fetch fails at the network layer', async () => {
    mocks.db = createFakeDb()
    mocks.routerReplace = vi.fn()
    // Membership and header resolve, but the items fetch dies at the network.
    mocks.db.handlers['list_members.select'] = (q) =>
      q.filters.user_id
        ? { data: [{ list_id: 'fam-1', lists: { id: 'fam-1', name: 'Fam' } }], error: null }
        : { data: [{ user_id: 'user-1', display_name: 'Me', image_url: null, role: 'moderator' }], error: null }
    mocks.db.handlers['lists.select'] = () => ({
      data: { name: 'Fam', invite_code: 'ABCDEFGH', created_by: 'user-1', max_items_per_member: 50 },
      error: null,
    })
    mocks.db.handlers['shopping_list_items.select'] = fetchError

    const wrapper = trackMount(HomeView, { shallow: true })
    await flushPromises()
    await flushPromises()

    expect(anyErrorModalShown(wrapper)).toBe(false)
  })
})

// On native, the window 'online' event can fail to fire; the Capacitor
// connectivity signal is what reliably reports reconnection. Queued writes must
// flush on that signal alone — otherwise (the reported bug) they only sync on an
// app restart, so other clients never see them.
describe('reliable reconnect via connectivity signal', () => {
  it('flushes queued writes on the connectivity reconnect edge, with no window online event', async () => {
    const wrapper = await mountHome()

    // Reliable native offline (navigator may still claim online).
    __setOnlineForTest(false)
    await submitAdd(wrapper, 'Milk')
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(1)
    expect(mocks.db.calls.some((q) => q.op === 'insert')).toBe(false)

    // Server accepts the replayed insert; the refetch converges the list.
    const serverRow = makeItem({ id: 'srv', name: 'Milk', quantity: 2 })
    mocks.db.handlers['shopping_list_items.insert'] = (q) => {
      serverRow.id = q.payload.id
      return { data: q.payload, error: null }
    }
    mocks.db.handlers['shopping_list_items.select'] = (q) => ({
      data: [serverRow].filter((i) => i.checked === q.filters.checked),
      error: null,
    })

    // Connectivity restored — the native edge, not a window 'online' event.
    __setOnlineForTest(true)
    await flushPromises()

    expect(mocks.db.calls.some((q) => q.op === 'insert')).toBe(true)
    expect(loadOfflineQueue(localStorage, 'user-1')).toHaveLength(0)
  })
})
