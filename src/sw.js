// Custom service worker (vite-plugin-pwa injectManifest mode). Owns the
// app-shell precache that generateSW used to emit. Push is NOT handled here:
// OneSignal registers its own worker under /onesignal/ (see
// public/onesignal/OneSignalSDKWorker.js), and push events, notification
// display, and clicks all live on that registration.
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { clientsClaim } from 'workbox-core'

// Mirror registerType: 'autoUpdate' — a new SW takes over immediately instead
// of waiting for every tab to close.
self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
// Same-origin build output only; the Supabase and Clerk APIs are cross-origin
// and are never intercepted or cached here.
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// The barcode decoder, kept after the first scan rather than shipped to
// everyone up front.
//
// zxing_reader.wasm is ~1MB and is fetched only by browsers with no native
// BarcodeDetector — which is Safari (so every iPhone), Firefox, and Chrome on
// Windows, but not Chrome on Android and not the APK, where scanning goes
// through ML Kit and this file is never requested at all. It is deliberately
// absent from the precache globPatterns for that reason: adding `wasm` there
// would roughly double a 1MB precache for every visitor, including the ones
// who can never need it, which is the opposite of what the dynamic import in
// lib/barcodeScanner.ts is arranged to avoid.
//
// CacheFirst rather than a network strategy because the file is immutable —
// Vite fingerprints it, so a given URL is one exact build of one pinned
// zxing-wasm version and can never need revalidating. The cost is that the
// FIRST scan on such a browser still needs a connection; every scan after it
// works with no network, which is the case this app is actually built for.
//
// maxEntries: 1 is what keeps that honest across deploys. The name carries a
// content hash, so a version bump asks for a new URL and would otherwise leave
// the previous megabyte cached forever with nothing able to reach it; the
// expiration plugin evicts the old entry when the new one lands. Precached
// assets get this for free from cleanupOutdatedCaches, which is exactly what a
// hand-rolled runtime cache has to supply for itself.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.wasm'),
  new CacheFirst({
    cacheName: 'bagful-wasm',
    plugins: [new ExpirationPlugin({ maxEntries: 1 })],
  }),
)
