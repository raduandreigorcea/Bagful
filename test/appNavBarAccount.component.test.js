// @vitest-environment happy-dom
//
// When the app cold-boots offline, Clerk can't load so `useUser` yields a null
// user. The account button and menu must still show who's signed in, pulled
// from the cached list roster for the current user.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import AppNavBar from '../src/components/AppNavBar.vue'
import AccountActionModal from '../src/components/AccountActionModal.vue'
import ConfirmModal from '../src/components/ConfirmModal.vue'
import { clearOfflineQueue, enqueueOfflineMutation } from '../src/lib/offlineQueue'

const clerkUser = vi.hoisted(() => ({ value: null }))

vi.mock('@clerk/vue', () => ({
  useUser: () => ({ user: clerkUser }),
  useClerk: () => ref({ openUserProfile: vi.fn(), signOut: vi.fn() }),
  useAuth: () => ({ userId: ref(null), getToken: ref(async () => null) }),
}))

// AccountActionModal (always mounted inside the bar) talks to Supabase for
// notification prefs; stub it so the bar can mount in isolation.
vi.mock('../src/supabase', () => ({
  useSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
  getCatalogSupabase: () => null,
}))

// Sign out detaches the account from error reporting; the module is mocked so
// the call can be asserted on without an SDK anywhere near the test.
const identifyUser = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/errorReporting', () => ({
  captureException: vi.fn(),
  identifyUser,
}))

vi.mock('../src/lib/pushNotifications', async (importOriginal) => ({
  // Keep the real localStorage-backed preference helpers; only the SDK-touching
  // functions need stubbing.
  ...(await importOriginal()),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn(),
}))

const wrappers = []
function mountBar(props) {
  const w = mount(AppNavBar, { props })
  wrappers.push(w)
  return w
}

beforeEach(() => {
  clerkUser.value = null
  identifyUser.mockClear()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
  vi.restoreAllMocks()
})

const profiles = [
  { user_id: 'u_self', display_name: 'Radu Gorcea', image_url: '', role: 'owner' },
  { user_id: 'u_other', display_name: 'Alex', image_url: '', role: 'member' },
]

describe('AppNavBar account identity offline', () => {
  it('falls back to the cached profile when Clerk has no user', () => {
    const wrapper = mountBar({
      listName: 'Home',
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    // Avatar button shows the cached user's initial, not the empty '?'.
    expect(wrapper.find('.user-avatar-fallback').text()).toBe('R')

    // The account menu receives the cached display name.
    const modal = wrapper.findComponent(AccountActionModal)
    expect(modal.props('displayName')).toBe('Radu Gorcea')
    expect(modal.props('initial')).toBe('R')
  })

  it('shows the generic Account label when no cached profile matches', () => {
    const wrapper = mountBar({
      listName: 'Home',
      memberProfiles: profiles,
      currentUserId: 'u_missing',
    })

    const modal = wrapper.findComponent(AccountActionModal)
    expect(modal.props('displayName')).toBe('Account')
    expect(wrapper.find('.user-avatar-fallback').text()).toBe('?')
  })

  it('prefers the live Clerk user when it is available', () => {
    clerkUser.value = {
      fullName: 'Clerk Name',
      imageUrl: 'https://img/avatar.png',
      primaryEmailAddress: { emailAddress: 'clerk@example.com' },
    }
    const wrapper = mountBar({
      listName: 'Home',
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    const modal = wrapper.findComponent(AccountActionModal)
    expect(modal.props('displayName')).toBe('Clerk Name')
    expect(modal.props('avatarUrl')).toBe('https://img/avatar.png')
    expect(modal.props('email')).toBe('clerk@example.com')
  })
})

describe('AppNavBar list block', () => {
  const lists = [
    { id: 'fam-1', name: 'Home' },
    { id: 'fam-2', name: 'Parents' },
  ]

  // The list's own emoji anchors the block, the same square it wears on its
  // row in the account dialog.
  it('leads the list block with its emoji', () => {
    const wrapper = mountBar({
      listId: 'fam-1',
      listName: 'Home',
      listEmoji: 'HOUSEEMOJI',
      lists,
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    expect(wrapper.find('.list-btn .list-emoji').text()).toBe('HOUSEEMOJI')
  })

  // The account dialog is about YOU. Which list is on screen is a
  // fact about the screen, so the roster goes to the switcher instead and this
  // dialog is not even told about it.
  it('keeps the list roster out of the account dialog', () => {
    const wrapper = mountBar({
      listId: 'fam-1',
      listName: 'Home',
      lists,
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    const modal = wrapper.findComponent(AccountActionModal)
    expect(modal.props('lists')).toBeUndefined()
    expect(modal.props('listId')).toBeUndefined()
  })


})


// Reporting a problem sits with sign out at the bottom rather than among the
// four rows above it: those lead further into the app, these two are the ways of
// stepping outside it. Sign out stays last, since it ends the session.
describe('AccountActionModal report issue', () => {
  function mountAccount(props) {
    const w = mount(AccountActionModal, { props: { open: true, ...props } })
    wrappers.push(w)
    return w
  }

  it('offers a report row and emits from it', async () => {
    const wrapper = mountAccount({ listName: 'Home' })

    const row = wrapper.find('.account-report-item')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('Report an issue')

    await row.trigger('click')
    expect(wrapper.emitted('report-issue')).toBeTruthy()
  })

  it('keeps sign out as the last row', () => {
    const wrapper = mountAccount({ listName: 'Home' })

    const rows = wrapper.findAll('.account-menu-item')
    const last = rows[rows.length - 1]
    expect(last.classes()).toContain('account-menu-item--danger')
    expect(rows[rows.length - 2].classes()).toContain('account-report-item')
  })

  it('reaches the navbar as a handled event', () => {
    const wrapper = mountBar({
      listName: 'Home',
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    const modal = wrapper.findComponent(AccountActionModal)
    modal.vm.$emit('report-issue')
    // Handled locally, so it closes the dialog rather than bubbling out of the bar.
    expect(wrapper.emitted('report-issue')).toBeFalsy()
    expect(modal.props('open')).toBe(false)
  })
})

// The rows are near-identically shaped, so the icon is what tells them apart at
// a glance. A row added later without one would be the odd one out, which is
// what this guards.
describe('AccountActionModal row icons', () => {
  function mountAccount(props) {
    const w = mount(AccountActionModal, { props: { open: true, ...props } })
    wrappers.push(w)
    return w
  }

  it('leads every row with a mark, and never the same one twice', () => {
    const wrapper = mountAccount({
      listName: 'Home',
      lists: [{ id: 'fam-1', name: 'Home', emoji: 'E1' }],
      listId: 'fam-1',
    })

    // No exceptions, sign out included.
    for (const row of wrapper.findAll('.account-menu-item')) {
      const mark = row.find('.account-item-icon, .account-list-emoji')
      expect(mark.exists(), `no icon on: ${row.text()}`).toBe(true)
    }

    const svgs = wrapper.findAll('.account-item-icon svg')
    const shapes = svgs.map((s) => s.attributes('class'))
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  // The row used to empty to a bare spinner, which said something was happening
  // but not what. Only the mark is replaced now.
  it('keeps sign out named while it is signing out', () => {
    const wrapper = mountAccount({ listName: 'Home', loadingSignOut: true })

    const row = wrapper.find('.account-menu-item--danger')
    expect(row.text()).toContain('Signing out')
    expect(row.find('.account-spinner').exists()).toBe(true)
    expect(row.find('.account-item-icon').exists()).toBe(false)
  })
})

// Sentry's setUser is sticky module state rather than something stamped on each
// event, so an account left attached at sign-out would be blamed for whatever
// the next person on the device hits. The redirect usually ends the page first;
// this covers the case where it does not.
describe('AppNavBar sign out', () => {
  it('detaches the account from error reporting', async () => {
    const wrapper = mountBar({
      listName: 'Home',
      memberProfiles: profiles,
      currentUserId: 'u_self',
    })

    wrapper.findComponent(AccountActionModal).vm.$emit('sign-out')
    await flushPromises()
    wrapper.findComponent(ConfirmModal).vm.$emit('confirm')
    await flushPromises()

    expect(identifyUser).toHaveBeenCalledWith(null)
  })

  // Found by the bot swarm: Sign out was one tap with nothing in between, and
  // a stray tap on it (the row sits where the account menu opens) signed a
  // bot out mid-shop. It asks first now, like every other hard-to-undo action.
  it('asks first, and a Cancel keeps you signed in', async () => {
    const wrapper = mountBar({ listName: 'Home', memberProfiles: profiles, currentUserId: 'u_self' })

    wrapper.findComponent(AccountActionModal).vm.$emit('sign-out')
    await flushPromises()
    const dialog = wrapper.findComponent(ConfirmModal)
    expect(dialog.props('open')).toBe(true)
    expect(identifyUser).not.toHaveBeenCalledWith(null)

    dialog.vm.$emit('cancel')
    await flushPromises()
    expect(dialog.props('open')).toBe(false)
    expect(identifyUser).not.toHaveBeenCalledWith(null)
  })

  // Signing out deletes the offline queue, so the question has to say so when
  // there is something in it.
  it('warns that unsent changes are lost, only when there are some', async () => {
    const ask = async () => {
      const wrapper = mountBar({ listName: 'Home', memberProfiles: profiles, currentUserId: 'u_self' })
      wrapper.findComponent(AccountActionModal).vm.$emit('sign-out')
      await flushPromises()
      return wrapper.findComponent(ConfirmModal).props('message')
    }

    expect(await ask()).not.toMatch(/sent yet/)

    enqueueOfflineMutation(localStorage, 'u_self', { kind: 'delete', id: 'item-1' })
    try {
      expect(await ask()).toMatch(/sent yet/)
    } finally {
      clearOfflineQueue(localStorage)
    }
  })
})
