import { describe, it, expect } from 'vitest'
import { maskReplayText } from '../src/lib/replayText'
import en from '../src/locales/en'

describe('maskReplayText', () => {
  it('shows the apps own words and shop names, and blanks anything else', () => {
    const own = Object.values(en).find((v) => typeof v === 'string' && !v.includes('{'))
    expect(maskReplayText(own)).toBe(own)
    expect(maskReplayText('Mega Image')).toBe('Mega Image')
    expect(maskReplayText('Lapte de la Ana')).toBe('Lapte de la Ana'.replace(/\S/g, '*'))
    expect(maskReplayText('  ')).toBe('  ')
  })
})
