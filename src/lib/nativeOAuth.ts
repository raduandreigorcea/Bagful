import { App, type URLOpenListenerEvent } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { toRaw } from 'vue'

// Both constants come from lib/ssoScheme, which owns the one thing that is not
// obvious here: the deep link differs per build channel, because the nightly
// APK is a second installed app and a URL scheme is claimed per app. That
// module also holds the matching half, the forwarding rule the bounce page
// applies on the way back.
//
// Re-exported rather than merely imported: this is the module that documents
// the flow, and every caller and test already reaches for them here.
import { NATIVE_SSO_BOUNCE_URL, NATIVE_SSO_CALLBACK_URL } from './ssoScheme'
export { NATIVE_SSO_CALLBACK_URL, NATIVE_SSO_BOUNCE_URL } from './ssoScheme'

// Closing the browser tab and a successful redirect can fire together (the
// tab dismisses itself as the deep link brings the app forward), so a close
// event only counts as "user gave up" if no callback lands within this grace.
const BROWSER_CLOSE_GRACE_MS = 1500

// The slices of Clerk's SignIn/SignUp resources this flow touches. Structural
// on purpose: tests can hand in plain objects, and the flow documents exactly
// what it depends on.
export interface NativeOAuthSignIn {
  status: string | null
  createdSessionId: string | null
  firstFactorVerification: {
    status: string | null
    externalVerificationRedirectURL: URL | null
  }
  create(params: { strategy: string; redirectUrl: string }): Promise<unknown>
  reload(params?: { rotatingTokenNonce: string }): Promise<unknown>
}

export interface NativeOAuthSignUp {
  status: string | null
  createdSessionId: string | null
  create(params: { transfer: boolean }): Promise<unknown>
}

// OAuth cannot run inside the WebView — Google rejects embedded browsers
// outright — so the native app sends the whole provider round-trip through
// the system browser (a Chrome Custom Tab) and picks the attempt back up
// when Clerk redirects to the bagful:// deep link.
//
// Resolves with a session id to activate, or null when the user closed the
// browser without finishing. Anything else (Clerk errors, an attempt that
// comes back in a state we cannot finish) throws.
export async function startNativeOAuth(
  proxiedSignIn: NativeOAuthSignIn,
  proxiedSignUp: NativeOAuthSignUp,
  strategy: string,
): Promise<string | null> {
  // @clerk/vue stores Clerk's resources in a deep ref, so callers hold
  // reactive Proxies. Clerk's classes use native private fields, and any
  // method invoked with a Proxy as `this` dies with "cannot read private
  // member #…" — unwrap to the real instances before touching them.
  const signIn = toRaw(proxiedSignIn)
  const signUp = toRaw(proxiedSignUp)

  await signIn.create({ strategy, redirectUrl: NATIVE_SSO_BOUNCE_URL })

  const verificationUrl =
    signIn.firstFactorVerification.externalVerificationRedirectURL
  if (!verificationUrl) {
    throw new Error('Clerk returned no verification URL for the OAuth flow.')
  }

  const callbackUrl = await openBrowserAndAwaitCallback(verificationUrl.toString())
  if (callbackUrl === null) return null

  // The nonce ties this WebView's Clerk client to the attempt the external
  // browser just completed; reloading with it pulls the finished state over.
  // Clerk doesn't always issue one — a plain reload still refetches the
  // attempt, which this client owns, so it can pick up the completion too.
  const rotatingTokenNonce = new URL(callbackUrl).searchParams.get(
    'rotating_token_nonce',
  )
  await (rotatingTokenNonce
    ? signIn.reload({ rotatingTokenNonce })
    : signIn.reload())

  if (signIn.status === 'complete') return signIn.createdSessionId

  // A provider account Clerk has never seen parks the sign-in as
  // "transferable": finishing it means converting the attempt into a sign-up.
  if (signIn.firstFactorVerification.status === 'transferable') {
    await signUp.create({ transfer: true })
    if (signUp.status === 'complete') return signUp.createdSessionId
  }

  // The exact stuck state is the difference between "allowlist the redirect
  // URL in Clerk" and a bug here — name it instead of a generic failure.
  throw new Error(
    'Could not finish signing in with that provider ' +
      `(attempt: ${signIn.status ?? 'unknown'}, ` +
      `verification: ${signIn.firstFactorVerification.status ?? 'unknown'}, ` +
      `signup: ${signUp.status ?? 'none'}, ` +
      `nonce: ${rotatingTokenNonce ? 'present' : 'missing'}).`,
  )
}

// Opens the Custom Tab and waits for whichever comes first: the deep-link
// callback (success) or the tab being dismissed (null). Listeners are always
// detached afterwards so an abandoned flow cannot hijack a later one.
async function openBrowserAndAwaitCallback(url: string): Promise<string | null> {
  let finish: (value: string | null) => void = () => {}
  const outcome = new Promise<string | null>((resolve) => {
    finish = resolve
  })

  const urlListener = await App.addListener(
    'appUrlOpen',
    (event: URLOpenListenerEvent) => {
      if (event.url.startsWith(NATIVE_SSO_CALLBACK_URL)) finish(event.url)
    },
  )
  const closedListener = await Browser.addListener('browserFinished', () => {
    // Grace period: if the redirect raced this close event, the promise is
    // already resolved by the time this fires and the null is a no-op.
    setTimeout(() => finish(null), BROWSER_CLOSE_GRACE_MS)
  })

  try {
    await Browser.open({ url })
    return await outcome
  } finally {
    void urlListener.remove()
    void closedListener.remove()
    // Best effort: not every Android browser lets us dismiss the tab
    // programmatically; a leftover tab in the task switcher is harmless.
    Browser.close().catch(() => {})
  }
}
