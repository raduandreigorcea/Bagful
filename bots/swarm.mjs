// A family of browser bots using FamCart on famcart-dev, to find the bugs that
// only real, concurrent, flaky-network use finds. Local only, by choice.
//
//   npm run dev                      (in another terminal)
//   npm run bots -- --minutes 15 --bots 5 [--headed] [--seed N] [--setup-only] [--keep]
//
// Stops at the first failure and writes bots/runs/<time>/: a screenshot and a
// Playwright trace per bot (open with `npx playwright show-trace`), actions.log
// and the seed. The seed replays the same actions; what the network does in
// between (and so what a search returns, or which race wins) can still differ.
// The bot accounts are famcart-bot1..6+clerk_test@example.com on the Clerk
// development instance; test emails always accept the code 424242. Five by
// default: bot6 belongs to the /exploring-famcart skill, and a swarm that
// signs it in would pull it out of the explorer's list.
import fs from 'node:fs'
import { chromium } from 'playwright'
import { parseArgs, parseEnv, isProductionUrl, makeRng, pickWeighted, findDisagreement, isIgnoredConsole } from './core.mjs'
import { BASE_URL, openBot, ensureSignedIn, leaveAllLists, createList, joinList, deleteList, readList, errorDialogText } from './app.mjs'
import { ACTIONS } from './actions.mjs'

const opts = parseArgs(process.argv.slice(2))
const env = parseEnv(fs.readFileSync('.env.development.local', 'utf8'))
if (!env.VITE_SUPABASE_URL || isProductionUrl(env.VITE_SUPABASE_URL)) {
  console.error('.env.development.local must point at famcart-dev, never production. Refusing.')
  process.exit(1)
}
if (!(await fetch(BASE_URL).then(r => r.ok, () => false))) {
  console.error(`Nothing is serving ${BASE_URL}. Start it with \`npm run dev\` first.`)
  process.exit(1)
}

const rng = makeRng(opts.seed)
const log = []
const note = line => { log.push(`${new Date().toISOString()} ${line}`); console.log(line) }
const problems = []

const shared = opts.headed ? null : await chromium.launch()
const bots = []
for (let n = 1; n <= opts.bots; n++) {
  const bot = await openBot(shared, n, opts)
  const { page, context } = bot
  page.on('console', m => { if (m.type() === 'error' && !isIgnoredConsole(m.text())) problems.push(`bot${n} console: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`bot${n} uncaught: ${e.message}`))
  // What the realtime socket said, trimmed to event and topic, so a sync
  // failure shows whether changes arrived at all. Last 400 frames per bot.
  bot.ws = []
  const wsNote = line => { bot.ws.push(`${new Date().toISOString().slice(11, 23)} ${line}`); if (bot.ws.length > 400) bot.ws.shift() }
  page.on('websocket', ws => {
    if (!ws.url().includes('/realtime/')) return
    wsNote('open')
    ws.on('close', () => wsNote('close'))
    ws.on('socketerror', e => wsNote(`error ${e}`))
    const frame = dir => f => {
      try {
        const m = JSON.parse(f.payload)
        const [, , topic, event, payload] = Array.isArray(m) ? m : [null, null, m.topic, m.event, m.payload]
        if (event === 'heartbeat' || topic === 'phoenix') return
        // Errors in full: the server's reason is the whole point of the log.
        const failed = payload?.status === 'error' || event === 'phx_error'
        const detail = failed ? JSON.stringify(payload).slice(0, 400) : payload?.data?.type ?? payload?.status ?? ''
        wsNote(`${dir} ${event} ${topic} ${detail}`)
      } catch { /* binary frame */ }
    }
    ws.on('framereceived', frame('<'))
    ws.on('framesent', frame('>'))
  })
  page.on('response', async r => {
    if (!r.url().includes('.supabase.co') || r.status() < 400) return
    // PGRST303 is a token refused on time grounds (a clock a few seconds off),
    // which fetchWithFreshToken in src/supabase.ts retries with a fresh token.
    // If that retry fails too, the app shows it and the bots see that instead.
    if (r.status() === 401 && (await r.json().catch(() => null))?.code === 'PGRST303') return
    problems.push(`bot${n} ${r.status()} ${r.request().method()} ${r.url()}`)
  })
  // Answered, not aborted: an aborted request logs a console error of its own.
  // Only error and feedback envelopes count; client_report and transactions
  // are Sentry's bookkeeping.
  await context.route(/sentry\.io/, route => {
    const body = route.request().postData() ?? ''
    if (/"type":"(event|feedback)"/.test(body)) problems.push(`bot${n} reported to Sentry: ${body.slice(0, 500)}`)
    return route.fulfill({ status: 200, body: '{}' })
  })
  bots.push(bot)
}

async function dump(reason) {
  const dir = `bots/runs/${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.mkdirSync(dir, { recursive: true })
  for (const b of bots) {
    await b.page.screenshot({ path: `${dir}/bot${b.n}.png` }).catch(() => {})
    await b.context.tracing.stop({ path: `${dir}/bot${b.n}-trace.zip` }).catch(() => {})
    fs.writeFileSync(`${dir}/bot${b.n}-realtime.log`, b.ws.join('\n'))
  }
  fs.writeFileSync(`${dir}/actions.log`, [...log, '', 'FAILED:', reason].join('\n'))
  fs.writeFileSync(`${dir}/seed.txt`, `npm run bots -- --seed ${opts.seed} --bots ${opts.bots}\n`)
  console.error(`\nFAILED: ${reason}\nSaved to ${dir}`)
}

async function close() {
  for (const b of bots) if (b.ownsBrowser) await b.browser.close()
  if (shared) await shared.close()
}

// Online bots must show the same list once realtime has had 5s to catch up,
// or 15s right after a bot reconnects: it has to rejoin (its token has often
// expired meanwhile) and send what it queued, before the others can see it.
async function checkAgreement(seconds = 5) {
  const online = bots.filter(b => !b.offlineUntil)
  // A delete reaches the server only once its Undo toast has gone (5s), so
  // let open toasts finish before the 5s allowed for sync starts counting.
  await Promise.all(online.map(b => b.page.locator('.toast').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})))
  const deadline = Date.now() + seconds * 1000
  let diff
  do {
    diff = findDisagreement(await Promise.all(online.map(async b => ({ bot: b.n, items: await readList(b.page) }))))
    if (!diff) return null
    await new Promise(r => setTimeout(r, 500))
  } while (Date.now() < deadline)
  const report = `bot${diff.a} and bot${diff.b} disagree after ${seconds}s. Only bot${diff.a}: ${JSON.stringify(diff.onlyA)}. Only bot${diff.b}: ${JSON.stringify(diff.onlyB)}`
  // Still a failure either way, but slow and lost are different bugs.
  for (let waited = seconds; waited <= 35; waited++) {
    await new Promise(r => setTimeout(r, 1000))
    if (!findDisagreement(await Promise.all(online.map(async b => ({ bot: b.n, items: await readList(b.page) }))))) {
      return `${report}\nThey agreed after ${waited}s in all: slow sync, not lost changes.`
    }
  }
  return `${report}\nStill disagreeing after 35s: changes were lost, not just slow.`
}

async function backOnline(b) {
  await b.context.setOffline(false)
  b.offlineUntil = 0
  note(`bot${b.n} back online`)
}

const randomBot = () => bots[Math.floor(rng() * bots.length)]

note(`seed ${opts.seed}, ${opts.bots} bots, ${opts.minutes} min`)
try {
  await Promise.all(bots.map(ensureSignedIn))
  // One at a time, owner last: a list deleted under a member mid-leave is a
  // race in the cleanup, not a bug worth reporting.
  for (const b of [...bots].reverse()) await leaveAllLists(b)
  const code = await createList(bots[0], `Bots ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`)
  for (const b of bots.slice(1)) await joinList(b, code)
  note(`family ready, invite code ${code}`)
  if (opts.setupOnly) {
    await close()
    process.exit(0)
  }

  const end = Date.now() + opts.minutes * 60_000
  let sinceCheck = 0
  let reconnected = false
  while (Date.now() < end) {
    for (const b of bots) {
      if (b.offlineUntil && Date.now() > b.offlineUntil) {
        await backOnline(b)
        sinceCheck = 10
        reconnected = true
      }
    }
    // Sometimes two bots at once, which is where races live. Everything is
    // drawn from the seed before either acts, each action with a stream of its
    // own, so two concurrent actions cannot reorder each other's draws.
    const actors = [...new Set(rng() < 0.2 ? [randomBot(), randomBot()] : [randomBot()])]
    const plans = actors.map(b => ({ b, action: pickWeighted(rng, ACTIONS), own: makeRng(Math.floor(rng() * 2 ** 32)) }))
    await Promise.all(plans.map(async ({ b, action, own }) => {
      let what
      try {
        what = await action.run(b, own)
        b.giveUps = 0
      } catch (e) {
        // Another bot removed the row, or reordered the list, mid-action: a
        // person would shrug and move on. Three in a row is a stuck app.
        if (e.name !== 'TimeoutError' || ++b.giveUps >= 3) throw e
        note(`bot${b.n} gave up on ${action.id}: ${e.message.split('\n')[0]}`)
        await b.page.keyboard.press('Escape')
        return
      }
      if (what) note(`bot${b.n} ${what}`)
      if (action.id === 'offline' && what) {
        await b.page.getByRole('status').filter({ hasText: 'Offline' }).first().waitFor({ timeout: 10_000 })
      }
    }))
    for (const b of bots) {
      const err = await errorDialogText(b.page)
      if (err) problems.push(`bot${b.n} app showed an error: ${err}`)
    }
    if (problems.length) throw new Error(problems.join('\n'))
    if (++sinceCheck >= 10) {
      sinceCheck = 0
      const diff = await checkAgreement(reconnected ? 15 : 5)
      reconnected = false
      if (diff) throw new Error(diff)
    }
    await new Promise(r => setTimeout(r, 200 + rng() * 1800))
  }
  for (const b of bots) if (b.offlineUntil) await backOnline(b)
  const diff = await checkAgreement(15)
  if (diff) throw new Error(diff)
  if (!opts.keep) await deleteList(bots[0])
  note('clean run')
  await close()
} catch (e) {
  await dump(e.stack ?? String(e))
  await close()
  process.exit(1)
}
