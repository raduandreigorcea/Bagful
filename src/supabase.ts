import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '@clerk/vue'
import type { Database } from './types/database'
import type { Database as CatalogDatabase } from './types/catalog'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// The product catalog is a THIRD Supabase project, separate from the production
// and development app databases and shared live by both. It holds the imported
// and curated reference rows and nothing that belongs to anybody; lists,
// lists, history and list-contributed products stay in the app database.
// Its table is `catalog_products`, named so that nothing reads ambiguously
// against the app database's own `product_catalog`.
//
// Its schema lives in a repository of its own, checked out here as a submodule
// at `catalog/` (raduandreigorcea/Bagful-catalog). The separation is real
// rather than a naming convention: its own Supabase project in its own
// organisation, its own migrations, its own pgTAP suite and its own release
// cadence. It has no edge function of any kind.
//
// So what this file depends on is an API rather than a schema. Four RPCs:
//
//   search_catalog(p_query, p_limit, p_markets, p_langs, p_fuzzy, p_retailers)
//   lookup_barcode(p_codes, p_langs)                    005_search.sql
//   bump_product_popularity(p_name, p_maker)
//   catalog_shops_for(p_names)                          008_shops_for.sql
//
// PostgREST resolves an RPC by the argument NAMES in the body, so renaming one
// breaks this app with nothing on this side to warn you. That is why the
// catalog's own pgTAP suite runs in THIS repo's CI as well as its own (the
// catalog-tests job): it turns a change to any of them into a failed build
// rather than into an empty suggestions dropdown in production.
//
// This app reads; it does not write rows here. A popularity bump is the single
// exception, and it increments a counter rather than contributing content. A
// product the catalog has never heard of is contributed to the APP database
// instead, through add_custom_product() — see lib/productSuggestions.
//
// One Clerk session authenticates both, because the catalog project's
// Third-Party Auth integration names the same issuer. That is why the resolver
// below is shared rather than duplicated.
const catalogUrl = import.meta.env.VITE_CATALOG_SUPABASE_URL
const catalogAnonKey = import.meta.env.VITE_CATALOG_SUPABASE_ANON_KEY

// Both schemas are generated, not written. `npm run types` rewrites
// src/types/*.ts from the two LOCAL stacks, so `db reset` both first (the
// migrations are the source of truth, not whatever bagful-dev happens to
// hold). CI regenerates them the same way and fails on any difference, so a
// migration that lands without them turns the build red, and a renamed column
// or RPC argument then fails the typecheck instead of returning [] at runtime.
export type AppClient = SupabaseClient<Database>
export type CatalogClient = SupabaseClient<CatalogDatabase>

let authClient: AppClient | null = null
let catalogClient: CatalogClient | null = null
type TokenResolver = (options?: { skipCache?: boolean }) => Promise<string | null>
let getTokenFn: TokenResolver | null = null

// Reads that die at the network layer are retried with a short backoff: after
// the machine sleeps, the first request often goes out on a dead keep-alive
// socket and fails without ever reaching Supabase (the browser reports this as
// a CORS error). HTTP responses — including 4xx/5xx — are never retried, and
// neither are mutations: a POST whose response was lost may already have been
// applied, so replaying it could double-apply.
const RETRY_DELAYS_MS = [250, 750]

// A read that has had no answer by now is not coming: it is given up on and
// retried like one that failed outright. Without it a request that simply hung
// (a dead socket that never errors) held the app on its loading screen for good,
// which the bot swarm hit once after joining a list. Reads only, for the same
// reason as the retry: a write abandoned mid-flight may already have landed.
const READ_TIMEOUT_MS = 15_000

export async function fetchWithRetry(
  url: RequestInfo | URL,
  options: RequestInit = {},
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase()
  const retriable = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let forwardAbort: (() => void) | undefined
    let attemptOptions = options
    if (retriable) {
      const controller = new AbortController()
      timer = setTimeout(
        () => controller.abort(new DOMException('No answer from the server', 'TimeoutError')),
        READ_TIMEOUT_MS,
      )
      // Forwards the caller's abort, including one that happened before this
      // call, which a listener alone would never hear. Removed in the finally
      // below, or a long-lived signal collects one per attempt.
      const signal = options.signal
      if (signal) {
        forwardAbort = () => controller.abort(signal.reason)
        if (signal.aborted) forwardAbort()
        else signal.addEventListener('abort', forwardAbort, { once: true })
      }
      attemptOptions = { ...options, signal: controller.signal }
    }
    try {
      return await fetch(url, attemptOptions)
    } catch (error) {
      // The caller's own abort ends it; the timeout above is a TimeoutError,
      // not an AbortError, and is retried like any other dead read.
      const aborted =
        options.signal?.aborted || (error as { name?: string })?.name === 'AbortError'
      if (!retriable || aborted || attempt >= RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    } finally {
      clearTimeout(timer)
      if (forwardAbort) options.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

// A request whose token PostgREST refused on time grounds (PGRST303: "JWT
// expired", "JWT not yet valid", "JWT issued at future") is sent once more with
// a token minted fresh, skipping Clerk's cache. These cluster right after the
// phone wakes: Clerk judges its cached token's age from the
// token's `iat` against the device clock, so a phone clock running behind, or a
// WebView whose timers froze in the background, hands out a token the server
// already considers dead. The wait covers the other direction, a token that is
// a few seconds younger than the server's clock allows.
//
// Retrying a mutation is safe here, unlike in fetchWithRetry: the JWT is
// checked before any SQL runs, so a 401 PGRST303 means nothing was applied.
const JWT_TIME_REJECTED = 'PGRST303'
const NOT_YET_VALID_WAIT_MS = 2000

export async function fetchWithFreshToken(
  url: RequestInfo | URL,
  options: RequestInit = {},
): Promise<Response> {
  const response = await fetchWithRetry(url, options)
  if (response.status !== 401 || !getTokenFn) return response
  const body = await response.clone().json().catch(() => null)
  if (body?.code !== JWT_TIME_REJECTED) return response

  if (!/expired/i.test(body.message ?? '')) {
    await new Promise((resolve) => setTimeout(resolve, NOT_YET_VALID_WAIT_MS))
  }
  const token = await getTokenFn({ skipCache: true })
  if (!token) return response
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return fetchWithRetry(url, { ...options, headers })
}

// The token the realtime socket authenticates with.
//
// Realtime reads it only on connect and on each heartbeat (every 25s, realtime-js
// HEARTBEAT_INTERVAL), and a Clerk session token lives 60s. Clerk hands back its
// cached token until that is nearly expired, so a heartbeat could push one with
// 20s left: the server then closed all three channels ("Token has expired 0
// seconds ago") before the next heartbeat brought a fresh one, and the rejoin
// took up to 8s, during which changes from the rest of the list were missed.
// The bot swarm (bots/swarm.mjs) caught it. So a token that would not outlive
// the next heartbeat is swapped for a freshly minted one. Realtime only: the mint
// runs on the heartbeat, in the background, where on REST it would hold up the
// request that needed it (a second, once, against a slow database).
const MIN_TOKEN_LIFE_MS = 35_000

function msUntilExpiry(token: string): number {
  try {
    const payload = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(payload)) as { exp?: number }
    return typeof exp === 'number' ? exp * 1000 - Date.now() : Infinity
  } catch {
    return Infinity
  }
}

export async function resolveRealtimeToken(): Promise<string | null> {
  if (!getTokenFn) return null
  const token = await getTokenFn()
  if (token && msUntilExpiry(token) < MIN_TOKEN_LIFE_MS) return getTokenFn({ skipCache: true })
  return token
}

// There was an unauthenticated `supabase` client exported here for
// "public/unauthenticated queries". Nothing ever imported it — every table is
// behind RLS and every read needs a Clerk token — but being at module scope it
// was constructed on any page that imported this file, for nobody.

// The one client, built once and shared. The token comes from whatever resolver
// was last installed, so the client itself never needs rebuilding when the
// session changes.
export function getSupabase(): AppClient {
  if (!authClient) {
    authClient = createClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      // Single source of auth: supabase-js resolves this callback once per
      // request and attaches the Authorization header itself — no custom
      // header wiring, no second token fetch.
      accessToken: async () => (getTokenFn ? await getTokenFn() : null),
      // Realtime's own, which also covers setAuth() with no argument.
      realtime: { accessToken: resolveRealtimeToken },
      global: {
        fetch: fetchWithFreshToken,
      },
    })
  }
  return authClient
}

// The catalog project's client, or null where it is not configured.
//
// Null is a supported state, not a broken one. It is what a checkout with no
// VITE_CATALOG_* variables gets, and every caller treats a missing catalog the
// same way it treats a failed catalog request: the list's own products
// still appear and the add-item box still works. Suggestions are a convenience,
// and a third project being unreachable must not be able to empty the dropdown.
export function getCatalogSupabase(): CatalogClient | null {
  if (!catalogUrl || !catalogAnonKey) return null
  if (!catalogClient) {
    catalogClient = createClient<CatalogDatabase>(catalogUrl, catalogAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      // The same resolver the app client uses, deliberately. Two clients, one
      // session: the token Clerk issued verifies against both projects because
      // both name the same issuer in their Third-Party Auth settings.
      accessToken: async () => (getTokenFn ? await getTokenFn() : null),
      global: {
        fetch: fetchWithFreshToken,
      },
    })
  }
  return catalogClient
}

// How the client learns to mint tokens. Kept separate from getSupabase because
// the two have different requirements: this needs Clerk's useAuth() and so a
// component context, while the client is wanted from places that have none —
// the router guard in particular.
export function setSupabaseTokenResolver(resolve: TokenResolver): void {
  getTokenFn = resolve
}

// Returns a Supabase client authenticated with the current Clerk session token.
// Use this inside Vue components/composables where useAuth() is available.
export function useSupabase(): AppClient {
  const { getToken } = useAuth()
  // The plain session token, NOT getToken({ template: 'supabase' }).
  //
  // All three projects authenticate through Supabase's native Third-Party Auth,
  // which verifies a Clerk session token against Clerk's JWKS directly. The
  // `supabase` JWT template is the older integration and cost two things for no
  // benefit: a template token carries nbf = iat - 5 against the session token's
  // nbf = iat - 10, halving the clock tolerance before a request is refused as
  // `JWT not yet valid`; and it is minted by a separate call to Clerk's API on
  // every resolve, where the session token is already in memory.
  //
  // Verified against all three projects before the change: each one accepts the
  // session token and answers is_admin()/catalog_is_admin() with it.
  setSupabaseTokenResolver(async (options) => getToken.value(options))
  return getSupabase()
}
