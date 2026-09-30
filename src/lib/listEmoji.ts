// A list's icon is optional: owners pick one in settings, and until they do
// the app falls back to the shopping bag so the topbar tile and every list
// row still read as one tidy square. The settings picker shows the same fallback
// (dimmed) so the preview never sits empty.
//
// The icons are flat SVGs in src/assets/list-icons/, drawn in the logo's style
// (resources/icon.svg): its palette, no outlines, gradients or shine, a darker
// band across the top, round-capped detail strokes. Keep a
// new one to those rules and chunky enough to read at 16px. They sit on the
// green topbar tile, on white menus and in dark mode, so no part that matters
// is the logo's main green or its cream: each vanishes on one of the three.
// Pictures rather than emoji so they look the same on every phone.
//
// STORED IN `lists.emoji`, by name ('bag', 'tea-cup'). The column kept its name
// and its 16-character cap, which every name here fits. A list saved before the
// switch still holds an emoji: the five with a twin here are drawn as it, the rest
// stay text emoji until the owner picks again. Nothing was migrated, so the
// admin dashboard shows the name for new picks.
export const DEFAULT_LIST_EMOJI = 'bag'

export const LIST_EMOJIS = [
  'bag', 'heart', 'star', 'key', 'gift', 'tea-cup', 'takeaway-cup', 'glass',
  'crown', 'sun', 'moon', 'fire', 'trophy', 'medal',
  'map-pin', 'travel', 'umbrella', 'rocket',
] as const

const URLS = import.meta.glob('../assets/list-icons/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(URLS).map(([path, url]) => [path.replace(/^.*\/(.+)\.svg$/, '$1'), url]),
)

// The old picker's emoji that have a twin here, and the retired 'boy' and 'girl'
// icons, which fall back to the bag rather than show their name as text.
const LEGACY: Record<string, string> = {
  '🛒': 'bag',
  '☕': 'tea-cup',
  '🌟': 'star',
  '❤️': 'heart',
  '🔑': 'key',
  boy: 'bag',
  girl: 'bag',
}

/** The picture for a stored value, or null when it is a plain emoji to draw as text. */
export function listIconUrl(value: string): string | null {
  return BY_NAME[value] ?? BY_NAME[LEGACY[value] ?? ''] ?? null
}
