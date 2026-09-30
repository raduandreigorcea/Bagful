import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { sortItemsForDisplay, type ShoppingItem } from './shoppingList'
import { captureException } from './errorReporting'
import { isCurrentlyOffline, onReconnect } from './connectivity'

// A shopping_list_items row as held in view state: the pure-helper shape plus
// the DB columns the realtime handlers touch.
export interface ShoppingItemRow extends ShoppingItem {
  created_at: string
  [key: string]: unknown
}

export interface ListMemberProfile {
  user_id: string
  display_name?: string | null
  image_url?: string | null
  role?: string | null
}

export interface UseListRealtimeOptions {
  db: SupabaseClient
  listId: Ref<string | null>
  hasInitialized: Ref<boolean>
  items: Ref<ShoppingItemRow[]>
  listMembers: Ref<ListMemberProfile[]>
  loadItems: () => Promise<void>
  loadListHeader: () => Promise<void>
  refreshMembershipOrRedirect: () => Promise<void>
  onListDeleted: () => void
  // True while the given item id has a local write in flight; its realtime echo
  // must not be overwritten by an unrelated concurrent update.
  hasPendingWrite?: (id: string) => boolean
}

// Owns the realtime lifecycle for the list dashboard: the three Postgres
// change channels (items, members, list), reconnect scheduling with
// throttling, the visibility/online/user-activity wake-ups, and the watchdog
// interval that reconciles state whenever the socket is down.
//
// The caller keeps ownership of the data (items/listMembers refs and the
// load/refresh callbacks); this composable decides when to call them.
export function useListRealtime({
  db,
  listId,
  hasInitialized,
  items,
  listMembers,
  loadItems,
  loadListHeader,
  refreshMembershipOrRedirect,
  onListDeleted,
  hasPendingWrite,
}: UseListRealtimeOptions) {
  const realtimeHealthy = ref(false)
  // Healthy means ALL three channels are up, not any one of them. It used to be
  // set by whichever acknowledgement came last, so a dead list channel beside a
  // live members channel read as healthy, and the watchdog below, which only
  // acts on an unhealthy socket, never came to fetch what it was missing.
  const CHANNEL_COUNT = 3
  const subscribedChannels = new Set<string>()
  const reconnectInProgress = ref(false)
  const channelsRefreshing = ref(false)
  const realtimeChannels: RealtimeChannel[] = []
  let reconnectTimeoutId: number | null = null
  let fallbackRefreshIntervalId: number | null = null
  let lastReconnectAttemptAt = 0

  const RECONNECT_THROTTLE_MS = 1500
  const RECONNECT_RETRY_MS = 2500
  const FALLBACK_REFRESH_MS = 30000

  // ─── Pulling fresh state back, once ──────────────────────────────────────────
  // Everything here reads the same two things — the item list and the list
  // header — and three separate paths used to ask for them independently, none
  // able to see the others: the visibility handler, the reconnect it schedules,
  // and each channel's own SUBSCRIBED callback. Coming back to the app ran all
  // of them, so one foreground cost fourteen queries where four answer the
  // question. On a phone, foregrounding is most of what happens to an app.
  //
  // A trailing window rather than a lock, because the asks are naturally
  // simultaneous: three subscribe acknowledgements land within milliseconds of
  // each other, so waiting a moment before fetching is the whole of what turns
  // them into one fetch. Long enough to catch the burst, far short of anything
  // a user waiting for their list would notice.
  const REFRESH_COALESCE_MS = 250

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshInFlight = false
  // Which halves have been asked for and not yet fetched. These two ARE the
  // pending request — there is no separate "asked again" flag, because a want
  // that is still set is what being asked again means. Tracked separately
  // because the channels genuinely differ: a members channel coming back has no
  // reason to re-read the item list, and vice versa. Only a caller that wants
  // both pays for both.
  let wantItems = false
  let wantHeader = false

  function requestRefresh(parts: { items?: boolean; header?: boolean }): void {
    if (parts.items) wantItems = true
    if (parts.header) wantHeader = true
    // Already fetching, or already waiting out the window: in both cases the
    // flags just set are picked up without scheduling anything more. A channel
    // that resubscribed after the read went out may have missed a change that
    // read could not have seen, so the request is real — but any number of them
    // collapse into the same single re-run.
    if (refreshInFlight || refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void runRefresh()
    }, REFRESH_COALESCE_MS)
  }

  async function runRefresh(): Promise<void> {
    refreshInFlight = true
    try {
      // Re-checked after every pass, so a request arriving mid-fetch is served
      // by one more round rather than being swallowed by the one in progress.
      // Teardown clears both flags, which is also how this loop is stopped.
      while (wantItems || wantHeader) {
        // Claimed before awaiting, for the same reason.
        const items = wantItems
        const header = wantHeader
        wantItems = false
        wantHeader = false
        await Promise.all([
          items ? loadItems() : Promise.resolve(),
          header ? loadListHeader() : Promise.resolve(),
        ])
      }
    } finally {
      refreshInFlight = false
    }
  }

  function handleVisibilityOrOnline() {
    if (!hasInitialized.value) return

    if (document.visibilityState === 'visible') {
      if (!isCurrentlyOffline()) {
        requestRefresh({ items: true, header: true })
        scheduleRealtimeReconnect('focus/online', 0)
      }
    } else {
      // Backgrounded: drop the socket rather than hold a connection nobody is
      // looking at. handleVisibilityOrOnline reconnects on the way back.
      if (db && db.realtime) {
        db.realtime.disconnect()
      }
      realtimeHealthy.value = false
    }
  }

  // Every reconnect path is gated on this, so the connectivity signal it reads
  // decides whether realtime can recover at all. It used to be navigator.onLine,
  // which lib/connectivity exists precisely because of: inside the Android
  // WebView that flag is unreliable and its online/offline events can fail to
  // fire. A WebView wrongly reporting offline therefore pinned this to false and
  // took the watchdog and the user-activity handler down with it — leaving the
  // socket dead on the one platform the Capacitor status was added to serve.
  function shouldKeepRealtimeActive() {
    return hasInitialized.value
      && !!listId.value
      && document.visibilityState === 'visible'
      && !isCurrentlyOffline()
  }

  function setupFallbackRefresh() {
    if (fallbackRefreshIntervalId) return
    // Watchdog only. When realtime is healthy the WebSocket already delivers every
    // change, so this does nothing and steady-state REST traffic is zero. It only
    // acts when the socket is down: try to reconnect and pull one fresh snapshot to
    // reconcile whatever was missed while disconnected.
    fallbackRefreshIntervalId = window.setInterval(() => {
      if (!shouldKeepRealtimeActive()) return
      if (realtimeHealthy.value) return
      scheduleRealtimeReconnect('watchdog tick', 0)
      requestRefresh({ items: true, header: true })
    }, FALLBACK_REFRESH_MS)
  }

  function cleanupReconnectResources() {
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId)
      reconnectTimeoutId = null
    }
    if (fallbackRefreshIntervalId) {
      clearInterval(fallbackRefreshIntervalId)
      fallbackRefreshIntervalId = null
    }
    // A refresh still inside its coalescing window would otherwise fire from a
    // view that has gone, reading into refs nobody is rendering.
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    wantItems = false
    wantHeader = false
  }

  function handleUserActivity() {
    if (!shouldKeepRealtimeActive()) return
    if (realtimeHealthy.value) return
    scheduleRealtimeReconnect('user activity', 0)
  }

  async function reconnectRealtime(reason: string) {
    if (reconnectInProgress.value || !shouldKeepRealtimeActive()) return

    const now = Date.now()
    if (now - lastReconnectAttemptAt < RECONNECT_THROTTLE_MS) return
    lastReconnectAttemptAt = now

    reconnectInProgress.value = true
    try {
      db.realtime.setAuth()
      db.realtime.connect()
      await setupRealtimeSubscriptions()
      // Not awaited any more: the loads report their own failures (loadItems
      // sets loadError, loadListHeader captures anything that is not
      // offline), so holding reconnectInProgress open across two round trips
      // bought nothing and only delayed the next legitimate reconnect. The
      // subscribe acknowledgements below ask for the same refresh, and the
      // window is what makes all of it one fetch.
      requestRefresh({ items: true, header: true })
    } catch (error) {
      // A reconnect that throws is a real fault, unlike the ordinary CLOSED /
      // TIMED_OUT statuses the watchdog already handles by retrying. `reason`
      // is what the removed console.log carried and the one thing that makes
      // these reports separable — a focus reconnect failing is a different
      // problem from the watchdog never getting back on.
      captureException(
        error instanceof Error
          ? Object.assign(error, { bagfulReconnectReason: reason })
          : new Error(`Realtime reconnect failed (${reason}): ${String(error)}`),
      )
      scheduleRealtimeReconnect('retry after failure', RECONNECT_RETRY_MS)
    } finally {
      reconnectInProgress.value = false
    }
  }

  function scheduleRealtimeReconnect(reason: string, delayMs = RECONNECT_THROTTLE_MS) {
    if (!shouldKeepRealtimeActive()) return
    if (reconnectTimeoutId || reconnectInProgress.value) return

    reconnectTimeoutId = window.setTimeout(() => {
      reconnectTimeoutId = null
      void reconnectRealtime(reason)
    }, delayMs)
  }

  function handleChannelStatus(channelName: string, status: string) {
    if (status === 'SUBSCRIBED') {
      subscribedChannels.add(channelName)
      realtimeHealthy.value = subscribedChannels.size === CHANNEL_COUNT
      // A channel that has just (re)subscribed may have missed changes while it
      // was down, so each one asks for whatever it is responsible for — and only
      // that. Three acknowledgements arriving together therefore become one
      // fetch of each half rather than one fetch per channel.
      if (hasInitialized.value) {
        if (channelName === 'itemsChannel') requestRefresh({ items: true })
        if (channelName === 'membersChannel' || channelName === 'listChannel') {
          requestRefresh({ header: true })
        }
      }
      return
    }

    if (channelsRefreshing.value) return

    if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      subscribedChannels.delete(channelName)
      realtimeHealthy.value = false
      scheduleRealtimeReconnect(`${channelName}:${status}`, 0)
    }
  }

  function cleanupRealtimeSubscriptions() {
    subscribedChannels.clear()
    realtimeHealthy.value = false
    while (realtimeChannels.length) {
      const channel = realtimeChannels.pop()
      if (channel) db.removeChannel(channel)
    }
  }

  async function setupRealtimeSubscriptions() {
    if (!listId.value) return

    // Revert Realtime auth to use the dynamic accessToken callback function configured in supabase.ts,
    // preventing static token expiration during automatic WebSocket reconnects.
    db.realtime.setAuth()

    channelsRefreshing.value = true
    cleanupRealtimeSubscriptions()

    try {
      const itemsChannel = db
        .channel(`shopping-list:${listId.value}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'shopping_list_items',
            filter: `list_id=eq.${listId.value}`,
          },
          (payload) => {
            const newRecord = payload.new as ShoppingItemRow

            if (!items.value.some((i) => i.id === newRecord.id)) {
              // Same canonical order as loadItems, so the echo of an insert
              // lands exactly where the next refetch would put it.
              items.value = sortItemsForDisplay([...items.value, newRecord])
            }
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'shopping_list_items',
            filter: `list_id=eq.${listId.value}`,
          },
          (payload) => {
            const newRecord = payload.new as ShoppingItemRow
            // A row mid local write owns its state until that write's own echo
            // lands; a concurrent update must not revert the optimistic value.
            if (hasPendingWrite?.(newRecord.id)) return
            const idx = items.value.findIndex((i) => i.id === newRecord.id)
            if (idx !== -1) {
              items.value[idx] = { ...items.value[idx], ...newRecord }
              // Re-assert the canonical order after the merge. A remote tick
              // does not move the row (order is creation time), but the merged
              // record is the authority on created_at.
              items.value = sortItemsForDisplay(items.value)
            } else {
              // Through the refresh window like every other re-read here, not a
              // direct loadItems: a burst of these used to start one fetch each,
              // and they settled in completion order, older over newer.
              requestRefresh({ items: true })
            }
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'shopping_list_items',
            // Scoped like the INSERT and UPDATE handlers above. This is what
            // 007_realtime.sql set `replica identity full` for — without the full
            // old row a DELETE payload carries only the primary key and the
            // filter cannot match. The members channel below already did this;
            // this one was left unscoped, so a user in several lists
            // received every list's item deletions here and discarded them
            // client-side.
            filter: `list_id=eq.${listId.value}`,
          },
          (payload) => {
            const oldRecord = payload.old as Partial<ShoppingItemRow>
            if (oldRecord?.id) {
              items.value = items.value.filter((i) => i.id !== oldRecord.id)
            } else {
              // Fallback for environments where DELETE payloads are minimal.
              requestRefresh({ items: true })
            }
          },
        )
        .subscribe((status) => {
          handleChannelStatus('itemsChannel', status)
        })

      const membersChannel = db
        .channel(`list-members:${listId.value}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'list_members',
            filter: `list_id=eq.${listId.value}`,
          },
          () => {
            // Refetch rather than patch. The payload is a list_members row,
            // which since the profiles split (003_lists_and_members.sql) carries no name or
            // avatar — it could only ever seed a placeholder that the refetch
            // below immediately overwrote a moment later.
            requestRefresh({ header: true })
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'list_members',
            filter: `list_id=eq.${listId.value}`,
          },
          (payload) => {
            const removedUserId = (payload.old as Partial<ListMemberProfile>)?.user_id
            if (removedUserId) {
              listMembers.value = listMembers.value.filter((m) => m.user_id !== removedUserId)
            }
            void refreshMembershipOrRedirect()
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'list_members',
            filter: `list_id=eq.${listId.value}`,
          },
          () => {
            requestRefresh({ header: true })
          },
        )
        .subscribe((status) => {
          handleChannelStatus('membersChannel', status)
        })

      const listChannel = db
        .channel(`list:${listId.value}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'lists',
            filter: `id=eq.${listId.value}`,
          },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              cleanupRealtimeSubscriptions()
              onListDeleted()
              return
            }
            requestRefresh({ header: true })
          },
        )
        .subscribe((status) => {
          handleChannelStatus('listChannel', status)
        })

      realtimeChannels.push(itemsChannel, membersChannel, listChannel)
    } finally {
      channelsRefreshing.value = false
    }
  }

  // Unregisters the connectivity subscription below.
  let stopReconnect: (() => void) | null = null

  onMounted(() => {
    // On `document`, which is where the event is actually dispatched. It bubbles
    // to window, so the old binding worked — but HomeView listens on document
    // for the same signal, and two spellings of one API is a pause for whoever
    // reads them next.
    document.addEventListener('visibilitychange', handleVisibilityOrOnline)
    // Not window's 'online' event: in a WebView it can simply never fire, which
    // left this the dead half of the recovery path. lib/connectivity fires its
    // handlers off the Capacitor status (with the window events as its own web
    // fallback), so subscribing here covers both platforms through one signal.
    stopReconnect = onReconnect(handleVisibilityOrOnline)
    window.addEventListener('pointerdown', handleUserActivity)
    window.addEventListener('keydown', handleUserActivity)
    window.addEventListener('touchstart', handleUserActivity, { passive: true })
    setupFallbackRefresh()
  })

  onBeforeUnmount(() => {
    cleanupRealtimeSubscriptions()
    cleanupReconnectResources()
    document.removeEventListener('visibilitychange', handleVisibilityOrOnline)
    if (stopReconnect) {
      stopReconnect()
      stopReconnect = null
    }
    window.removeEventListener('pointerdown', handleUserActivity)
    window.removeEventListener('keydown', handleUserActivity)
    window.removeEventListener('touchstart', handleUserActivity)
  })

  return {
    realtimeHealthy,
    setupRealtimeSubscriptions,
    cleanupRealtimeSubscriptions,
  }
}
