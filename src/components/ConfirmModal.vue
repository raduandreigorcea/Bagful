<script setup lang="ts">
import { computed, useId, type PropType } from 'vue'
import AppButton from './AppButton.vue'
import AppModal from './AppModal.vue'
import AppIcon from './AppIcon.vue'
import { t } from '../lib/i18n'

// One mark per tone, all three from the icon set rather than drawn inline, and
// none with a ring of its own: the wrap behind each is already a 52px disc.
const TONE_ICONS: Record<string, string> = {
  danger: 'triangle-alert',
  success: 'check',
  warning: 'info',
}

// Per-instance, because this component is mounted several times over on one
// screen (HomeView alone has an ErrorModal and a limit-reached ConfirmModal).
// A hardcoded id put the same value on every copy, so aria-labelledby resolved
// to whichever happened to be first in the DOM rather than to this dialog's own
// title.
const titleId = useId()

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  tone: { type: String as PropType<'danger' | 'warning' | 'success' | ''>, default: '' },
  // Empty rather than the English word, for the reason ErrorModal spells out:
  // a t() call in a prop default runs once at import and never changes again.
  confirmText: { type: String, default: '' },
  cancelText: { type: String, default: '' },
  showCancel: { type: Boolean, default: true },
})

const resolvedConfirmText = computed(() => props.confirmText || t('common.confirm'))
const resolvedCancelText = computed(() => props.cancelText || t('common.cancel'))

const resolvedTone = computed(() => {
  if (props.tone) return props.tone
  return props.danger ? 'danger' : 'warning'
})

// Falls back to the warning mark, which is also what resolvedTone falls back to,
// so a tone without an icon of its own still draws something.
const toneIcon = computed(() => TONE_ICONS[resolvedTone.value] ?? TONE_ICONS.warning)

const confirmVariant = computed(() => {
  if (resolvedTone.value === 'danger') return 'danger'
  if (resolvedTone.value === 'warning') return 'warning'
  return 'primary'
})

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <AppModal
    :open="open"
    overlay-class="confirm-overlay"
    transition="confirm-fade"
    @close="emit('cancel')"
  >
      <div class="confirm-dialog" :class="`confirm-dialog--${resolvedTone}`" role="alertdialog" aria-modal="true" :aria-labelledby="titleId">
        <div class="confirm-dialog__icon-wrap" :class="`confirm-dialog__icon-wrap--${resolvedTone}`">
          <AppIcon class="confirm-dialog__icon" :name="toneIcon" />
        </div>

        <div class="confirm-dialog__body">
          <h4 :id="titleId" class="confirm-dialog__title">{{ title }}</h4>
          <p class="confirm-dialog__message">{{ message }}</p>
        </div>

        <div class="confirm-dialog__actions" :class="{ 'confirm-dialog__actions--single': !showCancel }">
          <AppButton v-if="showCancel" variant="secondary" block @click="emit('cancel')">{{ resolvedCancelText }}</AppButton>
          <AppButton :variant="confirmVariant" :block="showCancel" @click="emit('confirm')">{{ resolvedConfirmText }}</AppButton>
        </div>
      </div>
  </AppModal>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark-strong);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.confirm-dialog {
  width: 100%;
  max-width: 400px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  border: var(--border-width-thin) solid var(--border-main);
  box-shadow: var(--elevation-dialog);
  padding: var(--space-7) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.confirm-dialog--danger {
  border-color: color-mix(in srgb, var(--danger-main) 40%, var(--border-main));
}

.confirm-dialog--warning {
  border-color: color-mix(in srgb, var(--warning-border) 60%, var(--border-main));
}

.confirm-dialog--success {
  border-color: color-mix(in srgb, var(--color-primary) 42%, var(--border-main));
}

.confirm-dialog__icon-wrap {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.confirm-dialog__icon-wrap--danger {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.confirm-dialog__icon-wrap--warning {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.confirm-dialog__icon-wrap--success {
  background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-surface));
  color: var(--color-primary);
}

.confirm-dialog__icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
}

/* The assets ship at stroke-width 1 for a 24px box; weight it for this size. */
.confirm-dialog__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
}

.confirm-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.confirm-dialog__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.confirm-dialog__message {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.confirm-dialog__actions {
  display: flex;
  gap: 0.65rem;
  width: 100%;
  margin-top: 0.25rem;
}

.confirm-dialog__actions--single .app-btn {
  flex: 0 0 auto;
  min-width: 120px;
  margin: 0 auto;
}

/* Transitions */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}

/* Beats the entrance animation on the base class, which by now has finished. */
.confirm-fade-leave-active .confirm-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}
</style>
