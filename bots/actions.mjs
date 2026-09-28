// What a person does with a shopping list, weighted by how often they do it.
// Each action returns a short description for actions.log, or null if it
// found nothing to act on (an empty list has nothing to tick).
import { addButton, button } from './app.mjs'

const TERMS = ['lapte', 'paine', 'oua', 'banane', 'cafea', 'apa', 'iaurt', 'rosii', 'branza', 'pui']
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)]
const rows = page => page.locator('li.item:not(.item--draining)')

async function randomRow(page, rng, checked) {
  const all = checked === undefined
    ? rows(page)
    : rows(page).filter({ has: page.locator(`button.item-toggle[aria-pressed="${checked}"]`) })
  const n = await all.count()
  return n ? all.nth(Math.floor(rng() * n)) : null
}

async function addFromSearch({ page }, rng) {
  await addButton(page).click()
  const input = page.getByRole('combobox', { name: 'Add an item' })
  const term = pick(rng, TERMS)
  await input.fill(term)
  const options = page.getByRole('listbox').getByRole('option')
  await options.first().waitFor({ timeout: 10_000 })
  const choice = options.nth(Math.floor(rng() * await options.count()))
  const label = (await choice.textContent()).trim().replace(/\s+/g, ' ').slice(0, 50)
  await choice.click()
  if (/Add your own/.test(label)) {
    await page.getByLabel('Product', { exact: true }).fill(`${term} bot ${Math.floor(rng() * 1000)}`)
    await page.getByRole('button', { name: 'Add to list' }).click()
  }
  await button(page, 'Back').first().click()
  return `add "${label}" (searched ${term})`
}

async function toggle({ page }, rng, checked) {
  const row = await randomRow(page, rng, checked)
  if (!row) return null
  const name = await row.locator('.item-name').textContent()
  await row.locator('button.item-toggle').click()
  return `${checked ? 'untick' : 'tick'} "${name}"`
}

async function removeRow({ page }, rng) {
  const row = await randomRow(page, rng)
  if (!row) return null
  const name = await row.locator('.item-name').textContent()
  if (rng() < 0.5) {
    await row.locator('button.item-toggle').press('Delete')
    return `remove "${name}" (Delete key)`
  }
  const box = await row.locator('.item-face').boundingBox()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  return `remove "${name}" (swipe)`
}

async function changeQty({ page }, rng) {
  const row = await randomRow(page, rng, false)
  if (!row) return null
  const name = await row.locator('.item-name').textContent()
  await row.getByRole('button', { name: /^Quantity \d+\. Change$/ }).click()
  const more = rng() < 0.7
  const times = 1 + Math.floor(rng() * 3)
  const stepper = row.getByRole('button', { name: more ? 'One more' : 'One fewer' })
  for (let i = 0; i < times && await stepper.isEnabled(); i++) await stepper.click()
  return `qty ${more ? '+' : '-'}${times} "${name}"`
}

async function checkout({ page }) {
  const thumb = page.getByRole('button', { name: /^Check out \d+ items?$/ })
  if (!(await thumb.isVisible())) return null
  const label = await thumb.getAttribute('aria-label')
  const box = await thumb.boundingBox()
  const track = await thumb.locator('..').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width - 4, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  return `checkout (${label})`
}

async function reload({ page }) {
  await page.reload()
  await addButton(page).waitFor({ timeout: 30_000 })
  return 'reload'
}

// Offline is a state the loop owns (see swarm.mjs); this only flips it.
async function goOffline(bot, rng) {
  if (bot.offlineUntil) return null
  await bot.context.setOffline(true)
  bot.offlineUntil = Date.now() + 5_000 + rng() * 25_000
  return `offline for ${Math.round((bot.offlineUntil - Date.now()) / 1000)}s`
}

async function background({ page }, rng) {
  const ms = 2_000 + rng() * 8_000
  await page.evaluate(ms => {
    const set = state => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    set('hidden')
    return new Promise(r => setTimeout(() => { set('visible'); r() }, ms))
  }, ms)
  return `background ${Math.round(ms / 1000)}s`
}

export const ACTIONS = [
  { id: 'add', weight: 30, run: addFromSearch },
  { id: 'tick', weight: 20, run: (b, r) => toggle(b, r, false) },
  { id: 'untick', weight: 6, run: (b, r) => toggle(b, r, true) },
  { id: 'remove', weight: 8, run: removeRow },
  { id: 'qty', weight: 10, run: changeQty },
  { id: 'checkout', weight: 4, run: checkout },
  { id: 'reload', weight: 5, run: reload },
  { id: 'offline', weight: 4, run: goOffline },
  { id: 'background', weight: 4, run: background },
]
