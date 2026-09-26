<script setup lang="ts">
import { computed, useId, type PropType } from 'vue'
import AppModal from './AppModal.vue'
import AppIcon from './AppIcon.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import ListIcon from './ListIcon.vue'
import { LIST_MEMBERSHIP_CAP } from '../lib/limits'
import { normalizeMemberRole } from '../lib/memberRoles'
import { initialOf, memberDisplayName } from '../lib/userIdentity'
import type { ListMemberProfile } from '../lib/listRealtime'
import { t, tn } from '../lib/i18n'

// Whose list this is. Opened from the list name at the top of the list,
// which is where people look to ask that question.
//
// It gathers what used to be spread over three doors -- a list slot and a
// "Switch" slot in the bottom bar, and "Manage list" and "Invite" in the
// account dialog -- into the one place a list is: who is in it, how to get
// somebody else in, and which list you are looking at. The deep settings
// (name, emoji, roles, leaving) are one row away, in ListSettingsModal,
// because they are occasional and administrative and this sheet is neither.
const props = defineProps({
  open: { type: Boolean, default: false },
  lists: {
    type: Array as PropType<{ id: string; name: string; emoji?: string | null }[]>,
    default: () => [],
  },
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  listEmoji: { type: String, default: '' },
  // Already ordered for display (you first, then the owner).
  members: { type: Array as PropType<ListMemberProfile[]>, default: () => [] },
  ownerUserId: { type: String, default: '' },
  currentUserId: { type: String, default: '' },
})

const emit = defineEmits<{
  close: []
  'switch-list': [id: string]
  'add-list': []
  invite: []
  manage: []
}>()

const titleId = useId()

const alone = computed(() => props.members.length <= 1)
const canAddList = computed(() => props.lists.length < LIST_MEMBERSHIP_CAP)

function roleLabel(member: ListMemberProfile): string {
  if (member.user_id === props.ownerUserId) return t('list.roleOwner')
  return normalizeMemberRole(member.role) === 'moderator' ? t('list.roleModerator') : ''
}

function nameOf(member: ListMemberProfile): string {
  return member.user_id === props.currentUserId ? t('list.you') : memberDisplayName(member)
}

// A mouse wheel only scrolls up and down, so on a desktop a row that scrolls
// sideways would be reachable by trackpad and scrollbar-drag only, and this one
// has no scrollbar. Turn a vertical wheel into sideways travel -- but only while
// the row has somewhere to go, so a list that fits lets the wheel through
// to the sheet as usual.
function scrollMembersSideways(event: WheelEvent) {
  const row = event.currentTarget as HTMLElement
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
  const max = row.scrollWidth - row.clientWidth
  if (max <= 0) return
  const next = row.scrollLeft + event.deltaY
  if ((next <= 0 && row.scrollLeft <= 0) || (next >= max && row.scrollLeft >= max)) return
  event.preventDefault()
  row.scrollLeft = next
}

function addList() {
  emit('close')
  emit('add-list')
}

// Picking the one you are on is confirming where you are, not a switch.
function pick(id: string) {
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
            <ListIcon :value="listEmoji" />
          </span>
          <div class="sheet-header__text">
            <h3 :id="titleId">{{ listName || t('account.listFallback') }}</h3>
            <p>{{ tn('account.memberCount', members.length) }}</p>
          </div>
        </div>
        <ModalCloseButton @click="emit('close')" />
      </header>

      <div class="sheet-body">
        <!-- Who is in it, on the soft card the account dialog uses for who you
             are. Inviting is adding a face to this row, so it is drawn as the
             next face. -->
        <section class="members-card">
          <ul class="list-sheet__members" @wheel="scrollMembersSideways">
            <li v-for="member in members" :key="member.user_id" class="member">
              <img v-if="member.image_url" :src="member.image_url" alt="" class="member__avatar" />
              <span v-else class="member__avatar member__avatar--fallback" aria-hidden="true">
                {{ initialOf(memberDisplayName(member)) }}
              </span>
              <span class="member__name">{{ nameOf(member) }}</span>
              <span v-if="roleLabel(member)" class="member__role">{{ roleLabel(member) }}</span>
            </li>
            <li class="member">
              <button type="button" class="member__invite" @click="emit('invite')">
                <span class="member__avatar member__avatar--invite" aria-hidden="true">
                  <AppIcon name="user-round-plus" />
                </span>
                <span class="member__name member__name--invite">{{ t('list.invite') }}</span>
              </button>
            </li>
          </ul>
          <!-- A list of one is a list nobody else can see, which is most of
               the point missed. So it says why the empty face is there. -->
          <p v-if="alone" class="list-sheet__alone">{{ t('list.aloneHint') }}</p>
        </section>

        <div class="menu-section">
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
          <h4 class="menu-section__heading">{{ t('switcher.heading') }}</h4>
          <div class="menu-section" role="radiogroup" :aria-label="t('switcher.heading')">
            <button
              v-for="list in lists"
              :key="list.id"
              type="button"
              class="menu-row"
              :class="{ 'menu-row--current': list.id === listId }"
              role="radio"
              :aria-checked="list.id === listId"
              @click="pick(list.id)"
            >
              <span class="menu-row__label">
                <span class="menu-row__emoji" aria-hidden="true">
                  <ListIcon :value="list.emoji ?? ''" />
                </span>
                <span class="menu-row__text">{{ list.name || t('account.listFallback') }}</span>
              </span>
              <AppIcon v-if="list.id === listId" class="menu-row__check" name="check-bold" />
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
.members-card {
  border-radius: var(--radius-lg);
  background: var(--bg-surface-alt);
  overflow: hidden;
}

/* The people, by face and name. A row that scrolls sideways rather than a
   list, so a family of six does not push the rest off a phone screen. The
   edges fade, so faces slide out under them rather than being sliced off. */
.list-sheet__members {
  display: flex;
  gap: var(--space-4);
  margin: 0;
  padding: 0.8rem 0.9rem;
  list-style: none;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  scroll-padding-inline: 0.9rem;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 0.9rem, #000 calc(100% - 0.9rem), transparent);
  mask-image: linear-gradient(to right, transparent, #000 0.9rem, #000 calc(100% - 0.9rem), transparent);
}

.list-sheet__members::-webkit-scrollbar {
  display: none;
}

.member {
  flex-shrink: 0;
  scroll-snap-align: start;
  width: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  text-align: center;
}

.member__avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-pill);
  object-fit: cover;
  border: var(--border-width-base) solid var(--bg-surface);
  box-shadow: var(--elevation-soft);
}

.member__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
  color: var(--color-primary);
  font-weight: var(--weight-extrabold);
}

.member__name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.member__role {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

.member__invite {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

/* A face with nobody in it yet: dashed, in the brand colour, so it reads as a
   place to fill rather than a person. */
.member__avatar--invite {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 11px;
  border: var(--border-width-base) dashed color-mix(in srgb, var(--color-primary) 60%, transparent);
  box-shadow: none;
  background: var(--bg-surface);
  color: var(--color-primary);
  transition: background-color var(--transition-fast) var(--ease-standard);
}

.member__avatar--invite :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.member__invite:hover .member__avatar--invite {
  background: var(--color-primary-bg);
}

.member__invite:active .member__avatar--invite {
  background: color-mix(in srgb, var(--color-primary) 18%, var(--bg-surface));
}

.member__name--invite {
  color: var(--color-primary-text);
}

.list-sheet__alone {
  margin: 0;
  padding: 0 0.9rem 0.8rem;
  font-size: var(--text-xs);
  line-height: var(--leading-snug);
  color: var(--text-secondary);
}

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
.menu-row__emoji :deep(.list-icon) {
  width: 16px;
  height: 16px;
}
</style>
