<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, provide, watch } from 'vue'
import { useAuth, useUser } from '@clerk/vue'
import { useRouter } from 'vue-router'
import { useSupabase } from '../supabase'
import AppNavBar from '../components/AppNavBar.vue'
import AppSplash from '../components/AppSplash.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import CustomProductModal from '../components/CustomProductModal.vue'
import ErrorModal from '../components/ErrorModal.vue'
import NotificationPromptModal from '../components/NotificationPromptModal.vue'
import ShoppingList from '../components/ShoppingList.vue'
import AddItemForm from '../components/AddItemForm.vue'
import BarcodeScannerModal from '../components/BarcodeScannerModal.vue'
import OnboardingTour from '../components/OnboardingTour.vue'
import UpdateAvailableModal from '../components/UpdateAvailableModal.vue'
import { useListRealtime } from '../lib/listRealtime'
import { useProductSuggestions } from '../lib/productSuggestions'
import { deviceTimeZone, resolveRegion } from '../lib/region'
import type { ProductSuggestion } from '../lib/productSearch'
import type { ShoppingItemRow } from '../lib/listRealtime'
import { useShoppingListActions, type AddedProduct } from '../lib/shoppingListActions'
import { useBarcodeScanning } from '../lib/useBarcodeScanning'
import { refreshOwnProfile } from '../lib/profile'
import { cleanAuthCallbackUrl } from '../lib/authCallbackUrl'
import {
  clearListSnapshot,
  loadActiveListId,
  saveActiveListId,
  clearActiveListId,
} from '../lib/listCache'
import { useListSnapshot } from '../lib/useListSnapshot'
import { useList } from '../lib/useList'
import { isOfflineError } from '../lib/offlineQueue'
import { identifyUser } from '../lib/errorReporting'
// isCurrentlyOffline is the app's one answer to "are we offline", handed to
// every composable below that has to choose between writing and queueing:
// Capacitor status first, navigator.onLine as the definite-offline backstop.
// See the note in lib/connectivity.
import { isCurrentlyOffline, onReconnect, onlineStatus } from '../lib/connectivity'
import { useRemoteChanges } from '../lib/useRemoteChanges'
import { rememberUser, getRememberedUser } from '../lib/session'
import { useFirstRunGreeting } from '../lib/firstRunGreeting'
import { updateCheckKey, useUpdatePrompt } from '../lib/updatePrompt'
import { syncPushUser } from '../lib/pushNotifications'
import { ITEM_NAME_MAX_LENGTH, ITEM_QUANTITY_MAX } from '../lib/limits'
import { parseQuantity } from '../lib/productSearch'
import { applyUserLocale, getLocale, t, tn } from '../lib/i18n'
import { useShopMap } from '../lib/shopBadges'
import { sumActiveQuantities, sumCheckedQuantities } from '../lib/shoppingList'
import { showToast } from '../lib/useToast'
import type { ListSort } from '../lib/listSections'

const { userId, isLoaded } = useAuth()
const { user } = useUser()
const router = useRouter()
const db = useSupabase()

// Offline, Clerk hasn't loaded and userId is null, but we may have booted from a
// remembered session. Fall back to that id so the cache, offline queue, and new
// rows' authorship all key to the right user until Clerk confirms it online.
// Always a string: every consumer keys storage or rows by it, and '' simply
// finds nothing rather than forcing a null check at each call site.
const effectiveUserId = computed(() => userId.value || getRememberedUser(localStorage) || '')

const items = ref<ShoppingItemRow[]>([])
// Where this person shops, from the device timezone. A getter, read fresh on
// each use, so a phone that has crossed a border answers differently next time.
const region = () => resolveRegion(deviceTimeZone())

// Which shop each listed product came from; see useShopMap.
const shopMap = useShopMap(items, region)
// How the rows to buy are ordered: as added, or grouped by aisle. Remembered on
// this device, because it is a habit ("I always shop by aisle") rather than a
// passing view -- unlike the shop filter below, it hides nothing, so opening
// the app to it can never make an item look missing.
const LIST_SORT_KEY = 'bagful-list-sort'
function readListSort(): ListSort {
  try {
    return localStorage.getItem(LIST_SORT_KEY) === 'aisle' ? 'aisle' : 'added'
  } catch {
    return 'added'
  }
}
const listSort = ref<ListSort>(readListSort())
watch(listSort, (value) => {
  try {
    localStorage.setItem(LIST_SORT_KEY, value)
  } catch {
    // Storage off: the order holds for this session.
  }
})
// Which shop the list is narrowed to, independent of the filter above. With no
// catalog, shopMap is empty, so ShoppingList offers no shops and nothing can
// set this.
const listShop = ref<string | null>(null)
const {
  lists,
  listId,
  listName,
  listInviteCode,
  listOwnerId,
  listItemLimit,
  listEmoji,
  listMembers,
  memberProfileMap,
  loadListHeader,
  loadLists,
  refreshListAfterSettingsChange,
} = useList({ db, userId })
const newItem = ref('')
// What one add puts on the list: 1, unless the typed text named a number (see
// addTyped). The row's own stepper is where a quantity is set, and addItem's
// merge (same product again sums the quantities) turns two taps into two.
const newQty = ref(1)
// Everything behind the search box: the catalog query, this list's purchase
// habits (which rank it), and the regulars offered before anything is typed.
// listProductStats comes back out because the empty state reads it too — the
// same numbers answer "what does this list buy" and "have they ever shopped".
const {
  suggestions,
  suggestionsLoading,
  searchNote,
  selectedProduct,
  searchExpanded,
  canAddCustomProduct,
  searchShop,
  setSearchShop,
  shopOptions,
  listProductStats,
  productStatsLoaded,
  loadListProductStats,
  resetForList,
  recentProducts,
  restartProducts,
  lookupBarcode,
  lastAdded,
  reportAdded,
  clearLastAdded,
  recordProductAdd,
  clearSuggestions,
} = useProductSuggestions({
  db,
  listId,
  items,
  query: newItem,
  isOffline: isCurrentlyOffline,
  // Both resolved per search rather than held in a ref, so a phone that has
  // crossed a border and an app language just switched in Settings each take
  // effect on the next keystroke. Null region is a real answer and means "rank
  // on language and popularity alone".
  region,
  locale: () => getLocale(),
})
// A checkout that just succeeded is proof this list has shopped, available
// immediately rather than after the stats refetch lands.
const boughtThisSession = ref(false)
const loadError = ref('')
const customProductOpen = ref(false)
// The code the custom-product modal is naming, carried from the scan that missed
// so the contributed catalog row can keep it.
const pendingBarcode = ref('')
// The one-time first-run sequence: gesture tour, then the notifications ask.
// Owns its own dialog state; the view renders them and passes the answers back.
const {
  onboardingTourOpen,
  notificationPromptOpen,
  notificationError,
  start: startFirstRunGreeting,
  closeTour: closeOnboardingTour,
  acceptNotifications,
  declineNotifications,
} = useFirstRunGreeting({
  userId,
  isOffline: isCurrentlyOffline,
  // The update offer goes last, after the one-time greeting has had its say.
  onSettled: () => void startUpdateCheck(),
})
// The Android app cannot update itself the way the web app does, so it has to be
// told. A no-op everywhere else — see lib/nativeUpdate.
const appVersion = __APP_VERSION__
const {
  updateOpen,
  updatePhase,
  updateVersion,
  updateProgress,
  start: startUpdateCheck,
  checkNow: checkForUpdateNow,
  install: installUpdate,
  openInstallSettings,
  openReleasesPage,
  dismiss: dismissUpdate,
} = useUpdatePrompt({ currentVersion: appVersion })
// Settings → About runs the same check on demand; see updateCheckKey.
provide(updateCheckKey, checkForUpdateNow)
const hasInitialized = ref(false)
// True while switchList is tearing down the old list and loading the new one.
// Drives the skeleton (instead of the "no items" empty state) so a switch never
// flashes the new list as empty.
const switchingList = ref(false)

// Every write the list can make, with the optimistic bookkeeping around them.
// It owns the in-flight write set and the offline-queue flush, because both
// exist only to keep those writes honest against a racing refetch.
const {
  pendingItemWrites,
  addError,
  limitReachedPopupOpen,
  closeLimitReachedPopup,
  ensureQueueFlushed,
  flushQuantityWrites,
  loadItems,
  addItem,
  toggleItem,
  setItemQuantity,
  removeItemDeferred,
  checkoutItems,
} = useShoppingListActions({
  db,
  items,
  listId,
  userId: effectiveUserId,
  itemLimit: listItemLimit,
  isOffline: isCurrentlyOffline,
  draftName: newItem,
  draftQuantity: newQty,
  selectedProduct,
  loadError,
  reportAdded,
  clearLastAdded,
  recordProductAdd,
  onCheckedOut: () => {
    // The list is empty because it was bought, not because it was never filled.
    boughtThisSession.value = true
    // The checkout just became history, which is the ranking signal — fold it in
    // so what was bought ranks higher on the very next keystroke.
    void loadListProductStats()
  },
})

// Realtime sync (channels, reconnects, watchdog) lives in the composable; it
// registers its own lifecycle listeners and calls back into the loaders below.
const { realtimeHealthy, setupRealtimeSubscriptions, cleanupRealtimeSubscriptions } = useListRealtime({
  db,
  listId,
  hasInitialized,
  items,
  listMembers,
  loadItems,
  loadListHeader,
  onListDeleted: () => void reconcileActiveList(),
  // Being removed from the active list is the same question as the active
  // list vanishing: which list are we in now? Passed directly rather
  // than through a wrapper that only forwarded it.
  refreshMembershipOrRedirect: reconcileActiveList,
  // A realtime UPDATE must not clobber a row whose own write is still in flight
  // (its authoritative echo is still coming) — same guard as loadItems.
  hasPendingWrite: (id) => pendingItemWrites.has(id),
})

const checkedCount = computed(() => items.value.filter((i) => i.checked).length)
// The bar under the list name fills by quantity, not rows; see AppNavBar.
const checkedUnits = computed(() => sumCheckedQuantities(items.value))
const totalUnits = computed(() => checkedUnits.value + sumActiveQuantities(items.value))

// Other members' changes, as much as the screen should say about them: a glow on
// rows they add, and a toast when their checkout empties the cart. See
// lib/useRemoteChanges for why it is only those two.
const { freshIds, markLocal } = useRemoteChanges({
  items,
  userId: () => effectiveUserId.value,
  active: () => hasInitialized.value && !switchingList.value,
  onRemoteCheckout: (count) => showToast({ message: tn('realtime.checkedOut', count) }),
})

function checkout(ids: string[]) {
  markLocal(ids)
  void checkoutItems(ids)
}

// The header's sync pill. Offline is said at once, because it changes what the
// app can do (writes queue, the catalog is out of reach). A dropped realtime
// socket is only said after a grace period: it drops and recovers on its own
// all the time, and a pill flickering on every blip is noise.
const RECONNECT_GRACE_MS = 3000
const realtimeLagging = ref(false)
let realtimeGraceTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => hasInitialized.value && !realtimeHealthy.value,
  (down) => {
    if (realtimeGraceTimer) clearTimeout(realtimeGraceTimer)
    realtimeGraceTimer = null
    if (!down) {
      realtimeLagging.value = false
      return
    }
    realtimeGraceTimer = setTimeout(() => {
      realtimeLagging.value = true
    }, RECONNECT_GRACE_MS)
  },
)
const syncState = computed<'offline' | 'reconnecting' | ''>(() =>
  !onlineStatus.value ? 'offline' : realtimeLagging.value ? 'reconnecting' : '',
)

// The painted cache: what was on screen last time, read back so a returning user
// sees their list rather than skeletons. Owns the paint, the discard and the
// write-back, which have to name the same fields and had drifted apart while
// they lived here — see lib/useListSnapshot.
const {
  paintedFromCache,
  cachedShoppedListId,
  hasSnapshot,
  hydrate: hydrateFromCachedSnapshot,
  discard: discardCachedPaint,
  paintedFor,
  flush: flushSnapshot,
  persist: persistSnapshot,
} = useListSnapshot({
  userId: effectiveUserId,
  hasInitialized,
  refs: {
    listId,
    listName,
    listInviteCode,
    listOwnerId,
    listItemLimit,
    listEmoji,
    listMembers,
    items,
  },
  hasShopped: () => hasShopped.value,
})
// Initial load: nothing painted or fetched yet, and no error to show instead.
// Items arriving (realtime or fetch) end the skeleton early even before
// hasInitialized flips.
const initialLoading = computed(
  () => !hasInitialized.value && !paintedFromCache.value && !items.value.length && !loadError.value,
)
// The skeleton shows on the first-ever load and while switching lists.
const listLoading = computed(() => initialLoading.value || switchingList.value)

// Whether there is a list to draw the screen around at all. Every part of
// this screen is shaped like one: the rows of the list, the list the bar's
// first slot is about, the member stack in the header at the desktop column. A skeleton of that is a promise, and there is one
// account it cannot keep — a brand-new one, which lands here because the router
// only pays for a membership lookup on the way to /list-setup, and is
// replaced by onboarding a round trip later. It saw a mock-up of a shopping
// list it does not have, and then the sign-up flow.
//
// So the chrome waits for evidence rather than assuming it: a list painted
// from the cached snapshot, or one resolved by loadLists. Until then the
// boot splash simply continues, which is the screen the user was already
// looking at. The only case this costs anything is a first sign-in on a new
// device, which trades a skeleton for a splash for the length of one query.
// An error has to reach its dialog, so it ends the wait too.
const listUnknown = computed(
  () => !listId.value && !hasInitialized.value && !loadError.value,
)

// Has this list ever bought anything? Purchase history is the record, but a
// checkout in this session counts before the refetch confirms it.
const hasShopped = computed(
  () =>
    listProductStats.value.size > 0
    || boughtThisSession.value
    // Only while the cached answer is about the list currently on screen.
    || (!!listId.value && cachedShoppedListId.value === listId.value),
)

// The three error channels are independent, so more than one can be set at once
// — a background refresh failing while an add is also rejected, say. Rendering a
// dialog each stacked two overlays on top of each other. Show the first that has
// something to say and leave the rest queued behind it; dismissing reveals the
// next, so nothing is silently dropped.
// Titles resolved per read rather than baked in here: this array is built once
// at setup, so t() calls in it would freeze in whatever language was current
// when HomeView first mounted.
const ERROR_CHANNELS = [
  { ref: () => loadError, title: () => t('error.genericTitle') },
  { ref: () => addError, title: () => t('error.genericTitle') },
  { ref: () => notificationError, title: () => t('settings.notifications') },
]
const activeError = computed(() => {
  const channel = ERROR_CHANNELS.find((c) => c.ref().value)
  if (!channel) return { title: '', message: '', dismiss: () => {} }
  return {
    title: channel.title(),
    message: channel.ref().value,
    dismiss: () => {
      channel.ref().value = ''
      // A boot that failed on a server error never finished, and nothing else
      // runs it again while the network is fine.
      if (!hasInitialized.value) void initializeHome()
    },
  }
})
// The empty list has two opposite readings — "All bought" for a list that
// shops, "Nothing here yet" for one starting out — and picking the wrong one and
// correcting it a moment later is worse than waiting. Hold the empty state until
// the answer is actually known. There are no rows to delay in the meantime;
// this gates nothing but the message itself.
//
// But "known" is not the same as "fetched". The cached snapshot carries the answer
// for the list it describes, and hasShopped above already trusts it — so a
// returning user whose list is empty has no reason to sit in front of a blank
// column for the length of a purchase_history query. That wait was the whole
// delay: the skeleton comes down on the first painted frame and nothing replaced
// it until the fourth round trip of boot landed.
//
// Only ever unblocks the "yes" — cachedShoppedListId is set only when the
// snapshot said this list has shopped, so the genuinely ambiguous case
// still waits for the query, which is what the paragraph above asks for.
const emptyStateAnswerable = computed(
  () =>
    productStatsLoaded.value
    || boughtThisSession.value
    || (!!listId.value && cachedShoppedListId.value === listId.value),
)

// Whether to say the list is empty at all, as opposed to which of the two
// sentences to say.
//
// paintedFromCache counts alongside hasInitialized for the reason initialLoading
// gives above: a painted snapshot is a real list, and an empty one is a real
// answer. Waiting for hasInitialized instead meant waiting for the whole boot
// sequence — lists, header, items, realtime — with the skeleton already
// down, which is a blank column for as long as that takes. The stale reading can
// be wrong (someone added something since the snapshot), and then the rows
// arrive over it; that is the same bargain the cached list itself is already
// making, and it is a better one than showing nothing.
const showEmptyState = computed(
  () =>
    (hasInitialized.value || paintedFromCache.value)
    && !items.value.length
    && !loadError.value
    && !switchingList.value
    && emptyStateAnswerable.value,
)

// The regulars on the empty state are ranked from purchase history, so they
// arrive a beat after the words do now that the words come from the cache. Only
// a list we already know has shopped gets placeholders held for it: one that
// has not is not waiting for anything, and pills that resolve to nothing would be
// a promise the screen cannot keep.
const restartProductsLoading = computed(() => hasShopped.value && !productStatsLoaded.value)

let stopReconnect: (() => void) | null = null

onMounted(() => {
  // The one reconnect signal. lib/connectivity already folds the browser's
  // 'online' event into it, so listening to that event here as well ran the
  // whole sync twice per reconnect.
  stopReconnect = onReconnect(handleBackOnline)
  // The snapshot write is deferred to coalesce bursts, so it can still be
  // outstanding when the app goes away — which on a phone is most of the time,
  // and is exactly the moment the next cold boot depends on it. pagehide is the
  // one teardown event that fires reliably on mobile Safari and in a WebView.
  window.addEventListener('pagehide', flushPendingWork)
  document.addEventListener('visibilitychange', flushPendingWorkIfHidden)
  void initializeHome()
})

onBeforeUnmount(() => {
  if (realtimeGraceTimer) clearTimeout(realtimeGraceTimer)
  window.removeEventListener('pagehide', flushPendingWork)
  document.removeEventListener('visibilitychange', flushPendingWorkIfHidden)
  if (stopReconnect) stopReconnect()
  // No flushing here. Both kinds of deferred work are flushed by the composable
  // that owns them -- the snapshot by useListSnapshot, the quantity writes
  // by useShoppingListActions -- from their own unmount hooks, which run
  // alongside this one.
})

// Picking a suggestion adds it outright rather than filling the input: the pick
// already says exactly which product was meant, so a second confirming tap is
// just friction.
//
// The query stays, and so do its matches: "milk" is usually two kinds of milk,
// and emptying the field would mean typing the word again for the second one.
// Clearing the matches here
// while the text remained would be worse than either: the search is debounced on
// the text changing, so an unchanged query would never fetch them back.
function selectSuggestion(product: ProductSuggestion) {
  void addItem(product)
}

// Deleting is one gesture and undoing it is one tap. The row leaves now; the
// server is told when the toast goes away without Undo being pressed, which
// useToast guarantees for every other way it can go (timeout, pushed out of a
// full stack, the app being backgrounded). Several deletes stack up, each with
// its own Undo.
function deleteItem(item: ShoppingItemRow) {
  markLocal([item.id])
  const pending = removeItemDeferred(item)
  if (!pending) return
  showToast({
    message: t('item.removedToast', { name: item.name }),
    actionLabel: t('common.undo'),
    onAction: pending.undo,
    onExpire: () => void pending.commit(),
  })
}

// What was typed, added. "6 ouă" is six eggs (see parseQuantity), and once the
// row has landed the field empties, ready for the next thing, so Enter does not
// add the same words again.
//
// Emptied only if the add actually landed, which lastAdded changing says (it is
// set synchronously by both the insert and the merge path). A refused add -- the
// item cap, a name too long -- leaves the text where it was, and a failed insert
// puts it back itself.
function addTyped(asCustom: boolean) {
  const { name, quantity } = parseQuantity(newItem.value, ITEM_QUANTITY_MAX)
  if (!name) return
  newQty.value = quantity
  const before = lastAdded.value
  if (asCustom) {
    void addItem({ name, maker: null, custom: true } as AddedProduct)
  } else {
    if (name !== newItem.value.trim()) newItem.value = name
    void addItem()
  }
  newQty.value = 1
  if (lastAdded.value !== before) newItem.value = ''
}

// A custom product joins the list through exactly the same path as a catalog
// pick — it is simply a product the catalog does not have yet. The tag rides
// along so recordProductAdd knows to contribute it rather than bump it; it is
// dropped before the insert, which builds its row from named fields only.
//
// A barcode rides along the same way when the modal was opened from a scan the
// catalog could not answer. That is what turns naming it into a one-time cost:
// the contributed row carries the code, so the next scan of the same package —
// by anyone in the list — finds it.
// The barcode now arrives in the payload rather than being held here: the dialog
// shows it as an optional field, so the user can correct a misread one, clear it,
// or type one in for a product they never scanned at all. This only has to stop
// holding its own copy.
function addCustomProduct(product: ProductSuggestion & { barcode?: string | null }) {
  customProductOpen.value = false
  pendingBarcode.value = ''
  void addItem({ ...product, custom: true } as AddedProduct)
}

function cancelCustomProduct() {
  customProductOpen.value = false
  pendingBarcode.value = ''
}

// ─── Scanning ────────────────────────────────────────────────────────────────
// The camera, the two scanners and what a code means all live in
// lib/useBarcodeScanning. What stays here is the one thing the composable
// deliberately does not own: where a miss goes. The naming dialog below serves
// the typed "Can't find it?" path as well, so it belongs to the view rather than
// to scanning.
const {
  canScan,
  scannerOpen,
  scanBusy,
  scannedUnknown,
  openScanner,
  closeScanner,
  onBarcodeDetected,
  reportUnknown,
} = useBarcodeScanning({
  lookupBarcode,
  addProduct: (product) => void addItem(product as AddedProduct),
  clearSuggestions,
  onUnknownCode: nameUnknownBarcode,
})

// Naming it is a detour off the camera, so the camera has already gone by the
// time this runs: the item lands on the list, which is where the answer belongs
// and where the user ends up.
function nameUnknownBarcode(code: string) {
  pendingBarcode.value = code
  customProductOpen.value = true
}

// Back online: replay writes queued while offline, then re-fetch so local state
// converges on the server's. Reentrancy-safe: reconnect and Clerk-ready can both
// fire, and a trigger arriving mid-sync reruns once more so nothing is missed.
let syncInFlight = false
let syncAgain = false
async function handleBackOnline() {
  if (!hasInitialized.value) {
    // Boot did not finish, so there is nothing to resync: boot again instead.
    void initializeHome()
    return
  }
  if (!effectiveUserId.value || !listId.value) return
  if (syncInFlight) { syncAgain = true; return }
  syncInFlight = true
  try {
    do {
      syncAgain = false
      await ensureQueueFlushed()
      await loadListHeader()
      await loadItems()
      await setupRealtimeSubscriptions()
    } while (syncAgain)
  } finally {
    syncInFlight = false
  }
}

watch([isLoaded, userId], () => {
  // Clerk finished loading after we already booted from cache offline: sync now
  // that it can mint a token, rather than re-running the full init.
  if (hasInitialized.value) {
    if (userId.value) void handleBackOnline()
    return
  }
  void initializeHome()
})

// hasInitialized is only set once the whole sequence below has finished, so it
// cannot keep a second run out while the first is still awaiting. Both entry
// points (onMounted and the Clerk watcher) can fire inside that window — a
// session resolving in another tab is enough — and two overlapping runs mean
// duplicate loadLists/loadItems calls and two sets of realtime channels.
let initializing = false

async function initializeHome() {
  if (hasInitialized.value || initializing) return
  initializing = true
  try {
    await runInitializeHome()
  } finally {
    initializing = false
  }
}

async function runInitializeHome() {
  // Clerk has not confirmed the session yet. A remembered user with a cached
  // snapshot still gets painted right now rather than staring at skeletons for
  // the whole Clerk warm-up: the router already vetted us here, and this is the
  // stale half of stale-while-revalidate. Offline that paint is the entire boot,
  // so we mark ourselves initialized and let reconnection reconcile; online it
  // is just the first frame, and the watch above re-enters below once Clerk
  // resolves.
  if (!isLoaded.value || !userId.value) {
    const uid = effectiveUserId.value
    if (uid && hasSnapshot()) {
      sanitizeAuthCallbackUrl()
      hydrateFromCachedSnapshot()
      if (isCurrentlyOffline()) hasInitialized.value = true
    }
    return
  }

  // Clerk resolved to someone other than the remembered user we painted for:
  // that list belongs to the previous account, so drop it before going on.
  if (!paintedFor(userId.value)) discardCachedPaint()

  // Confirmed signed in: remember this user so a later offline open can boot.
  rememberUser(localStorage, userId.value)
  // Reconcile the language the device guessed with the one this account chose.
  //
  // Same reason identifyUser is here rather than in main.ts: this is the first
  // point there is an account to ask about. initLocale runs pre-mount, before
  // Clerk has resolved, so it can only read the device-wide key — which holds
  // whatever the last person to choose on this browser picked. On a device with
  // one account those agree and this is a no-op; on a shared one it is the only
  // thing that stops everybody booting into the same language.
  //
  // Not awaited, for the reason the three calls below are not: boot must not
  // wait on it. The language chunk lands a tick later and every t() re-renders
  // when it does, so the cost of not waiting is a brief frame in the device's
  // language — which is what the screen would otherwise have shown for good.
  void applyUserLocale(localStorage, userId.value)
  // And tell error reporting who this is, so a crash can say how many people it
  // reached. Here rather than in main.ts because this is the first point the
  // answer is actually known: Clerk has resolved, and the id is the real one
  // rather than the remembered hint effectiveUserId falls back to offline.
  identifyUser(userId.value)
  // Keep our profile row (name + Clerk avatar) current, so a changed photo shows
  // up across every list. Best-effort and non-blocking: boot must not wait on
  // it, and the next load reconciles if it fails. Skipped when nothing changed
  // since this device last wrote it, see refreshOwnProfile.
  void refreshOwnProfile(db, userId.value, user.value, localStorage)
  // Re-bind this device to the account in OneSignal. Signing out detaches it,
  // and without this a device could stay subscribed while belonging to nobody
  // and silently receive nothing. No-op unless notifications
  // were actually turned on. See syncPushUser.
  void syncPushUser(userId.value, localStorage)
  sanitizeAuthCallbackUrl()
  hydrateFromCachedSnapshot()

  // Fetch every list the user belongs to (the account dialog lists them),
  // only once Clerk has finished loading.
  const { error: mErr } = await loadLists()

  if (mErr) {
    // Offline with a cached snapshot already painted: run from local state and
    // let the reconnect handler flush queued writes and reconcile. Realtime is
    // still set up so its reconnect logic takes over once connectivity returns.
    // isOfflineError also catches the WebView case where navigator.onLine lies.
    if (isOfflineError(mErr) && listId.value) {
      await setupRealtimeSubscriptions()
      hasInitialized.value = true
      return
    }
    loadError.value = isOfflineError(mErr)
      ? t('error.offline')
      : t('error.loadListsFailed')
    return
  }

  if (!lists.value.length) {
    clearListSnapshot(localStorage, effectiveUserId.value)
    clearActiveListId(localStorage, effectiveUserId.value)
    router.replace('/list-setup')
    return
  }

  // Restore the last active list if it is still one we belong to, else default
  // to the first; persist the choice so it survives reloads.
  const storedActiveId = loadActiveListId(localStorage, userId.value)
  const activeList =
    lists.value.find((f) => f.id === storedActiveId) || lists.value[0]!
  listId.value = activeList.id
  saveActiveListId(localStorage, effectiveUserId.value, activeList.id)
  // Started here, the moment listId exists, rather than after the three
  // awaits below. Not awaited either way — the list must paint without waiting on
  // a ranking signal, and until it lands suggestions just rank by the global
  // catalog order. But issued last it was the fourth serial round trip of boot,
  // and an empty list has nothing to say until it answers (emptyStateAnswerable).
  // Run alongside the others it is usually back before the items are.
  void loadListProductStats()
  // Writes queued during a previous offline session land before the first
  // fetch, so the list below already reflects them. No-op when the queue is empty.
  // Through the shared single-flight guard, never flushOfflineQueue directly: two
  // flushes read the same head and send it twice.
  await ensureQueueFlushed()
  await loadListHeader()
  await loadItems()
  await setupRealtimeSubscriptions()
  hasInitialized.value = true
  persistSnapshot()
  // The update offer is not called here: it hangs off this sequence's onSettled,
  // so it lands after the tour and the notifications ask rather than racing them.
  startFirstRunGreeting()
}

// Everything owed to somewhere durable when the app goes away. On a phone that
// is most of the time, and is exactly when the next cold boot depends on it.
//
// Two different kinds of debt, both deferred for the same reason (coalescing a
// burst) and both settled here. The snapshot goes to localStorage and is
// synchronous, so it always lands. A quantity write goes to the server and
// cannot be guaranteed — but issuing it now, rather than leaving it to a 300ms
// timer the page may not survive, is the difference between usually landing and
// never landing.
function flushPendingWork() {
  flushSnapshot()
  void flushQuantityWrites()
}

function flushPendingWorkIfHidden() {
  if (document.visibilityState === 'hidden') flushPendingWork()
}

function sanitizeAuthCallbackUrl() {
  const cleanedUrl = cleanAuthCallbackUrl(window.location.href)
  if (cleanedUrl) window.history.replaceState({}, '', cleanedUrl)
}

// Switch which list is active: persist the choice, tear down the old realtime
// channels, and reload everything scoped to the new list.
async function switchList(id: string) {
  if (!id || id === listId.value) return
  if (!lists.value.some((f) => f.id === id)) return
  switchingList.value = true
  // Send the old list's debounced quantity taps before its rows are
  // cleared below. The flush looks each row up in the list, so run after the
  // clear it would find none and drop the taps. It picks
  // its rows up synchronously, so it is not awaited: the switch does not wait
  // on a round trip.
  void flushQuantityWrites()
  listId.value = id
  saveActiveListId(localStorage, effectiveUserId.value, id)
  cleanupRealtimeSubscriptions()
  // Drop the old list's data so none of it flashes under the new name.
  items.value = []
  // The shops come from the previous list's products, so the filter could
  // name one nothing in the new list is sold at.
  listShop.value = null
  listMembers.value = []
  // Everything the suggestions composable holds about the list being left,
  // cleared by the composable itself — it is the only thing that can see all of
  // it. See the note on resetForList.
  resetForList()
  boughtThisSession.value = false
  loadError.value = ''
  // Show the new name straight away (we already know it from the list of lists);
  // only the roster is unknown until loadListHeader returns, so that's all the
  // topbar skeletons.
  const next = lists.value.find((f) => f.id === id)
  if (next) listName.value = next.name
  // Alongside the two fetches below rather than after them, for the reason given
  // in runInitializeHome: the new list's empty list stays blank until this
  // answers, and issued last it answered a round trip after the skeleton came
  // down.
  void loadListProductStats()
  try {
    await loadListHeader()
    await loadItems()
  } finally {
    // The rows are on screen, so the skeleton has nothing left to stand in for.
    // Product stats and the realtime channel are background work; holding the
    // placeholder up behind a websocket handshake just delays the real list.
    switchingList.value = false
  }
  await setupRealtimeSubscriptions()
}

// The account dialog's "join or create" action: the setup page handles both, and
// the guard allows it while under the list cap.
function openAddList() {
  router.push({ name: 'list-setup', query: { add: '1' } })
}

// The active list vanished (deleted, left, or we were removed): move to another
// list we still belong to, or fall back to setup when none remain.
async function reconcileActiveList() {
  const { error } = await loadLists()
  // A failed lookup (network drop, transient server error) must not be read as
  // "no membership" and eject the user — leave them where they are.
  if (error) return
  if (lists.value.some((f) => f.id === listId.value)) return
  if (lists.value.length) {
    await switchList(lists.value[0]!.id)
    return
  }
  cleanupRealtimeSubscriptions()
  clearListSnapshot(localStorage, effectiveUserId.value)
  clearActiveListId(localStorage, effectiveUserId.value)
  router.replace('/list-setup')
}


</script>

<template>
  <!-- Nothing here is worth showing until there is a list for it to be
       about; see listUnknown. -->
  <AppSplash v-if="listUnknown" />
  <div v-else class="dashboard">
    <AppNavBar
      layout="bar"
      :list-id="listId || ''"
      :list-name="listName"
      :lists="lists"
      :loading="initialLoading"
      :sync-state="syncState"
      :total-count="items.length"
      :checked-count="checkedCount"
      :total-units="totalUnits"
      :checked-units="checkedUnits"
      :members-loading="switchingList"
      :invite-code="listInviteCode"
      :list-item-limit="listItemLimit"
      :list-emoji="listEmoji"
      :owner-user-id="listOwnerId"
      :member-profiles="listMembers"
      :current-user-id="effectiveUserId"
      @refresh-list="refreshListAfterSettingsChange"
      @switch-list="switchList"
      @add-list="openAddList"
      @list-deleted="reconcileActiveList"
      @list-left="reconcileActiveList"
      @add-product="selectSuggestion"
      @add="searchExpanded = true"
    />

    <main class="dashboard-main">
      <div class="dashboard-content">

        <!-- The add search. Below 900px it is not in this flow at all: it
             renders as a sheet the bar's centre button raises, and takes up no
             room here until it does. See the media query on .add-slot. -->

        <AddItemForm
          v-model:name="newItem"
          v-model:expanded="searchExpanded"
          :max-length="ITEM_NAME_MAX_LENGTH"
          :suggestions="suggestions"
          :recents="recentProducts"
          :last-added="lastAdded"
          :suggestions-loading="suggestionsLoading"
          :search-note="searchNote"
          :can-add-custom="canAddCustomProduct"
          :can-scan="canScan"
          :shop-options="shopOptions"
          :search-shop="searchShop"
          @select-shop="setSearchShop"
          @submit="addTyped(false)"
          @select="selectSuggestion"
          @add-custom="addTyped(true)"
          @scan="openScanner"
        />

        <ShoppingList
          :items="items"
          :shop-map="shopMap"
          v-model:sort="listSort"
          v-model:shop-filter="listShop"
          :member-profiles="memberProfileMap"
          :fresh-ids="freshIds"
          :loading="listLoading"
          :show-empty="showEmptyState"
          :has-shopped="hasShopped"
          :suggested-products="restartProducts"
          :suggested-products-loading="restartProductsLoading"
          @add="selectSuggestion"
          @toggle="toggleItem"
          @delete="deleteItem"
          @set-quantity="setItemQuantity($event.item, $event.quantity)"
          @checkout="checkout"
        />

      </div>
    </main>

    <ConfirmModal
      :open="limitReachedPopupOpen"
      :title="t('error.limitReachedTitle')"
      :message="t('error.limitReached', { n: listItemLimit })"
      :confirm-text="t('common.gotIt')"
      :show-cancel="false"
      @confirm="closeLimitReachedPopup"
      @cancel="closeLimitReachedPopup"
    />

    <!-- Mounted only once it has been asked for: it holds a camera, and the
         WebView should not be handed one on the way to a shopping list. -->
    <BarcodeScannerModal
      v-if="scannerOpen"
      :open="scannerOpen"
      :busy="scanBusy"
      :unknown-code="scannedUnknown"
      @detected="onBarcodeDetected"
      @name-unknown="reportUnknown"
      @close="closeScanner"
    />

    <CustomProductModal
      :open="customProductOpen"
      :initial-name="newItem"
      :name-max-length="ITEM_NAME_MAX_LENGTH"
      :initial-barcode="pendingBarcode"
      @submit="addCustomProduct"
      @cancel="cancelCustomProduct"
    />

    <OnboardingTour
      :open="onboardingTourOpen"
      :invite-code="listInviteCode"
      @close="closeOnboardingTour"
    />

    <NotificationPromptModal
      :open="notificationPromptOpen"
      @accept="acceptNotifications"
      @decline="declineNotifications"
    />

    <UpdateAvailableModal
      :open="updateOpen"
      :phase="updatePhase"
      :version="updateVersion"
      :current-version="appVersion"
      :progress="updateProgress"
      @install="installUpdate"
      @later="dismissUpdate"
      @open-settings="openInstallSettings"
      @open-releases="openReleasesPage"
      @close="updateOpen = false"
    />

    <ErrorModal
      :title="activeError.title"
      :message="activeError.message"
      @dismiss="activeError.dismiss()"
    />
  </div>
</template>

<style scoped>
.dashboard {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg-main);
}

/* Clears the fixed header above and the action bar below, so the first row
   starts under the header and the last can scroll clear of the bar. */
.dashboard-main {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: calc(var(--header-height) + var(--safe-top) + var(--space-3)) 1rem 0;
  padding-bottom: calc(var(--bottom-clearance) + var(--safe-bottom) + var(--space-6));
}

.dashboard-content {
  width: 100%;
  max-width: 480px;
}

/* Desktop: a phone-width strip looks lost on a big screen. Widen to the shared
   column and add air under the bar; past that, item rows get too long to scan.
   There is no action bar at this width, so the bottom needs only air. */
@media (min-width: 900px) {
  .dashboard-main {
    padding-top: calc(var(--header-height) + 2.5rem + var(--safe-top));
    padding-bottom: calc(2rem + var(--safe-bottom));
  }

  .dashboard-content {
    max-width: var(--desktop-column);
  }
}
</style>

