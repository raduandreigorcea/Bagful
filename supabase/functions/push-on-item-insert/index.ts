// Push fan-out via OneSignal, called by database webhooks on INSERT into:
//   • shopping_list_items — "Radu added Milk", one per item;
//   • purchase_history    — "Radu bought Milk and 2 more", one per checkout.
// A checkout inserts one history row per item, so the webhook fires once per
// row; every row carries the same checkout_id, which doubles as the OneSignal
// idempotency_key — duplicate calls collapse into a single sent notification.
//
// Recipients are every list member except the actor. Devices (web and
// native) are registered by the client SDKs and keyed to Clerk user ids via
// OneSignal.login(), so no subscription storage lives on our side.
//
// Required secrets (supabase secrets set ...):
//   ONESIGNAL_APP_ID       — the OneSignal app's id (dashboard → Settings → Keys & IDs)
//   ONESIGNAL_REST_API_KEY — the app's REST API key, same page
//   PUSH_WEBHOOK_SECRET    — shared secret; webhooks must send it in an
//                            `x-webhook-secret` header
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// verify_jwt is off for this function (config.toml): database webhooks carry no
// user JWT, so the shared secret is the authentication.
//
// WHAT IS AND IS NOT IN THIS FILE
//
// Everything here needs Deno, the platform's environment, or the network: the
// service-role client, the OneSignal call, the request handler. None of it can
// be exercised from this repo's test runner, and importing this module would
// run Deno.serve.
//
// So the decisions live next door in ../_shared/push.ts — which recipients,
// what the message says, whether the secret matched, which fan-out a payload is
// asking for — and are covered by test/push.test.js. What is left below is
// wiring, and it is deliberately shaped so that a mistake in it is a mistake in
// one plainly visible line rather than in a branch nobody can reach.

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  checkoutBody,
  itemAddedBody,
  localisedContents,
  recipientsFor,
  routePayload,
  secretMatches,
  type ItemRecord,
  type PurchaseRecord,
} from '../_shared/push.ts'

/** Must match PUSH_CHANNEL_ID in android/app/src/main/java/com/bagful/app/MainActivity.java. */
const PUSH_CHANNEL_ID = 'list_updates'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// List member ids for a list. Names live in profiles now, resolved
// separately by fetchDisplayName when a message needs to name the actor.
async function fetchMembers(listId: string) {
  return await supabase
    .from('list_members')
    .select('user_id')
    .eq('list_id', listId)
}

// The actor's display name from their profile row, or null if it is missing;
// the message then says "Someone" in each language (see ../_shared/push.ts).
async function fetchDisplayName(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.display_name || null
}

async function sendPush(options: {
  recipientIds: string[]
  /**
   * The message in every language the app speaks, keyed by language code.
   * OneSignal picks the one matching each subscription's own language and
   * falls back to `en`, so a list reading in three languages is still
   * one REST call. See localisedContents in ../_shared/push.ts.
   */
  contents: Record<string, string>
  listId: string
  idempotencyKey: string
}): Promise<Response> {
  // One collapsing notification per list: web_push_topic (browsers) and
  // collapse_id (native) make a burst of changes update in place, not stack.
  const tag = `bagful-${options.listId}`
  const res = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Key ${Deno.env.get('ONESIGNAL_REST_API_KEY')}`,
    },
    body: JSON.stringify({
      app_id: Deno.env.get('ONESIGNAL_APP_ID'),
      target_channel: 'push',
      include_aliases: { external_id: options.recipientIds },
      // The brand name, which is the same word in all six languages, so this
      // stays a single key while `contents` below does not.
      headings: { en: 'Bagful' },
      contents: options.contents,
      // The status-bar icon Chrome on Android shows for a web push. It keeps
      // only the image's shape, so this is the logo's one-colour outline
      // (scripts/build-icons.mjs). The production URL serves both channels:
      // the image is the same, and a preview URL would not outlive its deploy.
      chrome_web_badge: 'https://famcart-app.vercel.app/icons/badge-96.png',
      web_push_topic: tag,
      collapse_id: tag,
      // The high-importance channel MainActivity creates, which is what makes
      // Android drop a banner over the screen rather than only add an icon to
      // the status bar. A phone on an app older than the channel does not have
      // it, and OneSignal then falls back to its default channel as before.
      existing_android_channel_id: PUSH_CHANNEL_ID,
      // FCM high priority: delivered at once to a phone in Doze, not batched
      // into its next maintenance window.
      priority: 10,
      // Webhook retries (and per-row checkout fan-in) resend the same key;
      // OneSignal processes the first and swallows the rest.
      idempotency_key: options.idempotencyKey,
    }),
    // Without one, a OneSignal that never answers holds this function until the
    // platform kills it. Same bound as admin-services' vendor calls.
    signal: AbortSignal.timeout(10_000),
  })

  const result = await res.json().catch(() => null)
  if (!res.ok) {
    return Response.json(
      { error: 'OneSignal rejected the notification', detail: result },
      { status: 502 },
    )
  }
  // An empty id means no recipient had a subscribed device — normal when
  // nobody has enabled notifications; not an error.
  return Response.json({ id: result?.id ?? null, targeted: options.recipientIds.length })
}

async function handleItemAdded(item: ItemRecord): Promise<Response> {
  const { data: members, error } = await fetchMembers(item.list_id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  const recipientIds = recipientsFor(members, item.added_by)
  if (!recipientIds.length) return Response.json({ sent: 0 })

  const who = await fetchDisplayName(item.added_by)
  return sendPush({
    recipientIds,
    contents: localisedContents((locale) => itemAddedBody(who, item, locale)),
    listId: item.list_id,
    idempotencyKey: item.id,
  })
}

async function handleCheckout(purchase: PurchaseRecord): Promise<Response> {
  const [{ data: members, error: membersErr }, { data: items, error: itemsErr }] =
    await Promise.all([
      fetchMembers(purchase.list_id),
      // The webhook fires after buy_items commits, so every row of this
      // checkout is already visible; the count is complete on the first call.
      supabase
        .from('purchase_history')
        .select('name, quantity')
        .eq('checkout_id', purchase.checkout_id),
    ])
  if (membersErr) return Response.json({ error: membersErr.message }, { status: 500 })
  if (itemsErr) return Response.json({ error: itemsErr.message }, { status: 500 })

  const recipientIds = recipientsFor(members, purchase.purchased_by)
  if (!recipientIds.length || !items?.length) return Response.json({ sent: 0 })

  const who = await fetchDisplayName(purchase.purchased_by)
  return sendPush({
    recipientIds,
    contents: localisedContents((locale) => checkoutBody(who, items, locale)),
    listId: purchase.list_id,
    idempotencyKey: purchase.checkout_id,
  })
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET')
  if (!secret || !(await secretMatches(req.headers.get('x-webhook-secret'), secret))) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!Deno.env.get('ONESIGNAL_APP_ID') || !Deno.env.get('ONESIGNAL_REST_API_KEY')) {
    return Response.json({ error: 'OneSignal secrets not configured' }, { status: 500 })
  }

  const job = routePayload(await req.json().catch(() => null))
  if (!job) return Response.json({ skipped: true })
  return job.kind === 'item' ? handleItemAdded(job.record) : handleCheckout(job.record)
})
