// @vitest-environment happy-dom
//
// The list screen's header: one header on every width, meaning the same thing
// on a phone and a desktop. It replaced a five-slot bottom bar on the phone and
// a different desktop header, where the list name opened a different
// dialog on each.
//
// What it must do: say whose list this is and how much is left, open the
// list sheet from the name (the one door to members, invite, switching and
// settings), and keep history and the account one tap away.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import AppNavBar from '../src/components/AppNavBar.vue'
import { setLocale } from '../src/lib/i18n'
import ListSheet from '../src/components/ListSheet.vue'
import ListMembersCard from '../src/components/ListMembersCard.vue'
import ListSettingsModal from '../src/components/ListSettingsModal.vue'
import AccountActionModal from '../src/components/AccountActionModal.vue'

vi.mock('@clerk/vue', () => ({
  useUser: () => ({ user: ref(null) }),
  useClerk: () => ref({ openUserProfile: vi.fn(), signOut: vi.fn() }),
  useAuth: () => ({ userId: ref(null), getToken: ref(async () => null) }),
}))

vi.mock('../src/supabase', () => ({
  useSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
  getCatalogSupabase: () => null,
}))

const MEMBERS = [
  { user_id: 'u_self', display_name: 'Radu', image_url: null, role: 'member' },
  { user_id: 'u_ana', display_name: 'Ana', image_url: null, role: 'moderator' },
]

const wrappers = []
function mountBar(props = {}) {
  const w = mount(AppNavBar, {
    props: {
      layout: 'bar',
      listId: 'hh-1',
      listName: 'Gorcea',
      lists: [{ id: 'hh-1', name: 'Gorcea' }, { id: 'hh-2', name: 'Bunica' }],
      currentUserId: 'u_self',
      ownerUserId: 'u_ana',
      memberProfiles: MEMBERS,
      ...props,
    },
  })
  wrappers.push(w)
  return w
}

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('the list header', () => {
  // The phone's bottom bar: five slots, the add disc in the middle. Lists is
  // the sheet of lists, List is where you are, Add only reports the press.
  // Green is the list's; the setup screen draws the same header plain.
  it('wears the brand green only on the list', () => {
    expect(mountBar().find('.topbar--list').exists()).toBe(true)
    expect(mountBar({ layout: 'header' }).find('.topbar--list').exists()).toBe(false)
  })

  it('draws the five-slot bar with Add in the middle', () => {
    const labels = mountBar().findAll('.nav-slot__label').map((l) => l.text())
    expect(labels).toEqual(['List', 'History', 'Add', 'Lists', 'You'])
  })

  it('reports the add press rather than opening anything itself', async () => {
    const wrapper = mountBar()
    await wrapper.find('.nav-slot--add').trigger('click')
    expect(wrapper.emitted('add')).toHaveLength(1)
  })

  it('opens the sheet of lists from Lists', async () => {
    const wrapper = mountBar()
    await wrapper.findAll('.nav-slot')[3].trigger('click')
    const sheet = wrapper.findComponent(ListSheet)
    expect(sheet.props('open')).toBe(true)
    expect(sheet.props('mode')).toBe('lists')
  })

  // The List slot is where you already are: it opens nothing.
  it('scrolls to the top from List instead of opening settings', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      const wrapper = mountBar()
      await wrapper.findAll('.nav-slot')[0].trigger('click')
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
      expect(wrapper.findComponent(ListSheet).props('open')).toBe(false)
      expect(wrapper.find('.nav-slot').attributes('aria-current')).toBe('page')
    } finally {
      scrollTo.mockRestore()
    }
  })

  // The name, who is in the list, and how far this trip has got. No
  // count in words: the list's own header already has it.
  it('names the list, with its faces and the trip progress under it', () => {
    // Four rows, one of them "x10" and ticked: 10 of 13 things picked up.
    const wrapper = mountBar({
      listEmoji: '🏡',
      totalCount: 4,
      checkedCount: 1,
      totalUnits: 13,
      checkedUnits: 10,
    })
    expect(wrapper.find('.list-name').text()).toContain('Gorcea')
    expect(wrapper.find('.list-emoji').text()).toBe('🏡')
    expect(wrapper.findAll('.list-subrow .member-avatar')).toHaveLength(2)

    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.attributes('aria-valuenow')).toBe('10')
    expect(bar.attributes('aria-valuemax')).toBe('13')
    // The fill goes by quantity; the words above it still count rows left.
    expect(wrapper.find('.list-progress__fill').attributes('style')).toContain('width: 77%')
    expect(wrapper.find('.list-progress__label').text()).toBe('3 items')
  })

  // What is left, over the bar that shows it going; rows, not units.
  it('says how many products are left above the bar', () => {
    const label = (props) => mountBar(props).find('.list-progress__label').text()
    expect(label({ totalCount: 5, checkedCount: 3 })).toBe('2 items')
    expect(label({ totalCount: 5, checkedCount: 4 })).toBe('1 item')

    const done = mountBar({ totalCount: 5, checkedCount: 5 })
    expect(done.find('.list-progress__label').text()).toBe("Everything's in the cart")
    expect(done.find('.list-progress--done').exists()).toBe(true)
  })

  // Romanian has three plural forms and "de" from 20 up; the boundary is what
  // a naive ternary gets wrong.
  it('uses all three Romanian forms, including the 20 boundary', async () => {
    await setLocale('ro')
    try {
      const label = (left) =>
        mountBar({ totalCount: left + 1, checkedCount: 1 }).find('.list-progress__label').text()
      expect(label(1)).toBe('1 produs')
      expect(label(2)).toBe('2 produse')
      expect(label(19)).toBe('19 produse')
      expect(label(20)).toBe('20 de produse')
      expect(label(101)).toBe('101 produse')
    } finally {
      await setLocale('en')
    }
  })

  // The glint means "one more in", so it plays when the cart grows and not when
  // something is unticked.
  it('plays the glint when the cart grows, not when it shrinks', async () => {
    const wrapper = mountBar({ totalCount: 5, checkedCount: 1, totalUnits: 5, checkedUnits: 1 })
    expect(wrapper.find('.list-progress__shine').exists()).toBe(false)

    await wrapper.setProps({ checkedCount: 2, checkedUnits: 2 })
    const first = wrapper.find('.list-progress__shine')
    expect(first.exists()).toBe(true)

    await wrapper.setProps({ checkedCount: 1, checkedUnits: 1 })
    expect(wrapper.find('.list-progress__shine').element).toBe(first.element)
  })

  it('draws no progress bar over an empty list', () => {
    expect(mountBar({ totalCount: 0 }).find('[role="progressbar"]').exists()).toBe(false)
  })

  // The name is the one door to this list on every width. A phone gets the
  // list's own half of the sheet (the bar's Lists slot has the other); a
  // desktop has no bar, so it gets both.
  it('opens the list settings from the name on a phone, the sheet on a desktop', async () => {
    const realMatchMedia = window.matchMedia
    const stub = (desktop) => {
      window.matchMedia = () => ({
        matches: desktop,
        addEventListener() {},
        removeEventListener() {},
      })
    }
    try {
      stub(false)
      const phone = mountBar()
      const button = phone.find('button.list-btn')
      expect(button.attributes('aria-haspopup')).toBe('dialog')
      await button.trigger('click')
      await vi.waitFor(() => expect(phone.findComponent(ListSettingsModal).exists()).toBe(true))
      expect(phone.findComponent(ListSettingsModal).props('open')).toBe(true)
      expect(phone.findComponent(ListSheet).props('open')).toBe(false)

      stub(true)
      const desktop = mountBar()
      await desktop.find('button.list-btn').trigger('click')
      expect(desktop.findComponent(ListSheet).props('mode')).toBe('all')
    } finally {
      window.matchMedia = realMatchMedia
    }
  })

  it('switches list from the sheet and closes it', async () => {
    const wrapper = mountBar()
    await wrapper.find('.list-btn').trigger('click')
    wrapper.findComponent(ListSheet).vm.$emit('switch-list', 'hh-2')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('switch-list')).toEqual([['hh-2']])
    expect(wrapper.findComponent(ListSheet).props('open')).toBe(false)
  })

  it('keeps history and the account one tap away', async () => {
    const wrapper = mountBar()
    expect(wrapper.find('[aria-label="Checkout history"]').exists()).toBe(true)

    await wrapper.find('.user-avatar-btn').trigger('click')
    expect(wrapper.findComponent(AccountActionModal).props('open')).toBe(true)
  })
})

describe('the list sheet', () => {
  function mountSheet(props = {}) {
    const w = mount(ListSheet, {
      props: {
        open: true,
        listId: 'hh-1',
        listName: 'Gorcea',
        lists: [{ id: 'hh-1', name: 'Gorcea' }],
        members: MEMBERS,
        ownerUserId: 'u_ana',
        currentUserId: 'u_self',
        ...props,
      },
    })
    wrappers.push(w)
    return w
  }

  function mountCard(props = {}) {
    const w = mount(ListMembersCard, {
      props: { members: MEMBERS, ownerUserId: 'u_ana', currentUserId: 'u_self', ...props },
    })
    wrappers.push(w)
    return w
  }

  it('shows who is in it, you first by name', () => {
    const names = mountCard().findAll('.member__name:not(.member__name--invite)').map((n) => n.text())
    expect(names).toEqual(['You', 'Ana'])
  })

  it('marks the owner', () => {
    const roles = mountCard().findAll('.member__role').map((n) => n.text())
    expect(roles).toEqual(['Owner'])
  })

  it('offers the invite as the next face in the row', async () => {
    const wrapper = mountCard()
    const members = wrapper.findAll('.list-sheet__members > li')
    const invite = members.at(-1).find('.member__invite')
    expect(invite.text()).toBe('Invite')

    await invite.trigger('click')
    expect(wrapper.emitted('invite')).toHaveLength(1)
  })

  it('shows the members card in the full sheet', () => {
    expect(mountSheet().find('.members-card').exists()).toBe(true)
  })

  it('nudges a list of one toward inviting someone', () => {
    expect(mountCard({ members: [MEMBERS[0]] }).find('.list-sheet__alone').exists()).toBe(true)
    expect(mountCard().find('.list-sheet__alone').exists()).toBe(false)
  })

  it('does not report picking the list you are already on as a switch', async () => {
    const wrapper = mountSheet()
    await wrapper.find('[role="radio"]').trigger('click')
    expect(wrapper.emitted('switch-list')).toBeUndefined()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

// On a desktop a wheel only scrolls vertically, and this row has no scrollbar,
// so a big list's later faces were reachable by trackpad alone.
describe('scrolling a large list', () => {
  it('turns a vertical wheel into sideways travel while the row can move', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ user_id: `u${i}`, display_name: `M${i}` }))
    const w = mount(ListMembersCard, { props: { members: many } })
    wrappers.push(w)
    const row = w.find('.list-sheet__members').element
    Object.defineProperty(row, 'scrollWidth', { value: 800 })
    Object.defineProperty(row, 'clientWidth', { value: 300 })

    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true })
    row.dispatchEvent(event)
    expect(row.scrollLeft).toBe(120)
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets the wheel through when everyone fits', () => {
    const w = mount(ListMembersCard, { props: { members: MEMBERS } })
    wrappers.push(w)
    const row = w.find('.list-sheet__members').element
    Object.defineProperty(row, 'scrollWidth', { value: 300 })
    Object.defineProperty(row, 'clientWidth', { value: 300 })

    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true })
    row.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
