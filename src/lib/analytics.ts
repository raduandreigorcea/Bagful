// Product analytics, through PostHog's EU cloud.
//
// What people DO in the app, which the admin dashboard cannot see: it reads the
// database, and the database only learns about writes. Funnels, retention and
// which features get used come from here.
//
// THE PRIVACY RULE, which every caller relies on: nothing that a person typed
// or named leaves the phone. No product names, list names, emails, invite codes
// or search text. That is why track() takes a closed set of events with typed
// properties instead of a free-form object, why autocapture masks all text, and
// why scrubEvent drops every URL's query and hash (invite codes and Clerk's
// __clerk_* callback params both ride there).
//
// scrubEvent matches by key suffix (url/referrer/pathname) instead of a fixed
// list of property names, and checks all three bags PostHog fills on a capture
// (properties, $set, $set_once). posthog-js grows new URL-bearing keys with
// almost every release -- $session_entry_url and $external_click_url did not
// exist in the SDK version this file was first written against -- and a fixed
// list silently stops covering a key the day the SDK adds one, which is a
// privacy leak that ships with no test failure to catch it.
//
// No cookies and no localStorage (persistence: 'memory'), so no consent banner
// for the counts. An anonymous visitor is new on every launch; that costs the
// login screen's numbers only, since identifyAnalytics ties everything after
// sign-in to the Clerk id. Session replay is the opt-in part: off until the
// person turns it on in settings, per account.
//
// Channels follow OneSignal's rule (getOneSignalAppId): nightly reads its own
// key and never falls back to production's, because .env holds the production
// key and Vite loads it in every mode. Today both keys are the same project
// (the free plan allows one) and the registered `channel` property tells the
// two apart; the separate variable is what lets nightly move out later
// without a code change. The dev server sends nothing.

import type { PostHog } from 'posthog-js'
import { Capacitor } from '@capacitor/core'
import { resolveChannel, type AppChannel } from './appChannel'
import { userScopedKey } from './perUserStorage'

const DIRECT_HOST = 'https://eu.i.posthog.com'
const UI_HOST = 'https://eu.posthog.com'
const REPLAY_KEY = 'bagful-session-replay'

export type ItemSource = 'search' | 'barcode' | 'custom' | 'typed'

type EventProps = {
  list_created: undefined
  list_joined: undefined
  item_added: { source: ItemSource }
  item_checked: undefined
  barcode_scanned: { found: boolean }
  invite_sent: undefined
  shop_filter_used: { shop: string }
  onboarding_completed: undefined
  search_performed: { results: number }
}
export type AnalyticsEventName = keyof EventProps

export function posthogKey(
  channel: AppChannel,
  env: { prod?: string; nightly?: string; dev?: boolean },
): string {
  if (env.dev) return ''
  return (channel === 'nightly' ? env.nightly : env.prod) ?? ''
}

export function apiHost(isNative: boolean, origin: string): string {
  // The APK serves from https://localhost, so a relative path would post to the
  // phone itself. The web goes through vercel.json's /ingest rewrite, which an
  // ad blocker sees as first-party.
  return isNative ? DIRECT_HOST : `${origin}/ingest`
}

export function scrubUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url
  return url.split(/[?#]/)[0]
}

// Matches $current_url, $referrer, $pathname, $initial_current_url,
// $initial_referrer (in $set_once), $session_entry_url,
// $session_entry_referrer (in properties, once per session) and
// $external_click_url (autocapture on outbound links), plus whatever
// posthog-js names the same way next.
const URL_KEY_PATTERN = /(url|referrer|pathname)$/i

function scrubBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return
  for (const key of Object.keys(bag)) {
    if (URL_KEY_PATTERN.test(key)) bag[key] = scrubUrl(bag[key])
  }
}

export function scrubEvent<T extends {
  properties?: Record<string, unknown>
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
}>(event: T | null): T | null {
  if (!event) return event
  scrubBag(event.properties)
  scrubBag(event.$set)
  scrubBag(event.$set_once)
  return event
}

function resolveConfig(): { key: string; channel: AppChannel } {
  const env = import.meta.env
  const channel = resolveChannel({ channel: env.VITE_APP_CHANNEL, supabaseUrl: env.VITE_SUPABASE_URL, dev: env.DEV })
  const key = posthogKey(channel, { prod: env.VITE_POSTHOG_KEY, nightly: env.VITE_POSTHOG_NIGHTLY_KEY, dev: env.DEV })
  return { key, channel }
}

let client: PostHog | null = null
let started = false
let enabled = true
let queue: Array<[string, Record<string, unknown> | undefined]> = []
let identifiedAs: string | null = null
// Registered on every event. Kept so a sign-out can put them back: reset()
// clears every registered property along with the identity, and an event with
// no channel is invisible to the admin page, which filters on it.
let superProperties: Record<string, unknown> = {}
// A sign-in (or sign-out) made before the SDK has loaded. Clerk routinely
// resolves who is signed in before the dynamic import of posthog-js settles,
// and without this the call was simply dropped: identifyAnalytics no-opped on
// a null client, so every early sign-in shipped events under an anonymous id
// forever (identify is never retried) and replay opt-in never started.
// undefined = nothing pending; null is a real pending value (sign-out).
let pendingUserId: string | null | undefined

export function track<E extends AnalyticsEventName>(
  name: E,
  ...props: EventProps[E] extends undefined ? [] : [EventProps[E]]
): void {
  const properties = props[0] as Record<string, unknown> | undefined
  if (client) client.capture(name, properties)
  else if (enabled) queue.push([name, properties])
}

export async function startAnalytics(): Promise<void> {
  if (started) return
  started = true
  const { key, channel } = resolveConfig()
  if (!key) {
    enabled = false
    queue = []
    return
  }
  let posthog: PostHog
  try {
    ({ default: posthog } = await import('posthog-js'))
  } catch {
    // A blocked or failed fetch of the SDK itself (an ad blocker, a flaky
    // network on first launch). Same outcome as no key: go quiet rather than
    // throw out of a call sites do not await for its result.
    enabled = false
    queue = []
    return
  }
  posthog.init(key, {
    api_host: apiHost(Capacitor.isNativePlatform(), typeof window === 'undefined' ? '' : window.location.origin),
    ui_host: UI_HOST,
    persistence: 'memory',
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_pageview: 'history_change',
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    before_send: scrubEvent,
  })
  superProperties = { channel, app_version: __APP_VERSION__ }
  posthog.register(superProperties)
  client = posthog
  // Applied before the queue flushes: a captured event with no identity set
  // yet files under a fresh anonymous id, and every queued event lands before
  // an identify that arrives after it would tie them to the wrong person.
  if (pendingUserId !== undefined) {
    const userId = pendingUserId
    pendingUserId = undefined
    applyIdentify(userId)
  }
  for (const [name, properties] of queue) posthog.capture(name, properties)
  queue = []
}

export function identifyAnalytics(userId: string | null): void {
  if (!client) {
    pendingUserId = userId
    return
  }
  applyIdentify(userId)
}

function applyIdentify(userId: string | null): void {
  if (!client) return
  if (!userId) {
    // Nobody to forget. App.vue says "signed out" on every visit to the login
    // screen, and resetting there wiped channel off the very first events a
    // visitor sends -- which is how production's first day of events reached
    // PostHog with no channel and never showed in the admin page.
    if (identifiedAs === null) return
    client.stopSessionRecording()
    client.reset()
    client.register(superProperties)
    identifiedAs = null
    return
  }
  identifiedAs = userId
  client.identify(userId)
  // Guarded: this file's unit tests run in the plain node environment, which
  // has no localStorage global, and sign-in there should not throw.
  if (typeof localStorage !== 'undefined' && replayEnabled(localStorage, userId)) void startReplay()
}

async function startReplay(): Promise<void> {
  // Bundled, not fetched: disable_external_dependency_loading keeps PostHog's
  // CDN out of the page, so the recorder has to come from ours.
  await import('posthog-js/dist/recorder')
  client?.startSessionRecording()
}

export function replayEnabled(storage: Pick<Storage, 'getItem'>, userId: string): boolean {
  try {
    return storage.getItem(userScopedKey(REPLAY_KEY, userId)) === '1'
  } catch {
    return false
  }
}

export function setReplayEnabled(storage: Storage, userId: string, on: boolean): void {
  try {
    if (on) storage.setItem(userScopedKey(REPLAY_KEY, userId), '1')
    else storage.removeItem(userScopedKey(REPLAY_KEY, userId))
  } catch {
    // Blocked storage: the switch applies to this session and is not remembered.
  }
  if (!client || identifiedAs !== userId) return
  if (on) void startReplay()
  else client.stopSessionRecording()
}

export function __resetAnalyticsForTests(): void {
  client = null
  started = false
  enabled = true
  queue = []
  identifiedAs = null
  pendingUserId = undefined
  superProperties = {}
}
