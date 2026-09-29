import { createApp } from 'vue'
import { clerkPlugin } from '@clerk/vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { startConnectivity } from './lib/connectivity'
import { initPushNotifications } from './lib/pushNotifications'
import { captureEarlyErrors, startErrorReporting } from './lib/errorReporting'
import { startNativeBack } from './lib/nativeBack'
import { startAppUpdates } from './lib/appUpdate'
import { startTheme } from './lib/theme'
import { applyChannel } from './lib/appChannel'
import { startAnalytics } from './lib/analytics'
import { getClerkLocalization, initLocale, whenLocaleReady } from './lib/i18n'

// First statement in the module on purpose: everything below can throw or reject,
// and until the Sentry SDK loads (deferred to idle) nothing else is listening.
// Dropped again as soon as reporting is live — see the call to
// startErrorReporting near the bottom.
const stopEarlyCapture = captureEarlyErrors()

// Begin tracking real connectivity as early as possible so the router's first
// navigation can make a trustworthy offline/online decision.
startConnectivity()

// Register the app's service worker and pick up new deploys. Before push, so a
// worker left over from a previous build is cleared in dev before OneSignal
// starts registering its own alongside it.
startAppUpdates()

// OneSignal push: loads the web SDK (or initializes the native plugin) when a
// VITE_ONESIGNAL_APP_ID is configured; a no-op otherwise.
initPushNotifications()

// A lazy import can fail after a fresh deploy: the running page still asks for
// the old hashed chunk, which no longer exists and 404s to index.html — hence
// "'text/html' is not a valid JavaScript MIME type" and "Unable to preload CSS"
// from Vite's async component/CSS loader. A reload pulls the current manifest.
// Guarded by WHEN the last reload was, not whether there was one: a failure
// right after reloading means the chunk is genuinely broken, not merely stale,
// and reloading again would only loop. A plain one-shot flag did that too, but
// it never reset, so the next deploy in the same tab got no reload at all.
// preventDefault only when reloading: otherwise Vite rethrows, and a broken
// chunk surfaces as an error instead of a route that silently never loads.
const CHUNK_RELOAD_KEY = 'famcart-chunk-reloaded-at'
const CHUNK_RELOAD_WINDOW_MS = 10_000
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0
    if (Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    // Storage blocked: no way to tell a loop from a stale deploy, so do not reload.
    return
  }
  event.preventDefault()
  window.location.reload()
})

// Reading window.localStorage itself throws when the browser blocks site data,
// and a throw up here is a blank page: nothing is mounted yet to say anything.
// Both boot readers below only ask for saved values, so "nothing saved" is an
// honest stand-in, and the app boots in the default theme and language.
const bootStorage: Pick<Storage, 'getItem'> = (() => {
  try {
    return window.localStorage
  } catch {
    return { getItem: () => null }
  }
})()

// Before mount, so the first paint is already the right colour. The key, the
// modes and the resolver live in lib/theme, shared with the settings dialog
// that lets the user change them, and so does following the OS from here on.
startTheme(bootStorage)

// And which build this is, as an attribute on the root. Nothing is repainted
// by it any more; see applyChannel.
applyChannel()

// Same slot, same reason, one difference. The language has to be settled
// before the first view renders, so it is chosen here — but its catalog is a
// lazy chunk, and awaiting a fetch at this point would hold a blank frame
// (nothing is mounted yet and index.html has no static splash markup). So this
// is started and not awaited: the router guard awaits whenLocaleReady(), which
// puts the wait behind AppSplash where there is something to look at.
//
// No user id yet — Clerk has not loaded. lib/locale explains what stands in
// until HomeView reconciles the account's own choice.
void initLocale(bootStorage, navigator.languages)

const app = createApp(App)

// Error monitoring is opt-in on a DSN being present (CI has none, since .env is
// gitignored) and loaded after the app is idle rather than as part of the
// initial download: the SDK is about a third of the JavaScript here.
//
// A local `npm run dev` DOES report, which this comment used to deny. Vite
// loads .env in every mode, so the DSN is there in dev too, and three dev-server
// errors sat in the production issue stream before anyone read the URL tag on
// them. They are told apart by the environment tag now. See lib/errorReporting.
//
// Once it resolves, reporting is live (or there is no DSN and never will be),
// so the stand-in handlers installed at the top hand over. Without this they
// would keep running alongside Sentry's own and report everything twice.
void startErrorReporting(app, router).finally(stopEarlyCapture)

// Product analytics, a no-op without a key for this channel (and always on the
// dev server). The SDK is a lazy chunk; events tracked before it lands queue.
// Who is signed in is handed over from App.vue, once Clerk knows.
void startAnalytics()

// Registered after the locale settles so Clerk's own error copy — the one
// string of Clerk's that the custom sign-in UI surfaces — arrives in the right
// language. whenLocaleReady() is already resolved for English and for every
// boot after the first, so this costs a microtask, not a wait.
void whenLocaleReady().then(() => {
  app.use(clerkPlugin, {
    publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    localization: getClerkLocalization(),
  })
  app.use(router)
  startNativeBack(router)
  app.mount('#app')
})
