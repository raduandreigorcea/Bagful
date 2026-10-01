<script setup lang="ts">
import { computed } from 'vue'
import AppModal from './AppModal.vue'
import ModalCloseButton from './ModalCloseButton.vue'
// One icon per row, and each one distinct: their job here is to tell three
// near-identically shaped rows apart at a glance, so a repeat would cost more
// than it buys. They name the destination rather than the dialog it opens --
// a house for the list, a gear for the app -- which is also what keeps
// them apart, since both of those dialogs wear the same gear in their headers.
// The identity card's affordance. It is the only control here that leads
// somewhere without a hint on the right saying what it holds, because what it
// holds is the face and name already printed on it.
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

// Who is signed in, and the ways out of here. Appearance and notifications used
// to live in this dialog; they are settings for the app on this device rather
// than for the person, so they moved to AppSettingsModal and this now offers a
// row leading there.
//
// Nothing about the list is here. This is the place you open to act on
// YOURSELF; the list -- its members, the invite, switching, its settings --
// is the sheet the list name at the top of the list opens.
const props = defineProps({
  open: { type: Boolean, default: false },
  loadingSignOut: { type: Boolean, default: false },
  avatarUrl: { type: String, default: '' },
  // Resolved in a computed rather than defaulted here: this object literal is
  // evaluated once at import, so a t() call in it would freeze in whatever
  // language was current then.
  displayName: { type: String, default: '' },
  email: { type: String, default: '' },
  initial: { type: String, default: '?' },
})

const emit = defineEmits<{
  close: []
  'edit-account': []
  'report-issue': []
  'sign-out': []
  'app-settings': []
}>()

const resolvedDisplayName = computed(() => props.displayName || t('account.fallbackName'))

</script>

<template>
  <AppModal
    :open="open"
    overlay-class="account-overlay"
    transition="modal-fade"
    @close="emit('close')"
  >
      <div class="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
        <div class="account-dialog__header">
          <div class="account-dialog__title-wrap">
            <div class="account-dialog__icon-bg">
              <AppIcon class="account-header-icon" name="user-round" />
            </div>
            <div>
              <h3 id="account-modal-title">{{ t('account.title') }}</h3>
              <p class="account-dialog__subtitle">{{ t('account.subtitle') }}</p>
            </div>
          </div>
          <ModalCloseButton :aria-label="t('account.close')" @click="emit('close')" />
        </div>

        <div class="account-dialog__body">
          <!-- Who you are AND the way to change it, in one control, rather
               than a card with a separate "Profile" row under it repeating the
               name and photo the card already shows. Tapping your own face to edit it
               costs a row less and needs no label to explain it; the chevron
               says it leads somewhere and the accessible name says where. -->
          <button
            class="account-user-card"
            type="button"
            :aria-label="t('account.editProfile')"
            @click="emit('edit-account')"
          >
            <div class="account-user-card__avatar-wrap">
              <img v-if="avatarUrl" :src="avatarUrl" alt="" class="account-user-card__avatar" />
              <span v-else class="account-user-card__avatar account-user-card__avatar--fallback">{{ initial }}</span>
            </div>
            <div class="account-user-card__identity">
              <h4>{{ resolvedDisplayName }}</h4>
              <p>{{ email || t('account.noEmail') }}</p>
            </div>
            <AppIcon class="account-user-card__chevron" name="chevron-right" />
          </button>

          <div class="account-section">

            <button class="account-menu-item" type="button" @click="emit('app-settings')">
              <span class="account-menu-item__label">
                <AppIcon class="account-item-icon" name="settings" />
                <span>{{ t('account.appSettings') }}</span>
              </span>
              <span class="account-menu-item__hint">{{ t('account.appSettingsHint') }}</span>
            </button>

            <div class="account-divider"></div>

            <!-- Sits with sign out rather than with the rows above it: those
                 three lead further into the app, these two are the ways of
                 stepping outside it. -->
            <button
              class="account-menu-item account-report-item"
              type="button"
              @click="emit('report-issue')"
            >
              <span class="account-menu-item__label">
                <AppIcon class="account-item-icon" name="flag" />
                <span>{{ t('account.reportIssue') }}</span>
              </span>
              <span class="account-menu-item__hint">{{ t('account.reportHint') }}</span>
            </button>

            <button
              class="account-menu-item account-menu-item--danger"
              type="button"
              :disabled="loadingSignOut"
              @click="emit('sign-out')"
            >
              <!-- The spinner takes the icon's place rather than the whole
                   label's: signing out is the one action here that can hang on
                   the network, and the row that used to empty to a bare spinner
                   stopped saying which action was in flight. The name carries
                   through instead. -->
              <span class="account-menu-item__label account-menu-item__label--danger">
                <span v-if="loadingSignOut" class="account-spinner" aria-hidden="true"></span>
                <AppIcon v-else class="account-item-icon" name="log-out" />
                <span>{{ loadingSignOut ? t('account.signingOut') : t('account.signOut') }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
  </AppModal>
</template>

<style scoped>
.account-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.account-dialog {
  width: 100%;
  /* Wider than the 360px it opened at. Every row now spends 24px of its width on
     an icon and its gap before the label starts, while the hint still holds the
     right edge — so the two were meeting in the middle on the longest rows
     ("App settings" against "Appearance, notifications, about"). The sheet below
     520px is unaffected; it has been full-width all along. */
  max-width: 420px;
  background: var(--bg-surface);
  border: none;
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.account-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--bg-surface);
}

.account-dialog__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.account-dialog__icon-bg {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.account-header-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.account-header-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.account-dialog__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.account-dialog__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.account-dialog__body {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* A control, so it takes the button reset and answers a press. It keeps the
   borderless alt-surface fill rather than the rows' bordered box below: it is
   the one thing here identifying the person, and looking like the fourth
   variant of a menu row would lose that. Hover and press move the fill instead,
   which is the same answer the rows give with their border. */
.account-user-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  background: var(--bg-surface-alt);
  border: none;
  border-radius: var(--radius-lg);
  padding: 0.8rem 0.9rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-base) ease;
}

.account-user-card:hover {
  background: var(--bg-hover);
}

.account-user-card:active {
  background: var(--bg-press);
}

/* Inset and solid, the way .item-face rings the app's other large tappable
   surface. The --focus-ring-primary tokens are a 12-20% tint meant to sit
   OUTSIDE a small control against --bg-surface; at this size, on the alt
   surface, they read as a smudge rather than a focus state. */
.account-user-card:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-primary);
}

.account-user-card__avatar-wrap {
  position: relative;
}

.account-user-card__avatar {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-pill);
  object-fit: cover;
  border: var(--border-width-base) solid var(--bg-surface);
  box-shadow: var(--elevation-soft);
  flex-shrink: 0;
}

.account-user-card__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
}

/* Takes the slack so the chevron holds the right edge. */
.account-user-card__identity {
  min-width: 0;
  flex: 1;
}

.account-user-card__chevron {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  flex-shrink: 0;
  color: var(--text-disabled);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color var(--transition-base) ease;
}

/* Warms with the card, the way the rows' icons warm with theirs. */
.account-user-card:hover .account-user-card__chevron {
  color: var(--color-primary);
}

.account-user-card__chevron :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  /* Ships at stroke-width 1 for a 24px box; weighted here for this one. */
  stroke-width: 2;
  fill: none;
}

.account-user-card__identity h4 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-user-card__identity p {
  margin: 0.12rem 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}


.account-divider {
  height: 1px;
  background: var(--border-main);
  margin-block: var(--space-2);
}

.account-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.account-menu-item {
  width: 100%;
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  padding: 0.65rem 0.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-base) ease, border-color var(--transition-base) ease;
}

.account-menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--bg-surface));
}

.account-menu-item:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

/* Every row leads with an icon now, so the row/icon layout lives here rather
   than being re-declared per row. min-width:0 is what lets a long list
   name ellipsize inside it. */
.account-menu-item__label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

/* 16px. Every row in this menu leads with a mark on the same gap, so they all
   occupy the same width and the labels share a left edge. */
.account-item-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.account-item-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  /* The assets ship at mixed stroke widths — flag.svg at 1 reads as a hairline
     next to the bold row labels — so the weight is set here for all of them. */
  stroke-width: 2;
  fill: none;
}

/* The icon warms with the row, so the whole row answers a hover as one thing
   rather than the border moving while the mark stays grey. */
.account-menu-item:hover:not(:disabled) .account-item-icon {
  color: var(--color-primary);
}

.account-menu-item__label--danger {
  color: var(--text-inverse);
}

.account-menu-item__hint {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.account-menu-item--danger {
  border: none;
  background: var(--danger-solid);
  color: var(--text-inverse);
  box-shadow: var(--elevation-danger-subtle);
}

.account-menu-item--danger:hover:not(:disabled) {
  background: var(--danger-solid-hover);
  border-color: transparent;
  box-shadow: var(--elevation-danger-hover);
}

.account-menu-item--danger:disabled {
  opacity: 0.5;
}

/* The mark rides on the solid fill here, so it takes the label's inverse colour
   instead of the muted grey the pale rows use — and it must not warm to green
   on hover the way they do, which is why the hover state is restated. */
.account-menu-item--danger .account-item-icon,
.account-menu-item--danger:hover:not(:disabled) .account-item-icon {
  color: var(--text-inverse);
}












.account-spinner {
  /* Same box as .account-item-icon, which it stands in for: at 14px the label
     shifted two pixels left the moment sign-out started. */
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: var(--border-width-thick) solid color-mix(in srgb, var(--text-inverse) 45%, transparent);
  border-top-color: var(--text-inverse);
  border-radius: 50%;
  display: inline-block;
  animation: account-spin 0.7s linear infinite;
}

@keyframes account-spin {
  to {
    transform: rotate(360deg);
  }
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .account-dialog {
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.modal-fade-leave-active .account-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}

@media (max-width: 520px) {
  .account-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .account-dialog {
    max-width: none;
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom));
    /* Flush with the bottom edge, so it can travel its full height and start
       off screen rather than merely nudging up. */
    --modal-rise: 100%;
  }
}
</style>
