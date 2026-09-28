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
  page.on('response', r => {
    if (r.url().includes('.supabase.co') && r.status() >= 400) problems.push(`bot${n} ${r.status()} ${r.request().method()} ${r.url()}`)
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
  }
  fs.writeFileSync(`${dir}/actions.log`, [...log, '', 'FAILED:', reason].join('\n'))
  fs.writeFileSync(`${dir}/seed.txt`, `npm run bots -- --seed ${opts.seed} --bots ${opts.bots}\n`)
  console.error(`\nFAILED: ${reason}\nSaved to ${dir}`)
}

async function close() {
  for (const b of bots) if (b.ownsBrowser) await b.browser.close()
  if (shared) await shared.close()
}

// Online bots must show the same list once realtime has had 5s to catch up.
async function checkAgreement() {
  const online = bots.filter(b => !b.offlineUntil)
  const deadline = Date.now() + 5_000
  let diff
  do {
    diff = findDisagreement(await Promise.all(online.map(async b => ({ bot: b.n, items: await readList(b.page) }))))
    if (!diff) return null
    await new Promise(r => setTimeout(r, 500))
  } while (Date.now() < deadline)
  return `bot${diff.a} and bot${diff.b} disagree after 5s. Only bot${diff.a}: ${JSON.stringify(diff.onlyA)}. Only bot${diff.b}: ${JSON.stringify(diff.onlyB)}`
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
  while (Date.now() < end) {
    for (const b of bots) {
      if (b.offlineUntil && Date.now() > b.offlineUntil) {
        await backOnline(b)
        sinceCheck = 10
      }
    }
    // Sometimes two bots at once, which is where races live. Everything is
    // drawn from the seed before either acts, each action with a stream of its
    // own, so two concurrent actions cannot reorder each other's draws.
    const actors = [...new Set(rng() < 0.2 ? [randomBot(), randomBot()] : [randomBot()])]
    const plans = actors.map(b => ({ b, action: pickWeighted(rng, ACTIONS), own: makeRng(Math.floor(rng() * 2 ** 32)) }))
    await Promise.all(plans.map(async ({ b, action, own }) => {
      const what = await action.run(b, own)
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
      const diff = await checkAgreement()
      if (diff) throw new Error(diff)
    }
    await new Promise(r => setTimeout(r, 200 + rng() * 1800))
  }
  for (const b of bots) if (b.offlineUntil) await backOnline(b)
  const diff = await checkAgreement()
  if (diff) throw new Error(diff)
  if (!opts.keep) await deleteList(bots[0])
  note('clean run')
  await close()
} catch (e) {
  await dump(e.stack ?? String(e))
  await close()
  process.exit(1)
}
