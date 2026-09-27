<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import ShoppingListItem from './ShoppingListItem.vue'
import SkeletonBlock from './SkeletonBlock.vue'
import ListSortMenu from './ListSortMenu.vue'
import { getProductEmoji } from '../lib/productEmoji'
import { memberDisplayName } from '../lib/userIdentity'
import { productKey } from '../lib/productSearch'
import { buildListEntries, type ListSort } from '../lib/listSections'
import type { ShoppingItemRow, ListMemberProfile } from '../lib/listRealtime'
import type { ProductSuggestion } from '../lib/productSearch'
import { shopLabel, type ShopMap } from '../lib/shopBadges'
import { t, tn } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

// Presentational: renders the list with its move animations, the initial-load
// skeleton, and the empty state. All mutations stay with the parent, which owns
// the items.
//
// The list is two sections read top to bottom: what is still to pick up, then
// what is already in the cart. A ticked row travels down into the cart, so what
// you still have to find is always the top of the screen and it only ever gets
// shorter. See lib/listSections for how the entries are laid out.

// Which shops sell a row's product.
//
// Two lookups, and the second is what makes it work. The catalog answers with
// ITS canonical name and brand; the row on the list carries whatever the person
// picked, which is often a shop's own wording and sometimes has no maker at all
// because they typed it themselves. Falling back to the name alone resolves that
// second case, and an unknown product yields nothing, which renders nothing.
function shopsFor(item: ShoppingItemRow): string[] {
  const map = props.shopMap
  if (map.size === 0) return []
  return map.get(productKey(item.name, item.maker ?? null))
      ?? map.get(productKey(item.name, null))
      ?? []
}
const props = defineProps({
  items: { type: Array as PropType<ShoppingItemRow[]>, default: () => [] },
  // Which shops carry each product, keyed by productKey,
  // resolved by the parent in one call for the whole list -- a row knows a name
  // and a maker and nothing about the catalog, so it cannot look itself up.
  shopMap: {
    type: Map as PropType<ShopMap>,
    default: () => new Map(),
  },
  // Map<user_id, { display_name, image_url }> — the list roster, used to
  // resolve each row's author avatar/name from item.added_by at render time.
  memberProfiles: {
    type: Map as PropType<Map<string, ListMemberProfile>>,
    default: () => new Map(),
  },
  // Rows another member just added, for a brief highlight as they arrive.
  freshIds: { type: Object as PropType<ReadonlySet<string>>, default: () => new Set() },
  loading: { type: Boolean, default: false },
  showEmpty: { type: Boolean, default: false },
  // Whether this list has ever bought anything. An empty list means two
  // different things either side of that, and only one of them is a list
  // waiting to be started.
  hasShopped: { type: Boolean, default: false },
  // The regulars, [{ name, maker }], offered as one-tap adds on the empty
  // list. Empty for a list with no history, which then gets the words alone.
  suggestedProducts: { type: Array as PropType<ProductSuggestion[]>, default: () => [] },
  // The regulars are expected but have not arrived — the purchase history they
  // are ranked from is still in flight. Distinct from having none: one is a gap
  // to hold open, the other is a list with nothing to offer.
  suggestedProductsLoading: { type: Boolean, default: false },
})

// 'added' | 'aisle': how the rows to buy are ordered. A model because the
// control lives in this component's header but the choice belongs to the view,
// which remembers it.
const sort = defineModel<ListSort>('sort', { default: 'added' })
// The shop filter, independent of the one above it. An empty shopMap (no
// catalog configured) means availableShops is empty, so the section that sets
// this never renders.
const shopFilter = defineModel<string | null>('shopFilter', { default: null })

const emit = defineEmits<{
  toggle: [item: ShoppingItemRow]
  delete: [item: ShoppingItemRow]
  checkout: [ids: string[]]
  add: [product: ProductSuggestion]
  'set-quantity': [change: { item: ShoppingItemRow; quantity: number }]
}>()

// Which row has its quantity stepper open, if any. One at a time: two open
// steppers would be two rows claiming the same "this is the one you are editing"
// state, and the second one is always the one you meant.
const openQtyId = ref('')

// A row that leaves while its stepper is open (checked out, deleted, filtered
// away) would otherwise leave the id behind, and the next row to reuse it --
// there isn't one, ids are uuids -- is not the risk. The risk is the stepper
// silently staying "open" on nothing, so a later press to open a different row
// reads as a close.
// Watches the one fact that matters — is the open row still here — rather than
// building a joined string of every id on each change and splitting it again to
// look one up. Same behaviour, and it says what it means.
watch(
  () => openQtyId.value !== '' && !props.items.some((i) => i.id === openQtyId.value),
  (gone) => {
    if (gone) openQtyId.value = ''
  },
)

const uncheckedItems = computed(() => props.items.filter((i) => !i.checked))
const checkedItems = computed(() => props.items.filter((i) => i.checked))

// WE HIDE A ROW ONLY ON POSITIVE EVIDENCE THAT IT IS SOMEWHERE ELSE.
//
// Most things on a list have no shop against them -- typed by hand, or in a
// corner of the catalog no scraper has reached. Treating "we do not know" as
// "not here" would take a shopper's own item off their screen while they stand
// in the shop, and they would have no way to tell that from the shop not
// stocking it. So a row with no shops survives every shop filter, and only a
// row known to be sold somewhere else is hidden.
function keptByShop(item: ShoppingItemRow): boolean {
  if (!shopFilter.value) return true
  const shops = shopsFor(item)
  return shops.length === 0 || shops.includes(shopFilter.value)
}

const visibleItems = computed(() =>
  shopFilter.value ? props.items.filter(keptByShop) : props.items,
)

// The cart folds away to its heading, remembered on this device. Someone
// working down a long list in a shop wants the rows left to find and nothing
// else; someone checking what they already have taps it open.
const CART_COLLAPSED_KEY = 'famcart-cart-collapsed'
function readCartCollapsed(): boolean {
  try {
    return localStorage.getItem(CART_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}
const cartCollapsed = ref(readCartCollapsed())

// Folding the cart is not the rows going anywhere, so it must not borrow the
// list's leave animation: that takes each leaving row out of flow, and a whole
// cart of them stacked up onto one spot on their way out, which read as the
// products flying up. Folding removes them at once; unfolding fades them in
// where they belong. Cleared once the list has settled.
const foldMode = ref<'' | 'fold' | 'unfold'>('')
let foldTimer: ReturnType<typeof setTimeout> | null = null

function toggleCart() {
  foldMode.value = cartCollapsed.value ? 'unfold' : 'fold'
  if (foldTimer) clearTimeout(foldTimer)
  foldTimer = setTimeout(() => {
    foldMode.value = ''
  }, 400)
  cartCollapsed.value = !cartCollapsed.value
  try {
    localStorage.setItem(CART_COLLAPSED_KEY, cartCollapsed.value ? '1' : '0')
  } catch {
    // Storage off: the choice holds for this session and is simply not kept.
  }
}

const entries = computed(() =>
  buildListEntries(visibleItems.value, { sort: sort.value, cartCollapsed: cartCollapsed.value }),
)

// Only shops something on this list is actually sold at, so the menu can never
// offer one that would empty the list, and the counts beside them are what
// picking one would really leave -- unknowns included, by the rule above.
const availableShops = computed(() => {
  const seen = new Set<string>()
  for (const item of props.items) for (const shop of shopsFor(item)) seen.add(shop)
  return [...seen].sort()
})

const shopCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const shop of availableShops.value) {
    counts[shop] = props.items.filter((item) => {
      const shops = shopsFor(item)
      return shops.length === 0 || shops.includes(shop)
    }).length
  }
  return counts
})

// Everything each row needs, worked out once per render instead of per row
// inside the v-for. The drain lookups were the reason: indexOf() per row over
// the draining list is quadratic in the row count.
const rowMeta = computed(() => {
  const drainOrder = new Map(drainingIds.value.map((id, index) => [id, index]))
  const meta = new Map<string, {
    avatarUrl: string | undefined
    avatarName: string
    draining: boolean
    drainIndex: number
  }>()
  for (const item of visibleItems.value) {
    const profile = props.memberProfiles.get(item.added_by ?? '')
    meta.set(item.id, {
      avatarUrl: profile?.image_url || undefined,
      avatarName: memberDisplayName(profile),
      draining: drainOrder.has(item.id),
      drainIndex: drainOrder.get(item.id) ?? 0,
    })
  }
  return meta
})

// Rows, not units, everywhere a count is shown: "Grapes x4" is one thing to
// find. The quantity is on the row itself.
const toBuyCount = computed(() => uncheckedItems.value.length)

// The list has rows, the shop filter just hides all of them. Distinct from the
// empty state, which means there is nothing to buy at all.
const filteredToNothing = computed(
  () => !props.loading && props.items.length > 0 && visibleItems.value.length === 0,
)

const checkedCount = computed(() => checkedItems.value.length)

const skeletonNameWidths = ['55%', '38%', '62%', '30%']

// Placeholder pills for the empty state's one-tap adds. Fixed widths rather than
// percentages, because a chip is sized by its own name and not by the row it sits
// in — and three uneven ones read as products where three equal ones read as a
// loading bar cut into pieces.
//
// Each carries the plus glyph's width as well as a name's: the placeholder draws
// no plus, since a mark saying "tap to add" on something that cannot be tapped is
// a lie, but the pill still has to come out the size a real pill comes out.
const skeletonChipWidths = ['4.4rem', '6.6rem', '5.2rem']

// The "Buy again" block has something to show, or is about to. Kept as one
// question so the label and the chips appear and leave together: a heading over
// nothing is worse than no heading.
const showRestart = computed(
  () => props.suggestedProducts.length > 0 || props.suggestedProductsLoading,
)

// ─── Checkout action ─────────────────────────────────────────────────────────
// The bar owns the celebration: it drains the checked rows into the cart and
// morphs to a check, then hands the ids up so the parent archives them. Removal
// is deferred to the end of the animation so the rows are still on screen while
// they drain.
const DRAIN_MS = 550
const STAGGER_MS = 55
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const buying = ref(false)
const buttonSuccess = ref(false)
const drainingIds = ref<string[]>([])

// The checkout the user has already confirmed, held until the drain finishes.
// Non-null means the emit is still owed to the parent — the animation is the
// only thing outstanding, so it must survive whatever interrupts it.
let pendingCheckout: string[] | null = null
let drainTimer: ReturnType<typeof setTimeout> | null = null
let successTimer: ReturnType<typeof setTimeout> | null = null

function startCheckout() {
  if (buying.value || !checkedItems.value.length) return
  const ids = checkedItems.value.map((i) => i.id)
  buying.value = true
  buttonSuccess.value = true
  pendingCheckout = ids
  // Park the thumb at the end of the track for the success state, whichever
  // path got us here (a completed drag already has it there; the keyboard
  // path animates it across).
  maxTravel = maxTravel || measureTravel()
  dragX.value = maxTravel

  if (prefersReducedMotion) {
    finishCheckout(ids)
    return
  }

  drainingIds.value = ids
  // Wait out the last row's fall (its delay + one drain duration) before the
  // parent removes them, so nothing pops out mid-animation.
  const total = DRAIN_MS + Math.min(ids.length - 1, 6) * STAGGER_MS
  drainTimer = setTimeout(() => finishCheckout(ids), total)
}

function finishCheckout(ids: string[]) {
  // Idempotent: the drain timer and the unmount flush can both reach here, and
  // archiving the same checkout twice would be a second RPC for nothing.
  if (!pendingCheckout) return
  pendingCheckout = null
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
  }
  emit('checkout', ids)
  drainingIds.value = []
  buying.value = false
  // Let the success tick linger a beat; the bar usually unmounts before this
  // fires because the checked list just emptied. On a failed checkout the parent
  // restores the items and the bar reappears cleanly in its idle state.
  successTimer = setTimeout(() => {
    buttonSuccess.value = false
    dragX.value = 0
  }, 260)
}

onBeforeUnmount(() => {
  // Flushed BEFORE the timers are cleared, not after. Unmounting mid-drain (a
  // route change, a list switch tearing the list down) used to drop the
  // checkout on the floor: the timer died with the component and the rows
  // stayed checked in the database, having told the user they were bought. The
  // confirmation already happened, so it is flushed here.
  //
  // But finishCheckout arms the success timer on its way out, so running it
  // after the clears left that fresh timer to outlive the component. It only
  // touches two refs of an instance nobody is rendering, which is why nothing
  // ever showed — the ordering is the whole fix.
  if (pendingCheckout) finishCheckout(pendingCheckout)
  if (drainTimer) clearTimeout(drainTimer)
  if (successTimer) clearTimeout(successTimer)
  clearNudge()
  if (foldTimer) clearTimeout(foldTimer)
})

// ─── Slide to confirm ─────────────────────────────────────────────────────────
// Checking out archives the whole checked section, so the bar is a
// slide-to-confirm control rather than a tap target: drag the thumb across the
// track to trigger it. Below the completion threshold the thumb snaps back.
// Keyboard users are not made to simulate a drag: Enter/Space on the focused
// thumb (a click with detail 0) checks out directly.
const THUMB_SIZE = 56 // px; keep in sync with .buy-bar__thumb
const TRACK_HEIGHT = 53 // px; keep in sync with .buy-bar__track
// How far the thumb stands proud of the track, on every side: the track is
// inset by this much at its two ends as well as being this much shorter above
// and below. Keep in sync with .buy-bar__track's left and right.
const TRACK_INSET = (THUMB_SIZE - TRACK_HEIGHT) / 2
const THUMB_INSET = 0 // px gap between thumb and track edge; the thumb sits flush
const COMPLETE_AT = 0.85 // fraction of the travel that counts as done

const barEl = ref<HTMLElement | null>(null)
const thumbEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
const dragX = ref(0)
let activePointerId: number | null = null
let grabOffsetX = 0
let maxTravel = 0

function measureTravel() {
  if (!barEl.value || !thumbEl.value) return 0
  return Math.max(0, barEl.value.clientWidth - thumbEl.value.offsetWidth - THUMB_INSET * 2)
}

function onThumbDown(e: PointerEvent) {
  if (buying.value) return
  clearNudge()
  nudging.value = false
  maxTravel = measureTravel()
  if (!maxTravel) return
  dragging.value = true
  activePointerId = e.pointerId
  grabOffsetX = e.clientX - dragX.value
  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
}

function onThumbMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointerId) return
  dragX.value = Math.min(Math.max(e.clientX - grabOffsetX, 0), maxTravel)
}

function onThumbUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointerId) return
  dragging.value = false
  activePointerId = null
  if (dragX.value >= maxTravel * COMPLETE_AT) {
    startCheckout()
  } else {
    // A slide that stopped short glides home. The release is also a click,
    // which starts the helper; note when the glide ends so the helper waits for
    // it rather than grabbing the knob halfway back.
    if (dragX.value > 0) snapBackEndsAt = performance.now() + SNAP_BACK_MS
    dragX.value = 0
  }
}

function onThumbCancel() {
  dragging.value = false
  activePointerId = null
  dragX.value = 0
}

// A pointer click must not check out — requiring the slide is the point. A
// keyboard activation of the button arrives as a click with detail === 0.
//
// But a tap is somebody trying, and answering it with nothing reads as broken.
// So the thumb leans along the track twice, the way you would show somebody the
// gesture, and the label says it in words.
//
// The lean is dragX itself, stepped through a few positions, not an animation
// on the thumb. The thumb, the green trail and the white copy of the label all
// follow dragX on the same transition, so they travel together; a keyframe on
// the thumb alone left the trail and the label behind, and fought the thumb's
// own inline transform besides.
const NUDGE_STEPS: [number, number][] = [
  [28, 0],
  [0, 240],
  [14, 480],
  [0, 680],
]
// How long a short slide takes to glide back (the thumb's --transition-slow),
// and the pause after it before the helper starts, so the knob is seen to come
// to rest first.
const SNAP_BACK_MS = 280
const AFTER_SNAP_BACK_MS = 150
let snapBackEndsAt = 0
// The words arrive with the lean, so the knob showing the gesture and the label
// naming it are one moment, and stay a little past the knob coming home (the
// last step lands at 680ms and travels 280ms).
const NUDGE_HINT_MS = 1600
const nudging = ref(false)
let nudgeTimers: ReturnType<typeof setTimeout>[] = []

function clearNudge() {
  for (const timer of nudgeTimers) clearTimeout(timer)
  nudgeTimers = []
}

function onThumbClick(e: MouseEvent) {
  if (e.detail === 0) {
    startCheckout()
    return
  }
  if (buying.value || dragX.value > 0) return
  clearNudge()
  // After a slide that stopped short the knob is still gliding home; everything
  // below starts once it is there and has sat still for a beat.
  const remaining = snapBackEndsAt - performance.now()
  const start = remaining > 0 && !prefersReducedMotion ? remaining + AFTER_SNAP_BACK_MS : 0
  snapBackEndsAt = 0
  if (!prefersReducedMotion) {
    for (const [x, at] of NUDGE_STEPS) {
      nudgeTimers.push(
        setTimeout(() => {
          if (!dragging.value && !buying.value) dragX.value = x
        }, start + at),
      )
    }
  }
  // Without the lean there is nothing to wait for, so the words come at once.
  const hintAt = start
  nudgeTimers.push(
    setTimeout(() => {
      if (!dragging.value && !buying.value) nudging.value = true
    }, hintAt),
  )
  nudgeTimers.push(
    setTimeout(() => {
      nudging.value = false
    }, hintAt + NUDGE_HINT_MS),
  )
}

const thumbStyle = computed(() => ({ transform: `translateX(${dragX.value}px)` }))
// The green trail's rounded end sits under the middle of the thumb, which is
// taller than the track and so covers that end completely: the trail reads as
// coming out of the knob. Success pins it to the full track.
// The fill lives inside the track, which starts TRACK_INSET in from the bar.
const fillWidth = computed(
  () => THUMB_INSET + THUMB_SIZE / 2 + TRACK_HEIGHT / 2 + dragX.value - TRACK_INSET,
)
const fillStyle = computed(() => ({
  width: buttonSuccess.value ? '100%' : `${fillWidth.value}px`,
}))
// A white copy of the label is clipped to the swept region, so the hint text
// turns white where the green has covered it. The clip line sits at the
// thumb's midline — under the solid knob — not at the trail's leading edge:
// clipping at the edge flipped letters white a few pixels ahead of the knob
// (visibly so around its rounded nose).
const inverseLabelStyle = computed(() => ({
  clipPath: buttonSuccess.value
    ? 'inset(0 0 0 0)'
    : `inset(0 calc(100% - ${THUMB_INSET + THUMB_SIZE / 2 + dragX.value - TRACK_INSET}px) 0 0)`,
}))
// Which message the label is showing, as a key for its transition, and which
// way the words travel: the hint arrives from above and leaves the way it came,
// so a tap reads as the hint dropping in and lifting back out.
const labelKey = computed(() => (buttonSuccess.value ? 'done' : nudging.value ? 'hint' : 'count'))
const labelMotion = ref<'down' | 'up'>('down')
watch(nudging, (on) => {
  labelMotion.value = on ? 'down' : 'up'
})

const labelText = computed(() =>
  buttonSuccess.value
    ? t('list.buyBar.checkedOut')
    : nudging.value
      ? t('list.buyBar.slideHint')
      : tn('list.buyBar.slide', checkedCount.value),
)
</script>

<template>
  <div class="list-meta" v-if="!loading && items.length">
    <span class="list-meta__label">
      {{ toBuyCount ? t('list.meta.toBuy') : t('list.meta.allPicked') }}
    </span>
    <span class="list-meta__spacer"></span>
    <ListSortMenu
      v-model="sort"
      v-model:shop="shopFilter"
      :items="items"
      :shops="availableShops"
      :shop-counts="shopCounts"
    />
  </div>

  <!-- Skeleton rows while the first fetch is in flight, or the real list: never
       both. They are separate <ul>s stacked in flow, so rendering them together
       showed placeholders sitting on top of the rows they stand in for, which
       then jumped up as the skeletons unmounted. -->
  <ul v-if="loading" class="item-list" aria-hidden="true">
    <!-- Emoji tile, name, avatar — the row's three fixed parts, at the row's own
         sizes. There is deliberately no circle in front of the tile: that stood
         in for a checkbox the row has not had since checking became a swipe, so
         it was promising a control that never arrived. -->
    <li v-for="(nameWidth, idx) in skeletonNameWidths" :key="idx" class="skeleton-item">
      <SkeletonBlock class="skeleton-item__tile" width="2.25rem" height="2.25rem" radius="var(--radius-tile)" />
      <SkeletonBlock class="skeleton-item__name" :width="nameWidth" height="0.95rem" />
      <SkeletonBlock width="var(--size-avatar-sm)" height="var(--size-avatar-sm)" radius="var(--radius-pill)" />
    </li>
  </ul>

  <!-- One TransitionGroup for headings and rows alike, so a ticked row is seen
       travelling down into the cart rather than blinking from one list into
       another. The headings are list items so the list's own semantics stay a
       plain list; each one names the rows under it. -->
  <TransitionGroup
    v-else
    tag="ul"
    name="row"
    class="item-list"
    :class="{ 'item-list--fold': foldMode === 'fold', 'item-list--unfold': foldMode === 'unfold' }"
  >
    <template v-for="entry in entries" :key="entry.key">
      <li v-if="entry.kind === 'aisle'" class="list-heading">
        {{ t(`aisle.${entry.aisle}`) }}
      </li>
      <li v-else-if="entry.kind === 'cart'" class="list-heading list-heading--cart">
        <button
          type="button"
          class="cart-toggle"
          :aria-expanded="!cartCollapsed"
          @click="toggleCart"
        >
          <AppIcon class="cart-toggle__icon" name="shopping-cart" />
          <span class="cart-toggle__label">{{ t('list.cart.heading') }}</span>
          <span class="cart-toggle__count">{{ entry.count }}</span>
          <AppIcon
            class="cart-toggle__chevron"
            :class="{ 'cart-toggle__chevron--open': !cartCollapsed }"
            name="chevron-right"
          />
        </button>
      </li>
      <ShoppingListItem
        v-else
        :item="entry.item"
        :avatar-url="rowMeta.get(entry.item.id)?.avatarUrl"
        :avatar-name="rowMeta.get(entry.item.id)?.avatarName ?? ''"
        :draining="rowMeta.get(entry.item.id)?.draining ?? false"
        :drain-index="rowMeta.get(entry.item.id)?.drainIndex ?? 0"
        :fresh="freshIds.has(entry.item.id)"
        :shops="shopsFor(entry.item)"
        :qty-open="entry.item.id === openQtyId"
        @toggle="$emit('toggle', $event)"
        @delete="$emit('delete', $event)"
        @set-quantity="$emit('set-quantity', $event)"
        @open-quantity="openQtyId = $event"
        @close-quantity="openQtyId = ''"
      />
    </template>
  </TransitionGroup>

  <p v-if="filteredToNothing && shopFilter" class="filter-empty">
    {{ t('list.filteredEmpty.shop', { shop: shopLabel(shopFilter) }) }}
  </p>

  <!-- Keeps the last checked row clear of the fixed buy bar. -->
  <div v-if="checkedItems.length && !loading" class="buy-bar-spacer" aria-hidden="true"></div>

  <!-- An empty grocery list is usually a finished one, not a broken one: for a
       list that shops, this screen is what checking out leaves behind. And
       the thing they are most likely to want from it is not a message — it is
       the next list, which for groceries is largely the same as the last one.
       So the regulars are here as one tap each, and the screen is a way to
       start rather than a notice that there is nothing to see. -->
  <div v-if="showEmpty" class="empty-state">
    <p class="empty-state__title">{{ hasShopped ? t('list.empty.titleShopped') : t('list.empty.titleNew') }}</p>
    <p class="empty-state__text">
      {{ hasShopped ? t('list.empty.textShopped') : t('list.empty.textNew') }}
    </p>

    <!-- Same name as the search screen's section, because it is the same idea
         and one name for it is how it gets learned. -->
    <div v-if="showRestart" class="restart">
      <p class="restart__label">{{ t('list.buyAgain') }}</p>

      <!-- The words above arrive from the cached snapshot, on the first painted
           frame; the chips have to wait for the purchase history to say which
           products they are. Without something standing in that gap the screen
           resolves twice — a title alone, then pills shoving it up a row a
           moment later. Placeholders in the pills' own shape hold the space so
           the real ones land where these stood. -->
      <div v-if="suggestedProductsLoading" class="restart__chips" aria-hidden="true">
        <span v-for="(width, idx) in skeletonChipWidths" :key="idx" class="chip chip--skeleton">
          <SkeletonBlock width="1.15rem" height="1.15rem" radius="var(--radius-pill)" />
          <SkeletonBlock :width="width" height="0.8rem" />
        </span>
      </div>

      <div v-else class="restart__chips">
        <button
          v-for="product in suggestedProducts"
          :key="productKey(product.name, product.maker)"
          type="button"
          class="chip"
          :aria-label="t('list.addProduct', { name: product.name })"
          @click="emit('add', product)"
        >
          <span class="chip__emoji" aria-hidden="true">
            {{ getProductEmoji(product.name, product.maker || '') }}
          </span>
          <span class="chip__name">{{ product.name }}</span>
          <span class="chip__plus" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  </div>

  <!-- Floating checkout slider: appears whenever something is checked. -->
  <Transition name="buybar">
    <div v-if="checkedItems.length && !loading" class="buy-bar-wrap">
      <div
        ref="barEl"
        class="buy-bar"
        :class="{
          'buy-bar--success': buttonSuccess,
          'buy-bar--dragging': dragging,
        }"
      >
        <!-- The track is thinner than the thumb, so it is its own element: the
             bar itself cannot clip, or the thumb standing proud of the track
             would be cut off at the top and bottom. -->
        <div class="buy-bar__track">
          <div class="buy-bar__fill" :style="fillStyle" aria-hidden="true"></div>
          <!-- Each label is a clipped slot the words slide through: a new
               message drops in from above as the old one leaves below, and
               the hint going away plays that backwards. The white copy runs
               the same transition in the same slot, so the two stay one line
               of text wherever the green trail cuts it. -->
          <span class="buy-bar__label">
            <span class="buy-bar__slot">
              <Transition :name="`label-${labelMotion}`">
                <span :key="labelKey" class="buy-bar__text">{{ labelText }}</span>
              </Transition>
            </span>
          </span>
          <span class="buy-bar__label buy-bar__label--inverse" :style="inverseLabelStyle" aria-hidden="true">
            <span class="buy-bar__slot">
              <Transition :name="`label-${labelMotion}`">
                <span :key="labelKey" class="buy-bar__text">{{ labelText }}</span>
              </Transition>
            </span>
          </span>
        </div>
        <button
          ref="thumbEl"
          class="buy-bar__thumb"
          type="button"
          :style="thumbStyle"
          :disabled="buying"
          :aria-label="tn('list.buyBar.checkOut', checkedCount)"
          @pointerdown="onThumbDown"
          @pointermove="onThumbMove"
          @pointerup="onThumbUp"
          @pointercancel="onThumbCancel"
          @click="onThumbClick"
        >
          <span class="buy-bar__icon" aria-hidden="true">
            <AppIcon class="buy-bar__cart" name="shopping-cart" />
            <AppIcon class="buy-bar__check" name="check" />
          </span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Meta — names whichever list is on screen, and carries the filter button.
   Centred rather than baseline-aligned now that a control sits in the row. */
.list-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--size-control-sm);
  margin-top: 0.15rem;
  margin-bottom: 0.6rem;
  padding: 0 0.15rem;
}

.list-meta__label {
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.list-meta__spacer {
  margin-left: auto;
}


/* Mirrors ShoppingListItem's .item card so rows swap in without layout shift */
/* Box-for-box .item plus .item-face: same border, radius, gap and padding, so
   the tile and the name sit where the real row is about to put them and the
   swap moves nothing. The left padding is .item-face's 0.9rem rather than a
   rounder 0.75rem for that reason alone. */
.skeleton-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 60px;
  padding: 0.5rem 0.25rem;
}

.skeleton-item__name {
  margin-right: auto;
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* An aisle's name, or the cart's. Quiet: it groups the rows under it, and the
   rows are what you read. */
.list-heading {
  padding: var(--space-5) 0.25rem var(--space-1);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.list-heading:first-child {
  padding-top: var(--space-1);
}

.list-heading--cart {
  padding: var(--space-6) 0 var(--space-1);
  text-transform: none;
  letter-spacing: 0;
}

/* The cart's heading is also its switch, so it is built like a row: the same
   inline padding, the icon centred in a slot as wide as the emoji tile, and the
   same gap after it, so "In cart" starts exactly where the item names do and
   the cart reads as part of the list's grid rather than something laid over it. */
.cart-toggle {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-height: 48px;
  padding: 0 0.25rem;
  border: none;
  border-radius: var(--radius-lg);
  background: none;
  color: var(--text-primary);
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  text-align: left;
  cursor: pointer;
}

/* Filled at rest, not only on hover: it is the one control in the list that
   is a bar rather than a row, and on a phone (where there is no hover) it
   read as a plain heading. Hover and press each go a step further. */
.cart-toggle {
  background: var(--bg-hover);
}

@media (hover: hover) {
  .cart-toggle:hover {
    background: var(--bg-press);
  }
}

.cart-toggle:active {
  background: color-mix(in srgb, var(--bg-press), var(--text-primary) 6%);
}

.cart-toggle__icon {
  flex-shrink: 0;
  width: 2.5rem;
  height: 18px;
  display: flex;
  justify-content: center;
  color: var(--color-primary);
}

.cart-toggle__icon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.cart-toggle__chevron :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.cart-toggle__count {
  min-width: 1.5rem;
  padding: 0 0.4rem;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary-text);
  font-size: var(--text-xs);
  line-height: 1.5rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.cart-toggle__chevron {
  width: 16px;
  height: 16px;
  margin-left: auto;
  margin-right: var(--space-2);
  color: var(--text-secondary);
  transition: transform var(--transition-base) var(--ease-standard);
}

.cart-toggle__chevron--open {
  transform: rotate(90deg);
}

/* Rows still animate for the things that genuinely move them: something added,
   removed, or checked out. Ticking is no longer one of those. */
.row-move {
  transition: transform var(--transition-slow) var(--ease-rise);
  will-change: transform;
}

.row-enter-active {
  transition: opacity var(--transition-slow) var(--ease-rise), transform var(--transition-slow) var(--ease-rise);
}

.row-leave-active {
  transition: opacity var(--transition-base) ease, transform var(--transition-base) ease;
  position: absolute;
  width: 100%;
  pointer-events: none;
  z-index: 2;
}

/* Gone on the spot, not for one frame out of flow and stacked on its
   neighbours, which is what an unanimated leave still costs. */
.item-list--fold > .row-leave-active {
  display: none;
}

.item-list--fold > .row-move {
  transition: none;
}

.item-list--unfold > .row-enter-active {
  transition: opacity var(--transition-slow) var(--ease-rise);
}

.item-list--unfold > .row-enter-from {
  transform: none;
}

.row-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.995);
}

.row-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.995);
}

/* Not the empty state: the list has rows, this filter just has none of them.
   Quieter than the real empty state, because nothing is wrong. */
.filter-empty {
  margin: var(--space-6) 0 var(--space-4);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--text-disabled);
}

/* Empty state.
   Left-aligned on .list-meta's inset — the list's own left edge — so it reads
   as this list having nothing in it rather than as a widget parked in the
   middle of the screen. No card and no tinted icon tile; the chips below are
   the substance, and the words are just enough to say where you are. */
.empty-state {
  margin: 2.25rem 0 0;
  padding: 0 0.15rem;
}

.empty-state__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xl);
  font-weight: var(--weight-extrabold);
  /* The app's heading tracking. At this size the default spacing reads loose. */
  letter-spacing: -0.02em;
  line-height: var(--leading-tight);
  text-wrap: balance;
  color: var(--text-primary);
}

/* ~34ch is the measure where a line of this size still scans in one go. */
.empty-state__text {
  margin: 0;
  max-width: 34ch;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
  text-wrap: pretty;
}

/* Deliberately NOT the shape of an item row — these are things that are not on
   the list yet, and a row would say the opposite. Pills, wrapping, sized to
   their own names. */
.restart {
  margin-top: var(--space-5);
}

/* Mirrors .list-meta__label: both name what the things under them are. */
.restart__label {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-disabled);
}

.restart__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  /* 40px: comfortably tappable without the pills turning into buttons. */
  min-height: 40px;
  max-width: 100%;
  /* Wider on the emoji end than the plus end. The two glyphs are not the same
     kind of thing: an emoji is a filled image sitting nearly edge to edge in its
     box, while plus.svg is a Lucide stroke drawn from 4.5 to 19.5 of a 24 box,
     so roughly a fifth of its width is whitespace it brings with it -- about
     2.5px at this size. The 0.1rem difference here cancels that, leaving the two
     marks about equally far from the pill's ends.

     It used to be 0.45rem before the emoji and 0.7rem after the plus, which
     tilted the same way the glyphs already do and made the emoji look jammed
     against the edge. Exact balance is not worth chasing past this: emoji side
     bearings differ by platform, so the last pixel is not ours to set. */
  padding: 0.3rem 0.55rem 0.3rem 0.65rem;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast),
    transform var(--transition-fast) var(--ease-standard);
}

.chip:hover,
.chip:focus-visible {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--bg-surface));
}

/* The pill's own shape, borrowed whole so the real chips land exactly where
   these stood. It is a span, not a button: nothing here can be pressed yet, and
   pointer-events keeps the hover styling above from suggesting otherwise. */
.chip--skeleton {
  pointer-events: none;
  cursor: default;
}

/* Presses in rather than lifting: the chip is going onto the list, not away. */
.chip:active {
  transform: scale(0.97);
}

.chip__emoji {
  flex-shrink: 0;
  font-size: var(--text-md);
  line-height: 1;
}

/* The catalog carries some long names; the emoji does most of the recognising,
   so the tail can go rather than the row wrapping to three lines. */
.chip__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The same plus as the add button, at the size of a hint: what the tap does,
   said once per chip without a word. */
.chip__plus {
  flex-shrink: 0;
  width: 0.85rem;
  height: 0.85rem;
  margin-left: 0.05rem;
  background-color: var(--color-primary);
  mask: url('../assets/plus.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/plus.svg') no-repeat center / contain;
}

@media (prefers-reduced-motion: reduce) {
  .chip {
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }

  .chip:active {
    transform: none;
  }
}

/* Buy bar */
/* Keeps the last checked row clear of the slider, which floats over the end of
   the list. Generous rather than exact: the cost of too much is a little air
   under the last row, the cost of too little is a checked row hiding behind the
   slider that checks it out. */
.buy-bar-spacer {
  height: 84px;
}

/* Just above the action bar on a phone: the two are one assembly read from the
   bottom up, the way to add and then the thing this trip is for. From the
   desktop column up there is no bar and it sits on the bottom edge. */
.buy-bar-wrap {
  position: fixed;
  left: 0;
  right: 0;
  /* A few pixels of air over the bar's disc, so the two do not read as touching. */
  bottom: calc(var(--bottom-clearance) + var(--safe-bottom) + 4px);
  /* Over the list, under the composer's fade (--z-composer), which never
     reaches this high. */
  z-index: calc(var(--z-composer) - 1);
  display: flex;
  justify-content: center;
  padding: 0 1rem;
  /* Only the button should catch taps; the rest of the strip is see-through. */
  pointer-events: none;
}

/* A fade of the page's own colour behind the slider, so rows scrolling
   underneath dissolve rather than cutting across the pill. */
.buy-bar-wrap::before {
  content: '';
  position: absolute;
  z-index: -1;
  left: 0;
  right: 0;
  top: -2rem;
  bottom: -0.5rem;
  background: linear-gradient(
    to top,
    color-mix(in oklab, var(--bg-main) 92%, transparent) 60%,
    color-mix(in oklab, var(--bg-main) 0%, transparent)
  );
  pointer-events: none;
}

/* The bar is only the thumb's height and the drag's width. What is drawn is
   the track inside it, a thinner pill, with the thumb standing a little proud
   of it above and below, like a switch's knob. */
.buy-bar {
  pointer-events: auto;
  position: relative;
  width: 100%;
  max-width: 480px;
  height: 56px; /* THUMB_SIZE */
  color: var(--color-primary);
}

.buy-bar__track {
  position: absolute;
  /* Inset at the ends by as much as it is shorter than the thumb above and
     below, so the thumb stands equally proud all round. TRACK_INSET. */
  left: 1.5px;
  right: 1.5px;
  top: 50%;
  height: 53px; /* keep in sync with TRACK_HEIGHT */
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  box-shadow: var(--elevation-soft);
  overflow: hidden; /* the fill and the labels stay inside the pill */
}

/* Green trail the thumb leaves behind as it crosses the white track. A tint
   of the thumb's green (mixed toward the surface so it tracks the theme) —
   light enough that the solid knob reads as a distinct button riding on its
   own trail, dark enough that the inverse (white) label stays readable. */
.buy-bar__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-primary) 80%, var(--bg-surface));
  pointer-events: none;
  transition: width var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}

.buy-bar__label {
  position: relative;
  z-index: 1;
  /* Keep the hint clear of the thumb's resting spot. */
  padding: 0 3.4rem;
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.01em;
  pointer-events: none;
}

/* One line tall and clipped, so a message sliding in or out is cut off at the
   line rather than drifting over the thumb or the pill's edge. Both messages
   share one grid cell while they cross. */
.buy-bar__slot {
  display: inline-grid;
  overflow: hidden;
  line-height: 1.4;
  vertical-align: middle;
}

.buy-bar__text {
  grid-area: 1 / 1;
  white-space: nowrap;
  text-align: center;
}

.label-down-enter-active,
.label-down-leave-active,
.label-up-enter-active,
.label-up-leave-active {
  transition:
    transform var(--transition-slow) var(--ease-rise),
    opacity var(--transition-slow) var(--ease-rise);
}

.label-down-enter-from,
.label-up-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

.label-down-leave-to,
.label-up-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

/* White copy of the label, clipped to the green fill: the text reads white
   exactly where the trail has swept over it and green where it hasn't. */
.buy-bar__label--inverse {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-inverse);
  transition: clip-path var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}

/* The thumb keeps the full-strength green so it stands out as the grabbable
   knob against the lighter trail behind it. It must be painted (not
   transparent): it sits above the labels, so a solid thumb blots out text it
   crosses; a transparent one let the letters show through inside the knob. */
.buy-bar__thumb {
  position: absolute;
  /* At the bar's left end, covering the track's rounded end entirely: the
     track is 53px and this is 56px, so it stands 1.5px proud above and below. */
  left: 0;
  top: 0;
  z-index: 2;
  width: 56px; /* keep in sync with THUMB_SIZE */
  height: 56px;
  box-shadow: var(--elevation-primary);
  border: none;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  /* The drag owns the gesture; don't let touch scroll the page instead. */
  touch-action: none;
  transition: transform var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}

.buy-bar__thumb:disabled {
  cursor: default;
}

/* The thumb is invisible, so keyboard focus draws its own ring on the green
   disc beneath. */
.buy-bar__thumb:focus-visible {
  outline: var(--border-width-thick) solid var(--text-inverse);
  outline-offset: -4px;
}

/* While the finger drives the thumb, everything follows it instantly; the
   transitions above are for the snap back/forward on release. */
.buy-bar--dragging .buy-bar__thumb,
.buy-bar--dragging .buy-bar__fill,
.buy-bar--dragging .buy-bar__label {
  transition: none;
}

.buy-bar--dragging .buy-bar__thumb {
  cursor: grabbing;
}

.buy-bar__icon {
  position: relative;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  transition: transform var(--transition-fast) ease;
}

/* The icon gives under the finger while it is held, the way a pressed button
   does. It used to swell instead, which read backwards. */
.buy-bar--dragging .buy-bar__icon {
  transform: scale(0.88);
}

.buy-bar__cart,
.buy-bar__check {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  transition: opacity var(--transition-base) ease, transform var(--transition-slow) cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Both assets ship at stroke-width 1, too fine for a 22px knob icon. */
.buy-bar__cart :deep(svg),
.buy-bar__check :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  fill: none;
}

.buy-bar__cart :deep(svg) {
  stroke-width: 2;
}

.buy-bar__check :deep(svg) {
  stroke-width: 2.4;
}

/* Cart is the resting state; on success it lifts away and the check drops in. */
.buy-bar__cart {
  opacity: 1;
  transform: scale(1) translateY(0);
}

.buy-bar__check {
  opacity: 0;
  transform: scale(0.4) translateY(-6px);
}

.buy-bar--success .buy-bar__cart {
  opacity: 0;
  transform: scale(0.4) translateY(6px);
}

.buy-bar--success .buy-bar__check {
  opacity: 1;
  transform: scale(1) translateY(0);
}

/* Bar slide-in/out */
.buybar-enter-active {
  transition: opacity var(--transition-base) ease, transform var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}

.buybar-leave-active {
  transition: opacity var(--transition-base) ease, transform var(--transition-base) ease;
}

.buybar-enter-from,
.buybar-leave-to {
  opacity: 0;
  transform: translateY(16px);
}

@media (prefers-reduced-motion: reduce) {
  .label-down-enter-from,
  .label-down-leave-to,
  .label-up-enter-from,
  .label-up-leave-to {
    transform: none;
  }

  .row-move,
  .cart-toggle__chevron {
    transition: none;
  }

  .buy-bar__fill,
  .buy-bar__thumb,
  .buy-bar__label,
  .buy-bar__cart,
  .buy-bar__check,
  .buybar-enter-active,
  .buybar-leave-active {
    transition: none;
  }
}

@media (min-width: 900px) {
  .buy-bar-wrap {
    bottom: calc(1rem + var(--safe-bottom));
  }

  .buy-bar-wrap::before {
    bottom: calc(-1 * (1rem + var(--safe-bottom)));
  }
}
</style>
