// The SVG assets, checked for the ways a broken one still looks like a file.
//
// This exists because a hand-edited brand mark shipped broken and looked
// plausible the whole way: the paths were emitted as opening tags with nothing
// closing them. `<path>` is not a void element in HTML, so the browser nested
// all nine inside the first one, children of a <path> are not rendered, and the
// mark drew as its own background square. A blue square clipped to a circle is a
// blue circle, which reads as "a logo that has not loaded" rather than as
// "malformed markup".
//
// Nothing else would have caught it. It is valid-enough markup, the file is the
// right size, the import resolves, and the component renders without error.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../src/assets/', import.meta.url))

function svgsIn(sub) {
  const path = dir + sub
  return readdirSync(path)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => ({ name: `${sub}${f}`, markup: readFileSync(path + f, 'utf8') }))
}

const ALL = [...svgsIn(''), ...svgsIn('brands/'), ...svgsIn('flags/')]

describe('svg assets', () => {
  it('finds the assets at all, so an empty glob cannot pass this file', () => {
    expect(ALL.length).toBeGreaterThan(20)
  })

  for (const { name, markup } of ALL) {
    describe(name, () => {
      it('closes every element it opens', () => {
        // The one that bit: nine <path> tags, nothing closing any of them.
        for (const tag of ['path', 'g', 'circle', 'rect', 'polygon', 'line']) {
          const opened = (markup.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length
          if (opened === 0) continue
          const closed =
            (markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length +
            (markup.match(new RegExp(`<${tag}\\b[^>]*/>`, 'g')) ?? []).length
          expect(closed, `${opened} <${tag}> opened, ${closed} closed`).toBe(opened)
        }
      })

      it('declares a viewBox, or it cannot be scaled by its caller', () => {
        // Every caller sizes these through CSS. Without a viewBox the glyph
        // renders at its intrinsic size and ignores the box it was given.
        expect(markup).toMatch(/viewBox="[\d.\s-]+"/)
      })

      it('is a single root svg element', () => {
        expect((markup.match(/<svg\b/g) ?? []).length).toBe(1)
        expect(markup).toContain('</svg>')
      })
    })
  }
})

describe('the shop marks specifically', () => {
  const brands = Object.fromEntries(svgsIn('brands/').map((b) => [b.name, b.markup]))

  it('keeps every colour the shop actually uses', () => {
    // Lidl's mark is its own favicon and the yellow is where the recognition
    // lives -- a monochrome version of it was a faint ring nobody could read at
    // this size. Flattening it again would look like a tidy-up.
    expect(brands['brands/lidl.svg']).toContain('#fff000')
    expect(brands['brands/lidl.svg']).toContain('#e60a14')
  })

  it('never leaves a mark tinted by the theme', () => {
    // These are the one place in the app where currentColor is wrong: a
    // recoloured Carrefour blue is not Carrefour.
    for (const shop of ['aldi', 'auchan', 'carrefour', 'delhaize', 'lidl', 'mega-image', 'mpreis']) {
      expect(brands[`brands/${shop}.svg`], shop).not.toContain('currentColor')
    }
  })
})
