import { describe, it, expect } from 'vitest'
import {
  PRODUCTION_PROJECT_REF, isProductionUrl, parseEnv, parseArgs,
  makeRng, pickWeighted, findDisagreement, isIgnoredConsole,
} from '../bots/core.mjs'
import { PRODUCTION_PROJECT_REF as APP_REF } from '../src/lib/appChannel'

describe('bots core', () => {
  it('knows the same production ref as the app', () => {
    expect(PRODUCTION_PROJECT_REF).toBe(APP_REF)
  })
  it('spots a production url and nothing else', () => {
    expect(isProductionUrl(`https://${APP_REF}.supabase.co`)).toBe(true)
    expect(isProductionUrl('https://abcdefdev.supabase.co')).toBe(false)
    expect(isProductionUrl('')).toBe(false)
  })
  it('parses an env file with quotes, comments and CRLF', () => {
    expect(parseEnv('# c\r\nA=1\r\nB="two"\nC=\'3\'\n')).toEqual({ A: '1', B: 'two', C: '3' })
  })
  it('parses args and rejects nonsense', () => {
    expect(parseArgs(['--minutes', '2', '--bots', '3', '--seed', '7', '--headed']))
      .toMatchObject({ minutes: 2, bots: 3, seed: 7, headed: true, setupOnly: false, keep: false })
    expect(() => parseArgs(['--bots', '7'])).toThrow(/at most 6/)
    expect(() => parseArgs(['--minutes', 'x'])).toThrow(/whole number/)
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/)
  })
  it('replays the same sequence from the same seed', () => {
    const a = makeRng(42), b = makeRng(42)
    const xs = Array.from({ length: 5 }, a)
    expect(Array.from({ length: 5 }, b)).toEqual(xs)
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true)
  })
  it('picks by weight', () => {
    const rng = makeRng(1)
    const counts = { a: 0, b: 0 }
    for (let i = 0; i < 1000; i++) counts[pickWeighted(rng, [{ id: 'a', weight: 9 }, { id: 'b', weight: 1 }]).id]++
    expect(counts.a).toBeGreaterThan(800)
    expect(counts.b).toBeGreaterThan(0)
  })
  it('finds the first bot that disagrees, ignoring order', () => {
    const milk = { name: 'Milk', checked: false, qty: 1 }
    const bread = { name: 'Bread', checked: true, qty: 2 }
    expect(findDisagreement([{ bot: 1, items: [milk, bread] }, { bot: 2, items: [bread, milk] }])).toBeNull()
    expect(findDisagreement([{ bot: 1, items: [milk] }, { bot: 2, items: [{ ...milk, qty: 2 }] }]))
      .toEqual({ a: 1, b: 2, onlyA: ['Milk| |x1'], onlyB: ['Milk| |x2'] })
    expect(findDisagreement([{ bot: 1, items: [milk] }])).toBeNull()
  })
  it('ignores known console noise only', () => {
    expect(isIgnoredConsole('[vite] connecting...')).toBe(true)
    expect(isIgnoredConsole('Failed to load resource: net::ERR_INTERNET_DISCONNECTED')).toBe(true)
    expect(isIgnoredConsole('Failed to load resource: the server responded with a status of 401 ()')).toBe(true)
    expect(isIgnoredConsole('Failed to load resource: the server responded with a status of 500')).toBe(false)
    expect(isIgnoredConsole('TypeError: x is undefined')).toBe(false)
  })
})
