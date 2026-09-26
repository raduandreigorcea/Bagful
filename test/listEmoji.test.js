import { describe, it, expect } from 'vitest'
import { DEFAULT_LIST_EMOJI, LIST_EMOJIS, listIconUrl } from '../src/lib/listEmoji'

describe('list icons', () => {
  it('has a picture for every icon the picker offers, and for the default', () => {
    for (const name of [...LIST_EMOJIS, DEFAULT_LIST_EMOJI]) expect(listIconUrl(name), name).toBeTruthy()
  })

  // Lists saved before the switch hold an emoji. The ones with a 3D twin are
  // drawn as it; the rest stay text rather than silently becoming a bag.
  it('draws an old emoji as its 3D twin, and leaves the rest as text', () => {
    expect(listIconUrl('☕')).toBe(listIconUrl('tea-cup'))
    expect(listIconUrl('🛒')).toBe(listIconUrl('bag'))
    expect(listIconUrl('🍕')).toBeNull()
  })

  it('fits every name in the column, which caps at 16 characters', () => {
    for (const name of LIST_EMOJIS) expect(name.length).toBeLessThanOrEqual(16)
  })
})
