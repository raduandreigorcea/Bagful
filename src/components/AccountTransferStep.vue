<script setup lang="ts">
import { onMounted, ref, useId, type PropType } from 'vue'
import { initialOf } from '../lib/userIdentity'
import { t } from '../lib/i18n'
import AppButton from './AppButton.vue'

// The step AccountProfileModal shows before deleting an account whose list
// still has other people on it: who takes the list over, or nobody. Members who
// already own a list are listed but disabled, with the reason in words rather
// than only a greyed row, because lists_one_per_owner would refuse them.

export interface TransferCandidate {
  user_id: string
  display_name: string
  image_url: string | null
  owns_list: boolean
}

defineProps({
  candidates: { type: Array as PropType<TransferCandidate[]>, required: true },
  deleting: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits<{ back: []; delete: [] }>()
// '' means "delete the list for everyone".
const newOwner = defineModel<string>({ required: true })

const headingId = useId()
const errorId = useId()
const heading = ref<HTMLElement | null>(null)

// The view under the pointer was swapped out from under it, so focus would be
// left on nothing. The heading says where the person now is.
onMounted(() => heading.value?.focus())
</script>

<template>
  <div class="transfer">
    <div>
      <h4 :id="headingId" ref="heading" class="transfer__title" tabindex="-1">
        {{ t('profile.transferTitle') }}
      </h4>
      <p class="transfer__hint">{{ t('profile.transferDesc') }}</p>
    </div>

    <div
      class="transfer__choices"
      role="radiogroup"
      :aria-labelledby="headingId"
      :aria-describedby="error ? errorId : undefined"
    >
      <label
        v-for="c in candidates"
        :key="c.user_id"
        class="transfer__choice"
        :class="{ 'transfer__choice--disabled': c.owns_list }"
      >
        <input v-model="newOwner" type="radio" :value="c.user_id" :disabled="c.owns_list || deleting" />
        <img v-if="c.image_url" :src="c.image_url" alt="" class="transfer__avatar" />
        <span v-else class="transfer__avatar transfer__avatar--fallback" aria-hidden="true">
          {{ initialOf(c.display_name) }}
        </span>
        <span class="transfer__name">
          {{ c.display_name }}
          <small v-if="c.owns_list">{{ t('profile.transferOwnsList') }}</small>
        </span>
      </label>
      <label class="transfer__choice transfer__choice--danger">
        <input v-model="newOwner" type="radio" value="" :disabled="deleting" />
        <span class="transfer__name">{{ t('profile.transferNobody') }}</span>
      </label>
    </div>

    <p v-if="error" :id="errorId" class="transfer__error" role="alert">{{ error }}</p>

    <div class="transfer__actions">
      <AppButton variant="secondary" block :disabled="deleting" @click="emit('back')">
        {{ t('common.back') }}
      </AppButton>
      <AppButton variant="danger" block :disabled="deleting" :aria-busy="deleting" @click="emit('delete')">
        {{ deleting ? t('profile.deleting') : t('profile.deleteTitle') }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.transfer {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.transfer__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-md);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
}

.transfer__title:focus {
  outline: none;
}

.transfer__hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.45;
}

.transfer__choices {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.transfer__choice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--size-control-lg);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  transition: border-color var(--transition-base) ease, background var(--transition-base) ease;
}

.transfer__choice:hover:not(.transfer__choice--disabled) {
  background: var(--bg-hover);
}

.transfer__choice:has(input:focus-visible) {
  box-shadow: inset 0 0 0 2px var(--color-primary);
}

.transfer__choice:has(input:checked) {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--bg-surface));
}

.transfer__choice--danger:has(input:checked) {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.transfer__choice--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.transfer__choice input {
  accent-color: var(--color-primary);
  margin: 0;
}

.transfer__choice--danger input {
  accent-color: var(--danger-solid);
}

.transfer__avatar {
  width: var(--size-avatar-sm);
  height: var(--size-avatar-sm);
  border-radius: var(--radius-pill);
  object-fit: cover;
  flex-shrink: 0;
}

.transfer__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--weight-extrabold);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
}

.transfer__name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.transfer__name small {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}

.transfer__error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--danger-solid);
}

.transfer__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
