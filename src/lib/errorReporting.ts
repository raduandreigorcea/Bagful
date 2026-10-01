// Error reporting, kept out of the initial download.
//
// @sentry/vue is ~218 KB — about a third of the app's JavaScript — and imported
// at module scope in main.ts, every cold start would pay for it before the
// first item could be rendered. On a grocery list opened on a phone in a
// shop, that is the wrong thing to spend a connection on.
//
// So the SDK is loaded after the app is up and idle, and everything that wants
// to report an error talks to this module instead of importing Sentry directly.
// Reports raised before it lands are buffered and flushed on arrival.
//
// The cost, stated plainly: the initial pageload transaction is not
// traced, because tracing has to be installed before the load it measures. At a
// 10% trace sample rate that is a small loss against a third of the bundle, but
// it is a loss rather than a free win.

import type { App } from 'vue'
import type { Router } from 'vue-router'
// The same deferral the OneSignal web SDK uses. Shared rather than copied so
// "after the app is up" cannot come to mean two different things.
import { whenIdle } from './idle'
// Read once per event in beforeSend, to tell an expected offline failure from
// the same failure happening to someone who has a connection. Safe to import
// here: connectivity depends on vue and @capacitor/network only, so this is not
// a cycle.
import { isCurrentlyOffline } from './connectivity'
import { APP_CHANNEL, sentryEnvironment } from './appChannel'

// Only the one function is held, never the module namespace. Keeping the
// namespace alive (`sentry = module`) forces the bundler to retain every export
// the SDK has, because any of them might be reached through it — which turned
// the lazy chunk into 444 KB against the 142 KB the static import had been
// tree-shaken down to. Naming the three exports used is what lets that shaking
// still happen across a dynamic import.
let capture: ((error: unknown) => void) | null = null
// Held separately from `capture` for the same reason: naming the export is what
// lets the bundler shake the rest of the SDK across the dynamic import.
// Returns the event id it assigned, which is the handle the delivery check
// below waits on. Declared here rather than inferred, so the id cannot be
// quietly dropped again.
let sendFeedback:
  | ((params: {
      message: string
      name?: string
      tags?: Record<string, string>
    }) => string | undefined)
  | null = null
// Named for the same reason as the two above: reaching setUser through the
// module namespace would pin the whole SDK against the dynamic import.
let setUser: ((user: { id: string } | null) => void) | null = null
let loading: Promise<void> | null = null

// Who is signed in, held until there is an SDK to tell.
//
// Clerk resolves the session during boot, which is comfortably before the
// idle-deferred SDK lands, so an identity set at the natural moment would
// otherwise be thrown away. One slot rather than a queue: only the latest
// answer means anything, and `null` (signed out) is one of the answers.
let identity: { id: string } | null = null

// Reports waiting to hear whether they actually arrived, keyed by the event id
// captureFeedback handed back. Filled by captureReport, drained by the
// afterSendEvent hook installed at init.
const awaitingDelivery = new Map<string, (delivered: boolean) => void>()

// Whether that hook is installed, i.e. whether we are in a position to tell a
// delivered report from a lost one at all. Until it is, captureReport has no
// answer to give and says so by trusting the handoff.
let deliveryObserved = false

// How long a report waits for that answer. The request carries `keepalive` and
// is one small POST, so a working connection settles it in well under a second;
// this is the ceiling before we call it lost. Erring towards "it failed" is
// deliberate — a duplicate report in the inbox costs nothing, and a person told
// their report went when it did not is waiting on an answer that never comes.
const DELIVERY_TIMEOUT_MS = 5000

// Bounded on purpose. Without a DSN (local dev, CI, tests) the SDK never loads
// and this queue is the only thing holding the reports, so it must not become a
// leak in a long session.
const MAX_BUFFERED = 20
const buffered: unknown[] = []

// The one way the rest of the app reports an error. Safe before, during and
// after loading, and a no-op in an environment with no DSN.
export function captureException(error: unknown): void {
  if (capture) {
    capture(error)
    return
  }
  if (buffered.length < MAX_BUFFERED) buffered.push(error)
}

// Attach (or drop) the signed-in account, so a crash can say how many people it
// reached rather than "Users: 0".
//
// That zero was not a quiet cosmetic gap. It is what Sentry sorts, alerts and
// triages on, so with nothing set every issue looked equally unimportant and an
// error hitting the whole list was indistinguishable from one hitting a
// single old phone.
//
// Only the opaque Clerk id travels. No email, no name: the id is enough to tell
// two people apart and to look an account up when a report needs chasing, which
// is the whole job. Safe before, during and after the SDK load.
export function identifyUser(userId: string | null): void {
  identity = userId ? { id: userId } : null
  if (setUser) setUser(identity)
}

// Wait for the afterSendEvent hook to say what became of one report.
function waitForDelivery(eventId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (delivered: boolean) => {
      clearTimeout(timer)
      awaitingDelivery.delete(eventId)
      resolve(delivered)
    }
    const timer = setTimeout(() => settle(false), DELIVERY_TIMEOUT_MS)
    awaitingDelivery.set(eventId, settle)
  })
}

// A report someone typed, sent as Sentry feedback rather than as a message.
//
// The distinction matters more than it looks. captureMessage groups by message
// text, so reports would have collapsed into one issue per kind and place —
// every new one arriving as another event on an issue that had already been
// triaged, which is precisely how a report goes unread. Feedback lands in its
// own inbox, one entry per report, which is what this is.
//
// Unlike captureException it does NOT buffer, and it reports whether it
// arrived. An error raised into the void is still worth queueing, because
// nobody is waiting on the answer; a person who pressed "Send report" is, and
// telling them it went when it did not is worse than telling them it didn't.
// It waits on the SDK's idle-time load rather than racing it, since a report is
// almost always raised long after boot.
export async function captureReport(
  message: string,
  meta: Record<string, unknown>,
): Promise<boolean> {
  if (loading) await loading
  if (!sendFeedback) return false

  // The message travels verbatim: it is the person's own words and the one
  // thing in here nobody else could have written. Everything the app worked out
  // for itself becomes a tag, so the inbox can be filtered by it.
  const { userId, ...tagged } = meta
  const tags: Record<string, string> = { report: 'user' }
  for (const [key, value] of Object.entries(tagged)) {
    if (value !== '' && value !== undefined && value !== null) tags[key] = String(value)
  }

  const eventId = sendFeedback({
    message,
    // Sentry's inbox shows this as who reported it. An opaque Clerk id is not
    // a name, but it is what lets a report be traced back to an account.
    name: typeof userId === 'string' && userId ? userId : undefined,
    tags,
  })

  // No id means the SDK declined to capture it, so there is nothing in flight
  // to wait for.
  if (!eventId) return false
  // Nothing is watching deliveries, so there is no answer to be had. Trust the
  // handoff rather than inventing a failure: this is the branch an SDK that
  // stopped exposing a client would take, not a broken send.
  if (!deliveryObserved) return true
  return waitForDelivery(eventId)
}

function flush(): void {
  if (!capture) return
  for (const error of buffered) capture(error)
  buffered.length = 0
}

// Stand-in global handlers for the window before the SDK lands.
//
// Sentry installs its own onerror/onunhandledrejection hooks inside init(),
// which is deliberately deferred to idle (see above). Until then nothing is
// listening: a Vue render error still reaches captureException through App.vue's
// onErrorCaptured, but a plain unhandled rejection simply vanishes — and this
// codebase has many fire-and-forget `void someAsync()` calls that produce
// exactly those. On a fast machine that window is milliseconds; on a slow phone
// it is the full idle timeout, which is precisely the boot window the router
// guard, the Clerk load and the first fetches occupy.
//
// These feed the same buffer everything else uses, so a report raised here is
// flushed to Sentry the moment it arrives. Returns an unregister function: the
// caller drops them once reporting is live, so nothing is reported twice.
export function captureEarlyErrors(): () => void {
  if (typeof window === 'undefined') return () => {}

  // event.error is absent for resource-load failures (a 404 on an <img> raises
  // an 'error' event too). Those are not exceptions and would only add noise.
  const onError = (event: ErrorEvent) => {
    if (event.error) captureException(event.error)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    captureException(event.reason)
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

// The narrow view of a Sentry event this module reads. Declared rather than
// imported from the SDK, because importing a type from @sentry/vue at module
// scope is exactly the static reference the lazy load exists to avoid.
export interface ReportableEvent {
  exception?: { values?: Array<{ type?: string; value?: string }> }
}

// Whether an event is Clerk failing to fetch its UI bundle with no network.
//
// `app.use(clerkPlugin, ...)` in main.ts returns before Clerk's remote script
// has loaded, so a failure arrives as an unhandled rejection that no call site
// is in a position to catch. Offline that is not a fault to fix: the app has an
// offline route it deliberately boots into, and a script that cannot be fetched
// with no connection is the expected outcome. It was reported five times from
// one phone sitting on /offline.
//
// Online it is the opposite and must survive: a real user on an old WebView hit
// this with a working connection, and for them it means sign-in is impossible.
// So the filter is on the connection, not on Clerk, which is why this takes
// `offline` as an argument instead of reading it, and why both directions are
// tested.
export function isExpectedOfflineFailure(event: ReportableEvent, offline: boolean): boolean {
  if (!offline) return false
  // Matched on the message rather than the type: the class name arrives
  // minified ("e"), and the message carries the URL in one variant and the
  // code in the other, so a substring is the only stable handle.
  return (event.exception?.values ?? []).some((value) =>
    (value.value ?? '').includes('Failed to load Clerk UI'),
  )
}

// Called once from main.ts. Resolves when reporting is live, which tests use;
// nothing in the app awaits it.
export function startErrorReporting(app: App, router: Router): Promise<void> {
  if (loading) return loading
  const dsn = import.meta.env.VITE_SENTRY_DSN
  // No DSN means no reporting at all, and captureException stays a cheap no-op
  // that never pulls the SDK in. That is CI's path, where the gitignored .env
  // does not exist.
  //
  // It is NOT the path a local `npm run dev` takes, though this comment claimed
  // it was: Vite loads .env in every mode, so a developer's machine has a real
  // DSN in dev and under vitest alike. Three issues in the production stream
  // turned out to be a dev server on the LAN before anyone noticed. What keeps
  // those apart now is the environment tag below, not the absence of a DSN.
  if (!dsn) {
    loading = Promise.resolve()
    return loading
  }

  loading = new Promise<void>((resolve) => {
    whenIdle(() => {
      void import('@sentry/vue')
        .then(({
          init,
          captureException: sentryCapture,
          captureFeedback: sentryCaptureFeedback,
          setUser: sentrySetUser,
          getClient,
          browserTracingIntegration,
        }) => {
          init({
            app,
            dsn,
            // Sentry defaults this to 'production' when it is not given, which
            // is how three errors raised against a Vite dev server on the LAN
            // ended up in the production issue stream claiming to be production.
            // MODE is the build's own answer: 'production' for a build,
            // 'development' under `npm run dev`, 'test' under vitest.
            // And MODE alone was not enough either: the nightly APK is a
            // production-mode build, so it filed as production too. See
            // sentryEnvironment in lib/appChannel.
            environment: sentryEnvironment(import.meta.env.MODE, APP_CHANNEL),
            integrations: [browserTracingIntegration({ router })],
            tracesSampleRate: 0.1,
            // A fetch/websocket aborted because the user navigated mid-request
            // (e.g. Clerk during a login redirect) is expected teardown, not a
            // fault we can act on. Keep it out of the issue stream.
            ignoreErrors: ['AbortError: The connection was closed.'],
            // Same idea as ignoreErrors above, but it cannot be expressed there:
            // whether Clerk failing to load is news depends on the connection at
            // the time, not on the message. See isExpectedOfflineFailure.
            // `event` is left to infer Sentry's own ErrorEvent from this
            // position: annotating it as ReportableEvent would narrow the
            // return type too, and beforeSend must hand back the event it was
            // given. ReportableEvent stays the shape the exported predicate
            // asks for, so nothing here needs a type imported from the SDK.
            beforeSend: (event) =>
              isExpectedOfflineFailure(event, isCurrentlyOffline()) ? null : event,
          })
          capture = sentryCapture
          sendFeedback = sentryCaptureFeedback
          setUser = sentrySetUser
          // The only place the fate of a sent report is observable.
          //
          // captureFeedback hands the envelope to the transport and returns an
          // id; the POST happens after, and the client swallows a transport
          // failure whole — sendEnvelope catches it and hands back an empty
          // response. So a report eaten by an ad blocker looks identical to a
          // delivered one from the call site, which is how reports sent from a
          // browser were lost while the dialog said they had been sent.
          // (Sentry's ingest host is on EasyPrivacy, so every blocker drops it.)
          //
          // afterSendEvent still fires in that case, just with no statusCode.
          // That absence is the whole signal. flush() cannot stand in for it:
          // it drains with allSettled and resolves true for a request that
          // failed.
          const client = getClient()
          if (client) {
            deliveryObserved = true
            client.on('afterSendEvent', (event, response) => {
              const settle = event.event_id && awaitingDelivery.get(event.event_id)
              if (!settle) return
              const status = response?.statusCode
              settle(status !== undefined && status < 400)
            })
          }
          // Clerk almost always resolves the session before this point, so an
          // identity taken during boot is waiting here rather than arriving
          // later. Only sent when there is one: setUser(null) on a fresh SDK
          // would be a write saying nothing.
          if (identity) sentrySetUser(identity)
          flush()
        })
        .catch(() => {
          // The SDK failed to download. Reporting is the one feature allowed to
          // fail silently — surfacing it would be an error about errors.
        })
        .finally(resolve)
    })
  })

  return loading
}
