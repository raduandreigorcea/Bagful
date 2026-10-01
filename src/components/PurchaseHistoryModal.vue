<script setup lang="ts">
import { ref, computed, watch, type PropType } from 'vue'
import { useSupabase } from '../supabase'
import AppModal from './AppModal.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import SkeletonBlock from './SkeletonBlock.vue'
import { getProductEmoji } from '../lib/productEmoji'
import { normalizeSearchText, type ProductSuggestion } from '../lib/productSearch'
import {
  groupCheckouts,
  trimPartialTail,
  type CheckoutEntry,
  type DayLabel,
} from '../lib/purchaseHistory'
import type { ListMemberProfile } from '../lib/listRealtime'
import { formatDate, formatTime, t, tn } from '../lib/i18n'
import { initialOf } from '../lib/userIdentity'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  listId: { type: String, default: '' },
  currentUserId: { type: String, default: '' },
  memberProfiles: { type: Array as PropType<ListMemberProfile[]>, default: () => [] },
})

// History is for two things people actually ask it: "did we buy X?" (the
// search) and "put that back on the list" (Add again).
const emit = defineEmits<{ close: []; 'add-again': [product: ProductSuggestion] }>()

const query = ref('')

// Which products this visit has put back, so the button can say so instead of
// inviting a second tap that would only raise the quantity.
const readded = ref(new Set<string>())

function addAgain(entry: CheckoutEntry) {
  const name = entry.name ?? ''
  if (!name) return
  emit('add-again', { name, maker: entry.maker ?? null })
  readded.value = new Set(readded.value).add(readdKey(entry))
}

// The whole trip back on the list: "the same as last Saturday" is the common
// case for groceries, and one tap per item is too many. Items this visit has
// already put back are skipped, so pressing it after a few single adds does not
// double them up.
function addTripAgain(items: CheckoutEntry[]) {
  for (const entry of items) {
    if (!readded.value.has(readdKey(entry))) addAgain(entry)
  }
}

function tripReadded(items: CheckoutEntry[]): boolean {
  return items.every((entry) => readded.value.has(readdKey(entry)))
}

// History rows always carry an id from the database; the fallback only keeps the
// type honest for a row that somehow does not.
function readdKey(entry: CheckoutEntry): string {
  return entry.id ?? `${entry.name ?? ''}|${entry.maker ?? ''}`
}

const db = useSupabase()

// The server keeps at most 60 checkouts per list; this row cap comfortably
// covers that many checkouts' worth of items.
const HISTORY_LIMIT = 500
const entries = ref<CheckoutEntry[]>([])
const loading = ref(false)
const error = ref('')

// Re-fetch every time the modal opens so it reflects checkouts made since the
// last look. Cheap (one indexed query, capped rows) and always current.
// immediate: the modal is lazy-mounted at the moment it opens, so `open` is
// already true on first render — without this the first open would never fetch.
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      readded.value = new Set()
      loadHistory()
    }
  },
  { immediate: true },
)

async function loadHistory() {
  if (!props.listId) return
  loading.value = true
  error.value = ''
  const { data, error: fetchError } = await db
    .from('purchase_history')
    .select('id, name, maker, quantity, checkout_id, purchased_by, purchased_at, added_by_name, added_by_image_url')
    .eq('list_id', props.listId)
    // Rows in one checkout share a single purchased_at, and Postgres returns
    // tied rows in no particular order — without tiebreakers every open could
    // shuffle them. checkout_id keeps a checkout's rows contiguous (which the
    // partial-tail trim relies on); id pins the order within it.
    .order('purchased_at', { ascending: false })
    .order('checkout_id', { ascending: true })
    .order('id', { ascending: true })
    .limit(HISTORY_LIMIT)

  if (fetchError) {
    error.value = t('error.loadHistoryFailed')
    entries.value = []
  } else {
    // If the fetch filled the row cap, the oldest checkout may have been cut
    // mid-way; trim it so every checkout shown is complete.
    entries.value = trimPartialTail((data ?? []) as CheckoutEntry[], HISTORY_LIMIT)
  }
  loading.value = false
}

// Filtered before grouping, so a trip with no match drops out whole and a day
// with no trip drops out with it: what is left reads as "these are the times
// we bought it".
const visibleEntries = computed(() => {
  const needle = normalizeSearchText(query.value.trim())
  if (!needle) return entries.value
  return entries.value.filter((e) =>
    normalizeSearchText(`${e.name ?? ''} ${e.maker ?? ''}`).includes(needle),
  )
})

const days = computed(() => groupCheckouts(visibleEntries.value))

function buyerProfile(userId: string | null | undefined) {
  return props.memberProfiles.find((m) => m.user_id === userId) || null
}

function buyerName(userId: string | null | undefined) {
  if (userId && userId === props.currentUserId) return t('history.you')
  return buyerProfile(userId)?.display_name || t('history.someone')
}

function buyerInitial(userId: string | null | undefined) {
  return initialOf(buyerName(userId))
}

// Both of these follow the APP's language, not the device's, so a Romanian
// phone reading the app in English does not get English labels above
// device-formatted dates.
function checkoutTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatTime(d)
}

function dayLabel(label: DayLabel) {
  if (label.kind === 'today') return t('history.today')
  if (label.kind === 'yesterday') return t('history.yesterday')
  return formatDate(label.iso, { weekday: 'short', month: 'short', day: 'numeric' })
}
</script>

<template>
  <AppModal
    :open="open"
    overlay-class="history-overlay"
    transition="modal-fade"
    @close="emit('close')"
  >
      <div class="history-modal" role="dialog" aria-modal="true" :aria-label="t('history.buttonLabel')">
        <div class="history-modal__header">
          <div class="history-modal__title-wrap">
            <div class="history-modal__icon-bg">
              <AppIcon class="header-icon" name="history" />
            </div>
            <div>
              <h3>{{ t('history.title') }}</h3>
              <p class="history-modal__subtitle">{{ t('history.subtitle') }}</p>
            </div>
          </div>
          <ModalCloseButton :aria-label="t('history.close')" @click="emit('close')" />
        </div>

        <div class="history-modal__body">
          <!-- Loading: the exact structure and classes of the loaded list
               (dl / dt / dd), so every spacing rule applies identically and
               the swap to real content cannot shift the layout. Two skeleton
               days fill the fixed-height modal. -->
          <dl v-if="loading" class="history-days" aria-hidden="true">
            <template v-for="(cards, d) in [[3, 2], [3]]" :key="d">
              <dt class="history-day__label">
                <SkeletonBlock width="4rem" height="0.9rem" />
              </dt>
              <dd v-for="(rows, c) in cards" :key="c" class="checkout">
                <div class="checkout__head">
                  <SkeletonBlock width="24px" height="24px" radius="50%" />
                  <SkeletonBlock width="34%" height="0.85rem" />
                  <!-- The trip button's box, so the head is as tall loading as
                       loaded and nothing below it moves when the rows land. -->
                  <SkeletonBlock class="checkout__readd-skeleton" width="4.5rem" height="2.05rem" radius="0.65rem" />
                </div>
                <ul class="history-list">
                  <li v-for="n in rows" :key="n" class="history-row history-row--skeleton">
                    <SkeletonBlock width="2.05rem" height="2.05rem" radius="0.65rem" />
                    <SkeletonBlock :width="`${42 + ((n + c + d) % 3) * 14}%`" height="0.9rem" />
                  </li>
                </ul>
              </dd>
            </template>
          </dl>

          <!-- Error / empty -->
          <p v-else-if="error" class="history-empty">{{ error }}</p>
          <p v-else-if="!entries.length" class="history-empty">
            {{ t('history.empty') }}
          </p>

          <template v-else>
          <input
            v-model="query"
            class="history-search"
            type="search"
            :placeholder="t('history.searchPlaceholder')"
            :aria-label="t('history.searchPlaceholder')"
            autocomplete="off"
          />
          <p v-if="!days.length" class="history-empty">
            {{ t('history.noMatch', { query: query.trim() }) }}
          </p>

          <!-- Day -> checkout -> items. A description list so the day labels
               (dt) can stick to the top of the scrolling body; each checkout
               is a dd under its day. -->
          <dl v-else class="history-days">
            <template v-for="day in days" :key="day.day">
              <dt class="history-day__label">{{ dayLabel(day.label) }}</dt>

              <dd v-for="checkout in day.checkouts" :key="checkout.key" class="checkout">
                <div class="checkout__head">
                  <img
                    v-if="buyerProfile(checkout.purchasedBy)?.image_url"
                    :src="buyerProfile(checkout.purchasedBy)?.image_url ?? ''"
                    :alt="t('common.avatarAlt', { name: buyerName(checkout.purchasedBy) })"
                    class="checkout__avatar"
                  />
                  <span v-else class="checkout__avatar checkout__avatar--fallback">
                    {{ buyerInitial(checkout.purchasedBy) }}
                  </span>
                  <span class="checkout__buyer">{{ buyerName(checkout.purchasedBy) }}</span>
                  <span class="checkout__time">{{ checkoutTime(checkout.purchasedAt) }}</span>
                  <button
                    type="button"
                    class="checkout__readd"
                    :class="{ 'checkout__readd--done': tripReadded(checkout.items) }"
                    :disabled="tripReadded(checkout.items)"
                    :aria-label="
                      tripReadded(checkout.items)
                        ? t('history.tripReadded')
                        : tn('history.addTripLabel', checkout.items.length)
                    "
                    @click="addTripAgain(checkout.items)"
                  >
                    <AppIcon :name="tripReadded(checkout.items) ? 'check-bold' : 'plus'" />
                    <span>{{ tripReadded(checkout.items) ? t('history.tripReaddedShort') : t('history.addTrip') }}</span>
                  </button>
                </div>

                <ul class="history-list">
                  <li v-for="entry in checkout.items" :key="entry.id" class="history-row">
                    <span class="history-emoji" aria-hidden="true">{{ getProductEmoji(entry.name ?? '', entry.maker || '') }}</span>
                    <span class="history-text">
                      <span class="history-name">{{ entry.name }}</span>
                      <span v-if="entry.maker" class="history-maker">{{ entry.maker }}</span>
                    </span>
                    <span v-if="(entry.quantity ?? 1) > 1" class="history-qty">x{{ entry.quantity }}</span>
                    <img
                      v-if="entry.added_by_image_url"
                      :src="entry.added_by_image_url"
                      :alt="t('history.addedThis', { name: entry.added_by_name || t('common.memberFallback') })"
                      class="history-adder"
                      :title="t('history.addedBy', { name: entry.added_by_name || t('common.memberFallback') })"
                    />
                    <span
                      v-else
                      class="history-adder history-adder--fallback"
                      :title="t('history.addedBy', { name: entry.added_by_name || t('common.memberFallback') })"
                    >
                      {{ initialOf(entry.added_by_name) }}
                    </span>
                    <button
                      type="button"
                      class="history-readd"
                      :class="{ 'history-readd--done': readded.has(readdKey(entry)) }"
                      :disabled="readded.has(readdKey(entry))"
                      :aria-label="
                        readded.has(readdKey(entry))
                          ? t('history.readded', { name: entry.name ?? '' })
                          : t('history.addAgain', { name: entry.name ?? '' })
                      "
                      @click="addAgain(entry)"
                    >
                      <AppIcon :name="readded.has(readdKey(entry)) ? 'check-bold' : 'plus'" />
                    </button>
                  </li>
                </ul>
              </dd>
            </template>
          </dl>
          </template>
        </div>
      </div>
  </AppModal>
</template>

<style scoped>
.history-search {
  width: 100%;
  min-height: 44px;
  /* The body has no top padding of its own (see .history-modal__body), so
     the field brings the gap under the header with it. */
  margin: var(--space-4) 0 var(--space-3);
  padding: 0 var(--space-4);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-pill);
  background: var(--bg-surface-alt);
  font-size: var(--text-md);
  color: var(--text-primary);
}

.history-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
}

/* A plus, because it does what the plus does everywhere else in the app: puts
   the thing on the list. Once pressed it becomes a tick and stops, since a
   second tap would only raise the quantity of something already there. */
.history-readd {
  flex-shrink: 0;
  /* The emoji tile's box exactly, so a row reads as two matching squares
     with the name between them. */
  width: 2.05rem;
  height: 2.05rem;
  margin-left: var(--space-1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: 0.65rem;
  background: var(--bg-surface);
  color: var(--color-primary);
  cursor: pointer;
  position: relative;
}

/* Drawn at the tile's 33px, hit at 44px. */
.history-readd::after {
  content: '';
  position: absolute;
  inset: -6px;
}

/* The trip's button, in the head beside the time. Same height, corner and
   colours as the per-item ones below it, with a word, because "all of this"
   is not something a lone plus can say. */
.checkout__readd {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  height: 2.05rem;
  padding: 0 0.6rem 0 0.5rem;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: 0.65rem;
  background: var(--bg-surface);
  color: var(--color-primary);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  white-space: nowrap;
  cursor: pointer;
  position: relative;
}

.checkout__readd-skeleton {
  margin-left: auto;
}

.checkout__readd::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}

.checkout__readd:hover:not(:disabled) {
  background: var(--color-primary-bg);
}

.checkout__readd:active:not(:disabled) {
  background: var(--bg-press);
}

.checkout__readd--done {
  border-color: transparent;
  background: var(--color-primary);
  color: var(--text-inverse);
  cursor: default;
}

.checkout__readd :deep(svg) {
  width: 0.95rem;
  height: 0.95rem;
  display: block;
  stroke: currentColor;
  stroke-width: 2.4;
  fill: none;
}

.history-readd:hover:not(:disabled) {
  background: var(--color-primary-bg);
}

.history-readd:active:not(:disabled) {
  background: var(--bg-press);
}

.history-readd--done {
  border-color: transparent;
  background: var(--color-primary);
  color: var(--text-inverse);
  cursor: default;
}

.history-readd :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2.4;
  fill: none;
}

.history-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.history-modal {
  width: 100%;
  max-width: 520px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Fixed height (not max-height): the skeleton and the loaded list render in
     the same frame size, so the modal doesn't snap bigger when data arrives.
     Mirrors the phone bottom sheet, which is already fixed-height. */
  height: min(85vh, 640px);
}

.history-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-5) var(--space-6);
  border-bottom: var(--border-width-thin) solid var(--bg-hover);
}

.history-modal__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.history-modal__icon-bg {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.header-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.history-modal__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.history-modal__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.history-modal__body {
  /* No top padding on the scroll container: a sticky child pins below it and
     rows stay visible scrolling through the strip, so the label looks afloat.
     The resting gap lives inside the scrolled content (.history-days /
     .history-skeleton) instead, where it scrolls away naturally. */
  padding: 0 var(--space-6) var(--space-6);
  overflow-y: auto;
}

/* The label's own 0.6rem top padding (below) is part of every vertical gap it
   appears in, so the paddings/margins here are reduced by that amount to keep
   the original rhythm: 1rem below the header, 1.4rem between day groups. */
.history-days {
  margin: 0;
  padding-top: 0.4rem;
}

/* dd carries a browser-default indent; the cards do their own layout. */
.history-days dd {
  margin: 0;
}

/* Day labels stick to the top of the scrolling body; the next day's label
   slides in over the previous one. The opaque background is what stops rows
   from showing through while they scroll underneath (dt is not sticky by
   itself — position: sticky does the work). */
.history-day__label {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  /* Symmetric padding: this box is what shows while pinned, so equal space
     above and below the text keeps the pinned label centered in its strip. */
  padding: 0.6rem 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-disabled);
  background: var(--bg-surface);
}

/* Day-group spacing lives on the last card before the next label, not on the
   sticky label itself: margins travel with a stuck element, so margin-top on
   the dt would show as a transparent gap floating above it while pinned. */
.history-days dd:has(+ dt) {
  margin-bottom: 0.8rem;
}

/* One checkout event: a buyer + time header over the items bought together. */
.checkout {
  border: var(--border-width-thin) solid var(--bg-hover);
  border-radius: var(--radius-xl);
  padding: 0.6rem;
  background: var(--bg-surface);
}

.checkout + .checkout {
  margin-top: 0.6rem;
}

.checkout__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* Inline padding matches .history-row's, so the trip's button sits right
     above the column of per-item ones. */
  padding: 0.1rem 0.4rem 0.55rem;
}

.checkout__avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  border: var(--border-width-thin) solid var(--border-main);
  flex-shrink: 0;
}

.checkout__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
}

.checkout__buyer {
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.checkout__time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-disabled);
  font-variant-numeric: tabular-nums;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.4rem;
  border-radius: var(--radius-md);
  background: var(--bg-surface-alt);
}

/* Keeps .history-row's padding: both rows are 2.05rem of content tall, so the
   0.5rem this used to carry made every placeholder 3.2px taller than the row it
   stands in for -- eight of them, and the whole list stepped up as the real
   entries landed. Only the fill is dropped, because a skeleton is the shape of
   the content and not the surface it will sit on. */
.history-row--skeleton {
  background: transparent;
}

.history-emoji {
  flex-shrink: 0;
  font-size: var(--text-lg);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.05rem;
  height: 2.05rem;
  border-radius: 0.65rem;
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  border: var(--border-width-thin) solid color-mix(in srgb, var(--color-primary) 22%, var(--bg-surface));
}

.history-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.history-name {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-maker {
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-qty {
  flex-shrink: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  border: var(--border-width-thin) solid color-mix(in srgb, var(--color-primary) 28%, var(--bg-surface));
  border-radius: var(--radius-pill);
  padding: 0.12rem 0.42rem;
}

/* Who originally added the item (mirrors the avatar on the main list row). */
.history-adder {
  margin-left: auto;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  border: var(--border-width-thin) solid var(--border-main);
}

.history-adder--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
}

.history-empty {
  text-align: center;
  font-size: var(--text-base);
  color: var(--text-disabled);
  line-height: 1.5;
  margin: 2.5rem 0;
}

/* Modal transitions (mirrors the other modals) */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .history-modal {
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.modal-fade-leave-active .history-modal {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}

/* While the modal moves, subpixel rounding on the shifted content can tip the
   scroll body a fraction past its box and flash a scrollbar. Clip it for the
   length of the entrance; scrolling resumes right after. */
.modal-fade-enter-active .history-modal__body {
  overflow: hidden;
}

/* Bottom sheet on phones */
@media (max-width: 520px) {
  .history-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .history-modal {
    max-width: none;
    height: min(85dvh, 640px);
    max-height: min(85dvh, 640px);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding-bottom: var(--safe-bottom);
    /* Flush with the bottom edge, so it can travel its full height and start
       off screen rather than merely nudging up. */
    --modal-rise: 100%;
  }

  .history-modal__header {
    padding: 1rem;
  }

  .history-modal__body {
    padding: 0 1rem 1rem;
  }
}
</style>
