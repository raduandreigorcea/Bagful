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
// No cookies and no localStorage (persistence: 'memory'), so no consent banner
// for the counts. An anonymous visitor is new on every launch; that costs the
// login screen's numbers only, since identifyAnalytics ties everything after
// sign-in to the Clerk id. Session replay is the opt-in part: off until the
// person turns it on in settings, per account.
//
// Channels follow OneSignal's rule (getOneSignalAppId): nightly has its own
// PostHog project and never falls back to production's, because .env holds the
// production key and Vite loads it in every mode. The dev server sends nothing.

import type { PostHog } from 'posthog-js'
import { Capacitor } from '@capacitor/core'
import { resolveChannel, type AppChannel } from './appChannel'
import { userScopedKey } from './perUserStorage'

const DIRECT_HOST = 'https://eu.i.posthog.com'
const UI_HOST = 'https://eu.posthog.com'
const REPLAY_KEY = 'famcart-session-replay'

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

const URL_PROPS = ['$current_url', '$referrer', '$pathname', '$initial_current_url', '$initial_referrer']

export function scrubEvent<T extends { properties?: Record<string, unknown> }>(event: T | null): T | null {
  if (!event?.properties) return event
  for (const key of URL_PROPS) {
    if (key in event.properties) event.properties[key] = scrubUrl(event.properties[key])
  }
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
  const { default: posthog } = await import('posthog-js')
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
  posthog.register({ channel, app_version: __APP_VERSION__ })
  client = posthog
  for (const [name, properties] of queue) posthog.capture(name, properties)
  queue = []
}

export function identifyAnalytics(userId: string | null): void {
  if (!client) return
  if (!userId) {
    client.stopSessionRecording()
    client.reset()
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
}
