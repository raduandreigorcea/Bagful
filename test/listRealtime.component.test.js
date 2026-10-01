// @vitest-environment happy-dom
//
// Tests for the useListRealtime composable's channel handlers: echo dedupe on
// INSERT (optimistic rows share ids with their realtime echo), merge-or-reload
// on UPDATE, removal on DELETE, and the list-deleted teardown.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { useListRealtime } from '../src/lib/listRealtime'
import { __setOnlineForTest } from '../src/lib/connectivity'

// Fake realtime client: channels record their postgres_changes listeners so
// tests can fire payloads at them directly.
function createRealtimeFakeDb() {
  const db = {
    channels: [],
    removedChannels: [],
    channel(name) {
      const chan = {
        name,
        listeners: [],
        on(_type, filter, callback) {
          chan.listeners.push({ filter, callback })
          return chan
        },
        subscribe(statusCallback) {
          chan.statusCallback = statusCallback
          statusCallback('SUBSCRIBED')
          return chan
        },
        emit(event, payload) {
          for (const listener of chan.listeners) {
            if (listener.filter.event === event || listener.filter.event === '*') {
              listener.callback(payload)
            }
          }
        },
      }
      db.channels.push(chan)
      return chan
    },
    removeChannel(chan) {
      db.removedChannels.push(chan)
    },
    realtime: { setAuth: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  }
  return db
}

async function mountRealtime() {
  const db = createRealtimeFakeDb()
  const ctx = {
    db,
    listId: ref('fam-1'),
    hasInitialized: ref(true),
    items: ref([]),
    listMembers: ref([]),
    loadItems: vi.fn(async () => {}),
    loadListHeader: vi.fn(async () => {}),
    refreshMembershipOrRedirect: vi.fn(async () => {}),
    onListDeleted: vi.fn(),
  }

  let api
  const Harness = defineComponent({
    setup() {
      api = useListRealtime(ctx)
      return () => null
    },
  })
  const wrapper = mount(Harness)
  await api.setupRealtimeSubscriptions()
  await flushPromises()

  const channelByName = (prefix) => db.channels.find((c) => c.name.startsWith(prefix))
  return {
    ...ctx,
    api,
    wrapper,
    itemsChannel: channelByName('shopping-list:'),
    membersChannel: channelByName('list-members:'),
    listChannel: channelByName('list:'),
  }
}

function row(overrides = {}) {
  return {
    id: 'item-1',
    name: 'Milk',
    quantity: 1,
    checked: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

// The coalescing window is 250ms and these tests measure it rather than mock
// it away, so they wait it out on real timers. Comfortably past the window,
// still short enough not to be felt in the suite.
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

describe('shopping list channel', () => {
  it('adds INSERTed rows sorted by created_at and ignores echoes of known ids', async () => {
    const { itemsChannel, items, wrapper } = await mountRealtime()

    itemsChannel.emit('INSERT', { eventType: 'INSERT', new: row({ id: 'b', created_at: '2026-01-02T00:00:00.000Z' }) })
    itemsChannel.emit('INSERT', { eventType: 'INSERT', new: row({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }) })
    expect(items.value.map((i) => i.id)).toEqual(['a', 'b'])

    // The realtime echo of an optimistic insert reuses the same id — no duplicate.
    itemsChannel.emit('INSERT', { eventType: 'INSERT', new: row({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }) })
    expect(items.value).toHaveLength(2)

    wrapper.unmount()
  })

  it('merges UPDATEs into known rows and reloads for unknown rows', async () => {
    const { itemsChannel, items, loadItems, wrapper } = await mountRealtime()
    items.value = [row({ id: 'a', quantity: 1 })]
    loadItems.mockClear()

    itemsChannel.emit('UPDATE', { eventType: 'UPDATE', new: row({ id: 'a', quantity: 7 }) })
    expect(items.value[0].quantity).toBe(7)
    expect(loadItems).not.toHaveBeenCalled()

    // A burst of rows this list does not hold is one re-read, not one each:
    // separate reads settled in completion order, so an older one could land last.
    itemsChannel.emit('UPDATE', { eventType: 'UPDATE', new: row({ id: 'unknown' }) })
    itemsChannel.emit('UPDATE', { eventType: 'UPDATE', new: row({ id: 'unknown-2' }) })
    itemsChannel.emit('UPDATE', { eventType: 'UPDATE', new: row({ id: 'unknown-3' }) })
    await settle()
    expect(loadItems).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('removes DELETEd rows by id and falls back to a reload for minimal payloads', async () => {
    const { itemsChannel, items, loadItems, wrapper } = await mountRealtime()
    items.value = [row({ id: 'a' }), row({ id: 'b' })]
    loadItems.mockClear()

    itemsChannel.emit('DELETE', { eventType: 'DELETE', old: { id: 'a' } })
    expect(items.value.map((i) => i.id)).toEqual(['b'])
    expect(loadItems).not.toHaveBeenCalled()

    itemsChannel.emit('DELETE', { eventType: 'DELETE', old: {} })
    await settle()
    expect(loadItems).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})

describe('members channel', () => {
  it('removes the member on DELETE and rechecks own membership', async () => {
    const { membersChannel, listMembers, refreshMembershipOrRedirect, wrapper } = await mountRealtime()
    listMembers.value = [
      { user_id: 'user-1', display_name: 'Me' },
      { user_id: 'user-2', display_name: 'Them' },
    ]

    membersChannel.emit('DELETE', { eventType: 'DELETE', old: { user_id: 'user-2' } })
    expect(listMembers.value.map((m) => m.user_id)).toEqual(['user-1'])
    expect(refreshMembershipOrRedirect).toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('list channel', () => {
  it('tears down subscriptions and signals the caller when the list is deleted', async () => {
    const { listChannel, db, onListDeleted, wrapper } = await mountRealtime()

    listChannel.emit('DELETE', { eventType: 'DELETE', old: { id: 'fam-1' } })
    expect(onListDeleted).toHaveBeenCalled()
    expect(db.removedChannels).toHaveLength(3)

    wrapper.unmount()
  })
})

describe('refresh coalescing', () => {
  it('collapses three channels resubscribing into one fetch of each half', async () => {
    const { itemsChannel, membersChannel, listChannel, loadItems, loadListHeader, wrapper } =
      await mountRealtime()
    // Let the refresh the initial subscribe asked for run to completion, so what
    // is measured below is only what the reconnect itself costs.
    await settle()
    loadItems.mockClear()
    loadListHeader.mockClear()

    // What a reconnect looks like from here: all three acknowledgements land
    // within a few milliseconds of each other. Before coalescing this was one
    // loadItems and two loadListHeaders, on top of the pair the reconnect
    // had already issued itself.
    itemsChannel.statusCallback('SUBSCRIBED')
    membersChannel.statusCallback('SUBSCRIBED')
    listChannel.statusCallback('SUBSCRIBED')
    await settle()

    expect(loadItems).toHaveBeenCalledTimes(1)
    expect(loadListHeader).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('asks only for the half the resubscribed channel is responsible for', async () => {
    const { membersChannel, loadItems, loadListHeader, wrapper } = await mountRealtime()
    await settle()
    loadItems.mockClear()
    loadListHeader.mockClear()

    // The roster came back; the item list never went anywhere.
    membersChannel.statusCallback('SUBSCRIBED')
    await settle()

    expect(loadListHeader).toHaveBeenCalledTimes(1)
    expect(loadItems).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('leaves coming back online to the view, which syncs it once', async () => {
    const { db, loadItems, loadListHeader, wrapper } = await mountRealtime()
    await settle()
    loadItems.mockClear()
    loadListHeader.mockClear()
    const channelsBefore = db.channels.length

    // HomeView's reconnect handler flushes the queue, reloads and resubscribes.
    // Answering the same edge here as well fetched the list twice and rebuilt
    // the channels twice for every reconnect.
    __setOnlineForTest(false)
    __setOnlineForTest(true)
    await settle()

    expect(loadItems).not.toHaveBeenCalled()
    expect(loadListHeader).not.toHaveBeenCalled()
    expect(db.channels).toHaveLength(channelsBefore)

    wrapper.unmount()
  })

  it('drops a refresh still inside its window when the view goes away', async () => {
    const { itemsChannel, loadItems, wrapper } = await mountRealtime()
    await settle()
    loadItems.mockClear()

    itemsChannel.statusCallback('SUBSCRIBED')
    wrapper.unmount()
    await settle()

    expect(loadItems).not.toHaveBeenCalled()
  })
})

describe('channel health', () => {
  it('marks realtime unhealthy on CLOSED and healthy again on resubscribe', async () => {
    const { itemsChannel, api, wrapper } = await mountRealtime()
    expect(api.realtimeHealthy.value).toBe(true)

    itemsChannel.statusCallback('CLOSED')
    expect(api.realtimeHealthy.value).toBe(false)

    itemsChannel.statusCallback('SUBSCRIBED')
    expect(api.realtimeHealthy.value).toBe(true)

    wrapper.unmount()
  })

  // One live channel is not a live socket. The list channel dying while the
  // members channel stayed up used to read as healthy, so the watchdog never
  // stepped in and the list stopped hearing other people's changes.
  it('stays unhealthy while any one channel is down', async () => {
    const { itemsChannel, membersChannel, api, wrapper } = await mountRealtime()

    itemsChannel.statusCallback('CHANNEL_ERROR')
    membersChannel.statusCallback('SUBSCRIBED')
    expect(api.realtimeHealthy.value).toBe(false)

    itemsChannel.statusCallback('SUBSCRIBED')
    expect(api.realtimeHealthy.value).toBe(true)

    wrapper.unmount()
  })
})
