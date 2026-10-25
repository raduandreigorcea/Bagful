// The admin dashboard's view of Sentry, OneSignal and Clerk.
//
// supabase/functions/admin-services/index.ts holds three secret keys and hands
// the dashboard what they read. The parts worth pinning are here: that nothing
// outside the known requests gets through (a Clerk id is spliced into a URL),
// that a missing secret is named rather than failing as a vague 500, and that
// what reaches the browser is cut down to what a page shows -- a Clerk user
// object carries private metadata, and none of it should leave the function.
import { describe, it, expect } from 'vitest'
import {
  corsHeaders,
  missingSecrets,
  oneSignalNotificationsUrl,
  parseRequest,
  posthogActivityQuery,
  posthogChannel,
  shapePostHogActivity,
  readClerkCount,
  sentryEnvironments,
  sentryEnvironmentsUrl,
  knownEnvironments,
  sentryIssuesUrl,
  sentryProjectUrl,
  shapeClerkUser,
  shapeNotification,
  shapeSubscriber,
  oneSignalUserUrl,
  posthogReplayersQuery,
  posthogVersionsQuery,
  shapeVersions,
  posthogVersionSpreadQuery,
  posthogRecordingsQuery,
  shapeReplayers,
  shapeSentryFeedback,
  shapeSentryIssue,
  signInMethods,
  upstreamMessage,
} from '../supabase/functions/_shared/services.ts'

describe('parseRequest', () => {
  it('accepts every view the pages ask for', () => {
    expect(parseRequest({ service: 'sentry', view: 'issues' })).toEqual({ service: 'sentry', view: 'issues' })
    expect(parseRequest({ service: 'sentry', view: 'feedback' })).toEqual({ service: 'sentry', view: 'feedback' })
    expect(parseRequest({ service: 'onesignal', view: 'notifications' })).toEqual({ service: 'onesignal', view: 'notifications' })
    expect(parseRequest({ service: 'clerk', view: 'summary' })).toEqual({ service: 'clerk', view: 'summary' })
    expect(parseRequest({ service: 'clerk', view: 'user', userId: 'user_2abcDEF123456' })).toEqual({
      service: 'clerk',
      view: 'user',
      userId: 'user_2abcDEF123456',
    })
  })

  it('refuses anything else', () => {
    expect(parseRequest(null)).toBeNull()
    expect(parseRequest('sentry')).toBeNull()
    expect(parseRequest({ service: 'stripe', view: 'issues' })).toBeNull()
    expect(parseRequest({ service: 'sentry', view: 'events' })).toBeNull()
    expect(parseRequest({ service: 'clerk', view: 'user' })).toBeNull()
  })

  it('refuses a user id that could change the path it is put into', () => {
    expect(parseRequest({ service: 'clerk', view: 'user', userId: '../users/count' })).toBeNull()
    expect(parseRequest({ service: 'clerk', view: 'user', userId: 'user_abc123456/../../x' })).toBeNull()
  })
})

describe('corsHeaders', () => {
  it('lets the dashboard dev server read the answer', () => {
    expect(corsHeaders('http://localhost:5174')['access-control-allow-origin']).toBe('http://localhost:5174')
    expect(corsHeaders('http://127.0.0.1:5174')['access-control-allow-origin']).toBe('http://127.0.0.1:5174')
  })

  it('never names any other site, or everyone', () => {
    for (const origin of ['https://evil.example', 'https://famcart-app.vercel.app', 'null', null]) {
      const allowed = corsHeaders(origin)['access-control-allow-origin']
      expect(allowed).not.toBe(origin)
      expect(allowed).not.toBe('*')
    }
  })
})

describe('missingSecrets', () => {
  const only = (names) => (name) => (names.includes(name) ? 'set' : undefined)

  it('names what a service still needs', () => {
    expect(missingSecrets('onesignal', only(['ONESIGNAL_APP_ID']))).toEqual(['ONESIGNAL_REST_API_KEY'])
    expect(missingSecrets('clerk', only([]))).toEqual(['CLERK_SECRET_KEY'])
  })

  it('does not take the build token for a read token', () => {
    expect(missingSecrets('sentry', only(['SENTRY_AUTH_TOKEN']))).toEqual(['SENTRY_READ_TOKEN'])
  })

  it('is empty when everything is set', () => {
    expect(missingSecrets('sentry', only(['SENTRY_READ_TOKEN']))).toEqual([])
  })
})

describe('upstreamMessage', () => {
  // "Sentry answered 404" said nothing about WHAT was not found, and a 404
  // from Sentry means different things on the project and on the issues.
  it('says what was asked and what the vendor said about it', () => {
    const message = upstreamMessage('sentry', 404, {
      path: '/api/0/projects/bagful/javascript-vue/',
      detail: 'The requested resource does not exist',
    })
    expect(message).toContain('/api/0/projects/bagful/javascript-vue/')
    expect(message).toContain('The requested resource does not exist')
    // Never the query string, which can carry more than a path should.
    expect(upstreamMessage('sentry', 404, { path: '/api/0/x/?token=abc' })).not.toContain('token')
  })

  it('points at the key when the vendor refuses it', () => {
    expect(upstreamMessage('clerk', 401)).toMatch(/Clerk refused the key/)
    expect(upstreamMessage('sentry', 403)).toMatch(/missing a scope/)
  })
})

describe('Sentry', () => {
  it('lists unresolved errors, and feedback in every status', () => {
    const issues = new URL(sentryIssuesUrl('42', 'issues', ['production']))
    expect(issues.searchParams.get('project')).toBe('42')
    expect(issues.searchParams.get('query')).toBe('is:unresolved issue.category:error')

    // Sentry archives what it takes for spam on its own; a status filter would
    // hide exactly the reports nobody has seen.
    const feedback = new URL(sentryIssuesUrl('42', 'feedback', ['production']))
    expect(feedback.searchParams.get('query')).toBe('issue.category:feedback')
  })

  // The bagful organisation lives in Sentry's EU region. A personal token
  // carries no region, and sentry.io answers 404 for an EU organisation's
  // projects and issues -- which is what the Health page showed.
  // Sentry's issues endpoint answers 404 when a requested environment has never
  // received an event -- which a new channel's environment ("nightly") has not.
  // So the environments are checked first, and only real ones are asked for.
  it('asks only for environments Sentry has actually seen', () => {
    expect(knownEnvironments(['nightly', 'development'], [{ name: 'production' }, { name: 'development' }])).toEqual([
      'development',
    ])
    expect(knownEnvironments(['nightly'], [{ name: 'production' }])).toEqual([])
    expect(knownEnvironments(['production'], [{ name: 'production' }, { name: 42 }, null])).toEqual(['production'])
    expect(new URL(sentryEnvironmentsUrl()).pathname).toBe('/api/0/projects/bagful/javascript-vue/environments/')
  })

  it('asks the EU region, where the organisation lives', () => {
    expect(new URL(sentryProjectUrl()).origin).toBe('https://de.sentry.io')
    expect(new URL(sentryIssuesUrl('42', 'issues', ['production'])).origin).toBe('https://de.sentry.io')
  })

  it('asks only for the environments of the project it runs on', () => {
    expect(sentryEnvironments('https://qwpyiperbjaeykrvilhf.supabase.co')).toEqual(['production'])
    expect(sentryEnvironments('https://arkqdpvguqfsdocmfwaf.supabase.co')).toEqual(['nightly', 'development'])
    // Anything that is not provably production is not production.
    expect(sentryEnvironments(undefined)).toEqual(['nightly', 'development'])

    const url = new URL(sentryIssuesUrl('42', 'issues', ['nightly', 'development']))
    expect(url.searchParams.getAll('environment')).toEqual(['nightly', 'development'])
  })

  it('reads the event count Sentry sends as a string', () => {
    const issue = shapeSentryIssue({
      id: '7',
      shortId: 'JAVASCRIPT-VUE-7',
      title: 'TypeError: x is undefined',
      culprit: 'src/lib/list.ts',
      level: 'error',
      count: '128',
      userCount: 3,
      firstSeen: '2026-09-01T10:00:00Z',
      lastSeen: '2026-09-14T10:00:00Z',
      permalink: 'https://bagful.sentry.io/issues/7/',
      stats: { '24h': [[1, 2]] },
    })
    expect(issue.events).toBe(128)
    expect(issue.users).toBe(3)
    expect(issue).not.toHaveProperty('stats')
  })

  it('takes a feedback report out of its metadata', () => {
    const report = shapeSentryFeedback({
      id: '9',
      shortId: 'JAVASCRIPT-VUE-9',
      title: 'User Feedback',
      status: 'ignored',
      firstSeen: '2026-09-10T08:00:00Z',
      permalink: 'https://bagful.sentry.io/issues/9/',
      metadata: { message: 'The list does not sync', name: 'Ana', contact_email: 'ana@example.com' },
    })
    expect(report).toMatchObject({
      message: 'The list does not sync',
      name: 'Ana',
      email: 'ana@example.com',
      status: 'ignored',
    })
  })
})

describe('ban requests', () => {
  const A = 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'

  it('carries a trimmed reason on a ban and on nothing else', () => {
    expect(parseRequest({ service: 'clerk', action: 'ban', userId: A, reason: '  spam  ' })).toEqual({ service: 'clerk', action: 'ban', userId: A, reason: 'spam' })
    expect(parseRequest({ service: 'clerk', action: 'ban', userId: A, reason: '   ' })).toEqual({ service: 'clerk', action: 'ban', userId: A })
    expect(parseRequest({ service: 'clerk', action: 'unban', userId: A, reason: 'x' })).toEqual({ service: 'clerk', action: 'unban', userId: A })
    expect(parseRequest({ service: 'clerk', action: 'ban', userId: A, reason: 'x'.repeat(500) }).reason).toHaveLength(300)
  })
})

describe('Clerk banned list', () => {
  it('is a plain view, limited to owners like search', () => {
    const request = parseRequest({ service: 'clerk', view: 'banned' })
    expect(request).toEqual({ service: 'clerk', view: 'banned' })
    expect(refuseClerkRequest(request, 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE', [])).not.toBeNull()
    expect(refuseClerkRequest(request, 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE', ['user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'])).toBeNull()
  })
})

describe('PostHog recordings query', () => {
  it('reads first_url as an aggregate state, which any() cannot do against real rows', () => {
    const sql = posthogRecordingsQuery().query.query
    expect(sql).toContain('argMinMerge(first_url)')
    expect(sql).not.toContain('any(first_url)')
  })
})

describe('PostHog replayers', () => {
  const A = 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'
  const B = 'user_2abcdefghijKLMNOPqrstuvwxyz'

  it('takes Clerk ids only, and marks exactly those with a recording', () => {
    expect(parseRequest({ service: 'posthog', view: 'replayers', userIds: [A, B] })).toEqual({ service: 'posthog', view: 'replayers', userIds: [A, B] })
    expect(parseRequest({ service: 'posthog', view: 'replayers', userIds: ["x' OR 1=1"] })).toBeNull()
    expect(posthogReplayersQuery([A]).query.query).toContain(`'${A}'`)
    expect(shapeReplayers([A, B], { results: [[B]] })).toEqual([{ userId: A, replay: false }, { userId: B, replay: true }])
  })
})

describe('PostHog versions', () => {
  const A = 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'

  it('takes Clerk ids only, asks for one channel, and returns only the people PostHog heard from', () => {
    expect(parseRequest({ service: 'posthog', view: 'versions', userIds: [A] })).toEqual({ service: 'posthog', view: 'versions', userIds: [A] })
    expect(parseRequest({ service: 'posthog', view: 'versions', userIds: ["x' OR 1=1"] })).toBeNull()
    const query = posthogVersionsQuery([A], 'production').query
    expect(query.query).toContain(`'${A}'`)
    expect(query.values).toEqual({ channel: 'production' })
    expect(shapeVersions({ results: [[A, '0.8.22'], ['user_x', null]] })).toEqual([{ userId: A, version: '0.8.22' }])
  })
})

describe('PostHog version spread', () => {
  it('needs no ids, asks for one row per signed-in person on one channel', () => {
    expect(parseRequest({ service: 'posthog', view: 'version-spread' })).toEqual({ service: 'posthog', view: 'version-spread' })
    const query = posthogVersionSpreadQuery('nightly').query
    expect(query.query).toContain("startsWith(distinct_id, 'user_')")
    expect(query.query).toContain('GROUP BY distinct_id')
    expect(query.values).toEqual({ channel: 'nightly' })
  })
})

describe('OneSignal subscribers', () => {
  const A = 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'
  const B = 'user_2abcdefghijKLMNOPqrstuvwxyz'

  it('accepts a handful of Clerk ids, once each, and nothing else', () => {
    expect(parseRequest({ service: 'onesignal', view: 'subscribers', userIds: [A, B, A] })).toEqual({
      service: 'onesignal',
      view: 'subscribers',
      userIds: [A, B],
    })
    expect(parseRequest({ service: 'onesignal', view: 'subscribers', userIds: [] })).toBeNull()
    expect(parseRequest({ service: 'onesignal', view: 'subscribers', userIds: ['nope'] })).toBeNull()
    expect(parseRequest({ service: 'onesignal', view: 'subscribers', userIds: [A, 7] })).toBeNull()
    expect(parseRequest({ service: 'onesignal', view: 'subscribers' })).toBeNull()
    const many = Array.from({ length: 51 }, (_, i) => `user_${String(i).padStart(12, 'a')}`)
    expect(parseRequest({ service: 'onesignal', view: 'subscribers', userIds: many })).toBeNull()
  })

  it('puts the id in the path', () => {
    expect(oneSignalUserUrl('app-1', A)).toBe(`https://api.onesignal.com/apps/app-1/users/by/external_id/${A}`)
  })

  it('says on when any push device is subscribed, off when none is', () => {
    const phone = { type: 'AndroidPush', enabled: true, device_model: 'Pixel 8', device_os: '15', app_version: '0.8.2' }
    const web = { type: 'ChromePush', enabled: false }
    expect(shapeSubscriber(A, { subscriptions: [phone, web], properties: { last_active: 1757923200 } })).toEqual({
      userId: A,
      state: 'on',
      devices: [
        { kind: 'Android', enabled: true, model: 'Pixel 8', os: '15', appVersion: '0.8.2' },
        { kind: 'Chrome', enabled: false, model: null, os: null, appVersion: null },
      ],
      lastActive: new Date(1757923200 * 1000).toISOString(),
    })
    expect(shapeSubscriber(A, { subscriptions: [web] }).state).toBe('off')
  })

  it('says none for a person OneSignal has not heard of, or who only has email', () => {
    expect(shapeSubscriber(A, null)).toEqual({ userId: A, state: 'none', devices: [], lastActive: null })
    expect(shapeSubscriber(A, { subscriptions: [{ type: 'Email', enabled: true }] }).state).toBe('none')
  })
})

describe('OneSignal', () => {
  it('asks for the app it holds the key for', () => {
    expect(new URL(oneSignalNotificationsUrl('app-1')).searchParams.get('app_id')).toBe('app-1')
  })

  it('reads counts and unix times, and the English copy', () => {
    const sent = shapeNotification({
      id: 'n1',
      contents: { ro: 'Radu a adăugat Lapte', en: 'Radu added Milk' },
      successful: 2,
      failed: 1,
      errored: 0,
      remaining: 0,
      queued_at: 1757923200,
      completed_at: 1757923205,
      include_aliases: { external_id: ['user_secret'] },
    })
    expect(sent).toEqual({
      id: 'n1',
      text: 'Radu added Milk',
      at: new Date(1757923205 * 1000).toISOString(),
      delivered: 2,
      unsubscribed: 1,
      errored: 0,
      remaining: 0,
      canceled: false,
    })
  })

  it('falls back to when it was queued while it is still sending', () => {
    expect(shapeNotification({ id: 'n2', contents: {}, queued_at: 1757923200 }).at).toBe(
      new Date(1757923200 * 1000).toISOString(),
    )
  })
})

describe('Clerk', () => {
  const raw = {
    id: 'user_2abc',
    first_name: 'Radu',
    last_name: null,
    image_url: 'https://img.clerk.com/x',
    primary_email_address_id: 'e2',
    email_addresses: [
      { id: 'e1', email_address: 'old@example.com' },
      { id: 'e2', email_address: 'radu@example.com' },
    ],
    external_accounts: [{ provider: 'oauth_google' }],
    password_enabled: false,
    two_factor_enabled: false,
    banned: false,
    locked: false,
    created_at: 1750000000000,
    last_sign_in_at: 1757900000000,
    last_active_at: null,
    private_metadata: { note: 'never leaves the function' },
  }

  it('keeps what the page shows and nothing else', () => {
    const user = shapeClerkUser(raw)
    expect(user).toEqual({
      id: 'user_2abc',
      name: 'Radu',
      email: 'radu@example.com',
      imageUrl: 'https://img.clerk.com/x',
      methods: ['google', 'email'],
      createdAt: new Date(1750000000000).toISOString(),
      lastSignInAt: new Date(1757900000000).toISOString(),
      lastActiveAt: null,
      twoFactor: false,
      banned: false,
      locked: false,
    })
  })

  it('names a password instead of an email code when there is one', () => {
    expect(signInMethods({ password_enabled: true, email_addresses: [{ id: 'e' }] })).toEqual(['password'])
  })

  it('reads the count in either shape', () => {
    expect(readClerkCount({ object: 'total_count', total_count: 12 })).toBe(12)
    expect(readClerkCount(12)).toBe(12)
  })
})

describe('PostHog', () => {
  it('parses the one view it answers', () => {
    expect(parseRequest({ service: 'posthog', view: 'activity' })).toEqual({ service: 'posthog', view: 'activity' })
    expect(parseRequest({ service: 'posthog', view: 'persons' })).toBeNull()
  })

  it('reads production on the production project and nightly everywhere else', () => {
    expect(posthogChannel('https://qwpyiperbjaeykrvilhf.supabase.co')).toBe('production')
    expect(posthogChannel('https://someotherref.supabase.co')).toBe('nightly')
    expect(posthogChannel(undefined)).toBe('nightly')
  })

  it('passes the channel as a value, and never selects a person', () => {
    const body = posthogActivityQuery('nightly')
    expect(body.query.values).toEqual({ channel: 'nightly' })
    // person_id only ever inside uniq(): a count of people, never a list of them.
    expect(body.query.query.replaceAll("uniqIf(person_id, startsWith(distinct_id, 'user_'))", '')).not.toMatch(/person_id|distinct_id|email/)
    expect(body.query.query).not.toContain('nightly')
  })

  it('lays counts on a fixed 30-day axis, zero-filling empty days and dropping strays', () => {
    const today = new Date('2026-09-29T12:00:00Z')
    const shaped = shapePostHogActivity({
      results: [
        ['2026-09-29', 'item_added', 'search', 3],
        ['2026-09-29', 'item_added', 'barcode', '2'],
        ['2026-09-28', '$active', '', 5],
        ['2026-01-01', 'item_added', 'search', 99],
        'garbage',
      ],
    }, 'production', today)
    expect(shaped.days).toHaveLength(30)
    expect(shaped.days.at(0)).toBe('2026-08-31')
    expect(shaped.days.at(-1)).toBe('2026-09-29')
    expect(shaped.counts.item_added.search.at(-1)).toBe(3)
    expect(shaped.counts.item_added.barcode.at(-1)).toBe(2)
    expect(shaped.counts.item_added.search.reduce((a, b) => a + b)).toBe(3)
    expect(shaped.counts.$active[''].at(-2)).toBe(5)
  })
})

// ─── actions ─────────────────────────────────────────────────────────────────
// The dashboard can now change things, so what parseRequest lets through, what the
// function refuses and what it asks of the vendors are pinned here.
import {
  actorTokenBody,
  callerId,
  clerkSearchUrl,
  isAction,
  needsOwner,
  parseOwners,
  pushWasSent,
  refuseClerkRequest,
  refuseAction,
  sentryIssueUpdateUrl,
  sentryStatusOf,
  shapePostHogRecordings,
  testPushBody,
} from '../supabase/functions/_shared/services.ts'

const ME = 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE'
const THEM = 'user_2abcdefghijKLMNOPqrstuvwxyz'

describe('parseRequest, actions', () => {
  it('accepts the five Clerk actions on a valid id and nothing else', () => {
    for (const action of ['ban', 'unban', 'revoke_sessions', 'impersonate', 'delete']) {
      expect(parseRequest({ service: 'clerk', action, userId: THEM })).toEqual({ service: 'clerk', action, userId: THEM })
    }
    expect(parseRequest({ service: 'clerk', action: 'ban', userId: '../users' })).toBeNull()
  })

  it('accepts a Sentry status change only for a numeric issue id', () => {
    expect(parseRequest({ service: 'sentry', action: 'resolve', issueId: '123' })).toEqual({
      service: 'sentry', action: 'resolve', issueId: '123',
    })
    expect(parseRequest({ service: 'sentry', action: 'resolve', issueId: '1&project=2' })).toBeNull()
  })

  it('takes a test push with or without a user', () => {
    expect(parseRequest({ service: 'onesignal', action: 'test_push' })).toEqual({ service: 'onesignal', action: 'test_push' })
    expect(parseRequest({ service: 'onesignal', action: 'test_push', userId: THEM })?.userId).toBe(THEM)
    expect(parseRequest({ service: 'onesignal', action: 'test_push', userId: 'x' })).toBeNull()
  })

  it('takes a Clerk search, trimmed, and refuses an empty one', () => {
    expect(parseRequest({ service: 'clerk', view: 'search', query: '  anna ' })).toEqual({ service: 'clerk', view: 'search', query: 'anna' })
    expect(parseRequest({ service: 'clerk', view: 'search', query: '  ' })).toBeNull()
  })

  it('knows an action from a read', () => {
    expect(isAction(parseRequest({ service: 'clerk', action: 'ban', userId: THEM }))).toBe(true)
    expect(isAction(parseRequest({ service: 'clerk', view: 'summary' }))).toBe(false)
  })
})

describe('missingSecrets, writes', () => {
  const has = (names) => (name) => (names.includes(name) ? 'x' : undefined)

  it('asks for the Sentry write token only when the request writes', () => {
    const read = parseRequest({ service: 'sentry', view: 'issues' })
    const write = parseRequest({ service: 'sentry', action: 'resolve', issueId: '1' })
    expect(missingSecrets('sentry', has(['SENTRY_READ_TOKEN']), read)).toEqual([])
    expect(missingSecrets('sentry', has(['SENTRY_READ_TOKEN']), write)).toEqual(['SENTRY_WRITE_TOKEN'])
  })
})

describe('refuseAction', () => {
  it('will not ban, impersonate or delete the caller themselves', () => {
    for (const action of ['ban', 'impersonate', 'delete']) {
      expect(refuseAction({ service: 'clerk', action, userId: ME }, ME)).toBeTruthy()
    }
  })

  it('lets the caller sign themselves out everywhere', () => {
    expect(refuseAction({ service: 'clerk', action: 'revoke_sessions', userId: ME }, ME)).toBeNull()
  })

  it('lets an admin act on someone else, and unban anyone', () => {
    expect(refuseAction({ service: 'clerk', action: 'ban', userId: THEM }, ME)).toBeNull()
    expect(refuseAction({ service: 'clerk', action: 'unban', userId: ME }, ME)).toBeNull()
  })

  it('refuses when the caller cannot be identified', () => {
    expect(refuseAction({ service: 'clerk', action: 'ban', userId: THEM }, null)).toBeTruthy()
  })
})

describe('callerId', () => {
  const token = (sub) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.s`

  it('reads the Clerk id out of the bearer token', () => {
    expect(callerId(`Bearer ${token(ME)}`)).toBe(ME)
  })

  it('returns null for anything that is not a Clerk id', () => {
    expect(callerId(`Bearer ${token('admin')}`)).toBeNull()
    expect(callerId('Bearer nonsense')).toBeNull()
    expect(callerId(null)).toBeNull()
  })
})

describe('what is asked of the vendors', () => {
  it('actor token: this user, acted by the caller, short lived', () => {
    expect(actorTokenBody(THEM, ME)).toEqual({ user_id: THEM, actor: { sub: ME }, expires_in_seconds: 600 })
  })

  it('searches Clerk by the query, encoded', () => {
    expect(clerkSearchUrl('a b&c')).toContain('query=a+b%26c')
  })

  it('maps actions to Sentry statuses and targets one issue', () => {
    expect(sentryStatusOf('resolve')).toBe('resolved')
    expect(sentryStatusOf('ignore')).toBe('ignored')
    expect(sentryStatusOf('unresolve')).toBe('unresolved')
    expect(sentryIssueUpdateUrl('42')).toMatch(/\/issues\/\?id=42$/)
  })

  it('treats an answer with an id as sent, even beside a stale-subscription warning', () => {
    expect(pushWasSent({ id: 'abc', external_id: null })).toBe(true)
    expect(pushWasSent({ id: 'abc', errors: { invalid_aliases: { external_id: [THEM] } } })).toBe(true)
  })

  it('treats an empty id, or no answer, as not sent', () => {
    expect(pushWasSent({ id: '', errors: ['All included players are not subscribed'] })).toBe(false)
    expect(pushWasSent(null)).toBe(false)
  })

  it('addresses a test push to one person by Clerk id', () => {
    expect(testPushBody('app', THEM, 'nightly').include_aliases).toEqual({ external_id: [THEM] })
  })

  it('says which channel a test notification came from, in title and text', () => {
    const body = testPushBody('app', THEM, 'nightly')
    expect(body.headings.en).toContain('nightly')
    expect(body.contents.en).toContain('nightly')
    expect(testPushBody('app', THEM, 'production').headings.en).toContain('production')
  })
})

describe('shapePostHogRecordings', () => {
  it('keeps id, time, length and the start PATH, and links into the player', () => {
    const [row] = shapePostHogRecordings({
      results: [['0193abcd-1234-7000-8000-000000000001', '2026-10-15 10:00:00', 61, 12, 'https://x.app/lists?invite=SECRET']],
    })
    expect(row.startPath).toBe('/lists')
    expect(row.seconds).toBe(61)
    expect(row.startedAt).toBe('2026-10-15T10:00:00.000Z')
    expect(row.url).toContain('/replay/0193abcd-1234-7000-8000-000000000001')
    expect(JSON.stringify(row)).not.toContain('SECRET')
  })

  it('drops a row whose id is not a plain session id', () => {
    expect(shapePostHogRecordings({ results: [['../x', '2026-10-15 10:00:00', 1, 1, null]] })).toEqual([])
  })
})

describe('Clerk owners', () => {
  const OWNER = ME
  const act = (action, userId) => parseRequest({ service: 'clerk', action, userId })

  it('treats Clerk actions and search as owner-only, and reads and other services as not', () => {
    expect(needsOwner(act('ban', THEM))).toBe(true)
    expect(needsOwner(parseRequest({ service: 'clerk', view: 'search', query: 'a' }))).toBe(true)
    expect(needsOwner(parseRequest({ service: 'clerk', view: 'summary' }))).toBe(false)
    expect(needsOwner(parseRequest({ service: 'onesignal', action: 'test_push' }))).toBe(false)
  })

  it('refuses a caller who is not listed, and everyone when the list is empty', () => {
    expect(refuseClerkRequest(act('impersonate', THEM), THEM, [OWNER])).toBeTruthy()
    expect(refuseClerkRequest(act('impersonate', THEM), OWNER, [])).toBeTruthy()
    expect(refuseClerkRequest(act('impersonate', THEM), null, [OWNER])).toBeTruthy()
  })

  it('lets a listed owner act on someone else, but not on another owner', () => {
    const OTHER = 'user_2ownerownerOWNER000000'
    expect(refuseClerkRequest(act('impersonate', THEM), OWNER, [OWNER, OTHER])).toBeNull()
    expect(refuseClerkRequest(act('impersonate', OTHER), OWNER, [OWNER, OTHER])).toBeTruthy()
    expect(refuseClerkRequest(act('revoke_sessions', OTHER), OWNER, [OWNER, OTHER])).toBeTruthy()
  })

  it('lets an owner sign themselves out everywhere', () => {
    expect(refuseClerkRequest(act('revoke_sessions', OWNER), OWNER, [OWNER])).toBeNull()
    expect(refuseClerkRequest(act('ban', OWNER), OWNER, [OWNER])).toBeTruthy()
  })

  it('asks for the owners secret on a Clerk action and not on a Clerk read', () => {
    expect(missingSecrets('clerk', (n) => (n === 'CLERK_SECRET_KEY' ? 'x' : undefined), act('ban', THEM))).toEqual(['CLERK_ACTION_ADMINS'])
    expect(missingSecrets('clerk', (n) => (n === 'CLERK_SECRET_KEY' ? 'x' : undefined), parseRequest({ service: 'clerk', view: 'summary' }))).toEqual([])
  })

  it('keeps only well-formed ids from the list', () => {
    expect(parseOwners(` ${ME} , nonsense,${THEM}`)).toEqual([ME, THEM])
    expect(parseOwners(undefined)).toEqual([])
  })
})
