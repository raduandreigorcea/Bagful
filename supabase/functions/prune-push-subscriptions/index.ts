// Deletes a person's leftover OneSignal subscriptions: the ones an old install of
// the same phone left behind (see ../_shared/pushPrune.ts for what counts).
//
// Called by the app itself, signed in as the person it cleans up for, right after
// the device is tied to their Clerk id. Nobody can prune anyone else: the id comes
// from the caller's own verified token (requesting_user_id() through PostgREST,
// which checks a Clerk token through Third-Party Auth), never from the request.
//
// verify_jwt is off (config.toml) because the platform's check does not know a
// Clerk token; the requesting_user_id() call below is the gate.
//
// Secrets: ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY (shared with push-on-item-insert).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { oneSignalUserUrl } from '../_shared/services.ts'
import { oneSignalSubscriptionUrl, staleSubscriptionIds, SUBSCRIPTION_ID } from '../_shared/pushPrune.ts'

const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}
const reply = (status: number, body: unknown) => Response.json(body, { status, headers })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })

  const authorization = req.headers.get('authorization')
  if (!authorization) return reply(401, { error: 'No session token was sent.' })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userId, error: gateError } = await db.rpc('requesting_user_id')
  if (gateError || typeof userId !== 'string' || !userId) return reply(401, { error: 'Not signed in.' })

  const body = (await req.json().catch(() => null)) as { subscriptionId?: unknown } | null
  const subscriptionId = body?.subscriptionId
  if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID.test(subscriptionId)) {
    return reply(400, { error: 'subscriptionId must be a OneSignal subscription id.' })
  }

  const appId = Deno.env.get('ONESIGNAL_APP_ID')
  const key = Deno.env.get('ONESIGNAL_REST_API_KEY')
  if (!appId || !key) return reply(503, { error: 'OneSignal is not configured on this project.' })
  const auth = { authorization: `Key ${key}`, accept: 'application/json' }

  const found = await fetch(oneSignalUserUrl(appId, userId), { headers: auth, signal: AbortSignal.timeout(10_000) })
  if (found.status === 404) return reply(200, { deleted: 0 })
  if (!found.ok) return reply(502, { error: `OneSignal answered ${found.status}.` })
  const user = (await found.json()) as { subscriptions?: unknown }

  const stale = staleSubscriptionIds(user.subscriptions, subscriptionId)
  const results = await Promise.allSettled(
    stale.map((id) =>
      fetch(oneSignalSubscriptionUrl(appId, id), { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(10_000) }),
    ),
  )
  const deleted = results.filter((r) => r.status === 'fulfilled' && (r.value.ok || r.value.status === 404)).length
  return reply(200, { deleted })
})
