// @vitest-environment happy-dom
//
// HomeView's half of scanning a product onto the list.
//
// The scanner component only reports codes; everything that decides what a code
// MEANS lives here, and the parts worth pinning down are the ones no screenshot
// would show: that a hit takes the same path as a tapped suggestion, that a miss
// is remembered so a barcode lying in front of the camera cannot re-query every
// couple of seconds, and that naming a missed product carries its code into the
// catalog — which is the whole reason a miss is worth anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import HomeView from '../src/views/HomeView.vue'
import AddItemForm from '../src/components/AddItemForm.vue'
import BarcodeScannerModal from '../src/components/BarcodeScannerModal.vue'
import CustomProductModal from '../src/components/CustomProductModal.vue'
import { createFakeDb } from './support/fakeSupabase.js'
import { __setOnlineForTest } from '../src/lib/connectivity'
import { track } from '../src/lib/analytics'

const mocks = vi.hoisted(() => ({ db: null, nativeAvailable: false, nativeScan: null, timeZone: undefined }))

// Only the device's timezone is faked, so the market a scan sends comes from the
// real lookup table -- and the suite does not depend on the clock settings of
// the machine running it (this developer's says Bucharest, CI says UTC).
vi.mock('../src/lib/region', async (importOriginal) => ({
  ...(await importOriginal()),
  deviceTimeZone: () => mocks.timeZone,
}))

// Spied so the barcode_scanned event can be asserted; everything else real.
vi.mock('../src/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal()),
  track: vi.fn(),
}))

vi.mock('../src/supabase', () => ({
  useSupabase: () => mocks.db,
  getCatalogSupabase: () => mocks.catalogDb ?? null,
}))

// In the app, Google's scanner reads the code and there is no camera screen of
// ours at all. Only those two functions are swapped — barcodeCandidates is the
// real one, because productSuggestions builds the lookup query with it.
vi.mock('../src/lib/barcodeScanner', async (importOriginal) => ({
  ...(await importOriginal()),
  nativeScanAvailable: () => mocks.nativeAvailable,
  scanWithNativeScanner: () => mocks.nativeScan(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ replace: () => {} }) }))

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

const mountedWrappers = []

// One product in the catalog, filed under the code its package prints.
const SCANNED = '5941234567890'
const UNKNOWN = '4001234567890'

// The code a product's package prints, and the code a DIFFERENT package prints
// for what the catalog decided is the same product. buildLoadPlan collapses
// those two onto one row and parks the second in alt_barcodes; lookup_barcode()
// is what makes it findable again. Before that it scanned to nothing.
const ALT = '5941234567906'

// `catalog` opts a test into the second Supabase project. Left out,
// getCatalogSupabase() returns null and only the list's own contributed
// rows answer a scan — which is the shape every test above this was written in.
async function mountHome({ catalog = false } = {}) {
  mocks.catalogDb = null
  if (catalog) {
    mocks.catalogDb = createFakeDb()
    mocks.catalogDb.handlers['rpc.lookup_barcode'] = (q) => {
      const codes = q.params?.p_codes ?? []
      return codes.includes(SCANNED) || codes.includes(ALT)
        ? { data: [{ name: 'Apa Plata 2L', maker: 'Dorna', popularity: 100 }], error: null }
        : { data: [], error: null }
    }
  }
  mocks.db = createFakeDb()
  mocks.db.handlers['list_members.select'] = (q) =>
    q.filters.user_id
      ? { data: [{ list_id: 'fam-1', lists: { id: 'fam-1', name: 'Fam' } }], error: null }
      : {
          data: [{ user_id: 'user-1', display_name: 'Test User', image_url: null, role: 'moderator' }],
          error: null,
        }
  mocks.db.handlers['lists.select'] = () => ({
    data: { name: 'Fam', invite_code: 'ABCDEFGH', created_by: 'user-1', max_items_per_member: 50 },
    error: null,
  })
  mocks.db.handlers['shopping_list_items.select'] = () => ({ data: [], error: null })
  mocks.db.handlers['purchase_history.select'] = () => ({ data: [], error: null })
  mocks.db.handlers['shopping_list_items.insert'] = (q) => ({
    data: { ...q.payload, checked: false },
    error: null,
  })
  mocks.db.handlers['rpc.add_custom_product'] = () => ({ data: null, error: null })
  mocks.db.handlers['rpc.bump_product_popularity'] = () => ({ data: null, error: null })
  // The barcode lookup and the typed search hit the same table; the barcode one
  // is the query filtering on a set of codes.
  mocks.db.handlers['product_catalog.select'] = (q) => {
    const codes = q.filters['in:barcode']
    if (!codes) return { data: [], error: null }
    return codes.includes(SCANNED)
      ? { data: [{ name: 'Apa Plata 2L', maker: 'Dorna', popularity: 40 }], error: null }
      : { data: [], error: null }
  }

  const wrapper = mount(HomeView, { shallow: true })
  mountedWrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  return wrapper
}

const scanner = (wrapper) => wrapper.findComponent(BarcodeScannerModal)

const rpcCalls = (fn) => mocks.db.calls.filter((c) => c.table === 'rpc' && c.op === fn)
const insertedRows = () =>
  mocks.db.calls
    .filter((c) => c.table === 'shopping_list_items' && c.op === 'insert')
    .map((c) => c.payload)
const barcodeQueries = () =>
  mocks.db.calls.filter((c) => c.table === 'product_catalog' && c.filters?.['in:barcode'])
const catalogLookups = () =>
  (mocks.catalogDb?.calls ?? []).filter((c) => c.table === 'rpc' && c.op === 'lookup_barcode')

async function openScanner(wrapper) {
  wrapper.findComponent(AddItemForm).vm.$emit('scan')
  await flushPromises()
}

async function scan(wrapper, code) {
  scanner(wrapper).vm.$emit('detected', code)
  await flushPromises()
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  localStorage.clear()
  // Default to the browser path, which is what the tests above exercise.
  mocks.nativeAvailable = false
  mocks.nativeScan = vi.fn(async () => ({ ok: true, code: null }))
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop().unmount()
  __setOnlineForTest(true)
  vi.restoreAllMocks()
})

describe('scanning a barcode onto the list', () => {
  it('mounts no scanner until one is asked for', async () => {
    // It holds a camera. Nothing should be able to reach one on the way to a
    // shopping list.
    const wrapper = await mountHome()
    expect(scanner(wrapper).exists()).toBe(false)
  })

  // The scan IS the add now. It used to fill the form and close the camera so
  // the name and the quantity picker could be checked first — but quantity moved
  // onto the list row, and a barcode is an exact key, so that confirming tap was
  // buying nothing that tapping a fuzzy search result had to pay for.
  it('adds the product it found', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    await scan(wrapper, SCANNED)

    const [row] = insertedRows()
    expect(row.name).toBe('Apa Plata 2L')
    expect(rpcCalls('bump_product_popularity')).toHaveLength(1)
  })

  // Writing the catalog's spelling into the field left it sitting there
  // afterwards — the add form no longer clears on add — where it looked like a
  // draft and suppressed suggestions until it was edited by hand.
  it('never touches the add form', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    await scan(wrapper, SCANNED)

    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('')
  })

  // One code per scan. Our camera could have kept reading and Google's could
  // have been reopened, but a camera that comes back on its own after every item
  // is a thing to dismiss rather than a thing to use.
  it('closes once it has an answer', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    await scan(wrapper, SCANNED)

    // The list behind it is the confirmation: the row is there with its own
    // stepper, which is also where a count gets corrected.
    expect(scanner(wrapper).exists()).toBe(false)
    expect(insertedRows()).toHaveLength(1)
  })

  it('keeps the maker with the product it scanned', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    await scan(wrapper, SCANNED)

    // The row must be the one a tapped suggestion would have produced — maker
    // included, which the typed text alone could never carry.
    const [row] = insertedRows()
    expect(row.name).toBe('Apa Plata 2L')
    expect(row.maker).toBe('Dorna')
    expect(row).not.toHaveProperty('barcode')
    // A catalog product gets its popularity counted, not contributed again.
    expect(rpcCalls('bump_product_popularity')).toHaveLength(1)
    expect(rpcCalls('add_custom_product')).toHaveLength(0)
  })

  it('scoped the lookup to the global catalog plus this list', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    await scan(wrapper, SCANNED)

    // Same scoping the typed search uses. RLS blocks other lists either
    // way; this is what stops a product contributed in a DIFFERENT list the
    // user belongs to being found while shopping here.
    expect(barcodeQueries()[0].filters.or).toBe('list_id.is.null,list_id.eq.fam-1')
  })

  it('reports a code the catalog has no product for, and adds nothing', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    await scan(wrapper, UNKNOWN)

    expect(scanner(wrapper).props('unknownCode')).toBe(UNKNOWN)
    expect(insertedRows()).toHaveLength(0)
  })

  it('counts a real miss for the catalog, but not a lookup that failed offline', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    vi.mocked(track).mockClear()

    await scan(wrapper, UNKNOWN)
    expect(track).toHaveBeenCalledWith('barcode_scanned', { found: false })

    // Offline a failed lookup looks like a miss; counting it would make the
    // catalog's miss rate follow the shops' signal. The miss is still shown.
    const other = await mountHome()
    await openScanner(other)
    vi.mocked(track).mockClear()
    __setOnlineForTest(false)
    await scan(other, '4009999999999')
    expect(track).not.toHaveBeenCalledWith('barcode_scanned', { found: false })
    expect(scanner(other).props('unknownCode')).toBe('4009999999999')
  })

  // The reference catalog answers through an RPC where the app database is a
  // plain select, because only the catalog has alt_barcodes and only it needs
  // an ordering across two columns to resolve a code.
  // A scan in Italy must not find a product only a Romanian shop sells, and
  // should read the name an Italian shop uses -- the rule search already follows.
  it('sends the market the timezone implies with a scan', async () => {
    mocks.timeZone = 'Europe/Rome'
    try {
      const wrapper = await mountHome({ catalog: true })
      await openScanner(wrapper)
      await scan(wrapper, SCANNED)
      expect(catalogLookups()[0].params.p_markets).toEqual(['IT'])
    } finally {
      mocks.timeZone = undefined
    }
  })

  // Omitted rather than null: PostgREST resolves an RPC by the keys it is sent,
  // and no key is what keeps a no-market scan identical to the one before this.
  it('sends no market with a scan when the timezone names none the catalog covers', async () => {
    mocks.timeZone = 'Europe/Warsaw'
    try {
      const wrapper = await mountHome({ catalog: true })
      await openScanner(wrapper)
      await scan(wrapper, SCANNED)
      expect('p_markets' in catalogLookups()[0].params).toBe(false)
    } finally {
      mocks.timeZone = undefined
    }
  })

  it('asks the reference catalog through lookup_barcode, with every candidate form', async () => {
    const wrapper = await mountHome({ catalog: true })
    await openScanner(wrapper)

    await scan(wrapper, SCANNED)

    expect(catalogLookups()).toHaveLength(1)
    // The scanned code plus its leading-zero variant: a UPC-A symbol prints 12
    // digits for a product Open Food Facts files under 13.
    expect(catalogLookups()[0].params.p_codes).toContain(SCANNED)
  })

  // The 4,468-product bug. A code that lost a collapse used to reach nothing at
  // all; it now reaches the row that absorbed it, under that row's name.
  it('finds a product by a code that collapsed onto it', async () => {
    const wrapper = await mountHome({ catalog: true })
    await openScanner(wrapper)

    await scan(wrapper, ALT)

    expect(insertedRows()).toHaveLength(1)
    expect(insertedRows()[0].name).toBe('Apa Plata 2L')
    // A hit is an add, and an add closes the camera. Asserting the modal is
    // gone is the same statement as "this was not reported as a miss", and it
    // is the one that survives the scanner being reworked.
    expect(scanner(wrapper).exists()).toBe(false)
  })

  it('still reports a miss when neither database holds the code', async () => {
    const wrapper = await mountHome({ catalog: true })
    await openScanner(wrapper)

    await scan(wrapper, UNKNOWN)

    expect(catalogLookups()).toHaveLength(1)
    expect(insertedRows()).toHaveLength(0)
    expect(scanner(wrapper).props('unknownCode')).toBe(UNKNOWN)
  })

  it('does not ask the catalog twice about the same missed code', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)

    // A barcode sitting in front of the camera is read again every couple of
    // seconds. The answer has not changed, and each re-ask would be a round trip
    // and a flicker through the "looking it up" state.
    await scan(wrapper, UNKNOWN)
    await scan(wrapper, UNKNOWN)

    expect(barcodeQueries()).toHaveLength(1)
    expect(scanner(wrapper).props('unknownCode')).toBe(UNKNOWN)
  })

  it('asks again about a missed code in a later scanning session', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    await scan(wrapper, UNKNOWN)

    scanner(wrapper).vm.$emit('close')
    await flushPromises()
    await openScanner(wrapper)
    await scan(wrapper, UNKNOWN)

    // Naming it in between would have made it findable, so an answer from the
    // previous session is not one to keep trusting.
    expect(barcodeQueries()).toHaveLength(2)
  })

  it('hands a missed code to the naming dialog and closes the camera', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    await scan(wrapper, UNKNOWN)

    scanner(wrapper).vm.$emit('name-unknown', UNKNOWN)
    await flushPromises()

    expect(scanner(wrapper).exists()).toBe(false)
    expect(wrapper.findComponent(CustomProductModal).props('initialBarcode')).toBe(UNKNOWN)
  })

  it('stores the scanned code with the product the user names for it', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    await scan(wrapper, UNKNOWN)
    scanner(wrapper).vm.$emit('name-unknown', UNKNOWN)
    await flushPromises()

    // The payload the dialog really emits: the code is a field in it now, not
    // something HomeView holds on the side.
    wrapper
      .findComponent(CustomProductModal)
      .vm.$emit('submit', { name: 'Lapte 1L', maker: 'Zuzu', barcode: UNKNOWN })
    await flushPromises()

    // The point of the whole miss path: the contributed row carries the code, so
    // the next scan of this package finds it for everyone in the list.
    expect(rpcCalls('add_custom_product')[0].params).toEqual({
      p_list_id: 'fam-1',
      p_name: 'Lapte 1L',
      p_maker: 'Zuzu',
      p_barcode: UNKNOWN,
    })
    // And the code is not a column on the item row.
    expect(insertedRows()[0]).not.toHaveProperty('barcode')
  })

  it('does not carry a scanned code into the next product typed by hand', async () => {
    const wrapper = await mountHome()
    await openScanner(wrapper)
    await scan(wrapper, UNKNOWN)
    scanner(wrapper).vm.$emit('name-unknown', UNKNOWN)
    await flushPromises()

    // Backing out of the naming dialog abandons the code with it.
    wrapper.findComponent(CustomProductModal).vm.$emit('cancel')
    await flushPromises()
    expect(wrapper.findComponent(CustomProductModal).props('initialBarcode')).toBe('')

    wrapper.findComponent(AddItemForm).vm.$emit('update:name', 'Olive Oil')
    await wrapper.vm.$nextTick()
    wrapper
      .findComponent(CustomProductModal)
      .vm.$emit('submit', { name: 'Olive Oil', maker: null, barcode: null })
    await flushPromises()

    expect(rpcCalls('add_custom_product')[0].params.p_barcode).toBeNull()
  })

  it('stores a barcode typed in for a product that was never scanned', async () => {
    // The other half of making the field editable: a product on the counter can
    // be given its code without the camera ever being opened, and the next scan
    // of it finds something.
    const wrapper = await mountHome()
    wrapper.findComponent(AddItemForm).vm.$emit('update:name', 'Olive Oil')
    await wrapper.vm.$nextTick()

    wrapper
      .findComponent(CustomProductModal)
      .vm.$emit('submit', { name: 'Olive Oil', maker: 'Bertolli', barcode: '8001234567890' })
    await flushPromises()

    expect(rpcCalls('add_custom_product')[0].params.p_barcode).toBe('8001234567890')
  })
})

// In the app the code comes from Google's scanner: auto-zoom, no camera
// permission of ours, and its own full-screen UI that closes itself after one
// read. So none of our camera screen is involved, and a miss has nowhere to be
// shown as a row — it goes straight to the naming dialog.
describe('scanning through the native scanner', () => {
  beforeEach(() => {
    mocks.nativeAvailable = true
  })

  it('never opens our camera screen', async () => {
    mocks.nativeScan = vi.fn(async () => ({ ok: true, code: SCANNED }))
    const wrapper = await mountHome()

    await openScanner(wrapper)

    expect(mocks.nativeScan).toHaveBeenCalled()
    expect(scanner(wrapper).exists()).toBe(false)
  })

  it('adds the code it read', async () => {
    mocks.nativeScan = vi.fn(async () => ({ ok: true, code: SCANNED }))
    const wrapper = await mountHome()

    await openScanner(wrapper)

    expect(insertedRows().map((r) => r.name)).toEqual(['Apa Plata 2L'])
    // Asked once. Nothing reopens it.
    expect(mocks.nativeScan).toHaveBeenCalledTimes(1)
    // Nothing of ours was on screen, so the form is never involved.
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('')
    expect(scanner(wrapper).exists()).toBe(false)
  })

  it('does nothing when the user backs out without scanning', async () => {
    // Backing out REJECTS in the plugin, and the lib turns that into ok/null.
    // Treating it as a failure would answer "no thanks" by opening our camera.
    mocks.nativeScan = vi.fn(async () => ({ ok: true, code: null }))
    const wrapper = await mountHome()

    await openScanner(wrapper)

    expect(scanner(wrapper).exists()).toBe(false)
    expect(wrapper.findComponent(CustomProductModal).props('initialBarcode')).toBe('')
    expect(barcodeQueries()).toHaveLength(0)
    expect(wrapper.findComponent(AddItemForm).props('name')).toBe('')
  })

  it('falls back to our camera screen when the native scanner cannot run', async () => {
    // No Play Services, or the scanner module would not install. A device that
    // cannot reach Google's scanner can still have a working camera.
    mocks.nativeScan = vi.fn(async () => ({ ok: false }))
    const wrapper = await mountHome()

    await openScanner(wrapper)

    expect(scanner(wrapper).exists()).toBe(true)
  })
})
