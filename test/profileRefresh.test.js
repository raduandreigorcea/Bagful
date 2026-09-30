import { describe, it, expect, beforeEach, vi } from 'vitest'
import { refreshOwnProfile, clearProfileWritten } from '../src/lib/profile'
import { forgetLocalUserState } from '../src/lib/session'
import { makeStorage } from './support/fakeStorage'

const user = { fullName: 'Radu Andrei', imageUrl: 'https://img.clerk.com/a.png' }
const DAY = 24 * 60 * 60 * 1000

function makeDb(error = null) {
  const upsert = vi.fn(async () => ({ error }))
  return { db: { from: () => ({ upsert }) }, upsert }
}

describe('refreshOwnProfile', () => {
  let storage
  beforeEach(() => { storage = makeStorage() })

  it('writes on the first boot and skips an unchanged one after it', async () => {
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    const second = await refreshOwnProfile(db, 'u1', user, storage, 2000)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(second.skipped).toBe(true)
  })

  it('writes again when the name or photo changed', async () => {
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    await refreshOwnProfile(db, 'u1', { ...user, fullName: 'Radu' }, storage, 2000)
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('writes again once a day has passed, so a missing row comes back', async () => {
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    await refreshOwnProfile(db, 'u1', user, storage, 1000 + DAY)
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying after a rejected write', async () => {
    const { db, upsert } = makeDb({ message: 'banned' })
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    await refreshOwnProfile(db, 'u1', user, storage, 2000)
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('does not let one account skip another account\'s write', async () => {
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    await refreshOwnProfile(db, 'u2', user, storage, 2000)
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('writes when the stored record is unreadable', async () => {
    storage = makeStorage({ 'bagful.profileWritten.u1': '{not json' })
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('writes again after sign-out clears the record', async () => {
    const { db, upsert } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    forgetLocalUserState(storage, 'u1')
    await refreshOwnProfile(db, 'u1', user, storage, 2000)
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('clears every account when no id is given', async () => {
    const { db } = makeDb()
    await refreshOwnProfile(db, 'u1', user, storage, 1000)
    await refreshOwnProfile(db, 'u2', user, storage, 1000)
    clearProfileWritten(storage)
    expect([...storage.map.keys()].some((k) => k.startsWith('bagful.profileWritten.'))).toBe(false)
  })
})
