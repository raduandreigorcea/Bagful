import type { SupabaseClient } from '@supabase/supabase-js'
import { findActiveItemByName, type ShoppingItem } from './shoppingList'
import { captureException } from './errorReporting'
import { clearUserScopedKeys, userScopedKey } from './perUserStorage'
import { sumQuantities } from './limits'

// Write queue for shopping-list mutations made while offline. The views apply
// every mutation optimistically already; when the browser reports no
// connectivity they enqueue the write here instead of hitting the network, and
// replay the queue in order once connectivity returns. The queue is keyed to
// one user (like the list snapshot) and survives restarts via localStorage,
// pairing with the snapshot cache: the snapshot restores what the list looked
// like, the queue restores what still has to reach the server.

export type OfflineMutation =
  | { kind: 'insert'; id: string; row: Record<string, unknown> }
  | { kind: 'update'; id: string; patch: Record<string, unknown> }
  | { kind: 'delete'; id: string }
  // A checkout made offline, replayed through buy_items so it still reaches
  // purchase history (and the list's push) instead of being queued as bare
  // deletes, which it used to be. `id` names the checkout, not a row, so the
  // per-row coalescing below never touches it. Safe to replay late or twice:
  // buy_items moves only rows that are still ticked and in the caller's
  // list, so a row already bought, or unticked since by someone else, is
  // simply not moved. The ticks it relies on are queued before it, in order.
  | { kind: 'checkout'; id: string; ids: string[] }

export interface FlushResult {
  // Mutations acknowledged by the server (including inserts folded into a
  // concurrent same-name row).
  flushed: number
  // Mutations the server permanently rejected; they are dropped so one bad
  // write can never wedge the queue.
  failed: number
  // True when a network-level failure stopped the replay; the unsent tail is
  // kept for the next attempt.
  interrupted: boolean
}

interface StoredQueue {
  version: number
  userId: string
  mutations: OfflineMutation[]
}

// Only the query-builder entry point, and rpc for a checkout, are used here, and
// typing them as the real client keeps the `any` out: SupabaseClient['from'] carries PostgREST's own
// builder types, so a typo in a filter or a patch is caught rather than waved
// through. Structural rather than the whole client so tests can hand in a fake.
type Db = Pick<SupabaseClient, 'from' | 'rpc'>

// One queue per account, rather than one queue with an account stamped on it.
//
// The stamped version was safe to READ — a queue belonging to someone else was
// ignored, so writes were never replayed as the wrong user. It was not safe to
// WRITE: the ignored queue still occupied the one key, so the next mutation
// enqueued by a different account overwrote it wholesale, and the first
// account's unsent writes were gone with nothing said. Signing out clears the
// queue deliberately (see clearOfflineQueue), so this only bit when a session
// ended some other way — an expired Clerk session, then somebody else signing in
// on the same device — which is exactly the case the queue exists to survive.
const STORAGE_PREFIX = 'bagful-offline-queue'
// What every build before this one wrote: a single key holding whichever
// account's queue was last saved. Read once and migrated on the next save.
//
// This and renameLegacyRowKeys below are the last of the pre-rename shims. The
// others (snapshot, active list, update and push keys) were removed on
// 2026-09-22; these stayed because removing them loses writes rather than a
// cache. Safe to delete from 2026-11-14, three months after the newer of the two.
const LEGACY_STORAGE_KEY = STORAGE_PREFIX
const VERSION = 1
const TABLE = 'shopping_list_items'

// A ceiling on how many unsent mutations one account may accumulate.
//
// Without one the only limit was localStorage's own quota, which is a bad place
// to find the edge: it is device-dependent, it arrives as an exception in the
// middle of a write, and saveOfflineQueue swallows it — so the queue silently
// stopped accepting anything and the user was told nothing. A fixed bound turns
// that into a predictable, reportable event well before the browser's cliff.
//
// Deliberately generous. Coalescing already collapses repeat edits to a row
// (see enqueueOfflineMutation), so reaching this means hundreds of DISTINCT
// operations without connectivity — far past any real shopping trip, and a
// strong hint that something else is wrong.
const MAX_QUEUED_MUTATIONS = 500

function queueKey(userId: string): string {
  return userScopedKey(STORAGE_PREFIX, userId)
}

// A queued insert carries the literal row it will POST, so a mutation enqueued
// before either rename still says `family_id` (families→households) or
// `household_id` (households→lists) — columns that no longer exist. Replaying
// one would fail permanently, and this queue drops permanent failures by
// design, so the user would silently lose whatever they added while offline
// during either upgrade. Rewriting the key on the way out is the whole fix;
// both legacy names are stripped regardless of which one (if either) is
// present, so a row can never leak a column the server no longer has.
function renameLegacyRowKeys(row: Record<string, unknown>): Record<string, unknown> {
  if (!('family_id' in row) && !('household_id' in row)) return row
  const { family_id: familyId, household_id: householdId, ...rest } = row
  return { ...rest, list_id: rest.list_id ?? householdId ?? familyId }
}

export function loadOfflineQueue(storage: Storage, userId: string): OfflineMutation[] {
  try {
    // The legacy single key is the fallback, not the primary: a queue written by
    // the previous build is still worth replaying, and it carries the userId
    // check below to decide whether it is this account's. The next save moves it
    // to the per-user key.
    const raw = storage.getItem(queueKey(userId)) ?? storage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const stored = JSON.parse(raw) as StoredQueue
    if (stored.version !== VERSION) return []
    // Never replay one account's writes as another account on the same browser.
    // Still checked despite the key now carrying the user id, because the legacy
    // key read above has no such guarantee.
    if (stored.userId !== userId) return []
    if (!Array.isArray(stored.mutations)) return []
    return stored.mutations.map((mutation) =>
      mutation.kind === 'insert'
        ? { ...mutation, row: renameLegacyRowKeys(mutation.row) }
        : mutation,
    )
  } catch {
    return []
  }
}

// Enforced here rather than at the append, because "append" is three different
// paths: a plain push, and the coalescing update and delete branches that each
// rewrite the list and return early. This is the one place all of them, and the
// flush's own shrinking rewrites, have to pass through.
function saveOfflineQueue(storage: Storage, userId: string, queued: OfflineMutation[]): void {
  const mutations = enforceQueueBound(queued)
  try {
    // Whatever happens to this account's queue, the legacy single key is
    // superseded by it — it held this same queue a moment ago, and leaving it
    // would let loadOfflineQueue fall back to a stale copy once the per-user key
    // is emptied below.
    storage.removeItem(LEGACY_STORAGE_KEY)
    if (!mutations.length) {
      storage.removeItem(queueKey(userId))
      return
    }
    const stored: StoredQueue = { version: VERSION, userId, mutations }
    storage.setItem(queueKey(userId), JSON.stringify(stored))
  } catch (error) {
    // Quota exceeded or storage disabled — the write is lost on restart, but
    // the in-session optimistic state still stands.
    //
    // Reported rather than merely swallowed. This is unsent work disappearing,
    // which is the exact failure this whole file exists to prevent, and with
    // the bound above it should now be unreachable — so if it does happen, the
    // reasoning behind MAX_QUEUED_MUTATIONS is wrong and that is worth knowing.
    captureException(error)
  }
}

// Append a mutation, coalescing against what is already queued so the replay
// sends the fewest requests and never touches rows the server has never seen:
// - update after a queued insert folds the patch into the insert row
// - update after a queued update merges the patches (fields are absolute values)
// - delete of a queued insert cancels the insert (and its updates) entirely
// - delete otherwise supersedes any queued updates for that row
export function enqueueOfflineMutation(
  storage: Storage,
  userId: string,
  mutation: OfflineMutation,
): void {
  const mutations = loadOfflineQueue(storage, userId)

  if (mutation.kind === 'update') {
    const insert = mutations.find(
      (m): m is Extract<OfflineMutation, { kind: 'insert' }> =>
        m.kind === 'insert' && m.id === mutation.id,
    )
    if (insert) {
      insert.row = { ...insert.row, ...mutation.patch }
      saveOfflineQueue(storage, userId, mutations)
      return
    }
    const update = mutations.find(
      (m): m is Extract<OfflineMutation, { kind: 'update' }> =>
        m.kind === 'update' && m.id === mutation.id,
    )
    if (update) {
      update.patch = { ...update.patch, ...mutation.patch }
      saveOfflineQueue(storage, userId, mutations)
      return
    }
  }

  if (mutation.kind === 'delete') {
    const hadQueuedInsert = mutations.some((m) => m.kind === 'insert' && m.id === mutation.id)
    const kept = mutations.filter((m) => m.id !== mutation.id)
    // The row only ever existed locally — nothing to delete on the server.
    if (hadQueuedInsert) {
      saveOfflineQueue(storage, userId, kept)
      return
    }
    kept.push(mutation)
    saveOfflineQueue(storage, userId, kept)
    return
  }

  mutations.push(mutation)
  saveOfflineQueue(storage, userId, mutations)
}

// Keep the queue inside its ceiling, dropping from the front when it is over.
//
// Which end to drop is the real decision, and neither answer is free — at this
// point work is being lost either way. The oldest goes because the newest is
// what the user just did and is looking at right now: refusing that one instead
// would leave a row on screen that was never going to be saved, which is the
// more dishonest of the two. Replay is in order, so the front is also the part
// most likely already reflected in what the server has.
//
// Only ever reached in a situation this queue was not designed for, so it
// reports: silently discarding a user's writes is precisely the outcome this
// file is built to avoid, and it should never be inferred from a support
// ticket.
function enforceQueueBound(mutations: OfflineMutation[]): OfflineMutation[] {
  if (mutations.length <= MAX_QUEUED_MUTATIONS) return mutations
  const dropped = mutations.length - MAX_QUEUED_MUTATIONS
  captureException(
    new Error(
      `Offline queue exceeded ${MAX_QUEUED_MUTATIONS} mutations; dropped ${dropped} of the oldest.`,
    ),
  )
  return mutations.slice(dropped)
}

export function hasQueuedOfflineMutations(storage: Storage, userId: string): boolean {
  return loadOfflineQueue(storage, userId).length > 0
}

// Called on sign-out, which is a deliberate "this account is done on this
// device" — so unsent writes going with it is the intended behaviour, not the
// accident this file's per-user keying exists to prevent.
//
// `userId` scopes it to one account. Without one — a sign-out from a screen that
// does not know who is signed in — every Bagful queue on the device is cleared,
// which is the safer end of the trade on a shared browser.
export function clearOfflineQueue(storage: Storage, userId?: string): void {
  try {
    // The device-wide predecessor, whose name only this module knows. Always
    // removed: it belongs to no account, so there is nothing to scope it by.
    storage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Storage disabled — nothing to clear.
  }
  clearUserScopedKeys(storage, STORAGE_PREFIX, userId)
}

// A request that died at the network layer (or while the browser still reports
// offline) will succeed later — keep the mutation. Anything the server actually
// answered (it has an error `code`) is a real rejection.
//
// `navigator.onLine === false` is a reliable *positive* offline signal but an
// unreliable *negative* one: an Android WebView (and desktop browsers on a
// captive/dead network) often reports `true` with no real connectivity. So we
// also match the fetch-failure message that Supabase surfaces in that case,
// letting callers route the failure through the offline path instead of showing
// a raw "TypeError: Failed to fetch" error.
export function isOfflineError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (!error) return false
  const code = (error as { code?: string }).code
  if (code) return false
  const message = (error as { message?: string }).message ?? String(error)
  return /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(
    message,
  )
}

// The item-insert ceiling in 004_shopping_list.sql, recognised by the
// detail string that migration raises with.
//
// This matters most here rather than in the UI. A flush treats anything the
// server actually answered as a permanent rejection and DROPS it, so that one
// bad write can never wedge the queue — correct for a row the server will refuse
// forever, and exactly wrong for one it is merely refusing right now. Replaying
// a long offline trip is the case most likely to reach the ceiling and the case
// where losing the writes is most expensive, so a throttled mutation is kept and
// retried instead.
//
// Both `message` and `details` are checked: PostgREST surfaces a raised
// exception's DETAIL in `details`, but the shape has moved between versions and
// the queue is not where a silent data-loss bug should hide behind one field.
export function isRateLimitedError(error: unknown): boolean {
  if (!error) return false
  const { message, details } = error as { message?: string; details?: string }
  return `${message ?? ''} ${details ?? ''}`.includes('item_insert_rate_limit_exceeded')
}

// The per-member active-item cap, rejected by the trigger in
// 004_shopping_list.sql. Two paths hit it — adding, and unchecking a row back
// into the active set — and both answer it with the same friendly popup rather
// than an error, so both need the same question answered the same way.
//
// It lives beside isRateLimitedError because it is the same KIND of thing: a
// server rejection that is a rule doing its job, not a fault, told apart from a
// real failure by sniffing a raised exception's text. Sniffing is fragile, which
// is the argument for having exactly one copy of it rather than the two
// hand-written ones this replaces.
//
// `details` is read as well as `message`, which neither copy did: PostgREST
// surfaces a raised exception's DETAIL there, and the field it lands in has
// moved between versions — the same reason isRateLimitedError above checks both.
// A cap misread as a fault shows a generic error where the friendly popup
// belongs, and reports the trigger to Sentry.
//
// Only the machine token, which the trigger raises as its DETAIL. It also used
// to match the words `limit of` in the human message, the trigger's older
// wording, which any other error saying "limit of" would have matched too.
export function isItemLimitError(error: unknown): boolean {
  if (!error) return false
  const { message, details } = error as { message?: string; details?: string }
  return `${message ?? ''} ${details ?? ''}`.includes('member_active_item_limit_exceeded')
}

async function applyMutation(
  db: Db,
  mutation: OfflineMutation,
): Promise<{ ok: boolean; transient: boolean }> {
  if (mutation.kind === 'insert') {
    const { error } = await db.from(TABLE).insert(mutation.row)
    if (!error) return { ok: true, transient: false }
    // Throttled, not rejected: keep it for the next attempt (see above).
    if (isRateLimitedError(error)) return { ok: false, transient: true }
    // Someone added the same item while we were offline: fold our quantity into
    // their row, mirroring the insert-race handling in HomeView.
    if (error.code === '23505') {
      // Every row, ticked ones included, so the first question can be asked of
      // them all: is the row we collided with OUR OWN? A 23505 is also what the
      // primary key answers when this insert already landed -- the request
      // reached the server and only the reply was lost, which queued it as
      // offline, or two flushes sent the same head. Folding then found the row
      // itself by name and added its quantity to itself: 2 milk became 4. It is
      // done, not rejected. Ticked rows count because it may have been ticked
      // since, and would then be missed by a read of the active ones.
      const { data, error: selectErr } = await db
        .from(TABLE)
        .select('*')
        .eq('list_id', mutation.row.list_id)
      if (selectErr) return { ok: false, transient: isOfflineError(selectErr) }
      const rows = (data ?? []) as ShoppingItem[]
      if (rows.some((row) => row.id === mutation.id)) return { ok: true, transient: false }
      // The live equivalent of this lookup is resolveActiveItemByName in
      // shoppingListActions.ts, which the add and uncheck paths share. This one
      // stays separate deliberately: it has no local list to splice a fetched
      // row into, and it has to classify the failure as transient or permanent
      // for the replay loop. Change the match rule in either and check the
      // other — that is exactly what went wrong below.
      //
      // The maker is half the match key, and leaving it out was silent data
      // loss. shopping_list_items_unique_active_name (004_shopping_list.sql) is
      // on (list_id, name, coalesce(maker, '')), so a 23505 on a row that
      // HAS a maker means the row it collided with has that same maker — while
      // findActiveItemByName with no maker option looks for '' and matches only
      // maker-less rows. It therefore found nothing, this returned a permanent
      // rejection, and the flush dropped the mutation by design. Every catalog
      // pick and every barcode scan carries a maker, so that was the common
      // path, not an edge one.
      const target = findActiveItemByName(rows, String(mutation.row.name), {
        maker: (mutation.row.maker as string | null) ?? null,
      })
      // Still nothing to fold into: the server says this product is already
      // active here and we cannot see the row (checked between the insert and
      // this read, or gone). Dropped rather than kept, because a replay would
      // hit the same 23505 forever and wedge the queue behind it.
      if (!target) return { ok: false, transient: false }
      const merged = sumQuantities(Number(target.quantity) || 1, Number(mutation.row.quantity) || 1)
      const { error: updateErr } = await db
        .from(TABLE)
        .update({ quantity: merged })
        .eq('id', target.id)
      if (updateErr) return { ok: false, transient: isOfflineError(updateErr) }
      return { ok: true, transient: false }
    }
    return { ok: false, transient: isOfflineError(error) }
  }

  if (mutation.kind === 'checkout') {
    const { error } = await db.rpc('buy_items', { p_item_ids: mutation.ids })
    if (!error) return { ok: true, transient: false }
    return { ok: false, transient: isOfflineError(error) }
  }

  if (mutation.kind === 'update') {
    const { error } = await db.from(TABLE).update(mutation.patch).eq('id', mutation.id)
    if (!error) return { ok: true, transient: false }
    return { ok: false, transient: isOfflineError(error) }
  }

  const { error } = await db.from(TABLE).delete().eq('id', mutation.id)
  if (!error) return { ok: true, transient: false }
  return { ok: false, transient: isOfflineError(error) }
}

// Whether two queued mutations are the same intent, for the purpose of striking
// one off after it has been sent.
//
// Kind and id, not deep equality. A coalesce landing during the request can
// rewrite the row of a queued insert in place (see enqueueOfflineMutation), and
// a mutation that no longer deep-equals the one we sent is still the one we
// sent — refusing to recognise it would leave it at the head forever.
function isSameMutation(a: OfflineMutation, b: OfflineMutation): boolean {
  return a.kind === b.kind && a.id === b.id
}

// Replay the queue in order. The queue is persisted after every mutation so an
// interruption (tab closed, network dropped again) never replays an
// acknowledged write. Callers should re-fetch the list afterwards so local
// state converges on the server's.
//
// STORAGE IS RE-READ AROUND EVERY REQUEST, and that is the whole shape of this
// loop rather than a detail of it.
//
// This used to load the queue once and write that array back after each
// mutation. Every one of those writes therefore restored a snapshot taken
// before the loop started — so anything enqueueOfflineMutation had written
// during the preceding `await` was overwritten and gone, with the optimistic
// row still on screen and nothing said. The window is not theoretical: a flush
// runs on reconnect, on focus and on every watchdog tick, and costs a round
// trip per mutation. If the connection drops inside one, the user's next tap
// takes the offline path, lands in storage, and was erased by the next
// iteration. Silent loss of a user's writes, in the module written to prevent
// exactly that.
//
// So the queue in storage is the authority throughout, and this only ever
// strikes off the one mutation it has just settled.
export async function flushOfflineQueue(
  storage: Storage,
  userId: string,
  db: Db,
): Promise<FlushResult> {
  const result: FlushResult = { flushed: 0, failed: 0, interrupted: false }

  for (;;) {
    // Re-read rather than carry an array across the await below: a mutation
    // enqueued during the previous request has to be picked up, not replaced.
    const queued = loadOfflineQueue(storage, userId)
    if (!queued.length) return result

    const sent = queued[0]!
    const { ok, transient } = await applyMutation(db, sent)

    // The window closed. Whatever is in storage now is what the next decision
    // has to be made against.
    const current = loadOfflineQueue(storage, userId)

    if (!ok && transient) {
      result.interrupted = true
      // Nothing was acknowledged, so nothing comes off. Written back anyway —
      // unchanged in content — because loadOfflineQueue is also what migrates a
      // queue found under the legacy device-wide key, and a flush that stops on
      // its first mutation would otherwise never persist that migration.
      saveOfflineQueue(storage, userId, current)
      return result
    }

    if (ok) result.flushed++
    else result.failed++

    // Strike off what was just settled, and only that. Anything enqueued while
    // it was on the wire sits behind it and survives untouched.
    //
    // The head can fail to match: a delete arriving for a row whose insert was
    // in flight cancels that insert out of the queue entirely, so there is
    // nothing left to remove. Leaving the queue alone is right there, and the
    // loop still makes progress because the next pass reads a different head.
    if (current.length && isSameMutation(current[0]!, sent)) {
      saveOfflineQueue(storage, userId, current.slice(1))
    }
  }
}
