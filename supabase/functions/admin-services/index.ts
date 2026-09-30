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
  CLERK_API,
  CORS_HEADERS,
  UpstreamError,
  missingSecrets,
  oneSignalNotificationsUrl,
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

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: CORS_HEADERS })
}

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

async function clerk(request: Extract<ServiceRequest, { service: 'clerk' }>) {
  const auth = `Bearer ${env('CLERK_SECRET_KEY')}`
  if (request.view === 'user') {
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
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

  const missing = missingSecrets(request.service, env)
  if (missing.length) {
    return reply(503, {
      code: 'not_configured',
      missing,
      error: `This project has no ${missing.join(', ')} secret.`,
    })
  }

  try {
    const data =
      request.service === 'sentry'
        ? await sentry(request.view)
        : request.service === 'onesignal'
          ? await oneSignal()
          : request.service === 'posthog'
            ? await posthog()
            : await clerk(request)
    return reply(200, { data })
  } catch (error) {
    if (error instanceof UpstreamError) {
      return reply(502, { code: 'upstream', status: error.status, error: error.message })
    }
    const message = error instanceof Error ? error.message : String(error)
    return reply(502, { code: 'upstream', status: 0, error: `Could not reach ${request.service}: ${message}` })
  }
})
