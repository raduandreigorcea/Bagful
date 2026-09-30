<script setup lang="ts">
// "There's a new Bagful" — the Android app's only way of saying so.
//
// Shaped like NotificationPromptModal on purpose: same icon-over-title-over-
// buttons dialog, because it arrives in the same place (just after the list
// loads) and the two should not look like they came from different apps.
//
// The phases share one dialog rather than becoming four, because they are one
// continuous thing happening: the icon and title stay put and only the sentence
// and the buttons change underneath them, so nothing jumps.
import { computed, type PropType } from 'vue'
import AppButton from './AppButton.vue'
import AppModal from './AppModal.vue'
import type { UpdatePhase } from '../lib/updatePrompt'
import { t, tAccent } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  phase: { type: String as PropType<UpdatePhase>, default: 'available' },
  version: { type: String, default: '' },
  currentVersion: { type: String, default: '' },
  // 0–1, or -1 when the download's total size is unknown.
  progress: { type: Number, default: -1 },
})

const emit = defineEmits<{
  install: []
  later: []
  'open-settings': []
  'open-releases': []
  close: []
}>()

// Nothing to cancel into once the APK is on its way, and a stray backdrop tap
// during a 30 MB download should not look like it stopped anything.
const dismissable = computed(() => props.phase === 'available' || props.phase === 'error')

const percent = computed(() => Math.round(Math.min(Math.max(props.progress, 0), 1) * 100))

// The Android setting's own name is bolded inside the sentence, so the
// string marks it with brackets and tAccent hands back the three
// pieces to render.
const permissionMessage = computed(() => tAccent('update.permissionMessage'))
</script>

<template>
  <!-- Back and Escape mean Later. On Android, Back IS the dialog's "no" button,
       and someone pressing it wants the offer gone, not merely hidden until the
       next time the list loads — so it declines the version exactly as the
       button does. That is not as final as it sounds: a version is bumped on
       every commit, so "not this one" is answered by the next build rather than
       by silence.

       The backdrop is the one route that does NOT decide, which is why it is
       switched off rather than pointed at 'later'. A tap that lands beside the
       dialog is as likely to be a missed press as an answer, and it is the one
       dismissal with no intent behind it worth reading. -->
  <AppModal
    :open="open"
    overlay-class="update-overlay"
    transition="update-fade"
    :close-on-backdrop="false"
    @close="dismissable && emit('later')"
  >
    <div
      class="update-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-prompt-title"
    >
      <div class="update-dialog__icon-wrap">
        <AppIcon class="update-dialog__icon" name="download" />
      </div>

      <div class="update-dialog__body">
        <h4 id="update-prompt-title" class="update-dialog__title">
          {{ phase === 'permission' ? t('update.permissionTitle') : t('update.availableTitle') }}
        </h4>

        <p v-if="phase === 'available'" class="update-dialog__message">
          {{ t('update.readyToInstall', { version }) }}
          <template v-if="currentVersion"> {{ t('update.currentVersion', { version: currentVersion }) }}</template>
        </p>

        <p v-else-if="phase === 'permission'" class="update-dialog__message">
          <!-- The setting's own name is bolded mid-sentence, so the string
               carries a [marker] round it and tAccent places the pieces —
               which words sit either side differs per language. -->
          {{ permissionMessage[0] }}<strong>{{ permissionMessage[1] }}</strong>{{ permissionMessage[2] }}
        </p>

        <p v-else-if="phase === 'downloading'" class="update-dialog__message">
          {{ t('update.downloadingMessage', { version }) }}
        </p>

        <p v-else-if="phase === 'installing'" class="update-dialog__message">
          {{ t('update.installingMessage') }}
        </p>

        <p v-else class="update-dialog__message">
          {{ t('update.failedMessage') }}
        </p>
      </div>

      <div v-if="phase === 'downloading'" class="update-dialog__progress">
        <div
          class="update-dialog__track"
          role="progressbar"
          :aria-label="t('update.progressLabel')"
          :aria-valuenow="progress >= 0 ? percent : undefined"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <!-- No Content-Length means no honest percentage, so the bar sweeps
               instead of claiming a number it does not have. -->
          <div
            class="update-dialog__fill"
            :class="{ 'update-dialog__fill--unknown': progress < 0 }"
            :style="progress >= 0 ? { width: `${percent}%` } : undefined"
          ></div>
        </div>
        <span v-if="progress >= 0" class="update-dialog__percent">{{ percent }}%</span>
      </div>

      <div class="update-dialog__actions">
        <template v-if="phase === 'available'">
          <AppButton variant="secondary" block @click="emit('later')">{{ t('update.later') }}</AppButton>
          <AppButton variant="primary" block @click="emit('install')">{{ t('update.install') }}</AppButton>
        </template>

        <template v-else-if="phase === 'permission'">
          <AppButton variant="secondary" block @click="emit('later')">{{ t('update.notNow') }}</AppButton>
          <AppButton variant="primary" block @click="emit('open-settings')">
            {{ t('update.openSettings') }}
          </AppButton>
        </template>

        <template v-else-if="phase === 'downloading'">
          <AppButton variant="secondary" block disabled>{{ t('update.downloading') }}</AppButton>
        </template>

        <!-- Try again is the safety net. Normally this phase is not reachable
             for long enough to read: a finished install replaces the app, and
             backing out of the installer puts the offer straight back (see
             lib/updatePrompt). It is where you end up only if that resume
             listener never registered — so the one case where this text is
             actually read is the one where Close alone would strand you. -->
        <template v-else-if="phase === 'installing'">
          <AppButton variant="secondary" block @click="emit('close')">{{ t('common.close') }}</AppButton>
          <AppButton variant="primary" block @click="emit('install')">{{ t('common.tryAgain') }}</AppButton>
        </template>

        <template v-else>
          <AppButton variant="secondary" block @click="emit('open-releases')">
            {{ t('update.openReleases') }}
          </AppButton>
          <AppButton variant="primary" block @click="emit('install')">{{ t('common.tryAgain') }}</AppButton>
        </template>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark-strong);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4)
    calc(var(--space-4) + var(--safe-bottom));
}

.update-dialog {
  width: 100%;
  max-width: 400px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  border: var(--border-width-thin) solid
    color-mix(in srgb, var(--color-primary) 42%, var(--border-main));
  box-shadow: var(--elevation-dialog);
  padding: var(--space-7) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.update-dialog__icon-wrap {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary) 14%, var(--bg-surface));
  color: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.update-dialog__icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
}

/* The asset ships at stroke-width 1 for a 24px box; weight it for this size. */
.update-dialog__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
}

.update-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.update-dialog__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.update-dialog__message {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.update-dialog__progress {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}

.update-dialog__track {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
  overflow: hidden;
}

.update-dialog__fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--color-primary);
  transition: width var(--transition-base) ease;
}

.update-dialog__fill--unknown {
  width: 40%;
  animation: update-sweep 1.1s ease-in-out infinite;
}

@keyframes update-sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

.update-dialog__percent {
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.update-dialog__actions {
  display: flex;
  gap: 0.65rem;
  width: 100%;
  margin-top: 0.25rem;
}

.update-fade-enter-active,
.update-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.update-fade-enter-from,
.update-fade-leave-to {
  opacity: 0;
}

/* Beats the entrance animation on the base class, which by now has finished. */
.update-fade-leave-active .update-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}
</style>
