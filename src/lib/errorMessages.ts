// What a failure is allowed to say out loud.
//
// Supabase hands back Postgres error text verbatim: constraint names, trigger
// messages, "permission denied for table shopping_list_items". Passing that
// straight into the UI (the old `error.message ?? 'Could not …'` fallback) turned
// every failure into a readout of the schema. It also read badly — nobody wants
// "duplicate key value violates unique constraint" in a dialog.
//
// So messages come from one of two places:
//   • UserFacingError — text written deliberately for the user, shown as-is;
//   • everything else — replaced with the caller's fallback, with the original
//     sent to Sentry so the detail is still there when debugging.
//
// Errors are still *inspected* freely at the call sites (the item-limit and
// 23505 branches read error.message/code to pick a friendly response). This is
// only about what reaches the screen.

import { captureException } from './errorReporting'
import { isOfflineError } from './offlineQueue'

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

// Reporting is a no-op without a DSN (dev, CI, tests) and buffers until the SDK
// finishes loading, so this is safe everywhere and at any time. Wrapped anyway:
// reporting must never throw on top of the failure it is reporting.
function report(error: unknown): void {
  try {
    captureException(error)
  } catch {
    // Nothing useful to do here — swallow and let the caller show its fallback.
  }
}

// The message to show the user for `error`, and the only way an error should
// reach the UI. Deliberate messages pass through; anything else is replaced
// with `fallback` and reported, unless the request died on the network: a
// dropped connection, or the page being left mid-save (a reload, the browser's
// Back). That is not a fault in the app, the same rule loadListHeader and the
// list actions follow, and the bot swarm showed every interrupted settings save
// arriving in Sentry as an error.
export function userMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError) return error.message
  if (!isOfflineError(error)) report(error)
  return fallback
}
