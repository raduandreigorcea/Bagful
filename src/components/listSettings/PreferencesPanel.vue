<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSupabase } from '../../supabase'
import { userMessage } from '../../lib/errorMessages'
import { LIST_EMOJIS, listIconUrl } from '../../lib/listEmoji'
import ListIcon from '../ListIcon.vue'
import {
  clampItemLimit,
  LIST_NAME_MAX_LENGTH,
  ITEM_LIMIT_DEFAULT,
  ITEM_LIMIT_MAX,
  ITEM_LIMIT_MIN,
} from '../../lib/limits'
import { t } from '../../lib/i18n'
import AppIcon from '../AppIcon.vue'

// The three settings an owner can change: the list's name, its emoji, and how
// many active items each member may hold. Each is edited locally and committed
// by its own Save button, so a half-typed name is never written.
//
// The item limit is the one a moderator can also change, which is why it sits
// outside the isOwner sections rather than in a panel of its own.
const props = defineProps({
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  listItemLimit: { type: Number, default: ITEM_LIMIT_DEFAULT },
  listEmoji: { type: String, default: '' },
  isOwner: { type: Boolean, default: false },
})

// `error` carries the message up to the modal's single ErrorModal rather than
// opening one per panel — one dialog, wherever the failure came from.
const emit = defineEmits<{
  (e: 'refresh-list'): void
  (e: 'error', message: string, title?: string): void
}>()

const db = useSupabase()

const renameValue = ref('')
const savingName = ref(false)
const nameSaved = ref(false)
const renameLength = computed(() => renameValue.value.length)
const renameOverLimit = computed(() => renameLength.value > LIST_NAME_MAX_LENGTH)

const itemLimitValue = ref(ITEM_LIMIT_DEFAULT)
const savingItemLimit = ref(false)
const itemLimitSaved = ref(false)

const emojiValue = ref('')
const savingEmoji = ref(false)
const emojiSaved = ref(false)

// Re-seed the editable fields whenever the source values change — which
// includes the moment this panel mounts, and a refresh landing underneath it.
watch(
  () => [props.listName, props.listItemLimit, props.listEmoji] as const,
  ([name, limit, emoji]) => {
    renameValue.value = name || ''
    itemLimitValue.value = clampItemLimit(limit)
    emojiValue.value = emoji || ''
  },
  { immediate: true },
)

// The "Saved" ticks all clear themselves after a beat. Tracked so unmounting
// mid-tick (closing the modal, switching tab) does not leave a timer behind.
const savedTimers = new Set<ReturnType<typeof setTimeout>>()

function flashSaved(flag: { value: boolean }) {
  flag.value = true
  const timer = setTimeout(() => {
    flag.value = false
    savedTimers.delete(timer)
  }, 2000)
  savedTimers.add(timer)
}

onBeforeUnmount(() => {
  for (const timer of savedTimers) clearTimeout(timer)
  savedTimers.clear()
})

async function renameList() {
  if (!props.isOwner) return
  const nextName = renameValue.value.trim()
  if (!props.listId || savingName.value) return
  // An empty field is a mistake, not an instruction, and a Save that silently
  // did nothing would look as though it had worked. It is refused the same way the
  // ceiling below it is, because both are the same thing to whoever pressed the
  // button -- a name this list cannot have.
  if (!nextName) {
    emit('error', t('error.listNameRequired'), t('error.nameRequiredTitle'))
    return
  }
  if (renameOverLimit.value) {
    emit(
      'error',
      t('error.listNameTooLong', { max: LIST_NAME_MAX_LENGTH }),
      t('error.nameTooLongTitle'),
    )
    return
  }
  savingName.value = true
  try {
    const { error } = await db.from('lists').update({ name: nextName }).eq('id', props.listId)
    if (error) {
      emit('error', userMessage(error, t('error.renameListFailed')))
      return
    }
    emit('refresh-list')
    flashSaved(nameSaved)
  } finally {
    savingName.value = false
  }
}

async function saveEmoji() {
  if (!props.isOwner || !props.listId || savingEmoji.value) return
  savingEmoji.value = true
  try {
    const { error } = await db
      .from('lists')
      .update({ emoji: emojiValue.value || null })
      .eq('id', props.listId)
    if (error) {
      emit('error', userMessage(error, t('error.saveEmojiFailed')))
      return
    }
    emit('refresh-list')
    flashSaved(emojiSaved)
  } finally {
    savingEmoji.value = false
  }
}

// Picking is local; Save commits it, like the name and the item limit.
function pickEmoji(emoji: string) {
  if (savingEmoji.value) return
  // Tapping the current selection clears it (back to no emoji).
  emojiValue.value = emojiValue.value === emoji ? '' : emoji
}

async function saveItemLimit() {
  if (!props.listId || savingItemLimit.value) return

  const normalizedLimit = clampItemLimit(itemLimitValue.value)
  itemLimitValue.value = normalizedLimit

  savingItemLimit.value = true
  try {
    const { error } = await db
      .from('lists')
      .update({ max_items_per_member: normalizedLimit })
      .eq('id', props.listId)
    if (error) {
      emit('error', userMessage(error, t('error.saveLimitFailed')))
      return
    }
    emit('refresh-list')
    flashSaved(itemLimitSaved)
  } finally {
    savingItemLimit.value = false
  }
}
</script>

<template>
  <div class="tab-panel tab-panel--overlay">
    <div class="panel-section">
      <h4 class="panel-section-title">{{ t('prefs.title') }}</h4>

      <div class="preferences-grid">
        <section v-if="isOwner" class="card-item pref-card">
          <div class="pref-card__head">
            <AppIcon class="pref-card__icon" name="square-pen" />
            <div class="pref-card__meta">
              <h5>{{ t('prefs.nameTitle') }}</h5>
              <p>{{ t('prefs.nameDesc') }}</p>
            </div>
          </div>

          <div class="card-item__form">
            <div class="input-action-group">
              <div class="input-wrapper">
                <input
                  id="listNameInput"
                  :aria-label="t('prefs.nameTitle')"
                  v-model="renameValue"
                  class="panel-input"
                  type="text"
                  :placeholder="t('prefs.namePlaceholder')"
                />
              </div>
              <div class="panel-save-stack">
                <button
                  class="panel-save-btn"
                  type="button"
                  :disabled="savingName"
                  @click="renameList"
                >
                  <span v-if="savingName" class="btn-spinner"></span>
                  <span v-else-if="nameSaved" class="success-state animate-pop">
                    <AppIcon class="success-icon-wrap" name="check" />
                    {{ t('common.saved') }}
                  </span>
                  <span v-else>{{ t('common.save') }}</span>
                </button>
                <p class="panel-counter panel-counter--under-save" :class="{ 'panel-counter--danger': renameOverLimit }">
                  {{ renameLength }}/{{ LIST_NAME_MAX_LENGTH }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section v-if="isOwner" class="card-item pref-card">
          <div class="pref-card__head">
            <AppIcon class="pref-card__icon" name="sticker" />
            <div class="pref-card__meta">
              <h5>{{ t('prefs.emojiTitle') }}</h5>
              <p>{{ t('prefs.emojiDesc') }}</p>
            </div>
            <span
              class="pref-card__value pref-card__value--emoji"
              :class="{ 'pref-card__value--emoji-default': !emojiValue }"
            ><ListIcon :value="emojiValue" /></span>
          </div>

          <div class="emoji-picker">
            <button
              v-for="e in LIST_EMOJIS"
              :key="e"
              type="button"
              class="emoji-option"
              :class="{ 'emoji-option--active': emojiValue === e }"
              :aria-pressed="emojiValue === e"
              :aria-label="t('preferences.useEmoji', { emoji: t(`listIcon.${e}`) })"
              @click="pickEmoji(e)"
            ><img :src="listIconUrl(e) ?? ''" alt="" draggable="false" /></button>
          </div>

          <div class="card-item__form">
            <div class="input-action-group input-action-group--end">
              <button
                class="panel-save-btn"
                type="button"
                :disabled="savingEmoji"
                @click="saveEmoji"
              >
                <span v-if="savingEmoji" class="btn-spinner"></span>
                <span v-else-if="emojiSaved" class="success-state animate-pop">
                  <AppIcon class="success-icon-wrap" name="check" />
                  {{ t('common.saved') }}
                </span>
                <span v-else>{{ t('common.save') }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="card-item pref-card">
          <div class="pref-card__head">
            <AppIcon class="pref-card__icon" name="shopping-cart" />
            <div class="pref-card__meta">
              <h5>{{ t('prefs.limitTitle') }}</h5>
              <p>{{ t('prefs.limitDesc') }}</p>
            </div>
            <span class="pref-card__value">{{ itemLimitValue }}</span>
          </div>

          <div class="pref-range-wrap">
            <span class="pref-range-minmax">{{ ITEM_LIMIT_MIN }}</span>
            <input
              v-model.number="itemLimitValue"
              class="pref-range"
              type="range"
              :min="ITEM_LIMIT_MIN"
              :max="ITEM_LIMIT_MAX"
              step="1"
              :aria-label="t('prefs.limitSlider')"
            />
            <span class="pref-range-minmax">{{ ITEM_LIMIT_MAX }}</span>
          </div>

          <div class="card-item__form">
            <div class="input-action-group input-action-group--end">
              <button
                class="panel-save-btn"
                type="button"
                :disabled="savingItemLimit"
                @click="saveItemLimit"
              >
                <span v-if="savingItemLimit" class="btn-spinner"></span>
                <span v-else-if="itemLimitSaved" class="success-state animate-pop">
                  <AppIcon class="success-icon-wrap" name="check" />
                  {{ t('common.saved') }}
                </span>
                <span v-else>{{ t('common.save') }}</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Emoji picker */
.emoji-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(2.5rem, 1fr));
  gap: 0.4rem;
  margin-top: 0.85rem;
}

.emoji-option {
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  /* A share of the button rather than a fixed inset: the grid stretches the
     buttons with the sheet, and a 3D picture filling a wide button reads as
     shouting next to the text around it. */
  padding: 20%;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}

.emoji-option img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.emoji-option:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--bg-hover);
}

.emoji-option:active:not(:disabled) {
  transform: scale(0.92);
}

.emoji-option--active {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
  box-shadow: var(--focus-ring-primary);
}

.emoji-option:disabled {
  cursor: default;
}

.pref-card__value--emoji {
  font-size: 1.35rem;
  line-height: 1;
  /* Square, not the wide number-badge shape it inherits from .pref-card__value. */
  width: 2.4rem;
  height: 2.4rem;
  min-width: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
}

/* Nothing picked yet: the tile previews the fallback the topbar will use,
   dimmed so it still reads as a placeholder rather than a choice. */
.pref-card__value--emoji-default {
  opacity: 0.45;
}

.preferences-grid {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.pref-card {
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--color-primary) 3%, var(--bg-surface)) 0%,
    var(--bg-surface) 60%
  );
}

.pref-card__head {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.7rem;
}

.pref-card__meta {
  min-width: 0;
  flex: 1;
}

.pref-card__meta h5 {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
}

.pref-card__meta p {
  margin: 0.18rem 0 0;
  font-size: var(--text-xs);
  line-height: 1.45;
  color: var(--text-secondary);
}

.pref-card__icon {
  width: 20px;
  height: 20px;
  color: var(--color-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pref-card__icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

.pref-card__value {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  background: var(--bg-surface-alt);
  border: var(--border-width-thin) solid var(--bg-hover);
  border-radius: var(--radius-sm);
  padding: 0.22rem 0.5rem;
  min-width: 2.2rem;
  text-align: center;
}

.pref-range-wrap {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
}

.pref-range-minmax {
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
  min-width: 1rem;
  text-align: center;
}

.pref-range {
  flex: 1;
  appearance: none;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--border-light);
  outline: none;
}

.pref-range:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 4px;
}

.pref-range::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-primary);
  border: var(--border-width-thick) solid var(--bg-surface);
  box-shadow: var(--elevation-soft);
  cursor: pointer;
}

.pref-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-primary);
  border: var(--border-width-thick) solid var(--bg-surface);
  box-shadow: var(--elevation-soft);
  cursor: pointer;
}

.input-action-group {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.15rem;
  align-items: flex-start;
}

.input-action-group--end {
  justify-content: flex-end;
}

.input-wrapper {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.panel-input {
  width: 100%;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: 0.55rem 0.75rem;
  font-size: var(--text-base);
  background: var(--bg-surface);
  color: var(--text-primary);
  transition: all var(--transition-base) ease;
}

.panel-input:focus {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
  outline: none;
}

.panel-input::placeholder {
  color: var(--border-dark);
}

.panel-counter {
  margin: 0.25rem 0 0;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.panel-counter--under-save {
  min-width: 82px;
  text-align: center;
}

.panel-save-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.panel-counter--danger {
  color: var(--danger-main);
  font-weight: var(--weight-bold);
}

.panel-save-btn {
  background: var(--bg-hover);
  color: var(--text-primary);
  border: var(--border-width-thin) solid var(--bg-hover);
  border-radius: var(--radius-md);
  padding: 0.55rem 1rem;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  cursor: pointer;
  transition: all var(--transition-base) ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 82px;
}

.panel-save-btn:hover:not(:disabled) {
  background: var(--border-light);
  border-color: var(--border-dark);
}

.panel-save-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
