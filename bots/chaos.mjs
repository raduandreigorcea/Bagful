// The impatient, distracted and careless things people do: walking away from a
// half-finished add, tapping twice, reloading mid-write, changing the list's
// settings while everyone else is using it, kicking someone mid-action.
//
// Same contract as actions.mjs: return a line for actions.log, or null when
// there was nothing to act on. An action that catches the app misbehaving in a
// way no watcher would see throws a Finding (see swarm.mjs).
import { BASE_URL, ROW, addButton, listSettingsButton } from './app.mjs'

export class Finding extends Error {
  name = 'Finding'
}

const TERMS = ['lapte', 'paine', 'oua', 'cafea', 'iaurt', 'pui']
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)]
const pause = ms => new Promise(r => setTimeout(r, ms))

// Back on the app's first screen leaves it, as Android's back closes the app;
// the person then opens it again.
async function back(page) {
  await page.goBack().catch(() => {})
  if (!page.url().startsWith(BASE_URL)) await page.goto(BASE_URL + '/')
}
const rowNamed = (page, name) => page.locator(ROW).filter({ has: page.locator('.item-name').getByText(name, { exact: true }) }).first()

async function randomName(page, rng, checked) {
  const all = checked === undefined
    ? page.locator(ROW)
    : page.locator(ROW).filter({ has: page.locator(`button.item-toggle[aria-pressed="${checked}"]`) })
  const n = await all.count()
  return n ? (await all.nth(Math.floor(rng() * n)).locator('.item-name').textContent()).trim() : null
}

async function openAccount(page) {
  await page.getByRole('button', { name: 'Your account', exact: true }).first().click()
}

// Opened and closed the way people close things: Escape, the browser's back
// (Android's back gesture), or the close button, chosen at random.
async function closeSomehow(page, rng, closeName) {
  const how = pick(rng, ['escape', 'back', 'button'])
  if (how === 'escape') await page.keyboard.press('Escape')
  else if (how === 'back') await back(page)
  else await page.getByRole('button', { name: closeName }).click({ timeout: 3_000 }).catch(() => page.keyboard.press('Escape'))
  return how
}

async function addThenBail(bot, rng) {
  const { page } = bot
  await addButton(page).click()
  const term = pick(rng, TERMS)
  await page.getByRole('combobox', { name: 'Add an item' }).fill(term)
  await pause(rng() * 700) // sometimes before the results land, sometimes after
  const how = pick(rng, bot.offlineUntil ? ['escape', 'back'] : ['escape', 'back', 'reload', 'offline', 'report'])
  if (how === 'escape') await page.keyboard.press('Escape')
  else if (how === 'back') await back(page)
  else if (how === 'reload') await (bot.offlineUntil ? page.keyboard.press('Escape') : page.reload())
  else if (how === 'offline') {
    if (bot.offlineUntil) return null
    await bot.context.setOffline(true)
    bot.offlineUntil = Date.now() + 5_000 + rng() * 10_000
    await page.keyboard.press('Escape')
  } else {
    // Back out and go straight for the report form, mid-transition.
    await back(page)
    await reportIssue(bot, rng)
  }
  return `typed "${term}" into add, then bailed: ${how}`
}

async function reportIssue({ page }, rng) {
  await openAccount(page)
  await page.getByRole('button', { name: /^Report an issue/ }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Report an issue' })
  await dialog.getByRole('button', { name: pick(rng, ["Something's broken", 'Something could be better']) }).click()
  const places = dialog.getByRole('group', { name: 'Where in the app?' }).getByRole('button')
  if (await places.count()) await places.nth(Math.floor(rng() * await places.count())).click()
  await dialog.getByRole('textbox').pressSequentially('bot report: the list flickered when two of us ticked', { delay: 5 })
  const end = pick(rng, ['send', 'cancel', 'escape', 'back'])
  if (end === 'send') {
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 10_000 })
  } else if (end === 'cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  else if (end === 'escape') await page.keyboard.press('Escape')
  else await back(page)
  return `report an issue, then ${end}`
}

async function tapThenReload({ page, offlineUntil }, rng) {
  if (offlineUntil) return null // no service worker on the dev server
  const name = await randomName(page, rng)
  if (!name) return null
  // No waiting for the write: the page goes away while it is in flight.
  await rowNamed(page, name).locator('button.item-toggle').click()
  await page.reload()
  await addButton(page).waitFor({ timeout: 30_000 })
  return `tap "${name}" and reload at once`
}

async function spamTaps({ page }, rng) {
  if (rng() < 0.5) {
    const name = await randomName(page, rng)
    if (!name) return null
    const toggle = rowNamed(page, name).locator('button.item-toggle')
    const taps = 2 + Math.floor(rng() * 3)
    await toggle.click({ clickCount: taps, delay: 30 })
    return `${taps} rapid taps on "${name}"`
  }
  const name = await randomName(page, rng, false)
  if (!name) return null
  const row = rowNamed(page, name)
  await row.getByRole('button', { name: /^Quantity \d+\. Change$/ }).click()
  const plus = row.getByRole('button', { name: 'One more' })
  const taps = 5 + Math.floor(rng() * 10)
  for (let i = 0; i < taps && await plus.isEnabled(); i++) await plus.click({ delay: 0 })
  return `hammer + ${taps} times on "${name}"`
}

async function deleteThenUndo({ page }, rng) {
  const name = await randomName(page, rng)
  if (!name) return null
  await rowNamed(page, name).locator('button.item-toggle').press('Delete')
  // Anywhere in the 5s window, and sometimes right at its edge.
  const wait = rng() < 0.3 ? 4_700 + rng() * 600 : rng() * 4_000
  await pause(wait)
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).last()
  const undone = await undo.click({ timeout: 1_000 }).then(() => true, () => false)
  return `delete "${name}", undo after ${Math.round(wait)}ms: ${undone ? 'undone' : 'too late'}`
}

const LIST_NAMES = [
  'Weekly shop', 'Cumpărături 🛒', 'Ça coûte cher', '🍕🍕🍕🍕', 'x',
  'A name of exactly 25 char', // at the limit
]

async function openSettingsTab(page, tab) {
  await listSettingsButton(page).click()
  await page.getByRole('tab', { name: tab }).click()
}

async function renameList({ page }, rng) {
  await openSettingsTab(page, 'Preferences')
  const input = page.getByLabel('List Name', { exact: true })
  if (!(await input.isEditable().catch(() => false))) {
    await page.keyboard.press('Escape')
    return null // not allowed for this member
  }
  // One in four is a name the app must refuse, with its own dialog.
  const invalid = rng() < 0.25 ? pick(rng, ['', '   ', 'This one is way too long for a list']) : null
  const name = invalid ?? pick(rng, LIST_NAMES)
  await input.fill(name)
  await page.locator('.input-action-group:has(#listNameInput) .panel-save-btn').click()
  if (invalid !== null) {
    const ok = page.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true })
    if (!(await ok.waitFor({ timeout: 5_000 }).then(() => true, () => false))) {
      throw new Finding(`renaming the list to ${JSON.stringify(name)} was not refused`)
    }
    await ok.click()
  }
  await closeSomehow(page, rng, 'Close settings')
  return `rename list to ${JSON.stringify(name)}${invalid !== null ? ' (refused, as it should be)' : ''}`
}

async function changeIcon({ page }, rng) {
  await openSettingsTab(page, 'Preferences')
  const icons = page.getByRole('button', { name: /^Use / })
  const n = await icons.count()
  if (!n) {
    await page.keyboard.press('Escape')
    return null
  }
  await icons.nth(Math.floor(rng() * n)).click()
  const save = page.locator('.panel-save-btn').nth(1)
  if (rng() < 0.7) await save.click()
  const how = await closeSomehow(page, rng, 'Close settings')
  return `change list icon, closed by ${how}`
}

async function modalStorm({ page }, rng) {
  // Open and close screens as fast as a thumb can, never waiting for an
  // animation to finish.
  const steps = []
  for (let i = 0; i < 4 + Math.floor(rng() * 4); i++) {
    const what = pick(rng, ['history', 'account', 'settings', 'escape', 'back', 'add'])
    steps.push(what)
    const click = name => page.getByRole('button', { name, exact: true }).first().click({ timeout: 2_000, force: true }).catch(() => {})
    if (what === 'history') await click('Checkout history')
    else if (what === 'account') await click('Your account')
    else if (what === 'settings') await listSettingsButton(page).click({ timeout: 2_000, force: true }).catch(() => {})
    else if (what === 'add') await click('Add an item')
    else if (what === 'escape') await page.keyboard.press('Escape')
    else await back(page)
    await pause(rng() * 150)
  }
  // Then a person gives up and gets back to the list.
  for (let i = 0; i < 5 && !(await addButton(page).isVisible()); i++) {
    await page.keyboard.press('Escape')
    await pause(300)
  }
  if (!(await addButton(page).isVisible())) {
    throw new Finding(`stuck after a modal storm (${steps.join(', ')}): Escape five times did not get back to the list`)
  }
  return `modal storm: ${steps.join(', ')}`
}

async function toggleTheme({ page }, rng) {
  await openAccount(page)
  await page.getByRole('button', { name: /^App settings/ }).click()
  const theme = pick(rng, ['Light', 'Dark', 'System'])
  await page.getByRole('dialog').getByText(theme, { exact: true }).click()
  const how = await closeSomehow(page, rng, 'Close app settings')
  return `theme ${theme}, closed by ${how}`
}

// Owner only (bot1). Returns the victim so the swarm can have them rejoin.
async function memberActions(page, n) {
  const name = page.locator('.member-custom-name', { hasText: new RegExp(`^\\s*Bot ${n}\\b`) })
  return name.locator('xpath=ancestor::*[.//button[@aria-label="Open member actions"]][1]').getByRole('button', { name: 'Open member actions' })
}

export async function kickMember({ page }, rng, bots) {
  const victims = bots.filter(b => b.n !== 1 && !b.kicked)
  if (!victims.length) return null
  const victim = pick(rng, victims)
  await openSettingsTab(page, 'Members')
  await (await memberActions(page, victim.n)).click()
  await page.getByRole('button', { name: /^Remove from list/ }).click()
  await page.getByRole('alertdialog').getByRole('button').last().click()
  victim.kicked = true
  victim.kickedAt = Date.now()
  // Not Back: in a browser, Back with a dialog open leaves the page, which
  // cancels the removal still on the wire (the APK's Back closes the dialog
  // instead, see lib/nativeBack). Leaving mid-request is tested elsewhere.
  await page.getByRole('button', { name: 'Close settings' }).click()
  return { line: `KICK bot${victim.n} out of the list`, victim }
}

export async function promoteOrDemote({ page }, rng, bots) {
  const target = pick(rng, bots.filter(b => b.n !== 1 && !b.kicked))
  if (!target) return null
  await openSettingsTab(page, 'Members')
  await (await memberActions(page, target.n)).click()
  const option = page.getByRole('button', { name: /^(Promote to moderator|Demote to member)/ }).first()
  const label = (await option.textContent()).match(/Promote to moderator|Demote to member/)[0]
  await option.click()
  await closeSomehow(page, rng, 'Close settings')
  return `${label.toLowerCase()}: bot${target.n}`
}

// Owner only. Returns the new code, which a kicked bot needs to get back in.
export async function regenerateCode({ page }, rng) {
  await openSettingsTab(page, 'Danger Zone')
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button').last().click()
  await page.getByRole('tab', { name: 'Overview' }).click()
  const code = (await page.getByRole('dialog').getByText(/^[A-Z0-9]{8}$/).first().textContent()).trim()
  await closeSomehow(page, rng, 'Close settings')
  return code
}

export const CHAOS = [
  { id: 'add-then-bail', weight: 8, run: addThenBail },
  { id: 'report', weight: 3, run: reportIssue, lazy: true },
  { id: 'tap-then-reload', weight: 4, run: tapThenReload },
  { id: 'spam-taps', weight: 6, run: spamTaps },
  { id: 'delete-undo', weight: 5, run: deleteThenUndo },
  { id: 'rename', weight: 3, run: renameList, lazy: true },
  { id: 'icon', weight: 2, run: changeIcon, lazy: true },
  { id: 'modal-storm', weight: 4, run: modalStorm, lazy: true },
  { id: 'theme', weight: 2, run: toggleTheme, lazy: true },
]

// Everything a racer can do to one named item. Short timeouts: the other
// racers may well have removed it already, which is the point.
const t = { timeout: 3_000 }
export const RACE_OPS = [
  { id: 'tick', run: ({ page }, name) => rowNamed(page, name).locator('button.item-toggle').click(t) },
  { id: 'delete', run: ({ page }, name) => rowNamed(page, name).locator('button.item-toggle').press('Delete', t) },
  { id: 'qty+', run: async ({ page }, name) => {
    const row = rowNamed(page, name)
    await row.getByRole('button', { name: /^Quantity \d+\. Change$/ }).click(t)
    await row.getByRole('button', { name: 'One more' }).click(t)
  } },
  { id: 'tick+checkout', run: async ({ page }, name) => {
    await rowNamed(page, name).locator('button.item-toggle').click(t)
    const thumb = page.getByRole('button', { name: /^Check out \d+ items?$/ })
    const box = await thumb.boundingBox(t)
    const track = await thumb.locator('..').boundingBox(t)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(track.x + track.width - 4, box.y + box.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.mouse.move(1, 1)
  } },
]
