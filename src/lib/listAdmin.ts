import type { AppClient } from '../supabase'
import type { TablesUpdate } from '../types/database'

// The online-only writes and reads behind the list settings, the purchase
// history and the setup screen. They are not queued offline (unlike the item
// writes in shoppingListActions): each is a deliberate, confirmed action that
// should fail visibly. Kept here so the components own the UI and the messages,
// and the table and column names live in one place.
//
// Each returns the PostgREST result untouched, so callers still read `error`.

type Db = Pick<AppClient, 'from'>

export const updateList = (db: Db, listId: string, patch: TablesUpdate<'lists'>) =>
  db.from('lists').update(patch).eq('id', listId)

export const deleteList = (db: Db, listId: string) => db.from('lists').delete().eq('id', listId)

export const setMemberRole = (db: Db, listId: string, userId: string, role: string) =>
  db.from('list_members').update({ role }).eq('list_id', listId).eq('user_id', userId)

export const removeMember = (db: Db, listId: string, userId: string) =>
  db.from('list_members').delete().eq('list_id', listId).eq('user_id', userId)

/** Whether this person created any list: only the first one is allowed. */
export const findOwnedList = (db: Db, userId: string) =>
  db.from('lists').select('id').eq('created_by', userId).limit(1).maybeSingle()

const HISTORY_COLUMNS =
  'id, name, maker, quantity, checkout_id, purchased_by, purchased_at, added_by_name, added_by_image_url'

export const fetchPurchaseHistory = (db: Db, listId: string, limit: number) =>
  db
    .from('purchase_history')
    .select(HISTORY_COLUMNS)
    .eq('list_id', listId)
    // Rows in one checkout share a single purchased_at, and Postgres returns
    // tied rows in no particular order, so without tiebreakers every open could
    // shuffle them. checkout_id keeps a checkout's rows contiguous (which the
    // partial-tail trim relies on); id pins the order within it.
    .order('purchased_at', { ascending: false })
    .order('checkout_id', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
