// Driving FamCart like a person: every locator is an accessible name from
// src/locales/en.ts, so a renamed label breaks the bots loudly, not silently.
import fs from 'node:fs'
import { chromium } from 'playwright'

export const BASE_URL = 'http://localhost:5173'

// Sentry does not exist, as far as a bot's browser knows. swarm.mjs answers
// Sentry's requests itself, but a report sent while a page is unloading
// (keepalive) slips past request interception and reached the real project;
// four development issues on 2026-09-28 were bots leaving pages mid-save.
export const LAUNCH_ARGS = ['--host-resolver-rules=MAP *.sentry.io ~NOTFOUND']
const botEmail = n => `famcart-bot${n}+clerk_test@example.com`
const authFile = n => `bots/.auth/bot${n}.json`
export const button = (page, name) => page.getByRole('button', { name, exact: true })
// Rows of the real list only. The onboarding tour mounts ShoppingListItem with
// sample rows (Avocado, Milk...), which a bare li.item would count as items.
export const ROW = 'ul.item-list > li.item:not(.item--draining)'
export const addButton = page => page.getByRole('button', { name: 'Add an item', exact: true }).first()

// Headed bots get a browser each so their windows can be tiled; hidden bots
// share one browser, one context apiece.
export async function openBot(shared, n, { headed }) {
  const browser = shared ?? await chromium.launch({
    headless: false,
    args: [...LAUNCH_ARGS, `--window-position=${((n - 1) % 3) * 490},${Math.floor((n - 1) / 3) * 520}`, '--window-size=480,500'],
  })
  const context = await browser.newContext({
    viewport: headed ? { width: 470, height: 420 } : { width: 400, height: 860 },
    locale: 'en-US',
    storageState: fs.existsSync(authFile(n)) ? authFile(n) : undefined,
  })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  // A tap waits 10s, not 30s: longer than any honest render, short enough
  // that a row deleted under a bot costs little (see the give-up in swarm.mjs).
  page.setDefaultTimeout(10_000)
  // The tour, the notification prompt and the welcome screen open on their own
  // schedule; whenever one covers what a bot is about to tap, Playwright clicks
  // through it first.
  for (const name of ['Skip tour', 'Not now', 'Get started']) {
    // The overlay may leave by itself mid-click; that is fine too.
    await page.addLocatorHandler(button(page, name), b => b.click({ timeout: 5_000 }).catch(() => {}), { noWaitAfter: true })
  }
  return { n, browser, context, page, headed, ownsBrowser: !shared, offlineUntil: 0, giveUps: 0 }
}

const setupPicker = page => page.getByText('Create a list', { exact: true })

// A user with no list gets the language and welcome screens again (after a
// sign-in, and after their last list is deleted), then list setup.
async function throughWelcome(page) {
  const english = page.getByRole('group', { name: 'Choose a language' }).getByRole('button', { name: /English/ })
  await english.or(button(page, 'Get started')).or(setupPicker(page)).or(addButton(page)).first().waitFor({ timeout: 30_000 })
  if (await english.isVisible()) await english.click()
  // Hover is an action, so the Get started handler (see openBot) clicks
  // through the welcome screen before it lands.
  await setupPicker(page).or(addButton(page)).first().hover({ timeout: 30_000 })
}

export async function ensureSignedIn(bot) {
  const { page, n } = bot
  await page.goto(BASE_URL + '/')
  const email = page.getByLabel('Email address')
  const landed = () => email
    .or(page.getByRole('group', { name: 'Choose a language' }))
    .or(button(page, 'Get started'))
    .or(setupPicker(page))
    .or(addButton(page))
    .first()
  await landed().waitFor({ timeout: 30_000 })
  if (await email.isVisible()) {
    await email.fill(botEmail(n))
    await email.press('Enter')
    await page.getByLabel('Digit 1 of 6').click()
    await page.keyboard.type('424242')
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    await landed().waitFor({ timeout: 30_000 })
  }
  await throughWelcome(page)
  fs.mkdirSync('bots/.auth', { recursive: true })
  await bot.context.storageState({ path: authFile(n) })
}

export const listSettingsButton = page => page.getByRole('navigation', { name: 'Main actions' }).getByRole('button', { name: / settings$|^List$/ })

// Crash leftovers: delete what this bot owns, leave what it joined, until the
// app sends it to list setup. Bounded by the membership cap of 3.
export async function leaveAllLists(bot) {
  const { page } = bot
  for (let i = 0; i < 3; i++) {
    // The app paints its cached list first and only then learns from the
    // server that the bot left it last run; decide after the network settles.
    await page.waitForLoadState('networkidle')
    await throughWelcome(page)
    if (!(await addButton(page).isVisible())) return
    await listSettingsButton(page).click()
    await page.getByRole('tab', { name: 'Danger Zone' }).click()
    const del = button(page, 'Delete List')
    const which = (await del.isVisible()) ? 'Delete' : 'Leave'
    await button(page, `${which} List`).click()
    await page.getByRole('alertdialog').getByRole('button').last().click()
    await page.getByRole('alertdialog').waitFor({ state: 'detached' })
    // Reload rather than trust the screen, which still shows the old list
    // for a moment after leaving it.
    await page.goto(BASE_URL + '/')
    await throughWelcome(page)
  }
}

export async function createList(bot, name) {
  const { page } = bot
  await setupPicker(page).click()
  await page.getByLabel('List name').fill(name)
  await page.getByLabel('List name').press('Enter')
  await addButton(page).waitFor({ timeout: 30_000 })
  await listSettingsButton(page).click()
  const code = await page.getByRole('dialog').getByText(/^[A-Z0-9]{8}$/).first().textContent()
  await page.getByRole('button', { name: 'Close settings' }).click()
  return code.trim()
}

export async function joinList(bot, code) {
  const { page } = bot
  await page.getByText('Join a list', { exact: true }).click()
  await page.getByLabel('Invite code').fill(code)
  await page.getByLabel('Invite code').press('Enter')
  await addButton(page).waitFor({ timeout: 30_000 })
}

export const deleteList = leaveAllLists

// A stray tap in a modal storm can pick another language, and every locator
// here is English. Put it back the way a person would find it after
// reinstalling: the device and per-account keys (lib/locale), then a reload.
// Returns the language it found, or null when it was already English.
export async function ensureEnglish(bot) {
  const lang = await bot.page.evaluate(() => document.documentElement.lang).catch(() => 'en')
  if (!lang || lang.startsWith('en') || bot.offlineUntil) return null
  await bot.page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('famcart-locale')) localStorage.setItem(key, 'en')
  })
  await bot.page.reload()
  await addButton(bot.page).waitFor({ timeout: 30_000 })
  return lang
}

export async function readList(page) {
  // A folded "In cart" takes its rows out of the page, not just out of view,
  // and a stray tap can fold it. Unfold before counting.
  const folded = page.locator('ul.item-list button[aria-expanded="false"]')
  if (await folded.count()) {
    await folded.first().click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
  return page.locator(ROW).evaluateAll(rows => rows.map(r => ({
    name: r.querySelector('.item-name')?.textContent.trim() ?? '',
    checked: r.classList.contains('item--checked'),
    qty: Number(r.querySelector('.item-qty__value')?.textContent.trim() || 1),
  })))
}

// ErrorModal is a ConfirmModal whose only button is OK.
export async function errorDialogText(page) {
  const ok = button(page, 'OK')
  if (!(await ok.isVisible())) return null
  // One that was just dismissed is still fading out: give it a second to go.
  if (await ok.waitFor({ state: 'hidden', timeout: 1_000 }).then(() => true, () => false)) return null
  return (await page.getByRole('alertdialog').filter({ has: ok }).first().textContent())?.trim() || 'error dialog'
}
