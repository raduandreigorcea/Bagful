<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type PropType } from 'vue'
import { closeModal, isTopModal, openModal } from '../lib/modalStack'
import { isSheetWidth, useSearchSheet } from '../lib/useSearchSheet'
import { useTapPops } from '../lib/useTapPops'
import { useAddedConfirmation } from '../lib/useAddedConfirmation'
import { getProductEmoji } from '../lib/productEmoji'
import BackButton from './BackButton.vue'
import SkeletonBlock from './SkeletonBlock.vue'
import { productKey, type ProductSuggestion } from '../lib/productSearch'
import { ITEM_NAME_MAX_LENGTH } from '../lib/limits'
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'
import ShopBadges from './ShopBadges.vue'

// Presentational: the typed name lives in the parent (via v-model) so the add
// flow can restore it when an optimistic insert fails. The suggestions list is
// likewise owned by the parent (it queries the product catalog); this component
// only renders it and reports the pick.
//
// There is no quantity here any more. A stepper used to sit at the head of this
// row, which asked how many before anything had said of what, reset itself after
// every add, and spent the width that made the row need one button for two jobs.
// It is on the list row now, where the product it counts exists and can still be
// corrected. Adding is one tap; adding the same thing twice sums, as it always
// has.
const name = defineModel('name', { type: String, default: '' })
// Whether the search is open as a sheet.
//
// Two-way, and below the bar boundary the parent WRITES it first: the
// bar's centre button raises the sheet by setting this, and the component answers by
// focusing the field. It reads it back for two reasons -- to widen the query
// while the sheet is up, since a screen has room for twice the rows a dropdown
// does, and to learn that the sheet dismissed itself.
const expanded = defineModel('expanded', { type: Boolean, default: false })

const props = defineProps({
  // The item-name cap, from lib/limits rather than a literal: it mirrors
  // 004_shopping_list.sql, and a second copy of a migration's bound is free to
  // drift from it without anything saying so.
  maxLength: { type: Number, default: ITEM_NAME_MAX_LENGTH },
  // Product catalog matches for the current input: [{ name, maker }].
  suggestions: { type: Array as PropType<ProductSuggestion[]>, default: () => [] },
  // The shops the search may be narrowed to, and which one it currently is.
  // Empty means no filter is offered at all -- production, a missing catalog, or
  // a catalog with no retailers yet. See useProductSuggestions.
  shopOptions: { type: Array as PropType<string[]>, default: () => [] },
  searchShop: { type: String as PropType<string | null>, default: null },
  // What this list buys most, same shape as suggestions. Shown in the
  // sheet before anything is typed; ignored above the bar boundary, where the
  // dropdown has no screen to fill.
  recents: { type: Array as PropType<ProductSuggestion[]>, default: () => [] },
  // The product that just landed on the list, as a fresh object each time so
  // adding the same thing twice still reads as two adds. Only the search screen
  // shows it: everywhere else the list is right there and the row arriving in
  // it is the confirmation.
  lastAdded: {
    type: Object as PropType<{ name: string; maker: string | null } | null>,
    default: null,
  },
  // A search is running (or debouncing) for what is currently typed, so the
  // matches below are not the answer yet.
  suggestionsLoading: { type: Boolean, default: false },
  // Whether to offer the "add your own" escape hatch. Owned by the parent,
  // which knows when the query is long enough to have been searched for.
  canAddCustom: { type: Boolean, default: false },
  // Why the matches may be partial -- 'offline' or 'degraded' -- so a search
  // that could not reach the catalog does not pass for one that found nothing.
  searchNote: { type: String as PropType<'offline' | 'degraded' | null>, default: null },
  // Whether this device can scan at all — a camera it can reach, and something
  // that can decode. Asked once by the parent; a browser that cannot scan is
  // never offered the button rather than being offered one that fails.
  canScan: { type: Boolean, default: false },
})

// Uneven widths so the placeholder reads as products rather than a bar chart.
const skeletonWidths = ['58%', '41%', '66%']

const emit = defineEmits<{
  submit: []
  select: [product: ProductSuggestion]
  'add-custom': []
  scan: []
  'select-shop': [shop: string | null]
}>()

// ─── The button at the end of the row ────────────────────────────────────────
// With nothing typed there is nothing to add, so the add button spends most of
// its life disabled — which is most of the time the form is on screen at all,
// since an empty field is what you come back to after every add. That dead state
// is where scanning goes: same button, same place, no extra control on a row
// that has no width to spare. The first keystroke hands it back to Add, which is
// the action that has become available.
const showScan = computed(() => props.canScan && !name.value.trim())

// The add's answer, given on the button that performed it.
//
// Tapping a suggestion is answered on its row (see useAddedConfirmation), but
// typing a name and pressing Add was answered nowhere: the field keeps its text,
// the row lands on a list this screen is covering, and the press produced no
// visible result at all. So the plus becomes a tick for a beat, and then goes
// back to being the way to add the next thing.
//
// Short on purpose. It is the receipt for a press, not a state the button is in
// -- the button is still the add button throughout, and pressing it again
// during the tick adds again.
const ADD_CONFIRMED_MS = 1100
const addConfirmed = ref(false)
// A typed add clears the field (so Enter cannot add the same words twice), which
// turns this button back into the scanner in the same moment the add lands. The
// tick still belongs to it: it is the button that was just pressed.
let submittedTyped = false
let addConfirmedTimer: ReturnType<typeof setTimeout> | null = null

function clearAddConfirmed() {
  if (addConfirmedTimer) clearTimeout(addConfirmedTimer)
  addConfirmedTimer = null
  addConfirmed.value = false
}

watch(
  () => props.lastAdded,
  (product) => {
    clearAddConfirmed()
    // Null is the parent taking an add back -- see clearLastAdded, "it did not
    // land". A tick for a write that failed is worse than no tick at all.
    const typed = submittedTyped
    submittedTyped = false
    if (!product) return
    // Only while this button IS the add button, or was the one just pressed.
    // With an empty field it is the scanner, and a tick flashing over the camera
    // glyph for a tapped suggestion would be a different control answering for
    // something it did not do.
    if (showScan.value && !typed) return
    addConfirmed.value = true
    addConfirmedTimer = setTimeout(() => {
      addConfirmed.value = false
      addConfirmedTimer = null
    }, ADD_CONFIRMED_MS)
  },
)

// The next keystroke is the next item; the tick was about the last one. A typed
// add empties the field itself, which is not a keystroke and must not take the
// tick straight back down.
watch(name, (value) => {
  if (value) clearAddConfirmed()
})

function onSubmit() {
  submittedTyped = true
  emit('submit')
}

onBeforeUnmount(clearAddConfirmed)

function onAction() {
  // Not a scan means this is the submit button, and the form's own submit
  // handler is already on its way. Nothing to do here.
  if (!showScan.value) return
  // Hand the screen over rather than stacking a camera on top of a search. The
  // collapse runs behind the dialog that is about to cover it, so the only thing
  // the user sees is the scanner arriving — and the way back is the list, which
  // is where the scanned items are.
  close()
  emit('scan')
}

// The dropdown shows only while the input has focus; mousedown.prevent on the
// options keeps focus in the input, so picking one never races the blur.
const inputFocused = ref(false)

const inputRef = ref<HTMLInputElement | null>(null)

// The input and the results are a combobox and its listbox, and saying so is
// what makes the pair navigable: without aria-controls the two are unrelated
// elements that merely sit near each other, and without aria-expanded there is
// no way to know the results opened at all. Generated rather than hardcoded so
// the id stays unique if this form is ever mounted twice.
const listboxId = useId()

// Measuring the visual viewport and running the sheet in and out. All of it
// lives in lib/useSearchSheet; this component keeps only the decision of WHEN to
// expand and collapse.
const { screenBox, closing, present, expand, collapse } = useSearchSheet({ expanded })

// ─── Counting the taps out loud ──────────────────────────────────────────────
// The running x2 / x3 / x4 that flies off a suggestion tapped more than once.
// See lib/useTapPops — it draws a number and forgets it, and knows nothing about
// products or the search.
const wrapRef = ref<HTMLElement | null>(null)
const { pops, countTap, reset: resetTapCounts } = useTapPops({ wrapRef })

function selectSuggestion(product: ProductSuggestion, event?: MouseEvent) {
  countTap(productKey(product.name, product.maker), event)
  emit('select', product)
}

// The rows commit on mousedown rather than click, so that pressing one never
// takes focus off the input and drops the keyboard mid-flow (see the note on
// the add button). That leaves the keyboard with no way in at all: Enter and
// Space on a focused button raise `click`, never `mousedown`, and so does the
// synthetic activation a screen reader sends — so tabbing to a suggestion and
// pressing Enter did nothing.
//
// Both paths cannot simply be bound, or a pointer press would add the item
// twice. `detail` is what separates them: it carries the click count, which is
// 0 for exactly the activations that never had a pointer press behind them.
// BackButton above can bind both because close() is idempotent; adding an item
// is not.
function isKeyboardActivation(event: MouseEvent): boolean {
  return event.detail === 0
}

function onSuggestionClick(product: ProductSuggestion, event: MouseEvent) {
  if (!isKeyboardActivation(event)) return
  selectSuggestion(product, event)
}

function onAddCustomClick(event: MouseEvent) {
  if (!isKeyboardActivation(event)) return
  emit('add-custom')
}

// Before anything is typed the screen shows what this list buys, so the
// common case — the same bread as last week — is one tap and no typing. Once
// there is a query it is the matches' screen, and these step aside.
// On the desktop column too: an empty field there is the same "what do we
// usually get" moment as the phone sheet, and it used to show nothing at all.
const showingRecents = computed(
  () => (present.value || inputFocused.value) && !name.value.trim() && props.recents.length > 0,
)

const rows = computed(() => (showingRecents.value ? props.recents : props.suggestions))

// There is something to say when a search is running, when it found something,
// or when the escape hatch is on offer. Lifted, the results are the screen's
// body rather than a dropdown, so they stay mounted either way — including
// empty, in the keystroke between a query starting and its skeleton.
const hasResults = computed(
  () => props.suggestionsLoading || rows.value.length > 0 || props.canAddCustom,
)
// In the sheet the results ARE the body, so they are mounted for as long as the
// sheet is — including empty, and including while it travels back down, which
// `present` covers. Focus has nothing to do with it: the keyboard can be
// dismissed with the sheet still up, and a screen with nothing under its header
// is still the screen. Above the sheet boundary this is an ordinary dropdown
// again, open only while the field has focus and there is something to show.
const panelOpen = computed(() => present.value || (inputFocused.value && hasResults.value))

// At the desktop column a focused field is the thing being used, so the page
// behind it is blurred and the field and its dropdown stay sharp. On focus, not
// on the dropdown opening: an empty field is already a search in progress, and
// blurring only once a match arrived made the page flicker as you typed. Not
// while the sheet is up: below the bar boundary its own cover takes the list.
const dimmed = computed(() => inputFocused.value && !present.value)

// The slot is lifted above the page for as long as the blur is DRAWN, which
// outlasts `dimmed` by the length of its fade. The blur lives inside the slot's
// stacking context; dropping the lift the moment focus left would drop the
// fading blur beneath the header, which would snap sharp mid-fade.
const lifted = ref(false)
watch(dimmed, (on) => {
  if (on) lifted.value = true
})

// A list with no history yet gets a line telling them what to do rather than
// a blank screen. Only on an empty query: telling someone who has typed a
// character to type a product name is worse than saying nothing, and that
// single keystroke before the search starts is the only other time this would
// come up.
const showingHint = computed(
  () =>
    present.value &&
    !name.value.trim() &&
    !props.suggestionsLoading &&
    !rows.value.length &&
    !props.canAddCustom,
)

// ─── Walking the results from the keyboard ───────────────────────────────────
// The input declares role="combobox" with aria-controls pointing at the list
// below, and every row declares role="option". That set of attributes is a
// promise: it tells assistive tech to expect the ARIA combobox pattern, where
// Down and Up move through the options and aria-activedescendant reports which
// one is current. None of it existed — the only key this handled was Escape —
// so the markup announced a list of suggestions and then the documented way to
// move through it did nothing at all.
//
// The rows were never unreachable. Each is a real button, and the detail === 0
// split below is what lets Tab-then-Enter commit one. But reaching the sixth
// match meant six presses of Tab, past every row in between, which is not what
// the roles said would happen and is the exact friction the pattern exists to
// remove.
//
// -1 means nothing is active: the query itself is the selection, and Enter
// submits what was typed. Every new set of matches returns here, because a
// highlight belongs to the list it was placed in and not to the one that
// replaced it.
const activeIndex = ref(-1)

// The "Can't find it?" hatch carries role="option" like the rows do, so it is
// one of this listbox's options and has to be walkable too — otherwise the
// roles are lying in the other direction. It sits one past the last row.
const optionCount = computed(() => rows.value.length + (props.canAddCustom ? 1 : 0))

// "Add 'oat milk'" goes FIRST unless something on screen already is exactly
// that. Somebody who typed a whole name and sees no row carrying it wants that
// name, and it used to sit under twelve near misses at the bottom of the list.
// When a row does match exactly, that row is the better answer (it has a maker,
// and it ranks) and the typed version drops to the end.
const hatchFirst = computed(() => {
  if (!props.canAddCustom || props.suggestionsLoading) return false
  const typed = name.value.trim().toLocaleLowerCase()
  return !rows.value.some((r) => r.name.trim().toLocaleLowerCase() === typed)
})
const rowOffset = computed(() => (hatchFirst.value ? 1 : 0))
const hatchIndex = computed(() => (hatchFirst.value ? 0 : rows.value.length))

function optionId(index: number): string {
  return `${listboxId}-option-${index}`
}

// Only ever an id that is actually rendered. A stale activedescendant pointing
// at nothing is worse than none: the reader announces a blank.
const activeOptionId = computed(() =>
  activeIndex.value >= 0 && activeIndex.value < optionCount.value
    ? optionId(activeIndex.value)
    : undefined,
)

// Wraps at both ends, as the pattern specifies — a list this short is quicker to
// walk round than to reverse out of. From nothing, Down takes the first option
// and Up takes the last, so either key gets you in.
function moveActive(delta: number) {
  const count = optionCount.value
  if (!count) return
  const from = activeIndex.value
  const next = from < 0 ? (delta > 0 ? 0 : count - 1) : (from + delta + count) % count
  activeIndex.value = next
  // The panel scrolls, and a highlight the list has not scrolled to is a
  // highlight nobody can see. 'nearest' so it only moves when it has to.
  void nextTick(() => {
    document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  })
}

// What Enter means depends on whether a row is highlighted. With one, it is
// that row — the same commit a tap makes, down to the tap counter. Without, it
// is the typed text, and the form's own submit owns that, so this must not
// swallow the event.
function onEnter(event: KeyboardEvent) {
  if (activeIndex.value < 0) return
  event.preventDefault()
  if (props.canAddCustom && activeIndex.value === hatchIndex.value) {
    emit('add-custom')
    return
  }
  const product = rows.value[activeIndex.value - rowOffset.value]
  if (product) selectSuggestion(product)
}

// A fresh set of matches is a fresh list to choose from. Watching the rendered
// rows rather than the query catches every way they can change — a search
// landing, the recents taking over on an emptied field, a list switch
// clearing them.
watch([rows, () => props.canAddCustom], () => {
  activeIndex.value = -1
})

// Which shops carry a suggestion.
//
// search_catalog returns `retailers` on every row it answers with; a row from
// the app database's own search_catalog has none, and neither does one recovered
// from purchase history. So an empty answer here is meaningful rather than
// missing: it says this product came from what the list typed in, not from
// a shop we read.
function shopsOf(product: ProductSuggestion): string[] {
  return Array.isArray(product.retailers) ? product.retailers : []
}


// The shop filter shows while SEARCHING and not while showing recents. Recents
// come from what this list has bought, which says nothing about which shops
// carry it -- so the chips would sit above rows they cannot narrow, and the one
// that did nothing would look broken rather than empty.
const showingShopFilter = computed(
  () => props.shopOptions.length > 0 && !showingRecents.value,
)

// ─── Confirming the add ──────────────────────────────────────────────────────
// Which rows this search has already put on the list, and which one to light
// up about it. All of it lives in lib/useAddedConfirmation; what stays here is
// the decision of when a visit to the search has ended.
const { announcement, justAddedKey, litPhase, isAdded, forgetAdded } = useAddedConfirmation({
  lastAdded: () => props.lastAdded,
})

// The record is of this visit to the search, not of the session. Leaving the
// panel and coming back should not show ticks against a trip already finished.
watch(panelOpen, (open) => {
  if (!open) {
    forgetAdded()
    resetTapCounts()
    // The highlight belongs to the visit too. Coming back to a list still
    // pointing at the row left behind last time would be a selection nobody made.
    activeIndex.value = -1
  }
})

// ─── Phone search mode ───────────────────────────────────────────────────────
// Below 900px this form has no place in the flow: the list screen's shell is a
// bottom action bar and the search is a sheet its centre button raises. So the sheet is
// opened from OUTSIDE, by whoever owns the `expanded` model, and this component
// answers by putting the keyboard where the user is already looking.
//
// Above 900px nothing here applies: the field is an ordinary field in the
// column, focusing it opens a dropdown, and expand() is never called.
watch(expanded, (open) => {
  if (!open || !isSheetWidth()) return
  // The field is inside the sheet, which mounts in this same tick. Focusing it
  // before that lands would focus an element with no layout, which iOS answers
  // by declining to raise the keyboard at all.
  void nextTick(() => inputRef.value?.focus())
})

function onFocus() {
  inputFocused.value = true
  // Above the sheet boundary this is the whole story. Below it the sheet is
  // already open by the time the field can be focused, and expand() no-ops —
  // except mid-close, which is the one case it exists to catch. See the comment
  // on expand() in the composable.
  if (isSheetWidth()) expand()
}

// A DELIBERATE dismissal: the back button, Escape, or handing the screen over to
// the scanner. Not blur, and not a tap on the surface behind the sheet.
//
// Both of those used to land here, and on a phone that made the search screen
// feel like it was waiting for an excuse to leave. Anything not focusable took
// the keyboard down and the whole screen with it — the shop-filter chips, the
// gap under a short results list, a scroll that started on the padding — and
// whatever had been typed went with it. A sheet raised on purpose should be
// dismissed on purpose.
function close() {
  inputFocused.value = false
  inputRef.value?.blur()
  collapse()
}

// Losing focus is not a dismissal while the sheet is up; it only means the
// keyboard went away. Above the sheet boundary it is the whole story, because
// there the dropdown belongs to the focused field and nothing else.
function onBlur() {
  inputFocused.value = false
  if (present.value) return
  collapse()
}

// ─── Android's Back button ───────────────────────────────────────────────────
// This form's place in the layer stack, joined for the same reason PopoverMenu
// joins it: on a phone a focused field is not a field, it is a screen covering
// the list, and Back has to mean "put that away". Without this the press fell
// through an empty stack to Home's root-route case and exited the app with the
// search still up — losing whatever had been typed, which is the one thing Back
// is never supposed to do.
//
// Registered whenever there is something for Back to put away: the sheet for as
// long as it is up, or — above the sheet boundary, where there is no sheet — a
// focused field with a dropdown under it.
//
// It cannot be keyed on focus alone any more. Blur no longer dismisses the
// sheet, so a keyboard dropped inside an open search would have taken this
// registration with it and left Back falling through to Home's root-route case,
// which exits the app. That is the exact failure this was written to eliminate,
// and Back is now the ONLY way out on a phone, so it has to be the thing that
// cannot come unstuck.
//
// It does not lock the page's scroll. Raised, the sheet owns the viewport itself
// and its cover already swallows touch; collapsed, a text cursor is no reason to
// freeze the list.
const layer = Symbol('add-item-search')

// immediate, because the bar can hand this component a sheet that is ALREADY
// open: HomeView sets the model and the form mounts with it true, so the value
// never changes and a lazy watcher would never fire. That left the one state
// where Back is the only exit as the one state Back was not registered for.
// closeModal ignores a token it has never seen, so the false case is free.
watch(
  // `expanded`, not `present`: the layer means "there is a search open for Back
  // to put away", and once it has been dismissed there is not — even though the
  // sheet is still drawn for the length of its exit. Keyed on `present`, a
  // second Back during those 280ms would report itself handled and then do
  // nothing, eating a press the list screen should have had.
  () => expanded.value || inputFocused.value,
  (open) => {
    if (open) openModal(layer, { close, locksScroll: false })
    else closeModal(layer)
  },
  { immediate: true },
)

// "/" puts the cursor in the add field from anywhere on the desktop column, the
// shortcut search boxes have taught people. Ignored while typing somewhere else,
// and on a phone, where the field lives in a sheet the bar's Add button raises.
function onSlash(event: KeyboardEvent) {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
  if (isSheetWidth()) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable="true"]')) return
  event.preventDefault()
  inputRef.value?.focus()
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onSlash)

// Escape closes the search from anywhere in it, not only from the search box:
// after a tap on a shop chip the box no longer has focus, and a keyboard had
// no way out of the whole-screen sheet (found by the bot swarm). Guarded by the
// layer stack like AppModal's, so one press closes only what is on top.
function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !isTopModal(layer)) return
  event.stopPropagation()
  close()
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onEscape)

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onSlash)
    document.removeEventListener('keydown', onEscape)
  }
  // The slide timer, the viewport listeners and the transitionend handler are
  // useSearchSheet's own teardown, and the confirmation timer is
  // useAddedConfirmation's. Only the layer registration is this component's.
  closeModal(layer)
})

</script>

<template>
  <!-- The form's place in the flow at the desktop column, and nothing at all
       below it: see the media query on .add-slot. `present` rather than
       `expanded` because the sheet has to stay drawn while it leaves. -->
  <div class="add-slot" :class="{ 'add-slot--open': present, 'add-slot--dim': dimmed || lifted }">
    <!-- The blur behind the focused desktop field. No handler: pressing it
         moves focus off the field, and onBlur already closes the dropdown. It
         comes BEFORE the form on purpose; see .add-dim. -->
    <Transition name="add-cover" @after-leave="lifted = false">
      <div v-if="dimmed" class="add-dim" aria-hidden="true"></div>
    </Transition>

    <Transition name="add-cover">
      <!-- mousedown, not click, for the same reason the options use it: the tap
           must not steal focus before we decide what to do with it. -->
      <!-- The surface the sheet sits on, and nothing more. It used to dismiss
           on mousedown, which on a phone is a full-screen target sitting under
           a search you raised on purpose. touchmove is still swallowed so the
           list behind cannot be scrolled through it. -->
      <div v-if="present" class="add-cover" @touchmove.prevent></div>
    </Transition>

    <form
      class="add-form"
      :class="{ 'add-form--expanded': present, 'add-form--closing': closing }"
      :style="screenBox"
      @submit.prevent="onSubmit"
    >
      <!-- Lifted, this is the header band: the field, and the one way out that
           the keyboard can never cover. Collapsed it draws nothing at all. -->
      <div class="add-head">
        <!-- No leave transition, deliberately. A fading element stays mounted,
             and by the time this one unmounts the band's padding is gone, so it
             would take ordinary layout above the field and shove the field —
             which has just landed — back down for the length of the fade. It
             fades on the way out via .add-form--closing instead, which leaves
             the layout alone, and is already invisible when it goes. -->
        <div v-if="present" class="add-head__bar">
          <!-- mousedown holds focus through the tap the way the option rows
               do; click is what a keyboard sends, and close() no-ops on the
               second call. -->
          <BackButton @mousedown.prevent="close" @click="close" />
        </div>

        <div class="add-row">
          <!-- The button uses mousedown.prevent for the same reason the option
               rows do: pressing it must not take focus off the input. Adding an
               item is the middle of the job, not the end of it, and losing focus
               here would drop the keyboard and put the search screen away
               mid-flow. -->
          <input
            v-model="name"
            ref="inputRef"
            type="text"
            :aria-label="t('add.inputLabel')"
            :placeholder="t('add.inputPlaceholder')"
            :maxlength="maxLength"
            autocomplete="off"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="panelOpen"
            :aria-controls="panelOpen ? listboxId : undefined"
            :aria-activedescendant="activeOptionId"
            @focus="onFocus"
            @blur="onBlur"
            @keydown.esc.stop="close"
            @keydown.down.prevent="moveActive(1)"
            @keydown.up.prevent="moveActive(-1)"
            @keydown.enter="onEnter"
          />
          <!-- One control, two jobs. type follows the job so Enter in the field
               still submits when there is something to add, and the scan state is
               never a submit button that would fire on it. -->
          <button
            :type="showScan ? 'button' : 'submit'"
            class="add-btn"
            @mousedown.prevent
            @click="onAction"
            :disabled="!showScan && !name.trim()"
            :aria-label="showScan ? t('add.scanLabel') : t('add.submitLabel')"
          >
            <!-- Both icons stay mounted, stacked in one grid cell, and the swap
                 is opacity and scale on whichever is not the current job.

                 This was a <Transition mode="out-in">, which is the one shape
                 that can leave the button holding NOTHING: out-in unmounts the
                 outgoing icon, renders a placeholder comment, and mounts the
                 incoming one only once the leave resolves. Vue schedules the
                 second half of a leave inside a double requestAnimationFrame, so
                 anything that starves rAF -- a backgrounded tab is the easy one
                 -- strands the placeholder and the primary action of the app is
                 a blank green square. An empty button is a far worse outcome
                 than a missing 110ms flourish, and CSS gives the same flourish
                 with nothing left to stall.

                 The scan icon is still absent entirely where it would never be
                 used: canScan cannot change while the field is being typed in,
                 so that one is a real v-if and not a hidden element. -->
            <AppIcon
              v-if="canScan"
              class="add-btn__icon scan-icon"
              :class="{ 'add-btn__icon--off': !showScan || addConfirmed }"
              name="scan-barcode"
            />
            <span
              class="add-btn__icon add-icon"
              :class="{ 'add-btn__icon--off': showScan || addConfirmed }"
            ></span>
            <!-- The tick the plus turns into once an add has landed. A third
                 occupant of the same cell, faded in and out by the same two
                 rules, so it cannot leave the button empty either. -->
            <AppIcon
              class="add-btn__icon confirm-icon"
              :class="{ 'add-btn__icon--off': !addConfirmed }"
              name="check"
            />
          </button>
        </div>
      </div>

      <!-- Collapsed this is the dropdown, open only when there is something to
           say. Lifted it is the screen's body and stays mounted, because a
           screen with nothing under its header is still the screen.

           The fade is likewise for the dropdown, which appears and goes in
           place. Lifted, the results are a screen-tall surface hanging off a
           field that is itself moving, and fading them out means sweeping all
           of that down the page on the way out; cutting is quieter. -->
      <Transition name="suggest" :css="!present">
        <div v-if="panelOpen" ref="wrapRef" class="suggestions-wrap">
          <!-- Always mounted so a screen reader is already listening when the
               confirmation arrives; announcing depends on the region
               pre-existing, not on it appearing with the news.

               The add is confirmed on the row that was tapped, which is still
               sitting there now that a pick no longer clears the query. This
               used to be a band above the results restating the product, which
               said the same thing twice and said it away from the thing.

               The band was also the live region, so it stays as one -- announced
               and not drawn, because the visible half of its job now belongs to
               the row. -->
          <p class="added-announce" role="status" aria-live="polite">
            {{ announcement }}
          </p>

          <!-- Outside the listbox: a listbox exposes only its options, so a
               heading inside it would be dropped on the way to a screen reader.
               Out here it is ordinary text, and aria-label carries the name. -->
          <p v-if="showingRecents" class="suggestions-label">{{ t('list.buyAgain') }}</p>

          <!-- Said once, above the matches, when they are not the whole answer:
               a catalog that could not be reached must not read as a product
               nobody sells. -->
          <p v-if="searchNote && name.trim() && !suggestionsLoading" class="search-note">
            <AppIcon class="search-note__icon" :name="searchNote === 'offline' ? 'wifi-off' : 'triangle-alert'" />
            {{ searchNote === 'offline' ? t('add.noteOffline') : t('add.noteDegraded') }}
          </p>

          <!-- NIGHTLY ONLY, above the listbox rather than inside it: a listbox
               exposes its options and nothing else, so controls placed in it are
               dropped on the way to a screen reader.

               A radiogroup, not a set of toggles. Exactly one shop at a time,
               "All" included, and that is what a radio group means -- pressed
               buttons would suggest several could be on at once and leave no
               name for the state where none are. -->
          <div
            v-if="showingShopFilter"
            class="shop-filter"
            role="radiogroup"
            :aria-label="t('add.shopFilter')"
          >
            <button
              type="button"
              class="shop-filter__chip"
              :class="{ 'shop-filter__chip--on': !searchShop }"
              role="radio"
              :aria-checked="!searchShop"
              @mousedown.prevent
              @click="emit('select-shop', null)"
            >
              {{ t('add.shopAll') }}
            </button>
            <button
              v-for="shop in shopOptions"
              :key="shop"
              type="button"
              class="shop-filter__chip"
              :class="{ 'shop-filter__chip--on': searchShop === shop }"
              role="radio"
              :aria-checked="searchShop === shop"
              @mousedown.prevent
              @click="emit('select-shop', searchShop === shop ? null : shop)"
            >
              <ShopBadges :shops="[shop]" labelled />
            </button>
          </div>

          <ul
            class="suggestions"
            :id="listboxId"
            role="listbox"
            :aria-label="showingRecents ? t('add.listRecents') : t('add.listSuggestions')"
            :aria-busy="suggestionsLoading"
          >
            <!-- While searching, the skeleton is all there is: the previous query's
                 matches are not this query's answers, and offering "Can't find it?"
                 before the search returns would be a lie. -->
            <template v-if="suggestionsLoading">
              <li
                v-for="(width, idx) in skeletonWidths"
                :key="`skeleton-${idx}`"
                class="suggestion-skeleton"
                role="presentation"
              >
                <SkeletonBlock width="1.9rem" height="1.9rem" radius="0.6rem" />
                <span class="suggestion-skeleton__text">
                  <SkeletonBlock :width="width" height="0.8rem" />
                  <SkeletonBlock width="26%" height="0.6rem" />
                </span>
              </li>
            </template>

            <template v-else>
              <li v-if="canAddCustom && hatchFirst" class="suggestions-hatch" role="presentation">
                <!-- An option like the products above it, not a stray button:
                     it is one of the choices this list is offering, and a
                     non-option child would be dropped from the listbox. -->
                <button
                  type="button"
                  role="option"
                  class="suggestion suggestion--custom"
                  :class="{ 'suggestion--active': activeIndex === hatchIndex }"
                  :id="optionId(hatchIndex)"
                  :aria-selected="activeIndex === hatchIndex"
                  @mousedown.prevent="emit('add-custom')"
                  @click="onAddCustomClick($event)"
                >
                  <span class="suggestion-emoji suggestion-emoji--custom" aria-hidden="true">
                    <span class="suggestion-icon"></span>
                  </span>
                  <span class="suggestion-text">
                    <span class="suggestion-name suggestion-name--custom">{{
                      t('add.addTyped', { name: name.trim() })
                    }}</span>
                    <span class="suggestion-maker suggestion-maker--custom">{{ t('add.addTypedHint') }}</span>
                  </span>
                </button>
              </li>
              <!-- The li is presentational so the listbox owns the options
                   directly: a listbox may only contain options, and a plain
                   list item between the two breaks that ownership and takes the
                   options out of the accessibility tree with it. -->
              <li
                v-for="(product, index) in rows"
                :key="productKey(product.name, product.maker)"
                role="presentation"
              >
                <button
                  type="button"
                  class="suggestion"
                  :class="{
                    'suggestion--added': isAdded(product),
                    'suggestion--active': activeIndex === index + rowOffset,
                    'suggestion--lit-a':
                      litPhase === 0 && productKey(product.name, product.maker) === justAddedKey,
                    'suggestion--lit-b':
                      litPhase === 1 && productKey(product.name, product.maker) === justAddedKey,
                  }"
                  role="option"
                  :id="optionId(index + rowOffset)"
                  :aria-selected="activeIndex === index + rowOffset"
                  @mousedown.prevent="selectSuggestion(product, $event)"
                  @click="onSuggestionClick(product, $event)"
                >
                  <span class="suggestion-emoji" aria-hidden="true">
                    {{ getProductEmoji(product.name, product.maker || '') }}
                    <!-- On the tile, the way the row on the list wears its own
                         mark. Rendering it only when added would pop the layout;
                         it scales in from nothing instead. -->
                    <AppIcon class="suggestion-tick" name="check" />
                  </span>
                  <span class="suggestion-text">
                    <span class="suggestion-name">{{ product.name }}</span>
                    <span v-if="product.maker || shopsOf(product).length" class="suggestion-sub">
                      <span v-if="product.maker" class="suggestion-maker">{{ product.maker }}</span>
                      <!-- Where this row came from. A suggestion
                           carries `retailers` because it came out of the catalog
                           a moment ago; see ShopBadges for why it is a logo and
                           not the name. -->
                      <ShopBadges :shops="shopsOf(product)" />
                    </span>
                  </span>
                  <!-- The tick is decoration; this is what carries the state into
                       the option's accessible name. -->
                  <span v-if="isAdded(product)" class="added-announce">{{ t('add.onYourList') }}</span>
                </button>
              </li>

              <li v-if="canAddCustom && !hatchFirst" class="suggestions-hatch" role="presentation">
                <!-- An option like the products above it, not a stray button:
                     it is one of the choices this list is offering, and a
                     non-option child would be dropped from the listbox. -->
                <button
                  type="button"
                  role="option"
                  class="suggestion suggestion--custom"
                  :class="{ 'suggestion--active': activeIndex === hatchIndex }"
                  :id="optionId(hatchIndex)"
                  :aria-selected="activeIndex === hatchIndex"
                  @mousedown.prevent="emit('add-custom')"
                  @click="onAddCustomClick($event)"
                >
                  <span class="suggestion-emoji suggestion-emoji--custom" aria-hidden="true">
                    <span class="suggestion-icon"></span>
                  </span>
                  <span class="suggestion-text">
                    <span class="suggestion-name suggestion-name--custom">{{
                      t('add.addTyped', { name: name.trim() })
                    }}</span>
                    <span class="suggestion-maker suggestion-maker--custom">{{ t('add.addTypedHint') }}</span>
                  </span>
                </button>
              </li>
            </template>
          </ul>

          <!-- A list with nothing bought yet has no usuals to open on. An
               empty screen should say what to do with it. -->
          <p v-if="showingHint" class="suggestions-hint">{{ t('add.typeToSearch') }}</p>

          <!-- Last in the wrap and outside the scrolling results, so a counter
               thrown from the top row is not sliced off by the list's own edge.
               Decorative: the count it reports is already in the row's tick and
               in the announcement, so there is nothing here for a reader. -->
          <div class="pop-layer" aria-hidden="true">
            <span
              v-for="pop in pops"
              :key="pop.id"
              class="pop"
              :style="{
                left: `${pop.x}px`,
                top: `${pop.y}px`,
                '--pop-dx': `${pop.dx}px`,
                '--pop-dy': `${pop.dy}px`,
                '--pop-rot': `${pop.rot}deg`,
              }"
            >{{ pop.label }}</span>
          </div>
        </div>
      </Transition>
    </form>
  </div>
</template>

<style scoped>
/* Why the matches below may be partial. Quiet, one line, not an error: the
   search still worked, it just could not ask everyone. */
.search-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.search-note__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.search-note__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* At the desktop column this still holds the form's place in the flow, and the
   margin below is the form's own. Below 900px it holds nothing: see the block
   at the foot of this file. */
.add-slot {
  position: relative;
  margin-bottom: 1.25rem;
}

/* ─── Below the bar boundary the form is not in the flow at all ──────────────
   The field lives in the sheet the bar's Add button raises, so there is
   nothing here to lay out until it does.

   Hidden rather than unmounted, because the parent owns one instance and its
   state — the query, the shop filter, the added-confirmation record — has to
   survive the sheet closing. `display:none` on the slot takes the collapsed
   form out with it; when it opens, both children inside are position:fixed and
   the slot itself still contributes no height. */
@media (max-width: 899.98px) {
  .add-slot {
    margin-bottom: 0;
  }

  .add-slot:not(.add-slot--open) {
    display: none;
  }
}

.add-form {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* ─── Phone search screen ────────────────────────────────────────────────────
   The whole viewport, top-anchored, transparent: the surface underneath it is
   .add-cover. `top` and `height` arrive inline from the visual viewport, so the
   screen ends where the keyboard starts; 100dvh is only the frame before that
   measurement lands. */
.add-form--expanded {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 100dvh;
  z-index: 61;
  gap: 0;
  /* Up from the bottom edge, its whole height, which is what --modal-rise: 100%
     means to the shared keyframes in style.css. Same motion every bottom sheet
     in the app uses, and the same edge the keyboard is about to arrive from.

     It used to fly from the field's own position in the list, which was the
     right answer while the field had one. It has not had one since the bar
     took over the shell — see the header of lib/useSearchSheet. */
  --modal-rise: 100%;
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) both;
}

/* Leaving goes the other way: --ease-fall starts slow and gets out of the way,
   which is what a sheet being dismissed should do. The composable's timer
   unmounts it after this has run; the duration there is deliberately longer
   than this one. */
.add-form--closing {
  animation: modal-rise-out var(--transition-slow) var(--ease-fall) both;
}

/* The header band. Collapsed it draws nothing — no padding, no rule — so above
   the bar boundary the field sits exactly where the flow puts it. Below it there
   is no collapsed state on screen at all; see the media query on .add-slot. */
.add-head {
  display: flex;
  flex-direction: column;
}

.add-form--expanded .add-head {
  flex-shrink: 0;
  width: 100%;
  /* +2rem so the field inside spans the same box it did in the column: the
     gutter lives in this padding rather than in the max-width. */
  max-width: calc(480px + 2rem);
  margin-inline: auto;
  padding: calc(var(--safe-top) + 0.35rem) 1rem 0.7rem;
  /* On top of the button's own bottom padding: leaving the two edges nearly
     touching read as one control rather than a way out above a field. */
  gap: 0.5rem;
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

/* The one exit the keyboard can never cover. Leading, because that is the shape
   a back affordance has everywhere else in the app; the negative margin pulls
   the button's own padding out so the arrow lines up with the gutter rather
   than sitting a few pixels inside it. */
.add-head__bar {
  display: flex;
  justify-content: flex-start;
  margin-left: -0.4rem;
}

/* The band fades as the sheet drops, rather than cutting out the moment the
   dismissal is decided. Same duration and curve as the sheet's own exit and the
   cover's, so the screen resolves in one moment instead of the sheet still
   travelling while its header has already gone. It keeps its layout box the
   whole way, so nothing it does moves the field. */
.add-form--expanded .add-head__bar {
  transition: opacity var(--transition-slow) var(--ease-fall);
}

.add-form--closing .add-head__bar {
  opacity: 0;
}

/* Opaque, and in the surface colour rather than the page's: the results are the
   content now, and content sits on a surface everywhere else in the app. The
   page colour would say "you are still on the list", which is the lie that
   makes a half-dimmed list behind the matches feel wrong. Fading this in is
   what takes the list away.

   It is not a dismissal target: a full-screen tap-to-close under a search you
   raised on purpose is the largest misclick in the app, so it only swallows
   touchmove. The stack it has to clear is the header (--z-header), the action bar
   and the checkout slider; teleported menus stay above it at 1000. */
.add-cover {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--bg-surface);
}

.add-cover-enter-active {
  transition: opacity var(--transition-fast) var(--ease-standard);
}

/* The same duration AND the same curve as the sheet's own exit, so the list
   comes back at exactly the rate the sheet clears it rather than being most of
   the way there while the sheet is still barely moving. */
.add-cover-leave-active {
  transition: opacity var(--transition-slow) var(--ease-fall);
}

.add-cover-enter-from,
.add-cover-leave-to {
  opacity: 0;
}

/* ─── The desktop blur ───────────────────────────────────────────────────────
   Everything behind the focused field, header included, goes soft and a shade
   darker, so the search is the one sharp thing on screen. The same 6px blur
   AccountActionModal puts behind its dialog. It shares the cover's fade, and
   so its reduced-motion rule too.

   The layering is the whole trick, and the first version got it wrong. The
   SLOT lifts to 56, above the header's layers (ribbon 30, bar 40), and that
   makes it a stacking context; the blur is inside it. So the blur must have NO
   z-index of its own: with one, it outranked the form in that same context and
   blurred the field and its matches along with the page. Without one it paints
   in DOM order, before the form, and still covers the whole viewport because
   nothing above it sets a transform. Teleported menus stay at 1000. */
.add-dim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--backdrop) 35%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.add-slot--dim {
  z-index: 56;
}

/* Belt and braces: below the bar boundary `dimmed` is never true, since the
   field only opens as the sheet there, but a blur must not be the thing that
   proves it wrong. */
@media (max-width: 899.98px) {
  .add-dim {
    display: none;
  }
}

.suggest-enter-active,
.suggest-leave-active {
  transition: opacity var(--transition-fast) var(--ease-standard);
}

.suggest-enter-from,
.suggest-leave-to {
  opacity: 0;
}

/* Overlay under the input row rather than in-flow, so opening the dropdown
   never pushes the list down. */
.suggestions-wrap {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 0.35rem;
  z-index: 20;
  /* The dropdown's surface is the WHOLE panel, not just the list. It used to be
     on .suggestions, which left everything above the list -- the shop
     chips and their divider -- floating on the page with no card under it. On
     the light page nobody noticed; over the page blur the chips' near-white
     border-bottom read as a stray white line above the results. On the panel,
     that border is what it was meant to be, a divider inside the card.

     No overflow: hidden to round the corners off: the tap counters are
     positioned against this box and are thrown past its edge on purpose. */
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-xl);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--text-primary) 14%, transparent);
}

/* Lifted, it is not an overlay at all: it is what is left of the screen under
   the band, and it takes the rest of the height. */
.add-form--expanded .suggestions-wrap {
  /* relative rather than static: it still has to sit in the flow, but it is also
     what the tap counters are positioned against, and they must not be clipped
     by the scrolling results inside it.

     inset and z-index have to be put back by hand. The rule above is the
     DROPDOWN's, and its top/left/right and stacking only ever applied because it
     was absolute there; static ignored them silently. Turning this relative
     hands them all back — top: 100% on a relative box shifts it down a full
     container height, which puts the entire results panel off the bottom of the
     screen and looks exactly like search having stopped working. */
  position: relative;
  inset: auto;
  z-index: auto;
  margin-top: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: calc(480px + 2rem);
  margin-inline: auto;
  /* The dropdown's card, taken off again: lifted, the screen is the surface. */
  background: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.suggestions {
  list-style: none;
  margin: 0;
  padding: 0.3rem;
  max-height: 275px;
  overflow-y: auto;
}

/* Lifted, every one of those is wrong: a border, a radius and a drop shadow are
   how a dropdown says it is floating over a page, and the page is gone. The
   rows run edge to edge on the screen's own surface instead, and the only cap
   left is the screen. */
.add-form--expanded .suggestions {
  flex: 1;
  min-height: 0;
  max-height: none;
  padding: 0.35rem 0 calc(1.5rem + var(--safe-bottom));
  background: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
  overscroll-behavior: contain;
}

.suggestion {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.5rem 0.6rem;
  background: none;
  border: none;
  border-radius: var(--radius-lg);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}

/* Full-bleed rows with the gutter inside them, so a long product name gets the
   whole width and the touch target runs to both edges. */
.add-form--expanded .suggestion {
  min-height: 56px;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-radius: 0;
}

.add-form--expanded .suggestion-emoji {
  width: 2.15rem;
  height: 2.15rem;
  font-size: var(--text-xl);
}

/* Mirrors .list-meta__label in the shopping list: the two are the same kind of
   thing — a quiet word naming what the rows under it are. */
.suggestions-label {
  flex-shrink: 0;
  margin: 0;
  padding: 0.85rem 1rem 0.3rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-disabled);
}

/* The shop filter, above the results.

   Scrolls sideways rather than wrapping: three shops fit on a phone today and a
   fourth would not, and a row that grows a second line pushes the results down
   by 40px every time somebody types. flex-shrink: 0 keeps it out of the
   dropdown's own vertical squeeze for the same reason. */
.shop-filter {
  display: flex;
  flex-shrink: 0;
  gap: 0.4rem;
  padding: 0.6rem 1rem;
  overflow-x: auto;
  /* The scrollbar would sit on the results below it. */
  scrollbar-width: none;
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.shop-filter::-webkit-scrollbar {
  display: none;
}

/* The list's chips, at the size a filter wants: they are pressed on the way to
   something else rather than being the thing, so they give up the 40px tap
   target the add chips keep. */
.shop-filter__chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.4rem;
  padding: 0.3rem 0.65rem;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.shop-filter__chip:hover,
.shop-filter__chip:focus-visible {
  border-color: var(--color-primary);
}

/* The selected one has to read as selected while the mark inside it keeps its
   own brand colours -- so the state is carried by the pill, never by the logo. */
.shop-filter__chip--on {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-surface));
  border-color: var(--color-primary);
  color: var(--text-main);
  font-weight: var(--weight-bold);
}

.suggestions-hint {
  margin: 0;
  padding: 1.5rem 1rem;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

/* ─── The add, confirmed ─────────────────────────────────────────────────────
   Announced, not drawn. The confirmation that used to be a band above the
   results is a mark on the row now, so this carries only what a tick cannot. */
.added-announce {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* The keyboard highlight shares the hover surface deliberately: it is the same
   state — "this is the one you are about to commit" — reached a different way.
   It needs its own class rather than :focus-visible because focus never leaves
   the input during arrow navigation; aria-activedescendant is what moves, and
   it moves virtually. */
.suggestion:hover,
.suggestion:focus-visible,
.suggestion--active {
  background: var(--bg-hover);
}

/* ─── A row that is already on the list ──────────────────────────────────────
   The tick rides the product tile, the way the row on the list wears its own
   mark. It is always rendered and scaled to nothing, so appearing costs no
   layout -- the row's height and the name's position never move. */
.suggestion-emoji {
  position: relative;
}

.suggestion-tick {
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

.suggestion--added .suggestion-tick {
  transform: scale(1);
}

.suggestion-tick :deep(svg) {
  width: 0.62rem;
  height: 0.62rem;
  display: block;
  stroke: currentColor;
  stroke-width: 3.5;
  fill: none;
}

/* The name steps back once its product is on the list: still readable, no longer
   the thing being offered. */
.suggestion--added .suggestion-name {
  color: var(--text-secondary);
}

/* The moment of adding, on the row that was tapped: one pass, leaving the tick
   behind as the standing answer.

   Two rules and two keyframes, identical in everything but their names. The row
   that was just tapped is very often the row that was tapped a moment ago --
   that is how you add three of something -- and re-applying the same animation
   to an element already wearing it does nothing at all. Swapping which of these
   two is on the row is a real declaration change, so the flash starts over. */
.suggestion--lit-a {
  animation: suggestion-lit-a var(--transition-slow) var(--ease-standard);
}

.suggestion--lit-b {
  animation: suggestion-lit-b var(--transition-slow) var(--ease-standard);
}

@keyframes suggestion-lit-a {
  50% {
    background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
  }
}

@keyframes suggestion-lit-b {
  50% {
    background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
  }
}

/* ─── The tap counters ───────────────────────────────────────────────────────
   A layer of its own, over the results and outside their scroll box, so a
   counter thrown from the top row is not sliced off by the list's edge. It never
   takes a press: the row underneath is still the thing being tapped, and being
   tapped repeatedly is the entire point. */
.pop-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}

.pop {
  position: absolute;
  padding: 0.1rem 0.45rem;
  border-radius: var(--radius-pill);
  background: var(--color-primary);
  color: var(--text-inverse);
  font-size: var(--text-sm);
  font-weight: var(--weight-extrabold);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  box-shadow: var(--elevation-primary-soft);
  /* left/top put it under the finger; the keyframes carry the centring, because
     an animated transform replaces any transform set here. */
  animation: pop-drift 0.9s var(--ease-fall) forwards;
}

@keyframes pop-drift {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.6);
  }
  /* Overshoots its final size on the way out of the finger, which is what makes
     it read as thrown rather than faded up. */
  22% {
    opacity: 1;
    transform: translate(
        calc(-50% + var(--pop-dx) * 0.35),
        calc(-50% + var(--pop-dy) * 0.35)
      )
      scale(1.08);
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--pop-dx)), calc(-50% + var(--pop-dy)))
      scale(0.92) rotate(var(--pop-rot));
  }
}

/* Mirrors .suggestion's box exactly, so real rows land where the placeholder
   stood instead of shifting the list as they arrive. */
.suggestion-skeleton {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
}

.suggestion-skeleton__text {
  display: flex;
  flex-direction: column;
  gap: 0.32rem;
  flex: 1;
  min-width: 0;
}

.suggestion-emoji {
  flex-shrink: 0;
  font-size: var(--text-lg);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  border: var(--border-width-thin) solid color-mix(in srgb, var(--color-primary) 22%, var(--bg-surface));
}

.suggestion-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.suggestion-name {
  font-size: var(--text-md);
  color: var(--text-primary);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The second line: the maker, and the shops carrying it. Wraps
   rather than truncating, because a row with three shops is exactly the row
   worth looking at. */
.suggestion-sub {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  min-width: 0;
}

.suggestion-maker {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  line-height: 1.3;
}


/* The escape hatch is an action, not a product: a rule separates it from the
   matches above, and it takes the primary colour so it reads as a way out
   rather than as one more thing to buy. When it is the only row there is
   nothing to separate it from, so the rule collapses. */
.suggestions-hatch:not(:only-child) {
  border-top: var(--border-width-thin) solid var(--border-light);
  margin-top: 0.3rem;
  padding-top: 0.3rem;
}

/* First in the list (see hatchFirst), the rule goes under it instead: on top it
   sat right against the shop filter's own divider and drew a second line, and
   what it separates from now is the matches below. */
.suggestions-hatch:not(:only-child):first-child {
  border-top: none;
  margin-top: 0;
  padding-top: 0;
  border-bottom: var(--border-width-thin) solid var(--border-light);
  margin-bottom: 0.3rem;
  padding-bottom: 0.3rem;
}

/* Edge to edge with the rows it sits under, rather than inset by a card's
   padding that is no longer there. */
.add-form--expanded .suggestions-hatch:not(:only-child) {
  margin-top: 0.35rem;
  padding-top: 0.35rem;
}

/* Same icon as the modal this row opens, so the two read as one action. */
.suggestion-icon {
  width: 1.05rem;
  height: 1.05rem;
  background-color: var(--color-primary);
  mask: url('../assets/package-search.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/package-search.svg') no-repeat center / contain;
}

/* Quieter than the products it sits under: this is the way out, not a thing to
   buy. Only the action line takes the primary colour, and it keeps the same
   weight as a real product's maker so it never out-shouts the matches. */
.suggestion-name--custom {
  color: var(--text-secondary);
}

.suggestion-maker--custom {
  color: var(--color-primary);
}

.add-row {
  display: flex;
  align-items: center;
  background: var(--bg-surface);
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-2xl);
  overflow: hidden;
  transition: border-color var(--transition-fast);
}

/* Nothing travels on its own any more: the whole sheet rises and falls as one
   object, so the field only has to hold its height inside it. The transform
   transition that used to carry it between the list and the screen is gone with
   the FLIP that set it — see the header of lib/useSearchSheet. */
.add-form--expanded .add-row {
  flex-shrink: 0;
  transition: border-color var(--transition-fast);
}

.add-row:focus-within {
  border-color: var(--color-primary);
}

.add-row input {
  flex: 1;
  padding: 0.85rem 1rem;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--text-md);
  color: var(--text-primary);
  outline: none;
  min-width: 0;
}

.add-row input::placeholder {
  color: var(--text-disabled);
}


.add-btn {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  /* Even on all four sides: the row has no padding of its own, so this margin
     is the whole gap to its inner edge. */
  margin: 4px;
  background: var(--color-primary);
  color: var(--text-inverse);
  border: none;
  border-radius: var(--radius-lg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--transition-fast);
  padding: 0;
}

/* One cell, both icons in it. */
.add-btn {
  display: grid;
  place-items: center;
}

.add-btn__icon {
  grid-area: 1 / 1;
  transition: opacity 0.11s ease, transform 0.11s ease;
}

/* The job the button is not doing. Faded rather than unmounted -- see the
   template. */
.add-btn__icon--off {
  opacity: 0;
  transform: scale(0.7);
}

.add-icon {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  background-color: var(--text-inverse);
  mask: url('../assets/add.svg') no-repeat center / contain;
  -webkit-mask: url('../assets/add.svg') no-repeat center / contain;
}

/* Inlined rather than masked, for the reason the scan glyph below is: a tick is
   a single hairline in the asset and would dissolve into the green. Weighted to
   the plus it stands in for, so the swap changes the shape and nothing else. */
.confirm-icon {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.confirm-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 3;
  fill: none;
}

/* Inlined rather than masked like its neighbours, for the reason .suggestion-tick
   is: the asset ships at stroke-width 1, and a barcode glyph is nothing BUT thin
   strokes — masked at this size it dissolves into the green. A shade larger than
   the plus, too, since seven hairlines read lighter than one stroked cross. */
.scan-icon {
  width: calc(var(--size-icon-lg) + 2px);
  height: calc(var(--size-icon-lg) + 2px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.scan-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2.1;
  fill: none;
}

.add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}


/* The sheet still opens — it is where the room comes from — it just opens at
   once. Its own rise needs nothing here: style.css redefines the modal-rise
   keyframes under this query so every sheet in the app loses the travel and
   keeps the fade. The composable checks the same query and skips its timer. */
@media (prefers-reduced-motion: reduce) {
  .add-form--expanded .add-head__bar,
  .add-cover-enter-active,
  .add-cover-leave-active,
  .suggest-enter-active,
  .suggest-leave-active,
  .suggestion,
  .suggestion-tick,
  .add-btn__icon {
    transition: none;
  }

  /* The tick still arrives, it just does not grow into place. */
  .suggestion-tick {
    transform: scale(1);
  }

  .suggestion--lit-a,
  .suggestion--lit-b {
    animation: none;
  }

  /* The count still appears and still goes away on its own — it is the answer to
     "did that tap count", not decoration — it just does not fly to get there. */
  @keyframes pop-drift {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%);
    }
    22% {
      opacity: 1;
      transform: translate(-50%, -50%);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, -50%);
    }
  }

  /* Still swapped, just not scaled into place. */
  .add-btn__icon--off {
    transform: none;
  }
}
</style>

