// The one-time first-run sequence: gesture tour, then the notifications ask.
//
// The order is the point. Being asked for a push permission before you know
// what the app does is how you get a "no" that sticks, so the ask waits for the
// tour to close. These pin that handoff and the conditions under which the ask
// is skipped entirely — each of which exists so an unset preference re-asks
// later rather than burning the one chance.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useFirstRunGreeting } from '../src/lib/firstRunGreeting'

// onSettled is how anything else gets the screen after this sequence. It was
// added because the update offer used to run alongside start() instead of after
// it: on a fresh install the tour was already open, the offer saw a dialog on
// screen and stood down for good, and a freshly sideloaded old APK was never
// told it was old. Every path out of the sequence has to reach it, including the
// ones that show nothing at all.

const push = vi.hoisted(() => ({
  supported: true,
  appId: 'app-1',
  desktop: false,
  enableResult: 'subscribed',
  enableCalls: [],
}))

vi.mock('../src/lib/pushNotifications', () => ({
  isPushSupported: () => push.supported,
  getOneSignalAppId: () => push.appId,
  isDesktopBrowser: () => push.desktop,
  enablePushNotifications: async (id) => {
    push.enableCalls.push(id)
    return push.enableResult
  },
  // Keyed by account, like the real one: the preference is a standing answer
  // that belongs to whoever gave it, not to the device.
  getNotificationPreference: (s, userId) => {
    if (!userId) return null
    const v = s.getItem(`bagful-notifications:${userId}`)
    return v === 'on' || v === 'off' ? v : null
  },
  setNotificationPreference: (s, userId, mode) => {
    if (userId) s.setItem(`bagful-notifications:${userId}`, mode)
  },
}))

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  }
}

const greeting = (opts = {}) =>
  useFirstRunGreeting({
    userId: ref('user-1'),
    isOffline: () => false,
    storage: makeStorage(),
    ...opts,
  })

beforeEach(() => {
  push.supported = true
  push.appId = 'app-1'
  push.desktop = false
  push.enableResult = 'subscribed'
  push.enableCalls.length = 0
})

describe('the sequence', () => {
  it('opens the tour first for someone who has never seen it', () => {
    const g = greeting()
    g.start()

    expect(g.onboardingTourOpen.value).toBe(true)
    // Not both at once: the ask waits its turn.
    expect(g.notificationPromptOpen.value).toBe(false)
  })

  it('hands off to the notifications ask when the tour closes', () => {
    const g = greeting()
    g.start()
    g.closeTour()

    expect(g.onboardingTourOpen.value).toBe(false)
    expect(g.notificationPromptOpen.value).toBe(true)
  })

  it('goes straight to the ask for someone who has seen the tour', () => {
    const g = greeting({ storage: makeStorage({ 'bagful_tour_seen_v4': '1' }) })
    g.start()

    expect(g.onboardingTourOpen.value).toBe(false)
    expect(g.notificationPromptOpen.value).toBe(true)
  })

  it('does nothing at all without a signed-in user', () => {
    const g = greeting({ userId: ref(null) })
    g.start()

    expect(g.onboardingTourOpen.value).toBe(false)
    expect(g.notificationPromptOpen.value).toBe(false)
  })
})

// Every skip below leaves the preference unset on purpose, so the same account
// is asked again somewhere the answer can actually stick.
describe('when the ask would be pointless', () => {
  const seen = () => makeStorage({ 'bagful_tour_seen_v4': '1' })

  it('skips it where push is unsupported', () => {
    push.supported = false
    const g = greeting({ storage: seen() })
    g.start()
    expect(g.notificationPromptOpen.value).toBe(false)
  })

  it('skips it where push is not configured', () => {
    push.appId = ''
    const g = greeting({ storage: seen() })
    g.start()
    expect(g.notificationPromptOpen.value).toBe(false)
  })

  it('skips it offline, where subscribing needs the network', () => {
    const g = greeting({ storage: seen(), isOffline: () => true })
    g.start()
    expect(g.notificationPromptOpen.value).toBe(false)
  })

  it('skips it on desktop, so the phone still gets to ask', () => {
    push.desktop = true
    const g = greeting({ storage: seen() })
    g.start()
    expect(g.notificationPromptOpen.value).toBe(false)
  })

  it('never re-asks once a decision is stored', () => {
    const g = greeting({
      storage: makeStorage({ 'bagful_tour_seen_v4': '1', 'bagful-notifications:user-1': 'off' }),
    })
    g.start()
    expect(g.notificationPromptOpen.value).toBe(false)
  })
})

describe('answering the ask', () => {
  it('stores the decision on decline', () => {
    const storage = makeStorage()
    const g = greeting({ storage })
    g.declineNotifications()

    expect(g.notificationPromptOpen.value).toBe(false)
    expect(storage.getItem('bagful-notifications:user-1')).toBe('off')
  })

  it('stores it and subscribes on accept', async () => {
    const storage = makeStorage()
    const g = greeting({ storage })
    await g.acceptNotifications()

    expect(storage.getItem('bagful-notifications:user-1')).toBe('on')
    expect(push.enableCalls).toEqual(['user-1'])
    expect(g.notificationError.value).toBe('')
  })

  // A preference saying "on" while the browser is blocking is a preference that
  // lies, and the settings screen would then show a toggle that does nothing.
  it('reverts the preference when the browser refuses', async () => {
    push.enableResult = 'permission-denied'
    const storage = makeStorage()
    const g = greeting({ storage })
    await g.acceptNotifications()

    expect(storage.getItem('bagful-notifications:user-1')).toBe('off')
    expect(g.notificationError.value).toContain('blocked')
  })

  it('reverts it on an outright failure too', async () => {
    push.enableResult = 'error'
    const storage = makeStorage()
    const g = greeting({ storage })
    await g.acceptNotifications()

    expect(storage.getItem('bagful-notifications:user-1')).toBe('off')
    expect(g.notificationError.value).toContain('try again')
  })

  describe('handing the screen on', () => {
    it('does not settle while the tour is still up', () => {
      const onSettled = vi.fn()
      const g = greeting({ storage: makeStorage(), onSettled })
      g.start()

      expect(g.onboardingTourOpen.value).toBe(true)
      expect(g.isGreeting()).toBe(true)
      expect(onSettled).not.toHaveBeenCalled()
    })

    it('settles once the tour closes and nothing else is owed', () => {
      // The regression: a fresh install always opens the tour, so anything that
      // ran alongside start() found the screen busy and gave up permanently.
      const onSettled = vi.fn()
      const storage = makeStorage({ 'bagful-notifications:user-1': 'off' })
      const g = greeting({ storage, onSettled })

      g.start()
      expect(onSettled).not.toHaveBeenCalled()

      g.closeTour()
      expect(g.isGreeting()).toBe(false)
      expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('waits for the notifications ask when the tour hands off to it', () => {
      const onSettled = vi.fn()
      const g = greeting({ storage: makeStorage(), onSettled })

      g.start()
      g.closeTour()
      expect(g.notificationPromptOpen.value).toBe(true)
      expect(onSettled).not.toHaveBeenCalled()

      g.declineNotifications()
      expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('settles after the ask is accepted', async () => {
      const onSettled = vi.fn()
      const g = greeting({ storage: makeStorage(), onSettled })
      await g.acceptNotifications()
      expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('settles immediately for a returning user with nothing to show', () => {
      const onSettled = vi.fn()
      const storage = makeStorage({
        'bagful_tour_seen_v4': '1',
        'bagful-notifications:user-1': 'off',
      })
      greeting({ storage, onSettled }).start()

      expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('settles even when there is no user to greet', () => {
      // The update offer is not tied to being signed in; nothing downstream
      // should be stranded by an unresolved session.
      const onSettled = vi.fn()
      useFirstRunGreeting({
        userId: ref(null),
        isOffline: () => false,
        storage: makeStorage(),
        onSettled,
      }).start()

      expect(onSettled).toHaveBeenCalledTimes(1)
    })
  })
})
