import fs from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Source maps are built and uploaded to Sentry only when an auth token is
// available: locally via .env.sentry-build-plugin (auto-read by the plugin),
// in CI/hosting via the SENTRY_AUTH_TOKEN env var. Builds without a token are
// completely unaffected.
const uploadSourceMaps = !!process.env.SENTRY_AUTH_TOKEN || fs.existsSync('.env.sentry-build-plugin')

// The version shown in Settings -> About, read from package.json at build time
// so bumping the version there is the only step. Inlined as a constant rather
// than imported, so the whole of package.json does not end up in the bundle.
const appVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version

// A worker registered on this origin by a production build — a `vite preview`,
// or dist/ served on the same host and port — outlives the build that installed
// it. It keeps answering navigations from its own precache, so the dev server is
// running and reachable while the browser never sees a line of it: the page it
// serves is built HTML with no /@vite/client in it, so there is no HMR socket
// either. Phones are where this bites, because clearing site data on one is
// buried three menus deep.
//
// The worker cannot fix itself. It re-fetches /sw.js to check for a new version,
// and in dev that path is the SPA fallback — HTML where a script belongs, so the
// update fails and the old worker stays. Serving a real script here is what
// breaks the loop: the browser accepts it, and it removes itself and its caches
// on activation, then reloads whatever tabs it was holding.
const SELF_DESTRUCTING_WORKER = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
    await self.registration.unregister()
    const windows = await self.clients.matchAll({ type: 'window' })
    for (const client of windows) client.navigate(client.url)
  })())
})
`

function devServiceWorkerKillSwitch() {
  return {
    name: 'bagful:dev-sw-kill-switch',
    apply: 'serve',
    configureServer(server) {
      // Registered directly rather than from a returned function, so it runs
      // ahead of Vite's internal middleware — including the SPA fallback that
      // was answering /sw.js with index.html.
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/sw.js') return next()
        res.setHeader('Content-Type', 'application/javascript')
        res.setHeader('Cache-Control', 'no-store')
        res.end(SELF_DESTRUCTING_WORKER)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Deliberately no `server.host`. Binding every interface is what lets a phone
  // on the LAN reach the dev server, and it is also what puts the whole project
  // source in front of everyone else on that network — which on a home network
  // is nobody and in a cafe is everybody. Not a decision to make once, in a file,
  // on behalf of every future `npm run dev`.
  //
  // `npm run dev:host` opts in per session instead, so exposure lasts exactly as
  // long as the phone testing it was for.
  build: {
    // 'hidden' emits the maps for upload without adding sourceMappingURL
    // comments to the bundles; the maps are deleted after upload so they are
    // never deployed or precached.
    sourcemap: uploadSourceMaps ? 'hidden' : false,
  },
  plugins: [
    vue(),
    devServiceWorkerKillSwitch(),
    VitePWA({
      // Custom SW (src/sw.js): precaching that generateSW used to emit.
      // skipWaiting/clientsClaim in the SW mirror the autoUpdate behavior.
      // Push lives on OneSignal's own worker (public/onesignal/), outside
      // this plugin entirely.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      // The injected registerSW.js only registers; the reload that makes
      // 'autoUpdate' actually update a page on screen is not in it. src/lib/
      // appUpdate.ts registers instead and does both — see the note there.
      injectRegister: null,
      includeAssets: ['icons/*.png', 'screen.webp'],
      manifest: {
        name: 'Bagful: Shared Shopping List',
        short_name: 'Bagful',
        description: 'A shared grocery list for everyone you shop with, with live updates.',
        // The manifest stays English, deliberately, even though the app speaks
        // six languages. Localising it means shipping six manifests and
        // swapping <link rel="manifest"> at runtime, which browsers honour
        // inconsistently — and the installed app's name would only change on
        // reinstall anyway. `lang` and `dir` simply declare what this one is.
        lang: 'en',
        dir: 'ltr',
        theme_color: '#4d8c65',
        background_color: '#f5f5f7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Precache the app shell + brand assets so the list opens offline; the
        // navigation fallback lives in src/sw.js (NavigationRoute).
        globPatterns: ['**/*.{js,css,html,svg,png,webp,ico,woff2}'],
        // OneSignal's worker must be fetched fresh by the browser's SW
        // machinery, never served from the app-shell precache.
        globIgnores: ['onesignal/**'],
      },
    }),
    uploadSourceMaps &&
      sentryVitePlugin({
        org: 'famcart',
        project: 'javascript-vue',
        sourcemaps: { filesToDeleteAfterUpload: 'dist/**/*.map' },
      }),
  ],
})
