// What the list renders, in order: rows to buy (optionally under aisle
// headings), then the "In cart" heading and the rows already picked up.
//
// One flat array of headings and rows rather than nested sections, because the
// list animates with a single TransitionGroup. A row that is ticked has to be
// seen travelling from where it was down into the cart; in two separate lists
// it would vanish from one and pop into the other. Headings are entries in the
// same group, keyed, so they slide aside for the rows the same way.

import { AISLES, getProductAisle, type Aisle } from './productIcon'

export type ListSort = 'added' | 'aisle'

interface Row {
  id: string
  name: string
  maker?: string | null
  checked: boolean
}

export type ListEntry<T extends Row> =
  | { kind: 'aisle'; key: string; aisle: Aisle; count: number }
  | { kind: 'cart'; key: 'cart'; count: number }
  | { kind: 'row'; key: string; item: T }

export function buildListEntries<T extends Row>(
  items: readonly T[],
  options: { sort: ListSort; cartCollapsed: boolean },
): ListEntry<T>[] {
  const toBuy = items.filter((i) => !i.checked)
  const inCart = items.filter((i) => i.checked)
  const entries: ListEntry<T>[] = []

  if (options.sort === 'aisle') {
    // Grouped in the fixed aisle order; within an aisle, the list's own order
    // (when each thing was added), so nothing reshuffles as rows come and go.
    const byAisle = new Map<Aisle, T[]>()
    for (const item of toBuy) {
      const aisle = getProductAisle(item.name, item.maker ?? '')
      const group = byAisle.get(aisle)
      if (group) group.push(item)
      else byAisle.set(aisle, [item])
    }
    for (const aisle of AISLES) {
      const group = byAisle.get(aisle)
      if (!group) continue
      entries.push({ kind: 'aisle', key: `aisle:${aisle}`, aisle, count: group.length })
      for (const item of group) entries.push({ kind: 'row', key: item.id, item })
    }
  } else {
    for (const item of toBuy) entries.push({ kind: 'row', key: item.id, item })
  }

  if (inCart.length) {
    entries.push({ kind: 'cart', key: 'cart', count: inCart.length })
    if (!options.cartCollapsed) {
      for (const item of inCart) entries.push({ kind: 'row', key: item.id, item })
    }
  }

  return entries
}
