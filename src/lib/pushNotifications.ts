// Push client backed by OneSignal. Two SDKs, chosen at runtime:
//   • Native Capacitor app (Android/iOS) → @onesignal/capacitor-plugin.
//   • Web browser / PWA → OneSignal Web SDK v16, loaded from their CDN by
//     initPushNotifications(); commands go through the window.OneSignalDeferred
//     queue so they work no matter when the script finishes loading.
// Devices are keyed to users via OneSignal.login(<Clerk user id>), and the
// push-on-item-insert edge function targets those external ids through the
// OneSignal REST API. Everything degrades gracefully: without support or
// config the toggle still saves the local preference and nothing else happens.

import { Capacitor } from '@capacitor/core'
import { whenIdle } from './idle'
import { userScopedKey } from './perUserStorage'
import { IS_NIGHTLY } from './appChannel'
// The language the app is actually in, which is what a notification about this
// app should be in too. Read rather than passed, because every caller of
// setPushLanguage below would otherwise have to remember to look it up, and the
// one that forgot would silently subscribe a device to English. No cycle:
// lib/i18n depends on vue and lib/locale only.
import { getLocale } from './i18n'

// Minimal slice of the v16 web SDK surface this module touches.
interface OneSignalWebSdk {
  init(options: Record<string, unknown>): Promise<void>
  login(externalId: string): Promise<void>
  logout(): Promise<void>
  User: {
    PushSubscription: { optIn(): Promise<void>; optOut(): Promise<void> }
    setLanguage(language: string): Promise<void>
  }
  Notifications: {
    addEventListener(
      event: 'foregroundWillDisplay',
      listener: (event: { preventDefault(): void }) => void,
    ): void
  }
}

type DeferredQueue = Array<(sdk: OneSignalWebSdk) => void>

const WEB_SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'
// Registered under its own scope so it coexists with the root-scope PWA
// service worker (src/sw.js); the push subscription lives on this one.
const WORKER_PATH = 'onesignal/OneSignalSDKWorker.js'
const WORKER_SCOPE = '/onesignal/'

export function getOneSignalAppId(): string {
  // Nightly has its OWN OneSignal app, and never the production one. A device
  // is keyed by its Clerk id, and Clerk is one instance for both channels, so a
  // nightly phone subscribed to the production app would receive every real
  // list's notifications for that person, and famcart-dev's test pushes
  // would reach the phone they shop with.
  //
  // Its own variable rather than VITE_ONESIGNAL_APP_ID from another file: .env
  // holds the production id and Vite loads it in every mode, so a nightly build
  // missing the nightly id would otherwise fall through to production's. Missing
  // here means empty, which every caller already treats as push switched off.
  if (IS_NIGHTLY) return (import.meta.env.VITE_ONESIGNAL_NIGHTLY_APP_ID as string | undefined) ?? ''
  return (import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined) ?? ''
}

// The saved preference doubles as "has this user ever decided": null means the
// login prompt hasn't been answered yet, which is exactly what HomeView keys on.
export type NotificationPreference = 'on' | 'off'

// One preference per account, keyed like the offline queue and the list
// snapshot, and for a sharper reason than either.
//
// This used to be a single device-wide key. Signing out clears the session, the
// snapshot and the queue but deliberately not this — a preference is a standing
// answer, and someone signing back in should not have to give it again. Which
// meant it outlived the account that set it: A turns notifications on, A signs
// out, B signs in, and syncPushUser below reads 'on' and calls
// OneSignal.login(B). The first-run prompt then skips B, because a preference
// exists. B is subscribed to push having never been asked.
//
// Keyed by user, that whole sequence is correct without anything else changing:
// B has no preference and gets asked, and A's survives for when A comes back.
const PREFERENCE_PREFIX = 'bagful-notifications'

function preferenceKey(userId: string): string {
  return userScopedKey(PREFERENCE_PREFIX, userId)
}

export function getNotificationPreference(
  storage: Pick<Storage, 'getItem'>,
  userId: string,
): NotificationPreference | null {
  if (!userId) return null
  const value = storage.getItem(preferenceKey(userId))
  return value === 'on' || value === 'off' ? value : null
}

export function setNotificationPreference(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  mode: NotificationPreference,
): void {
  if (!userId) return
  storage.setItem(preferenceKey(userId), mode)
}

export function isPushSupported(): boolean {
  // Native app: OneSignal uses FCM directly, regardless of WebView support.
  if (Capacitor.isNativePlatform()) return true
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// Pushes matter on devices that leave the desk: a desktop tab is either open
// (the list is already live via Realtime) or closed with the user away from
// the machine, so greeting desktop users with a permission prompt is noise.
// Coarse primary pointer separates phones/tablets from desktops — including
// touch-screen laptops, whose primary pointer is still the mouse/trackpad.
// Desktop users can still opt in from Account Settings.
export function isDesktopBrowser(): boolean {
  if (Capacitor.isNativePlatform()) return false
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !window.matchMedia('(pointer: coarse)').matches
  )
}

function deferredQueue(): DeferredQueue {
  const w = window as unknown as { OneSignalDeferred?: DeferredQueue }
  w.OneSignalDeferred = w.OneSignalDeferred ?? []
  return w.OneSignalDeferred
}

// Resolve the loaded web SDK, or null if it hasn't loaded within the cap —
// the CDN script may never arrive (offline, blocked); the toggle must not hang.
function webSdk(timeoutMs = 15000): Promise<OneSignalWebSdk | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (value: OneSignalWebSdk | null) => {
      if (settled) return
      settled = true
      // Cleared whichever way this settles, so an SDK that arrives immediately
      // does not leave a 15-second timer holding this closure behind it. Called
      // from the enable, disable and boot-sync paths, so they accumulated.
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    deferredQueue().push((sdk) => finish(sdk))
    timer = setTimeout(() => finish(null), timeoutMs)
  })
}

// Whether the web SDK script has been asked for. Keeps ensureWebSdkLoaded
// idempotent: several paths can want the SDK, and only the first should fetch it.
let webSdkRequested = false

// Fetch and initialize the OneSignal web SDK, once.
//
// Deliberately NOT called from initPushNotifications. This is ~100KB from a
// third-party CDN plus a service-worker registration, and until somebody has
// actually turned notifications on there is nothing for any of it to do — yet
// it used to load on every cold start for every visitor, including the desktop
// users isDesktopBrowser goes out of its way never even to prompt. That is the
// exact cost lib/errorReporting takes trouble to avoid for Sentry ("on a
// grocery list opened on a phone in a shop, that is the wrong thing to spend a
// connection on"), and the same reasoning applies here; it simply had not been
// applied yet.
//
// So the SDK is fetched by the two paths that actually need it: syncPushUser for
// a device already opted in, and enableWebPush for one turning it on. `immediate`
// is what separates them — someone who just tapped the toggle is waiting on an
// answer, so the script goes now; boot-time re-binding is background repair with
// nobody watching, so it waits for idle like Sentry does.
//
// Turning push OFF and signing out fetch it too, and immediately. That looks
// like the same wasted download this function exists to avoid and is not: the
// flag below only knows about THIS session, while a subscription outlives one,
// so gating those two on it left a device subscribed after being told to stop.
// See the note in disablePushNotifications.
function ensureWebSdkLoaded(options: { immediate?: boolean } = {}): void {
  if (webSdkRequested) return
  const appId = getOneSignalAppId()
  if (!appId || !isPushSupported()) return
  webSdkRequested = true

  deferredQueue().push((sdk) => {
    // init() rejects when the OneSignal app has no web-push configuration
    // ("App not configured for web push", code 2) — a project-config state, not
    // a runtime fault. Swallow it so it doesn't surface as an unhandled
    // rejection; push simply stays off until the app is configured.
    sdk
      .init({
        appId,
        serviceWorkerParam: { scope: WORKER_SCOPE },
        serviceWorkerPath: WORKER_PATH,
        allowLocalhostAsSecureOrigin: true,
      })
      .catch(() => {})
    // The list is already live in front of an open app (Supabase Realtime); a
    // banner over it is noise. Suppress while the app is foregrounded.
    sdk.Notifications.addEventListener('foregroundWillDisplay', (event) => {
      event.preventDefault()
    })
  })

  // Guarded because the unit tests drive the deferred queue directly, in a node
  // environment with no document — the queue above is the whole contract they
  // rely on, and the script tag is the half only a browser has.
  if (typeof document === 'undefined') return
  const append = () => {
    const script = document.createElement('script')
    script.src = WEB_SDK_URL
    script.defer = true
    document.head.appendChild(script)
  }
  if (options.immediate) append()
  else whenIdle(append)
}

// Call once at app startup (main.ts).
//
// Native only, now. The Capacitor plugin is initialized eagerly because it is a
// local dynamic import rather than a network fetch, and because the native SDK
// throws if anything touches it before initialize(). The web SDK is not fetched
// here at all — see ensureWebSdkLoaded for why, and for who fetches it instead.
export function initPushNotifications(): void {
  const appId = getOneSignalAppId()
  if (!appId) return
  if (!Capacitor.isNativePlatform()) return

  void import('@onesignal/capacitor-plugin').then(({ default: OneSignal }) => {
    void OneSignal.initialize(appId)
    // The list is already live in front of an open app (Supabase Realtime);
    // a banner over it is noise. Suppress while the app is foregrounded.
    OneSignal.Notifications.addEventListener('foregroundWillDisplay', (event) => {
      event.preventDefault()
    })
  })
}

// Tell OneSignal which language this device reads, so a notification arrives in
// it.
//
// The edge function sends every message in all six languages at once (see
// localisedContents in supabase/functions/_shared/push.ts) and OneSignal picks
// per subscription, falling back to English. This is the half that makes the
// pick right: without it OneSignal uses the language it inferred from the
// browser or the handset, which is the device's language rather than the one
// the user chose in Settings — and on a phone whose owner reads the app in
// Romanian on an English handset, those differ.
//
// Best-effort and never awaited by anything user-facing. A failed call leaves
// the subscription on whatever language it already had, which is the state
// before this existed; the next boot's syncPushUser tries again.
//
// Called from three places, and all three are needed for a different reason:
// subscribing (the language is part of what is being registered), booting
// (repairs a subscription made before this existed, or before the user changed
// languages on another device), and the Settings control itself (so the change
// takes effect now rather than at the next launch).
export async function setPushLanguage(): Promise<void> {
  const appId = getOneSignalAppId()
  if (!appId || !isPushSupported()) return
  const language = getLocale()
  try {
    if (Capacitor.isNativePlatform()) {
      const { default: OneSignal } = await import('@onesignal/capacitor-plugin')
      await OneSignal.initialize(appId)
      await OneSignal.User.setLanguage(language)
      return
    }
    // Deliberately does NOT call ensureWebSdkLoaded: a language is only worth
    // recording for a device that has a subscription, and every path that
    // creates one has already loaded the SDK. Fetching ~100KB here would put
    // that cost on the language picker, which is exactly the boot-time download
    // ensureWebSdkLoaded's own comment explains at length. An unloaded SDK
    // resolves null and this does nothing.
    const sdk = await webSdk(3000)
    await sdk?.User.setLanguage(language)
  } catch {
    // See above: leaving the language as it was is the pre-existing behaviour.
  }
}

export type EnablePushResult =
  | 'subscribed'
  | 'unsupported'
  | 'not-configured'
  | 'permission-denied'
  | 'error'

async function enableNativePush(userId: string): Promise<EnablePushResult> {
  const appId = getOneSignalAppId()
  if (!appId) return 'not-configured'
  try {
    const { default: OneSignal } = await import('@onesignal/capacitor-plugin')
    // Idempotent (the plugin no-ops repeat calls); doing it here instead of
    // trusting the startup init closes the gap where login() reaches a
    // not-yet-initialized native SDK — which throws and takes the app down.
    await OneSignal.initialize(appId)
    await OneSignal.login(userId)
    const accepted = await OneSignal.Notifications.requestPermission(true)
    if (!accepted) return 'permission-denied'
    await OneSignal.User.pushSubscription.optIn()
    // After the opt-in, not before: there is no subscription to record a
    // language against until it succeeds. Not awaited — the toggle's answer is
    // 'subscribed' either way, and boot repairs a language that did not land.
    void setPushLanguage()
    return 'subscribed'
  } catch {
    return 'error'
  }
}

async function enableWebPush(userId: string): Promise<EnablePushResult> {
  if (!getOneSignalAppId()) return 'not-configured'
  // The tap that got here is the first thing in the app that genuinely needs
  // the SDK, and someone is watching the toggle — so it is fetched now rather
  // than at the next idle moment.
  ensureWebSdkLoaded({ immediate: true })
  const sdk = await webSdk()
  if (!sdk) return 'error'
  try {
    await sdk.login(userId)
    // optIn shows the browser permission prompt when it hasn't been granted.
    await sdk.User.PushSubscription.optIn()
  } catch {
    return Notification.permission === 'denied' ? 'permission-denied' : 'error'
  }
  if (Notification.permission !== 'granted') return 'permission-denied'
  // Same placement as the native path: only once there is a subscription for
  // the language to belong to.
  void setPushLanguage()
  return 'subscribed'
}

export async function enablePushNotifications(userId: string): Promise<EnablePushResult> {
  if (!userId) return 'error'
  if (!isPushSupported()) return 'unsupported'
  if (Capacitor.isNativePlatform()) return enableNativePush(userId)
  return enableWebPush(userId)
}

// Re-attach this device to the signed-in user, on every boot.
//
// login() is what ties a device to a Clerk id, and it used to run in exactly one
// place: the moment somebody switched notifications on. That made the binding a
// one-shot. Signing out calls logoutPushUser(), which detaches the device;
// signing back in re-initialises the SDK but never re-binds, so the device stayed
// subscribed to OneSignal while belonging to nobody. The symptom is invisible
// from the client — the toggle still reads On, because that is a separate local
// preference — and only shows up at the far end: the edge function targets the
// right external ids, OneSignal matches no devices, and the REST call comes back
// with an empty notification id and a non-zero `targeted` count.
//
// Idempotent on purpose. OneSignal no-ops a login for the id it already holds,
// so calling this on every boot costs nothing in the normal case and repairs the
// detached one. It stays out of the way of an explicit decision: with no stored
// preference, or one set to off, it does nothing at all, so it can never
// resurrect push for somebody who turned it off.
export async function syncPushUser(
  userId: string,
  storage: Pick<Storage, 'getItem'>,
): Promise<void> {
  if (!userId) return
  const appId = getOneSignalAppId()
  if (!appId) return
  if (getNotificationPreference(storage, userId) !== 'on') return
  if (!isPushSupported()) return

  try {
    if (Capacitor.isNativePlatform()) {
      const { default: OneSignal } = await import('@onesignal/capacitor-plugin')
      // Same init-before-use guard the enable path uses: the native SDK throws
      // and takes the app down when touched before initialize.
      await OneSignal.initialize(appId)
      await OneSignal.login(userId)
      // Boot is also where a stale language is reconciled — a subscription made
      // before this existed has whatever OneSignal inferred from the handset,
      // and a language changed on another device has not reached this one.
      await OneSignal.User.setLanguage(getLocale())
      return
    }
    // This is the path that fetches the web SDK for a device already opted in,
    // and it is the reason boot no longer does. At idle, because nobody is
    // waiting on it — the preference is already 'on', so the only thing at
    // stake is re-binding a device that is usually still bound.
    ensureWebSdkLoaded()
    // The full cap rather than the shorter one this used to take: the script is
    // no longer fetched during boot, so the wait now has an idle callback and a
    // CDN download in front of it. Nobody is watching, and a repair that times
    // out one launch short of arriving is a repair that never happens.
    const sdk = await webSdk()
    await sdk?.login(userId)
    // Same reconciliation as the native branch above.
    await sdk?.User.setLanguage(getLocale())
  } catch {
    // Best-effort. A failed re-bind leaves push exactly as broken as it already
    // was, and the toggle in Account settings is still there to force it.
  }
}

export async function disablePushNotifications(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const appId = getOneSignalAppId()
      if (!appId) return
      const { default: OneSignal } = await import('@onesignal/capacitor-plugin')
      // Same init-before-use guard as enableNativePush: the native SDK throws
      // (crashing the app) when touched before initialize.
      await OneSignal.initialize(appId)
      await OneSignal.User.pushSubscription.optOut()
      return
    }
    if (!isPushSupported() || !getOneSignalAppId()) return
    // Fetched here if nothing has fetched it yet, which is the whole of what
    // turning this off requires: the subscription lives on OneSignal's side, so
    // a local preference alone leaves pushes arriving for someone who just said
    // stop.
    //
    // This deliberately does NOT gate on `webSdkRequested`. That flag says
    // "loaded during THIS session", and it is set only by syncPushUser (called
    // from HomeView) and enableWebPush — so a session that reached the settings
    // dialog another way, which AppNavBar allows from ListSetupView, has
    // it false while the device is genuinely subscribed from a previous
    // session. Skipping the opt-out there is the one outcome this toggle exists
    // to prevent, and it is unfalsifiable from the client: the toggle reads Off
    // and the notifications keep coming.
    //
    // The cost is a ~100KB fetch for someone turning off something they never
    // turned on. You can only turn off a toggle that is showing on, so that is
    // rare, user-initiated, and the right side of the trade. The optimisation
    // that actually mattered — not fetching this during boot for every visitor
    // — is untouched: initPushNotifications is native-only and syncPushUser
    // still gates on the stored preference.
    ensureWebSdkLoaded({ immediate: true })
    const sdk = await webSdk(3000)
    await sdk?.User.PushSubscription.optOut()
  } catch {
    // Best-effort: opting out again next time is harmless.
  }
}

// Detach this device from the account on sign-out, so pushes for the old
// account stop following a shared device.
export async function logoutPushUser(): Promise<void> {
  try {
    const appId = getOneSignalAppId()
    if (!appId) return
    if (Capacitor.isNativePlatform()) {
      const { default: OneSignal } = await import('@onesignal/capacitor-plugin')
      await OneSignal.initialize(appId)
      await OneSignal.logout()
      return
    }
    if (!isPushSupported()) return
    // Loaded rather than merely waited for, and for the same reason as
    // disablePushNotifications: a device bound in an earlier session is bound
    // whether or not anything has fetched the SDK in this one, and leaving it
    // bound is the detached-binding failure syncPushUser exists to repair,
    // arrived at from the other end — the next person to sign in on this device
    // inherits the old account's pushes.
    //
    // Waiting without loading was worse than either: it spent 3 seconds on a
    // script nothing had requested and left its callback sitting in
    // OneSignalDeferred, which nothing will ever drain.
    ensureWebSdkLoaded({ immediate: true })
    const sdk = await webSdk(3000)
    await sdk?.logout()
  } catch {
    // Best-effort.
  }
}
