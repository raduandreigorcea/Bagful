import { describe, it, expect } from 'vitest'
import { staleSubscriptionIds, oneSignalSubscriptionUrl, SUBSCRIPTION_ID } from '../supabase/functions/_shared/pushPrune.ts'

const sub = (id, over = {}) => ({ id, type: 'AndroidPush', enabled: true, device_model: 'Pixel 7', ...over })

describe('staleSubscriptionIds', () => {
  it('drops older installs of the same phone and keeps the live one', () => {
    expect(staleSubscriptionIds([sub('a'), sub('b'), sub('live')], 'live')).toEqual(['a', 'b'])
  })

  it('never touches a different phone that is still subscribed', () => {
    expect(staleSubscriptionIds([sub('old'), sub('moto', { device_model: 'moto g(60)s' }), sub('live')], 'live')).toEqual(['old'])
  })

  it('drops unsubscribed ones whatever the model, but not email or sms', () => {
    const subs = [sub('off', { enabled: false, device_model: 'Other' }), sub('mail', { type: 'Email', enabled: false }), sub('live')]
    expect(staleSubscriptionIds(subs, 'live')).toEqual(['off'])
  })

  it('does nothing when the live subscription is not in the list, or the input is junk', () => {
    expect(staleSubscriptionIds([sub('a'), sub('b')], 'live')).toEqual([])
    expect(staleSubscriptionIds(null, 'live')).toEqual([])
  })

  it('needs a model to call two subscriptions the same phone (browsers have none)', () => {
    const web = (id) => ({ id, type: 'ChromePush', enabled: true, device_model: '' })
    expect(staleSubscriptionIds([web('a'), web('live')], 'live')).toEqual([])
  })
})

describe('ids in the url', () => {
  it('accepts only a uuid', () => {
    expect(SUBSCRIPTION_ID.test('3f2b7c1e-9a4d-4e0b-8c55-0a1b2c3d4e5f')).toBe(true)
    expect(SUBSCRIPTION_ID.test('../users')).toBe(false)
    expect(oneSignalSubscriptionUrl('app', 'x')).toBe('https://api.onesignal.com/apps/app/subscriptions/x')
  })
})
