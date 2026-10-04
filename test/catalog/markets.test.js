import { describe, it, expect } from 'vitest'
import { MARKETS, isMarket } from '../../catalog/src/core/types.ts'
import { SCRAPERS, IMPLEMENTED } from '../../catalog/src/core/registry.ts'
import { MARKETS as APP_MARKETS } from '../../src/lib/region.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The catalog and the app have to agree on which markets exist, and there is no
// runtime that would ever tell you they had stopped agreeing.
//
// THIS TEST READS ACROSS A REPOSITORY BOUNDARY ON PURPOSE, and it is the only
// one here that does. The catalog is its own repo, cloned into catalog/
// (raduandreigorcea/Bagful-catalog), with its own tests, and everything that
// concerns only the catalog lives over there. This one cannot: it compares the
// catalog's market list against src/lib/region.ts, and neither repo can see
// both sides on its own.
//
// It therefore FAILS LOUDLY on a checkout without catalog/, which is why
// .github/workflows/ci.yml checks the catalog out on the unit-test job.
//
// WHAT GOES WRONG WITHOUT IT, and note that the second one CHANGED with the
// catalog rebuild:
//
//   * region.ts gains a market the catalog's check constraint rejects → every
//     retailer registered for it is refused at import, so the market stays
//     permanently empty and the failure shows up as an empty dropdown in one
//     country.
//   * region.ts gains a market no retailer sells in → p_markets carries a code
//     that matches no row. This used to mean every product was DEMOTED for that
//     phone and the dropdown filled with foreign names. Since the rebuild
//     p_markets FILTERS, so it now means that phone gets nothing from the
//     catalog at all. That is the correct answer for a country we have no shops
//     in, and it is still worth knowing which countries those are.
//
// (Two assertions were dropped here rather than updated. They pinned the
// catalog's six-language list against src/locales/, back when a catalog product
// carried a name per language and search ranked on it. Products now come from
// Romanian retailers in Romanian, search_catalog accepts p_langs and ignores it,
// and there is no language vocabulary left to drift.)

const MIGRATIONS = fileURLToPath(new URL('../../catalog/supabase/migrations/', import.meta.url))

const migration = readFileSync(MIGRATIONS + '002_catalog.sql', 'utf8')

// EVERY migration, for the shop rows, and only 002 for the country constraint.
// 002 seeded the first three shops; Mega Image arrived in 011, because 002 is
// applied everywhere already and editing it would reach a fresh database and
// nothing else. So "which shops does the schema claim" is a question about the
// whole directory rather than about one file in it.
const allMigrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(MIGRATIONS + f, 'utf8'))
  .join('\n')

describe('market vocabulary', () => {
  it('lists exactly the markets src/lib/region.ts can derive from a timezone', () => {
    // Sorted, because the order in each file is meaningful to a reader (region.ts
    // groups them roughly by language family) and meaningless to the check.
    expect([...MARKETS].sort()).toEqual([...APP_MARKETS].sort())
  })

  it('accepts every one of them in the database check constraint', () => {
    // The constraint is the thing that actually rejects a row, and it is written
    // in SQL where no type system reaches it. Read it back out of the migration
    // rather than trusting that someone updated both.
    const match = migration.match(/country in \(([^)]+)\)/)
    expect(match, 'the country check constraint is still in 002_catalog.sql').toBeTruthy()

    const constraintMarkets = match[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(constraintMarkets.sort()).toEqual([...MARKETS].sort())
  })

  it('narrows unknown values rather than accepting them', () => {
    expect(isMarket('RO')).toBe(true)
    expect(isMarket('US')).toBe(false)
    expect(isMarket('ro')).toBe(false)
    expect(isMarket(null)).toBe(false)
  })
})

describe('the retailers the catalog is built from', () => {
  it('sell in a market the app can derive from a phone', () => {
    // THE DRIFT THAT MATTERS NOW. A scraper for a country region.ts cannot
    // derive would import products no phone ever asks for: p_markets would never
    // carry that code, so the rows would sit in the catalog, invisible, and the
    // scrape would look like it was working.
    for (const scraper of SCRAPERS) {
      expect(APP_MARKETS, `${scraper.retailer} sells in ${scraper.country}`).toContain(
        scraper.country,
      )
    }
  })

  it('has at least one shop somebody can actually be offered', () => {
    // A catalog with no implemented retailer is a catalog that can only ever be
    // empty, and every symptom of that looks like a search bug.
    expect(IMPLEMENTED.length).toBeGreaterThan(0)
  })

  it('has a database row for each implemented shop and none for the others', () => {
    // A row in catalog_retailers is a claim that data can arrive. One for a
    // retailer with no scraper would give it listings that a run which can never
    // happen would be responsible for sweeping.
    for (const scraper of IMPLEMENTED) {
      expect(allMigrations, `${scraper.retailer} is seeded`).toContain(`'${scraper.retailer}',`)
    }
    for (const scraper of SCRAPERS.filter((s) => !s.implemented)) {
      expect(allMigrations, `${scraper.retailer} is NOT seeded`).not.toContain(`('${scraper.retailer}',`)
    }
  })
})
