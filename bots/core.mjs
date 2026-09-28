// Pure pieces of the bot swarm, kept apart from Playwright so Vitest can pin
// them. See bots/swarm.mjs for what the swarm is for.

// Copied, not imported: src/lib/appChannel.ts reads import.meta.env at load,
// which plain Node does not have. test/bots.test.js fails if the two drift.
export const PRODUCTION_PROJECT_REF = 'qwpyiperbjaeykrvilhf'

export function isProductionUrl(url) {
  try {
    return new URL(url).hostname.split('.')[0] === PRODUCTION_PROJECT_REF
  } catch {
    return false
  }
}

export function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export function parseArgs(argv) {
  const o = { minutes: 15, bots: 5, seed: Date.now() % 2 ** 31, headed: false, setupOnly: false, keep: false, keepGoing: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--headed') o.headed = true
    else if (a === '--setup-only') o.setupOnly = true
    else if (a === '--keep') o.keep = true
    else if (a === '--keep-going') o.keepGoing = true
    else if (a === '--minutes' || a === '--bots' || a === '--seed') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) throw new Error(`${a} needs a positive whole number`)
      o[a.slice(2)] = n
    } else throw new Error(`Unknown option ${a}`)
  }
  if (o.bots > 6) throw new Error('--bots is at most 6: there are six bot accounts')
  return o
}

// mulberry32: tiny, seedable, good enough to pick taps.
export function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pickWeighted(rng, entries) {
  let r = rng() * entries.reduce((s, e) => s + e.weight, 0)
  for (const e of entries) {
    r -= e.weight
    if (r < 0) return e
  }
  return entries[entries.length - 1]
}

const canonical = items => items.map(i => `${i.name}|${i.checked ? '✓' : ' '}|x${i.qty}`).sort()

export function findDisagreement(snaps) {
  if (snaps.length < 2) return null
  const [first, ...rest] = snaps
  const a = canonical(first.items)
  for (const s of rest) {
    const b = canonical(s.items)
    if (a.join('\n') !== b.join('\n')) {
      return { a: first.bot, b: s.bot, onlyA: a.filter(x => !b.includes(x)), onlyB: b.filter(x => !a.includes(x)) }
    }
  }
  return null
}

// What a Sentry envelope reports, in one line: the exception's type, message
// and top frame, or the message of a captureMessage. The envelope is newline-
// separated JSON; the header lines carry nothing worth reading.
export function describeSentryEnvelope(body) {
  for (const line of body.split('\n')) {
    let item
    try { item = JSON.parse(line) } catch { continue }
    const ex = item.exception?.values?.at(-1)
    if (ex) {
      const frame = ex.stacktrace?.frames?.at(-1)
      const where = frame ? ` at ${frame.function ?? '?'} (${(frame.filename ?? '').split('/').pop()}:${frame.lineno ?? '?'})` : ''
      return `${ex.type}: ${ex.value}${where}`
    }
    if (item.message) return typeof item.message === 'string' ? item.message : item.message.formatted ?? JSON.stringify(item.message)
  }
  return body.slice(0, 300)
}

// Console errors that are not FamCart bugs. Grow this only with a reason.
const IGNORED_CONSOLE = [
  /^\[vite\]/,
  /Clerk has been loaded with development keys/,
  // Chrome's own line for a request made while a bot is offline on purpose.
  /net::ERR_INTERNET_DISCONNECTED/,
  // Chrome's line for any 401. The response watcher in swarm.mjs judges those,
  // since only the body says whether the app retries it (PGRST303) or not.
  /Failed to load resource: the server responded with a status of 401/,
]
export const isIgnoredConsole = text => IGNORED_CONSOLE.some(re => re.test(text))
