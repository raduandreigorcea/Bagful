<script setup lang="ts">
// One-time first-run tour. Six beats (search, scan, quantity, swipe, check out,
// invite) covering everything on the list screen that is not obvious by looking
// at it. Rendered by HomeView over the real list; dismissing marks it seen.
//
// The pictures are the app, not drawings of it. The quantity and swipe beats
// mount the real ShoppingListItem with sample rows and play the gesture on it:
// the tour presses the stepper's own buttons, and drives the swipe through the
// row's demoOffset, so every colour, panel and animation is the list's own and
// cannot drift from it. The rest cannot be mounted (the search screen takes the
// whole viewport and raises the keyboard, the scanner needs a camera, the buy
// bar lives inside ShoppingList), so those are rebuilt from AddItemForm's,
// BarcodeScannerModal's and ShoppingList's own values. A grey dot plays the
// finger, the way Android's "show taps" does.
//
// The card never changes height. The picture frame is a fixed size, every beat's
// text is laid out in one grid cell so the tallest decides the block, and each
// scene is positioned inside the frame rather than sized by it.
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import AppModal from './AppModal.vue'
import ShoppingListItem from './ShoppingListItem.vue'
import { useCopyFeedback } from '../lib/clipboard'
import BackButton from './BackButton.vue'
import { t, tn } from '../lib/i18n'
import { getProductEmoji } from '../lib/productEmoji'
import type { ShoppingItemRow } from '../lib/listRealtime'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  inviteCode: { type: String, default: '' },
})

const emit = defineEmits<{ close: [] }>()

const step = ref(0)
// 1800ms here rather than the 2000ms default, which is what this tour already
// used — the step it sits on is short and the confirmation should not outlive it.
const { copied, copy } = useCopyFeedback(1800)

// Written against what the app actually does. Tapping a suggestion adds it
// outright (HomeView.selectSuggestion calls addItem directly), and checking a
// row does not buy it: buy_items only runs once the bar is slid.
//
// A computed, not a plain array. Built once at setup, plain t() calls here
// would freeze every step in whatever language was current when this
// component first mounted and never follow a change made from settings.
const steps = computed(() => [
  { key: 'add', title: t('tour.add.title'), body: t('tour.add.body') },
  { key: 'scan', title: t('tour.scan.title'), body: t('tour.scan.body') },
  { key: 'qty', title: t('tour.qty.title'), body: t('tour.qty.body') },
  { key: 'swipe', title: t('tour.swipe.title'), body: t('tour.swipe.body') },
  { key: 'checkout', title: t('tour.checkout.title'), body: t('tour.checkout.body') },
  { key: 'invite', title: t('tour.invite.title'), body: t('tour.invite.body') },
])

// Falls back to the first beat rather than to nothing. `step` is only ever
// moved by next() and back(), which both stay in range, so the fallback is
// unreachable today -- but the alternative is a `current?.` everywhere below,
// each of which would render an empty tour rather than say anything.
const current = computed(() => steps.value[step.value] ?? steps.value[0]!)
const isLast = computed(() => step.value === steps.value.length - 1)

// Restart at the first beat each time it opens.
watch(() => props.open, (open) => {
  if (open) {
    step.value = 0
    copied.value = false
  }
})

function next() {
  if (isLast.value) return finish()
  step.value += 1
}
function back() {
  if (step.value > 0) step.value -= 1
}
function finish() {
  emit('close')
}

function copyCode() {
  // Shared with OverviewPanel via lib/clipboard, which also owns the timer this
  // used to leak — and stacked, so two taps could cancel each other's tick.
  // A blocked clipboard leaves `copied` false; the code is on screen to type.
  void copy(props.inviteCode)
}

// ─── Scenes ──────────────────────────────────────────────────────────────────
// Placeholder people for the rows' "who added it" avatar. Without a picture the
// row draws the fallback initial, and a column of "M" for Member reads as a bug
// rather than as three people sharing a list.
const face = (bg: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="${bg}"/>` +
      '<circle cx="20" cy="16" r="7" fill="#fff" fill-opacity=".92"/>' +
      '<path d="M6 40c1.6-8.4 7-12.6 14-12.6S32.4 31.6 34 40z" fill="#fff" fill-opacity=".92"/></svg>',
  )
const AVATARS = [face('#6fb39b'), face('#e3a063'), face('#9489d4')]

// Sample products whose names are the same word in all six languages, so the
// rows need no translating and getProductEmoji (which knows English and
// Romanian) gives each the right picture everywhere. "Milch" or "Latte" would
// have come out as a shopping bag and a coffee. `who` picks the avatar and
// travels with the row, so a row leaving does not reshuffle the faces.
const row = (id: string, name: string, who: number, quantity = 1, checked = false): ShoppingItemRow => ({
  id, name, quantity, checked, maker: null, created_at: '', who,
})
const avatarOf = (item: ShoppingItemRow) => AVATARS[Number(item.who) % AVATARS.length]

// Asked for stillness, each scene is set straight to the frame that tells its
// story and nothing is scheduled.
const reducedMotion =
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const artRef = ref<HTMLElement | null>(null)
const finger = reactive({ x: 0, y: 0, shown: false, down: false })

let timers: ReturnType<typeof setTimeout>[] = []
let frame = 0
function at(ms: number, fn: () => void) {
  timers.push(setTimeout(fn, ms))
}
function stopScene() {
  timers.forEach(clearTimeout)
  timers = []
  cancelAnimationFrame(frame)
  finger.shown = false
  finger.down = false
}

// Where an element's centre sits inside the picture frame. Measured at the
// moment the finger moves, never cached, so it holds in every language and at
// every width.
function centreOf(selector: string): { x: number; y: number } | null {
  const art = artRef.value
  const el = art?.querySelector(selector)
  if (!art || !el) return null
  const a = art.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return {
    x: r.left - a.left - art.clientLeft + r.width / 2,
    y: r.top - a.top - art.clientTop + r.height / 2,
  }
}

// Puts the finger on a point. It never travels to get there: a finger that
// slides in from the side looks like a drag, which is a different gesture. On a
// new target it fades out and comes back where it is needed.
function place(p: { x: number; y: number }) {
  const moved = finger.shown && (Math.abs(p.x - finger.x) > 4 || Math.abs(p.y - finger.y) > 4)
  const show = () => {
    finger.x = p.x
    finger.y = p.y
    finger.shown = true
  }
  if (!moved) return show()
  finger.shown = false
  at(180, show)
}

// The finger appears on an element, presses (it shrinks, as Android's tap dot
// does), and lets go. Returns when it let go, so a scene reads as a sequence.
// By default the press is a real click on the element: on a mounted
// ShoppingListItem that runs the component's own handler.
function tap(ms: number, selector: string, onTap?: () => void): number {
  at(ms, () => {
    const p = centreOf(selector)
    if (p) place(p)
  })
  at(ms + 450, () => (finger.down = true))
  at(ms + 600, () => {
    finger.down = false
    if (onTap) onTap()
    else artRef.value?.querySelector<HTMLElement>(selector)?.click()
  })
  return ms + 600
}

function lift(ms: number) {
  at(ms, () => (finger.shown = false))
}

function tween(ms: number, fn: (k: number) => void) {
  const start = performance.now()
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / ms)
    fn(k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)
    if (k < 1) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}

// Search: the query types itself, the matches come in under it, one is tapped
// and wears its tick. The phone's search screen, since that is where it happens.
const SEARCH_QUERY = 'mozz'
const SEARCH_RESULTS = ['Mozzarella', 'Mozzarella light', 'Mozzarella di bufala']
const query = ref('')
const addedResult = ref(-1)

function playSearch() {
  query.value = ''
  addedResult.value = -1
  if (reducedMotion) {
    query.value = SEARCH_QUERY
    addedResult.value = 0
    return
  }
  const typed = 700 + SEARCH_QUERY.length * 170
  for (let i = 1; i <= SEARCH_QUERY.length; i++) {
    at(700 + i * 170, () => (query.value = SEARCH_QUERY.slice(0, i)))
  }
  const done = tap(typed + 500, '.art-result', () => (addedResult.value = 0))
  lift(done + 500)
  at(done + 2600, playSearch)
}

// Scan: the barcode button in the empty box, the camera, the read, and the
// product landing on the list with the glow a new row gets.
const scanRows = ref<ShoppingItemRow[]>([])
const scanPhase = ref<'list' | 'camera' | 'hit'>('list')
const freshId = ref('')

function playScan() {
  scanRows.value = [row('s1', 'Kiwi', 0), row('s2', 'Pasta', 1)]
  scanPhase.value = 'list'
  freshId.value = ''
  if (reducedMotion) {
    scanPhase.value = 'hit'
    return
  }
  const opened = tap(700, '.art-field__btn', () => (scanPhase.value = 'camera'))
  lift(opened + 300)
  at(opened + 1500, () => (scanPhase.value = 'hit'))
  at(opened + 1900, () => {
    scanPhase.value = 'list'
    scanRows.value = [...scanRows.value, row('s3', 'Muesli', 2)]
    freshId.value = 's3'
  })
  at(opened + 4800, playScan)
}

// Quantity: the tour presses the real stepper. The count animates the way the
// list animates it, and the control puts itself away on its own idle timer.
const qtyRows = ref<ShoppingItemRow[]>([])
const qtyOpenId = ref<string | null>(null)

function setQuantity({ item, quantity }: { item: ShoppingItemRow; quantity: number }) {
  qtyRows.value = qtyRows.value.map((r) => (r.id === item.id ? { ...r, quantity } : r))
}
function closeQuantity() {
  // Held open when motion is off: the still frame is the open stepper.
  if (!reducedMotion) qtyOpenId.value = null
}

function playQty() {
  qtyRows.value = [row('q1', 'Pizza', 0), row('q2', 'Kiwi', 1, reducedMotion ? 3 : 1), row('q3', 'Espresso', 2)]
  qtyOpenId.value = reducedMotion ? 'q2' : null
  if (reducedMotion) return
  const face = '[data-demo="q2"] .item-qty__face'
  const plus = '[data-demo="q2"] .item-qty__step:last-child'
  let ms = tap(700, face)
  ms = tap(ms + 450, plus)
  ms = tap(ms + 150, plus)
  lift(ms + 350)
  // The row's own 2s idle closes it; the loop waits for that and a beat more.
  at(ms + 3800, playQty)
}

// Swipe: a real row pulled right until it arms and ticks, then another pulled
// left until it arms and goes.
const swipeRows = ref<ShoppingItemRow[]>([])
const swipeOffsets = reactive<Record<string, number | null>>({})

// A drag: the finger lands at `from` (a point it measures when the time comes),
// presses, travels `to` pixels with `onMove` told how far along it is, and lets
// go. The travel is the gesture, so this is the one place the finger moves.
function drag(
  ms: number,
  from: () => { x: number; y: number } | null,
  to: () => number,
  onMove: (dx: number) => void,
  onRelease: () => void,
): number {
  let start = { x: 0, y: 0 }
  let distance = 0
  at(ms, () => {
    const p = from()
    if (!p) return
    start = p
    place(p)
  })
  at(ms + 400, () => (finger.down = true))
  at(ms + 520, () => {
    distance = to()
    tween(750, (k) => {
      onMove(distance * k)
      finger.x = start.x + distance * k
    })
  })
  at(ms + 520 + 750 + 380, () => {
    finger.down = false
    onRelease()
  })
  return ms + 520 + 750 + 380
}

// Pulled well past the point where each side arms, the way a thumb does, so the
// panel has room for its words: at the bare threshold "Got it" ran into the row.
const SWIPE_RIGHT = 170
const SWIPE_LEFT = -190

function swipeRow(ms: number, id: string, to: number, onRelease: () => void): number {
  // Grabbed a little in from the side it is pulled away from.
  const from = () => {
    const p = centreOf(`[data-demo="${id}"] .item-face`)
    return p && { x: p.x + (to > 0 ? -60 : 60), y: p.y }
  }
  return drag(ms, from, () => to, (dx) => (swipeOffsets[id] = dx), () => {
    swipeOffsets[id] = null
    onRelease()
  })
}

function playSwipe() {
  swipeRows.value = [row('w1', 'Mango', 0), row('w2', 'Croissant', 1), row('w3', 'Ketchup', 2)]
  for (const id of Object.keys(swipeOffsets)) swipeOffsets[id] = null
  if (reducedMotion) {
    swipeOffsets.w2 = SWIPE_RIGHT
    return
  }
  let ms = swipeRow(700, 'w2', SWIPE_RIGHT, () => {
    swipeRows.value = swipeRows.value.map((r) => (r.id === 'w2' ? { ...r, checked: true } : r))
  })
  lift(ms + 200)
  ms = swipeRow(ms + 900, 'w3', SWIPE_LEFT, () => {
    swipeRows.value = swipeRows.value.filter((r) => r.id !== 'w3')
  })
  lift(ms + 200)
  at(ms + 2200, playSwipe)
}

// Check out: ShoppingList's buy bar at its real size (a 56px knob standing
// proud of a 53px track) with its real arithmetic for the trail and the white
// label, dragged to the end. Then the checked rows drain the way they do in the
// list. The bar lives inside ShoppingList and cannot be mounted alone, so this
// is its markup and its numbers; keep them in step with it.
const BUY_THUMB = 56
const BUY_TRACK = 53
const BUY_INSET = (BUY_THUMB - BUY_TRACK) / 2

const buyRows = ref<ShoppingItemRow[]>([])
const buyX = ref(0)
const buyDragging = ref(false)
const buySuccess = ref(false)
const buyDraining = ref(false)
const buyCount = ref(2)

const buyFill = computed(() =>
  buySuccess.value ? '100%' : `${BUY_THUMB / 2 + BUY_TRACK / 2 + buyX.value - BUY_INSET}px`,
)
const buyClip = computed(() =>
  buySuccess.value
    ? 'inset(0 0 0 0)'
    : `inset(0 calc(100% - ${BUY_THUMB / 2 + buyX.value - BUY_INSET}px) 0 0)`,
)
const buyTravel = () => (artRef.value?.querySelector<HTMLElement>('.art-buy')?.clientWidth ?? 0) - BUY_THUMB

function playCheckout() {
  buyRows.value = [row('b1', 'Kiwi', 0, 1, true), row('b2', 'Croissant', 1, 1, true)]
  buyCount.value = buyRows.value.length
  buyX.value = 0
  buyDragging.value = false
  buySuccess.value = false
  buyDraining.value = false
  if (reducedMotion) {
    // Parked mid journey once there is a bar to measure.
    at(450, () => (buyX.value = buyTravel() / 2))
    return
  }
  const ms = drag(
    700,
    () => centreOf('.art-buy__thumb'),
    buyTravel,
    (dx) => {
      buyDragging.value = true
      buyX.value = dx
    },
    () => {
      buyDragging.value = false
      buySuccess.value = true
    },
  )
  lift(ms + 150)
  at(ms + 450, () => (buyDraining.value = true))
  at(ms + 1300, () => (buyRows.value = []))
  at(ms + 2600, playCheckout)
}

const scenes: Record<string, () => void> = {
  add: playSearch,
  scan: playScan,
  qty: playQty,
  swipe: playSwipe,
  checkout: playCheckout,
}

watch(
  [() => props.open, () => current.value.key],
  ([open, key]) => {
    stopScene()
    if (open) scenes[key]?.()
  },
  { immediate: true },
)
onBeforeUnmount(stopScene)
</script>

<template>
  <!-- No backdrop dismissal, as before: a first-run tour is finished or skipped
       on purpose, not clicked away by accident. Escape is new, and does what
       Skip does — every other dialog answers to it, and a tour is the last
       thing that should feel like a trap. -->
  <AppModal
    :open="open"
    overlay-class="tour-overlay"
    transition="tour-fade"
    :close-on-backdrop="false"
    @close="finish"
  >
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div class="tour-top">
          <button class="tour-skip" type="button" @click="finish">{{ t('tour.skip') }}</button>
        </div>

        <!-- A fixed frame; only what is inside it changes. The scenes are inert
             as well as hidden from a screen reader: they hold real buttons (the
             list rows' own), and a picture must not take focus or a tap. -->
        <div ref="artRef" class="tour-art" aria-hidden="true">
          <Transition name="tour-step" mode="out-in">
            <!-- eslint-disable vue/no-bare-strings-in-template -- sample product
                 names, the same word in every language, and decorative glyphs;
                 the block is aria-hidden and the words beside it come from t() -->

            <!-- Search, as the phone's search screen: field on top, matches
                 running edge to edge under it. -->
            <div v-if="current.key === 'add'" key="add" class="scene" inert>
              <div class="art-field art-field--focus">
                <span class="art-field__text">
                  <span v-if="query">{{ query }}</span><span class="art-caret"></span><span
                    v-if="!query"
                    class="art-field__placeholder"
                  >{{ t('add.inputPlaceholder') }}</span>
                </span>
                <span class="art-field__btn">
                  <AppIcon class="art-field__icon art-field__scan" :class="{ 'art-field__icon--off': query }" name="scan-barcode" />
                  <span class="art-field__icon art-field__add" :class="{ 'art-field__icon--off': !query }"></span>
                </span>
              </div>
              <ul class="art-results" :class="{ 'art-results--on': query.length >= 2 }">
                <li
                  v-for="(name, i) in SEARCH_RESULTS"
                  :key="name"
                  class="art-result"
                  :class="{ 'art-result--added': addedResult === i }"
                >
                  <span class="art-result__emoji">
                    {{ getProductEmoji(name, '') }}
                    <AppIcon class="art-result__tick" name="check" />
                  </span>
                  <span class="art-result__name">{{ name }}</span>
                </li>
              </ul>
            </div>

            <!-- Scan: the empty box's button is the scanner. -->
            <div v-else-if="current.key === 'scan'" key="scan" class="scene" inert>
              <div class="art-field">
                <span class="art-field__text">
                  <span class="art-field__placeholder">{{ t('add.inputPlaceholder') }}</span>
                </span>
                <span class="art-field__btn">
                  <AppIcon class="art-field__icon art-field__scan" name="scan-barcode" />
                </span>
              </div>
              <TransitionGroup tag="ul" name="art-row" class="art-list">
                <ShoppingListItem
                  v-for="item in scanRows"
                  :key="item.id"
                  :data-demo="item.id"
                  :item="item"
                  :avatar-url="avatarOf(item)"
                  :fresh="item.id === freshId"
                />
              </TransitionGroup>
              <Transition name="art-camera">
                <div v-if="scanPhase !== 'list'" class="art-camera">
                  <div class="art-viewfinder" :class="{ 'art-viewfinder--hit': scanPhase === 'hit' }">
                    <span class="art-label">
                      <span class="art-label__bars"></span>
                      <span class="art-label__digits">5 941234 567890</span>
                    </span>
                    <span class="art-corner art-corner--tl"></span>
                    <span class="art-corner art-corner--tr"></span>
                    <span class="art-corner art-corner--bl"></span>
                    <span class="art-corner art-corner--br"></span>
                  </div>
                  <p class="art-camera__hint">{{ t('scanner.pointCamera') }}</p>
                </div>
              </Transition>
            </div>

            <!-- Quantity: real rows, real stepper. -->
            <div v-else-if="current.key === 'qty'" key="qty" class="scene scene--rows" inert>
              <TransitionGroup tag="ul" name="art-row" class="art-list">
                <ShoppingListItem
                  v-for="item in qtyRows"
                  :key="item.id"
                  :data-demo="item.id"
                  :item="item"
                  :avatar-url="avatarOf(item)"
                  :qty-open="qtyOpenId === item.id"
                  @open-quantity="qtyOpenId = $event"
                  @close-quantity="closeQuantity"
                  @set-quantity="setQuantity"
                />
              </TransitionGroup>
            </div>

            <!-- Swipe: real rows, driven through demoOffset. -->
            <div v-else-if="current.key === 'swipe'" key="swipe" class="scene scene--rows" inert>
              <TransitionGroup tag="ul" name="art-row" class="art-list">
                <ShoppingListItem
                  v-for="item in swipeRows"
                  :key="item.id"
                  :data-demo="item.id"
                  :item="item"
                  :avatar-url="avatarOf(item)"
                  :demo-offset="swipeOffsets[item.id] ?? null"
                />
              </TransitionGroup>
            </div>

            <!-- Check out: real checked rows, and the buy bar under them. Checking
                 a row does not buy it; this slide does. -->
            <div v-else-if="current.key === 'checkout'" key="checkout" class="scene scene--rows scene--buy" inert>
              <TransitionGroup tag="ul" name="art-row" class="art-list">
                <ShoppingListItem
                  v-for="(item, i) in buyRows"
                  :key="item.id"
                  :data-demo="item.id"
                  :item="item"
                  :avatar-url="avatarOf(item)"
                  :draining="buyDraining"
                  :drain-index="i"
                />
              </TransitionGroup>
              <div
                class="art-buy"
                :class="{ 'art-buy--success': buySuccess, 'art-buy--dragging': buyDragging }"
              >
                <div class="art-buy__track">
                  <div class="art-buy__fill" :style="{ width: buyFill }"></div>
                  <span class="art-buy__label">{{
                    buySuccess ? t('list.buyBar.checkedOut') : tn('list.buyBar.slide', buyCount)
                  }}</span>
                  <!-- The white copy, clipped to the swept region, exactly as the
                       real bar turns its letters white under the trail. -->
                  <span class="art-buy__label art-buy__label--inverse" :style="{ clipPath: buyClip }">{{
                    buySuccess ? t('list.buyBar.checkedOut') : tn('list.buyBar.slide', buyCount)
                  }}</span>
                </div>
                <span class="art-buy__thumb" :style="{ transform: `translateX(${buyX}px)` }">
                  <span class="art-buy__icon">
                    <AppIcon class="art-buy__cart" name="shopping-cart" />
                    <AppIcon class="art-buy__check" name="check" />
                  </span>
                </span>
              </div>
            </div>

            <!-- Invite: no gesture to teach here, so nothing moves. Not inert:
                 the code copies. -->
            <div v-else key="invite" class="scene scene--centre">
              <div class="art-invite">
                <button
                  class="art-code"
                  type="button"
                  :aria-label="
                    inviteCode
                      ? t('tour.copyInviteCode', { code: inviteCode })
                      : t('tour.inviteCodeLabel')
                  "
                  @click="copyCode"
                >
                  <span class="art-code__value">{{ inviteCode || '••••••••' }}</span>
                  <span class="art-code__copy">{{ copied ? t('overview.copied') : t('common.copy') }}</span>
                </button>
                <div class="art-people">
                  <span>🧑</span><span>👩</span><span>🧒</span>
                </div>
              </div>
            </div>
            <!-- eslint-enable vue/no-bare-strings-in-template -->
          </Transition>

          <!-- Placed with the `translate` property, not `transform`. The press
               is the `scale` property, and CSS applies `scale` before
               `transform`: positioned by transform, the press scaled the
               finger's distance from the frame's corner too, so every tap
               threw it up and to the left. `translate` is applied before
               `scale`, so the dot shrinks where it is. -->
          <span
            class="tour-finger"
            :class="{
              'tour-finger--shown': finger.shown,
              'tour-finger--down': finger.down,
            }"
            :style="{ translate: `${finger.x}px ${finger.y}px` }"
          ></span>
        </div>

        <!-- Every beat's words in one cell: the tallest sets the height, so the
             card stays put from the first beat to the last, in any language. -->
        <div class="tour-copy">
          <div
            v-for="(s, i) in steps"
            :key="s.key"
            class="tour-copy__step"
            :class="{ 'tour-copy__step--on': i === step }"
            :aria-hidden="i === step ? undefined : 'true'"
          >
            <h3 :id="i === step ? 'tour-title' : undefined" class="tour-title">{{ s.title }}</h3>
            <p class="tour-body">{{ s.body }}</p>
          </div>
        </div>

        <div class="tour-dots" aria-hidden="true">
          <span
            v-for="(s, i) in steps"
            :key="s.key"
            class="tour-dot"
            :class="{ 'tour-dot--active': i === step }"
          ></span>
        </div>

        <div class="tour-actions">
          <BackButton v-if="step > 0" @click="back" />
          <button class="tour-next" type="button" @click="next">
            {{ isLast ? t('tour.start') : t('tour.next') }}
          </button>
        </div>
      </div>
  </AppModal>
</template>

<style scoped>
.tour-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: var(--overlay-dark-strong);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-5) + var(--safe-bottom));
}

@media (min-width: 640px) {
  .tour-overlay { align-items: center; }
}

.tour-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-dialog);
  padding: var(--space-4) var(--space-5) var(--space-6);
  animation: modal-rise-in var(--transition-slow) var(--ease-rise);
}

.tour-top {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--space-2);
}

.tour-skip {
  background: var(--bg-hover);
  border: var(--border-width-thin) solid var(--border-main);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.01em;
  cursor: pointer;
  padding: 0.4rem 0.8rem;
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.tour-skip:hover {
  color: var(--text-primary);
  background: var(--bg-surface-alt);
  border-color: var(--border-dark);
}

/* ── Picture frame ──
   One fixed size for every beat. Tall enough for the scan scene, the fullest:
   the search field and three list rows. */
.tour-art {
  position: relative;
  width: 100%;
  height: 268px;
  border-radius: var(--radius-2xl);
  /* The app's own list background, so a real row sits on the grey it sits on
     in the list. */
  background: var(--bg-main);
  border: var(--border-width-thin) solid var(--border-main);
  margin-bottom: var(--space-5);
  overflow: hidden;
}

.scene {
  position: absolute;
  inset: 0;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  text-align: left;
}

/* Rows start at one fixed line, so a row leaving does not recentre the rest.
   That line centres three 60px rows in the 268px frame. */
.scene--rows { padding-top: 44px; }
.scene--centre { align-items: center; justify-content: center; }

/* ── The finger ──
   Android's "show taps" dot: a grey disc with a light rim. It appears where it
   presses and never slides in; a tap is it shrinking and growing back. The only
   time it moves is a drag, where it tracks the row or the knob exactly. */
.tour-finger {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-primary) 22%, transparent);
  border: 2px solid color-mix(in srgb, #fff 80%, transparent);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.2);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s ease, scale 0.14s ease, background 0.14s ease;
}
.tour-finger--shown { opacity: 1; }
.tour-finger--down {
  scale: 0.72;
  background: color-mix(in srgb, var(--text-primary) 34%, transparent);
}

/* ── Search field ──
   AddItemForm's .add-row and .add-btn, value for value. */
.art-field {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-2xl);
  overflow: hidden;
}
.art-field--focus { border-color: var(--color-primary); }
.art-field__text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0.85rem 1rem;
  font-size: var(--text-md);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}
.art-field__placeholder { color: var(--text-disabled); }
.art-caret {
  width: 1.5px;
  height: 1.15em;
  margin: 0 1px;
  background: var(--color-primary);
  animation: art-caret 1s steps(1) infinite;
}
.art-field:not(.art-field--focus) .art-caret { display: none; }
@keyframes art-caret { 50% { opacity: 0; } }

.art-field__btn {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  margin: 4px;
  background: var(--color-primary);
  color: var(--text-inverse);
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
}
.art-field__icon {
  grid-area: 1 / 1;
  transition: opacity 0.11s ease, transform 0.11s ease;
}
.art-field__icon--off { opacity: 0; transform: scale(0.7); }
.art-field__add {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  background-color: var(--text-inverse);
  mask: url('../assets/add.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/add.svg') no-repeat center / contain;
}
.art-field__scan {
  width: calc(var(--size-icon-lg) + 2px);
  height: calc(var(--size-icon-lg) + 2px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.art-field__scan :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2.1;
  fill: none;
}

/* ── Search results ──
   The phone search screen's rows: full bleed, 56px, the bigger tile. */
.art-results {
  list-style: none;
  margin: 0 calc(-1 * var(--space-3));
  padding: 0.35rem 0 0;
  opacity: 0;
  transition: opacity var(--transition-fast) ease;
}
.art-results--on { opacity: 1; }
.art-result {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 56px;
  padding: 0.6rem 1rem;
}
.art-result__emoji {
  position: relative;
  flex-shrink: 0;
  width: 2.15rem;
  height: 2.15rem;
  font-size: var(--text-xl);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  border: var(--border-width-thin) solid color-mix(in srgb, var(--color-primary) 22%, var(--bg-surface));
}
.art-result__tick {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 1rem;
  height: 1rem;
  border-radius: var(--radius-pill);
  background: var(--color-primary);
  color: var(--text-inverse);
  border: var(--border-width-base) solid var(--bg-surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: scale(0);
  transition: transform var(--transition-base) var(--ease-rise);
}
.art-result--added .art-result__tick { transform: scale(1); }
.art-result__tick :deep(svg) {
  width: 0.62rem;
  height: 0.62rem;
  display: block;
  stroke: currentColor;
  stroke-width: 3.5;
  fill: none;
}
.art-result__name {
  font-size: var(--text-md);
  color: var(--text-primary);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.art-result--added .art-result__name { color: var(--text-secondary); }

/* ── Real rows ── */
.art-list {
  position: relative;
  list-style: none;
  margin: 0;
  padding: 0;
}
.art-row-enter-active { transition: opacity 0.3s ease; }
.art-row-enter-from { opacity: 0; }
/* Out the way a removed row goes: off to the left, the rest closing up. */
.art-row-leave-active {
  position: absolute;
  width: 100%;
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.art-row-leave-to { opacity: 0; transform: translateX(-60%); }
.art-row-move { transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1); }

/* ── Scanner ──
   BarcodeScannerModal's screen: surface, the 8:5 window with its brackets, the
   instruction under it. The ring and the brackets turn primary on a read. */
.art-camera {
  position: absolute;
  inset: 0;
  z-index: 2;
  padding: var(--space-4);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}
.art-camera-enter-active,
.art-camera-leave-active { transition: opacity var(--transition-fast) ease; }
.art-camera-enter-from,
.art-camera-leave-to { opacity: 0; }

.art-viewfinder {
  position: relative;
  width: 100%;
  aspect-ratio: 8 / 5;
  max-height: 170px;
  border-radius: var(--radius-2xl);
  overflow: hidden;
  background: #0b0f14;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: box-shadow var(--transition-base) var(--ease-standard);
}
.art-viewfinder--hit { box-shadow: 0 0 0 3px var(--color-primary); }

/* What the camera sees: a pack's barcode label, brought into frame. */
.art-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 12px 6px;
  border-radius: 6px;
  background: #f4f1ea;
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.45);
  animation: art-label-in 1.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.art-label__bars {
  width: 104px;
  height: 44px;
  background: repeating-linear-gradient(
    90deg,
    #111 0 2px, transparent 2px 3px, #111 3px 4px, transparent 4px 7px,
    #111 7px 10px, transparent 10px 11px, #111 11px 12px, transparent 12px 15px
  );
}
.art-label__digits {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: #111;
}
@keyframes art-label-in {
  from { transform: translate(46px, 18px) rotate(-7deg); }
  to { transform: translate(0, 0) rotate(-2deg); }
}

.art-corner {
  position: absolute;
  width: 26px;
  height: 26px;
  border: 2.5px solid rgba(255, 255, 255, 0.85);
  transition: border-color var(--transition-fast) var(--ease-standard);
}
.art-viewfinder--hit .art-corner { border-color: var(--color-primary); }
.art-corner--tl { top: 12px; left: 12px; border-right: none; border-bottom: none; border-top-left-radius: var(--radius-md); }
.art-corner--tr { top: 12px; right: 12px; border-left: none; border-bottom: none; border-top-right-radius: var(--radius-md); }
.art-corner--bl { bottom: 12px; left: 12px; border-right: none; border-top: none; border-bottom-left-radius: var(--radius-md); }
.art-corner--br { bottom: 12px; right: 12px; border-left: none; border-top: none; border-bottom-right-radius: var(--radius-md); }

.art-camera__hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: center;
}

/* Check out: ShoppingList's .buy-bar, value for value. A 56px knob (THUMB_SIZE)
   standing 1.5px proud of a 53px track (TRACK_HEIGHT) all round; the trail a
   lighter green than the knob; the label a white copy clipped to the swept
   region. The positions come from the script, as in the real bar. */
.scene--buy .art-buy { margin-top: auto; }
.art-buy {
  position: relative;
  flex-shrink: 0;
  width: 100%;
  height: 56px;
  color: var(--color-primary);
}
.art-buy__track {
  position: absolute;
  left: 1.5px;
  right: 1.5px;
  top: 50%;
  height: 53px;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  box-shadow: var(--elevation-soft);
  overflow: hidden;
}
.art-buy__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-primary) 80%, var(--bg-surface));
  transition: width var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}
.art-buy__label {
  position: relative;
  z-index: 1;
  padding: 0 3.4rem;
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.01em;
  line-height: 1.4;
  white-space: nowrap;
}
.art-buy__label--inverse {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-inverse);
  transition: clip-path var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}
.art-buy__thumb {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  width: 56px;
  height: 56px;
  box-shadow: var(--elevation-primary);
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--transition-slow) cubic-bezier(0.22, 1, 0.36, 1);
}
/* The finger drives everything 1:1 while it holds the knob. */
.art-buy--dragging .art-buy__thumb,
.art-buy--dragging .art-buy__fill,
.art-buy--dragging .art-buy__label--inverse {
  transition: none;
}
.art-buy__icon {
  position: relative;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  transition: transform var(--transition-fast) ease;
}
.art-buy--dragging .art-buy__icon { transform: scale(0.88); }
.art-buy__cart,
.art-buy__check {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  transition: opacity var(--transition-base) ease, transform var(--transition-slow) cubic-bezier(0.34, 1.56, 0.64, 1);
}
.art-buy__cart :deep(svg),
.art-buy__check :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  fill: none;
}
.art-buy__cart :deep(svg) { stroke-width: 2; }
.art-buy__check :deep(svg) { stroke-width: 2.4; }
.art-buy__check { opacity: 0; transform: scale(0.4) translateY(-6px); }
.art-buy--success .art-buy__cart { opacity: 0; transform: scale(0.4) translateY(6px); }
.art-buy--success .art-buy__check { opacity: 1; transform: scale(1) translateY(0); }

/* Invite */
.art-invite { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); }
.art-code {
  display: flex; align-items: center; gap: var(--space-3);
  background: var(--bg-surface); border: var(--border-width-base) dashed color-mix(in srgb, var(--color-primary) 40%, transparent);
  border-radius: var(--radius-lg); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  cursor: pointer;
}
.art-code__value {
  font-family: var(--font-mono); letter-spacing: 0.14em;
  font-size: var(--text-md); font-weight: var(--weight-extrabold); color: var(--text-primary);
}
.art-code__copy {
  font-size: var(--text-xs); font-weight: var(--weight-bold); color: var(--text-inverse);
  background: var(--color-primary); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-2);
}
.art-people { display: flex; gap: var(--space-2); font-size: var(--text-lg); }

/* The scripted scenes schedule nothing under reduced motion (see the script);
   these are the CSS loops, parked at a frame that still reads. */
@media (prefers-reduced-motion: reduce) {
  .art-label,
  .art-caret {
    animation: none;
  }
  .art-label { transform: rotate(-2deg); }
}

/* ── Copy ── */
.tour-copy {
  display: grid;
  text-align: center;
}
.tour-copy__step {
  grid-area: 1 / 1;
  align-self: start;
  visibility: hidden;
  opacity: 0;
  transition: opacity var(--transition-fast) ease, visibility var(--transition-fast);
}
.tour-copy__step--on {
  visibility: visible;
  opacity: 1;
}
.tour-title {
  margin: 0 0 var(--space-2); font-size: var(--text-xl); font-weight: var(--weight-extrabold);
  color: var(--text-primary); letter-spacing: -0.01em; text-wrap: balance;
}
.tour-body {
  margin: 0 auto; font-size: var(--text-base); line-height: 1.55; color: var(--text-secondary);
  max-width: 34ch;
}

/* ── Dots ── */
.tour-dots { display: flex; justify-content: center; gap: var(--space-2); margin: var(--space-5) 0; }
.tour-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--border-dark);
  transition: width var(--transition-base) ease, background var(--transition-base) ease;
}
.tour-dot--active { width: 22px; border-radius: var(--radius-pill); background: var(--color-primary); }

/* ── Actions ── */
.tour-actions { display: flex; align-items: center; gap: var(--space-3); }
/* Shared BackButton. It carries a top margin for standalone use at the top of a
   view; this row centres its items, so drop it and keep it from being squeezed. */
.tour-actions :deep(.back-btn) { flex-shrink: 0; margin-top: 0; }
.tour-next {
  flex: 1; background: var(--color-primary); color: var(--text-inverse); border: none;
  border-radius: var(--radius-md); padding: 0.75rem var(--space-4);
  font-size: var(--text-base); font-weight: var(--weight-bold); cursor: pointer;
  box-shadow: var(--elevation-primary); transition: background var(--transition-fast) ease;
}
/* Colour shift only — a lift here nudged the card's whole action row on hover. */
.tour-next:hover { background: color-mix(in srgb, var(--color-primary) 85%, var(--text-primary)); }

/* ── Transitions ── */
.tour-fade-enter-active, .tour-fade-leave-active { transition: opacity var(--transition-base) ease; }
.tour-fade-enter-from, .tour-fade-leave-to { opacity: 0; }
.tour-step-enter-active, .tour-step-leave-active { transition: opacity var(--transition-fast) ease; }
.tour-step-enter-from, .tour-step-leave-to { opacity: 0; }
</style>
