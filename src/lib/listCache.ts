import type { ListMemberProfile, ShoppingItemRow } from './listRealtime'
import { clearUserScopedKeys, userScopedKey } from './perUserStorage'

// Last known list state, keyed to one user. Read on startup so a returning
// user sees their list instantly (stale-while-revalidate) instead of skeletons
// while Clerk and the first Supabase fetches warm up; the fresh data then
// overwrites it. The cache is an optimization only — every failure mode
// degrades to "no snapshot".

export interface ListSnapshot {
  listId: string
  listName: string
  listInviteCode: string
  listOwnerId: string
  listItemLimit: number
  listEmoji: string
  listMembers: ListMemberProfile[]
  items: ShoppingItemRow[]
  // Whether this list has ever bought anything. Cached because it decides
  // between "All bought" and "Nothing here yet" on an empty list, and the
  // purchase history that answers it cannot be read offline — without this, a
  // list that shops every week is told they have never started.
  hasShopped: boolean
}

interface StoredSnapshot extends ListSnapshot {
  version: number
  userId: string
  savedAt: number
}

// One snapshot per account, rather than one snapshot with an account stamped on
// it.
//
// The read below has always rejected a snapshot belonging to somebody else, so
// the single key was never a leak. It was a loss: the one key held whichever
// account saved last, so B signing in overwrote A's snapshot outright, and A's
// next open was a column of skeletons for a cache that had been sitting there a
// moment earlier. offlineQueue.ts and the notification preference were both
// moved off exactly this design, each with its own note explaining why; this was
// the last one still on it.
//
// Milder than either of those, and worth saying why it is fixed the same way
// anyway: a snapshot is only a cache, so losing one costs a slower boot rather
// than a user's unsent writes or a consent nobody gave. It is the same shape of
// problem one severity down, and leaving the shape in place is how it survives
// to reappear somewhere it does matter — which is why the keying itself now
// lives in lib/perUserStorage rather than being spelled out a third time here.
// Stored as bagful-household-snapshot until the households→lists rename caught
// up with it; lib/legacyStorage carries old snapshots over to this name.
const STORAGE_PREFIX = 'bagful-list-snapshot'
// Bumped 1→2 for the households→lists rename: a version-1 snapshot's fields
// are `householdId` etc., not `listId`, and this module has no interest in
// reading that shape back out. It is only a cache, so discarding it costs one
// slower boot while the first fetch refills it.
const VERSION = 2

function snapshotKey(userId: string): string {
  return userScopedKey(STORAGE_PREFIX, userId)
}

// Older than this and the snapshot is more likely to confuse than help.
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Everything else in a snapshot is display text that gets escaped on its way to
// the DOM, and is overwritten by the first fetch anyway. The list id is
// different: it is read back out as a QUERY parameter, and one of its uses
// (lib/productSuggestions) interpolates it into a PostgREST `or` filter, whose
// syntax is comma- and dot-separated. The comment there is right that the id is
// server-issued — but only on the live path. Restored from a snapshot it is
// whatever localStorage happened to hold, and localStorage is not a trust
// boundary the app controls.
//
// RLS is still what decides which rows anyone may see, so this is not the thing
// standing between a tampered cache and another list. It is the
// cheap check that keeps a value that was never an id from being spliced into a
// filter expression at all.
//
// Deliberately "an opaque identifier" rather than "a uuid", though in
// production it is always the latter. What has to be excluded is PostgREST's
// filter syntax — the comma that separates conditions, the dot that separates
// column from operator, parens, colons, quotes, whitespace — and an allowlist
// of identifier characters excludes all of it. Demanding the full uuid shape
// would additionally assert a storage format this module has no reason to
// care about, and would break on any future id scheme without being any safer
// against the thing it is actually guarding.
const LIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function isListId(value: unknown): value is string {
  return typeof value === 'string' && LIST_ID_PATTERN.test(value)
}

export function loadListSnapshot(
  storage: Storage,
  userId: string,
  now: number = Date.now(),
): ListSnapshot | null {
  try {
    const raw = storage.getItem(snapshotKey(userId))
    if (!raw) return null
    const stored = JSON.parse(raw) as StoredSnapshot
    if (stored.version !== VERSION) return null
    // Never show one account's list to another account on the same browser.
    if (stored.userId !== userId) return null
    if (now - stored.savedAt > SNAPSHOT_MAX_AGE_MS) return null
    if (!isListId(stored.listId) || !Array.isArray(stored.items) || !Array.isArray(stored.listMembers)) {
      return null
    }
    return {
      listId: stored.listId,
      listName: stored.listName ?? '',
      listInviteCode: stored.listInviteCode ?? '',
      listOwnerId: stored.listOwnerId ?? '',
      listItemLimit: typeof stored.listItemLimit === 'number' ? stored.listItemLimit : 50,
      listEmoji: stored.listEmoji ?? '',
      listMembers: stored.listMembers,
      items: stored.items,
      // Snapshots written before this field existed are still version 1, so
      // default rather than discard them: false is the pre-existing behaviour.
      hasShopped: stored.hasShopped === true,
    }
  } catch {
    return null
  }
}

export function saveListSnapshot(
  storage: Storage,
  userId: string,
  snapshot: ListSnapshot,
  now: number = Date.now(),
): void {
  const stored: StoredSnapshot = { ...snapshot, version: VERSION, userId, savedAt: now }
  try {
    storage.setItem(snapshotKey(userId), JSON.stringify(stored))
  } catch {
    // Quota exceeded or storage disabled — skip; the app works without it.
  }
}

// `userId` scopes it to one account. Without one — a caller that cannot say
// whose snapshot this is — every account's is cleared, which is the safer end of
// the trade on a shared browser. Same signature and same reasoning as
// clearOfflineQueue, and now the same implementation.
export function clearListSnapshot(storage: Storage, userId?: string): void {
  clearUserScopedKeys(storage, STORAGE_PREFIX, userId)
}

// Which of a user's lists is currently active, so the choice survives
// reloads. The stored id is only a hint: HomeView uses it only if it still
// matches a live membership, otherwise it falls back to the first list.
//
// ONE RECORD PER ACCOUNT, which this was the last of the four to become.
//
// The offline queue, the snapshot above and the notification preference were
// each moved off a single device-wide key holding a stamped userId, one at a
// time, and lib/perUserStorage was written so the argument would not have to be
// made a fourth time. This was the fourth. Reading was always safe — every one
// of them ignores a record belonging to somebody else — but the single key held
// whichever account saved last, so B signing in destroyed A's outright.
//
// What that costs here is the mildest of the four by a distance: A lands on
// their first list instead of the one they last picked. It is fixed anyway
// because it is the same shape one severity down, and leaving the shape in place
// is how it comes back somewhere it matters.
// Was bagful-active-household; carried over the same way as STORAGE_PREFIX.
const ACTIVE_LIST_PREFIX = 'bagful-active-list'

function activeListKey(userId: string): string {
  return userScopedKey(ACTIVE_LIST_PREFIX, userId)
}

export function loadActiveListId(storage: Storage, userId: string): string | null {
  try {
    const raw = storage.getItem(activeListKey(userId))
    if (!raw) return null
    const stored = JSON.parse(raw) as { userId?: string; listId?: string; householdId?: string }
    if (stored.userId !== userId) return null
    // Same reasoning as the snapshot above. This one is checked against live
    // memberships before it is used, so it is the better-guarded of the two —
    // but both end up in the same place, and only one of them being validated
    // is how the unvalidated one gets forgotten.
    //
    // `householdId` is the field a pre-rename build wrote under this same key;
    // nothing rewrites that record in place, so a returning phone still has
    // to be read as its old name until it saves again under the new one.
    const active = stored.listId || stored.householdId || null
    return isListId(active) ? active : null
  } catch {
    return null
  }
}

export function saveActiveListId(storage: Storage, userId: string, listId: string): void {
  try {
    storage.setItem(activeListKey(userId), JSON.stringify({ userId, listId }))
  } catch {
    // Storage disabled — the active list just won't persist across reloads.
  }
}

// `userId` scopes it to one account. Without one — a sign-out from a screen that
// does not know who is signed in — every account's choice on the device is
// cleared, which is the safer end of the trade on a shared browser. Same
// signature and same reasoning as clearListSnapshot and clearOfflineQueue.
export function clearActiveListId(storage: Storage, userId?: string): void {
  clearUserScopedKeys(storage, ACTIVE_LIST_PREFIX, userId)
}
