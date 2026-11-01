<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type PropType } from 'vue'
import PopoverMenu from './PopoverMenu.vue'
import ListMembersCard from './ListMembersCard.vue'
import AppIcon from './AppIcon.vue'
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
//
// The shell is PopoverMenu, the same one the sort menu wears, so the header, the
// close button and the panel are decided once. What is left here is the content:
// the members card and the list cards.
const props = defineProps({
  open: { type: Boolean, default: false },
  // The button that opened it, so the panel hangs off it on a wide screen.
  trigger: { type: Object as PropType<HTMLElement | null>, default: null },
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
  invite: [listId: string]
  manage: []
}>()

// A panel's width on a wide screen; the members of a held list open beside it, not over it.
const PANEL_WIDTH = 340

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
  <!-- Closable: the sheet comes up over a bottom bar, where the surface you would
       tap to dismiss is the list you are trying to look at. -->
  <PopoverMenu
    :model-value="open"
    :trigger="trigger"
    closable
    :width="`${PANEL_WIDTH}px`"
    :label="mode === 'lists' ? t('switcher.heading') : listName || t('account.listFallback')"
    :heading="mode === 'lists' ? t('switcher.heading') : listName || t('account.listFallback')"
    :hint="mode === 'lists' ? t('switcher.hint') : tn('account.memberCount', members.length)"
    icon-name="menu-bold"
    @update:model-value="(v: boolean) => !v && emit('close')"
  >
    <!-- The square holds the list's own emoji where the switcher holds an icon. -->
    <template v-if="mode !== 'lists'" #icon>
      <ListIcon :value="listEmoji" />
    </template>

    <ListMembersCard
      v-if="mode !== 'lists'"
      class="sheet-gap"
      :members="members"
      :owner-user-id="ownerUserId"
      :current-user-id="currentUserId"
      @invite="emit('invite', listId)"
    />

    <button v-if="mode === 'all'" type="button" class="menu-item" @click="emit('manage')">
      <AppIcon class="row-icon" name="settings" />
      <span class="row-label">{{ t('account.manageList') }}</span>
      <AppIcon class="row-icon row-icon--quiet" name="chevron-right" />
    </button>

    <!-- Which list you are looking at. Shown to everyone, even with one
           list: it is also the way to a second one. -->
    <h4 v-if="mode === 'all'" class="sheet-body__heading">
      {{ t('switcher.heading') }}
    </h4>
    <button
      v-for="list in lists"
      :key="list.id"
      type="button"
      class="list-card"
      :class="{ 'list-card--current': list.id === listId }"
      role="menuitemradio"
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
    <button v-if="canAddList" type="button" class="menu-item" role="menuitem" @click="addList">
      <AppIcon class="row-icon" name="plus" />
      <span class="row-label">{{ t('account.joinOrCreate') }}</span>
    </button>
  </PopoverMenu>

  <PopoverMenu
    :model-value="!!peeked"
    :trigger="trigger"
    closable
    :width="`${PANEL_WIDTH}px`"
    :label="peeked?.name || t('account.listFallback')"
    :heading="peeked?.name || t('account.listFallback')"
    :hint="tn('account.memberCount', peekedMembers.length)"
    :offset="PANEL_WIDTH + 8"
    @update:model-value="(v: boolean) => !v && (peekId = null)"
  >
    <template #icon>
      <ListIcon :value="peeked?.emoji ?? ''" />
    </template>
    <ListMembersCard
      v-if="peeked"
      :members="peekedMembers"
      :owner-user-id="peeked.ownerId ?? ''"
      :current-user-id="currentUserId"
      @invite="emit('invite', peeked.id)"
    />
  </PopoverMenu>
</template>

<style scoped>
/* The panel, its header and its close button are PopoverMenu's; the rows that
   are plain actions take its .menu-item. What is below is what only this menu has. */
/* PopoverMenu's .menu-item rules only reach its direct slot children, so these
   rows are not wrapped; the spacing a wrapper's gap would give is margins. */
.sheet-gap {
  margin-bottom: 0.35rem;
}

.sheet-body__heading {
  margin: 0.5rem 0 0.1rem;
  padding-left: 0.1rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.row-label {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.row-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  color: var(--text-secondary);
}

.row-icon--quiet {
  color: var(--text-disabled);
}

.row-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* One list in the switcher: its mark, its name, how much is left and how far
   along it is, who is in it. Taller than a plain row, since it carries more. */
.list-card {
  margin-top: 0.35rem;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 72px;
  padding: var(--space-3);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background var(--transition-fast) var(--ease-standard),
    border-color var(--transition-fast) var(--ease-standard),
    scale var(--transition-base) var(--ease-rise);
}

.list-card:hover {
  background: var(--bg-hover);
}

.list-card:active {
  background: var(--bg-press);
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--bg-surface));
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
</style>
