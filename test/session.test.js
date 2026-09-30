import { describe, it, expect, beforeEach } from 'vitest'
import {
  rememberUser,
  getRememberedUser,
  forgetUser,
  forgetLocalUserState,
} from '../src/lib/session'
import {
  saveListSnapshot,
  loadListSnapshot,
  saveActiveListId,
  loadActiveListId,
} from '../src/lib/listCache'
import { enqueueOfflineMutation, hasQueuedOfflineMutations } from '../src/lib/offlineQueue'
import { makeStorage } from './support/fakeStorage'

describe('session', () => {
  let storage
  beforeEach(() => { storage = makeStorage() })

  it('returns null when no user has been remembered', () => {
    expect(getRememberedUser(storage)).toBe(null)
  })

  it('remembers and reads back the last signed-in user', () => {
    rememberUser(storage, 'user-abc')
    expect(getRememberedUser(storage)).toBe('user-abc')
  })

  it('forgets the user on sign-out', () => {
    rememberUser(storage, 'user-abc')
    forgetUser(storage)
    expect(getRememberedUser(storage)).toBe(null)
  })

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    expect(() => rememberUser(broken, 'x')).not.toThrow()
    expect(getRememberedUser(broken)).toBe(null)
    expect(() => forgetUser(broken)).not.toThrow()
  })
})

// ─── what signing out drops ──────────────────────────────────────────────────
// Sign-out used to spell this list out at the call site and got three of the
// four: the active-list pointer was left behind. Harmless in itself (it is
// rejected on read by any other account) but the list only existed inside one
// component, so the next key added would have been forgotten the same way.
describe('forgetLocalUserState', () => {
  it('drops every key this device holds for the account', () => {
    const storage = makeStorage()
    rememberUser(storage, 'user-1')
    saveListSnapshot(storage, 'user-1', {
      listId: 'fam-1',
      listName: 'Fam',
      listInviteCode: 'ABCDEFGH',
      listOwnerId: 'user-1',
      listItemLimit: 50,
      listEmoji: '🏠',
      listMembers: [],
      items: [],
      hasShopped: false,
    })
    saveActiveListId(storage, 'user-1', 'fam-1')
    enqueueOfflineMutation(storage, 'user-1', { kind: 'delete', id: 'i1' })
    // Written raw rather than through saveCachedShops, which is a no-op off
    // nightly. The key is device-wide by design, so what has to be proved is
    // that signing out drops it anyway — it holds the product names of the
    // list that was on screen, and it used to outlive the session that made it.
    storage.setItem('bagful.shop-badges.v1', JSON.stringify([['milk', ['lidl']]]))

    forgetLocalUserState(storage, 'user-1')

    expect(getRememberedUser(storage)).toBeNull()
    expect(loadListSnapshot(storage, 'user-1')).toBeNull()
    expect(loadActiveListId(storage, 'user-1')).toBeNull()
    expect(hasQueuedOfflineMutations(storage, 'user-1')).toBe(false)
    expect(storage.getItem('bagful.shop-badges.v1')).toBeNull()
    // Nothing of this account left anywhere on the device.
    expect(storage.map.size).toBe(0)
  })

  it('leaves another account on the same device alone', () => {
    const storage = makeStorage()
    enqueueOfflineMutation(storage, 'user-a', { kind: 'delete', id: 'a1' })
    enqueueOfflineMutation(storage, 'user-b', { kind: 'delete', id: 'b1' })

    forgetLocalUserState(storage, 'user-a')

    expect(hasQueuedOfflineMutations(storage, 'user-a')).toBe(false)
    expect(hasQueuedOfflineMutations(storage, 'user-b')).toBe(true)
  })
})
