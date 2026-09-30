// The deep link an OAuth sign-in comes back through, and which app it reaches.
//
// Two builds are installed side by side (com.bagful.app and
// com.bagful.app.nightly), and a custom URL scheme is claimed per app, not per
// install. If both claimed bagful://, Android would stop the sign-in halfway
// through to ask which Bagful should receive it, and picking wrong drops you
// into the other app's session. So the schemes differ.
//
// The awkward part is the middle of the round trip. Clerk refuses a custom
// scheme as a redirect target for a web-mode client, so the browser is sent to
// /sso-native on the deployed site, and that page forwards to the deep link.
// That page is served by the PRODUCTION deployment whichever app started the
// flow, so it cannot read its own channel to decide where to hand back. The
// app therefore marks the bounce URL on the way out, and the page reads the
// mark on the way back. Anything unmarked belongs to production, which is both
// the old behaviour and the safe guess.
//
// Keep in sync with the ${ssoScheme} manifest placeholder in
// android/app/build.gradle, which is where each flavour declares what it
// answers to.

import { IS_NIGHTLY } from './appChannel'

export const PRODUCTION_SSO_SCHEME = 'bagful'
const NIGHTLY_SSO_SCHEME = 'bagfulnightly'

// Appended to the bounce URL by the nightly build. Clerk adds its own
// parameters after it, so this stays a leading '?' and everything else arrives
// as '&...'.
export const NIGHTLY_BOUNCE_QUERY = '?app=nightly'

const BOUNCE_BASE_URL = 'https://famcart-app.vercel.app/sso-native'

/** The scheme this build answers to. */
const NATIVE_SSO_SCHEME = IS_NIGHTLY ? NIGHTLY_SSO_SCHEME : PRODUCTION_SSO_SCHEME

/** The deep link this build listens for. */
export const NATIVE_SSO_CALLBACK_URL = `${NATIVE_SSO_SCHEME}://sso-callback`

/**
 * What Clerk is told to redirect to. Allowlisted in Clerk under Native
 * applications; the nightly variant carries the query above, so if Clerk ever
 * matches allowlist entries strictly it is the nightly sign-in that fails and
 * production is untouched.
 */
export const NATIVE_SSO_BOUNCE_URL = IS_NIGHTLY
  ? `${BOUNCE_BASE_URL}${NIGHTLY_BOUNCE_QUERY}`
  : BOUNCE_BASE_URL

/**
 * The deep link to forward a finished sign-in to, given the bounce page's own
 * query string. The query is passed through whole, Clerk's parameters and the
 * app marker alike: the receiving app reads what it needs and ignores the rest.
 */
export function ssoCallbackUrlFromBounceQuery(search: string): string {
  const app = new URLSearchParams(search).get('app')
  const scheme = app === 'nightly' ? NIGHTLY_SSO_SCHEME : PRODUCTION_SSO_SCHEME
  return `${scheme}://sso-callback${search}`
}
