<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, toRaw, useId, watch } from 'vue'
import { useAuth, useClerk, useUser } from '@clerk/vue'
import { Capacitor } from '@capacitor/core'
import { useSupabase } from '../supabase'
import { refreshOwnProfile } from '../lib/profile'
import { userMessage } from '../lib/errorMessages'
import { getUserDisplayName, getUserInitial, getUserPrimaryEmail } from '../lib/userIdentity'
import { useConfirm } from '../lib/useConfirm'
import { useSignOut } from '../lib/useSignOut'
import { linkNativeOAuth, type NativeOAuthUser } from '../lib/nativeOAuth'
import { ReverificationCancelled, withReverification } from '../lib/reverification'
import { t } from '../lib/i18n'
import AppModal from './AppModal.vue'
import AppButton from './AppButton.vue'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import ModalCloseButton from './ModalCloseButton.vue'
import AccountTransferStep, { type TransferCandidate } from './AccountTransferStep.vue'

// The person's own profile: name, photo, email, a linked Google account, and the
// way to delete the account. It replaced Clerk's UserProfile, which could delete
// the Clerk user but told the database nothing, so a deleted account left its
// lists, memberships and name behind. Deleting goes through delete_my_account()
// (003_lists_and_members.sql) FIRST and Clerk second: the other order would
// leave data nobody can sign in to delete.
//
// Name and photo live in Clerk, and the profiles row every roster reads is a copy
// of them, so each change here is followed by refreshOwnProfile().

defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits<{ close: [] }>()

const titleId = useId()
const nameId = useId()
const nameErrorId = useId()
const db = useSupabase()
const { userId } = useAuth()
const { user } = useUser()
const clerk = useClerk()
// Linking, unlinking and deleting can each be refused until the person signs
// in again; see lib/reverification.
const reverified = <T,>(action: () => Promise<T>) => withReverification(clerk.value, action)
const { state: confirmState, confirm, resolveWith } = useConfirm()
const { signOut } = useSignOut({ userId: () => userId.value ?? '' })

// Every Clerk method is called on the raw instance: @clerk/vue hands out a
// reactive Proxy, and Clerk's classes use private fields that throw when `this`
// is a Proxy (the same trap nativeOAuth.ts documents).
const rawUser = () => (user.value ? toRaw(user.value) : null)

// One message per section, shown where the thing that failed is, rather than
// one line somewhere in the middle that a photo error and a Google error share.
const errors = reactive({ photo: '', name: '', google: '', delete: '' })

async function syncProfile() {
  if (!userId.value || !user.value) return
  // Skips nothing: the name or photo just changed, so the signature differs.
  await refreshOwnProfile(db, userId.value, rawUser(), localStorage)
}

// ─── name ─────────────────────────────────────────────────────────────────────
const name = ref('')
watch(
  () => getUserDisplayName(user.value),
  (current) => (name.value = current),
  { immediate: true },
)
const savingName = ref(false)
const nameSaved = ref(false)
const nameUnchanged = computed(() => !name.value.trim() || name.value.trim() === getUserDisplayName(user.value))

let savedTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer)
})

async function saveName() {
  const trimmed = name.value.trim()
  if (!user.value || nameUnchanged.value) return
  savingName.value = true
  errors.name = ''
  try {
    const space = trimmed.indexOf(' ')
    await rawUser()!.update(
      space === -1
        ? { firstName: trimmed, lastName: '' }
        : { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space + 1) },
    )
    await syncProfile()
    nameSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (nameSaved.value = false), 2000)
  } catch (e) {
    errors.name = userMessage(e, t('profile.nameFailed'))
  } finally {
    savingName.value = false
  }
}

// ─── photo ────────────────────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)
const savingPhoto = ref(false)

async function setPhoto(file: File | null) {
  if (!user.value) return
  savingPhoto.value = true
  errors.photo = ''
  try {
    await rawUser()!.setProfileImage({ file })
    await rawUser()!.reload()
    await syncProfile()
  } catch (e) {
    errors.photo = userMessage(e, t('profile.photoFailed'))
  } finally {
    savingPhoto.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

function onFilePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void setPhoto(file)
}

// ─── Google ───────────────────────────────────────────────────────────────────
const email = computed(() => getUserPrimaryEmail(user.value))
// Only a verified link counts: an attempt abandoned in the browser leaves an
// unverified account behind, which signs nobody in.
const google = computed(
  () =>
    user.value?.externalAccounts?.find(
      (a) => a.provider === 'google' && a.verification?.status === 'verified',
    ) ?? null,
)
// "Linked", plus the Google address only when it is not the one already shown
// in the row above: the same address twice reads like two accounts.
const googleLabel = computed(() => {
  const address = google.value?.emailAddress
  return address && address.toLowerCase() !== email.value.toLowerCase()
    ? t('profile.googleLinkedAs', { email: address })
    : t('profile.googleLinked')
})
const savingGoogle = ref(false)

async function linkGoogle() {
  const raw = rawUser()
  if (!raw) return
  savingGoogle.value = true
  errors.google = ''
  try {
    if (Capacitor.isNativePlatform()) {
      await reverified(() => linkNativeOAuth(raw as unknown as NativeOAuthUser, 'oauth_google'))
      return
    }
    // The web leaves the app for Google and comes back to it; Clerk has
    // finished the link by then, so the profile shows it on return.
    const account = await reverified(() =>
      raw.createExternalAccount({ strategy: 'oauth_google', redirectUrl: window.location.href }),
    )
    const url = account.verification?.externalVerificationRedirectURL
    if (!url) throw new Error('Clerk returned no verification URL for linking.')
    window.location.assign(url.href)
  } catch (e) {
    // Closing the verification window is a change of mind, not a failure.
    if (!(e instanceof ReverificationCancelled)) errors.google = userMessage(e, t('profile.googleFailed'))
  } finally {
    savingGoogle.value = false
  }
}

async function unlinkGoogle() {
  const account = google.value
  if (!account) return
  const sure = await confirm({
    title: t('profile.confirmUnlinkTitle'),
    message: t('profile.confirmUnlinkMessage'),
    confirmText: t('profile.googleUnlink'),
    danger: true,
  })
  if (!sure) return
  savingGoogle.value = true
  errors.google = ''
  try {
    // Clerk refuses to remove someone's last way in, and says so.
    await reverified(() => toRaw(account).destroy())
    await rawUser()?.reload()
  } catch (e) {
    if (!(e instanceof ReverificationCancelled)) errors.google = userMessage(e, t('profile.googleFailed'))
  } finally {
    savingGoogle.value = false
  }
}

// ─── deleting the account ─────────────────────────────────────────────────────
// Null until "Delete account" is pressed and the owned list turns out to have
// other people on it; then the step that asks who takes it over.
const candidates = ref<TransferCandidate[] | null>(null)
const newOwner = ref('')
const heir = computed(() => candidates.value?.find((c) => c.user_id === newOwner.value) ?? null)
const deleting = ref(false)
const deleteButton = ref<HTMLButtonElement | null>(null)
// The database half succeeded and Clerk's did not, so a retry skips straight to
// Clerk: the RPC would find nothing left to delete anyway.
let dataDeleted = false

async function startDelete() {
  errors.delete = ''
  if (dataDeleted) return finishDelete()
  const { data, error } = await db.rpc('account_transfer_candidates')
  if (error) {
    errors.delete = userMessage(error, t('profile.deleteFailed'))
    return
  }
  if (data?.length) {
    candidates.value = data
    newOwner.value = data.find((c) => !c.owns_list)?.user_id ?? ''
    return
  }
  await confirmAndDelete()
}

// Back from the transfer step: focus returns to the control that opened it.
async function leaveTransfer() {
  candidates.value = null
  errors.delete = ''
  await nextTick()
  deleteButton.value?.focus()
}

async function confirmAndDelete() {
  const sure = await confirm({
    title: t('profile.confirmDeleteTitle'),
    // With a new owner picked, the list is not deleted, so the message that
    // says it is would contradict the step they just finished.
    message: heir.value
      ? t('profile.deleteDescTransfer', { name: heir.value.display_name })
      : t('profile.deleteDesc'),
    confirmText: t('profile.deleteTitle'),
    danger: true,
  })
  if (!sure) return
  deleting.value = true
  errors.delete = ''
  const { error } = await db.rpc('delete_my_account', {
    p_new_owner: newOwner.value || undefined,
  })
  if (error) {
    deleting.value = false
    errors.delete = userMessage(error, t('profile.deleteFailed'))
    return
  }
  dataDeleted = true
  await finishDelete()
}

async function finishDelete() {
  deleting.value = true
  try {
    // The data is already gone by here, so a verification request is answered
    // rather than failed on; cancelling it lands on the retry message below.
    await reverified(async () => {
      await rawUser()?.delete()
    })
  } catch {
    deleting.value = false
    errors.delete = t('profile.clerkDeleteFailed')
    return
  }
  // Clears this device's caches, push binding and error-report identity. Clerk's
  // own sign-out may fail now that the user is gone; useSignOut swallows that,
  // so the redirect is made here rather than trusted to it.
  await signOut()
  window.location.replace(`${window.location.origin}/login`)
}

function close() {
  if (deleting.value) return
  candidates.value = null
  Object.assign(errors, { photo: '', name: '', google: '', delete: '' })
  emit('close')
}
</script>

<template>
  <AppModal :open="open" overlay-class="profile-overlay" transition="modal-fade" @close="close">
    <div class="profile-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <div class="profile-dialog__header">
        <div class="profile-dialog__title-wrap">
          <div class="profile-dialog__icon-bg" aria-hidden="true">
            <AppIcon class="profile-icon profile-icon--header" name="user-round" />
          </div>
          <div>
            <!-- The handover step is about the list, not the name and photo the
                 subtitle describes, so it is titled for what it is. -->
            <h3 :id="titleId">{{ candidates ? t('profile.deleteTitle') : t('profile.title') }}</h3>
            <p v-if="!candidates" class="profile-dialog__subtitle">{{ t('profile.subtitle') }}</p>
          </div>
        </div>
        <ModalCloseButton :aria-label="t('profile.close')" @click="close" />
      </div>

      <div class="profile-dialog__body">
        <AccountTransferStep
          v-if="candidates"
          v-model="newOwner"
          :candidates="candidates"
          :deleting="deleting"
          :error="errors.delete"
          @back="leaveTransfer"
          @delete="confirmAndDelete"
        />

        <template v-else>
          <section class="profile-photo" :aria-busy="savingPhoto">
            <div class="profile-photo__frame">
              <img v-if="user?.imageUrl" :src="user.imageUrl" alt="" class="profile-photo__avatar" />
              <span v-else class="profile-photo__avatar profile-photo__avatar--fallback" aria-hidden="true">
                {{ getUserInitial(user) }}
              </span>
              <span v-if="savingPhoto" class="profile-photo__busy" aria-hidden="true">
                <span class="profile-spinner"></span>
              </span>
            </div>
            <div class="profile-photo__side">
              <div class="profile-photo__actions">
                <AppButton variant="secondary" size="sm" :disabled="savingPhoto" @click="fileInput?.click()">
                  {{ t('profile.changePhoto') }}
                </AppButton>
                <AppButton
                  v-if="user?.hasImage"
                  variant="secondary"
                  size="sm"
                  :disabled="savingPhoto"
                  @click="setPhoto(null)"
                >
                  {{ t('profile.removePhoto') }}
                </AppButton>
              </div>
              <p v-if="errors.photo" class="profile-error" role="alert">{{ errors.photo }}</p>
            </div>
            <input ref="fileInput" type="file" accept="image/*" hidden @change="onFilePicked" />
          </section>

          <form class="profile-field" novalidate @submit.prevent="saveName">
            <label class="profile-label" :for="nameId">{{ t('profile.nameLabel') }}</label>
            <div class="profile-name-row">
              <input
                :id="nameId"
                v-model="name"
                class="profile-input"
                type="text"
                maxlength="80"
                autocomplete="name"
                :aria-invalid="errors.name ? 'true' : undefined"
                :aria-describedby="errors.name ? nameErrorId : undefined"
                @input="nameSaved = false"
              />
              <AppButton type="submit" size="sm" :disabled="savingName || nameUnchanged" :aria-busy="savingName">
                <template v-if="nameSaved">
                  <AppIcon class="profile-icon" name="check" aria-hidden="true" />
                  {{ t('common.saved') }}
                </template>
                <template v-else>{{ t('common.save') }}</template>
              </AppButton>
            </div>
            <p v-if="errors.name" :id="nameErrorId" class="profile-error" role="alert">{{ errors.name }}</p>
          </form>

          <dl class="profile-facts">
            <div class="profile-fact">
              <dt>{{ t('profile.emailLabel') }}</dt>
              <dd class="profile-fact__value">{{ email || t('account.noEmail') }}</dd>
            </div>
            <div class="profile-fact">
              <dt>{{ t('profile.google') }}</dt>
              <dd class="profile-fact__value profile-fact__value--action">
                <span v-if="google" class="profile-fact__text">{{ googleLabel }}</span>
                <AppButton
                  variant="secondary"
                  size="sm"
                  :disabled="savingGoogle"
                  :aria-busy="savingGoogle"
                  :aria-label="google ? t('profile.googleUnlinkLabel') : t('profile.googleLinkLabel')"
                  @click="google ? unlinkGoogle() : linkGoogle()"
                >
                  {{ google ? t('profile.googleUnlink') : t('profile.googleLink') }}
                </AppButton>
              </dd>
            </div>
          </dl>
          <p v-if="errors.google" class="profile-error" role="alert">{{ errors.google }}</p>

          <!-- One quiet row rather than a danger card: it is the least used thing
               here, and what it deletes is spelled out in the confirm it opens. -->
          <div class="profile-delete-wrap">
            <button
              ref="deleteButton"
              class="profile-delete"
              type="button"
              :disabled="deleting"
              :aria-busy="deleting"
              @click="startDelete"
            >
              <AppIcon class="profile-icon" name="trash-2" aria-hidden="true" />
              <span>{{ deleting ? t('profile.deleting') : t('profile.deleteTitle') }}</span>
            </button>
            <p v-if="errors.delete" class="profile-error" role="alert">{{ errors.delete }}</p>
          </div>
        </template>
      </div>
    </div>
  </AppModal>

  <ConfirmModal
    :open="confirmState.open"
    :title="confirmState.title"
    :message="confirmState.message"
    :danger="confirmState.danger"
    :confirm-text="confirmState.confirmText"
    :cancel-text="confirmState.cancelText"
    :show-cancel="confirmState.showCancel"
    @confirm="resolveWith(true)"
    @cancel="resolveWith(false)"
  />
</template>

<style scoped>
/* Overlay, dialog and header match AccountActionModal, which this opens from. */
.profile-overlay {
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

.profile-dialog {
  width: 100%;
  max-width: 420px;
  max-height: 100%;
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.profile-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
}

.profile-dialog__title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.profile-dialog__icon-bg {
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

.profile-dialog__header h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.profile-dialog__subtitle {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

.profile-dialog__body {
  padding: 0 var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  overflow-y: auto;
}

/* AppIcon ships its SVGs unstyled; one rule sizes and weights all of them here. */
.profile-icon {
  width: var(--size-icon-md);
  height: var(--size-icon-md);
  display: inline-flex;
  flex-shrink: 0;
}

.profile-icon--header {
  width: 22px;
  height: 22px;
}

.profile-icon :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}

/* ─── photo ─── */
.profile-photo {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  background: var(--bg-surface-alt);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
}

.profile-photo__frame {
  position: relative;
  flex-shrink: 0;
}

.profile-photo__avatar {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-pill);
  object-fit: cover;
  border: var(--border-width-base) solid var(--bg-surface);
  box-shadow: var(--elevation-soft);
  display: block;
}

.profile-photo__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xl);
  font-weight: var(--weight-extrabold);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 16%, var(--bg-surface));
}

/* Over the avatar rather than in a button label: the picture is what is
   changing, so that is where the wait shows. */
.profile-photo__busy {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.profile-spinner {
  width: 22px;
  height: 22px;
  border: 2.5px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-top-color: var(--color-primary);
  border-radius: var(--radius-pill);
  animation: profile-spin 0.8s linear infinite;
}

@keyframes profile-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .profile-spinner {
    animation-duration: 2.4s;
  }
}

.profile-photo__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.profile-photo__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* ─── name ─── */
.profile-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.profile-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.profile-name-row {
  display: flex;
  gap: var(--space-2);
}

.profile-name-row .app-btn {
  flex-shrink: 0;
}

.profile-input {
  flex: 1;
  min-width: 0;
  min-height: var(--size-control-md);
  font: inherit;
  font-size: var(--text-base);
  color: var(--text-primary);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  transition: border-color var(--transition-base) ease, box-shadow var(--transition-base) ease;
}

.profile-input:focus-visible {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--focus-ring-primary);
}

.profile-input[aria-invalid='true'] {
  border-color: var(--danger-border);
}

/* ─── email and Google ─── */
.profile-facts {
  margin: 0;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
}

.profile-fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--size-control-lg);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-sm);
}

.profile-fact + .profile-fact {
  border-top: var(--border-width-thin) solid var(--border-main);
}

.profile-fact dt {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.profile-fact__value {
  margin: 0;
  min-width: 0;
  color: var(--text-primary);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-fact__value--action {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  overflow: visible;
}

.profile-fact__value--action .app-btn {
  flex-shrink: 0;
}

.profile-fact__text {
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--danger-solid);
}

/* ─── delete ─── */
.profile-delete-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

.profile-delete {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-height: var(--size-control-sm);
  padding: var(--space-1) var(--space-2);
  margin-inline-start: calc(-1 * var(--space-2));
  border: none;
  background: none;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--danger-solid);
  cursor: pointer;
  transition: background var(--transition-base) ease;
}

.profile-delete:hover:not(:disabled) {
  background: var(--danger-bg);
}

.profile-delete:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--danger-solid);
}

.profile-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
