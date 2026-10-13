// The list's "By aisle" order is derived from the icon a product gets, so every
// icon a rule can produce must belong to an aisle, and have a drawing. A rule
// without an aisle would not fail anything visibly; its products would just drift
// to "Other". One without a drawing would show the generic basket.
import { describe, it, expect } from 'vitest'
import { AISLES, RULE_ICONS, aisleForIcon, getProductAisle } from '../src/lib/productIcon'

describe('getProductAisle', () => {
  it('places every icon the rules produce in an aisle', () => {
    const unplaced = RULE_ICONS.filter((icon) => aisleForIcon(icon) === 'other')
    expect(unplaced).toEqual([])
  })

  // The gate for merging feat/product-icons: no emoji is left to fall back on,
  // so a rule whose drawing is missing shows the generic basket. Both directions,
  // so a drawing nobody asks for does not sit in the bundle either.
  const DRAWN = Object.keys(import.meta.glob('../src/assets/product-icons/*.svg')).map((p) =>
    p.replace('../src/assets/product-icons/', '').replace('.svg', ''),
  )
  it('has a drawing for every icon the rules produce', () => {
    expect(RULE_ICONS.filter((icon) => !DRAWN.includes(icon))).toEqual([])
  })
  it('uses every drawing', () => {
    expect(DRAWN.filter((icon) => icon !== 'generic' && !RULE_ICONS.includes(icon))).toEqual([])
  })

  it('sorts common Romanian products where a shopper finds them', () => {
    expect(getProductAisle('Lapte', 'Zuzu')).toBe('dairy')
    expect(getProductAisle('Mere')).toBe('produce')
    expect(getProductAisle('Paine')).toBe('bakery')
    expect(getProductAisle('Piept de pui')).toBe('meat')
    expect(getProductAisle('Apa minerala', 'Borsec')).toBe('drinks')
    expect(getProductAisle('Detergent de vase')).toBe('household')
    expect(getProductAisle('Pasta de dinti')).toBe('personal')
    expect(getProductAisle('Chipsuri cu smantana')).toBe('sweets')
  })

  it('keeps a sauce in the pantry however fresh its flavour sounds', () => {
    // "usturoi" is longer than "sos", so the garlic used to win and the sauce
    // landed with the fruit and vegetables.
    expect(getProductAisle('Sos de usturoi')).toBe('pantry')
    expect(getProductAisle('Garlic sauce')).toBe('pantry')
    expect(getProductAisle('Sos de rosii')).toBe('pantry')
    expect(getProductAisle('Maioneza')).toBe('pantry')
    expect(getProductAisle('Usturoi')).toBe('produce')
  })

  it('puts what it cannot place under other, last', () => {
    expect(getProductAisle('Ceva necunoscut')).toBe('other')
    expect(AISLES[AISLES.length - 1]).toBe('other')
  })
})
