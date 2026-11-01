// @vitest-environment happy-dom
//
// Every write in the settings modal used to be `if (!error) { … }` with no else.
// A rejected save — RLS denial, dead connection, a unique-index collision on a
// regenerated invite code — stopped the spinner and did nothing else, which on
// screen is indistinguishable from success: the panel just sat there and the
// user walked away believing the change had landed.
//
// These cover the two shapes the failure takes: a plain save (rename) and a
// confirm-gated destructive action (leave/delete), the latter being the path
// that only ever reached console.error.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ListSettingsModal from '../src/components/ListSettingsModal.vue'
import ConfirmModal from '../src/components/ConfirmModal.vue'
import ErrorModal from '../src/components/ErrorModal.vue'

const currentUserId = vi.hoisted(() => ({ value: 'u_owner' }))

vi.mock('@clerk/vue', () => ({
  useAuth: () => ({ userId: currentUserId }),
}))

// Rejects whatever write the test names, so the component sees a real error
// object on exactly one path and clean results everywhere else.
const failing = vi.hoisted(() => ({ table: '', op: '', error: null }))

vi.mock('../src/supabase', () => ({
  useSupabase: () => ({
    from: (table) => {
      const q = {
        op: 'select',
        select: () => q,
        update: () => ((q.op = 'update'), q),
        delete: () => ((q.op = 'delete'), q),
        eq: () => q,
        then: (resolve) => {
          const rejected = table === failing.table && q.op === failing.op
          return Promise.resolve(
            rejected ? { data: null, error: failing.error } : { data: null, error: null },
          ).then(resolve)
        },
      }
      return q
    },
  }),
  getCatalogSupabase: () => null,
}))

// The confirm-gated paths await a promise that a later click resolves, then
// await the write itself — more turns than nextTick alone drains.
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

const wrappers = []

function mountSettings(props = {}) {
  const w = mount(ListSettingsModal, {
    props: {
      open: true,
      listId: 'fam_1',
      listName: 'Gorcea',
      inviteCode: 'ABCD2345',
      ownerUserId: 'u_owner',
      memberProfiles: [
        { user_id: 'u_owner', display_name: 'Radu', role: 'moderator' },
        { user_id: 'u_other', display_name: 'Alex', role: 'member' },
      ],
      ...props,
    },
  })
  wrappers.push(w)
  return w
}

// The dialog is only rendered while it has something to say, so its presence is
// the assertion.
const errorText = (w) => {
  const modal = w.findComponent(ErrorModal)
  return modal.exists() ? modal.props('message') : ''
}

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
  failing.table = ''
  failing.op = ''
  failing.error = null
  currentUserId.value = 'u_owner'
})

describe('settings writes that fail say so', () => {
  it('shows a message when renaming the list is rejected', async () => {
    failing.table = 'lists'
    failing.op = 'update'
    failing.error = { message: 'permission denied for table lists', code: '42501' }

    const wrapper = mountSettings()
    // Preferences tab, then edit the name and save.
    await wrapper.findAll('.sidebar-tab-btn')[1].trigger('click')
    await wrapper.find('#listNameInput').setValue('New Name')
    await wrapper.find('.panel-save-btn').trigger('click')
    await nextTick()
    await nextTick()

    expect(errorText(wrapper)).toBe('Could not rename the list.')
  })

  it('does not raise the dialog when the rename succeeds', async () => {
    const wrapper = mountSettings()
    await wrapper.findAll('.sidebar-tab-btn')[1].trigger('click')
    await wrapper.find('#listNameInput').setValue('New Name')
    await wrapper.find('.panel-save-btn').trigger('click')
    await nextTick()
    await nextTick()

    expect(errorText(wrapper)).toBe('')
    expect(wrapper.emitted('refresh-list')).toBeTruthy()
  })

  it('never puts the raw Postgres text on screen', async () => {
    failing.table = 'lists'
    failing.op = 'update'
    failing.error = { message: 'duplicate key value violates unique constraint "lists_pkey"' }

    const wrapper = mountSettings()
    await wrapper.findAll('.sidebar-tab-btn')[1].trigger('click')
    await wrapper.find('#listNameInput').setValue('New Name')
    await wrapper.find('.panel-save-btn').trigger('click')
    await nextTick()
    await nextTick()

    expect(errorText(wrapper)).not.toMatch(/unique constraint|duplicate key/)
  })

  it('reports a failed leave instead of only logging it', async () => {
    // A non-owner sees Leave rather than Delete.
    currentUserId.value = 'u_other'
    failing.table = 'list_members'
    failing.op = 'delete'
    failing.error = { message: 'network error', code: 'PGRST301' }

    const wrapper = mountSettings({ ownerUserId: 'u_owner' })
    // Danger zone is the fourth tab for a non-owner.
    const dangerTab = wrapper
      .findAll('.sidebar-tab-btn')
      .find((b) => b.text().includes('Danger zone'))
    await dangerTab.trigger('click')
    await wrapper.find('.danger-action-btn').trigger('click')
    await flush()

    // Confirm the "Leave list?" dialog, which is what runs the write.
    wrapper.findComponent(ConfirmModal).vm.$emit('confirm')
    await flush()

    expect(errorText(wrapper)).toBe('Could not leave the list.')
    // The user is still in the list, so the view must not move them on.
    expect(wrapper.emitted('list-left')).toBeFalsy()
  })

  it('reports a failed delete and keeps the user in the list', async () => {
    failing.table = 'lists'
    failing.op = 'delete'
    failing.error = { message: 'permission denied', code: '42501' }

    const wrapper = mountSettings()
    const dangerTab = wrapper
      .findAll('.sidebar-tab-btn')
      .find((b) => b.text().includes('Danger zone'))
    await dangerTab.trigger('click')
    await wrapper.find('.danger-action-btn--delete').trigger('click')
    await flush()

    wrapper.findComponent(ConfirmModal).vm.$emit('confirm')
    await flush()

    expect(errorText(wrapper)).toBe('Could not delete the list.')
    expect(wrapper.emitted('list-deleted')).toBeFalsy()
  })
})
