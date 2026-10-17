// Sentry, OneSignal, Clerk and PostHog, for the admin dashboard's Services pages.
//
// The dashboard holds no secret key and must never hold one, and all three of
// these answer only to a secret key. So the keys live here, as secrets of the
// project this function is deployed to, and the dashboard calls this with the
// signed-in person's Clerk token.
//
// Deployed to BOTH app projects, and each answers with its own secrets. That is
// what lets the pages follow the dashboard's project switcher: bagful-dev has
// no OneSignal secrets today, so its OneSignal page says "not configured"
// rather than showing production's notifications under a dev badge.
//
// Secrets (supabase secrets set --project-ref <ref> ...):
//   SENTRY_READ_TOKEN      a Sentry token with event:read and project:read
//   ONESIGNAL_APP_ID       shared with push-on-item-insert
//   ONESIGNAL_REST_API_KEY shared with push-on-item-insert
//   CLERK_SECRET_KEY       the sk_test_ key of the one Clerk instance
//   POSTHOG_PERSONAL_API_KEY  a phx_ key scoped to query:read, same on both projects
//   CLERK_ACTION_ADMINS    comma-separated Clerk ids allowed to use the Clerk actions and search
//                          (impersonate, ban, sign out, find any account). Unset: nobody can.
//   SENTRY_WRITE_TOKEN     only for resolving/ignoring issues: a token with event:admin.
//                          Without it those buttons answer not_configured and reads still work.
// ACTIONS (ban, impersonate, resolve, test push) are requests with an `action`; they pass the
// same is_admin() gate, and index.ts refuses the ones aimed at the caller's own account.
// A service whose secrets are missing answers 503 not_configured, naming them.
//
// WHO MAY ASK: verify_jwt is off (config.toml), because the platform's check
// knows the project's own JWT secret and a Clerk token is not signed with it.
// The gate is is_admin() instead, called through PostgREST with the caller's
// own token: PostgREST verifies a Clerk token through Third-Party Auth, and
// is_admin() reads public.admin_users. So a request that gets past it is from a
// real Clerk session belonging to an admin OF THIS PROJECT, which is the same
// rule every admin_* RPC applies.
//
// The decisions (which requests exist, what is sent back) are in
// ../_shared/services.ts and tested from test/services.test.js.

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  actorTokenBody,
  callerId,
  clerkSearchUrl,
  clerkAllUsersUrl,
  CLERK_API,
  corsHeaders,
  isAction,
  posthogRecordingsQuery,
  posthogReplayersQuery,
  shapeReplayers,
  refuseAction,
  sentryIssueUpdateUrl,
  sentryStatusOf,
  shapePostHogRecordings,
  testPushBody,
  parseOwners,
  pushWasSent,
  refuseClerkRequest,
  type ServiceAction,
  UpstreamError,
  missingSecrets,
  oneSignalNotificationsUrl,
  oneSignalUserUrl,
  shapeSubscriber,
  parseRequest,
  posthogActivityQuery,
  posthogChannel,
  posthogQueryUrl,
  shapePostHogActivity,
  readClerkCount,
  sentryEnvironments,
  sentryIssuesUrl,
  sentryEnvironmentsUrl,
  knownEnvironments,
  sentryProjectUrl,
  shapeClerkUser,
  shapeNotification,
  shapeSentryFeedback,
  shapeSentryIssue,
  type Service,
  type ServiceRequest,
} from '../_shared/services.ts'

const env = (name: string) => Deno.env.get(name)


async function getJson(service: Service, url: string, authorization: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    // Sentry, Clerk and OneSignal all put a sentence in the error body, under
    // one of these names. It is the most useful thing a failure can say.
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const detail = [body?.detail, body?.message, body?.errors].find((v) => typeof v === 'string') as string | undefined
    throw new UpstreamError(service, res.status, { path: new URL(url).pathname, detail })
  }
  return await res.json()
}

async function sendJson(
  service: Service,
  method: 'POST' | 'PUT',
  url: string,
  authorization: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const first = Array.isArray(parsed?.errors) ? (parsed!.errors as Record<string, unknown>[])[0] : null
    const detail = [parsed?.detail, parsed?.message, first?.long_message, first?.message].find((v) => typeof v === 'string') as
      | string
      | undefined
    throw new UpstreamError(service, res.status, { path: new URL(url).pathname, detail })
  }
  return await res.json().catch(() => ({}))
}

// The numeric project id the issues endpoint filters by, looked up once per
// instance: it never changes, and the lookup is a second round trip otherwise.
let sentryProjectId: string | null = null

async function sentry(view: 'issues' | 'feedback') {
  const auth = `Bearer ${env('SENTRY_READ_TOKEN')}`
  if (!sentryProjectId) {
    const project = (await getJson('sentry', sentryProjectUrl(), auth)) as { id: string }
    sentryProjectId = String(project.id)
  }
  // Only the environments Sentry has seen: asking for one it has not is a 404
  // (see knownEnvironments), and none seen means no issues to list.
  const seen = (await getJson('sentry', sentryEnvironmentsUrl(), auth)) as unknown[]
  const environments = knownEnvironments(sentryEnvironments(env('SUPABASE_URL')), Array.isArray(seen) ? seen : [])
  if (!environments.length) return []
  const url = sentryIssuesUrl(sentryProjectId, view, environments)
  const rows = (await getJson('sentry', url, auth)) as Record<string, unknown>[]
  return view === 'issues' ? rows.map(shapeSentryIssue) : rows.map(shapeSentryFeedback)
}

async function oneSignal() {
  const url = oneSignalNotificationsUrl(env('ONESIGNAL_APP_ID')!)
  const body = (await getJson('onesignal', url, `Key ${env('ONESIGNAL_REST_API_KEY')}`)) as {
    notifications?: Record<string, unknown>[]
  }
  return (body.notifications ?? []).map(shapeNotification)
}

// Whether each of these people can be pushed to, one OneSignal lookup apiece.
// A 404 is an answer, not a fault: the app signs a device in under the Clerk id
// only when someone turns notifications on, so most people are simply unknown.
async function subscribers(userIds: string[]) {
  return await Promise.all(
    userIds.map(async (userId) => {
      const url = oneSignalUserUrl(env('ONESIGNAL_APP_ID')!, userId)
      try {
        const raw = (await getJson('onesignal', url, `Key ${env('ONESIGNAL_REST_API_KEY')}`)) as Record<string, unknown>
        return shapeSubscriber(userId, raw)
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) return shapeSubscriber(userId, null)
        throw error
      }
    }),
  )
}

async function posthog() {
  const channel = posthogChannel(env('SUPABASE_URL'))
  const res = await fetch(posthogQueryUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('POSTHOG_PERSONAL_API_KEY')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(posthogActivityQuery(channel)),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const detail = typeof body?.detail === 'string' ? body.detail : undefined
    throw new UpstreamError('posthog', res.status, { path: new URL(posthogQueryUrl()).pathname, detail })
  }
  return shapePostHogActivity(await res.json(), channel)
}

async function posthogRecordings(userIds?: string[]) {
  const res = await fetch(posthogQueryUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('POSTHOG_PERSONAL_API_KEY')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(userIds ? posthogReplayersQuery(userIds) : posthogRecordingsQuery()),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const detail = typeof body?.detail === 'string' ? body.detail : undefined
    throw new UpstreamError('posthog', res.status, { path: new URL(posthogQueryUrl()).pathname, detail })
  }
  const raw = await res.json()
  return userIds ? shapeReplayers(userIds, raw) : shapePostHogRecordings(raw)
}

// Every write, one place. `caller` is the signed-in admin's Clerk id.
// The Clerk half of a ban went through but Bagful's own did not. A ban is both doors,
// so this is a failure, with the way out in the message: it is safe to press again.
class AppBanError extends Error {}

async function act(request: ServiceAction, caller: string | null, db: ReturnType<typeof createClient>) {
  if (request.service === 'clerk') {
    const auth = `Bearer ${env('CLERK_SECRET_KEY')}`
    const user = `${CLERK_API}/users/${request.userId}`
    if (request.action === 'ban' || request.action === 'unban') {
      // ONE ban, both doors. Clerk first: it is the one that refuses a sign-in and ends
      // every session, so it is the lock that matters most if the second step fails.
      // Both steps are idempotent (Clerk and admin_ban_user), so a retry is always safe.
      const clerkUser = shapeClerkUser((await sendJson('clerk', 'POST', `${user}/${request.action}`, auth)) as Record<string, unknown>)
      const { error } =
        request.action === 'ban'
          ? await db.rpc('admin_ban_user', { p_user_id: request.userId, p_reason: request.reason ?? '' })
          : await db.rpc('admin_unban_user', { p_user_id: request.userId })
      if (error) {
        throw new AppBanError(
          `Clerk is done, but Bagful's own ${request.action} failed: ${error.message}. Press the button again to finish it.`,
        )
      }
      return clerkUser
    }
    if (request.action === 'revoke_sessions') {
      const sessions = (await getJson('clerk', `${CLERK_API}/sessions?user_id=${request.userId}&status=active&limit=100`, auth)) as unknown
      const list = (Array.isArray(sessions) ? sessions : ((sessions as { data?: unknown[] })?.data ?? [])) as { id?: string }[]
      let revoked = 0
      for (const session of list) {
        if (typeof session.id === 'string' && /^sess_\w+$/.test(session.id)) {
          await sendJson('clerk', 'POST', `${CLERK_API}/sessions/${session.id}/revoke`, auth)
          revoked++
        }
      }
      return { revoked }
    }
    // impersonate: a one-time sign-in link, valid for ten minutes. It is NOT logged to
    // security_events (that table is written by the database); this line is the record.
    const token = (await sendJson('clerk', 'POST', `${CLERK_API}/actor_tokens`, auth, actorTokenBody(request.userId, caller!))) as {
      url?: string
    }
    // The record of an impersonation: the function log, since nothing else writes one.
    // eslint-disable-next-line no-console
    console.log(`[admin-services] ${caller} created an impersonation link for ${request.userId}`)
    return { url: token.url ?? null }
  }
  if (request.service === 'sentry') {
    await sendJson(
      'sentry',
      'PUT',
      sentryIssueUpdateUrl(request.issueId),
      `Bearer ${env('SENTRY_WRITE_TOKEN')}`,
      { status: sentryStatusOf(request.action) },
    )
    return { ok: true }
  }
  // onesignal test_push
  const target = request.userId ?? caller
  if (!target) throw new Error('Could not tell who to send the test to.')
  const sent = (await sendJson(
    'onesignal',
    'POST',
    'https://api.onesignal.com/notifications?c=push',
    `Key ${env('ONESIGNAL_REST_API_KEY')}`,
    testPushBody(env('ONESIGNAL_APP_ID')!, target, posthogChannel(env('SUPABASE_URL'))),
  )) as unknown
  // OneSignal answers 200 either way; pushWasSent says whether a device was found.
  return { sent: pushWasSent(sent) }
}

async function clerk(request: Extract<ServiceRequest, { service: 'clerk' }>) {
  const auth = `Bearer ${env('CLERK_SECRET_KEY')}`
  if ('view' in request && request.view === 'search') {
    const rows = (await getJson('clerk', clerkSearchUrl(request.query), auth)) as Record<string, unknown>[]
    return rows.map(shapeClerkUser)
  }
  if ('view' in request && request.view === 'banned') {
    const rows = (await getJson('clerk', clerkAllUsersUrl(), auth)) as Record<string, unknown>[]
    return rows.map(shapeClerkUser).filter((user) => user.banned)
  }
  if ('view' in request && request.view === 'user') {
    try {
      return shapeClerkUser((await getJson('clerk', `${CLERK_API}/users/${request.userId}`, auth)) as Record<string, unknown>)
    } catch (error) {
      // A profile can outlive its Clerk account. That is an answer, not a fault.
      if (error instanceof UpstreamError && error.status === 404) return null
      throw error
    }
  }
  const [count, recent] = await Promise.all([
    getJson('clerk', `${CLERK_API}/users/count`, auth),
    getJson('clerk', `${CLERK_API}/users?order_by=-last_sign_in_at&limit=25`, auth),
  ])
  return {
    total: readClerkCount(count),
    recent: (recent as Record<string, unknown>[]).map(shapeClerkUser),
  }
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'))
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return reply(405, { code: 'bad_request', error: 'POST only' })

  const authorization = req.headers.get('authorization')
  if (!authorization) return reply(401, { code: 'not_admin', error: 'No session token was sent.' })

  const db = createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, {
    global: { headers: { authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: isAdmin, error: gateError } = await db.rpc('is_admin')
  if (gateError || isAdmin !== true) {
    return reply(403, { code: 'not_admin', error: 'This account is not an admin of this project.' })
  }

  const request = parseRequest(await req.json().catch(() => null))
  if (!request) return reply(400, { code: 'bad_request', error: 'Unknown service or view.' })

  const missing = missingSecrets(request.service, env, request)
  if (missing.length) {
    return reply(503, {
      code: 'not_configured',
      missing,
      error: `This project has no ${missing.join(', ')} secret.`,
    })
  }

  // The Clerk key is one instance wide while is_admin() is per project: see CLERK_OWNERS_SECRET.
  const owner = refuseClerkRequest(request, callerId(authorization), parseOwners(env('CLERK_ACTION_ADMINS')))
  if (owner) return reply(403, { code: 'refused', error: owner })

  if (isAction(request)) {
    const caller = callerId(authorization)
    const refusal = refuseAction(request, caller)
    if (refusal) return reply(403, { code: 'refused', error: refusal })
    try {
      return reply(200, { data: await act(request, caller, db) })
    } catch (error) {
      if (error instanceof AppBanError) return reply(502, { code: 'upstream', status: 0, error: error.message })
      if (error instanceof UpstreamError) return reply(502, { code: 'upstream', status: error.status, error: error.message })
      const message = error instanceof Error ? error.message : String(error)
      return reply(502, { code: 'upstream', status: 0, error: `Could not reach ${request.service}: ${message}` })
    }
  }

  try {
    const data =
      request.service === 'sentry'
        ? await sentry((request as { view: 'issues' | 'feedback' }).view)
        : request.service === 'onesignal'
          ? (request as { view: string }).view === 'subscribers'
            ? await subscribers((request as { userIds: string[] }).userIds)
            : await oneSignal()
          : request.service === 'posthog'
            ? (request as { view: string }).view !== 'activity'
              ? await posthogRecordings((request as { userIds?: string[] }).userIds)
              : await posthog()
            : await clerk(request as Extract<ServiceRequest, { service: 'clerk' }>)
    return reply(200, { data })
  } catch (error) {
    if (error instanceof UpstreamError) {
      return reply(502, { code: 'upstream', status: error.status, error: error.message })
    }
    const message = error instanceof Error ? error.message : String(error)
    return reply(502, { code: 'upstream', status: 0, error: `Could not reach ${request.service}: ${message}` })
  }
})
