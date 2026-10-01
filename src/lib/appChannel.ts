// Which build this is, and how the app says so on screen.
//
// Bagful ships from one codebase to two places: the production app, wired to
// the `bagful` Supabase project, and the nightly one, wired to `bagful-dev`.
// Until this module existed the two were pixel-identical, so a screenshot, a
// bug report or a phone left on a desk could not tell you which database it
// had been talking to. Worse, the failure was silent in the dangerous
// direction: a production build accidentally pointing at dev looked exactly
// like the real thing.
//
// So the channel is derived from what the build is actually connected to
// rather than declared, and it is safe by default in both directions. Only the
// exact production project ref, or an explicit `production` override, produces
// an unmarked build. Everything else wears the badge.

export type AppChannel = 'production' | 'nightly'

// The `bagful` project. Public: this ref is half of VITE_SUPABASE_URL, which
// ships in every bundle. Hardcoding it is the point, since the URL it is
// compared against is exactly the thing that might be wrong.
export const PRODUCTION_PROJECT_REF = 'qwpyiperbjaeykrvilhf'

/** The project ref out of a Supabase URL, or '' if it is not one. */
export function projectRefFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.split('.')[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * Pure so it can be tested; the constants below are the one real call.
 *
 * `channel` is VITE_APP_CHANNEL, the escape hatch for builds whose database
 * says nothing useful about them: a Vercel preview of a production-wired
 * branch, or the nightly APK flavour when that arrives.
 */
export function resolveChannel(env: {
  channel?: string
  supabaseUrl?: string
  dev?: boolean
}): AppChannel {
  const override = (env.channel ?? '').trim().toLowerCase()
  if (override) return override === 'production' ? 'production' : 'nightly'
  // The dev server is nightly even when someone has pointed it at production,
  // because an unbuilt, hot-reloading page is never the production app.
  if (env.dev) return 'nightly'
  return projectRefFromUrl(env.supabaseUrl) === PRODUCTION_PROJECT_REF ? 'production' : 'nightly'
}

export const SUPABASE_PROJECT_REF = projectRefFromUrl(import.meta.env.VITE_SUPABASE_URL)

export const APP_CHANNEL: AppChannel = resolveChannel({
  channel: import.meta.env.VITE_APP_CHANNEL,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  dev: import.meta.env.DEV,
})

export const IS_NIGHTLY = APP_CHANNEL === 'nightly'

/**
 * The environment Sentry files a report under.
 *
 * It was the Vite MODE, which cannot tell the two apps apart: the nightly APK is
 * a production-mode build, so every nightly crash was filed as `production`
 * beside the real ones. The channel can. A dev server and the test runner keep
 * their own names, since neither is a build anybody installed.
 *
 * The admin dashboard's Sentry page reads by this tag, `production` on the
 * bagful project and `nightly` plus `development` on bagful-dev
 * (sentryEnvironments in supabase/functions/_shared/services.ts).
 */
export function sentryEnvironment(mode: string, channel: AppChannel): string {
  if (mode === 'development' || mode === 'test') return mode
  return channel
}

/**
 * Stamp the channel on the root element.
 *
 * Nightly repaints nothing: a nightly build that looks different from
 * production makes every design judgement on nightly a judgement about a screen
 * production never draws. The NIGHTLY badge in the desktop header and the
 * `-nightly` version are how a nightly build announces itself. The
 * attribute stays, for devtools and for anything that has to tell the two apart
 * from CSS.
 */
export function applyChannel(): void {
  document.documentElement.setAttribute('data-channel', APP_CHANNEL)
}
