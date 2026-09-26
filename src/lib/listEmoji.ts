// A list's icon is optional: owners pick one in settings, and until they do
// the app falls back to the shopping bag so the topbar tile and every list
// row still read as one tidy square. The settings picker shows the same fallback
// (dimmed) so the preview never sits empty.
//
// The icons are 3D renders from 3dicons.co (CC0), cropped and shrunk to 144px
// webp in src/assets/list-icons/. Pictures rather than emoji so they look the
// same on every phone.
//
// STORED IN `lists.emoji`, by name ('bag', 'tea-cup'). The column kept its name
// and its 16-character cap, which every name here fits. A list saved before the
// switch still holds an emoji: the five with a 3D twin are drawn as it, the rest
// stay text emoji until the owner picks again. Nothing was migrated, so the
// admin dashboard shows the name for new picks.
export const DEFAULT_LIST_EMOJI = 'bag'

export const LIST_EMOJIS = [
  'bag', 'heart', 'star', 'key', 'gift', 'tea-cup', 'takeaway-cup', 'glass',
  'boy', 'girl', 'crown', 'sun', 'moon', 'fire', 'trophy', 'medal',
  'map-pin', 'travel', 'umbrella', 'rocket',
] as const

const URLS = import.meta.glob('../assets/list-icons/*.webp', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(URLS).map(([path, url]) => [path.replace(/^.*\/(.+)\.webp$/, '$1'), url]),
)

// The old picker's emoji that 3dicons has a twin for.
const LEGACY: Record<string, string> = {
  '🛒': 'bag',
  '☕': 'tea-cup',
  '🌟': 'star',
  '❤️': 'heart',
  '🔑': 'key',
}

/** The picture for a stored value, or null when it is a plain emoji to draw as text. */
export function listIconUrl(value: string): string | null {
  return BY_NAME[value] ?? BY_NAME[LEGACY[value] ?? ''] ?? null
}
