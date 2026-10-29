// Hover is a pointer's state, and a phone has no pointer. A touch screen applies
// :hover on the tap and keeps it until the next tap somewhere else, so a chip or a
// row stays lit after it was pressed, which reads as "selected" and is not.
//
// Wrapping each of the :hover rules in `@media (hover: hover)` fixes that, but the
// fix has to be remembered for every new one. So it is done here, once, for the
// whole stylesheet: a rule that mentions :hover moves into the media query, and
// a selector list that mixes it with others (`.a:hover, .a:focus-visible`) is
// split so the focus half stays unconditional.
//
// A rule already inside a `hover: hover` query is left alone, so the ones written
// by hand keep working and nothing nests twice.
const isHoverQuery = (node) =>
  node.type === 'atrule' && node.name === 'media' && /hover:\s*hover/.test(node.params)

function insideHoverQuery(node) {
  for (let p = node.parent; p; p = p.parent) if (isHoverQuery(p)) return true
  return false
}

export default function hoverOnlyWithPointer() {
  return {
    postcssPlugin: 'hover-only-with-pointer',
    Rule(rule, { AtRule }) {
      // Keyframe steps ("from", "50%") are rules too, and never mention :hover.
      const hover = rule.selectors.filter((s) => s.includes(':hover'))
      if (!hover.length || insideHoverQuery(rule)) return

      const rest = rule.selectors.filter((s) => !s.includes(':hover'))
      const media = new AtRule({ name: 'media', params: '(hover: hover)' })
      media.append(rule.clone({ selectors: hover }))

      if (rest.length) {
        rule.selectors = rest
        rule.after(media)
      } else {
        rule.replaceWith(media)
      }
    },
  }
}
hoverOnlyWithPointer.postcss = true
