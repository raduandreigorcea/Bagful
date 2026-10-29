<script setup lang="ts">
import { computed, type PropType } from 'vue'
import AppIcon from './AppIcon.vue'
import { normalizeMemberRole } from '../lib/memberRoles'
import { initialOf, memberDisplayName } from '../lib/userIdentity'
import type { ListMemberProfile } from '../lib/listRealtime'
import { t } from '../lib/i18n'

// Who is in a list, by face and name, and the next face: the empty one that
// invites somebody. Used twice by the list sheet: for the list you are on, and
// for another list you peek at. Both answer "who is here, and how do I add someone".
const props = defineProps({
  // Already ordered for display (you first, then the owner).
  members: { type: Array as PropType<ListMemberProfile[]>, default: () => [] },
  ownerUserId: { type: String, default: '' },
  currentUserId: { type: String, default: '' },
  // The invite belongs to the list you are on; another list's has no code here.
  canInvite: { type: Boolean, default: true },
})

const emit = defineEmits<{ invite: [] }>()

const alone = computed(() => props.members.length <= 1)

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
</script>

<template>
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
      <li v-if="canInvite" class="member">
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
    <p v-if="alone && canInvite" class="list-sheet__alone">{{ t('list.aloneHint') }}</p>
  </section>
</template>

<style scoped>
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
</style>
