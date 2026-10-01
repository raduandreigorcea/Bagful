// @vitest-environment happy-dom
//
// Deleting an account has to delete the data before the Clerk user: the other
// order leaves lists and a profile behind that nobody can sign in to remove,
// which is what Clerk's own UserProfile did. These pin that order, that a failed
// RPC stops everything, and that the owned list goes to the member picked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AccountProfileModal from '../src/components/AccountProfileModal.vue'
import ConfirmModal from '../src/components/ConfirmModal.vue'
import { createFakeDb } from './support/fakeSupabase.js'

const mocks = vi.hoisted(() => ({ db: null, user: null, order: [], signOut: null }))

vi.mock('../src/supabase', () => ({ useSupabase: () => mocks.db }))
vi.mock('../src/lib/useSignOut', () => ({
  useSignOut: () => ({ signingOut: { value: false }, signOut: (...a) => mocks.signOut(...a) }),
}))
vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return {
    useAuth: () => ({ userId: ref('me'), isLoaded: ref(true), getToken: ref(async () => 'token') }),
    useUser: () => ({ user: ref(mocks.user) }),
    useClerk: () => ref({}),
  }
})

beforeEach(() => {
  localStorage.clear()
  mocks.order = []
  mocks.db = createFakeDb()
  mocks.db.handlers['profiles.upsert'] = () => ({ data: null, error: null })
  mocks.signOut = vi.fn(async () => mocks.order.push('signOut'))
  mocks.user = {
    fullName: 'Ana Pop',
    firstName: 'Ana',
    imageUrl: null,
    hasImage: false,
    externalAccounts: [{ provider: 'google' }],
    primaryEmailAddress: { emailAddress: 'ana@example.com' },
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => mocks.order.push('clerk')),
  }
  window.location.replace = vi.fn()
})

const rpcCalls = (fn) => mocks.db.calls.filter((c) => c.table === 'rpc' && c.op === fn)

async function pressDelete(wrapper) {
  const button = wrapper.findAll('button').find((b) => b.text() === 'Delete account')
  await button.trigger('click')
  await flushPromises()
}

async function confirm(wrapper) {
  wrapper.findComponent(ConfirmModal).vm.$emit('confirm')
  await flushPromises()
}

describe('AccountProfileModal', () => {
  it('deletes the data, then the Clerk user, then signs out', async () => {
    mocks.db.handlers['rpc.account_transfer_candidates'] = () => ({ data: [], error: null })
    mocks.db.handlers['rpc.delete_my_account'] = () => {
      mocks.order.push('rpc')
      return { data: null, error: null }
    }
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    await pressDelete(wrapper)
    await confirm(wrapper)

    expect(rpcCalls('delete_my_account')[0].params).toEqual({ p_new_owner: undefined })
    expect(mocks.order).toEqual(['rpc', 'clerk', 'signOut'])
    expect(window.location.replace).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('stops when the database refuses', async () => {
    mocks.db.handlers['rpc.account_transfer_candidates'] = () => ({ data: [], error: null })
    mocks.db.handlers['rpc.delete_my_account'] = () => ({ data: null, error: { message: 'nope' } })
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    await pressDelete(wrapper)
    await confirm(wrapper)

    expect(mocks.user.delete).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hands the list to the first member who can take it', async () => {
    mocks.db.handlers['rpc.account_transfer_candidates'] = () => ({
      data: [
        { user_id: 'busy', display_name: 'Busy', image_url: null, owns_list: true },
        { user_id: 'mem', display_name: 'Mem', image_url: null, owns_list: false },
      ],
      error: null,
    })
    mocks.db.handlers['rpc.delete_my_account'] = () => ({ data: null, error: null })
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    await pressDelete(wrapper)
    expect(wrapper.find('input[value="busy"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('h3').text()).toBe('Delete account')
    await pressDelete(wrapper)
    expect(wrapper.findComponent(ConfirmModal).props('message')).toContain('Mem becomes the owner')
    await confirm(wrapper)

    expect(rpcCalls('delete_my_account')[0].params).toEqual({ p_new_owner: 'mem' })
    wrapper.unmount()
  })

  it('saves a new name to Clerk and the profiles row', async () => {
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    await wrapper.find('input[type="text"]').setValue('Maria Ana Pop')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(mocks.user.update).toHaveBeenCalledWith({ firstName: 'Maria', lastName: 'Ana Pop' })
    expect(mocks.db.calls.some((c) => c.table === 'profiles' && c.op === 'upsert')).toBe(true)
    wrapper.unmount()
  })

  it('links Google on the web by sending the browser to Clerk', async () => {
    mocks.user.createExternalAccount = vi.fn(async () => ({
      verification: { externalVerificationRedirectURL: new URL('https://accounts.google.com/x') },
    }))
    window.location.assign = vi.fn()
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    await wrapper.findAll('button').find((b) => b.text() === 'Link').trigger('click')
    await flushPromises()

    expect(mocks.user.createExternalAccount).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'oauth_google' }),
    )
    expect(window.location.assign).toHaveBeenCalledWith('https://accounts.google.com/x')
    wrapper.unmount()
  })

  it('unlinks a verified Google account only after confirming', async () => {
    const destroy = vi.fn(async () => {})
    mocks.user.reload = vi.fn(async () => {})
    mocks.user.externalAccounts = [
      { provider: 'google', emailAddress: 'ana@gmail.com', verification: { status: 'verified' }, destroy },
    ]
    const wrapper = mount(AccountProfileModal, { props: { open: true } })
    expect(wrapper.text()).toContain('ana@gmail.com')

    await wrapper.findAll('button').find((b) => b.text() === 'Unlink').trigger('click')
    await flushPromises()
    expect(destroy).not.toHaveBeenCalled()
    await confirm(wrapper)

    expect(destroy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ties a failed name save to the field', async () => {
    mocks.user.update = vi.fn(async () => {
      throw new Error('nope')
    })
    const wrapper = mount(AccountProfileModal, { props: { open: true } })

    const input = wrapper.find('input[type="text"]')
    await input.setValue('Maria')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const error = wrapper.find('form [role="alert"]')
    expect(error.exists()).toBe(true)
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe(error.attributes('id'))
    wrapper.unmount()
  })

  it('moves focus into the transfer step and back to Delete account', async () => {
    mocks.db.handlers['rpc.account_transfer_candidates'] = () => ({
      data: [{ user_id: 'mem', display_name: 'Mem', image_url: null, owns_list: false }],
      error: null,
    })
    const wrapper = mount(AccountProfileModal, { props: { open: true }, attachTo: document.body })

    await pressDelete(wrapper)
    expect(document.activeElement?.textContent).toContain('Who takes over your list?')

    await wrapper.findAll('button').find((b) => b.text() === 'Back').trigger('click')
    await flushPromises()
    expect(document.activeElement?.textContent).toContain('Delete account')
    wrapper.unmount()
  })
})
