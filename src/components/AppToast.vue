<script setup lang="ts">
import { pauseToast, resumeToast, triggerToastAction, useToast } from '../lib/useToast'

// Renders the toast stack lib/useToast holds. Mounted once, in App.vue.
//
// Newest at the bottom, nearest the thumb and the thing that caused it; older
// ones ride up above it until they time out.
//
// The live region is always in the DOM and only its contents change: a region
// inserted together with its text is often not announced at all, which is the
// whole job of a toast for someone who cannot see it.
//
// Paused by the pointer MOVING over it, not entering it: a toast that slides in
// under a mouse left resting there fires pointerenter too, which would pause it
// for as long as the mouse stayed put, holding back the delete its Undo is
// guarding. pauseToast is idempotent, so the stream
// of moves costs nothing after the first.
const { toasts } = useToast()
</script>

<template>
  <div
    class="toast-region"
    role="status"
    aria-live="polite"
    @pointermove="pauseToast"
    @pointerleave="resumeToast"
    @focusin="pauseToast"
    @focusout="resumeToast"
  >
    <TransitionGroup name="toast">
      <div v-for="toast in toasts" :key="toast.id" class="toast">
        <span class="toast__message">{{ toast.message }}</span>
        <button
          v-if="toast.actionLabel"
          type="button"
          class="toast__action"
          @click="triggerToastAction(toast.id)"
        >
          {{ toast.actionLabel }}
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* Above the bottom action bar on the list screen, which is where toasts come
   from; --bottom-clearance is the bar's height, disc included. */
.toast-region {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--safe-bottom) + var(--bottom-clearance) + var(--space-3));
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: 440px;
  min-height: 48px;
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--toast-bg);
  color: var(--toast-text);
  box-shadow: var(--elevation-modal);
}

.toast__message {
  flex: 1;
  min-width: 0;
  padding: var(--space-2) 0;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-snug);
}

.toast__action {
  flex-shrink: 0;
  min-height: 40px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-lg);
  background: none;
  color: var(--toast-action);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
}

.toast__action:hover {
  background: color-mix(in srgb, var(--toast-text) 10%, transparent);
}

.toast__action:active {
  background: color-mix(in srgb, var(--toast-text) 18%, transparent);
}

/* The ones already up slide aside for a newcomer instead of jumping. */
.toast-move {
  transition: transform var(--transition-slow) var(--ease-rise);
}

.toast-enter-active {
  transition:
    transform var(--transition-slow) var(--ease-rise),
    opacity var(--transition-slow) var(--ease-rise);
}

.toast-leave-active {
  position: absolute;
  transition:
    transform var(--transition-base) var(--ease-fall),
    opacity var(--transition-base) var(--ease-fall);
}

.toast-enter-from,
.toast-leave-to {
  transform: translateY(12px);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .toast-move {
    transition: none;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
