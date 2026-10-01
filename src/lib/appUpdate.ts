// Keeping the open page on the latest build.
//
// vite-plugin-pwa's injected registerSW.js does one thing: call
// navigator.serviceWorker.register('/sw.js'). With registerType 'autoUpdate' the
// part that makes "auto" mean anything — reloading once the new worker is in
// charge — lives in the virtual:pwa-register module, which this app never
// imports. So a deploy would install in the background, take over immediately
// via skipWaiting/clientsClaim (src/sw.js), and then just sit there: the page on
// screen was already painted from the previous precache, and src/sw.js answers
// navigations out of that precache too, so every ordinary refresh kept serving
// the old build until a cache-bypassing reload. Hence injectRegister: null in
// vite.config.js and this module doing the registering.

const SW_URL = '/sw.js'

// OneSignal owns its own worker under /onesignal/ (see lib/pushNotifications).
// It is not ours to unregister.
const FOREIGN_WORKER_PATH = '/onesignal/'

let reloading = false

function scriptUrlOf(registration: ServiceWorkerRegistration): string {
  const worker = registration.active ?? registration.waiting ?? registration.installing
  return worker?.scriptURL ?? ''
}

// A worker registered on this origin by an earlier production build — a
// `vite preview`, or a dist/ served on the same host and port — outlives the
// build that installed it and keeps answering from its own precache, which
// hides every edit behind the dev server. It cannot even update itself out of
// the way: in dev /sw.js is the SPA fallback, so the browser fetches HTML where
// it expects a script and the update fails. Drop it instead.
function clearStaleDevWorkers(): void {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      Promise.all(
        registrations
          .filter((registration) => !scriptUrlOf(registration).includes(FOREIGN_WORKER_PATH))
          .map((registration) => registration.unregister()),
      ),
    )
    .catch(() => {
      // Nothing to clean up, or the browser refused to say. Either way dev works.
    })
}

function register(): void {
  void navigator.serviceWorker
    .register(SW_URL, { scope: '/' })
    .then((registration) => {
      // Installed to the home screen, the app is resumed for days without a real
      // page load ever happening, so coming back to the foreground is the only
      // dependable moment to go looking for a new deploy.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        // Rejects on its own if the check runs while the page is unloading, or
        // offline. Swallowed here rather than left to surface as an
        // unhandledrejection in the issue stream — the next foreground retries.
        void registration.update().catch(() => {})
      })
    })
    .catch(() => {
      // No worker means no offline shell and no auto-update. The app itself runs
      // fine straight from the network, so there is nothing worth reporting.
    })
}

// Register the service worker and reload the page when a newer one takes over.
// Call once, from main.ts.
export function startAppUpdates(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  if (import.meta.env.DEV) {
    clearStaleDevWorkers()
    return
  }

  // Whether this load was already under a worker's control decides what a
  // controller change means. Uncontrolled is a first install claiming the page:
  // that page came off the network, so it is current and reloading it would only
  // flash. Controlled means a new build has just replaced the one on screen.
  const wasControlled = !!navigator.serviceWorker.controller

  // The reload waits for the page to be hidden. The update check runs as the app
  // comes back to the foreground, so the takeover usually lands while someone is
  // mid-search, and reloading then would throw away what they were typing. The old
  // page keeps working meanwhile; a lazy chunk it no longer finds reloads it
  // through vite:preloadError in main.ts, which is the same reload, only sooner.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return
    reloading = true
    if (document.visibilityState === 'hidden') {
      window.location.reload()
      return
    }
    const reloadWhenHidden = () => {
      if (document.visibilityState !== 'hidden') return
      document.removeEventListener('visibilitychange', reloadWhenHidden)
      window.location.reload()
    }
    document.addEventListener('visibilitychange', reloadWhenHidden)
  })

  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register, { once: true })
  }
}
