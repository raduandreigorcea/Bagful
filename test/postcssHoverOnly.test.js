// A phone has no pointer, and a touch screen leaves :hover stuck on whatever was
// last tapped. The build wraps every :hover rule in `@media (hover: hover)` so no
// component has to remember to; what is worth pinning is the shapes a rule can
// take, because the one that goes wrong silently is the mixed selector list.
import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import hoverOnlyWithPointer from '../scripts/postcss-hover-only.mjs'

// postcss writes the nodes it adds without the spaces around braces that the
// source had, so both sides are put through the same spacing before comparing.
const norm = (css) => css.replace(/\s*([{}])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim()
const processed = async (css) =>
  norm((await postcss([hoverOnlyWithPointer()]).process(css, { from: undefined })).css)

describe('hover only where there is a pointer', () => {
  it('wraps a plain :hover rule', async () => {
    expect(await processed('.a:hover { color: red }')).toBe(
      norm('@media (hover: hover) { .a:hover { color: red } }'),
    )
  })

  it('splits a list that mixes :hover with something that must always apply', async () => {
    expect(await processed('.a:hover, .a:focus-visible { color: red }')).toBe(
      norm('.a:focus-visible { color: red } @media (hover: hover) { .a:hover { color: red } }'),
    )
  })

  it('leaves a rule that is already behind the query, and one with no hover, alone', async () => {
    const inside = '@media (hover: hover) { .a:hover { color: red } }'
    expect(await processed(inside)).toBe(norm(inside))
    expect(await processed('.a:active { color: red }')).toBe(norm('.a:active { color: red }'))
  })

  it('keeps a hover rule inside a width query, and the order around it', async () => {
    expect(
      await processed(
        '.a { color: blue } @media (min-width: 900px) { .a:hover { color: red } } .b { color: green }',
      ),
    ).toBe(
      norm(
        '.a { color: blue } @media (min-width: 900px) { @media (hover: hover) { .a:hover { color: red } } } .b { color: green }',
      ),
    )
  })
})
