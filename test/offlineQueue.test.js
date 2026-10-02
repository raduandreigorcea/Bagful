// Unit tests for the offline write queue: coalescing rules keep the replay
// minimal and never touch rows the server has never seen; the flush must
// survive interruptions without replaying acknowledged writes and must never
// let one rejected mutation wedge the rest of the queue.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  loadOfflineQueue,
  enqueueOfflineMutation,
  hasQueuedOfflineMutations,
  clearOfflineQueue,
  flushOfflineQueue,
  isItemLimitError,
  isRateLimitedError,
} from '../src/lib/offlineQueue'
import { createFakeDb } from './support/fakeSupabase.js'
import { makeStorage } from './support/fakeStorage.js'

const USER = 'user-1'

function insertMutation(id, overrides = {}) {
  return {
    kind: 'insert',
    id,
    row: { id, list_id: 'fam-1', name: 'Milk', quantity: 1, ...overrides },
  }
}

describe('enqueueOfflineMutation', () => {
  it('round-trips mutations in order, keyed to the user', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'server-row' })

    expect(loadOfflineQueue(storage, USER).map((m) => m.kind)).toEqual(['insert', 'delete'])
    // Another account on the same browser must never see (or replay) this queue.
    expect(loadOfflineQueue(storage, 'user-2')).toEqual([])
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(true)

    clearOfflineQueue(storage)
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  it('returns an empty queue for corrupted storage instead of throwing', () => {
    const storage = makeStorage()
    storage.setItem('bagful-offline-queue', '{not json')
    expect(loadOfflineQueue(storage, USER)).toEqual([])
  })

  it('folds an update into a queued insert for the same row', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a', { quantity: 1 }))
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { quantity: 3 } })

    const queue = loadOfflineQueue(storage, USER)
    expect(queue).toHaveLength(1)
    expect(queue[0].kind).toBe('insert')
    expect(queue[0].row.quantity).toBe(3)
  })

  it('merges consecutive updates for the same row (absolute values, last wins)', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { quantity: 2 } })
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { quantity: 5, checked: true } })

    const queue = loadOfflineQueue(storage, USER)
    expect(queue).toHaveLength(1)
    expect(queue[0].patch).toEqual({ quantity: 5, checked: true })
  })

  it('cancels a queued insert (and its updates) when the row is deleted offline', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'a' })

    expect(loadOfflineQueue(storage, USER)).toEqual([])
  })

  it('supersedes queued updates with the delete for a server row', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-1' })

    const queue = loadOfflineQueue(storage, USER)
    expect(queue).toEqual([{ kind: 'delete', id: 'srv-1' }])
  })
})

describe('flushOfflineQueue', () => {
  it('replays mutations in order and empties the queue', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-2' })

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({ data: null, error: null })
    db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })
    db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 3, failed: 0, interrupted: false })
    expect(db.calls.map((q) => q.op)).toEqual(['insert', 'update', 'delete'])
    expect(db.calls[1].filters.id).toBe('srv-1')
    expect(db.calls[2].filters.id).toBe('srv-2')
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // An offline checkout used to be queued as bare deletes, so it never reached
  // purchase history. A row added, ticked and bought all offline is the hard
  // case: it has to be inserted (ticked) first, or buy_items has nothing to move.
  it('replays an offline checkout through buy_items, after the rows it buys', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'checkout', id: 'co-1', ids: ['a'] })

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({ data: null, error: null })
    db.handlers['rpc.buy_items'] = () => ({ data: 1, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 2, failed: 0, interrupted: false })
    expect(db.calls.map((q) => q.op)).toEqual(['insert', 'buy_items'])
    expect(db.calls[0].payload.checked).toBe(true)
    expect(db.calls[1].params).toEqual({ p_item_ids: ['a'] })
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  it('keeps each account queue separate when a session ends without signing out', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    // A different account enqueues on the same device. This used to overwrite
    // the single shared key and lose USER's unsent writes silently.
    enqueueOfflineMutation(storage, 'user-2', insertMutation('b'))

    expect(loadOfflineQueue(storage, USER).map((m) => m.id)).toEqual(['a'])
    expect(loadOfflineQueue(storage, 'user-2').map((m) => m.id)).toEqual(['b'])
  })

  it('migrates a queue written under the pre-per-user key', () => {
    const storage = makeStorage()
    // Exactly what an older build left behind: one key, the account stamped inside.
    storage.setItem(
      'bagful-offline-queue',
      JSON.stringify({ version: 1, userId: USER, mutations: [insertMutation('a')] }),
    )

    expect(loadOfflineQueue(storage, USER).map((m) => m.id)).toEqual(['a'])
    // Another account still must not see it.
    expect(loadOfflineQueue(storage, 'user-2')).toEqual([])

    // The next save moves it across and retires the old key, so an emptied
    // per-user queue cannot fall back to this stale copy.
    enqueueOfflineMutation(storage, USER, insertMutation('b'))
    expect(storage.getItem('bagful-offline-queue')).toBeNull()
    expect(loadOfflineQueue(storage, USER).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('is a no-op on an empty queue', async () => {
    const db = createFakeDb()
    const result = await flushOfflineQueue(makeStorage(), USER, db)
    expect(result).toEqual({ flushed: 0, failed: 0, interrupted: false })
    expect(db.calls).toHaveLength(0)
  })

  it('folds a conflicting insert (23505) into the concurrent same-name row', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a', { name: 'Milk', quantity: 2 }))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    db.handlers['shopping_list_items.select'] = () => ({
      data: [{ id: 'srv-1', name: 'milk', checked: false, quantity: 3 }],
      error: null,
    })
    db.handlers['rpc.add_item_quantity'] = () => ({ data: 5, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 1, failed: 0, interrupted: false })
    // Added to whatever the row holds when it lands, not to the copy just read.
    const update = db.calls.find((q) => q.op === 'add_item_quantity')
    expect(update.params).toEqual({ p_id: 'srv-1', p_delta: 2 })
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // The maker is half the match key (004_shopping_list.sql), and the fold used
  // to ignore it — so a conflict on a product that has one found no target,
  // counted as a permanent rejection, and was dropped. Every catalog pick and
  // every barcode scan carries a maker, so this was the common path.
  it('folds a conflicting insert into the same-name row with the same maker', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(
      storage,
      USER,
      insertMutation('a', { name: 'Lapte 3.5% 1L', maker: 'Napolact', quantity: 2 }),
    )

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    db.handlers['shopping_list_items.select'] = () => ({
      data: [
        // Same name, different maker: a different product, and not the row we
        // collided with.
        { id: 'srv-other', name: 'Lapte 3.5% 1L', maker: 'LaDorna', checked: false, quantity: 9 },
        { id: 'srv-1', name: 'lapte 3.5% 1l', maker: 'napolact', checked: false, quantity: 3 },
      ],
      error: null,
    })
    db.handlers['rpc.add_item_quantity'] = () => ({ data: 5, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 1, failed: 0, interrupted: false })
    // Added to whatever the row holds when it lands, not to the copy just read.
    const update = db.calls.find((q) => q.op === 'add_item_quantity')
    expect(update.params).toEqual({ p_id: 'srv-1', p_delta: 2 })
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // The primary key answers 23505 too, when this very insert already landed and
  // only its reply was lost. Folding then found the row itself by name and added
  // its quantity to itself.
  it('treats a conflict with its own row as already done, not as a fold', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a', { name: 'Milk', quantity: 2 }))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    db.handlers['shopping_list_items.select'] = () => ({
      data: [{ id: 'a', name: 'Milk', checked: false, quantity: 2 }],
      error: null,
    })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 1, failed: 0, interrupted: false })
    expect(db.calls.find((q) => q.op === 'add_item_quantity')).toBeUndefined()
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // The bound is add_item_quantity's to hold (004_shopping_list.sql, pinned in
  // rls.test.sql): it clamps against the row as it is when the change lands,
  // which a number worked out here from an older read could not.
  it('sends a folded quantity as the change, leaving the bound to the server', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a', { name: 'Milk', quantity: 600 }))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })
    db.handlers['shopping_list_items.select'] = () => ({
      data: [{ id: 'srv-1', name: 'milk', checked: false, quantity: 600 }],
      error: null,
    })
    db.handlers['rpc.add_item_quantity'] = () => ({ data: 999, error: null })

    await flushOfflineQueue(storage, USER, db)

    expect(db.calls.find((q) => q.op === 'add_item_quantity').params.p_delta).toBe(600)
  })

  it('stops on a network-level failure and keeps the unsent tail', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-2' })

    const db = createFakeDb()
    db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { message: 'TypeError: Failed to fetch' },
    })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 0, failed: 0, interrupted: true })
    // Both mutations survive for the next attempt — nothing was acknowledged.
    expect(loadOfflineQueue(storage, USER)).toHaveLength(2)
  })

  it('drops a permanently rejected mutation and continues with the rest', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { checked: true } })
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-2' })

    const db = createFakeDb()
    db.handlers['shopping_list_items.update'] = () => ({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    })
    db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 1, failed: 1, interrupted: false })
    expect(db.calls.map((q) => q.op)).toEqual(['update', 'delete'])
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // A flush is a sequence of round trips, and the user is still using the app
  // during them. On a flaky connection their next tap fails at the network
  // layer, takes the offline path, and lands in storage — while the flush is
  // between two of its own writes. The flush must not carry a queue it read
  // before that happened back over the top of it.
  //
  // The handler below enqueues from inside the request, which is exactly the
  // window: after the flush loaded the queue, before it saves it again.
  it('sends a write enqueued while a mutation was on the wire', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-1' })

    const db = createFakeDb()
    // One tap, during the first request only — otherwise replaying the write it
    // adds would add another, forever.
    let tapped = false
    db.handlers['shopping_list_items.insert'] = () => {
      if (!tapped) {
        tapped = true
        // The tap that happened while this insert was in flight.
        enqueueOfflineMutation(storage, USER, insertMutation('late'))
      }
      return { data: null, error: null }
    }
    db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    // Three, not two: the write made mid-flush is picked up by this same flush
    // rather than being overwritten by the queue it read before that tap.
    expect(result).toEqual({ flushed: 3, failed: 0, interrupted: false })
    expect(db.calls.filter((q) => q.op === 'insert').map((q) => q.payload.id)).toEqual([
      'a',
      'late',
    ])
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // The insert has already left, so cancelling it out of the queue cannot
  // recall it: the row landed with nothing left to delete it, and came back on
  // the next refetch.
  it('still deletes a row whose insert was on the wire when it was deleted', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => {
      enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'a' })
      return { data: null, error: null }
    }
    db.handlers['shopping_list_items.delete'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 2, failed: 0, interrupted: false })
    expect(db.calls.filter((q) => q.op === 'delete').map((q) => q.filters.id)).toEqual(['a'])
    expect(hasQueuedOfflineMutations(storage, USER)).toBe(false)
  })

  // Same window: folding the patch into an insert that has already been sent
  // changes a row nobody will send again, so the change was lost.
  it('still sends an update made while the row insert was on the wire', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => {
      enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'a', patch: { quantity: 3 } })
      return { data: null, error: null }
    }
    db.handlers['shopping_list_items.update'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 2, failed: 0, interrupted: false })
    expect(db.calls.filter((q) => q.op === 'update').map((q) => q.payload)).toEqual([{ quantity: 3 }])
  })

  it('still sends an update made while an earlier update of the row was on the wire', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { quantity: 2 } })

    const db = createFakeDb()
    let tapped = false
    db.handlers['shopping_list_items.update'] = () => {
      if (!tapped) {
        tapped = true
        enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { quantity: 3 } })
      }
      return { data: null, error: null }
    }

    await flushOfflineQueue(storage, USER, db)

    expect(db.calls.filter((q) => q.op === 'update').map((q) => q.payload)).toEqual([
      { quantity: 2 },
      { quantity: 3 },
    ])
  })

  // Same window, on the path that stops early. The transient branch used to
  // persist its own snapshot too, so it dropped a concurrent write just as the
  // acknowledged path did.
  it('keeps a write enqueued while an interrupted mutation was on the wire', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'update', id: 'srv-1', patch: { checked: true } })

    const db = createFakeDb()
    db.handlers['shopping_list_items.update'] = () => {
      enqueueOfflineMutation(storage, USER, insertMutation('late'))
      return { data: null, error: { message: 'TypeError: Failed to fetch' } }
    }

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 0, failed: 0, interrupted: true })
    // The unsent update, and the write made while it was failing.
    expect(loadOfflineQueue(storage, USER).map((m) => m.id)).toEqual(['srv-1', 'late'])
  })
})

// The item-insert ceiling in 004_shopping_list.sql. A throttled write
// looks like a permanent rejection to the flush -- the server answered, so it
// carries an error code -- and would be DROPPED by the rule directly above this.
// That is the wrong call for a refusal that expires: replaying a long offline
// trip is both the likeliest way to reach the ceiling and the costliest place to
// lose writes.
describe('rate-limited writes', () => {
  const throttled = {
    code: 'P0001',
    message: 'Too many items added in a short time. Try again shortly.',
    details: 'item_insert_rate_limit_exceeded',
  }

  it('recognises the throttle in either field the server may use', () => {
    expect(isRateLimitedError(throttled)).toBe(true)
    // PostgREST has moved DETAIL between fields across versions; the queue is
    // not where a silent data-loss bug should hide behind one of them.
    expect(isRateLimitedError({ message: 'item_insert_rate_limit_exceeded' })).toBe(true)
    expect(isRateLimitedError({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isRateLimitedError(null)).toBe(false)
  })

  // The per-member cap is the other rejection that is a rule rather than a
  // fault, and it answered with a hand-written sniff in two places. Misreading
  // it shows a generic error where the friendly popup belongs and files the
  // trigger in Sentry.
  it('recognises the active-item cap in either field, and only it', () => {
    expect(isItemLimitError({ message: 'member_active_item_limit_exceeded' })).toBe(true)
    // The field neither hand-written copy looked at.
    expect(isItemLimitError({ code: 'P0001', details: 'member_active_item_limit_exceeded' })).toBe(true)
    // The human wording alone is not enough: any error could say "limit of".
    expect(isItemLimitError({ message: 'You have reached the limit of 50 items.' })).toBe(false)
    expect(isItemLimitError({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isItemLimitError({ message: 'item_insert_rate_limit_exceeded' })).toBe(false)
    expect(isItemLimitError(null)).toBe(false)
  })

  it('keeps a throttled insert for the next attempt instead of dropping it', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a'))
    enqueueOfflineMutation(storage, USER, insertMutation('b'))

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({ data: null, error: throttled })

    const result = await flushOfflineQueue(storage, USER, db)

    // Interrupted, not failed: nothing was rejected on its merits.
    expect(result).toEqual({ flushed: 0, failed: 0, interrupted: true })
    expect(loadOfflineQueue(storage, USER)).toHaveLength(2)
    // Stopped at the first one rather than burning the rest against a ceiling
    // that is already refusing them.
    expect(db.calls).toHaveLength(1)
  })
})

// ─── upgrading across the families → households rename ───────────────────
// A queued insert carries the literal row it will POST. One enqueued by a
// pre-rename build says `family_id`, which is now a column that does not exist,
// so the replay would be rejected permanently — and this queue drops permanent
// failures by design. Without the rewrite on load, anything a user added while
// offline during the upgrade would vanish with no error they ever see.
describe('legacy pre-rename queue rows', () => {
  const KEY = 'bagful-offline-queue'

  function writeLegacyQueue(storage, mutations) {
    storage.setItem(KEY, JSON.stringify({ version: 1, userId: USER, mutations }))
  }

  it('rewrites family_id to list_id on a queued insert', () => {
    const storage = makeStorage()
    writeLegacyQueue(storage, [
      { kind: 'insert', id: 'i1', row: { id: 'i1', family_id: 'fam-1', name: 'Lapte', quantity: 2 } },
    ])

    const [mutation] = loadOfflineQueue(storage, USER)
    expect(mutation.row.list_id).toBe('fam-1')
    expect(mutation.row).not.toHaveProperty('family_id')
    // Everything else about the row survives untouched.
    expect(mutation.row.name).toBe('Lapte')
    expect(mutation.row.quantity).toBe(2)
  })

  it('leaves an already-migrated row alone', () => {
    const storage = makeStorage()
    writeLegacyQueue(storage, [insertMutation('i1')])

    const [mutation] = loadOfflineQueue(storage, USER)
    expect(mutation.row.list_id).toBe('fam-1')
    expect(mutation.row).not.toHaveProperty('family_id')
  })

  // The households→lists rename left one more legacy field behind: a row
  // queued between that rename and this one says `household_id`, not
  // `family_id` or `list_id`.
  it('rewrites household_id to list_id on a queued insert', () => {
    const storage = makeStorage()
    writeLegacyQueue(storage, [
      { kind: 'insert', id: 'i1', row: { id: 'i1', household_id: 'fam-1', name: 'Lapte', quantity: 2 } },
    ])

    const [mutation] = loadOfflineQueue(storage, USER)
    expect(mutation.row.list_id).toBe('fam-1')
    expect(mutation.row).not.toHaveProperty('household_id')
    expect(mutation.row.name).toBe('Lapte')
    expect(mutation.row.quantity).toBe(2)
  })

  it('does not invent a row key on updates and deletes', () => {
    const storage = makeStorage()
    writeLegacyQueue(storage, [
      { kind: 'update', id: 'i1', patch: { checked: true } },
      { kind: 'delete', id: 'i2' },
    ])

    const [update, remove] = loadOfflineQueue(storage, USER)
    expect(update).toEqual({ kind: 'update', id: 'i1', patch: { checked: true } })
    expect(remove).toEqual({ kind: 'delete', id: 'i2' })
  })

  it('replays a legacy insert against the renamed column', async () => {
    const storage = makeStorage()
    writeLegacyQueue(storage, [
      { kind: 'insert', id: 'i1', row: { id: 'i1', family_id: 'fam-1', name: 'Lapte', quantity: 2 } },
    ])

    const db = createFakeDb()
    db.handlers['shopping_list_items.insert'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)
    expect(result).toEqual({ flushed: 1, failed: 0, interrupted: false })
    // What actually reaches the server carries the new column name.
    expect(db.calls[0].payload.list_id).toBe('fam-1')
    expect(db.calls[0].payload).not.toHaveProperty('family_id')
  })

  // Unbounded, the only limit was localStorage's own quota — a device-dependent
  // cliff that arrives mid-write and was swallowed silently.
  describe('the queue ceiling', () => {
    // Distinct rows, so coalescing cannot collapse them and the count is real.
    function fill(storage, count) {
      for (let i = 0; i < count; i++) {
        enqueueOfflineMutation(storage, USER, { kind: 'delete', id: `row-${i}` })
      }
    }

    it('keeps everything below the ceiling', () => {
      const storage = makeStorage()
      fill(storage, 500)
      expect(loadOfflineQueue(storage, USER)).toHaveLength(500)
    })

    it('stops growing once the ceiling is reached', () => {
      const storage = makeStorage()
      fill(storage, 520)
      expect(loadOfflineQueue(storage, USER)).toHaveLength(500)
    })

    it('drops the oldest, keeping the write the user just made', () => {
      const storage = makeStorage()
      fill(storage, 510)

      const queued = loadOfflineQueue(storage, USER)
      // The ten earliest are gone; the most recent survived.
      expect(queued[0]).toEqual({ kind: 'delete', id: 'row-10' })
      expect(queued[queued.length - 1]).toEqual({ kind: 'delete', id: 'row-509' })
    })
  })
})

// Quantity changes are queued as changes ("+2"), not totals ("= 4"), so a
// replay adds to whatever another member did meanwhile instead of overwriting it.
describe('quantity changes', () => {
  const change = (id, delta) => ({ kind: 'quantity', id, delta })

  it('adds up changes to the same row', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, change('a', 2))
    enqueueOfflineMutation(storage, USER, change('a', 3))
    expect(loadOfflineQueue(storage, USER)).toEqual([change('a', 5)])
  })

  it('drops changes that cancel out', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, change('a', 2))
    enqueueOfflineMutation(storage, USER, change('a', -2))
    expect(loadOfflineQueue(storage, USER)).toEqual([])
  })

  it('folds into a row not yet sent, held at 1', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, insertMutation('a', { quantity: 2 }))
    enqueueOfflineMutation(storage, USER, change('a', 3))
    expect(loadOfflineQueue(storage, USER)[0].row.quantity).toBe(5)
    enqueueOfflineMutation(storage, USER, change('a', -9))
    expect(loadOfflineQueue(storage, USER)[0].row.quantity).toBe(1)
  })

  it('is dropped with the row when the row is deleted', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, change('srv-1', 2))
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-1' })
    expect(loadOfflineQueue(storage, USER)).toEqual([{ kind: 'delete', id: 'srv-1' }])
  })

  it('replays through add_item_quantity, and a row gone by then is done', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, change('srv-1', 2))
    const db = createFakeDb()
    db.handlers['rpc.add_item_quantity'] = () => ({ data: null, error: null })

    const result = await flushOfflineQueue(storage, USER, db)

    expect(result).toEqual({ flushed: 1, failed: 0, interrupted: false })
    expect(db.calls[0].params).toEqual({ p_id: 'srv-1', p_delta: 2 })
  })

  // Build 1 replays a kind it does not know as a DELETE, so the queue moved to
  // version 2 to keep a stale tab away from it. This build still reads build
  // 1's queues, or upgrading would drop their unsent writes.
  it('reads a queue written by the previous version, and writes the new one', () => {
    const storage = makeStorage()
    storage.setItem(
      `bagful-offline-queue:${USER}`,
      JSON.stringify({ version: 1, userId: USER, mutations: [{ kind: 'delete', id: 'x' }] }),
    )
    expect(loadOfflineQueue(storage, USER)).toEqual([{ kind: 'delete', id: 'x' }])

    enqueueOfflineMutation(storage, USER, change('a', 1))
    expect(JSON.parse(storage.getItem(`bagful-offline-queue:${USER}`)).version).toBe(2)
  })
})

describe('a replayed write that never answers', () => {
  afterEach(() => vi.restoreAllMocks())

  // Every refetch waits on the flush, so a write stuck on a dead socket would
  // hold up every refresh behind it. It is given up on and kept instead.
  it('is given up on and kept for the next attempt', async () => {
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-1' })
    const db = createFakeDb()
    // Answers only once the request is given up on, as a dead socket would.
    db.handlers['shopping_list_items.delete'] = (q) =>
      new Promise((resolve) => {
        const timedOut = () =>
          resolve({ data: null, error: { code: '', message: 'TimeoutError: signal timed out' } })
        if (q.signal.aborted) timedOut()
        else q.signal.addEventListener('abort', timedOut)
      })

    const flushing = flushOfflineQueue(storage, USER, db)
    timeout.abort()

    expect(await flushing).toEqual({ flushed: 0, failed: 0, interrupted: true })
    expect(loadOfflineQueue(storage, USER)).toEqual([{ kind: 'delete', id: 'srv-1' }])
  })
})

describe('a write refused for an expired login', () => {
  // The phone was away long enough for its token to lapse. The write itself is
  // fine, and the next attempt carries a fresh token, so it is kept, not
  // dropped like a permanent refusal.
  it('is kept for the next attempt', async () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, USER, { kind: 'delete', id: 'srv-1' })
    const db = createFakeDb()
    db.handlers['shopping_list_items.delete'] = () => ({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    expect(await flushOfflineQueue(storage, USER, db)).toEqual({
      flushed: 0,
      failed: 0,
      interrupted: true,
    })
    expect(loadOfflineQueue(storage, USER)).toHaveLength(1)
  })
})
