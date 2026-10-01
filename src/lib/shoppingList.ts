// Pure helpers for the shopping list. Deliberately free of Vue and Supabase so
// they can be unit-tested and reused across the add / toggle / merge paths.

export interface ShoppingItem {
  id: string
  name: string
  checked: boolean
  checked_at?: string | null
  quantity?: number
  added_by?: string
  maker?: string | null
}

// Normalize a name for matching: trimmed and lowercased, so "Milk", "milk " and
// "MILK" all collapse to the same key. Mirrors the DB's lower(btrim(name)) index.
export function normalizeItemName(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase()
}

// Total units left to buy: sum of quantities across unchecked items. A missing or
// invalid quantity counts as 1.
export function sumActiveQuantities(items: ShoppingItem[]): number {
  return items
    .filter((i) => !i.checked)
    .reduce((sum, i) => sum + (Number(i.quantity) || 1), 0)
}

// Total units marked to buy: sum of quantities across checked items, so a stack
// like "grapes x4" counts as 4. A missing or invalid quantity counts as 1.
export function sumCheckedQuantities(items: ShoppingItem[]): number {
  return items
    .filter((i) => i.checked)
    .reduce((sum, i) => sum + (Number(i.quantity) || 1), 0)
}

// First unchecked item whose name AND maker match (case/whitespace-insensitive),
// optionally excluding one id. Returns undefined if none match. The maker is
// part of the merge key — "Lapte 3.5% 1L" from Napolact and from LaDorna are
// different products — mirroring the DB's unique active-item index
// (004_shopping_list.sql). A null/absent maker only matches other maker-less items.
// Generic in the row type so a caller holding richer rows (ShoppingItemRow, with
// created_at) gets one back rather than the narrow interface — otherwise feeding
// the result into sortItemsForDisplay widens the whole array and the assignment
// back to the list no longer typechecks.
export function findActiveItemByName<T extends ShoppingItem>(
  items: T[],
  name: string,
  { excludeId, maker }: { excludeId?: string; maker?: string | null } = {},
): T | undefined {
  const key = normalizeItemName(name)
  const makerKey = normalizeItemName(maker)
  return items.find(
    (i) =>
      !i.checked &&
      i.id !== excludeId &&
      normalizeItemName(i.name) === key &&
      normalizeItemName(i.maker) === makerKey,
  )
}

// The same product already in the cart: same match rule as above, but among
// the checked rows. Ticking a row whose twin is already there folds the two
// together instead of leaving two of one thing side by side.
export function findCheckedItemByName<T extends ShoppingItem>(
  items: T[],
  name: string,
  { excludeId, maker }: { excludeId?: string; maker?: string | null } = {},
): T | undefined {
  const key = normalizeItemName(name)
  const makerKey = normalizeItemName(maker)
  return items.find(
    (i) =>
      i.checked &&
      i.id !== excludeId &&
      normalizeItemName(i.name) === key &&
      normalizeItemName(i.maker) === makerKey,
  )
}

// How many active (unchecked) items a given member currently owns — the client
// side of the per-member cap (the DB trigger is the authoritative backstop).
export function countActiveItemsByMember(items: ShoppingItem[], userId: string): number {
  return items.filter((i) => !i.checked && i.added_by === userId).length
}

// The one canonical display order, shared by every path that rebuilds the array
// (fetch, realtime, local mutation) so a refetch can never disagree with a local
// action and swap rows on the next background sync: creation time ascending
// (oldest first), then id. Timestamps use a stable id tiebreak because Postgres
// returns equal-timestamp rows in an arbitrary order.
//
// `checked` is deliberately not part of the order. A row you tick keeps the spot
// you found it in: sorting it into a section at the bottom would move it out
// from under your finger and reshuffle a list you are working down.
export function sortItemsForDisplay<
  T extends ShoppingItem & { created_at?: unknown; checked_at?: unknown },
>(items: T[]): T[] {
  const time = (v: unknown) => new Date(String(v ?? '')).getTime() || 0
  return [...items].sort((a, b) => {
    const ta = time(a.created_at)
    const tb = time(b.created_at)
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
