import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Mirrors the define in vite.config.js. Without it every component that shows
// the version throws "__APP_VERSION__ is not defined" under test, since the
// constant is injected by the bundler rather than existing at runtime.
const appVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version

// Separate from vite.config.js so the PWA plugin doesn't run during unit tests.
// Pure-logic tests run in the default node environment; component tests opt in
// to happy-dom with a `// @vitest-environment happy-dom` docblock per file.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [vue()],
  resolve: {
    // Templates reference public-dir assets by absolute URL (e.g.
    // /icons/pwa-192.png); dev/build serve them from public/, but the test
    // runner has no server, so point the imports at the files directly.
    alias: [{ find: /^\/icons\//, replacement: fileURLToPath(new URL('./public/icons/', import.meta.url)) }],
  },
  test: {
    // The suite describes the shipped app, so it runs as the production
    // channel. Without this it would run as nightly, because lib/appChannel
    // treats DEV as nightly and vitest sets it -- which would quietly flip the
    // version string, the update check and the OAuth scheme under every test
    // that never mentions channels. Cases that want nightly mock IS_NIGHTLY.
    //
    // And every live service is blanked. Vite loads .env in test mode too, so on
    // a machine with one the suite reached the real catalog project from any
    // test that did not mock ../src/supabase (the aborted fetches printed at the
    // end of a run), while CI, which has no .env, did not. Blank here, the suite
    // runs the same everywhere and never talks to anything real.
    env: {
      VITE_APP_CHANNEL: 'production',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_CATALOG_SUPABASE_URL: '',
      VITE_CATALOG_SUPABASE_ANON_KEY: '',
      VITE_CLERK_PUBLISHABLE_KEY: '',
      VITE_SENTRY_DSN: '',
      VITE_ONESIGNAL_APP_ID: '',
      VITE_ONESIGNAL_NIGHTLY_APP_ID: '',
      VITE_POSTHOG_KEY: '',
      VITE_POSTHOG_NIGHTLY_KEY: '',
    },
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
    // A component test that mounts a whole list takes about 2s alone and went
    // past the 5s default under a full parallel run, failing at random. Room for
    // load, not for a test that is actually stuck.
    testTimeout: 15_000,
  },
})
