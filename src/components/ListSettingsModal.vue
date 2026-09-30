<script setup lang="ts">
import { computed, nextTick, ref, watch, type PropType } from 'vue'
import { useAuth } from '@clerk/vue'
import AppModal from './AppModal.vue'
import ConfirmModal from './ConfirmModal.vue'
import ErrorModal from './ErrorModal.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import OverviewPanel from './listSettings/OverviewPanel.vue'
import PreferencesPanel from './listSettings/PreferencesPanel.vue'
import MembersPanel from './listSettings/MembersPanel.vue'
import DangerPanel from './listSettings/DangerPanel.vue'
import type { ListMemberProfile } from '../lib/listRealtime'
import { normalizeMemberRole } from '../lib/memberRoles'
import { ITEM_LIMIT_DEFAULT } from '../lib/limits'
import { useConfirm } from '../lib/useConfirm'

// The settings dialog's shell: which tab is showing, what the viewer is allowed
// to do, and the two dialogs the panels share (confirm and error).
//
// Each tab is its own component under listSettings/. They were all inline
// here once, which made this file 2,658 lines and meant every change to the
// members list was a change to the same file as the emoji picker.

// Raw SVG imports for the sidebar and header.
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  inviteCode: { type: String, default: '' },
  listItemLimit: { type: Number, default: ITEM_LIMIT_DEFAULT },
  listEmoji: { type: String, default: '' },
  ownerUserId: { type: String, default: '' },
  memberProfiles: {
    type: Array as PropType<ListMemberProfile[]>,
    default: () => [],
  },
})

const emit = defineEmits<{
  close: []
  'refresh-list': []
  'list-deleted': []
  'list-left': []
}>()

const { userId } = useAuth()

const activeTab = ref('overview')
// Which member row has its actions open, owned here because dismiss() below has
// to know: with the menu up, Escape and a backdrop click belong to it.
const openMemberMenuId = ref('')

// The awaitable confirm dialog, handed to the panels that destroy things so
// there is one dialog rather than one per panel.
const { state: confirmModal, confirm, resolveWith } = useConfirm()

// Whatever the last action failed with. Panels emit `error` rather than opening
// their own dialog, so every failure in here arrives on one surface.
const actionError = ref('')
const actionErrorTitle = ref('')

function showError(message: string, title = '') {
  // Empty means "no title of its own"; ErrorModal fills in the generic one,
  // per render, in the current language. A t() call in the default would run
  // once at import and freeze.
  actionErrorTitle.value = title
  actionError.value = message
}

// Re-sync the tab every time the modal opens; the panels re-seed their own
// editable fields from their props.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    activeTab.value = 'overview'
    closeMemberMenu()
  },
  { immediate: true },
)

function closeMemberMenu() {
  openMemberMenuId.value = ''
}

function requestClose() {
  closeMemberMenu()
  emit('close')
}

// Escape and a backdrop click both arrive here from AppModal. With the member
// menu open they belong to the menu, not the dialog underneath it: dismissing
// both at once would take the whole settings modal away from someone who only
// meant to back out of a sub-menu.
function dismiss() {
  if (openMemberMenuId.value) {
    closeMemberMenu()
    return
  }
  requestClose()
}

const memberCount = computed(() => props.memberProfiles.length)
const isOwner = computed(() => !!props.ownerUserId && props.ownerUserId === userId.value)

const currentUserRole = computed(() => {
  const membership = props.memberProfiles.find((m) => m.user_id === userId.value)
  return normalizeMemberRole(membership?.role)
})

const isOwnerOrModerator = computed(() => isOwner.value || currentUserRole.value === 'moderator')

const ownerProfile = computed(
  () => props.memberProfiles.find((m) => m.user_id === props.ownerUserId) ?? null,
)

interface SettingsTab {
  id: string
  label: string
  icon: string
  badge?: number
  danger?: boolean
}

// The tabs this viewer can reach, in sidebar order. Built as data so the
// tablist below is one v-for rather than five near-identical buttons carrying
// their own v-ifs — which is how the Danger tab came to be written out twice.
// The tablist pattern: only the active tab is in the Tab order (tabindex -1 on
// the rest), so the arrow keys have to be how the others are reached. Without
// this handler a keyboard could never leave the first tab.
function onTabKeydown(event: KeyboardEvent) {
  const list = tabs.value
  const index = list.findIndex((tab) => tab.id === activeTab.value)
  let next = -1
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % list.length
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = list.length - 1
  if (next < 0) return
  event.preventDefault()
  const id = list[next]!.id
  activeTab.value = id
  void nextTick(() => document.getElementById(`settings-tab-${id}`)?.focus())
}

const tabs = computed<SettingsTab[]>(() => {
  const list: SettingsTab[] = [
    { id: 'overview', label: t('list.tab.overview'), icon: 'layout-grid' },
  ]
  if (isOwnerOrModerator.value) {
    list.push({ id: 'list', label: t('list.tab.preferences'), icon: 'settings' })
  }
  list.push({
    id: 'members',
    label: t('list.tab.members'),
    icon: 'users-round',
    badge: memberCount.value,
  })
  list.push({ id: 'danger', label: t('list.tab.danger'), icon: 'trash-2', danger: true })
  // No About tab: an app's version and its data-licence credit are not a
  // property of any one list. They live in AppSettingsModal, reached from
  // the account dialog. Every tab here now changes something about THIS
  // list, which is what the dialog claims to be.
  return list
})

// A tab can disappear from under the viewer — losing moderator while the
// Preferences tab is open — which would otherwise leave the content area blank
// with no tab marked current.
watch(tabs, (list) => {
  if (!list.some((tab) => tab.id === activeTab.value)) activeTab.value = 'overview'
})

// Leaving and deleting both take the user off this list, so the dialog goes
// with it; HomeView decides where they land.
function onListLeft() {
  emit('close')
  emit('list-left')
}

function onListDeleted() {
  emit('close')
  emit('list-deleted')
}
</script>

<template>
  <AppModal
    :open="open"
    overlay-class="settings-modal-overlay"
    transition="modal-fade"
    @close="dismiss"
  >
      <div class="settings-modal" role="dialog" aria-modal="true" :aria-label="t('list.title')">

        <!-- Modal Header -->
        <div class="settings-modal__header">
          <div class="settings-modal__title-wrap">
            <div class="settings-modal__icon-bg">
              <AppIcon class="header-icon" name="settings" />
            </div>
            <div>
              <h3>{{ t('list.title') }}</h3>
              <!-- Which list this is, rather than a description of the
                   panels below: that is the one question the dialog has to
                   answer. Renaming, removing members and deleting all happen in here,
                   and someone in more than one list needs something on screen
                   confirming they are in the right one. -->
              <p class="settings-modal__subtitle">{{ listName || t('account.listFallback') }}</p>
            </div>
          </div>
          <ModalCloseButton :aria-label="t('list.close')" @click="requestClose()" />
        </div>

        <!-- Modal Body Container -->
        <div class="settings-modal__body">

          <!-- Sidebar Navigation. Real tab semantics: these were plain buttons
               carrying an `active` class, so a screen reader got five unlabelled
               controls and no indication which view was showing. -->
          <nav
            class="settings-sidebar"
            role="tablist"
            aria-orientation="vertical"
            :aria-label="t('list.sections')"
          >
            <button
              v-for="tab in tabs"
              :id="`settings-tab-${tab.id}`"
              :key="tab.id"
              class="sidebar-tab-btn"
              :class="{
                active: activeTab === tab.id,
                'sidebar-tab-btn--danger': tab.danger,
              }"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              :aria-controls="`settings-panel-${tab.id}`"
              :tabindex="activeTab === tab.id ? 0 : -1"
              @click="activeTab = tab.id"
              @keydown="onTabKeydown"
            >
              <AppIcon class="tab-icon" :name="tab.icon" />
              <span>{{ tab.label }}</span>
              <span v-if="tab.badge !== undefined" class="tab-badge">{{ tab.badge }}</span>
            </button>
          </nav>

          <!-- Content Panel Area -->
          <main class="settings-content-wrapper">

            <!-- Always in the layout, even when another tab is active: it is the
                 tallest panel, so it fixes the modal's height and the other tabs
                 overlay it. Ghosted copies are inert and out of the a11y tree. -->
            <OverviewPanel
              id="settings-panel-overview"
              role="tabpanel"
              aria-labelledby="settings-tab-overview"
              :ghost="activeTab !== 'overview'"
              :list-name="listName"
              :invite-code="inviteCode"
              :member-count="memberCount"
              :owner-profile="ownerProfile"
            />

            <PreferencesPanel
              v-if="activeTab === 'list' && isOwnerOrModerator"
              id="settings-panel-list"
              role="tabpanel"
              aria-labelledby="settings-tab-list"
              :list-id="listId"
              :list-name="listName"
              :list-item-limit="listItemLimit"
              :list-emoji="listEmoji"
              :is-owner="isOwner"
              @refresh-list="emit('refresh-list')"
              @error="showError"
            />

            <MembersPanel
              v-if="activeTab === 'members'"
              id="settings-panel-members"
              role="tabpanel"
              aria-labelledby="settings-tab-members"
              v-model:open-menu-id="openMemberMenuId"
              :list-id="listId"
              :owner-user-id="ownerUserId"
              :is-owner="isOwner"
              :is-owner-or-moderator="isOwnerOrModerator"
              :member-profiles="memberProfiles"
              :confirm="confirm"
              @refresh-list="emit('refresh-list')"
              @error="showError"
            />

            <DangerPanel
              v-if="activeTab === 'danger'"
              id="settings-panel-danger"
              role="tabpanel"
              aria-labelledby="settings-tab-danger"
              :list-id="listId"
              :list-name="listName"
              :is-owner="isOwner"
              :is-owner-or-moderator="isOwnerOrModerator"
              :confirm="confirm"
              @refresh-list="emit('refresh-list')"
              @list-left="onListLeft"
              @list-deleted="onListDeleted"
              @error="showError"
            />
          </main>
        </div>
      </div>
  </AppModal>

  <!-- Shared by every destructive action in the panels. -->
  <ConfirmModal
    :open="confirmModal.open"
    :title="confirmModal.title"
    :message="confirmModal.message"
    :danger="confirmModal.danger"
    :confirm-text="confirmModal.confirmText"
    :cancel-text="confirmModal.cancelText"
    :show-cancel="confirmModal.showCancel"
    @confirm="resolveWith(true)"
    @cancel="resolveWith(false)"
  />

  <!-- Whatever the last write failed with. Stacks above the settings dialog
       rather than replacing it, so dismissing it leaves the panel exactly where
       it was and the action can simply be retried. -->
  <ErrorModal
    :title="actionErrorTitle"
    :message="actionError"
    @dismiss="actionError = ''"
  />
</template>

<style scoped>
.settings-modal-overlay {
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

.settings-modal {
  width: 100%;
  max-width: 640px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  border: none;
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: min(85vh, 600px);
}

.settings-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-5) var(--space-6);
  background: var(--bg-surface);
}

.settings-modal__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  /* The subtitle carries a list name now, up to 25 characters of someone
     else's choosing. Let the text block shrink so it ellipsizes instead of
     shouldering the close button off the header. */
  min-width: 0;
}

.settings-modal__title-wrap > div:last-child {
  min-width: 0;
}

.settings-modal__icon-bg {
  flex-shrink: 0;
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
}

.settings-modal__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.settings-modal__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


/* Modal Body split screen */
.settings-modal__body {
  display: grid;
  grid-template-columns: 180px 1fr;
  background: var(--bg-surface);
  height: 480px;
  overflow: hidden;
}

@media (max-width: 580px) {
  .settings-modal__body {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    height: 520px;
  }
}

/* Sidebar Nav */
.settings-sidebar {
  padding: 1.25rem 0.75rem;
  background: var(--bg-surface-alt);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

@media (max-width: 580px) {
  .settings-sidebar {
    flex-direction: row;
    padding: 0.75rem;
    overflow-x: auto;
    gap: 0.5rem;
    scrollbar-width: none; /* Hide scrollbar for clean tab-bar look */
  }
  .settings-sidebar::-webkit-scrollbar {
    display: none;
  }
}

.sidebar-tab-btn {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-slow) cubic-bezier(0.4, 0, 0.2, 1), color var(--transition-slow) cubic-bezier(0.4, 0, 0.2, 1);
  width: 100%;
}

.sidebar-tab-btn:hover:not(.active) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

@media (max-width: 580px) {
  .sidebar-tab-btn {
    width: auto;
    white-space: nowrap;
    padding: 0.5rem 0.85rem;
  }
  .sidebar-tab-btn:hover {
    transform: none;
  }
}

.sidebar-tab-btn.active {
  background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-surface));
  color: var(--color-primary);
}

.sidebar-tab-btn--danger:hover:not(.active) {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.sidebar-tab-btn--danger.active {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.tab-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tab-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 1.75;
  fill: none;
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

.tab-badge {
  margin-left: auto;
  font-size: var(--text-2xs);
  background: var(--border-light);
  color: var(--text-secondary);
  padding: 0.15rem 0.4rem;
  border-radius: var(--radius-pill);
  font-weight: var(--weight-bold);
}

.sidebar-tab-btn.active .tab-badge {
  background: var(--color-primary);
  color: var(--text-inverse);
}

/* Content Area */
.settings-content-wrapper {
  position: relative;
  overflow-y: auto;
  background: var(--bg-surface);
}

/* Panels */
.tab-panel {
  animation: panelFadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-height: 100%;
  padding: var(--space-6);
}

/* The Overview panel stays in flow at all times to hold the modal's height
   open; when another tab is active it is hidden but still occupies its box. */
.tab-panel--ghost {
  visibility: hidden;
}

/* Every other tab is painted over the Overview panel's box and scrolls
   independently if its content runs longer. */
.tab-panel--overlay {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  background: var(--bg-surface);
}

@keyframes btnSpin {
  to {
    transform: rotate(360deg);
  }
}

/* Animations & Transitions */
/* Opacity only: a vertical translate would push these min-height:100% panels
   past the bottom of their overflow-y:auto scroll container for the length of
   the animation, flashing a scrollbar on open and on every tab switch. */
@keyframes panelFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes tickPop {
  0% {
    transform: scale(0.85);
    opacity: 0.5;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* Modal Transitions */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .settings-modal {
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

/* While the modal moves, subpixel rounding on the shifted content can tip these
   scroll containers a fraction past their box and flash a scrollbar. Clip them
   for the length of the entrance; scrolling resumes right after. */
.modal-fade-enter-active .settings-content-wrapper,
.modal-fade-enter-active .tab-panel--overlay {
  overflow: hidden;
}

.modal-fade-leave-active .settings-modal {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}

@media (max-width: 520px) {
  .settings-modal-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .settings-modal {
    max-width: none;
    /* Height comes from the always-present Overview panel, floored by
       .settings-content-wrapper below, so it is the same on every tab. The cap
       only bites on very short viewports. */
    height: auto;
    max-height: min(88dvh, calc(760px + var(--safe-bottom)));
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    /* Bottom sheet: the surface runs behind the phone's nav bar while the
       content stays above it (the overlay's safe padding is zeroed here). */
    padding-bottom: var(--safe-bottom);
    /* Flush with the bottom edge, so it can travel its full height and start
       off screen rather than merely nudging up. */
    --modal-rise: 100%;
  }

  .settings-modal__header {
    padding: 1rem;
  }

  .settings-modal__body {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    height: auto;
    min-height: 0;
  }

  /* The sheet is the one place the modal's height is content-driven (desktop
     pins .settings-modal__body to a fixed height), so whatever Overview happens
     to contain used to decide how much room Members and Danger got. Give the
     panel area a floor of its own and that stops being an accident.

     Viewport-relative on purpose: the sheet is capped at 88dvh, and 55dvh plus
     the header and tab strip stays under that cap on any real phone, so the
     floor can never fight the cap and push content past the modal's clip. */
  .settings-content-wrapper {
    min-height: 55dvh;
  }

  .settings-sidebar {
    flex-direction: row;
    padding: 0.75rem;
    border-right: none;
    border-bottom: var(--border-width-thin) solid var(--bg-hover);
    overflow-x: auto;
    gap: 0.5rem;
    scrollbar-width: none;
  }

  .settings-sidebar::-webkit-scrollbar {
    display: none;
  }

  .sidebar-tab-btn {
    width: auto;
    white-space: nowrap;
    padding: 0.5rem 0.85rem;
  }

  .sidebar-tab-btn:hover {
    transform: none;
  }
}

/* ─── Shared panel primitives ────────────────────────────────────────────
   Rendered by the panel components under listSettings/, styled here so
   there is one copy rather than five. :deep() is what lets this scoped block
   reach past the child component boundary. */

:deep(.success-icon-wrap) {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:deep(.success-icon-wrap svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 3;
  fill: none;
}
:deep(.panel-section) {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
:deep(.panel-section-title) {
  margin: 0;
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  font-weight: var(--weight-bold);
}
:deep(.panel-section-title.text-danger) {
  color: var(--danger-text);
}
:deep(.panel-section-desc) {
  margin: 0 0 0.25rem;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.4;
}

/* Form Settings (Preferences) */
:deep(.card-item) {
  border: var(--border-width-thin) solid var(--bg-hover);
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  transition: all var(--transition-base) ease;
}
:deep(.card-item:focus-within) {
  border-color: color-mix(in srgb, var(--color-primary) 30%, var(--border-light));
  box-shadow: var(--elevation-soft);
}
:deep(.card-item__form) {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

/* Loaders and success checks */
:deep(.btn-spinner) {
  width: 14px;
  height: 14px;
  border: var(--border-width-thick) solid transparent;
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: btnSpin 0.6s linear infinite;
}
:deep(.btn-spinner--accent) {
  border-top-color: var(--color-primary);
}
:deep(.btn-spinner--light) {
  border-top-color: var(--text-inverse);
}
:deep(.success-state) {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--color-primary-text);
  font-weight: var(--weight-bold);
}
:deep(.animate-pop) {
  animation: tickPop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
</style>
