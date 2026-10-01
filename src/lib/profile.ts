import type { AppClient } from '../supabase'
import { deriveProfileFields, type UserLike } from './userIdentity'

// Write the caller's own profiles row (name + Clerk avatar), the single source
// of truth every roster and list-item avatar now reads from.
//
// Internal to this file, and the only caller is refreshOwnProfile below — which
// is the write everything should be going through, because it is the one that
// skips a write that would change nothing. Exported, this was the way to make
// the unconditional write by accident. (The setup paths do not call it: their
// RPCs upsert the profile and insert the membership in one server-side step.)
async function upsertOwnProfile(
  db: AppClient,
  userId: string,
  user: UserLike | null | undefined,
) {
  const fields = deriveProfileFields(user)
  return db
    .from('profiles')
    .upsert(
      { user_id: userId, ...fields, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
}

// How long a boot may go without writing the row even when nothing changed.
// The write is not only a refresh: it also puts the row back if it went missing,
// so it cannot be skipped for good, only thinned out.
const PROFILE_REWRITE_MS = 24 * 60 * 60 * 1000

const writtenKey = (userId: string) => `bagful.profileWritten.${userId}`

// The boot-time refresh. Every write counts against the profile_write rate
// limit (003_lists_and_members.sql), and writing an unchanged name on
// every app open, tab and reload filled that counter for nothing -- 14 hits in
// an hour for one person just using the app. So this writes only when the name
// or photo differs from the last successful write on this device, or a day has
// passed since it. The record is kept only after the database accepted the
// write, so a failure (offline, banned) is retried on the next boot as before.
export async function refreshOwnProfile(
  db: AppClient,
  userId: string,
  user: UserLike | null | undefined,
  storage: Storage,
  now: number = Date.now(),
) {
  const fields = deriveProfileFields(user)
  const signature = JSON.stringify(fields)
  try {
    const last = JSON.parse(storage.getItem(writtenKey(userId)) ?? 'null') as
      | { signature?: string; at?: number }
      | null
    if (last?.signature === signature && typeof last.at === 'number' && now - last.at < PROFILE_REWRITE_MS) {
      return { skipped: true as const, error: null }
    }
  } catch {
    // Unreadable record or storage disabled: write, which is the old behaviour.
  }

  const { error } = await upsertOwnProfile(db, userId, user)
  if (!error) {
    try {
      storage.setItem(writtenKey(userId), JSON.stringify({ signature, at: now }))
    } catch {
      // Storage disabled: the next boot writes again, which is harmless.
    }
  }
  return { skipped: false as const, error }
}

// Forget when this device last wrote the row, so the next sign-in writes it
// again. With no id, every account's record goes, same as the other sign-out
// clears.
export function clearProfileWritten(storage: Storage, userId?: string): void {
  try {
    if (userId) {
      storage.removeItem(writtenKey(userId))
      return
    }
    const prefix = 'bagful.profileWritten.'
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    // Storage disabled: there is nothing to clear.
  }
}
