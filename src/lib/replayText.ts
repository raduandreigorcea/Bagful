import { catalogTexts } from './i18n'
import { shopNames } from './shopBadges'

// Which text a session replay may show. Replays blank every piece of text
// (maskTextSelector '*') because lists carry people's own words: item names, list
// names, notes, member names. A blank screen tells nobody what the app is doing, so
// the text that is OURS stays readable: any string that is exactly one of the app's
// own translations, in the language on screen or English, or a shop's name. The
// rule is a closed list on purpose. Something a person typed shows only if it
// happens to equal a button label, which is harmless, and a new field of theirs
// is masked with no change here. A translation with a name inside it ("Add Milk")
// is not a match, so it stays blank.

export function maskReplayText(text: string): string {
  const shown = text.trim()
  return shown && (catalogTexts().has(shown) || shopNames().has(shown)) ? text : text.replace(/\S/g, '*')
}
