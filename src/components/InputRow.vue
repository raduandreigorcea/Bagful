<script setup lang="ts">
import { t } from '../lib/i18n'
import AppIcon from './AppIcon.vue'

// Anything not declared below lands on the <input>, not on the wrapper <div>.
//
// Without this, every undeclared attribute a caller writes falls through onto
// the wrapper, where it silently does nothing — which is how `required` and
// `autofocus` were once lost, and the setup screen quietly stopped focusing its
// field. Declaring a prop per attribute fixes only the attribute somebody
// noticed; `inputmode`, `pattern`, `readonly`, `name` and the rest would each
// fail the same invisible way in turn. No caller passes class or style, so
// nothing that belongs on the wrapper moves off it.
defineOptions({ inheritAttrs: false })

defineProps({
  modelValue: String,
  type: { type: String, default: 'text' },
  // What the field is called, for anyone who cannot see the form around it.
  //
  // The placeholder is not that. It is a hint, it is not exposed as an
  // accessible name reliably, and it disappears the moment someone types — so a
  // screen-reader user checking what they are in the middle of filling in hears
  // "edit text" and nothing else. This component is the sign-in email field and
  // both list setup fields, which made it the app's front door.
  ariaLabel: String,
  placeholder: String,
  autocomplete: String,
  maxlength: [String, Number],
  // Both belong to the wrapper's own controls, so they stay props: `loading`
  // drives the submit button, `uppercase` styles the input.
  loading: { type: Boolean, default: false },
  uppercase: { type: Boolean, default: false },
})

defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="input-row">
    <input
      v-bind="$attrs"
      :value="modelValue"
      :type="type"
      :aria-label="ariaLabel"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :maxlength="maxlength"
      :class="{ 'input--uppercase': uppercase }"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button type="submit" class="submit-btn" :disabled="loading" :aria-label="t('common.continue')">
      <span v-if="loading" class="spinner"></span>
      <AppIcon v-else class="submit-btn__icon" name="arrow-right" />
    </button>
  </div>
</template>

<style scoped>
.input-row {
  display: flex;
  align-items: center;
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-xl);
  background: var(--bg-surface);
  transition: border-color var(--transition-fast);
  overflow: hidden;
}

.input-row:focus-within {
  border-color: var(--color-primary);
}

.input-row input {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--text-lg);
  color: var(--text-primary);
  outline: none;
  min-width: 0;
}

.input-row input::placeholder {
  color: var(--text-disabled);
  font-weight: var(--weight-regular);
  letter-spacing: 0;
  text-transform: none;
}

.input--uppercase {
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-weight: var(--weight-bold);
}

.submit-btn {
  width: var(--size-control-md);
  height: var(--size-control-md);
  flex-shrink: 0;
  margin: 4px;
  background: var(--color-primary);
  color: var(--text-inverse);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: opacity var(--transition-fast);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.submit-btn__icon {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  display: inline-flex;
}

/* The asset ships at stroke-width 1 for a 24px box; weight it for this size. */
.submit-btn__icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke: currentColor;
  stroke-width: 2;
}

.submit-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.spinner {
  width: var(--size-icon-lg);
  height: var(--size-icon-lg);
  border: var(--border-width-thick) solid var(--spinner-stroke);
  border-top-color: var(--text-inverse);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
