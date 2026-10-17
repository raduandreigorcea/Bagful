// Which of a person's OneSignal subscriptions are dead weight.
//
// OneSignal opens a NEW subscription on every install, cleared-data launch or
// browser-profile reset, and keeps the old one marked enabled until a push to it
// fails. A developer's phone ends up with twenty, and so does anyone who
// reinstalls. The app tells prune-push-subscriptions which subscription is the
// one it is running on; everything it can safely call a leftover is returned here.
//
// Safe means: the live subscription must be in the list (otherwise OneSignal and
// the phone disagree and nothing is touched), and a leftover is either already
// unsubscribed, or the same kind of device with the same model, which is what an
// older install of this very phone looks like. A different phone, or a different
// browser, is never a leftover.

type Raw = Record<string, unknown>

/** The ids to delete. `subscriptions` is OneSignal's `user.subscriptions`. */
export function staleSubscriptionIds(subscriptions: unknown, currentId: string): string[] {
  if (!Array.isArray(subscriptions)) return []
  const push = (subscriptions as Raw[]).filter(
    (s) => typeof s.id === 'string' && typeof s.type === 'string' && (s.type as string).endsWith('Push'),
  )
  const current = push.find((s) => s.id === currentId)
  if (!current) return []
  const model = typeof current.device_model === 'string' ? current.device_model.trim() : ''
  return push
    .filter((s) => s.id !== currentId)
    .filter((s) => s.enabled !== true || (model !== '' && s.type === current.type && s.device_model === current.device_model))
    .map((s) => s.id as string)
}

// OneSignal's subscription ids are UUIDs, and this one is spliced into a URL path.
export const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function oneSignalSubscriptionUrl(appId: string, subscriptionId: string): string {
  return `https://api.onesignal.com/apps/${appId}/subscriptions/${subscriptionId}`
}
