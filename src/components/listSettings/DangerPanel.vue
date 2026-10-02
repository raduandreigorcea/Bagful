<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type PropType } from 'vue'
import { useAuth } from '@clerk/vue'
import { useSupabase } from '../../supabase'
import { userMessage } from '../../lib/errorMessages'
import { randomInviteCode } from '../../lib/inviteCode'
import type { ConfirmOptions } from '../../lib/useConfirm'
import { t, tAccent } from '../../lib/i18n'
import AppIcon from '../AppIcon.vue'
import AppButton from '../AppButton.vue'

// The actions that cannot be undone: rotating the invite code, leaving, and
// deleting the list. An owner sees delete, everyone else sees leave — the
// owner cannot leave a list they still own.
const props = defineProps({
  listId: { type: String, default: '' },
  listName: { type: String, default: '' },
  isOwner: { type: Boolean, default: false },
  isOwnerOrModerator: { type: Boolean, default: false },
  // The modal's own confirm dialog, handed down so every destructive action in
  // the settings shares one dialog instead of each panel mounting its own.
  confirm: {
    type: Function as PropType<(options: ConfirmOptions) => Promise<boolean>>,
    required: true,
  },
})

const emit = defineEmits<{
  (e: 'refresh-list'): void
  (e: 'list-deleted'): void
  (e: 'list-left'): void
  (e: 'error', message: string, title?: string): void
}>()

const { userId } = useAuth()
const db = useSupabase()

// Split on the marker, then interpolated, so the bolded run is the list's
// own name wherever that language puts it in the sentence — and so a name
// carrying a bracket of its own cannot move where the bolding starts or ends.
const deleteDesc = computed(() => tAccent('danger.deleteDesc', { name: props.listName }))

const regenerating = ref(false)
const codeRegenerated = ref(false)
const leavingList = ref(false)
const deletingList = ref(false)

let regeneratedTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (regeneratedTimer) clearTimeout(regeneratedTimer)
})

async function regenerateInviteCode() {
  if (!props.listId || regenerating.value) return
  const confirmed = await props.confirm({
    title: t('danger.confirmRegenerateTitle'),
    message: t('danger.confirmRegenerateMessage'),
    danger: false,
  })
  if (!confirmed) return
  regenerating.value = true
  try {
    const { error } = await db
      .from('lists')
      .update({ invite_code: randomInviteCode() })
      .eq('id', props.listId)
    if (error) {
      // Includes the rare unique-index collision on the new code; retrying
      // draws a different one, which is what the message asks for.
      emit('error', userMessage(error, t('error.regenerateCodeFailed')))
      return
    }
    emit('refresh-list')
    codeRegenerated.value = true
    if (regeneratedTimer) clearTimeout(regeneratedTimer)
    regeneratedTimer = setTimeout(() => {
      codeRegenerated.value = false
    }, 2000)
  } finally {
    regenerating.value = false
  }
}

async function leaveList() {
  if (!props.listId || leavingList.value) return
  const confirmed = await props.confirm({
    title: t('danger.confirmLeaveTitle'),
    message: t('danger.confirmLeaveMessage'),
    danger: true,
  })
  if (!confirmed || !userId.value) return
  leavingList.value = true
  try {
    const { error } = await db
      .from('list_members')
      .delete()
      .eq('list_id', props.listId)
      .eq('user_id', userId.value)
    if (error) {
      emit('error', userMessage(error, t('error.leaveListFailed')))
      return
    }
    // HomeView moves to another list, or to setup if none remain.
    emit('list-left')
  } finally {
    leavingList.value = false
  }
}

async function deleteList() {
  if (!props.listId || deletingList.value) return
  const confirmed = await props.confirm({
    title: t('danger.confirmDeleteTitle'),
    message: t('danger.confirmDeleteMessage', { name: props.listName }),
    danger: true,
  })
  if (!confirmed) return
  deletingList.value = true
  try {
    const { error } = await db.from('lists').delete().eq('id', props.listId)
    if (error) {
      emit('error', userMessage(error, t('error.deleteListFailed')))
      return
    }
    // HomeView reconciles: switch to another list, or setup if none remain.
    emit('list-deleted')
  } finally {
    deletingList.value = false
  }
}
</script>

<template>
  <div class="tab-panel tab-panel--overlay">
    <!-- Invite code rotation -->
    <div class="panel-section" v-if="isOwnerOrModerator">
      <h4 class="panel-section-title">{{ t('danger.inviteTitle') }}</h4>
      <div class="card-item card-item--action">
        <div class="card-item__info">
          <p>{{ t('danger.inviteDesc') }}</p>
        </div>
        <button
          class="panel-action-btn"
          type="button"
          :disabled="regenerating"
          @click="regenerateInviteCode"
        >
          <span v-if="regenerating" class="btn-spinner"></span>
          <span v-else-if="codeRegenerated" class="success-state animate-pop">
            <AppIcon class="success-icon-wrap" name="check" />
            {{ t('danger.regenerated') }}
          </span>
          <span v-else>{{ t('danger.regenerate') }}</span>
        </button>
      </div>
    </div>

    <!-- Leave (non-owners) -->
    <div class="panel-section" v-if="!isOwner">
      <h4 class="panel-section-title text-danger">{{ t('danger.leaveTitle') }}</h4>
      <div class="card-item card-item--action">
        <div class="card-item__info">
          <p>{{ t('danger.leaveDesc') }}</p>
        </div>
        <AppButton variant="danger" size="sm" class="danger-action-btn" :disabled="leavingList" @click="leaveList">{{ t('danger.leaveTitle') }}</AppButton>
      </div>
    </div>

    <!-- Delete (owner only) -->
    <div class="panel-section" v-if="isOwner">
      <h4 class="panel-section-title text-danger">{{ t('danger.deleteTitle') }}</h4>
      <div class="card-item card-item--action card-item--danger">
        <div class="card-item__info">
          <!-- The list's name is bolded mid-sentence, so the string
               carries a [marker] round it and tAccent places the three
               pieces — the same mechanism the setup headings use, and for the
               same reason: which words sit either side of the name differs
               per language. -->
          <p>{{ deleteDesc[0] }}<strong>{{ deleteDesc[1] }}</strong>{{ deleteDesc[2] }}</p>
        </div>
        <AppButton
          variant="danger"
          size="sm"
          class="danger-action-btn danger-action-btn--delete"
          :disabled="deletingList"
          @click="deleteList"
        >
          <span v-if="deletingList" class="btn-spinner btn-spinner--light"></span>
          <span v-else>{{ t('danger.deleteTitle') }}</span>
        </AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Card Action (Regenerate code) */
.card-item--action {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  background: var(--bg-surface);
}

@media (max-width: 480px) {
  .card-item--action {
    flex-direction: column;
    gap: 0.75rem;
  }
  .card-item--action .panel-action-btn {
    width: auto;
    align-self: flex-start;
    justify-content: flex-start;
  }
}

.card-item__info h5 {
  margin: 0 0 0.2rem 0;
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.card-item__info p {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.45;
}

.panel-action-btn {
  background: var(--bg-surface);
  color: var(--text-primary);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: 0.55rem 0.9rem;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  cursor: pointer;
  transition: all var(--transition-base) ease;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 100px;
  /* Same reason as .danger-action-btn below: nowrap without flex-shrink:0 spills
     rather than wraps. "Regenerated" is wider than "Regenerate", so this one can
     overflow at the moment it succeeds. */
  flex-shrink: 0;
}

.panel-action-btn:hover:not(:disabled) {
  background: var(--bg-surface-alt);
  border-color: var(--border-dark);
}

.panel-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Danger zone card modifier */
.card-item--danger {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

/* Layout only: the look is AppButton's danger variant. */
.danger-action-btn {
  white-space: nowrap;
  min-width: 100px;
  /* Pairs with white-space:nowrap. Without it this is an ordinary flex item and
     will shrink under its own label, which nowrap then spills outside the button
     rather than wrapping. The paragraph beside it is the part meant to give way.
     Latent until "Delete Family" became "Delete List" and the label got
     wide enough to cross the threshold. */
  flex-shrink: 0;
}
</style>
