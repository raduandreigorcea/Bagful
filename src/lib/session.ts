// Remembers which user was last confirmed signed in, so the app can boot into
// their cached list when offline — Clerk needs the network to verify a session
// and otherwise reports "signed out", which would bounce a logged-in user to a
// login page that also can't work offline. This is only a routing/cache hint;
// every authenticated request still carries a real Clerk token once online.

import { clearActiveListId, clearListSnapshot } from './listCache'
import { clearOfflineQueue } from './offlineQueue'
import { clearProfileWritten } from './profile'
import { clearCachedShops } from './shopBadges'

const KEY = 'bagful-last-user'

export function rememberUser(storage: Storage, userId: string): void {
  try {
    storage.setItem(KEY, userId)
  } catch {
    // Storage disabled — offline boot just won't be available; nothing breaks.
  }
}

export function getRememberedUser(storage: Storage): string | null {
  try {
    return storage.getItem(KEY)
  } catch {
    return null
  }
}

export function forgetUser(storage: Storage): void {
  try {
    storage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

// Everything this device remembers about a signed-in user, dropped together.
//
// Sign-out used to spell this out at the call site, and got three of the four:
// the remembered user, the snapshot and the offline queue were cleared, and the
// active-list pointer was not. That particular omission was harmless — the
// pointer is stored with the account it belongs to and rejected on read by
// anyone else — but "harmless" was luck rather than design, and the list only
// exists in one function whose name does not say it is a list.
//
// So it is a list, here, next to the thing that writes the first entry. The
// point is not the four calls; it is that adding a fifth key has an obvious
// place to be added, instead of depending on whoever adds it remembering that
// signing out is a thing that exists.
//
// `userId` scopes what can be scoped. Without one — a sign-out from a screen
// that never learned who was signed in — the queue and the snapshot each clear
// every account's, which is the safer end of that trade on a shared browser.
//
// Two keys are deliberately NOT on the list, and they have to be named here or
// the next person reading "adding a fifth key has an obvious place to be added"
// will add them. Both belong to the language choice (lib/locale):
//
//   bagful-locale:<userId>  A preference is a standing answer. Signing back in
//                            should not re-ask, which is the same argument the
//                            notification preference makes for itself and the
//                            reason neither is cleared here.
//   bagful-locale           The device hint. Clearing it would flip the app to
//                            English at the one moment the user has no way to
//                            change it back — the login screen, where there is
//                            no account to read a preference from.
//
// The cost is that signing in as somebody who has never chosen leaves the app
// in the previous account's language until they change it. That is cosmetic,
// two taps to fix, and the same trade bagful-last-user already makes.
export function forgetLocalUserState(storage: Storage, userId?: string): void {
  forgetUser(storage)
  clearListSnapshot(storage, userId)
  clearActiveListId(storage, userId)
  clearOfflineQueue(storage, userId)
  clearProfileWritten(storage, userId)
  // The fifth entry, and the one that proves the paragraph above was worth
  // writing. It takes no userId because its key carries none: the shop cache is
  // device-wide on purpose (see clearCachedShops), so there is only ever one to
  // drop and every sign-out drops it.
  clearCachedShops(storage)
}
