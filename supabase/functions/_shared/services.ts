// What the admin dashboard may ask of Sentry, OneSignal, Clerk and PostHog, and what it
// gets back.
//
// The dashboard is a plain SPA and holds no secret, on purpose (admin's
// .env.example says why). These three services only answer to a secret key, so
// admin-services/index.ts holds the keys and asks on the dashboard's behalf,
// once the caller has proved to be an admin. This file is the part of that
// which is decisions rather than wiring -- which requests exist, which secrets
// each one needs, and how a vendor's payload is cut down to the fields a page
// renders -- and it uses no Deno API, so test/services.test.js runs it as is.
// Same split as push.ts beside it.
//
// Cutting the payloads down is not tidiness. A Clerk user object carries
// private metadata and every address the person ever added; a Sentry issue
// carries stack context. The browser gets what the page shows and no more.

export type Service = 'sentry' | 'onesignal' | 'clerk' | 'posthog'

export type ServiceRequest =
  | { service: 'sentry'; view: 'issues' | 'feedback' }
  | { service: 'onesignal'; view: 'notifications' }
  | { service: 'onesignal'; view: 'subscribers'; userIds: string[] }
  | { service: 'clerk'; view: 'summary' }
  | { service: 'clerk'; view: 'user'; userId: string }
  | { service: 'posthog'; view: 'activity' }
  | { service: 'posthog'; view: 'recordings' }
  | { service: 'posthog'; view: 'replayers'; userIds: string[] }
  | { service: 'clerk'; view: 'search'; query: string }
  | { service: 'clerk'; view: 'banned' }
  | ServiceAction

/**
 * Things the dashboard can DO, as opposed to read. Kept apart from the reads
 * because they need more than a read key (Sentry) and because index.ts refuses
 * the ones that would hurt the caller (banning or impersonating yourself).
 */
export type ServiceAction =
  // A ban or an unban is ONE operation across both doors: Clerk and Bagful's own
  // profile flag (see admin-services). `reason` is the audit text for the Bagful half.
  | { service: 'clerk'; action: 'ban' | 'unban' | 'revoke_sessions' | 'impersonate'; userId: string; reason?: string }
  | { service: 'sentry'; action: 'resolve' | 'ignore' | 'unresolve'; issueId: string }
  // No userId means "the caller": a test push to your own phone.
  | { service: 'onesignal'; action: 'test_push'; userId?: string }

// The Sentry project the app reports to. The same two strings vite.config.js
// uploads source maps under, so they are constants rather than two more secrets.
// The project is shared by every build, so both app databases read the same
// issues.
export const SENTRY_ORG = 'bagful'
export const SENTRY_PROJECT = 'javascript-vue'

// THE EU REGION, NOT sentry.io. The bagful organisation's data lives in
// Sentry's EU region (its DSN ingests at ingest.de.sentry.io, and an org token
// says region_url https://de.sentry.io). An organisation token carries that
// region and sentry.io routes it; a personal token does not, and sentry.io then
// answers 404 for the organisation's projects and issues -- which is what the
// admin Health page showed as "Sentry answered 404". The region host answers
// both kinds, so it is what is asked.
export const SENTRY_API = 'https://de.sentry.io/api/0'

/** What writing to Sentry needs, apart from SENTRY_READ_TOKEN: a token with event:admin. */
export const SENTRY_WRITE_SECRET = 'SENTRY_WRITE_TOKEN'

/**
 * Who may use the Clerk actions and the Clerk-wide search: a comma-separated list of Clerk ids.
 *
 * is_admin() is per project, but the Clerk key is one instance for every project. Without
 * this list an admin of bagful-dev, which is easy to grant, could impersonate, ban or sign
 * out an admin of bagful-prod, and read every account's email. Unset means nobody may.
 */
export const CLERK_OWNERS_SECRET = 'CLERK_ACTION_ADMINS'

const SECRETS: Record<Service, string[]> = {
  // A token with event:read and project:read. The build's SENTRY_AUTH_TOKEN is
  // not it: that one is scoped to uploading source maps and gets 403 here.
  sentry: ['SENTRY_READ_TOKEN'],
  // The same two push-on-item-insert already uses.
  onesignal: ['ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY'],
  clerk: ['CLERK_SECRET_KEY'],
  // A personal API key with the query:read scope, nothing else.
  posthog: ['POSTHOG_PERSONAL_API_KEY'],
}

// The dashboard is a local tool (admin/, `npm run dev` on port 5174), so only
// its dev server may read these answers from a browser. Not the gate, which is
// is_admin(): a request from anywhere else still needs an admin's token.
export const ADMIN_ORIGINS = ['http://localhost:5174', 'http://127.0.0.1:5174']

/** CORS headers for a request from `origin`, allowing it only if it is the dashboard's. */
export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': origin && ADMIN_ORIGINS.includes(origin) ? origin : ADMIN_ORIGINS[0]!,
    vary: 'origin',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  }
}

// A Clerk user id. Checked because it is spliced into a URL path.
const CLERK_USER_ID = /^user_[A-Za-z0-9]{10,64}$/
// A Sentry issue id: digits, and spliced into a query string.
const SENTRY_ISSUE_ID = /^\d{1,20}$/

/** The request, or null for anything this function does not answer. */
export function parseRequest(body: unknown): ServiceRequest | null {
  if (!body || typeof body !== 'object') return null
  const { service, view, userId } = body as Record<string, unknown>
  if (service === 'sentry' && (view === 'issues' || view === 'feedback')) return { service, view }
  if (service === 'onesignal' && view === 'notifications') return { service, view }
  if (service === 'clerk' && (view === 'summary' || view === 'banned')) return { service, view }
  if (service === 'posthog' && view === 'activity') return { service, view }
  if (service === 'clerk' && view === 'user' && typeof userId === 'string' && CLERK_USER_ID.test(userId)) {
    return { service, view, userId }
  }
  if (service === 'posthog' && view === 'recordings') return { service, view }
  const { userIds } = body as Record<string, unknown>
  if ((view === 'subscribers' && service === 'onesignal' || view === 'replayers' && service === 'posthog') && Array.isArray(userIds)) {
    // One lookup per id, so the count is capped: a page of the Users table is 25.
    const ids = [...new Set(userIds)]
    if (ids.length > 0 && ids.length <= SUBSCRIBER_LOOKUP_MAX && ids.every((id) => typeof id === 'string' && CLERK_USER_ID.test(id))) {
      return { service, view, userIds: ids as string[] } as ServiceRequest
    }
    return null
  }
  const { query, action, issueId, reason } = body as Record<string, unknown>
  if (service === 'clerk' && view === 'search' && typeof query === 'string') {
    const trimmed = query.trim().slice(0, 100)
    return trimmed ? { service, view, query: trimmed } : null
  }
  if (service === 'clerk' && typeof userId === 'string' && CLERK_USER_ID.test(userId)) {
    if (action === 'ban' || action === 'unban' || action === 'revoke_sessions' || action === 'impersonate') {
      // Only a ban carries a reason, trimmed and capped: it goes into the audit trail.
      return action === 'ban' && typeof reason === 'string' && reason.trim()
        ? { service, action, userId, reason: reason.trim().slice(0, 300) }
        : { service, action, userId }
    }
  }
  if (service === 'sentry' && typeof issueId === 'string' && SENTRY_ISSUE_ID.test(issueId)) {
    if (action === 'resolve' || action === 'ignore' || action === 'unresolve') return { service, action, issueId }
  }
  if (service === 'onesignal' && action === 'test_push') {
    if (userId === undefined) return { service, action }
    if (typeof userId === 'string' && CLERK_USER_ID.test(userId)) return { service, action, userId }
  }
  return null
}

/** The Clerk requests that reach beyond this project's own people: every action, and the search. */
export function needsOwner(request: ServiceRequest): boolean {
  return request.service === 'clerk' && (isAction(request) || ('view' in request && (request.view === 'search' || request.view === 'banned')))
}

/** True for a request that changes something somewhere. */
export function isAction(request: ServiceRequest): request is ServiceAction {
  return 'action' in request
}

/** The secrets a service needs that this project does not have. */
export function missingSecrets(
  service: Service,
  read: (name: string) => string | undefined,
  request?: ServiceRequest,
): string[] {
  const needed = [...SECRETS[service]]
  // Resolving an issue is a write, and the read token must not be able to.
  if (service === 'sentry' && request && isAction(request)) needed.push(SENTRY_WRITE_SECRET)
  if (service === 'clerk' && request && needsOwner(request)) needed.push(CLERK_OWNERS_SECRET)
  return needed.filter((name) => !read(name))
}

/** A vendor answered, and not with what was asked for. */
/** What was asked, and what the vendor said about it, for the message. */
export interface UpstreamContext {
  /** The URL's path. The query is dropped: it is not needed and can carry more. */
  path?: string
  /** The vendor's own explanation, from the error body when it sends one. */
  detail?: string
}

export class UpstreamError extends Error {
  constructor(
    readonly service: Service,
    readonly status: number,
    context: UpstreamContext = {},
  ) {
    super(upstreamMessage(service, status, context))
  }
}

const SERVICE_NAMES: Record<Service, string> = { sentry: 'Sentry', onesignal: 'OneSignal', clerk: 'Clerk', posthog: 'PostHog' }

export function upstreamMessage(service: Service, status: number, context: UpstreamContext = {}): string {
  const name = SERVICE_NAMES[service]
  // "Sentry answered 404" was all a 404 ever said, and it did not say which of
  // two requests had failed or why. The path and the vendor's words do.
  const path = context.path?.split('?')[0]
  const said = [path ? `for ${path}` : '', context.detail ? `: ${context.detail.slice(0, 200)}` : ''].join('')
  if (status === 401 || status === 403) {
    return `${name} refused the key this project holds (${status}). It is wrong, revoked, or missing a scope.`
  }
  if (status === 429) return `${name} is rate limiting this key (429). Try again in a minute.`
  if (status >= 500) return `${name} is failing on its side (${status}).`
  return `${name} answered ${status}${said ? ` ${said}` : ''}.`
}

// ─── Sentry ──────────────────────────────────────────────────────────────────

/**
 * The issues endpoint, for one view.
 *
 * Feedback deliberately has no status filter. Sentry archives feedback it
 * judges to be spam on its own, and an archived report is invisible in the
 * default inbox, so the page lists every status and says which one each is in.
 */
export function sentryIssuesUrl(
  projectId: string,
  view: 'issues' | 'feedback',
  environments: string[],
): string {
  const params = new URLSearchParams({
    project: projectId,
    limit: '50',
    sort: 'date',
    statsPeriod: view === 'issues' ? '14d' : '90d',
    query: view === 'issues' ? 'is:unresolved issue.category:error' : 'issue.category:feedback',
  })
  for (const environment of environments) params.append('environment', environment)
  return `${SENTRY_API}/organizations/${SENTRY_ORG}/issues/?${params}`
}

// The `bagful` project. The same public ref src/lib/appChannel.ts compares
// against, and for the same reason: it is what production IS.
export const PRODUCTION_PROJECT_REF = 'qwpyiperbjaeykrvilhf'

/**
 * Which Sentry environments belong to the project this function runs on.
 *
 * One Sentry project takes reports from every build, told apart by the
 * environment tag src/lib/errorReporting.ts sets from the app's channel. So the
 * production database reads `production` only, and bagful-dev reads what is
 * wired to it: the nightly builds and a local `npm run dev`. Reports sent before
 * the tag followed the channel say `production` whatever sent them.
 */
export function sentryEnvironments(supabaseUrl: string | undefined): string[] {
  const ref = (supabaseUrl ?? '').replace(/^https:\/\//, '').split('.')[0]
  return ref === PRODUCTION_PROJECT_REF ? ['production'] : ['nightly', 'development']
}

/** The environments the project has ever received an event in. */
export function sentryEnvironmentsUrl(): string {
  return `${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/environments/`
}

/**
 * The wanted environments that Sentry actually knows.
 *
 * NOT A FILTER FOR TIDINESS. Sentry's issues endpoint answers 404, "The requested
 * resource does not exist", when ANY environment it is asked for has never
 * received an event -- and a new channel's environment has not: `nightly` was
 * added on 2026-09-15, and bagful-dev's Sentry line on the admin Health page
 * failed on it until this existed. An empty result means none of them has seen
 * an event, whose true answer is no issues rather than an error.
 */
export function knownEnvironments(wanted: string[], known: unknown[]): string[] {
  const names = new Set(
    known
      .map((row) => (row && typeof row === 'object' ? (row as Raw).name : null))
      .filter((name): name is string => typeof name === 'string'),
  )
  return wanted.filter((name) => names.has(name))
}

export function sentryProjectUrl(): string {
  return `${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/`
}

type Raw = Record<string, unknown>

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

export interface SentryIssue {
  id: string
  shortId: string
  title: string
  culprit: string | null
  level: string
  events: number
  users: number
  firstSeen: string
  lastSeen: string
  url: string
}

export function shapeSentryIssue(raw: Raw): SentryIssue {
  return {
    id: String(raw.id),
    shortId: str(raw.shortId) ?? String(raw.id),
    title: str(raw.title) ?? '(untitled)',
    culprit: str(raw.culprit),
    level: str(raw.level) ?? 'error',
    // Sentry sends the event count as a string and the user count as a number.
    events: num(raw.count),
    users: num(raw.userCount),
    firstSeen: String(raw.firstSeen),
    lastSeen: String(raw.lastSeen),
    url: String(raw.permalink),
  }
}

export interface SentryFeedback {
  id: string
  shortId: string
  message: string
  name: string | null
  email: string | null
  /** unresolved, resolved or ignored; ignored is what Sentry calls archived. */
  status: string
  at: string
  url: string
}

export function shapeSentryFeedback(raw: Raw): SentryFeedback {
  const meta = (raw.metadata ?? {}) as Raw
  return {
    id: String(raw.id),
    shortId: str(raw.shortId) ?? String(raw.id),
    message: str(meta.message) ?? str(raw.title) ?? '',
    name: str(meta.name),
    email: str(meta.contact_email),
    status: str(raw.status) ?? 'unresolved',
    at: String(raw.firstSeen),
    url: String(raw.permalink),
  }
}

// ─── OneSignal ───────────────────────────────────────────────────────────────

/** The newest notifications first; 50 is the most the endpoint returns. */
export function oneSignalNotificationsUrl(appId: string): string {
  return `https://api.onesignal.com/notifications?${new URLSearchParams({ app_id: appId, limit: '50' })}`
}

/** The most people one subscribers request may ask about: it is one OneSignal call each. */
export const SUBSCRIBER_LOOKUP_MAX = 50

/** One person's OneSignal record, by the Clerk id the app signs their devices in with. */
export function oneSignalUserUrl(appId: string, userId: string): string {
  return `https://api.onesignal.com/apps/${appId}/users/by/external_id/${encodeURIComponent(userId)}`
}

export interface PushDevice {
  /** Android, iOS, Chrome, Firefox, Safari: where the subscription lives. */
  kind: string
  /** OneSignal's `enabled`: false means unsubscribed (uninstalled, data cleared, or notifications off). */
  enabled: boolean
  model: string | null
  os: string | null
  appVersion: string | null
}

export interface PushSubscriber {
  userId: string
  /**
   * on: at least one device is subscribed. off: devices exist and none is.
   * none: OneSignal has no push device for this person, which is also what a
   * person who never opened the app on a phone looks like.
   */
  state: 'on' | 'off' | 'none'
  devices: PushDevice[]
  lastActive: string | null
}

// OneSignal's subscription types end in Push for the channels that are push;
// Email and SMS subscriptions on the same person are not this page's business.
const deviceKind = (type: string): string => type.replace(/Push$/, '')

/** `raw` is OneSignal's user, or null when it has never heard of this id (a 404). */
export function shapeSubscriber(userId: string, raw: Raw | null): PushSubscriber {
  const subscriptions = Array.isArray(raw?.subscriptions) ? (raw!.subscriptions as Raw[]) : []
  const devices = subscriptions
    .filter((sub) => typeof sub.type === 'string' && (sub.type as string).endsWith('Push'))
    .map((sub) => ({
      kind: deviceKind(sub.type as string),
      enabled: sub.enabled === true,
      model: str(sub.device_model),
      os: str(sub.device_os),
      appVersion: str(sub.app_version),
    }))
  const state = devices.length === 0 ? 'none' : devices.some((d) => d.enabled) ? 'on' : 'off'
  const properties = (raw?.properties ?? {}) as Record<string, unknown>
  return { userId, state, devices, lastActive: unixToIso(properties.last_active) }
}

export interface PushNotification {
  id: string
  text: string
  /** When it finished sending, or was queued if it has not. */
  at: string | null
  delivered: number
  /** Devices that had unsubscribed: gone, rather than broken. */
  unsubscribed: number
  /** Deliveries that failed for a reason OneSignal counts as an error. */
  errored: number
  remaining: number
  canceled: boolean
}

const unixToIso = (value: unknown): string | null => {
  const n = num(value)
  return n > 0 ? new Date(n * 1000).toISOString() : null
}

export function shapeNotification(raw: Raw): PushNotification {
  const contents = (raw.contents ?? {}) as Record<string, unknown>
  // English is the fallback every notification carries (push.ts sends all six).
  const text = str(contents.en) ?? Object.values(contents).map(str).find(Boolean) ?? ''
  return {
    id: String(raw.id),
    text,
    at: unixToIso(raw.completed_at) ?? unixToIso(raw.queued_at),
    delivered: num(raw.successful),
    unsubscribed: num(raw.failed),
    errored: num(raw.errored),
    remaining: num(raw.remaining),
    canceled: raw.canceled === true,
  }
}

// ─── Clerk ───────────────────────────────────────────────────────────────────

export const CLERK_API = 'https://api.clerk.com/v1'

export interface ClerkUser {
  id: string
  name: string | null
  email: string | null
  imageUrl: string | null
  /** How this person can sign in: google, apple, password, email. */
  methods: string[]
  createdAt: string | null
  lastSignInAt: string | null
  lastActiveAt: string | null
  twoFactor: boolean
  banned: boolean
  locked: boolean
}

const msToIso = (value: unknown): string | null => {
  const n = num(value)
  return n > 0 ? new Date(n).toISOString() : null
}

export function signInMethods(raw: Raw): string[] {
  const methods = ((raw.external_accounts ?? []) as Raw[])
    .map((account) => str(account.provider)?.replace(/^oauth_/, ''))
    .filter((provider): provider is string => Boolean(provider))
  if (raw.password_enabled === true) methods.push('password')
  // An address with no password is a one-time code by email.
  else if (((raw.email_addresses ?? []) as Raw[]).length) methods.push('email')
  return [...new Set(methods)]
}

export function shapeClerkUser(raw: Raw): ClerkUser {
  const emails = (raw.email_addresses ?? []) as Raw[]
  const primary = emails.find((e) => e.id === raw.primary_email_address_id) ?? emails[0]
  const name = [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(' ')
  return {
    id: String(raw.id),
    name: name || str(raw.username),
    email: primary ? str(primary.email_address) : null,
    imageUrl: str(raw.image_url),
    methods: signInMethods(raw),
    createdAt: msToIso(raw.created_at),
    lastSignInAt: msToIso(raw.last_sign_in_at),
    lastActiveAt: msToIso(raw.last_active_at),
    twoFactor: raw.two_factor_enabled === true,
    banned: raw.banned === true,
    locked: raw.locked === true,
  }
}

/** `/users/count` answers `{ total_count }`; older docs show a bare number. */
export function readClerkCount(raw: unknown): number {
  if (typeof raw === 'number') return raw
  return num((raw as Raw | null)?.total_count)
}

// ─── PostHog ─────────────────────────────────────────────────────────────────

// The one EU project both channels send to (src/lib/analytics.ts). Constants,
// like Sentry's org and project: neither is a secret and neither changes.
export const POSTHOG_API = 'https://eu.posthog.com'
export const POSTHOG_PROJECT_ID = '287898'
export const POSTHOG_DAYS = 30

/** The channel whose events this project's admin page shows. */
export function posthogChannel(supabaseUrl: string | undefined): 'production' | 'nightly' {
  const ref = (supabaseUrl ?? '').replace(/^https:\/\//, '').split('.')[0]
  return ref === PRODUCTION_PROJECT_REF ? 'production' : 'nightly'
}

export function posthogQueryUrl(): string {
  return `${POSTHOG_API}/api/projects/${POSTHOG_PROJECT_ID}/query/`
}

// COUNTS ONLY, and that is the privacy line of this page: the query groups by
// day and never selects a person, a distinct_id or a property beyond the three
// closed breakdowns below, so nothing that names or follows someone can reach
// the browser even from an admin session. `$active` is people per day
// (uniqIf over signed-in people only (Clerk ids start with user_; HogQL has no is_identified): before login every page load is a fresh anonymous id, which would count one visitor many times), the one number that is not an event count.
const TRACKED_EVENTS = [
  'list_created', 'list_joined', 'item_added', 'item_checked', 'barcode_scanned',
  'invite_sent', 'shop_filter_used', 'onboarding_completed', 'search_performed',
]

export function posthogActivityQuery(channel: string): Record<string, unknown> {
  const since = `timestamp >= today() - INTERVAL ${POSTHOG_DAYS - 1} DAY AND properties.channel = {channel}`
  return {
    query: {
      kind: 'HogQLQuery',
      query: `
        SELECT toString(toDate(timestamp)) AS day, event,
          multiIf(event = 'item_added', toString(properties.source),
                  event = 'barcode_scanned', toString(properties.found),
                  event = 'shop_filter_used', toString(properties.shop), '') AS part,
          count() AS n
        FROM events
        WHERE ${since} AND event IN (${TRACKED_EVENTS.map((e) => `'${e}'`).join(', ')})
        GROUP BY day, event, part
        UNION ALL
        SELECT toString(toDate(timestamp)) AS day, '$active' AS event, '' AS part, uniqIf(person_id, startsWith(distinct_id, 'user_')) AS n
        FROM events
        WHERE ${since}
        GROUP BY day`,
      values: { channel },
    },
  }
}

export interface PostHogActivity {
  channel: string
  /** YYYY-MM-DD, oldest first, every day of the window whether or not it had events. */
  days: string[]
  /** counts[event][part] is one number per day; part is '' for an event with no breakdown. */
  counts: Record<string, Record<string, number[]>>
}

export function shapePostHogActivity(raw: unknown, channel: string, today: Date = new Date()): PostHogActivity {
  const days: string[] = []
  for (let i = POSTHOG_DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10))
  }
  const index = new Map(days.map((day, i) => [day, i]))
  const counts: PostHogActivity['counts'] = {}
  const results = ((raw as Raw | null)?.results ?? []) as unknown[]
  for (const row of results) {
    if (!Array.isArray(row)) continue
    const [day, event, part, n] = row
    const i = index.get(String(day))
    if (i === undefined || typeof event !== 'string') continue
    const byPart = (counts[event] ??= {})
    const values = (byPart[String(part ?? '')] ??= days.map(() => 0))
    values[i] = (values[i] ?? 0) + num(n)
  }
  return { channel, days, counts }
}

// ─── actions ─────────────────────────────────────────────────────────────────

/** The Clerk user id inside a session token, or null. The signature was already checked by is_admin(). */
export function callerId(authorization: string | null): string | null {
  const token = authorization?.replace(/^Bearer\s+/i, '')
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json.sub === 'string' && CLERK_USER_ID.test(json.sub) ? json.sub : null
  } catch {
    return null
  }
}

/**
 * Why an action must not run, or null. Banning yourself locks you out and
 * impersonating yourself is meaningless. Signing yourself out of every device and
 * a test notification to your own phone are fine.
 */
export function refuseAction(request: ServiceAction, caller: string | null): string | null {
  if (request.service !== 'clerk') return null
  if (request.action !== 'ban' && request.action !== 'impersonate') return null
  if (!caller) return 'Could not tell which account is asking.'
  if (request.userId === caller) {
    return request.action === 'impersonate'
      ? 'Impersonating yourself does nothing.'
      : 'This is your own account: doing that would lock you out of the dashboard.'
  }
  return null
}

/** Actor tokens last ten minutes: long enough to open the link, short enough not to linger. */
export const ACTOR_TOKEN_SECONDS = 600

export function actorTokenBody(userId: string, actor: string): Record<string, unknown> {
  return { user_id: userId, actor: { sub: actor }, expires_in_seconds: ACTOR_TOKEN_SECONDS }
}

// Clerk cannot filter by ban, so this reads the newest accounts and the caller keeps
// the banned ones. ponytail: 500 is Clerk's page limit; past that many accounts,
// page with offset.
export function clerkAllUsersUrl(): string {
  return `${CLERK_API}/users?${new URLSearchParams({ limit: '500', order_by: '-created_at' })}`
}

export function clerkSearchUrl(query: string): string {
  return `${CLERK_API}/users?${new URLSearchParams({ query, limit: '25', order_by: '-last_sign_in_at' })}`
}

export function sentryIssueUpdateUrl(issueId: string): string {
  return `${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?id=${issueId}`
}

export function sentryStatusOf(action: 'resolve' | 'ignore' | 'unresolve'): string {
  return action === 'resolve' ? 'resolved' : action === 'ignore' ? 'ignored' : 'unresolved'
}

/**
 * The test notification. It names the channel it was sent from (production or
 * nightly) in both the title and the text, because the two apps look alike on a
 * phone that has both installed and "which one answered" is the thing a test is for.
 */
export function testPushBody(appId: string, userId: string, channel: string): Record<string, unknown> {
  return {
    app_id: appId,
    target_channel: 'push',
    include_aliases: { external_id: [userId] },
    headings: { en: `Bagful Admin · ${channel}` },
    contents: { en: `Test notification sent from ${channel}. If you can read this, push works.` },
    // The same presentation a real list notification has (push-on-item-insert), so a
    // test shows the icon and the banner a person actually gets, not OneSignal's
    // defaults. The channel id must match PUSH_CHANNEL_ID there.
    chrome_web_badge: 'https://famcart-app.vercel.app/icons/badge-96.png',
    existing_android_channel_id: 'list_updates',
    priority: 10,
  }
}

/**
 * Whether OneSignal accepted a notification for at least one subscribed device.
 *
 * The id is the answer. A send that reaches nobody comes back with an EMPTY id; one
 * that reaches a device carries an id. `errors.invalid_aliases` is NOT a failure
 * signal: an account with a stale, disabled subscription next to a live one (every
 * phone that reinstalls or signs in again leaves one) is listed there while the
 * notification is delivered to the live one. Reading it as "nobody" reported a
 * notification that had arrived as undelivered. And NOT `recipients`, which an
 * alias-targeted send does not return at all.
 */
export function pushWasSent(raw: unknown): boolean {
  const id = ((raw ?? {}) as Raw).id
  return typeof id === 'string' && id.length > 0
}

// ─── PostHog recordings ──────────────────────────────────────────────────────

export interface PostHogRecording {
  id: string
  startedAt: string | null
  seconds: number
  clicks: number
  /** The page it started on, path only: a query string can carry an invite code. */
  startPath: string | null
  /** A link into PostHog's own player. */
  url: string
}

// NAMES NO ONE, like the activity query: a session id, when, how long, how many
// clicks and where it began. Who it was is for the PostHog player to say, behind
// PostHog's own login.
// first_url is an aggregate STATE on the raw table, so it is read with argMinMerge: any()
// on it passes while the table is empty and makes PostHog answer 500 as soon as a
// recording exists.
export function posthogRecordingsQuery(): Record<string, unknown> {
  return {
    query: {
      kind: 'HogQLQuery',
      query: `
        SELECT session_id, min(min_first_timestamp) AS started,
          dateDiff('second', min(min_first_timestamp), max(max_last_timestamp)) AS seconds,
          sum(click_count) AS clicks, argMinMerge(first_url) AS first_url
        FROM raw_session_replay_events
        WHERE min_first_timestamp >= now() - INTERVAL 14 DAY
        GROUP BY session_id
        ORDER BY started DESC
        LIMIT 30`,
    },
  }
}

// WHO HAS SESSION REPLAY ON. The switch lives only in the phone (Settings), so the
// one trace of it is a recording: the app identifies PostHog by Clerk id, and a
// person who switched replay on has recordings under that id. "On" here means
// "recorded in the last POSTHOG_DAYS days"; an account that switched it on and
// has not opened the app since reads as off. The ids were checked against
// CLERK_USER_ID, so they are safe to put in the query as literals.
export function posthogReplayersQuery(userIds: string[]): Record<string, unknown> {
  return {
    query: {
      kind: 'HogQLQuery',
      query: `
        SELECT DISTINCT distinct_id
        FROM raw_session_replay_events
        WHERE min_first_timestamp >= now() - INTERVAL ${POSTHOG_DAYS} DAY
          AND distinct_id IN (${userIds.map((id) => `'${id}'`).join(', ')})`,
    },
  }
}

export interface ReplayState {
  userId: string
  replay: boolean
}

export function shapeReplayers(userIds: string[], raw: unknown): ReplayState[] {
  const rows = ((raw as Raw | null)?.results ?? []) as unknown[]
  const recorded = new Set(rows.map((row) => (Array.isArray(row) ? row[0] : null)))
  return userIds.map((userId) => ({ userId, replay: recorded.has(userId) }))
}

function pathOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? new URL(url).pathname : null
  } catch {
    return null
  }
}

export function shapePostHogRecordings(raw: unknown): PostHogRecording[] {
  const results = ((raw as Raw | null)?.results ?? []) as unknown[]
  const out: PostHogRecording[] = []
  for (const row of results) {
    if (!Array.isArray(row)) continue
    const [id, started, seconds, clicks, firstUrl] = row
    if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) continue
    const startPath = pathOf(firstUrl)
    // PostHog answers UTC timestamps, with or without a zone marker.
    const text = typeof started === 'string' ? started : ''
    const when = text ? new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`) : null
    out.push({
      id,
      startedAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
      seconds: num(seconds),
      clicks: num(clicks),
      startPath,
      url: `${POSTHOG_API}/project/${POSTHOG_PROJECT_ID}/replay/${id}`,
    })
  }
  return out
}

/** The Clerk ids in CLERK_ACTION_ADMINS. */
export function parseOwners(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((id) => id.trim()).filter((id) => CLERK_USER_ID.test(id))
}

/**
 * Why this Clerk request is refused for this caller, or null. The caller must be a listed
 * owner, and an owner cannot be impersonated, banned or signed out by another one.
 */
export function refuseClerkRequest(request: ServiceRequest, caller: string | null, owners: string[]): string | null {
  if (!needsOwner(request)) return null
  if (!caller || !owners.includes(caller)) {
    return 'Clerk actions are limited to the owners listed in CLERK_ACTION_ADMINS.'
  }
  // Signing yourself out of every device is yours to do, so it is the one action an owner may aim at an owner.
  const ownSessions = isAction(request) && request.service === 'clerk' && request.action === 'revoke_sessions' && request.userId === caller
  if (!ownSessions && isAction(request) && request.service === 'clerk' && request.action !== 'unban' && owners.includes(request.userId)) {
    return 'That account is an owner, so it is out of reach of this action.'
  }
  return null
}
