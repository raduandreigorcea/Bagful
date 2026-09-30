// @vitest-environment happy-dom
//
// The catalog is built from what Auchan, Carrefour and Lidl actually list, and
// the app says so somewhere a user can reach.
//
// THIS USED TO BE A LICENCE TEST. The catalog was imported from Open Food Facts
// and its two sibling projects, all ODbL, which obliged anyone publishing an app
// built on it to credit them. That obligation is gone with those sources -- but
// the test is kept, because what it really guards is the ROUTE: the credit used
// to sit in an About tab inside the list settings dialog, and moving About
// out of there is exactly the kind of change that drops it on the floor. It
// very nearly did.
//
// So this is now a courtesy rather than a licence term, tested to the same
// standard, because a credit nobody tests is one a redesign quietly deletes.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AppSettingsModal from '../src/components/AppSettingsModal.vue'
import AccountActionModal from '../src/components/AccountActionModal.vue'
import ListSettingsModal from '../src/components/ListSettingsModal.vue'

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return {
    useAuth: () => ({ userId: ref('user-1'), isLoaded: ref(true), getToken: ref(async () => 't') }),
    useUser: () => ({ user: ref({ fullName: 'Test User', imageUrl: null }) }),
  }
})

vi.mock('../src/supabase', () => ({
  useSupabase: () => ({}),
  getCatalogSupabase: () => null,
}))
vi.mock('../src/lib/pushNotifications', async (importOriginal) => ({
  ...(await importOriginal()),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn(),
}))

// AppModal stays real: it is the shell the dialog renders through, and stubbing
// it drops the slot and with it the whole body this file inspects.
function mountAppSettings() {
  return mount(AppSettingsModal, {
    global: { stubs: { AppModal: false } },
    props: { open: true },
  })
}

// The credit lives behind an About button now. "Somewhere a user can reach" is
// the obligation, so opening it is part of what these assert rather than a
// detail to work around — if the button stops opening it, that is the failure.
async function openAbout() {
  const wrapper = mountAppSettings()
  const button = wrapper.findAll('button').find((b) => b.text().includes('About'))
  if (!button) throw new Error('no About button in App Settings')
  await button.trigger('click')
  return wrapper
}

const attributionLinks = (wrapper) =>
  wrapper
    .findAll('a')
    .filter((a) =>
      /auchan\.ro|carrefour\.ro|lidl\.ro/.test(a.attributes('href') ?? ''),
    )

describe('product data attribution', () => {
  it('is rendered where a user can see it', async () => {
    const text = (await openAbout()).text()
    // Every shop the catalog actually reads, not just the biggest one.
    expect(text).toContain('Auchan')
    expect(text).toContain('Carrefour')
    expect(text).toContain('Lidl')
  })

  it('no longer claims a licence it is not using', async () => {
    // The catalog was rebuilt around retailer listings on 2026-09-04. Leaving
    // an ODbL notice up for data the app no longer touches would be a false
    // statement about where its data comes from.
    const text = (await openAbout()).text()
    expect(text).not.toContain('Open Food Facts')
    expect(text).not.toContain('ODbL')
  })

  it('links to each shop', async () => {
    const hrefs = attributionLinks(await openAbout()).map((a) => a.attributes('href'))
    expect(hrefs).toContain('https://www.auchan.ro')
    expect(hrefs).toContain('https://carrefour.ro')
    expect(hrefs).toContain('https://www.lidl.ro')
  })

  it('opens those links safely', async () => {
    // rel=noopener because target=_blank otherwise hands the opened page a
    // reference back to this one.
    for (const link of attributionLinks(await openAbout())) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toContain('noopener')
    }
  })

  it('has a labelled way in, not just markup that exists', () => {
    const wrapper = mountAppSettings()
    const button = wrapper.findAll('button').find((b) => b.text().includes('About'))
    expect(button).toBeTruthy()
    // Closed until asked for: the credit must be reachable, not permanently on
    // screen, and this is the line between the two.
    expect(attributionLinks(wrapper)).toHaveLength(0)
  })

  // The point is that a user can REACH the credit, so the route to it is part
  // of what this file guards, not just the markup.
  it('is reachable from the account dialog', () => {
    const wrapper = mount(AccountActionModal, {
      global: { stubs: { AppModal: false } },
      props: { open: true, displayName: 'Radu', listName: 'Acasa' },
    })

    const row = wrapper
      .findAll('.account-menu-item')
      .find((b) => b.text().includes('App settings'))
    expect(row).toBeTruthy()

    row.trigger('click')
    expect(wrapper.emitted('app-settings')).toBeTruthy()
  })
})

describe('the About section', () => {
  it('names the app and shows its logo', async () => {
    const wrapper = await openAbout()
    expect(wrapper.text()).toContain('Bagful')
    expect(wrapper.find('.about-logo').exists()).toBe(true)
  })

  // Injected from package.json at build time, so a version bump there is the
  // only step. A hardcoded string would drift the moment anyone released.
  it('shows the real version, not a hardcoded one', async () => {
    const { version } = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')),
    )
    expect((await openAbout()).find('.about-version').text()).toBe(`v${version}`)
  })

  it('no longer sits in the list dialog', () => {
    // About describes the app, not a list. If it reappears among the
    // list tabs, the split this dialog is built on has been undone.
    const wrapper = mount(ListSettingsModal, {
      shallow: true,
      global: { stubs: { AppModal: false } },
      props: {
        open: true,
        listId: 'fam-1',
        listName: 'Fam',
        inviteCode: 'ABCDEFGH',
        ownerUserId: 'user-1',
        memberProfiles: [],
      },
    })

    const labels = wrapper.findAll('.sidebar-tab-btn').map((b) => b.text())
    expect(labels).not.toContain('About')
    expect(attributionLinks(wrapper)).toHaveLength(0)
  })
})
