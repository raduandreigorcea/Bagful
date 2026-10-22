<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import { useAuth } from '@clerk/vue'
import { useSupabase } from '../../supabase'
import { userMessage } from '../../lib/errorMessages'
import * as listAdmin from '../../lib/listAdmin'
import type { ListMemberProfile } from '../../lib/listRealtime'
import type { ConfirmOptions } from '../../lib/useConfirm'
import {
  normalizeMemberRole,
  sortMembersForDisplay,
  canManageMember as canManageMemberRule,
  canPromoteToModerator as canPromoteRule,
  canDemoteFromModerator as canDemoteRule,
} from '../../lib/memberRoles'
import { initialOf, memberDisplayName } from '../../lib/userIdentity'
import { t } from '../../lib/i18n'
import AppIcon from '../AppIcon.vue'

// The roster, and what can be done to a row on it. The rules themselves live in
// lib/memberRoles — this decides only what to render and what to write.
const props = defineProps({
  listId: { type: String, default: '' },
  ownerUserId: { type: String, default: '' },
  isOwner: { type: Boolean, default: false },
  isOwnerOrModerator: { type: Boolean, default: false },
  memberProfiles: {
    type: Array as PropType<ListMemberProfile[]>,
    default: () => [],
  },
  // The modal's shared confirm dialog (see DangerPanel for the same argument).
  confirm: {
    type: Function as PropType<(options: ConfirmOptions) => Promise<boolean>>,
    required: true,
  },
})

const emit = defineEmits<{
  (e: 'refresh-list'): void
  (e: 'error', message: string, title?: string): void
}>()

// Which row's actions are showing. A model rather than local state because the
// modal needs to read it: Escape and a backdrop click belong to this menu while
// it is open, not to the dialog underneath it.
const openMenuId = defineModel<string>('openMenuId', { default: '' })

const { userId } = useAuth()
const db = useSupabase()

const memberActionPendingId = ref('')

const sortedMembers = computed(() => sortMembersForDisplay(props.memberProfiles, props.ownerUserId))

function canManageMember(member: ListMemberProfile) {
  return canManageMemberRule(member, {
    actorIsOwnerOrModerator: props.isOwnerOrModerator,
    ownerUserId: props.ownerUserId,
    actorUserId: userId.value ?? '',
  })
}

function canPromoteToModerator(member: ListMemberProfile) {
  return canPromoteRule(member, props.isOwner)
}

function canDemoteFromModerator(member: ListMemberProfile) {
  return canDemoteRule(member, props.isOwner)
}

function toggleMemberMenu(memberUserId: string) {
  if (memberActionPendingId.value) return
  openMenuId.value = openMenuId.value === memberUserId ? '' : memberUserId
}

function closeMemberMenu() {
  openMenuId.value = ''
}

// The member whose actions are showing, used by the mobile action sheet, which
// is teleported out of the scrolling panel and so cannot read the v-for's row.
const activeMenuMember = computed(() => {
  if (!openMenuId.value) return null
  return props.memberProfiles.find((m) => m.user_id === openMenuId.value) || null
})

function handleGlobalPointerDown(event: PointerEvent) {
  if (!openMenuId.value) return

  const target = event.target
  if (!(target instanceof Element)) {
    closeMemberMenu()
    return
  }

  // The sheet is teleported to <body>, so it is outside the trigger's wrapper.
  // Without this it would close on pointerdown, before the click ever lands.
  if (target.closest('.member-actions-menu-wrap')) return
  if (target.closest('.member-sheet')) return
  closeMemberMenu()
}

// Escape is not handled here: AppModal owns it and routes it through the
// modal's dismiss(), which is what keeps one keystroke from closing this menu
// and the dialog behind it at the same time. Two listeners could only have raced.
onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown)
})

async function setMemberRole(memberUserId: string, role: string) {
  if (!props.isOwner) return
  if (!props.listId || memberActionPendingId.value) return
  memberActionPendingId.value = memberUserId
  // Dismiss on tap; the row's spinner carries the pending state from here.
  closeMemberMenu()
  try {
    const { error } = await listAdmin.setMemberRole(db, props.listId, memberUserId, role)
    if (error) {
      emit('error', userMessage(error, t('error.roleUpdateFailed')))
      return
    }
    emit('refresh-list')
  } finally {
    memberActionPendingId.value = ''
  }
}

async function removeMember(memberUserId: string) {
  if (!props.listId || memberActionPendingId.value) return
  // Dismiss first: on mobile the action sheet covers the confirm dialog.
  closeMemberMenu()
  const confirmed = await props.confirm({
    title: t('members.confirmRemoveTitle'),
    message: t('members.confirmRemoveMessage'),
    danger: true,
  })
  if (!confirmed) return
  memberActionPendingId.value = memberUserId
  try {
    const { error } = await listAdmin.removeMember(db, props.listId, memberUserId)
    if (error) {
      emit('error', userMessage(error, t('error.removeMemberFailed')))
      return
    }
    emit('refresh-list')
  } finally {
    memberActionPendingId.value = ''
  }
}
</script>

<template>
  <div class="tab-panel tab-panel--overlay">
    <div class="panel-section">
      <h4 class="panel-section-title">{{ t('members.title', { n: memberProfiles.length }) }}</h4>
      <p class="panel-section-desc">{{ t('members.desc') }}</p>

      <div class="members-list-wrapper">
        <ul class="members-custom-list">
          <li
            v-for="member in sortedMembers"
            :key="member.user_id"
            class="member-custom-item"
            :class="{ 'member-custom-item--menu-open': openMenuId === member.user_id }"
          >
            <div class="member-custom-left">
              <img
                v-if="member.image_url"
                :src="member.image_url"
                :alt="t('common.avatarAlt', { name: memberDisplayName(member) })"
                class="member-custom-avatar"
              />
              <span v-else class="member-custom-avatar member-custom-avatar--fallback">
                {{ initialOf(member.display_name) }}
              </span>
              <div class="member-custom-details">
                <span class="member-custom-name">
                  {{ memberDisplayName(member) }}
                  <span v-if="member.user_id === userId" class="you-tag">{{ t('members.you') }}</span>
                </span>
              </div>
            </div>
            <div class="member-custom-right">
              <span v-if="member.user_id === ownerUserId" class="member-role-badge role-owner">
                <AppIcon class="badge-icon-wrap" name="crown" />
                {{ t('overview.owner') }}
              </span>

              <div
                v-if="canManageMember(member)"
                class="member-actions-menu-wrap"
                :class="{ 'member-actions-menu-wrap--open': openMenuId === member.user_id }"
                @click.stop
              >
                <button
                  class="member-actions-trigger"
                  type="button"
                  :aria-label="t('members.openActions')"
                  :disabled="memberActionPendingId === member.user_id"
                  @click.stop="toggleMemberMenu(member.user_id)"
                >
                  <span v-if="memberActionPendingId === member.user_id" class="btn-spinner btn-spinner--accent"></span>
                  <AppIcon v-else class="member-actions-icon" name="ellipsis" />
                </button>

                <div v-if="openMenuId === member.user_id" class="member-actions-menu">
                  <button
                    v-if="canPromoteToModerator(member)"
                    class="member-action-item"
                    type="button"
                    @click="setMemberRole(member.user_id, 'moderator')"
                  >
                    <AppIcon class="member-action-icon" name="shield" />
                    <span class="member-action-text">
                      <span class="member-action-label">{{ t('members.promote') }}</span>
                      <span class="member-action-hint">{{ t('members.promoteHint') }}</span>
                    </span>
                  </button>
                  <button
                    v-if="canDemoteFromModerator(member)"
                    class="member-action-item"
                    type="button"
                    @click="setMemberRole(member.user_id, 'member')"
                  >
                    <AppIcon class="member-action-icon" name="user-round" />
                    <span class="member-action-text">
                      <span class="member-action-label">{{ t('members.demote') }}</span>
                      <span class="member-action-hint">{{ t('members.demoteHint') }}</span>
                    </span>
                  </button>
                  <button
                    class="member-action-item member-action-item--danger"
                    type="button"
                    @click="removeMember(member.user_id)"
                  >
                    <AppIcon class="member-action-icon" name="trash-2" />
                    <span class="member-action-text">
                      <span class="member-action-label">{{ t('members.remove') }}</span>
                      <span class="member-action-hint">{{ t('members.removeHint') }}</span>
                    </span>
                  </button>
                </div>
              </div>

              <span v-if="member.user_id !== ownerUserId && normalizeMemberRole(member.role) === 'moderator'" class="member-role-badge role-moderator">{{ t('members.roleModerator') }}</span>
              <span v-if="member.user_id !== ownerUserId && normalizeMemberRole(member.role) !== 'moderator'" class="member-role-badge role-member">{{ t('members.roleMember') }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- Mobile member actions: a bottom sheet teleported out of the scrolling
         tab panel, which would otherwise clip an anchored dropdown. Hidden by
         CSS above the phone breakpoint, where the inline dropdown is used. -->
    <Teleport to="body">
      <Transition name="member-sheet-fade">
        <div
          v-if="activeMenuMember"
          class="member-sheet-overlay"
          @click.self="closeMemberMenu()"
        >
          <div class="member-sheet" role="dialog" aria-modal="true" :aria-label="activeMenuMember.display_name
              ? t('members.sheetLabel', { name: activeMenuMember.display_name })
              : t('members.sheetLabelGeneric')">
            <div class="member-sheet__head">
              <img
                v-if="activeMenuMember.image_url"
                :src="activeMenuMember.image_url"
                alt=""
                class="member-sheet__avatar"
              />
              <span v-else class="member-sheet__avatar member-sheet__avatar--fallback">
                {{ initialOf(activeMenuMember.display_name) }}
              </span>
              <div class="member-sheet__meta">
                <span class="member-sheet__name">{{ memberDisplayName(activeMenuMember) }}</span>
                <span class="member-sheet__role">
                  {{
                    normalizeMemberRole(activeMenuMember.role) === 'moderator'
                      ? t('members.roleModerator')
                      : t('members.roleMember')
                  }}
                </span>
              </div>
            </div>

            <div class="member-sheet__actions">
              <button
                v-if="canPromoteToModerator(activeMenuMember)"
                class="member-sheet__action"
                type="button"
                @click="setMemberRole(activeMenuMember.user_id, 'moderator')"
              >
                <AppIcon class="member-sheet__action-icon" name="shield" />
                <span class="member-sheet__action-text">
                  <span class="member-sheet__action-label">{{ t('members.promote') }}</span>
                  <span class="member-sheet__action-hint">{{ t('members.promoteHint') }}</span>
                </span>
              </button>

              <button
                v-if="canDemoteFromModerator(activeMenuMember)"
                class="member-sheet__action"
                type="button"
                @click="setMemberRole(activeMenuMember.user_id, 'member')"
              >
                <AppIcon class="member-sheet__action-icon" name="user-round" />
                <span class="member-sheet__action-text">
                  <span class="member-sheet__action-label">{{ t('members.demote') }}</span>
                  <span class="member-sheet__action-hint">{{ t('members.demoteHint') }}</span>
                </span>
              </button>

              <button
                class="member-sheet__action member-sheet__action--danger"
                type="button"
                @click="removeMember(activeMenuMember.user_id)"
              >
                <AppIcon class="member-sheet__action-icon" name="trash-2" />
                <span class="member-sheet__action-text">
                  <span class="member-sheet__action-label">{{ t('members.remove') }}</span>
                  <span class="member-sheet__action-hint">{{ t('members.removeHint') }}</span>
                </span>
              </button>
            </div>

            <button class="member-sheet__cancel" type="button" @click="closeMemberMenu()">{{ t('common.cancel') }}</button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.badge-icon-wrap {
  width: 10px;
  height: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.badge-icon-wrap :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* Members tab styling */
.members-list-wrapper {
  border-radius: var(--radius-lg);
  overflow: visible;
  background: var(--bg-surface);
}

.members-custom-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.member-custom-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: var(--border-width-thin) solid var(--bg-hover);
  gap: 1rem;
  position: relative;
  overflow: visible;
}

.member-custom-item--menu-open {
  z-index: 7000;
}

.member-custom-item:last-child {
  border-bottom: none;
}

.member-custom-left {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
}

.member-custom-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  border: var(--border-width-thin) solid var(--bg-hover);
  background: var(--bg-hover);
  flex-shrink: 0;
}

.member-custom-avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
}

.member-custom-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.member-custom-name {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.you-tag {
  font-size: var(--text-xs);
  color: var(--color-primary);
  font-weight: var(--weight-semibold);
  margin-left: 0.2rem;
}

.member-custom-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  position: relative;
  overflow: visible;
}

.member-role-badge {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  /* Match the height of the ellipsis trigger sitting beside it. */
  min-height: 28px;
  padding: 0 0.55rem;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}

.role-owner {
  background: var(--warning-bg);
  color: var(--warning-text);
  border: var(--border-width-thin) solid var(--warning-border);
}


.role-member {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: var(--border-width-thin) solid var(--border-light);
}

.role-moderator {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary-text);
  border: var(--border-width-thin) solid color-mix(in srgb, var(--color-primary) 28%, var(--bg-surface));
}

.member-actions-menu-wrap {
  position: relative;
}

.member-actions-menu-wrap--open {
  z-index: 6000;
}

.member-actions-trigger {
  width: 28px;
  height: 28px;
  border: var(--border-width-thin) solid var(--bg-hover);
  background: var(--bg-surface);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.member-actions-trigger:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.member-actions-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.member-actions-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.member-actions-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.member-actions-menu {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0;
  left: auto;
  z-index: 6100;
  min-width: 248px;
  padding: 0.25rem;
  border: var(--border-width-thin) solid color-mix(in srgb, var(--border-dark) 45%, var(--bg-hover));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-surface-alt) 88%, var(--border-light));
  box-shadow: 0 12px 28px var(--shadow-popover);
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  animation: memberMenuIn 0.16s cubic-bezier(0.2, 0.9, 0.2, 1) forwards;
  transform-origin: top right;
}

.member-action-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.55rem;
  cursor: pointer;
}

.member-action-item:hover {
  background: var(--bg-hover);
}

.member-action-item--danger {
  color: var(--danger-text);
}

.member-action-item--danger:hover {
  background: var(--danger-bg);
}

.member-action-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: currentColor;
}

.member-action-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.member-action-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.member-action-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}

.member-action-hint {
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  margin-top: 0.05rem;
}

/* Mobile member action sheet (hidden on desktop; dropdown is used there) */
.member-sheet-overlay {
  display: none;
}

.member-sheet__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0 0.35rem 0.9rem;
  border-bottom: var(--border-width-thin) solid var(--bg-hover);
}

.member-sheet__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  border: var(--border-width-thin) solid var(--bg-hover);
  background: var(--bg-hover);
  flex-shrink: 0;
}

.member-sheet__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
}

.member-sheet__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.member-sheet__name {
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.member-sheet__role {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.member-sheet__actions {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0;
}

.member-sheet__action {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  width: 100%;
  /* Comfortable touch target; the old 0.45rem dropdown rows were ~28px tall. */
  min-height: 56px;
  padding: 0.75rem 0.35rem;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.member-sheet__action:active {
  background: var(--bg-hover);
}

.member-sheet__action--danger {
  color: var(--danger-text);
}

.member-sheet__action--danger:active {
  background: var(--danger-bg);
}

.member-sheet__action-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: currentColor;
}

.member-sheet__action-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.member-sheet__action-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.member-sheet__action-label {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}

.member-sheet__action-hint {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
  margin-top: 0.1rem;
}

.member-sheet__cancel {
  width: 100%;
  min-height: 52px;
  margin-top: 0.35rem;
  border: var(--border-width-thin) solid var(--bg-hover);
  background: var(--bg-surface-alt);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
}

.member-sheet__cancel:active {
  background: var(--bg-hover);
}

@media (max-width: 520px) {
  /* Swap the anchored dropdown for the bottom sheet. */
  .member-actions-menu {
    display: none;
  }

  .member-role-badge {
    min-height: 32px;
    padding: 0 0.6rem;
    font-size: var(--text-xs);
  }

  .member-actions-trigger {
    width: 32px;
    height: 32px;
    position: relative;
  }

  /* Keep a 44px touch target without drawing a 44px button. */
  .member-actions-trigger::after {
    content: '';
    position: absolute;
    inset: -6px;
  }

  .member-sheet-overlay {
    position: fixed;
    inset: 0;
    z-index: 7500;
    display: flex;
    align-items: flex-end;
    background: var(--overlay-dark);
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
  }

  .member-sheet {
    width: 100%;
    background: var(--bg-surface);
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    box-shadow: var(--elevation-modal);
    padding: 1.15rem 1rem calc(0.75rem + var(--safe-bottom));
    /* This sheet only exists on a phone, so it is always flush with the bottom
       edge and always travels its own full height. */
    --modal-rise: 100%;
    animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
  }

  /* Beats the entrance animation on the base class, which by now has finished.
     In here rather than beside the other fade rules so it shares the scope that
     sets --modal-rise. */
  .member-sheet-fade-leave-active .member-sheet {
    animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
  }
}

.member-sheet-fade-enter-active,
.member-sheet-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.member-sheet-fade-enter-from,
.member-sheet-fade-leave-to {
  opacity: 0;
}

@keyframes memberMenuIn {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
