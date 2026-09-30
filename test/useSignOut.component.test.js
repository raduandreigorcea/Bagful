// @vitest-environment happy-dom
//
// Sign-out tears down four subsystems in a fixed order (see lib/useSignOut).
// These pin what the navbar tests cannot see: a second press is ignored, a
// failure at Clerk still leaves the device cleaned and the control usable, and
// the local state goes first, before anything that can fail.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({ order: [], clerkSignOut: null }))

vi.mock('@clerk/vue', async () => {
  const { ref } = await import('vue')
  return { useClerk: () => ref({ signOut: (...args) => mocks.clerkSignOut(...args) }) }
})
vi.mock('../src/lib/session', () => ({
  forgetLocalUserState: (_storage, userId) => mocks.order.push(['forget', userId]),
}))
vi.mock('../src/lib/pushNotifications', () => ({
  logoutPushUser: async () => mocks.order.push(['push']),
}))
vi.mock('../src/lib/errorReporting', () => ({
  identifyUser: (id) => mocks.order.push(['identify', id]),
  captureException: (error) => mocks.order.push(['captured', error.message]),
}))

import { useSignOut } from '../src/lib/useSignOut'

function mountSignOut(userId = 'user-1') {
  const onSignedOut = vi.fn()
  let api
  mount(
    defineComponent({
      setup() {
        api = useSignOut({ userId: () => userId, onSignedOut })
        return () => null
      },
    }),
  )
  return { ...api, onSignedOut }
}

beforeEach(() => {
  mocks.order = []
  mocks.clerkSignOut = vi.fn(async () => mocks.order.push(['clerk']))
})

describe('useSignOut', () => {
  it('clears local state first and asks Clerk last', async () => {
    const { signOut, onSignedOut } = mountSignOut()

    await signOut()

    expect(mocks.order).toEqual([['forget', 'user-1'], ['identify', null], ['push'], ['clerk']])
    expect(mocks.clerkSignOut).toHaveBeenCalledWith({ redirectUrl: `${window.location.origin}/login` })
    expect(onSignedOut).toHaveBeenCalledTimes(1)
  })

  it('clears every account on the device when it does not know whose it is', async () => {
    const { signOut } = mountSignOut('')

    await signOut()

    expect(mocks.order[0]).toEqual(['forget', undefined])
  })

  it('ignores a second press while the first is still running', async () => {
    let release
    mocks.clerkSignOut = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const { signOut, signingOut } = mountSignOut()

    const first = signOut()
    expect(signingOut.value).toBe(true)
    await signOut()
    release()
    await first

    expect(mocks.clerkSignOut).toHaveBeenCalledTimes(1)
    expect(signingOut.value).toBe(false)
  })

  it('reports a Clerk failure, with the device already cleaned, and can be pressed again', async () => {
    mocks.clerkSignOut = vi.fn(async () => {
      throw new Error('clerk down')
    })
    const { signOut, signingOut, onSignedOut } = mountSignOut()

    await expect(signOut()).resolves.toBeUndefined()

    expect(mocks.order[0]).toEqual(['forget', 'user-1'])
    expect(mocks.order).toContainEqual(['captured', 'clerk down'])
    expect(onSignedOut).not.toHaveBeenCalled()
    expect(signingOut.value).toBe(false)
  })
})
