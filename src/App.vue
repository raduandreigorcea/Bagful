<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@clerk/vue'
import { isCurrentlyOffline } from './lib/connectivity'
import { captureException } from './lib/errorReporting'
import { identifyAnalytics } from './lib/analytics'
import AppSplash from './components/AppSplash.vue'
import AppButton from './components/AppButton.vue'
import AppToast from './components/AppToast.vue'
import { t } from './lib/i18n'

// The first navigation is async (connectivity check, then Clerk). Show a branded
// splash until it resolves so the app never opens on a blank screen — offline in
// particular, where the guard has real work to do before any route can mount.
const router = useRouter()
const ready = ref(false)
router.isReady().finally(() => { ready.value = true })

// The router guard checks the session only when the user navigates. A session
// that Clerk ends while the app sits open (a token refresh coming back 401)
// would leave the list on screen with every request going out as the
// anonymous role, each one refused. So a sign-out that
// happens here goes to login. Offline is excluded: Clerk cannot verify a
// session without the network, and the offline list must survive that.
const { isLoaded, isSignedIn, userId } = useAuth()
watch([isLoaded, isSignedIn], ([loaded, signedIn]) => {
  if (!loaded || signedIn || isCurrentlyOffline()) return
  if (router.currentRoute.value.meta.requiresAuth) router.replace({ name: 'login' })
})

// Analytics files everything after sign-in under the Clerk id, and a sign-out
// (null) starts a fresh anonymous visitor. Here because App is the one
// component mounted through every route, signed in or not.
watch([isLoaded, userId], ([loaded, id]) => {
  if (loaded) identifyAnalytics(id ?? null)
}, { immediate: true })

// A throw during render unmounts the tree, which without this leaves a white
// page: the one failure mode where the app tells the user nothing at all. Vue
// gives no way to re-render a component that has already failed, so the honest
// offer is a reload rather than a retry button that quietly does nothing.
const crashed = ref(false)

onErrorCaptured((error) => {
  crashed.value = true
  // Reported here rather than left to Sentry's Vue integration, because
  // returning false below stops the error propagating to the global handler
  // that would otherwise have logged it.
  captureException(error)
  return false
})

function reload() {
  window.location.reload()
}
</script>

<template>
  <div v-if="crashed" class="crash">
    <div class="crash__box">
      <img src="/icons/pwa-192.png" alt="" class="crash__logo" />
      <h1 class="crash__title">{{ t('error.genericTitle') }}</h1>
      <p class="crash__text">{{ t('crash.text') }}</p>
      <AppButton variant="primary" @click="reload">{{ t('common.reload') }}</AppButton>
    </div>
  </div>
  <RouterView v-else-if="ready" />
  <AppSplash v-else />
  <AppToast />
</template>

<style scoped>
.crash {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--space-6) + var(--safe-top)) var(--space-5)
    calc(var(--space-6) + var(--safe-bottom));
  background: var(--bg-main);
}

.crash__box {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}

.crash__logo {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-lg);
}

.crash__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-extrabold);
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.crash__text {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-secondary);
}
</style>
