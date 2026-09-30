<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppModal from './AppModal.vue'
import AppButton from './AppButton.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import ErrorModal from './ErrorModal.vue'
import {
  REPORT_MAX_LENGTH,
  REPORT_SURFACES,
  collectDiagnostics,
  describeDiagnostics,
  isReportSendable,
  submitReport,
  type ReportKind,
} from '../lib/issueReport'
import { isCurrentlyOffline } from '../lib/connectivity'
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

// The form for "Report an issue".
//
// It is a dialog rather than a route on purpose. Reporting is an interruption,
// not a destination: a route would push a history entry, which on the Android
// build means the hardware back button can land someone back inside a form they
// already sent, and it would be the only secondary surface in the app that is
// not an AppModal.
//
// The shape of the form is the argument. A single large textarea is the obvious
// build and the wrong one: it asks for everything and therefore gets "it
// doesn't work", while the facts that would make the report actionable —
// version, platform, connection, stuck offline edits — are ones the app can
// read for itself. So the questions here are only the two nobody else can
// answer, where and what, and lib/issueReport assembles the rest.

const props = defineProps({
  open: { type: Boolean, default: false },
  listId: { type: String, default: '' },
  userId: { type: String, default: '' },
})

const emit = defineEmits<{ close: [] }>()

const kind = ref<ReportKind>('bug')
const surface = ref('')
const message = ref('')
const sending = ref(false)
const sent = ref(false)
// What to say about a send that went nowhere, empty when there is nothing to
// say. A string rather than a flag because ErrorModal opens on a non-empty
// message, which is the same contract every other failure in the app uses.
//
// Never set pre-emptively: a note about being offline on a form someone has not
// filled in yet is an obstacle, not a warning.
const failure = ref('')

// The two ways a send fails, told apart at the moment it happens rather than
// assumed. Offline is the obvious one. The other is a send that fails on a
// perfectly good connection: the request to Sentry's ingest host is on every ad
// blocker's list, so a browser drops it on sight, and telling that person to try
// again once they are back online points them at the one thing that is fine.


const diagnostics = computed(() =>
  collectDiagnostics({ listId: props.listId, userId: props.userId }),
)
const attachedLines = computed(() => describeDiagnostics(diagnostics.value))

const isBug = computed(() => kind.value === 'bug')

const canSend = computed(() =>
  isReportSendable({ kind: kind.value, surface: surface.value, message: message.value }),
)

// Both kinds are asked where, in the same words. A section that mounts and
// unmounts would resize the whole dialog under the finger on every switch, and
// reserving the space would leave a blank gap, so it stays put: "Where in the
// app?" is true of a bug and of an idea, and only the optional badge needs to
// differ. The place is worth
// having either way: "the scanner is confusing" is as easy to act on as "the
// scanner is broken".
const whereLabel = computed(() => t('report.whereLabel'))

const prompt = computed(() => (isBug.value ? t('report.promptBug') : t('report.promptIdea')))

// A worked example rather than an instruction. It shows the level of detail
// that makes a report usable, in the app's own vocabulary, which is something
// "Describe your issue…" has never once done.
//
// Neither example asks for a feature that does not exist. A placeholder is read
// as a suggestion of what belongs here, and seeding it with an unbuilt feature
// invites reports about things that were never promised — so both point at
// something already in the app instead.
const placeholder = computed(() =>
  isBug.value ? t('report.placeholderBug') : t('report.placeholderIdea'),
)

// The chips carry translated labels, keyed by id. REPORT_SURFACES' own `label`
// stays English on purpose — it is what surfaceLabel() writes into the Sentry
// payload, which a developer reads, not a user.
const SURFACE_LABELS = computed<Record<string, string>>(() => ({
  list: t('report.surface.list'),
  add: t('report.surface.add'),
  scan: t('report.surface.scan'),
  history: t('report.surface.history'),
  settings: t('report.surface.settings'),
  notifications: t('report.surface.notifications'),
  signin: t('report.surface.signin'),
  other: t('report.surface.other'),
}))

const remaining = computed(() => REPORT_MAX_LENGTH - message.value.length)

function selectKind(next: ReportKind) {
  if (kind.value === next) return
  kind.value = next
  // The place carries across: the question is still on screen and still asked
  // of the same app, so clearing it would discard an answer the person can see
  // themselves having given.
  failure.value = ''
}

function selectSurface(id: string) {
  surface.value = surface.value === id ? '' : id
  failure.value = ''
}

async function send() {
  if (!canSend.value || sending.value) return
  sending.value = true
  failure.value = ''
  try {
    const ok = await submitReport({
      kind: kind.value,
      surface: surface.value,
      message: message.value,
      diagnostics: diagnostics.value,
    })
    if (ok) sent.value = true
    else failure.value = isCurrentlyOffline() ? t('report.offlineFailure') : t('report.sendFailure')
  } finally {
    sending.value = false
  }
}

// Reset on open rather than on close, so nothing changes under the closing
// animation and a reopened dialog is always a blank one.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    kind.value = 'bug'
    surface.value = ''
    message.value = ''
    sending.value = false
    sent.value = false
    failure.value = ''
  },
)
</script>

<template>
  <AppModal
    :open="open"
    overlay-class="report-overlay"
    transition="modal-fade"
    @close="emit('close')"
  >
    <div
      class="report-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-modal-title"
    >
      <div class="report-dialog__header">
        <div class="report-dialog__title-wrap">
          <div class="report-dialog__icon-bg">
            <AppIcon class="report-header-icon" name="flag" />
          </div>
          <div>
            <h3 id="report-modal-title">{{ t('report.title') }}</h3>
            <p class="report-dialog__subtitle">{{ t('report.subtitle') }}</p>
          </div>
        </div>
        <ModalCloseButton :aria-label="t('report.close')" @click="emit('close')" />
      </div>

      <!-- Sent: the form is replaced rather than dismissed. Closing on success
           leaves someone staring at the screen they were on, with no evidence
           the press did anything. -->
      <div v-if="sent" class="report-done">
        <AppIcon class="report-done__mark" name="check" />
        <!-- Answers the two things someone wonders once the press has landed:
             whether they still have something to do, and whether to expect a
             reply. What was attached is not one of them — that question was
             asked and answered on the form before they sent it. -->
        <h4>{{ t('report.sentTitle') }}</h4>
        <p>{{ t('report.sentBody') }}</p>
        <AppButton variant="primary" block @click="emit('close')">{{ t('common.done') }}</AppButton>
      </div>

      <div v-else class="report-dialog__body">
        <!-- No label over these two. They are the first thing in the dialog and
             they say what they are, so a line asking what kind of report this is
             only makes someone read the question before reading the answers. The
             group still carries the question for a screen reader, which cannot
             see that the buttons are self-describing. -->
        <div class="report-field">
          <div class="report-segmented" role="group" :aria-label="t('report.kindGroupLabel')">
            <button
              class="report-segmented__btn"
              :class="{ 'report-segmented__btn--on': kind === 'bug' }"
              type="button"
              :aria-pressed="kind === 'bug'"
              @click="selectKind('bug')"
            >
              {{ t('report.kindBug') }}
            </button>
            <button
              class="report-segmented__btn"
              :class="{ 'report-segmented__btn--on': kind === 'idea' }"
              type="button"
              :aria-pressed="kind === 'idea'"
              @click="selectKind('idea')"
            >
              {{ t('report.kindIdea') }}
            </button>
          </div>
        </div>

        <!-- The place, as a set of the app's own rooms. This is the part that
             replaces "please describe where the problem occurred": picking is
             precise, typing is not, and a tapped chip survives translation into
             a search of the codebase in a way prose does not.
             Always present, so switching the kind above never moves anything
             below it; only the label changes, and it stays one line. -->
        <div class="report-field">
          <p class="report-label" id="report-where-label">
            {{ whereLabel }}
            <span v-if="!isBug" class="report-optional">{{ t('custom.optional') }}</span>
          </p>
          <div class="report-places" role="group" aria-labelledby="report-where-label">
            <button
              v-for="place in REPORT_SURFACES"
              :key="place.id"
              class="report-place"
              :class="{ 'report-place--on': surface === place.id }"
              type="button"
              :aria-pressed="surface === place.id"
              @click="selectSurface(place.id)"
            >
              {{ SURFACE_LABELS[place.id] ?? place.label }}
            </button>
          </div>
        </div>

        <div class="report-field">
          <label class="report-label" for="report-message">{{ prompt }}</label>
          <textarea
            id="report-message"
            v-model="message"
            class="report-textarea"
            :placeholder="placeholder"
            :maxlength="REPORT_MAX_LENGTH"
            rows="4"
          ></textarea>
          <!-- Silent until the limit is close enough to matter. A counter
               running from 1000 is just a number watching someone type. -->
          <p v-if="remaining <= 100" class="report-count">{{ t('report.charsLeft', { n: remaining }) }}</p>
        </div>

        <div class="report-attached">
          <p class="report-attached__title">{{ t('report.attachedTitle') }}</p>
          <ul>
            <li v-for="line in attachedLines" :key="line">{{ line }}</li>
          </ul>
        </div>

        <div class="report-actions">
          <AppButton variant="secondary" block @click="emit('close')">{{ t('common.cancel') }}</AppButton>
          <AppButton variant="primary" block :disabled="!canSend || sending" @click="send">
            {{ sending ? t('report.sending') : t('report.send') }}
          </AppButton>
        </div>
      </div>
    </div>
  </AppModal>

  <!-- A send that went nowhere, said the way every other failure in the app is
       said. Stacks above the form rather than replacing it, so dismissing it
       leaves the text exactly where it was and Send can simply be pressed
       again. This was a paragraph under the button until it was the only
       failure in the app that was not a dialog. -->
  <ErrorModal :title="t('report.failureTitle')" :message="failure" @dismiss="failure = ''" />
</template>

<style scoped>
.report-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-dark);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: calc(var(--space-4) + var(--safe-top)) var(--space-4)
    calc(var(--space-4) + var(--safe-bottom));
}

.report-dialog {
  width: 100%;
  max-width: 460px;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: min(88vh, 720px);
}

.report-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  flex-shrink: 0;
}

.report-dialog__title-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.report-dialog__icon-bg {
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

.report-header-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
}

.report-header-icon :deep(svg),
.report-done__mark :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.report-dialog__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.report-dialog__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.report-dialog__body {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
  overflow-y: auto;
}

.report-field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.report-label {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

/* Rides on the label line rather than under it, so the two states of this
   question are exactly the same height. */
.report-optional {
  margin-left: 0.35rem;
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-disabled);
}

/* ─── The kind of report ─────────────────────────────────────────────────── */
.report-segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
  padding: 0.25rem;
  background: var(--bg-surface-alt);
  border-radius: var(--radius-lg);
}

.report-segmented__btn {
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  padding: 0.55rem var(--space-2);
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.report-segmented__btn--on {
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: var(--weight-bold);
  box-shadow: var(--elevation-soft);
}

/* ─── Where ──────────────────────────────────────────────────────────────── */
.report-places {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.report-place {
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-surface);
  border-radius: var(--radius-pill);
  padding: 0.4rem 0.75rem;
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
}

.report-place:hover {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--bg-surface));
  color: var(--text-primary);
}

/* The one saturated thing on the panel. Everything else here is grey on white
   precisely so the answered question is the thing the eye returns to. */
.report-place--on,
.report-place--on:hover {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--text-inverse);
}

/* ─── What ───────────────────────────────────────────────────────────────── */
.report-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 5.5rem;
  padding: 0.7rem 0.8rem;
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--text-primary);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.report-textarea::placeholder {
  color: var(--text-disabled);
}

.report-textarea:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary-soft);
}

.report-count {
  margin: 0;
  align-self: flex-end;
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

/* ─── What travels with it ───────────────────────────────────────────────── */
.report-attached {
  background: var(--bg-surface-alt);
  border-radius: var(--radius-md);
  padding: 0.7rem 0.85rem;
}

.report-attached__title {
  margin: 0 0 0.3rem;
  font-size: var(--text-2xs);
  font-weight: var(--weight-extrabold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-disabled);
}

.report-attached ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.report-attached li {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.45;
}

.report-actions {
  display: flex;
  gap: 0.6rem;
}

/* ─── Sent ───────────────────────────────────────────────────────────────── */
.report-done {
  padding: var(--space-2) var(--space-4) var(--space-6);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
}

.report-done__mark {
  width: 30px;
  height: 30px;
  color: var(--color-primary);
  display: inline-flex;
  margin-bottom: 0.2rem;
}

.report-done h4 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
}

.report-done p {
  margin: 0 0 0.9rem;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.5;
  max-width: 30ch;
}

/* Keyboard users get the same answer everywhere in here. */
.report-segmented__btn:focus-visible,
.report-place:focus-visible {
  outline: var(--border-width-thick) solid var(--color-primary);
  outline-offset: 2px;
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--transition-base) ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .report-dialog {
  animation: modal-rise-in var(--transition-slow) var(--ease-rise) forwards;
}

.modal-fade-leave-active .report-dialog {
  animation: modal-rise-out var(--transition-base) var(--ease-fall) forwards;
}

@media (max-width: 520px) {
  .report-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .report-dialog {
    max-width: none;
    max-height: 92dvh;
    border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
    padding-bottom: var(--safe-bottom);
    /* Flush with the bottom edge, so it travels its full height rather than
       nudging up — the same entrance every other sheet in the app makes. */
    --modal-rise: 100%;
  }
}
</style>
