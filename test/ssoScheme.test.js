// Which app an OAuth round trip comes back to.
//
// The bounce page at /sso-native is served by the PRODUCTION web deployment
// whichever APK started the sign-in, because that is the one URL Clerk will
// redirect to. So the page cannot ask its own build which app to hand back to:
// the answer has to travel in the query string the app put there.
import { describe, it, expect } from 'vitest'
import {
  NIGHTLY_BOUNCE_QUERY,
  PRODUCTION_SSO_SCHEME,
  ssoCallbackUrlFromBounceQuery,
} from '../src/lib/ssoScheme'

describe('ssoCallbackUrlFromBounceQuery', () => {
  it('hands a nightly sign-in back to the nightly app', () => {
    expect(ssoCallbackUrlFromBounceQuery('?app=nightly&rotating_token_nonce=n7')).toBe(
      'bagfulnightly://sso-callback?app=nightly&rotating_token_nonce=n7',
    )
  })

  it('hands everything else back to the production app', () => {
    expect(ssoCallbackUrlFromBounceQuery('?rotating_token_nonce=n7')).toBe(
      'bagful://sso-callback?rotating_token_nonce=n7',
    )
  })

  it('forwards an empty query as no query at all', () => {
    expect(ssoCallbackUrlFromBounceQuery('')).toBe('bagful://sso-callback')
  })

  // Production is the safe fallback: it is the app almost everyone has, and a
  // deep link to a scheme nobody claims goes nowhere at all.
  it('falls back to production for an app it does not recognise', () => {
    expect(ssoCallbackUrlFromBounceQuery('?app=staging')).toBe(
      'bagful://sso-callback?app=staging',
    )
    expect(ssoCallbackUrlFromBounceQuery('?app=')).toContain(`${PRODUCTION_SSO_SCHEME}://`)
  })

  // The marker the nightly build appends to the bounce URL and the marker this
  // page looks for are the same string, so they cannot drift apart.
  it('recognises the query the nightly build actually sends', () => {
    expect(ssoCallbackUrlFromBounceQuery(NIGHTLY_BOUNCE_QUERY)).toBe(
      `bagfulnightly://sso-callback${NIGHTLY_BOUNCE_QUERY}`,
    )
  })
})
