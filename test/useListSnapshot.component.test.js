// @vitest-environment happy-dom
//
// The painted cache on its own, without HomeView around it. The view tests
// cover when it is written; these cover what it refuses to do: paint over a
// list that has loaded, paint one account's list for another, write before
// the first load has finished, or carry one list's "has shopped" onto another.
import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useListSnapshot } from '../src/lib/useListSnapshot'
import { loadListSnapshot, saveListSnapshot } from '../src/lib/listCache'
import { ITEM_LIMIT_DEFAULT } from '../src/lib/limits'

const item = (id, name = 'Milk') => ({
  id, name, quantity: 1, checked: false, checked_at: null, maker: null,
  added_by: 'user-1', list_id: 'fam-1', created_at: '2026-01-01T00:00:00.000Z',
})

function snapshot(overrides = {}) {
  return {
    listId: 'fam-1',
    listName: 'Home',
    listInviteCode: 'ABCD2345',
    listOwnerId: 'user-1',
    listItemLimit: 40,
    listEmoji: '🏠',
    listMembers: [{ user_id: 'user-1', display_name: 'Radu', image_url: null, role: 'moderator' }],
    items: [item('a')],
    hasShopped: true,
    ...overrides,
  }
}

function mountSnapshot({ userId = 'user-1', initialized = false, shopped = false } = {}) {
  const refs = {
    listId: ref(null),
    listName: ref(''),
    listInviteCode: ref(''),
    listOwnerId: ref(''),
    listItemLimit: ref(ITEM_LIMIT_DEFAULT),
    listEmoji: ref(''),
    listMembers: ref([]),
    items: ref([]),
  }
  const user = ref(userId)
  const hasInitialized = ref(initialized)
  let api
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useListSnapshot({ userId: user, hasInitialized, refs, hasShopped: () => shopped })
        return () => null
      },
    }),
  )
  return { api, refs, user, hasInitialized, wrapper }
}

beforeEach(() => localStorage.clear())

describe('useListSnapshot', () => {
  it('paints the saved list for this account', () => {
    saveListSnapshot(localStorage, 'user-1', snapshot())
    const { api, refs } = mountSnapshot()

    expect(api.hasSnapshot()).toBe(true)
    api.hydrate()

    expect(refs.listId.value).toBe('fam-1')
    expect(refs.items.value.map((i) => i.id)).toEqual(['a'])
    expect(api.paintedFromCache.value).toBe(true)
    expect(api.paintedFor('user-1')).toBe(true)
    expect(api.cachedShoppedListId.value).toBe('fam-1')
  })

  it('never paints another account\'s list', () => {
    saveListSnapshot(localStorage, 'user-2', snapshot())
    const { api, refs } = mountSnapshot()

    expect(api.hasSnapshot()).toBe(false)
    api.hydrate()

    expect(refs.listId.value).toBeNull()
    expect(api.paintedFromCache.value).toBe(false)
  })

  it('does not paint over a list that has already loaded', () => {
    saveListSnapshot(localStorage, 'user-1', snapshot())
    const { api, refs } = mountSnapshot()
    refs.items.value = [item('live', 'Bread')]

    api.hydrate()

    expect(refs.items.value.map((i) => i.id)).toEqual(['live'])
    expect(api.paintedFromCache.value).toBe(false)
  })

  it('names no list as shopped when the snapshot says it has not', () => {
    saveListSnapshot(localStorage, 'user-1', snapshot({ hasShopped: false }))
    const { api } = mountSnapshot()

    api.hydrate()

    expect(api.cachedShoppedListId.value).toBe('')
  })

  it('discards a paint back to an empty screen', () => {
    saveListSnapshot(localStorage, 'user-1', snapshot())
    const { api, refs } = mountSnapshot()
    api.hydrate()

    api.discard()

    expect(refs.listId.value).toBeNull()
    expect(refs.items.value).toEqual([])
    expect(refs.listItemLimit.value).toBe(ITEM_LIMIT_DEFAULT)
    expect(api.paintedFromCache.value).toBe(false)
    expect(api.paintedFor('user-1')).toBe(false)
    expect(api.cachedShoppedListId.value).toBe('')
  })

  it('writes nothing until the first load has finished', async () => {
    const { api, refs } = mountSnapshot({ initialized: false })
    refs.listId.value = 'fam-1'
    refs.items.value = [item('a')]
    await nextTick()

    api.persist()
    api.flush()

    expect(loadListSnapshot(localStorage, 'user-1')).toBeNull()
  })

  it('coalesces a burst of changes into one write, flushed on unmount', async () => {
    const { refs, wrapper } = mountSnapshot({ initialized: true, shopped: true })
    refs.listId.value = 'fam-1'
    refs.listName.value = 'Home'
    refs.items.value = [item('a')]
    refs.items.value.push(item('b', 'Eggs'))
    await nextTick()

    // Still inside the window: nothing written yet.
    expect(loadListSnapshot(localStorage, 'user-1')).toBeNull()
    wrapper.unmount()

    const saved = loadListSnapshot(localStorage, 'user-1')
    expect(saved.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(saved.hasShopped).toBe(true)
  })
})
