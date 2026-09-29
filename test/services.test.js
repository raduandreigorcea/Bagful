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
      path: '/api/0/projects/famcart/javascript-vue/',
      detail: 'The requested resource does not exist',
    })
    expect(message).toContain('/api/0/projects/famcart/javascript-vue/')
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

  // The famcart organisation lives in Sentry's EU region. A personal token
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
    expect(new URL(sentryEnvironmentsUrl()).pathname).toBe('/api/0/projects/famcart/javascript-vue/environments/')
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
      permalink: 'https://famcart.sentry.io/issues/7/',
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
      permalink: 'https://famcart.sentry.io/issues/9/',
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
    expect(body.query.query.replaceAll('uniq(person_id)', '')).not.toMatch(/person_id|distinct_id|email/)
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
