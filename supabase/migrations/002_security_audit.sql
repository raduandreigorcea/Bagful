-- ─── security audit trail and rate limiting ──────────────────────────────────
-- Two locked-down tables and the functions that write them: what happened, how
-- often someone is allowed to make it happen, and who may read that back.
--
-- This comes before the list, lists and the catalog because all three depend
-- on it — join_list_with_code() logs here and throttles against it, the list's
-- insert trigger (004_shopping_list.sql) throttles against it, and so do the two
-- catalog write RPCs.
--
-- Why any of this lives in the database rather than at the edge: the browser
-- talks to Supabase directly (VITE_SUPABASE_URL), so a Vercel firewall rule only
-- ever sees requests for the app shell, never a single PostgREST call. Anything
-- that watches or throttles the API has to live where the API does. Sentry has
-- the same blind spot — it only sees the browser, and someone hitting PostgREST
-- with a valid token never loads our JavaScript.

-- ─── the audit trail ─────────────────────────────────────────────────────────
create table if not exists public.security_events (
  id         bigint      generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text        not null,
  actor      text,        -- Clerk user id; null when the caller was unauthenticated
  list_id  uuid,        -- deliberately no FK: see below
  detail     jsonb       not null default '{}'::jsonb
);

-- No foreign key on list_id on purpose. "Owner deleted the list and removed
-- everyone first" is exactly the sequence an audit log exists to preserve, and an
-- ON DELETE CASCADE would erase it at the moment it became interesting.

comment on table public.security_events is
  'Append-only audit trail. Written only by SECURITY DEFINER functions and '
  'triggers; unreadable by client roles. Read it from the SQL editor or with '
  'the service role.';

-- RLS on with *zero policies* means no client role can select, insert, update or
-- delete: every row fails the (nonexistent) policy check. That is the whole
-- access model — an attacker who reaches the API with a valid token still cannot
-- read the log recording them, nor delete their own entries to cover the trail.
alter table public.security_events enable row level security;

-- Grants and RLS are separate gates, and hosted Supabase hands the API roles
-- table privileges by default at provisioning. Revoke explicitly rather than
-- relying on RLS alone; this closes both.
revoke all on public.security_events from anon, authenticated;

-- And the sequence, which the line above does not reach. `id` is an identity
-- column, so it has its own sequence object with its own ACL, and provisioning
-- granted anon SELECT/UPDATE/USAGE on it. SELECT on a sequence returns
-- last_value — that is, roughly how many rows this table holds, which is the one
-- fact it exists to keep from the person it is recording. Not reachable through
-- PostgREST, which does not expose sequences, but the whole point of this table
-- is that it stays shut from more than one direction.
--
-- Identity columns do not need sequence privileges to insert (unlike serial), and
-- only the definer function below writes here, so nothing loses anything.
revoke all on sequence public.security_events_id_seq from anon, authenticated, service_role;

create index if not exists idx_security_events_kind_created_at
  on public.security_events (kind, created_at desc);

-- Serves the invite throttle in 003_lists_and_members.sql: "how many events
-- of this kind has this actor produced recently".
create index if not exists idx_security_events_actor_kind_created_at
  on public.security_events (actor, kind, created_at desc);

-- The only way a row lands in this table. SECURITY DEFINER so it writes as the
-- owner, past the RLS lockdown above; callers are other definer functions and
-- triggers, never a client.
--
-- Never raises: a failure to log must not roll back the operation being logged.
-- Losing an audit row is bad, but breaking a member removal because the audit
-- write hiccuped is worse, and would turn the log into a denial-of-service knob.
create or replace function public.log_security_event(
  p_kind text,
  p_list_id uuid default null,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.security_events (kind, actor, list_id, detail)
  values (p_kind, requesting_user_id(), p_list_id, coalesce(p_detail, '{}'::jsonb));

  -- Opportunistic retention: ~1 call in 100 also trims anything older than 90
  -- days. Doing it inline on every write would put a delete scan on the hot path;
  -- doing it never would grow the table forever. There is no cron on this project,
  -- so this keeps retention self-contained in the one function that writes here.
  if random() < 0.01 then
    delete from public.security_events where created_at < now() - interval '90 days';
  end if;
exception
  when others then
    -- Swallow deliberately (see above).
    return;
end;
$$;

-- EXECUTE defaults to PUBLIC in Postgres. Nothing outside this schema's own
-- definer functions and triggers has any reason to write audit rows, so no role
-- is granted execute at all — the callers run as the owner already.
-- anon and authenticated are named here, not just PUBLIC, and that distinction
-- is the whole point. `revoke ... from public` removes only the PUBLIC grant.
-- Hosted Supabase runs `alter default privileges ... grant execute on functions
-- to anon, authenticated, service_role`, so every function created here also
-- carries an EXPLICIT grant to those roles, which a revoke from PUBLIC leaves
-- untouched.
--
-- A database built from these migrations alone has no default privileges, so
-- revoking from PUBLIC looks sufficient there and the pgTAP suite agreed. On
-- production it was not: import_catalog_products below was callable over
-- /rest/v1/rpc by anyone holding the publishable key that ships in the client
-- bundle, and security_digest exposed the audit summary the same way. Verified
-- against the live project, then closed here.
revoke all on function public.log_security_event(text, uuid, jsonb) from public, anon, authenticated;

-- ─── rate limiting ───────────────────────────────────────────────────────────
-- The target is catalog write amplification. bump_product_popularity() and
-- add_custom_product() (006_product_catalog.sql) both increment
-- product_catalog.add_count on *global* rows, and add_count drives the
-- suggestion ranking every list sees. Uncapped, one account in a loop could
-- push any product to the top of everyone's suggestions. The catalog's own
-- guards cap breadth (500 products per list, 3 distinct accounts to promote)
-- but not repetition, which is the part that moves the ranking.
--
-- Why a counter table rather than counting security_events the way the invite
-- throttle does: invite failures are rare and belong in the audit trail on their
-- own merit. These calls fire on every item add — logging each one to build a
-- count would bury the audit log in routine traffic. So the hot path gets a
-- counter, and only crossing the limit reaches security_events.
create table if not exists public.rate_limit_counters (
  actor        text        not null,
  kind         text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (actor, kind, window_start)
);

-- Same lockdown as security_events, for the same reason: a client that could
-- edit its own counter has no rate limit.
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

-- service_role got the full provisioning grant on both of these as well, TRUNCATE
-- included — and TRUNCATE ignores RLS, so on an append-only audit trail it is the
-- one privilege that could erase the whole thing in a statement. Nothing should
-- write these but the definer functions above, which run as the owner. Reads stay:
-- reading the trail back with the service role is the documented triage path.
-- See the long note at the end of 003_lists_and_members.sql.
revoke all on public.security_events, public.rate_limit_counters from service_role;
grant select on public.security_events, public.rate_limit_counters to service_role;

comment on table public.rate_limit_counters is
  'Fixed-window request counters. Written only by rate_limit_hit(); no client role '
  'can read or modify it.';

-- Records one hit and reports whether the caller is now over the limit.
--
-- Fixed window (via date_bin), not a sliding one: a caller can burst up to twice
-- the limit across a window boundary. That is the standard trade for a limiter
-- that costs a single upsert, and the limits are set far enough above real usage
-- that a 2x boundary burst is still nowhere near abusive.
--
-- Logs to security_events exactly once per window — on the call that crosses the
-- limit (hits = limit + 1) — so repeated hammering leaves one audit row per
-- window rather than one per request.
--
-- Never raises: both callers are fire-and-forget from the client and must not
-- surface an error on top of an add that already succeeded.
create or replace function public.rate_limit_hit(
  p_kind text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := requesting_user_id();
  v_start timestamptz;
  v_hits  integer;
begin
  if v_actor is null then
    return true;  -- unauthenticated callers have no budget
  end if;

  v_start := date_bin(p_window, now(), timestamptz 'epoch');

  insert into public.rate_limit_counters as rl (actor, kind, window_start, hits)
  values (v_actor, p_kind, v_start, 1)
  on conflict (actor, kind, window_start)
  do update set hits = rl.hits + 1
  returning rl.hits into v_hits;

  -- Opportunistic cleanup of windows nobody will read again, same approach as
  -- security_events: rare enough to stay off the hot path, frequent enough that
  -- the table cannot grow without bound.
  if random() < 0.01 then
    delete from public.rate_limit_counters where window_start < now() - interval '1 day';
  end if;

  if v_hits = p_limit + 1 then
    perform public.log_security_event(
      'rate_limited',
      null,
      jsonb_build_object('for', p_kind, 'limit', p_limit)
    );
  end if;

  return v_hits > p_limit;
exception
  when others then
    -- A broken limiter must not break the app. Fail open and let the catalog's
    -- breadth caps (500 products per list, the 3-account promotion gate) hold.
    return false;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, interval) from public, anon, authenticated;

-- ─── reading the trail back ──────────────────────────────────────────────────
-- security_events records the right things, but nothing surfaces them, so in
-- practice it only gets read if someone goes looking. This is as much of that gap
-- as the architecture closes.
--
-- What is deliberately NOT built here: a push alert from inside the database.
--
-- An earlier version of this note justified that by saying pg_net is not
-- installed. That was simply wrong — pg_net is installed, and the push webhooks
-- in 007_realtime.sql run on it. The real reason is narrower and worth stating
-- honestly: an alert channel needs somewhere to send to, and the surface that was
-- removed as an SSRF and exfiltration risk was an *owner-configurable* URL. A
-- hardcoded alert endpoint would not reopen that hole, but it would mean a
-- credential and a destination living in the schema, and an alerting path that
-- fails silently inside a trigger nobody watches. An external poller that fails
-- loudly is the better shape, which is what the role at the bottom of this file
-- and .github/workflows/security-digest.yml provide.
--
-- The remaining honest options are:
--   • this: one query, run from the Supabase SQL editor when you want to look;
--   • an external poller holding a database credential. That is real alerting,
--     but it puts a credential somewhere new, which is a trade worth making
--     deliberately rather than by default.
--
-- Both are now in use. The digest below is the manual read; the poller is
-- .github/workflows/security-digest.yml, running daily as the narrow role
-- defined at the bottom of this file.
--
-- Usage, in the Supabase SQL editor:
--   select * from public.security_digest();     -- last 7 days
--   select * from public.security_digest(30);   -- last 30 days
--
-- Read it as: anything with a nonzero rate_limited or invite_rate_limited count
-- is someone hitting a ceiling, and distinct_actors tells you whether it is one
-- account or many.
create or replace function public.security_digest(p_days integer default 7)
returns table (
  kind            text,
  events          bigint,
  distinct_actors bigint,
  first_seen      timestamptz,
  last_seen       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.kind,
    count(*)                as events,
    count(distinct e.actor) as distinct_actors,
    min(e.created_at)       as first_seen,
    max(e.created_at)       as last_seen
  from public.security_events e
  where e.created_at > now() - make_interval(days => greatest(p_days, 1))
  group by e.kind
  order by count(*) desc, e.kind;
$$;

-- Never reachable from the client. SECURITY DEFINER means this function *can*
-- read the locked-down table, so the grant is the only thing standing between a
-- signed-in user and the audit trail — it goes to service_role alone.
revoke all on function public.security_digest(integer) from public, anon, authenticated;
grant execute on function public.security_digest(integer) to service_role;

-- ─── the poller's role ───────────────────────────────────────────────────────
-- A login role that can read the digest and nothing else, so something other
-- than a human opening the SQL editor notices an attack.
--
-- WHY NOT `grant select on security_events`
--
-- Because it does not work, though it looks like it should. This table has RLS
-- enabled with zero policies, and RLS applies to every role except the table's
-- owner — so a plain SELECT grant passes the privilege check and then matches no
-- rows. That is a poller reporting "all quiet" forever, which is worse than no
-- poller at all. security_digest() is SECURITY DEFINER, so it runs as the owner
-- and can see the table; EXECUTE on it is the only grant that reads anything,
-- and it hands back aggregates rather than the rows themselves.
--
-- So the role gets connect, usage on the schema, and execute on one function. It
-- holds no SELECT on any table in this database, including the one it reports
-- on, and cannot write at all. Raw-row triage stays where it was: the SQL
-- editor, as the service role.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bagful_security_auditor') then
    -- LOGIN with no password: under scram-sha-256 a passwordless role cannot
    -- authenticate, so this is inert until the password is set out of band. That
    -- is deliberate — a credential does not belong in a file that lives in git.
    -- Set it once, from the Supabase SQL editor:
    --
    --   alter role bagful_security_auditor with password '<generated>';
    --
    -- then put the connection string in the GitHub repository secret
    -- SECURITY_DIGEST_DB_URL (Settings → Secrets and variables → Actions).
    --
    -- NOINHERIT so it never picks up privileges from some future grant of
    -- another role to it; anything it may do, it may do explicitly.
    create role bagful_security_auditor with login noinherit;
  end if;
end;
$$;

-- Two concurrent connections is one more than a daily poller needs, and a cheap
-- ceiling on what a leaked credential can occupy.
alter role bagful_security_auditor connection limit 2;

-- The digest scans at most 90 days of a small table. A statement running longer
-- than this is not the digest.
alter role bagful_security_auditor set statement_timeout = '30s';

-- Nothing this role does should ever write, including implicitly.
alter role bagful_security_auditor set default_transaction_read_only = on;

-- current_database() rather than a literal: 'postgres' on hosted Supabase and on
-- the local CLI stack today, but the grant should not be the thing that breaks
-- if that ever differs.
do $$
begin
  execute format('grant connect on database %I to bagful_security_auditor', current_database());
end;
$$;

grant usage on schema public to bagful_security_auditor;

-- The one capability. Note what is absent: no SELECT on any table, no execute on
-- any other function. Postgres grants EXECUTE to PUBLIC by default, so the
-- functions that matter are explicitly revoked from public in their own files —
-- this role inherits that lockdown rather than needing its own revokes.
grant execute on function public.security_digest(integer) to bagful_security_auditor;

-- A role comment is a shared-object comment, and the `postgres` role that runs
-- migrations on hosted Supabase is not a superuser — so this can fail where
-- everything above it succeeded. Wrapped for the same reason 005 wraps the
-- pg_cron sweep: a label is not worth failing a migration over.
do $$
begin
  execute 'comment on role bagful_security_auditor is '
    || quote_literal(
         'Read-only poller for security_digest(). No table privileges; cannot '
         || 'read security_events directly (RLS) nor write anything. Credential '
         || 'lives in the GitHub secret SECURITY_DIGEST_DB_URL.'
       );
exception when others then
  raise warning 'could not comment on bagful_security_auditor (%); role is otherwise configured.', sqlerrm;
end;
$$;
