<script setup lang="ts">
import { useAuth, useClerk, useSignIn, useSignUp } from '@clerk/vue'
import { Capacitor } from '@capacitor/core'
import { captureException } from '../lib/errorReporting'
import { computed, ref, nextTick, toRaw, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  startNativeOAuth,
  type NativeOAuthSignIn,
  type NativeOAuthSignUp,
} from '../lib/nativeOAuth'
import InputRow from '../components/InputRow.vue'
import ErrorModal from '../components/ErrorModal.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import AppCard from '../components/AppCard.vue'
import BackButton from '../components/BackButton.vue'
import { isOfflineError } from '../lib/offlineQueue'
import { t, tAccent } from '../lib/i18n'
import AppIcon from '../components/AppIcon.vue'

const clerk = useClerk()
const { signIn, isLoaded: signInLoaded } = useSignIn()
const { signUp } = useSignUp()
const { isSignedIn } = useAuth()
const router = useRouter()

const step = ref('email') // 'email' | 'code'
const email = ref('')
const digits = ref(['', '', '', '', '', ''])
const digitRefs = ref<HTMLInputElement[]>([])
const error = ref('')
const loading = ref(false)
const loadingProvider = ref<string | null>(null)
const alreadySignedInOpen = ref(false)

// The router guard redirects signed-in users away from /login, but it can be
// bypassed: Clerk may load after the guard's timeout let the navigation
// through, or the user signs in from another tab while this one sits on the
// login page. Home is always the right destination for a signed-in user.
watch(isSignedIn, (signedIn) => {
  if (signedIn) router.replace('/')
}, { immediate: true })

// The two error shapes that reach this function: Clerk's, which carries an
// `errors` array, and a network failure, which carries none. Structural rather
// than imported — @clerk/types is not a direct dependency — and narrow enough
// that reading a field off it is checked rather than waved through.
interface ClerkErrorLike {
  errors?: { code?: string; message?: string; longMessage?: string }[]
}

// Clerk rejects sign-in attempts with session_exists when a session is
// already active. That is an account-level condition, not an input problem,
// so it gets the app's announcement dialog instead of the inline field error.
function handleSignInError(e: unknown, fallback: string) {
  const clerkErrors = (e as ClerkErrorLike | null | undefined)?.errors
  if (clerkErrors?.some((err) => err.code === 'session_exists')) {
    alreadySignedInOpen.value = true
    return
  }
  // A network failure has no Clerk error array; show a plain offline message
  // rather than the raw "Failed to fetch".
  if (isOfflineError(e) && !clerkErrors?.length) {
    error.value = t('error.offline')
    return
  }
  error.value = clerkErrors?.[0]?.longMessage ?? clerkErrors?.[0]?.message ?? fallback
}

function goToApp() {
  // Full reload so Clerk re-reads the active session before HomeView boots.
  window.location.href = '/'
}

// The tagline's second half is coloured, and which words that is differs per
// language, so the marker travels inside the string. Provider names below
// stay untranslated — they are brands.
const tagline = computed(() => tAccent('login.tagline'))

const oauthProviders = [
  {
    id: 'oauth_google',
    label: 'Google',
    icon: 'brands/google',
  },
  {
    id: 'oauth_apple',
    label: 'Apple',
    icon: 'brands/apple',
  },
  {
    id: 'oauth_microsoft',
    label: 'Microsoft',
    icon: 'brands/microsoft',
  },
]

async function signInWithOAuth(providerId: string) {
  if (!signInLoaded.value || loadingProvider.value) return
  error.value = ''
  loadingProvider.value = providerId

  // Native app: the WebView cannot run OAuth (Google refuses embedded
  // browsers), so the round-trip happens in the system browser and returns
  // through the bagful:// deep link. A null session id means the user
  // closed the browser — quietly re-arm the buttons.
  if (Capacitor.isNativePlatform()) {
    try {
      // Guarded by signInLoaded above, so both resources exist by here.
      const sessionId = await startNativeOAuth(
        signIn.value as unknown as NativeOAuthSignIn,
        signUp.value as unknown as NativeOAuthSignUp,
        providerId,
      )
      if (sessionId) {
        // Reaching here means the session already exists server-side
        // (the attempt completed in the external browser); activating
        // it is client bookkeeping. If Clerk's wrapper still trips
        // over it, don't strand a signed-in user on the login screen:
        // the full reload in goToApp() re-reads the session anyway —
        // a cold restart demonstrably comes back logged in.
        try {
          // toRaw + calling on the instance: both the Vue proxy and
          // a detached method crash on Clerk's private class fields.
          await toRaw(clerk.value)!.setActive({ session: sessionId })
        } catch (activationError) {
          captureException(activationError)
        }
        goToApp()
        return
      }
    } catch (e) {
      // Native OAuth failures are unexpected by definition (user
      // cancellation resolves null instead) — worth a Sentry event
      // (no-op without a DSN). The dialog shows the diagnosis the
      // error carries: which state the attempt got stuck in. A session that
      // already exists is expected (a second tap, a sign-in in another tab)
      // and gets its own dialog, so it is not reported.
      const codes = (e as ClerkErrorLike | null)?.errors?.map((err) => err.code)
      if (!codes?.includes('session_exists')) captureException(e)
      handleSignInError(e, (e as Error)?.message || t('error.oauthFailed'))
    }
    loadingProvider.value = null
    return
  }

  try {
    await signIn.value!.authenticateWithRedirect({
      // The provider list below is the only caller, and every entry in it
      // is a strategy Clerk accepts; @clerk/types is not a direct
      // dependency, so the narrowing happens here rather than at the top.
      strategy: providerId as 'oauth_google' | 'oauth_apple' | 'oauth_microsoft',
      redirectUrl: '/sso-callback',
      redirectUrlComplete: `${window.location.origin}/`,
    })
  } catch (e) {
    handleSignInError(e, t('error.oauthFailed'))
    loadingProvider.value = null
  }
}

async function handleEmailSubmit() {
  if (!signInLoaded.value || loading.value) return
  error.value = ''
  loading.value = true
  try {
    const { supportedFirstFactors } = await signIn.value!.create({
      identifier: email.value,
    })
    const otpFactor = supportedFirstFactors?.find(
      (f) => f.strategy === 'email_code',
    )
    if (!otpFactor) {
      error.value = t('error.noEmailCode')
      return
    }
    await signIn.value!.prepareFirstFactor({
      strategy: 'email_code',
      emailAddressId: otpFactor.emailAddressId,
    })
    digits.value = ['', '', '', '', '', '']
    step.value = 'code'
    await nextTick()
    digitRefs.value[0]?.focus()
  } catch (e) {
    handleSignInError(e, t('error.generic'))
  } finally {
    loading.value = false
  }
}

async function handleCodeSubmit() {
  if (!signInLoaded.value || loading.value) return
  const code = digits.value.join('')
  if (code.length < 6) return
  error.value = ''
  loading.value = true
  try {
    const result = await signIn.value!.attemptFirstFactor({
      strategy: 'email_code',
      code,
    })
    if (result.status === 'complete') {
      window.location.href = '/'
    } else {
      error.value = t('error.verificationIncomplete')
    }
  } catch (e) {
    handleSignInError(e, t('error.invalidCode'))
    digits.value = ['', '', '', '', '', '']
    await nextTick()
    digitRefs.value[0]?.focus()
  } finally {
    loading.value = false
  }
}

function onDigitInput(index: number, event: Event) {
  const val = (event.target as HTMLInputElement).value.replace(/\D/g, '')
  digits.value[index] = val.slice(-1)
  if (val && index < 5) {
    digitRefs.value[index + 1]?.focus()
  }
  if (digits.value.every(d => d !== '')) {
    void handleCodeSubmit()
  }
}

function onDigitKeydown(index: number, event: KeyboardEvent) {
  if (event.key === 'Backspace' && !digits.value[index] && index > 0) {
    digitRefs.value[index - 1]?.focus()
  }
}

function onDigitPaste(event: ClipboardEvent) {
  event.preventDefault()
  const pasted = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6)
  pasted.split('').forEach((ch: string, i: number) => { digits.value[i] = ch })
  const next = Math.min(pasted.length, 5)
  nextTick(() => digitRefs.value[next]?.focus())
  if (pasted.length === 6) void handleCodeSubmit()
}

function goBack() {
  step.value = 'email'
  digits.value = ['', '', '', '', '', '']
  error.value = ''
}
</script>

<template>
  <div class="login-page">
    <AppCard variant="narrow">
      <!-- Brand -->
      <div class="brand">
        <div class="brand-top">
          <img src="/icons/pwa-192.png" :alt="t('login.logoAlt')" class="brand-logo" />
          <!-- <span class="brand-name">Fam<span class="brand-name--accent">Cart</span></span> -->
        </div>
        <!-- The accented half is marked inside the string, so each
                     language can put the emphasis where its own phrasing does. -->
        <p class="brand-tagline">{{ tagline[0]
         }}<span class="brand-tagline--accent">{{ tagline[1] }}</span>{{ tagline[2] }}</p>
      </div>

      <!-- Email form -->
      <form v-if="step === 'email'" @submit.prevent="handleEmailSubmit" class="email-form">
        <InputRow v-model="email" type="email" :aria-label="t('login.emailLabel')" :placeholder="t('login.emailPlaceholder')" autocomplete="email" :loading="loading" required />
      </form>

      <!-- OTP code form -->
      <div v-else class="otp-section">
        <p class="code-hint">{{ t('login.codeHint') }} <strong>{{ email }}</strong></p>
        <!-- One field per digit is a sighted-user affordance; to a screen
                     reader it is six unlabelled boxes unless each says which one
                     it is. The group carries the overall name, the boxes carry
                     their position. -->
        <div
          class="otp-row"
          :class="{ 'otp-row--loading': loading }"
          role="group"
          :aria-label="t('login.codeGroupLabel')"
        >
          <input
            v-for="(_, i) in digits"
            :key="i"
            :aria-label="t('login.digitLabel', { i: i + 1, n: digits.length })"
            :ref="(el) => { if (el) digitRefs[i] = el as HTMLInputElement }"
            v-model="digits[i]"
            type="text"
            inputmode="numeric"
            maxlength="1"
            class="otp-input"
            :disabled="loading"
            autocomplete="one-time-code"
            @input="onDigitInput(i, $event)"
            @keydown="onDigitKeydown(i, $event)"
            @paste="onDigitPaste"
            @focus="($event.target as HTMLInputElement).select()"
          />
        </div>
        <div class="otp-status">
          <span v-if="loading" class="spinner spinner--dark"></span>
        </div>
        <BackButton @click="goBack" />
      </div>

      <!-- Divider -->
      <div class="divider"><span>{{ t('login.or') }}</span></div>

      <!-- OAuth icon buttons -->
      <div class="oauth-row">
        <button v-for="provider in oauthProviders" :key="provider.id" class="oauth-btn"
          :class="{ 'oauth-btn--loading': loadingProvider === provider.id }"
          :disabled="!!loadingProvider"
          :aria-label="provider.label" :title="provider.label" @click="signInWithOAuth(provider.id)">
          <span v-if="loadingProvider === provider.id" class="oauth-spinner"></span>
          <AppIcon v-else class="oauth-icon" :name="provider.icon" />
        </button>
      </div>
    </AppCard>

    <ConfirmModal
      :open="alreadySignedInOpen"
      :title="t('login.alreadyTitle')"
      :message="t('login.alreadyMessage')"
      :confirm-text="t('login.goToList')"
      :show-cancel="false"
      @confirm="goToApp"
      @cancel="goToApp"
    />

    <ErrorModal :title="t('login.errorTitle')" :message="error" @dismiss="error = ''" />
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(1rem + var(--safe-top)) 1rem calc(1rem + var(--safe-bottom));
  position: relative;
  /* The backdrop's gradient runs top-to-bottom, so it must span the full
     height exactly once (no vertical tiling). Size it to the viewport height,
     anchor from the centre, and tile only horizontally to fill wide screens.
     The fill is a fallback behind it. */
  background-color: var(--color-primary-bg);
  background-image: url('/screen.webp');
  background-size: auto 100%;
  background-position: center;
  background-repeat: repeat-x;
}

/* Brand */
.brand {
  text-align: center;
  margin-bottom: 1.75rem;
}

.brand-top {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
}

.brand-logo {
  width: 84px;
  height: 84px;
  object-fit: contain;
}

.brand-name {
  font-family: inherit;
  font-size: var(--text-3xl);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: 1;
}

.brand-name--accent {
  color: var(--color-primary);
}

.brand-tagline {
  font-family: inherit;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin: 0;
  line-height: 1.4;
}

.brand-tagline--accent {
  color: var(--color-primary);
  font-weight: var(--weight-semibold);
}

/* Email form */
.email-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.otp-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.code-hint {
  font-size: var(--text-base);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.otp-row {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.otp-row--loading {
  opacity: 0.55;
}

.otp-input {
  width: 100%;
  aspect-ratio: 1;
  text-align: center;
  font-family: inherit;
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-lg);
  outline: none;
  color: var(--text-primary);
  background: var(--bg-surface);
  transition: border-color var(--transition-fast), background var(--transition-fast);
  caret-color: transparent;
}

.otp-input:focus {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
}

.otp-status {
  min-height: 1.5rem;
  display: flex;
  align-items: center;
}

.spinner--dark {
  border-color: var(--color-primary);
  border-top-color: var(--color-primary);
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
  to {
    transform: rotate(360deg);
  }
}

/* Divider */
.divider {
  display: flex;
  align-items: center;
  margin: 1.25rem 0;
  color: var(--text-disabled);
  font-size: var(--text-xs);
  gap: 0.75rem;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-main);
}

/* OAuth row */
.oauth-row {
  display: flex;
  gap: 0.875rem;
}

.oauth-btn {
  flex: 1;
  height: var(--size-control-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  border: var(--border-width-base) solid var(--border-main);
  border-radius: var(--radius-xl);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  padding: 0;
}

.oauth-btn:hover:not(:disabled) {
  background: var(--bg-main);
  border-color: var(--color-primary);
}

.oauth-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.oauth-btn--loading {
  opacity: 1 !important;
  border-color: var(--color-primary) !important;
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-surface)) !important;
}

.oauth-spinner {
  width: 20px;
  height: 20px;
  border: var(--border-width-thick) solid color-mix(in srgb, var(--color-primary) 20%, var(--bg-surface));
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.oauth-icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.oauth-icon :deep(svg) {
  width: 22px;
  height: 22px;
}
</style>