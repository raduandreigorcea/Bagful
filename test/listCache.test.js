import { describe, it, expect } from 'vitest'
import {
  loadListSnapshot,
  saveListSnapshot,
  clearListSnapshot,
  loadActiveListId,
  saveActiveListId,
  clearActiveListId,
  SNAPSHOT_MAX_AGE_MS,
} from '../src/lib/listCache'
import { makeStorage } from './support/fakeStorage'
import { userScopedKey } from '../src/lib/perUserStorage'

function makeSnapshot(overrides = {}) {
  return {
    listId: 'fam-1',
    listName: 'Fam',
    listInviteCode: 'ABCDEFGH',
    listOwnerId: 'user-1',
    listItemLimit: 50,
    listEmoji: '🏠',
    listMembers: [{ user_id: 'user-1', display_name: 'Me', image_url: null, role: 'moderator' }],
    items: [{ id: 'i1', name: 'Milk', quantity: 2, checked: false, created_at: '2026-01-01T00:00:00.000Z' }],
    hasShopped: true,
    ...overrides,
  }
}

// The list id is the one field read back out as a query parameter rather
// than as display text — lib/productSuggestions interpolates it into a
// PostgREST `or` filter — and localStorage is not a trust boundary the app
// controls. A snapshot whose id is not an opaque identifier is refused whole.
describe('listCache rejects a tampered list id', () => {
  const REJECTED = {
    'a PostgREST filter expression': 'fam-1,list_id.not.is.null',
    'an operator suffix': 'fam-1.eq.anything',
    'a parenthesised condition': 'fam-1,or(a.eq.b)',
    'a quoted string': `fam-1'`,
    'whitespace': 'fam-1 or true',
    'nothing at all': '',
  }

  for (const [what, listId] of Object.entries(REJECTED)) {
    it(`refuses ${what}`, () => {
      const storage = makeStorage()
      saveListSnapshot(storage, 'user-1', makeSnapshot({ listId }))
      expect(loadListSnapshot(storage, 'user-1')).toBeNull()
    })
  }

  it('still accepts an ordinary id', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-1', makeSnapshot({
      listId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    }))
    expect(loadListSnapshot(storage, 'user-1')).not.toBeNull()
  })
})

describe('listCache', () => {
  it('round-trips a snapshot for the same user', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-1', makeSnapshot())
    expect(loadListSnapshot(storage, 'user-1')).toEqual(makeSnapshot())
  })

  it('defaults a snapshot saved before the emoji existed to no emoji', () => {
    const storage = makeStorage()
    const { listEmoji, ...withoutEmoji } = makeSnapshot()
    saveListSnapshot(storage, 'user-1', withoutEmoji)
    expect(loadListSnapshot(storage, 'user-1').listEmoji).toBe('')
  })

  // Snapshots written before this field existed are still version 1, so they
  // must survive rather than be discarded — false is the pre-existing reading.
  it('defaults a snapshot saved before hasShopped existed to not shopped', () => {
    const storage = makeStorage()
    const { hasShopped, ...older } = makeSnapshot()
    saveListSnapshot(storage, 'user-1', older)
    expect(loadListSnapshot(storage, 'user-1').hasShopped).toBe(false)
  })

  it('never returns another user\'s snapshot', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-1', makeSnapshot())
    expect(loadListSnapshot(storage, 'user-2')).toBeNull()
  })

  it('expires snapshots older than the max age', () => {
    const storage = makeStorage()
    const savedAt = 1_000_000
    saveListSnapshot(storage, 'user-1', makeSnapshot(), savedAt)
    expect(loadListSnapshot(storage, 'user-1', savedAt + SNAPSHOT_MAX_AGE_MS)).not.toBeNull()
    expect(loadListSnapshot(storage, 'user-1', savedAt + SNAPSHOT_MAX_AGE_MS + 1)).toBeNull()
  })

  it('returns null for corrupt or structurally invalid data', () => {
    const storage = makeStorage()
    storage.setItem('bagful-household-snapshot', '{not json')
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()

    saveListSnapshot(storage, 'user-1', makeSnapshot({ listId: '' }))
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()

    saveListSnapshot(storage, 'user-1', makeSnapshot({ items: 'oops' }))
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()
  })

  it('fills defaults for missing optional fields', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-1', makeSnapshot({ listName: undefined, listItemLimit: undefined }))
    const loaded = loadListSnapshot(storage, 'user-1')
    expect(loaded.listName).toBe('')
    expect(loaded.listItemLimit).toBe(50)
  })

  it('swallows storage write failures', () => {
    const storage = makeStorage()
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    expect(() => saveListSnapshot(storage, 'user-1', makeSnapshot())).not.toThrow()
  })

  it('clears the snapshot', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-1', makeSnapshot())
    clearListSnapshot(storage)
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()
  })
})

// ─── one snapshot per account ────────────────────────────────────────────────
// The single device-wide key was never a leak (the userId check below has always
// rejected somebody else's snapshot) but it was a loss: whoever saved last
// owned the key, so signing in as B threw A's cache away.
describe('per-user snapshot keys', () => {
  it('keeps two accounts on one device from overwriting each other', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-a', makeSnapshot({ listName: 'A House' }))
    saveListSnapshot(storage, 'user-b', makeSnapshot({ listName: 'B House' }))

    // Before this, B's save took the one key and A's snapshot was simply gone.
    expect(loadListSnapshot(storage, 'user-a').listName).toBe('A House')
    expect(loadListSnapshot(storage, 'user-b').listName).toBe('B House')
  })

  it('clears only the named account when told which one', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-a', makeSnapshot())
    saveListSnapshot(storage, 'user-b', makeSnapshot())

    clearListSnapshot(storage, 'user-a')

    expect(loadListSnapshot(storage, 'user-a')).toBeNull()
    expect(loadListSnapshot(storage, 'user-b')).not.toBeNull()
  })

  it('clears every account when it cannot say whose it is', () => {
    const storage = makeStorage()
    saveListSnapshot(storage, 'user-a', makeSnapshot())
    saveListSnapshot(storage, 'user-b', makeSnapshot())

    // Signing out from a screen that never learned who was signed in: the safer
    // end of the trade on a shared browser.
    clearListSnapshot(storage)

    expect(loadListSnapshot(storage, 'user-a')).toBeNull()
    expect(loadListSnapshot(storage, 'user-b')).toBeNull()
  })
})

// The fourth and last record on this device to move off a single device-wide
// key with the account stamped inside it, after the offline queue, the snapshot
// above and the notification preference.
//
// Mildest of the four by a distance -- losing it means landing on your first
// list rather than the one you last picked, where the queue loses unsent
// writes -- which is exactly why it was the one left behind. It is the same
// shape one severity down, and the shape is what comes back somewhere it
// matters.
describe('per-user active list', () => {

  it('keeps two accounts on one device from overwriting each other', () => {
    const storage = makeStorage()
    saveActiveListId(storage, 'user-a', 'fam-a')
    saveActiveListId(storage, 'user-b', 'fam-b')

    // Before this, B's save took the one key and A's choice was simply gone.
    expect(loadActiveListId(storage, 'user-a')).toBe('fam-a')
    expect(loadActiveListId(storage, 'user-b')).toBe('fam-b')
  })

  it('clears only the named account when told which one', () => {
    const storage = makeStorage()
    saveActiveListId(storage, 'user-a', 'fam-a')
    saveActiveListId(storage, 'user-b', 'fam-b')

    clearActiveListId(storage, 'user-a')

    expect(loadActiveListId(storage, 'user-a')).toBeNull()
    expect(loadActiveListId(storage, 'user-b')).toBe('fam-b')
  })

  it('clears every account when it cannot say whose it is', () => {
    const storage = makeStorage()
    saveActiveListId(storage, 'user-a', 'fam-a')
    saveActiveListId(storage, 'user-b', 'fam-b')

    clearActiveListId(storage)

    expect(loadActiveListId(storage, 'user-a')).toBeNull()
    expect(loadActiveListId(storage, 'user-b')).toBeNull()
  })

  // The stored id is read back out as a query parameter, so the tamper check
  // that guards the snapshot's list id guards this one too.
  it('refuses an id that is not an opaque identifier', () => {
    const storage = makeStorage()
    storage.setItem(
      'bagful-active-household:user-1',
      JSON.stringify({ userId: 'user-1', listId: 'fam-1,name.eq.x' }),
    )
    expect(loadActiveListId(storage, 'user-1')).toBeNull()
  })
})

// A phone that saved its active list before the households→lists rename wrote
// `householdId`, not `listId`, under this same key. Nothing rewrites that
// record in place, so the read has to still recognise it.
describe('reads an active list saved before the rename', () => {
  const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

  it('falls back to householdId when listId is absent', () => {
    const storage = makeStorage()
    storage.setItem(
      userScopedKey('bagful-active-household', 'user-1'),
      JSON.stringify({ userId: 'user-1', householdId: UUID }),
    )
    expect(loadActiveListId(storage, 'user-1')).toBe(UUID)
  })

  it('a record written by saveActiveListId round-trips', () => {
    const storage = makeStorage()
    saveActiveListId(storage, 'user-1', UUID)
    expect(loadActiveListId(storage, 'user-1')).toBe(UUID)
  })
})

// A snapshot written before the rename stores householdId etc., not listId,
// and predates the version bump below. Discarding it costs one slower boot
// (the fresh fetch fills in the real data), not a household-shaped snapshot
// shown under list field names.
describe('snapshot saved before the rename', () => {
  it('is discarded rather than misread', () => {
    const storage = makeStorage()
    storage.setItem(
      userScopedKey('bagful-household-snapshot', 'user-1'),
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        savedAt: Date.now(),
        householdId: 'fam-1',
        householdName: 'Fam',
        householdInviteCode: 'ABCDEFGH',
        householdOwnerId: 'user-1',
        householdItemLimit: 50,
        householdEmoji: '🏠',
        householdMembers: [],
        items: [],
        hasShopped: false,
      }),
    )
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()
  })
})
