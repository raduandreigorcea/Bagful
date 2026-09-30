import { computed, ref, type Ref } from 'vue'
import type { AppClient } from '../supabase'
import type { ListMemberProfile } from './listRealtime'
import { captureException } from './errorReporting'
import { clampItemLimit, ITEM_LIMIT_DEFAULT } from './limits'
import { isOfflineError } from './offlineQueue'

// The list the dashboard is showing, and every list the user is in:
// the state, and the two reads that fill it. Moved out of HomeView, which keeps
// what ties this to the rest (switching, reconciling after a removal), because
// those also drive the list, realtime and the suggestions.

// Every list the user belongs to; the account dialog lists them to switch.
export interface ListRow { id: string; name: string; emoji?: string | null }

// PostgREST types an embedded to-one relation as an array, but these selects
// each return a single joined row; the casts at the two call sites say so once.
interface MemberRow {
  user_id: string
  role?: string | null
  profiles?: { display_name?: string | null; image_url?: string | null } | null
}
interface MembershipRow {
  list_id: string
  lists?: { name?: string | null; emoji?: string | null } | null
}

export function useList(options: {
  db: AppClient
  /** The Clerk id; memberships are read for this user only. */
  userId: Ref<string | null | undefined>
}) {
  const { db, userId } = options

  // Every list the user belongs to ({ id, name }), listed in the account
  // dialog. listId below is whichever one is currently active.
  const lists = ref<ListRow[]>([])
  const listId = ref<string | null>(null)
  const listName = ref('')
  const listInviteCode = ref('')
  const listOwnerId = ref('')
  const listItemLimit = ref(ITEM_LIMIT_DEFAULT)
  const listEmoji = ref('')
  const listMembers = ref<ListMemberProfile[]>([])
  // Roster keyed by user id, so a list row can resolve its author's live avatar
  // from added_by (the row no longer carries a copied name/photo).
  const memberProfileMap = computed(
    () => new Map(listMembers.value.map((m) => [m.user_id, m])),
  )

  async function loadListHeader() {
    // Which list this answer will be ABOUT, read before the round trip and
    // checked against the live one after it. See the note on the guard below.
    const forList = listId.value
    if (!forList) return
    const [{ data: list, error: listErr }, { data: members, error: membersErr }] = await Promise.all([
      db.from('lists').select('name, invite_code, created_by, max_items_per_member, emoji').eq('id', forList).single(),
      // Name/avatar live in profiles now; embed them so the roster keeps the same
      // { user_id, display_name, image_url, role } shape every consumer expects.
      db.from('list_members').select('user_id, role, profiles(display_name, image_url)').eq('list_id', forList),
    ])

    // Neither failure reaches the screen, and that is deliberate: this runs from
    // the watchdog every 30 seconds while the socket is down, and a dialog per
    // tick over a header that is merely stale would be worse than the staleness.
    // But silence is not the same as ignoring it — dropped entirely, a list
    // read that has started failing (a revoked membership, a transient 500) leaves
    // a stale header up indefinitely with no trace anywhere. Offline is the
    // expected case and is not a fault.
    //
    // Nor is the list row coming back empty (PGRST116, from .single()): that is
    // what a removed member, or anyone with a list open when it was deleted,
    // reads next, and the members channel already moves them off it. Reporting
    // it filed a Sentry issue per removal (found by the bot swarm). The roster
    // read beside it has no .single() and still reports as before.
    for (const err of [listErr, membersErr]) {
      if (!err || isOfflineError(err)) continue
      if (err === listErr && (err as { code?: string }).code === 'PGRST116') continue
      captureException(err)
    }

    // The list moved on while this was in flight, so this answer describes
    // one the user has left. Reported above regardless — the request was made and
    // a failure in it is still news — but not applied: the name, invite code,
    // owner, item cap and roster below would all be the previous list's,
    // painted over the current list.
    //
    // Not a contrived double-tap. This function runs from the reconnect handler,
    // from each realtime subscribe acknowledgement and from the watchdog every 30
    // seconds while the socket is down, so a read already in flight for the
    // list being left is the ordinary case. Whichever answer lands last used
    // to win, which is completion order rather than call order.
    if (listId.value !== forList) return

    if (!listErr && list) {
      listName.value = list.name
      listInviteCode.value = list.invite_code || ''
      listOwnerId.value = list.created_by || ''
      listItemLimit.value = clampItemLimit(list.max_items_per_member)
      listEmoji.value = list.emoji || ''
    }

    if (!membersErr && Array.isArray(members)) {
      listMembers.value = (members as unknown as MemberRow[]).map((m) => ({
        user_id: m.user_id,
        role: m.role,
        // Null, not the user id: memberDisplayName() turns a missing name into
        // "Member" in the reader's language, which a raw Clerk id never reached.
        display_name: m.profiles?.display_name || null,
        image_url: m.profiles?.image_url || null,
      }))
    }
  }

  // Every list the user belongs to, with names for the account dialog's list.
  // Only refreshes the roster; the active list is chosen by the caller.
  async function loadLists() {
    // Signed out mid-session: an error, so callers keep what they have rather
    // than read an empty answer as "belongs to no list" and send you to setup.
    if (!userId.value) return { error: new Error('No signed-in user') }
    const { data, error } = await db
      .from('list_members')
      .select('list_id, lists(name, emoji)')
      .eq('user_id', userId.value)
    if (error) return { error }
    // A list row renders an emoji tile, a name and a marker, so that is all it
    // carries, and the embed brings all of it back in this one query. It used to
    // fetch every list's full roster here to draw composite member avatars;
    // those are gone, and so is the extra round trip.
    const list = ((data ?? []) as unknown as MembershipRow[]).map((row) => ({
      id: row.list_id,
      name: row.lists?.name ?? '',
      emoji: row.lists?.emoji ?? '',
    }))

    // Stable, name-ordered so the list never reshuffles between loads.
    // Pinned to 'en' so the list switcher lists in the same order on
    // every device, whatever language each member is reading it in.
    lists.value = list.sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'),
    )
    return { error: null }
  }

  // A list setting changed (name, item limit, emoji): refresh the active list's
  // header and the lists this user belongs to together, so a new name or emoji
  // shows up everywhere right away rather than only after the next reload.
  async function refreshListAfterSettingsChange() {
    await loadListHeader()
    await loadLists()
  }

  return {
    lists,
    listId,
    listName,
    listInviteCode,
    listOwnerId,
    listItemLimit,
    listEmoji,
    listMembers,
    memberProfileMap,
    loadListHeader,
    loadLists,
    refreshListAfterSettingsChange,
  }
}
