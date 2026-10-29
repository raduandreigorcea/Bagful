<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, type PropType } from 'vue'
import AppModal from './AppModal.vue'
import ListMembersCard from './ListMembersCard.vue'
import AppIcon from './AppIcon.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import ListIcon from './ListIcon.vue'
import { LIST_MEMBERSHIP_CAP } from '../lib/limits'
import type { ListMemberProfile } from '../lib/listRealtime'
import type { ListRow } from '../lib/useList'
import MemberAvatarStack from './MemberAvatarStack.vue'
import { t, tn } from '../lib/i18n'

// Whose list this is. Opened from the list name at the top of the list,
// which is where people look to ask that question.
//
// It is the one place a list is: who is in it, how to get
// somebody else in, and which list you are looking at. The deep settings
// (name, emoji, roles, leaving) are one row away, in ListSettingsModal,
// because they are occasional and administrative and this sheet is neither.
const props = defineProps({
  open: { type: Boolean, default: false },
  lists: { type: Array as PropType<ListRow[]>, default: () => [] },
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  listEmoji: { type: String, default: '' },
  // Already ordered for display (you first, then the owner).
  members: { type: Array as PropType<ListMemberProfile[]>, default: () => [] },
  ownerUserId: { type: String, default: '' },
  currentUserId: { type: String, default: '' },
  // 'lists': which list you are on, from the phone's bar. 'all': that and who is in
  // this one and how to manage it, for the desktop, which has no bar.
  mode: { type: String as PropType<'all' | 'lists'>, default: 'all' },
})

const emit = defineEmits<{
  close: []
  'switch-list': [id: string]
  'add-list': []
  invite: []
  manage: []
}>()

const titleId = useId()

const canAddList = computed(() => props.lists.length < LIST_MEMBERSHIP_CAP)

// What is left to buy, said for the card; a finished list says so instead of
// counting zero, and an empty one says it has nothing yet.
const isDone = (list: ListRow): boolean => !!list.total && list.done === list.total
const percentOf = (list: ListRow): number =>
  list.total ? Math.round(((list.done ?? 0) / list.total) * 100) : 0
function progressText(list: ListRow): string {
  if (!list.total) return t('switcher.empty')
  if (isDone(list)) return t('list.meta.allPicked')
  return tn('switcher.left', list.total - (list.done ?? 0))
}

function addList() {
  emit('close')
  emit('add-list')
}

// A press held this long is a request for the list's members, not a pick: they
// open over the switcher, which stays where it is, and nothing is switched. The
// click that follows the release is swallowed, or it would pick the list as well.
const peekId = ref<string | null>(null)
const peeked = computed(() => props.lists.find((l) => l.id === peekId.value))
// The list you are on has the richer member rows and the invite; the others only
// have what the switcher already loaded for their cards.
const peekedMembers = computed(() =>
  peeked.value?.id === props.listId ? props.members : (peeked.value?.members ?? []),
)
const HOLD_MS = 500
let holdTimer: ReturnType<typeof setTimeout> | undefined
let held = false

function startHold(id: string) {
  held = false
  clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    held = true
    peekId.value = id
  }, HOLD_MS)
}
const cancelHold = () => clearTimeout(holdTimer)
onBeforeUnmount(cancelHold)

// Picking the one you are on is confirming where you are, not a switch.
function pick(id: string) {
  if (held) {
    held = false
    return
  }
  emit('close')
  if (id !== props.listId) emit('switch-list', id)
}
</script>

<template>
  <AppModal :open="open" variant="sheet" @close="emit('close')">
    <div class="app-sheet list-sheet" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <!-- The same header every menu here wears: a tinted square, a title with a
           line under it, and the close button. The square holds the list's
           own emoji where the others hold an icon. -->
      <header class="sheet-header">
        <div class="sheet-header__title-wrap">
          <span class="sheet-header__icon-bg" aria-hidden="true">
            <AppIcon v-if="mode === 'lists'" name="layout-grid" />
            <ListIcon v-else :value="listEmoji" />
          </span>
          <div class="sheet-header__text">
            <h3 v-if="mode === 'lists'" :id="titleId">{{ t('switcher.heading') }}</h3>
            <template v-else>
              <h3 :id="titleId">{{ listName || t('account.listFallback') }}</h3>
              <p>{{ tn('account.memberCount', members.length) }}</p>
            </template>
          </div>
        </div>
        <ModalCloseButton @click="emit('close')" />
      </header>

      <div class="sheet-body">
        <ListMembersCard
          v-if="mode !== 'lists'"
          :members="members"
          :owner-user-id="ownerUserId"
          :current-user-id="currentUserId"
          @invite="emit('invite')"
        />

        <div v-if="mode === 'all'" class="menu-section">
          <button type="button" class="menu-row" @click="emit('manage')">
            <span class="menu-row__label">
              <AppIcon class="menu-row__icon" name="settings" />
              <span>{{ t('account.manageList') }}</span>
            </span>
            <AppIcon class="menu-row__chevron" name="chevron-right" />
          </button>
        </div>

        <!-- Which list you are looking at. Shown to everyone, even with one
             list: it is also the way to a second one. -->
        <section class="menu-section" :aria-label="t('switcher.heading')">
          <h4 v-if="mode === 'all'" class="menu-section__heading">{{ t('switcher.heading') }}</h4>
          <div class="menu-section" role="radiogroup" :aria-label="t('switcher.heading')">
            <button
              v-for="list in lists"
              :key="list.id"
              type="button"
              class="list-card"
              :class="{ 'list-card--current': list.id === listId }"
              role="radio"
              :aria-checked="list.id === listId"
              @click="pick(list.id)"
              @pointerdown="startHold(list.id)"
              @pointerup="cancelHold"
              @pointerleave="cancelHold"
              @pointercancel="cancelHold"
              @contextmenu.prevent
            >
              <span class="list-card__tile" aria-hidden="true">
                <ListIcon :value="list.emoji ?? ''" />
              </span>
              <span class="list-card__body">
                <span class="list-card__name">{{ list.name || t('account.listFallback') }}</span>
                <span class="list-card__meta" :class="{ 'list-card__meta--done': isDone(list) }">
                  {{ progressText(list) }}
                </span>
                <span v-if="list.total" class="list-card__bar" aria-hidden="true">
                  <span class="list-card__fill" :style="{ width: `${percentOf(list)}%` }"></span>
                </span>
              </span>
              <span class="list-card__side">
                <AppIcon v-if="list.id === listId" class="list-card__check" name="check-bold" />
                <MemberAvatarStack
                  v-if="list.members?.length"
                  class="list-card__faces"
                  :members="list.members"
                />
              </span>
            </button>
            <button v-if="canAddList" type="button" class="menu-row" @click="addList">
              <span class="menu-row__label">
                <AppIcon class="menu-row__icon" name="plus" />
                <span>{{ t('account.joinOrCreate') }}</span>
              </span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </AppModal>

  <AppModal :open="!!peeked" variant="sheet" @close="peekId = null">
    <div v-if="peeked" class="app-sheet list-sheet" role="dialog" aria-modal="true" :aria-label="peeked.name">
      <header class="sheet-header">
        <div class="sheet-header__title-wrap">
          <span class="sheet-header__icon-bg" aria-hidden="true">
            <ListIcon :value="peeked.emoji ?? ''" />
          </span>
          <div class="sheet-header__text">
            <h3>{{ peeked.name || t('account.listFallback') }}</h3>
            <p>{{ tn('account.memberCount', peekedMembers.length) }}</p>
          </div>
        </div>
        <ModalCloseButton @click="peekId = null" />
      </header>
      <div class="sheet-body">
        <ListMembersCard
          :members="peekedMembers"
          :owner-user-id="peeked.ownerId ?? ''"
          :current-user-id="currentUserId"
          :can-invite="peeked.id === listId"
          @invite="emit('invite')"
        />
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
/* The vocabulary below is AccountActionModal's, restated rather than shared
   because every dialog here keeps its styles scoped: the same header, the same
   1rem body rhythm, the same bordered rows with a 16px mark and a bold label.
   Matching them by the numbers is what makes this read as one of the menus
   rather than a screen from somewhere else. */
.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
}

.sheet-header__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.sheet-header__icon-bg {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  font-size: 1.25rem;
  line-height: 1;
}

.sheet-header__text {
  min-width: 0;
}

.sheet-header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-header p {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}

.sheet-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0 1rem 1rem;
}

/* The soft, borderless card the account dialog puts who-you-are on. */
/* ── Rows: AccountActionModal's .account-menu-item ───────────────────────── */
.menu-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.menu-section__heading {
  margin: 0 0 -0.1rem;
  padding-left: 0.1rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.menu-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  padding: 0.65rem 0.75rem;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-base) ease, border-color var(--transition-base) ease;
}

.menu-row:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--bg-surface));
}

.menu-row:active {
  background: var(--bg-press);
}

/* The list you are on: marked the way a chosen option is everywhere
   else, a green edge and a tick, not a different kind of row. */
.menu-row--current {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--bg-surface));
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface));
}

.menu-row__label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.menu-row__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-row__icon,
.menu-row__chevron,
.menu-row__check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.menu-row:hover .menu-row__icon {
  color: var(--color-primary);
}

.menu-row__chevron {
  color: var(--text-disabled);
}

.menu-row__check {
  color: var(--color-primary);
}

.menu-row__icon :deep(svg),
.menu-row__chevron :deep(svg),
.menu-row__check :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.menu-row__check :deep(svg) {
  stroke-width: 3;
}

/* An emoji where the other rows have a mark, held to the same 16px column so
   the labels share a left edge. */
.menu-row__emoji {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
  font-size: 0.95rem;
  line-height: 1;
}

/* Held to the column like the marks on the other rows. */
/* One list in the switcher: its mark, its name, how much is left and how far
   along it is, who is in it. Same border and radius as the rows around it, so
   it reads as a taller row rather than a different kind of thing. */
.list-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 72px;
  padding: var(--space-3);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-2xl);
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background var(--transition-fast) var(--ease-standard),
    border-color var(--transition-fast) var(--ease-standard);
}

.list-card:hover {
  background: var(--bg-hover);
}

.list-card:active {
  background: var(--bg-press);
}

.list-card--current {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--bg-surface));
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface));
}

.list-card__tile {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xl);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  font-size: 1.5rem;
  line-height: 1;
}

.list-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.list-card__name {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-card__meta {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.list-card__meta--done {
  color: var(--color-primary-text);
}

.list-card__bar {
  display: block;
  height: 4px;
  margin-top: 3px;
  border-radius: var(--radius-pill);
  background: var(--border-main);
  overflow: hidden;
}

.list-card__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width var(--transition-slow) var(--ease-rise);
}

.list-card__side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  /* The faces sit at the bottom edge of the card, the check (when there is one) above. */
  justify-content: flex-end;
  align-self: stretch;
  gap: 6px;
}

.list-card__faces {
  --member-avatar-size: 24px;
  --member-avatar-ring: var(--bg-surface);
}

.list-card--current .list-card__faces {
  --member-avatar-ring: color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface));
}

.list-card__check {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  color: var(--color-primary);
}

@media (prefers-reduced-motion: reduce) {
  .list-card,
  .list-card__fill {
    transition: none;
  }
}

.menu-row__emoji :deep(.list-icon) {
  width: 16px;
  height: 16px;
}
</style>
