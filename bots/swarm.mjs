// A family of browser bots using FamCart on famcart-dev, to find the bugs that
// only real, concurrent, flaky-network use finds. Local only, by choice.
//
//   npm run dev                      (in another terminal)
//   npm run bots -- --minutes 15 --bots 5 [--headed] [--seed N] [--setup-only] [--keep] [--keep-going]
//
// Stops at the first failure (or, with --keep-going, notes it and carries on)
// and writes bots/runs/<time>/: a screenshot and a
// Playwright trace per bot (open with `npx playwright show-trace`), actions.log
// and the seed. The seed replays the same actions; what the network does in
// between (and so what a search returns, or which race wins) can still differ.
// The bot accounts are famcart-bot1..6+clerk_test@example.com on the Clerk
// development instance; test emails always accept the code 424242. Five by
// default: bot6 belongs to the /exploring-famcart skill, and a swarm that
// signs it in would pull it out of the explorer's list.
import fs from 'node:fs'
import { chromium } from 'playwright'
import { parseArgs, parseEnv, isProductionUrl, makeRng, pickWeighted, findDisagreement, isIgnoredConsole, describeSentryEnvelope } from './core.mjs'
import { BASE_URL, openBot, ensureSignedIn, leaveAllLists, createList, joinList, deleteList, readList, errorDialogText, addButton, ensureEnglish } from './app.mjs'
import { ACTIONS } from './actions.mjs'
import { CHAOS, RACE_OPS, kickMember, promoteOrDemote, regenerateCode } from './chaos.mjs'

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
  // A kicked bot's in-flight writes fail until it rejoins: expected, so its
  // console and responses are not judged while it is out.
  page.on('console', m => { if (m.type() === 'error' && !bot.kicked && !isIgnoredConsole(m.text())) problems.push(`bot${n} console: ${m.text()}`) })
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
        const [joinRef, ref, topic, event, payload] = Array.isArray(m) ? m : [m.join_ref, m.ref, m.topic, m.event, m.payload]
        if (event === 'heartbeat' || topic === 'phoenix') return
        // Errors in full: the server's reason is the whole point of the log.
        const failed = payload?.status === 'error' || event === 'phx_error'
        const row = payload?.data?.record ?? payload?.data?.old_record
        const detail = failed ? JSON.stringify(payload).slice(0, 400) : payload?.data ? `${payload.data.type} ${row?.id?.slice(0, 8) ?? ''}` : payload?.status ?? ''
        // join_ref says which subscription a frame belongs to: after a rejoin, an
        // event for a subscription the page has dropped is silently ignored.
        wsNote(`${dir} ${event} ${topic} [${joinRef ?? '-'},${ref ?? '-'}] ${detail}`)
      } catch { /* binary frame */ }
    }
    ws.on('framereceived', frame('<'))
    ws.on('framesent', frame('>'))
  })
  page.on('response', async r => {
    if (!r.url().includes('.supabase.co') || r.status() < 400 || bot.kicked) return
    // PGRST303 is a token refused on time grounds (a clock a few seconds off),
    // which fetchWithFreshToken in src/supabase.ts retries with a fresh token.
    // If that retry fails too, the app shows it and the bots see that instead.
    if (r.status() === 401 && (await r.json().catch(() => null))?.code === 'PGRST303') return
    problems.push(`bot${n} ${r.status()} ${r.request().method()} ${r.url()}`)
  })
  // Answered, not aborted: an aborted request logs a console error of its own.
  // Only error events count: client_report and transactions are Sentry's
  // bookkeeping, and feedback is the bots' own "Report an issue".
  await context.route(/sentry\.io/, route => {
    const body = route.request().postData() ?? ''
    if (/"type":"event"/.test(body)) problems.push(`bot${n} reported to Sentry${bot.kicked ? ' (while being removed from the list)' : ''}: ${describeSentryEnvelope(body)}`)
    return route.fulfill({ status: 200, body: '{}' })
  })
  bots.push(bot)
}

const findings = []

// A finding ends the run, unless --keep-going: then it is saved like a failure
// and the bots carry on, so one long run collects every finding it can.
async function finding(reason) {
  if (!opts.keepGoing) throw new Error(reason)
  findings.push(reason.split('\n')[0])
  await dump(reason)
  for (const b of bots) {
    await b.context.tracing.start({ screenshots: true, snapshots: true })
    // An error dialog would otherwise be reported again on every round.
    await b.page.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true }).click({ timeout: 2_000 }).catch(() => {})
  }
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
  const online = bots.filter(b => !b.offlineUntil && !b.kicked)
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

const family = { code: '' }
const randomBot = () => bots[Math.floor(rng() * bots.length)]
const shuffled = xs => xs.map(x => [rng(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x)

// Things only the owner (bot1) can do, done while everyone else carries on.
const OWNER = [
  { id: 'kick', weight: 3, owner: true, run: async (b, r) => (await kickMember(b, r, bots))?.line ?? null },
  { id: 'promote', weight: 2, owner: true, run: (b, r) => promoteOrDemote(b, r, bots) },
  { id: 'regenerate', weight: 1, owner: true, run: async (b, r) => {
    family.code = await regenerateCode(b, r)
    return `regenerate invite code: ${family.code}`
  } },
]
const POOL = [...ACTIONS, ...CHAOS, ...OWNER]

async function runAction(b, action, own) {
  const lang = await ensureEnglish(b)
  if (lang) note(`bot${b.n} found its app in "${lang}" after a stray tap; back to English`)
  let what
  try {
    what = await action.run(b, own)
    b.giveUps = 0
  } catch (e) {
    if (e.name === 'Finding') {
      await finding(`bot${b.n} ${action.id}: ${e.message}`)
      return
    }
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
}

// Two or three bots do different things to the same item at the same moment.
async function race() {
  const ready = bots.filter(b => !b.offlineUntil && !b.kicked)
  if (ready.length < 2) return
  const open = (await readList(ready[0].page)).filter(i => !i.checked)
  if (!open.length) return
  const name = open[Math.floor(rng() * open.length)].name
  const racers = shuffled(ready).slice(0, 2 + Math.floor(rng() * 2))
  const ops = racers.map(b => ({ b, op: RACE_OPS[Math.floor(rng() * RACE_OPS.length)] }))
  note(`RACE on "${name}": ${ops.map(o => `bot${o.b.n} ${o.op.id}`).join(', ')}`)
  await Promise.all(ops.map(({ b, op }) => op.run(b, name).catch(e => {
    if (e.name !== 'TimeoutError') throw e
    note(`  bot${b.n} ${op.id} found nothing to act on`)
  })))
}

// A kicked bot's own app must notice within 10s, without a reload. Then it
// comes back in with whatever the invite code is by now.
async function rejoin(b) {
  if (Date.now() - b.kickedAt < 10_000) return
  if (await addButton(b.page).isVisible()) {
    await finding(`bot${b.n} was removed from the list ${Math.round((Date.now() - b.kickedAt) / 1000)}s ago and its screen still shows the list`)
  }
  await b.page.goto(BASE_URL + '/')
  await joinList(b, family.code)
  b.kicked = false
  note(`bot${b.n} rejoined with code ${family.code}`)
}

note(`seed ${opts.seed}, ${opts.bots} bots, ${opts.minutes} min`)
try {
  await Promise.all(bots.map(ensureSignedIn))
  // One at a time, owner last: a list deleted under a member mid-leave is a
  // race in the cleanup, not a bug worth reporting.
  for (const b of [...bots].reverse()) await leaveAllLists(b)
  family.code = await createList(bots[0], `Bots ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`)
  for (const b of bots.slice(1)) await joinList(b, family.code)
  note(`family ready, invite code ${family.code}`)
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
    for (const b of bots) if (b.kicked && rng() < 0.3) await rejoin(b)
    if (rng() < 0.08) {
      await race()
      sinceCheck = 10
    } else {
      // Sometimes two bots at once. Everything is drawn from the seed before
      // either acts, each action with a stream of its own, so two concurrent
      // actions cannot reorder each other's draws. Owner actions go to bot1.
      const actors = [...new Set(rng() < 0.2 ? [randomBot(), randomBot()] : [randomBot()])]
      const plans = []
      for (const actor of actors) {
        const action = pickWeighted(rng, POOL)
        const own = makeRng(Math.floor(rng() * 2 ** 32))
        const b = action.owner ? bots[0] : actor
        // Screens that load on demand cannot load offline on the dev server
        // (no service worker, and dev skips vite:preloadError): the app would
        // crash where the installed one would not.
        if (b.kicked || b.offlineUntil && (action.owner || action.lazy) || plans.some(p => p.b === b)) continue
        plans.push({ b, action, own })
      }
      await Promise.all(plans.map(({ b, action, own }) => runAction(b, action, own)))
    }
    for (const b of bots) {
      if (b.kicked) continue
      const err = await errorDialogText(b.page)
      if (err) problems.push(`bot${b.n} app showed an error: ${err}`)
    }
    if (problems.length) await finding(problems.splice(0).join('\n'))
    if (++sinceCheck >= 10) {
      sinceCheck = 0
      const diff = await checkAgreement(reconnected ? 15 : 5)
      reconnected = false
      if (diff) await finding(diff)
    }
    await new Promise(r => setTimeout(r, 200 + rng() * 1800))
  }
  for (const b of bots) if (b.offlineUntil) await backOnline(b)
  const diff = await checkAgreement(15)
  if (diff) await finding(diff)
  if (!opts.keep) await deleteList(bots[0])
  if (findings.length) {
    note(`${findings.length} finding(s):\n${findings.map(f => `  - ${f}`).join('\n')}`)
    await close()
    process.exit(1)
  }
  note('clean run')
  await close()
} catch (e) {
  await dump(e.stack ?? String(e))
  await close()
  process.exit(1)
}
