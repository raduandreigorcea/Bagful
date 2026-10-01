-- ─── the admin read surface ──────────────────────────────────────────────────
-- Who is allowed to see across lists, and the functions that let them.
--
-- WHY THIS FILE EXISTS
--
-- Every table in this schema is scoped by list membership, and
-- security_events is scoped to nobody at all (RLS on, zero policies). That is
-- the correct posture for an app where the only reader is a member, and it means
-- there is no query a client can issue that answers "how many lists are
-- there". The Bagful-admin dashboard needs exactly those answers.
--
-- Three ways to give it them, and only the third is acceptable:
--
--   1. Put the service-role key in the dashboard. It is a browser app on a
--      public repo. No.
--   2. Stand up a server that holds the service-role key and proxies. A whole
--      deployment target, its own secrets and its own outage mode, for what is
--      fundamentally a set of SELECTs.
--   3. Let Postgres decide. SECURITY DEFINER functions that check an admin table
--      before they read anything. The dashboard keeps using the ordinary
--      publishable key and an ordinary Clerk token, and the database is the
--      authority on who gets more than their own list.
--
-- So: this file adds one table, one gate, and a set of read functions. The
-- dashboard owns none of it, exactly as this app owns none of search_catalog()
-- over in the catalog project.
--
-- WHAT IS NOT HERE, deliberately: any function that deletes a list, removes
-- a member, or edits a product. The dashboard is a read surface plus the two
-- grant/revoke writes at the foot of this file. Adding a destructive RPC here is
-- a decision to take on its own, with its own audit entry and its own test.
--
-- Re-runnable like every other file in this directory. Note the trap the others
-- document: a constraint declared inside `create table if not exists` is skipped
-- wherever the table already exists, so any bound changed up there has to be
-- restated as an explicit alter below it.

-- ─── who is an admin ─────────────────────────────────────────────────────────
-- A table rather than a JWT claim. A claim would mean editing Clerk's Supabase
-- token template in a dashboard, which is a place this repo cannot see and
-- CLAUDE.md already lists two ways to get wrong; a table is checked where the
-- data is, in the same transaction as the read it is gating.
create table if not exists public.admin_users (
  user_id    text        primary key,   -- Clerk user id
  -- Free text, for the human reason. "Owner", "on-call for the August import".
  note       text,
  granted_by text,                      -- Clerk user id of the granting admin; null for the bootstrap row
  granted_at timestamptz not null default now(),
  constraint admin_users_note_length
    check (note is null or char_length(note) between 1 and 200)
);

comment on table public.admin_users is
  'Clerk user ids allowed to call the admin_* functions. Written by admin_grant/'
  'admin_revoke, or by hand with the service role to seed the first row. '
  'Unreadable by client roles: is_admin() is how a client asks about itself.';

-- The same closed-door treatment security_events gets, and for the same reason.
-- RLS on with zero policies means no client role can select, insert, update or
-- delete: every row fails the policy check that does not exist. So the list of
-- who can see everything is itself not visible to anyone holding a token.
alter table public.admin_users enable row level security;

-- Grants and RLS are separate gates, and hosted Supabase hands the API roles
-- table privileges at provisioning. Revoke explicitly rather than trusting RLS
-- alone; this closes both.
revoke all on public.admin_users from anon, authenticated;

-- ─── dropped before they are created ─────────────────────────────────────────
-- `create or replace function` CANNOT change a function's return type, and for a
-- `returns table (...)` function the OUT parameters ARE the return type. Change
-- one column of one of the tables below and re-running this file fails with
--
--   cannot change return type of existing function (SQLSTATE 42P13)
--   Row type defined by OUT parameters is different.
--
-- on every database that already has the old shape -- which is every database
-- except a fresh one. So a local `db reset` passes, CI passes, and the push to a
-- real project is the thing that fails.
--
-- That is the same class of trap the other files in this directory document for
-- constraints declared inside `create table if not exists`: the re-runnable
-- version works everywhere except where it matters. The fix is the same shape
-- too -- state it explicitly rather than relying on the idempotent form.
--
-- Dropping first is safe here because this file recreates every one of them a
-- few lines below, and because plpgsql function bodies are not dependency-tracked:
-- dropping is_admin() does not invalidate the functions that call it, and they
-- all resolve again once it is back.
--
-- ANY function added below needs its signature added here, with its argument
-- types, or it will be the one that fails on the next shape change.
drop function if exists public.is_admin();
drop function if exists public.admin_guard();
drop function if exists public.admin_user_facts();
drop function if exists public.admin_list_facts();
drop function if exists public.admin_overview(timestamptz);
drop function if exists public.admin_activity_series(timestamptz, text);
-- Retired: the Overview feed it served did not scale past a handful of users.
drop function if exists public.admin_recent_activity(integer);
drop function if exists public.admin_list_users(text, text, text, integer, integer);
drop function if exists public.admin_user_detail(text);
drop function if exists public.admin_lists(text, text, text, integer, integer);
drop function if exists public.admin_list_detail(uuid);
drop function if exists public.admin_local_products(text, text, text, integer, integer);
drop function if exists public.admin_security_events(text, timestamptz, text, integer, integer);
drop function if exists public.admin_security_events(text, timestamptz, text, integer, integer, boolean);
drop function if exists public.admin_event_digest(timestamptz);
drop function if exists public.admin_rate_limits(integer);
drop function if exists public.admin_health();
drop function if exists public.admin_grant(text, text);
drop function if exists public.admin_revoke(text);
drop function if exists public.admin_list_admins();
drop function if exists public.admin_top_purchases(timestamptz, integer);
drop function if exists public.admin_catalog_misses(integer);
drop function if exists public.admin_delete_list(uuid);
drop function if exists public.admin_restore_list(uuid);
drop function if exists public.admin_ban_user(text, text);
drop function if exists public.admin_unban_user(text);
drop function if exists public.admin_deleted_lists();
drop function if exists public.admin_banned_users();
drop function if exists public.admin_create_product(text, text, text, integer);
drop function if exists public.admin_update_product(uuid, text, text, text, integer);
drop function if exists public.admin_delete_product(uuid);

-- ─── the gate ────────────────────────────────────────────────────────────────
-- The one question a client may ask about this table, and it may only ask it
-- about itself: `select public.is_admin()`. The dashboard calls this on boot to
-- decide whether to render an admin shell or a "not authorised" screen.
--
-- Answering it honestly to a non-admin costs nothing. It reveals that an admin
-- system exists, which the public repo already does, and it does not reveal who
-- the admins are or how many there are.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users a
    where a.user_id = requesting_user_id()
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Every function below opens with `perform public.admin_guard()`. Raising rather
-- than returning empty is deliberate: an empty result set and a refusal look the
-- same on a dashboard, and "there are no lists" is a very different thing to
-- learn than "you may not ask".
--
-- 42501 is insufficient_privilege, which PostgREST maps to HTTP 403. The
-- dashboard keys its "not authorised" screen off that code rather than off the
-- message text.
create or replace function public.admin_guard()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_guard: caller is not an admin'
      using errcode = '42501';
  end if;
end;
$$;

-- Internal. The functions below are SECURITY DEFINER and owned by the same role,
-- so they keep their own EXECUTE; a client has no reason to call this directly.
--
-- anon and authenticated are named explicitly, and that is not belt-and-braces:
-- `revoke ... from public` removes only the PUBLIC grant, while hosted Supabase
-- runs `alter default privileges ... grant execute on functions to anon,
-- authenticated, service_role`, so every function created here also carries an
-- explicit grant those roles keep. On a local database built from migrations
-- alone there are no default privileges, so revoking from PUBLIC looks
-- sufficient and a pgTAP suite agrees. That is exactly how import_catalog_products()
-- stayed callable by anyone holding the publishable key.
revoke all on function public.admin_guard() from public, anon, authenticated;

-- ─── per-user facts ──────────────────────────────────────────────────────────
-- One definition of "what do we know about this account", shared by the overview,
-- the user list and the user detail page, so the three can never disagree about
-- what "active" means.
--
-- TWO COLUMNS HERE ARE DERIVED RATHER THAN RECORDED, and the dashboard labels
-- them as such:
--
--   first_seen  - nothing records a signup. profiles has updated_at and no
--                 created_at, and a profile row is written on first sign-in and
--                 rewritten on every edit. The earliest membership join is the
--                 better witness, so this is the earlier of that and the profile
--                 timestamp. For a user who has never joined a list and
--                 never edited their name, it is exactly the signup time; for
--                 one who renamed themselves last week it is still their first
--                 join.
--
--   last_active - nothing records a session either. There is no login table, so
--                 this is the most recent thing the account is known to have
--                 DONE: added an item, checked out, joined a list, or
--                 changed their profile. A user who opened the app every day and
--                 added nothing reads as inactive here, which is the honest
--                 answer to the question this column can actually answer.
--
-- Anything that wants a true signup or session number has to record one first.
create or replace function public.admin_user_facts()
returns table (
  user_id            text,
  display_name       text,
  image_url          text,
  profile_updated_at timestamptz,
  banned_at          timestamptz,
  lists         bigint,
  owned_lists   bigint,
  moderator_of       bigint,
  items_added        bigint,
  items_open         bigint,
  purchases          bigint,
  checkouts          bigint,
  products_added     bigint,
  first_seen         timestamptz,
  last_active        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.user_id,
    p.display_name,
    p.image_url,
    p.updated_at as profile_updated_at,
    -- Rides along here rather than in admin_user_detail, because the detail RPC
    -- serialises this row wholesale with to_jsonb(f) -- adding it there would
    -- mean a second source for one fact.
    p.banned_at,
    coalesce(m.lists, 0)       as lists,
    coalesce(o.owned, 0)            as owned_lists,
    coalesce(m.moderator_of, 0)     as moderator_of,
    coalesce(i.items_added, 0)      as items_added,
    coalesce(i.items_open, 0)       as items_open,
    coalesce(h.purchases, 0)        as purchases,
    coalesce(h.checkouts, 0)        as checkouts,
    coalesce(c.products_added, 0)   as products_added,
    least(
      coalesce(m.first_join, p.updated_at),
      p.updated_at
    ) as first_seen,
    greatest(
      p.updated_at,
      coalesce(m.last_join, '-infinity'::timestamptz),
      coalesce(i.last_item, '-infinity'::timestamptz),
      coalesce(h.last_purchase, '-infinity'::timestamptz)
    ) as last_active
  from public.profiles p
  left join (
    select
      hm.user_id,
      -- The COUNTS are of live lists only. A withdrawn list is not a
      -- list this dashboard knows about, so reporting an account as "in 2"
      -- when one of the two cannot be opened is a number that sends whoever
      -- reads it to a not-found page. The membership row itself survives the
      -- withdrawal untouched, which is what makes a restore whole; it just
      -- stops being counted while the list is gone.
      count(*) filter (where hh.deleted_at is null) as lists,
      count(*) filter (
        where hh.deleted_at is null and hm.role in ('moderator', 'admin')
      ) as moderator_of,
      -- The DATES are not filtered. When this account first joined something,
      -- and when it last did, are facts about the account, and withdrawing a
      -- list afterwards does not unmake them. Filtering here would move
      -- first_seen forward onto the profile write and make an old account look
      -- new -- see the first_seen caveat this function's header spells out.
      min(hm.joined_at)                                   as first_join,
      max(hm.joined_at)                                   as last_join
    from public.list_members hm
    join public.lists hh on hh.id = hm.list_id
    group by hm.user_id
  ) m on m.user_id = p.user_id
  left join (
    -- Live lists, for the same reason and one more: 009 made the ownership
    -- slot itself count only live rows, so an owner whose list was
    -- withdrawn may create another immediately. "Owns 1" beside a list
    -- they can no longer open would be describing a slot nobody holds.
    select hh.created_by as user_id, count(*) as owned
    from public.lists hh
    where hh.deleted_at is null
    group by hh.created_by
  ) o on o.user_id = p.user_id
  left join (
    select
      si.added_by as user_id,
      count(*)                                as items_added,
      count(*) filter (where not si.checked)  as items_open,
      max(si.created_at)                      as last_item
    from public.shopping_list_items si
    group by si.added_by
  ) i on i.user_id = p.user_id
  left join (
    select
      ph.purchased_by as user_id,
      count(*)                        as purchases,
      count(distinct ph.checkout_id)  as checkouts,
      max(ph.purchased_at)            as last_purchase
    from public.purchase_history ph
    group by ph.purchased_by
  ) h on h.user_id = p.user_id
  left join (
    select pc.contributed_by as user_id, count(*) as products_added
    from public.product_catalog pc
    where pc.contributed_by is not null
    group by pc.contributed_by
  ) c on c.user_id = p.user_id;
$$;

revoke all on function public.admin_user_facts() from public, anon, authenticated;

-- ─── per-list facts ─────────────────────────────────────────────────────
-- The same idea for the group. last_active here is the most recent thing anyone
-- in the list did, so an inactive list is one nobody has shopped in,
-- rather than one nobody has opened.
create or replace function public.admin_list_facts()
returns table (
  id              uuid,
  name            text,
  emoji           text,
  invite_code     text,
  created_by      text,
  owner_name      text,
  owner_image_url text,
  max_items_per_member integer,
  created_at      timestamptz,
  members         bigint,
  moderators      bigint,
  items_total     bigint,
  items_open      bigint,
  purchases       bigint,
  checkouts       bigint,
  products_added  bigint,
  last_active     timestamptz,
  -- Set means an admin withdrew this list. Every caller has to say what it
  -- does about that; the note at the foot of this function explains why.
  deleted_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    hh.id,
    hh.name,
    hh.emoji,
    hh.invite_code,
    hh.created_by,
    owner.display_name as owner_name,
    owner.image_url    as owner_image_url,
    hh.max_items_per_member,
    hh.created_at,
    coalesce(m.members, 0)       as members,
    coalesce(m.moderators, 0)    as moderators,
    coalesce(i.items_total, 0)   as items_total,
    coalesce(i.items_open, 0)    as items_open,
    coalesce(h.purchases, 0)     as purchases,
    coalesce(h.checkouts, 0)     as checkouts,
    coalesce(c.products_added, 0) as products_added,
    greatest(
      hh.created_at,
      coalesce(m.last_join, '-infinity'::timestamptz),
      coalesce(i.last_item, '-infinity'::timestamptz),
      coalesce(h.last_purchase, '-infinity'::timestamptz)
    ) as last_active,
    hh.deleted_at
  from public.lists hh
  left join public.profiles owner on owner.user_id = hh.created_by
  left join (
    select
      hm.list_id,
      count(*)                                                  as members,
      count(*) filter (where hm.role in ('moderator', 'admin')) as moderators,
      max(hm.joined_at)                                         as last_join
    from public.list_members hm
    group by hm.list_id
  ) m on m.list_id = hh.id
  left join (
    select
      si.list_id,
      count(*)                               as items_total,
      count(*) filter (where not si.checked) as items_open,
      max(si.created_at)                     as last_item
    from public.shopping_list_items si
    group by si.list_id
  ) i on i.list_id = hh.id
  left join (
    select
      ph.list_id,
      count(*)                       as purchases,
      count(distinct ph.checkout_id) as checkouts,
      max(ph.purchased_at)           as last_purchase
    from public.purchase_history ph
    group by ph.list_id
  ) h on h.list_id = hh.id
  left join (
    select pc.list_id, count(*) as products_added
    from public.product_catalog pc
    where pc.list_id is not null
    group by pc.list_id
  ) c on c.list_id = hh.id
  -- No filter here, and that is a reversal from how this read before.
  --
  -- Withdrawn lists were dropped in this one place, so that admin_overview,
  -- admin_lists and admin_list_detail all inherited it. That is
  -- right for the first two and wrong for the third: a withdrawn list is
  -- precisely the thing an operator needs to OPEN -- from a member's profile, or
  -- from the Bans page that lists it -- in order to decide whether to restore
  -- it. Inheriting the filter turned every one of those links into "No such
  -- list. It may have been deleted", which is the dashboard refusing to
  -- show a row it is offering to restore on the next page along.
  --
  -- So the fact rides along as deleted_at and each caller decides for itself:
  -- the list and the overview exclude it, the detail RPC serves it and says so.
  --
  -- What has NOT changed is where that decision cannot live. Every admin_*
  -- function is security definer and bypasses RLS by design, so
  -- active_list_ids() and the ten policies it feeds govern what the APP's
  -- users see and have no bearing whatsoever on what this dashboard reads. Two
  -- separate doors, and closing one taught me nothing about the other: the
  -- first end-to-end test deleted a list, watched it vanish from the app,
  -- and found it still sitting in the admin list.
  ;
$$;

revoke all on function public.admin_list_facts() from public, anon, authenticated;

-- ─── the overview ────────────────────────────────────────────────────────────
-- Everything the landing screen needs in one round trip, because eleven separate
-- counts would be eleven separate PostgREST requests racing each other to paint
-- a screen that has to agree with itself.
--
-- `window` counts things that HAPPENED in the range. `totals` counts what exists
-- now and ignores the range entirely, which is why a 24h view still shows the
-- real number of lists rather than a number that looks like a collapse.
create or replace function public.admin_overview(p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_since  timestamptz := coalesce(p_since, now() - interval '7 days');
  v_result jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'generated_at', now(),
    'since',        v_since,
    'totals', jsonb_build_object(
      'users',            (select count(*) from public.profiles),
      'lists',       (select count(*) from public.lists),
      'memberships',      (select count(*) from public.list_members),
      'list_items',       (select count(*) from public.shopping_list_items),
      'list_items_open',  (select count(*) from public.shopping_list_items where not checked),
      'purchases',        (select count(*) from public.purchase_history),
      'checkouts',        (select count(distinct checkout_id) from public.purchase_history),
      'local_products',   (select count(*) from public.product_catalog),
      'community_products',
        (select count(*) from public.product_catalog where source = 'community'),
      'promoted_products',
        (select count(*) from public.product_catalog where list_id is null),
      'security_events',  (select count(*) from public.security_events)
    ),
    'window', jsonb_build_object(
      -- "New users" is first_seen, with the caveat admin_user_facts() spells out.
      'new_users',
        (select count(*) from public.admin_user_facts() f where f.first_seen >= v_since),
      'active_users',
        (select count(*) from public.admin_user_facts() f where f.last_active >= v_since),
      'new_lists',
        (select count(*) from public.lists where created_at >= v_since),
      'members_joined',
        (select count(*) from public.list_members where joined_at >= v_since),
      'items_added',
        (select count(*) from public.shopping_list_items where created_at >= v_since),
      'items_checked',
        (select count(*) from public.shopping_list_items
          where checked_at is not null and checked_at >= v_since),
      'purchases',
        (select count(*) from public.purchase_history where purchased_at >= v_since),
      'checkouts',
        (select count(distinct checkout_id) from public.purchase_history
          where purchased_at >= v_since),
      'products_added',
        (select count(*) from public.product_catalog where created_at >= v_since),
      'security_events',
        (select count(*) from public.security_events where created_at >= v_since)
    ),
    -- The lists and the list are small; this is the shape of them. Feeds the
    -- two distribution strips on the overview without a second round trip.
    'distribution', jsonb_build_object(
      'list_sizes', coalesce((
        select jsonb_agg(t order by t.members)
        from (
          select f.members, count(*) as lists
          from public.admin_list_facts() f
          where f.deleted_at is null
          group by f.members
        ) t
      ), '[]'::jsonb),
      'members_per_user', coalesce((
        select jsonb_agg(t order by t.lists)
        from (
          select f.lists, count(*) as users
          from public.admin_user_facts() f
          group by f.lists
        ) t
      ), '[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_overview(timestamptz) from public, anon;
grant execute on function public.admin_overview(timestamptz) to authenticated;

-- ─── activity over time ──────────────────────────────────────────────────────
-- One row per bucket across the whole range, INCLUDING the empty ones. A chart
-- fed only the buckets that have rows draws a line that skips the quiet days,
-- which reads as continuous activity at a different scale rather than as a gap.
--
-- p_bucket is checked against a whitelist rather than passed through. date_trunc
-- takes its field as a value so an unknown string raises rather than injects, but
-- an unknown string raising inside a dashboard query is a 500 with a Postgres
-- message in it, and this way it is a sentence.
create or replace function public.admin_activity_series(
  p_since  timestamptz default null,
  p_bucket text        default 'day'
)
returns table (
  bucket         timestamptz,
  new_lists bigint,
  members_joined bigint,
  items_added    bigint,
  items_checked  bigint,
  purchases      bigint,
  checkouts      bigint,
  active_users   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_since timestamptz;
  v_step  interval;
begin
  perform public.admin_guard();

  if p_bucket not in ('hour', 'day', 'week') then
    raise exception 'admin_activity_series: p_bucket must be hour, day or week, got %',
      coalesce(p_bucket, '<null>');
  end if;

  v_step  := case p_bucket
               when 'hour' then interval '1 hour'
               when 'day'  then interval '1 day'
               else             interval '1 week'
             end;
  v_since := date_trunc(p_bucket, coalesce(p_since, now() - interval '7 days'));

  return query
  with spine as (
    select generate_series(v_since, date_trunc(p_bucket, now()), v_step) as bucket
  )
  select
    s.bucket,
    coalesce(hh.n, 0) as new_lists,
    coalesce(hm.n, 0) as members_joined,
    coalesce(ia.n, 0) as items_added,
    coalesce(ic.n, 0) as items_checked,
    coalesce(ph.n, 0) as purchases,
    coalesce(ph.c, 0) as checkouts,
    coalesce(au.n, 0) as active_users
  from spine s
  left join (
    select date_trunc(p_bucket, created_at) as b, count(*) as n
    from public.lists where created_at >= v_since group by 1
  ) hh on hh.b = s.bucket
  left join (
    select date_trunc(p_bucket, joined_at) as b, count(*) as n
    from public.list_members where joined_at >= v_since group by 1
  ) hm on hm.b = s.bucket
  left join (
    select date_trunc(p_bucket, created_at) as b, count(*) as n
    from public.shopping_list_items where created_at >= v_since group by 1
  ) ia on ia.b = s.bucket
  left join (
    select date_trunc(p_bucket, checked_at) as b, count(*) as n
    from public.shopping_list_items
    where checked_at is not null and checked_at >= v_since group by 1
  ) ic on ic.b = s.bucket
  left join (
    select
      date_trunc(p_bucket, purchased_at) as b,
      count(*) as n,
      count(distinct checkout_id) as c
    from public.purchase_history where purchased_at >= v_since group by 1
  ) ph on ph.b = s.bucket
  -- Distinct accounts that did anything in the bucket. Deliberately recomputed
  -- per bucket rather than summed: a user active on Monday and Tuesday is one
  -- active user on each, and two would be wrong on both.
  left join (
    select b, count(distinct actor) as n
    from (
      select date_trunc(p_bucket, created_at) as b, added_by as actor
      from public.shopping_list_items where created_at >= v_since
      union all
      select date_trunc(p_bucket, purchased_at), purchased_by
      from public.purchase_history where purchased_at >= v_since
      union all
      select date_trunc(p_bucket, joined_at), user_id
      from public.list_members where joined_at >= v_since
    ) acts
    group by b
  ) au on au.b = s.bucket
  order by s.bucket;
end;
$$;

revoke all on function public.admin_activity_series(timestamptz, text) from public, anon;
grant execute on function public.admin_activity_series(timestamptz, text) to authenticated;

-- ─── the user list ───────────────────────────────────────────────────────────
-- Sorting is expressed as one ORDER BY item per (column, direction) pair, each
-- guarded by a CASE that yields NULL unless that pair was asked for. Every row
-- ties on the fifteen clauses that were not selected, so ordering falls through
-- to the one that was, and then to the name for determinism.
--
-- It is verbose, and it is the price of not building this string with format()
-- and executing it. p_sort and p_dir arrive from a URL.
--
-- total_count rides along on every row rather than needing a second count query:
-- the window is computed before the limit, so the pager knows how many pages
-- there are from the same request that fetched the page.
create or replace function public.admin_list_users(
  p_query  text    default null,
  p_sort   text    default 'last_active',
  p_dir    text    default 'desc',
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  user_id            text,
  display_name       text,
  image_url          text,
  lists         bigint,
  owned_lists   bigint,
  moderator_of       bigint,
  items_added        bigint,
  items_open         bigint,
  purchases          bigint,
  products_added     bigint,
  first_seen         timestamptz,
  last_active        timestamptz,
  is_admin           boolean,
  total_count        bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dir   text    := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_sort  text    := coalesce(p_sort, 'last_active');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
begin
  perform public.admin_guard();

  return query
  with matched as (
    select f.*, (a.user_id is not null) as is_admin
    from public.admin_user_facts() f
    left join public.admin_users a on a.user_id = f.user_id
    where p_query is null
       or btrim(p_query) = ''
       or f.display_name ilike '%' || btrim(p_query) || '%'
       or f.user_id      ilike '%' || btrim(p_query) || '%'
  )
  select
    m.user_id, m.display_name, m.image_url,
    m.lists, m.owned_lists, m.moderator_of,
    m.items_added, m.items_open, m.purchases, m.products_added,
    m.first_seen, m.last_active, m.is_admin,
    count(*) over () as total_count
  from matched m
  order by
    case when v_sort = 'display_name' and v_dir = 'asc'  then lower(m.display_name) end asc  nulls last,
    case when v_sort = 'display_name' and v_dir = 'desc' then lower(m.display_name) end desc nulls last,
    case when v_sort = 'lists'   and v_dir = 'asc'  then m.lists   end asc  nulls last,
    case when v_sort = 'lists'   and v_dir = 'desc' then m.lists   end desc nulls last,
    case when v_sort = 'items_added'  and v_dir = 'asc'  then m.items_added  end asc  nulls last,
    case when v_sort = 'items_added'  and v_dir = 'desc' then m.items_added  end desc nulls last,
    case when v_sort = 'purchases'    and v_dir = 'asc'  then m.purchases    end asc  nulls last,
    case when v_sort = 'purchases'    and v_dir = 'desc' then m.purchases    end desc nulls last,
    case when v_sort = 'first_seen'   and v_dir = 'asc'  then m.first_seen   end asc  nulls last,
    case when v_sort = 'first_seen'   and v_dir = 'desc' then m.first_seen   end desc nulls last,
    case when v_sort = 'last_active'  and v_dir = 'asc'  then m.last_active  end asc  nulls last,
    case when v_sort = 'last_active'  and v_dir = 'desc' then m.last_active  end desc nulls last,
    lower(m.display_name) asc, m.user_id asc
  limit v_limit
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_list_users(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_users(text, text, text, integer, integer) to authenticated;

-- ─── one user ────────────────────────────────────────────────────────────────
create or replace function public.admin_user_detail(p_user_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'profile', to_jsonb(f),
    'is_admin', exists (select 1 from public.admin_users a where a.user_id = p_user_id),
    -- Why this account is refused, for the page that says it is.
    --
    -- profiles.banned_at is the flag and carries nothing else; the reason and
    -- the admin who gave it live in the audit trail and nowhere else, because
    -- admin_ban_user() records them there. So a profile page could say
    -- "Suspended" and could not say why -- the one question that state raises.
    -- admin_banned_users() already reaches for this; the Users list and this
    -- page now give the same answer rather than only the list having it.
    --
    -- Null when the flag is set but no event explains it: a ban applied
    -- straight against the table, or one whose audit row aged out. The view
    -- says that in words rather than rendering an empty reason, because a blank
    -- where a reason should be reads as a failed lookup.
    --
    -- Newest event wins. A ban lifted and given again is described by the
    -- second one, which is the one banned_at is talking about.
    'ban', case when f.banned_at is null then null else (
      select jsonb_build_object(
        'reason',       e.detail->>'reason',
        'by',           e.detail->>'actor',
        'by_name',      b.display_name,
        'by_image_url', b.image_url,
        'at',           e.created_at
      )
      from public.security_events e
      left join public.profiles b on b.user_id = e.detail->>'actor'
      where e.kind = 'admin_user_banned'
        and e.detail->>'target' = p_user_id
      order by e.created_at desc
      limit 1
    ) end,
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          hh.id,
        'name',        hh.name,
        'emoji',       hh.emoji,
        'role',        hm.role,
        'is_owner',    hh.created_by = p_user_id,
        'joined_at',   hm.joined_at,
        'members',     (select count(*) from public.list_members x where x.list_id = hh.id),
        'items_open',  (select count(*) from public.shopping_list_items x
                          where x.list_id = hh.id and not x.checked),
        -- Withdrawn lists stay in this list rather than being filtered out
        -- of it. The membership is real, the profile's list COUNT above
        -- already leaves it out, and hiding the row would take away the only
        -- route to the list from the person it belonged to.
        'deleted_at',  hh.deleted_at
      ) order by hh.deleted_at is not null, hm.joined_at)
      from public.list_members hm
      join public.lists hh on hh.id = hm.list_id
      where hm.user_id = p_user_id
    ), '[]'::jsonb),
    -- What this account actually buys, which is the closest thing to a taste
    -- profile that exists without recording searches.
    'top_products', coalesce((
      select jsonb_agg(t order by t.times desc, t.name)
      from (
        select ph.name, ph.maker, count(*) as times, sum(ph.quantity) as quantity,
               max(ph.purchased_at) as last_bought
        from public.purchase_history ph
        where ph.added_by = p_user_id
        group by ph.name, ph.maker
        order by count(*) desc, ph.name
        limit 12
      ) t
    ), '[]'::jsonb),
    'recent_events', coalesce((
      select jsonb_agg(t order by t.created_at desc)
      from (
        select se.created_at, se.kind, se.list_id, se.detail
        from public.security_events se
        where se.actor = p_user_id
        order by se.created_at desc
        limit 20
      ) t
    ), '[]'::jsonb)
  )
  into v_result
  from public.admin_user_facts() f
  where f.user_id = p_user_id;

  return v_result;   -- null when no such profile; the dashboard renders a 404 state
end;
$$;

revoke all on function public.admin_user_detail(text) from public, anon;
grant execute on function public.admin_user_detail(text) to authenticated;

-- ─── the lists ────────────────────────────────────────────────────────────────
create or replace function public.admin_lists(
  p_query  text    default null,
  p_sort   text    default 'last_active',
  p_dir    text    default 'desc',
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id             uuid,
  name           text,
  emoji          text,
  invite_code    text,
  created_by     text,
  owner_name     text,
  owner_image_url text,
  created_at     timestamptz,
  members        bigint,
  moderators     bigint,
  items_total    bigint,
  items_open     bigint,
  purchases      bigint,
  checkouts      bigint,
  products_added bigint,
  last_active    timestamptz,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dir   text    := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_sort  text    := coalesce(p_sort, 'last_active');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
begin
  perform public.admin_guard();

  return query
  with matched as (
    select f.* from public.admin_list_facts() f
    where f.deleted_at is null
      and (p_query is null
        or btrim(p_query) = ''
        or f.name        ilike '%' || btrim(p_query) || '%'
        or f.invite_code ilike '%' || btrim(p_query) || '%'
        or f.owner_name  ilike '%' || btrim(p_query) || '%')
  )
  select
    m.id, m.name, m.emoji, m.invite_code, m.created_by, m.owner_name, m.owner_image_url,
    m.created_at,
    m.members, m.moderators, m.items_total, m.items_open,
    m.purchases, m.checkouts, m.products_added, m.last_active,
    count(*) over () as total_count
  from matched m
  order by
    case when v_sort = 'name'        and v_dir = 'asc'  then lower(m.name)  end asc  nulls last,
    case when v_sort = 'name'        and v_dir = 'desc' then lower(m.name)  end desc nulls last,
    case when v_sort = 'members'     and v_dir = 'asc'  then m.members      end asc  nulls last,
    case when v_sort = 'members'     and v_dir = 'desc' then m.members      end desc nulls last,
    case when v_sort = 'items_open'  and v_dir = 'asc'  then m.items_open   end asc  nulls last,
    case when v_sort = 'items_open'  and v_dir = 'desc' then m.items_open   end desc nulls last,
    case when v_sort = 'purchases'   and v_dir = 'asc'  then m.purchases    end asc  nulls last,
    case when v_sort = 'purchases'   and v_dir = 'desc' then m.purchases    end desc nulls last,
    case when v_sort = 'created_at'  and v_dir = 'asc'  then m.created_at   end asc  nulls last,
    case when v_sort = 'created_at'  and v_dir = 'desc' then m.created_at   end desc nulls last,
    case when v_sort = 'last_active' and v_dir = 'asc'  then m.last_active  end asc  nulls last,
    case when v_sort = 'last_active' and v_dir = 'desc' then m.last_active  end desc nulls last,
    lower(m.name) asc, m.id asc
  limit v_limit
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_lists(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_lists(text, text, text, integer, integer) to authenticated;

-- ─── one list ───────────────────────────────────────────────────────────
create or replace function public.admin_list_detail(p_list_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'list', to_jsonb(f),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id',      hm.user_id,
        'display_name', p.display_name,
        'image_url',    p.image_url,
        'role',         hm.role,
        'is_owner',     hm.user_id = f.created_by,
        'joined_at',    hm.joined_at,
        'items_open',   (select count(*) from public.shopping_list_items x
                           where x.list_id = f.id and x.added_by = hm.user_id and not x.checked),
        'items_added',  (select count(*) from public.shopping_list_items x
                           where x.list_id = f.id and x.added_by = hm.user_id),
        'purchases',    (select count(*) from public.purchase_history x
                           where x.list_id = f.id and x.purchased_by = hm.user_id)
      ) order by (hm.user_id = f.created_by) desc, hm.joined_at)
      from public.list_members hm
      left join public.profiles p on p.user_id = hm.user_id
      where hm.list_id = f.id
    ), '[]'::jsonb),
    -- The items on the list. This key was `list` while the entity was called a
    -- household; after the rename that collided with the `list` key above, and
    -- jsonb keeps the last duplicate, so the entity silently vanished.
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         si.id,
        'name',       si.name,
        'maker',      si.maker,
        'quantity',   si.quantity,
        'checked',    si.checked,
        'checked_at', si.checked_at,
        'added_by',   si.added_by,
        'added_by_name', p.display_name,
        'added_by_image_url', p.image_url,
        'created_at', si.created_at
      ) order by si.checked, si.created_at desc)
      from public.shopping_list_items si
      left join public.profiles p on p.user_id = si.added_by
      where si.list_id = f.id
    ), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(t order by t.times desc, t.name)
      from (
        select ph.name, ph.maker, count(*) as times, sum(ph.quantity) as quantity,
               max(ph.purchased_at) as last_bought
        from public.purchase_history ph
        where ph.list_id = f.id
        group by ph.name, ph.maker
        order by count(*) desc, ph.name
        limit 15
      ) t
    ), '[]'::jsonb),
    'contributed_products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pc.id, 'name', pc.name, 'maker', pc.maker, 'barcode', pc.barcode,
        'add_count', pc.add_count, 'created_at', pc.created_at,
        'contributed_by', pc.contributed_by,
        'contributed_by_name', p.display_name,
        'contributed_by_image_url', p.image_url
      ) order by pc.created_at desc)
      from public.product_catalog pc
      left join public.profiles p on p.user_id = pc.contributed_by
      where pc.list_id = f.id
    ), '[]'::jsonb),
    'recent_checkouts', coalesce((
      select jsonb_agg(t order by t.purchased_at desc)
      from (
        select ph.checkout_id, max(ph.purchased_at) as purchased_at,
               ph.purchased_by,
               max(p.display_name) as purchased_by_name,
               max(p.image_url)    as purchased_by_image_url,
               count(*) as items, sum(ph.quantity) as quantity
        from public.purchase_history ph
        left join public.profiles p on p.user_id = ph.purchased_by
        where ph.list_id = f.id
        group by ph.checkout_id, ph.purchased_by
        order by max(ph.purchased_at) desc
        limit 15
      ) t
    ), '[]'::jsonb)
  )
  into v_result
  from public.admin_list_facts() f
  where f.id = p_list_id;

  return v_result;
end;
$$;

revoke all on function public.admin_list_detail(uuid) from public, anon;
grant execute on function public.admin_list_detail(uuid) to authenticated;

-- ─── the app database's own catalog rows ─────────────────────────────────────
-- Not the same table as the catalog project's, and the dashboard shows them side
-- by side precisely because that is the confusing part. These are the rows a
-- list contributed through add_custom_product(), plus anything promoted out
-- of them; the imported reference rows live in the other project entirely.
create or replace function public.admin_local_products(
  p_query  text    default null,
  p_source text    default null,
  p_scope  text    default 'all',      -- all | community | promoted
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id              uuid,
  name            text,
  maker           text,
  barcode         text,
  source          text,
  source_version  text,
  list_id    uuid,
  list_name  text,
  contributed_by  text,
  contributor_name text,
  contributor_image_url text,
  base_weight     integer,
  add_count       integer,
  popularity      integer,
  created_at      timestamptz,
  total_count     bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
begin
  perform public.admin_guard();

  if coalesce(p_scope, 'all') not in ('all', 'community', 'promoted') then
    raise exception 'admin_local_products: p_scope must be all, community or promoted, got %', p_scope;
  end if;

  return query
  with matched as (
    select pc.*
    from public.product_catalog pc
    where (p_query is null or btrim(p_query) = ''
           or pc.name ilike '%' || btrim(p_query) || '%'
           or pc.maker ilike '%' || btrim(p_query) || '%'
           or pc.barcode = btrim(p_query))
      and (p_source is null or pc.source = p_source)
      and (coalesce(p_scope, 'all') = 'all'
           or (p_scope = 'community' and pc.list_id is not null)
           or (p_scope = 'promoted'  and pc.list_id is null))
  )
  select
    m.id, m.name, m.maker, m.barcode, m.source, m.source_version,
    m.list_id, hh.name as list_name,
    m.contributed_by, p.display_name as contributor_name, p.image_url as contributor_image_url,
    m.base_weight, m.add_count, m.popularity, m.created_at,
    count(*) over () as total_count
  from matched m
  left join public.lists hh on hh.id = m.list_id
  left join public.profiles p on p.user_id = m.contributed_by
  order by m.popularity desc, m.created_at desc
  limit v_limit
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_local_products(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_local_products(text, text, text, integer, integer) to authenticated;

-- ─── writing to them ─────────────────────────────────────────────────────────
-- WHY THERE ARE RPCs HERE AT ALL
--
-- product_catalog has exactly one RLS policy and it is a SELECT. There is no
-- insert, update or delete policy, deliberately: every write in 006 goes through
-- a `security definer` function that owns a rule -- add_custom_product() counts a
-- list's contributions against a ceiling, promote_product_from_scoped()
-- waits for three distinct accounts in three distinct lists. A dashboard
-- cannot write this table directly and should not be able to.
--
-- It also could not compute what it would need to write. search_text is derived
-- by product_search_text(), whose EXECUTE is revoked from `authenticated` on
-- purpose (006 line 261): a client that can compute the merge key can craft a
-- name that collides with an existing product. So the derivation has to happen
-- on this side of the boundary regardless.
--
-- WHAT AN ADMIN MAY NOT DO, AND WHY
--
-- add_count is never writable here. It is earned usage -- the count of real adds
-- by real lists -- and it is half of the generated `popularity` column. An
-- admin who could set it could manufacture the appearance of demand, and the
-- promotion gate in 006 reads the same signal. base_weight is the editorial
-- thumb on the scale and is the correct knob; it is what the seed uses and what
-- these functions expose.
--
-- Nor may an admin create a list-scoped row. Scoped rows record that a
-- specific list asked for something, and one invented from this dashboard
-- would be a contribution nobody made, counting toward a promotion nobody
-- requested. Admin-created rows are global and curated, which is what they are.
--
-- DELETING IS SAFE, WHICH IS WORTH STATING
--
-- Nothing in this schema has a foreign key to product_catalog, and
-- shopping_list_items store `name` and `maker` as plain text (004). Removing a
-- product therefore removes a SUGGESTION and never touches anybody's list. That
-- is why this is an ordinary delete rather than another soft-delete column.

-- ─── create ──────────────────────────────────────────────────────────────────
-- Global and curated. Returns the new id so the dashboard can select the row it
-- just made rather than re-searching for it.
create or replace function public.admin_create_product(
  p_name        text,
  p_maker       text default null,
  p_barcode     text default null,
  p_base_weight integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_maker   text := nullif(btrim(coalesce(p_maker, '')), '');
  v_barcode text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_search  text;
  v_id      uuid;
begin
  perform public.admin_guard();

  -- Raised rather than returned as null. add_custom_product() returns quietly on
  -- bad input because it runs behind a keyboard and a silent no-op is kinder
  -- than an error mid-typing; this runs behind a form that can show a message,
  -- and a create that silently does nothing is the worst of both.
  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if v_maker is not null and char_length(v_maker) > 60 then
    raise exception 'A brand must be at most 60 characters.'
      using errcode = 'P0001', detail = 'bad_maker';
  end if;

  if coalesce(p_base_weight, 0) < 0 then
    raise exception 'Base weight cannot be negative.'
      using errcode = 'P0001', detail = 'bad_base_weight';
  end if;

  v_search := public.product_search_text(v_name, v_maker);
  if v_search = '' or char_length(v_search) > 200 then
    raise exception 'That name and brand do not reduce to a usable search key.'
      using errcode = 'P0001', detail = 'bad_search_text';
  end if;

  -- The same lock add_custom_product() takes, for the same reason: a concurrent
  -- promotion can insert a global row for this key between the check below and
  -- the insert.
  perform pg_advisory_xact_lock(hashtext(v_search));

  -- Checked rather than caught as a 23505, because the constraint names an index
  -- and this names the situation. Two different collisions are possible and they
  -- need different sentences.
  if exists (
    select 1 from public.product_catalog
    where list_id is null and search_text = v_search
  ) then
    raise exception 'A product with that name and brand already exists.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  if v_barcode is not null and exists (
    select 1 from public.product_catalog
    where list_id is null and barcode = v_barcode
  ) then
    raise exception 'Another product already claims that barcode.'
      using errcode = 'P0001', detail = 'duplicate_barcode';
  end if;

  insert into public.product_catalog
    (name, maker, search_text, list_id, contributed_by,
     base_weight, add_count, source, barcode)
  values
    (v_name, v_maker, v_search, null, null,
     greatest(coalesce(p_base_weight, 0), 0), 0, 'curated', v_barcode)
  returning id into v_id;

  perform public.log_security_event(
    'admin_product_created',
    null,
    jsonb_build_object(
      'actor', requesting_user_id(),
      'product', v_id,
      'name', v_name,
      'maker', v_maker
    )
  );

  return v_id;
end;
$$;

comment on function public.admin_create_product(text, text, text, integer) is
  'Add a global curated product. Admin only. add_count is not writable: it is '
  'earned usage and half of the generated popularity column.';

revoke all on function public.admin_create_product(text, text, text, integer)
  from public, anon;
grant execute on function public.admin_create_product(text, text, text, integer)
  to authenticated;

-- ─── update ──────────────────────────────────────────────────────────────────
-- Any row, scoped or global. Correcting a list's typo is a real job and
-- refusing it would send an admin to delete-and-recreate, which loses the row's
-- earned add_count and its contributed_by.
create or replace function public.admin_update_product(
  p_id          uuid,
  p_name        text,
  p_maker       text default null,
  p_barcode     text default null,
  p_base_weight integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text := btrim(coalesce(p_name, ''));
  v_maker    text := nullif(btrim(coalesce(p_maker, '')), '');
  v_barcode  text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_search   text;
  v_row      public.product_catalog%rowtype;
begin
  perform public.admin_guard();

  select * into v_row from public.product_catalog where id = p_id;
  if not found then
    raise exception 'That product no longer exists.'
      using errcode = 'P0001', detail = 'not_found';
  end if;

  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if v_maker is not null and char_length(v_maker) > 60 then
    raise exception 'A brand must be at most 60 characters.'
      using errcode = 'P0001', detail = 'bad_maker';
  end if;

  if coalesce(p_base_weight, v_row.base_weight) < 0 then
    raise exception 'Base weight cannot be negative.'
      using errcode = 'P0001', detail = 'bad_base_weight';
  end if;

  v_search := public.product_search_text(v_name, v_maker);
  if v_search = '' or char_length(v_search) > 200 then
    raise exception 'That name and brand do not reduce to a usable search key.'
      using errcode = 'P0001', detail = 'bad_search_text';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_search));

  -- Collision checks exclude this row, or renaming a product to a different
  -- capitalisation of its own name would report itself as a duplicate. The
  -- scoped and global keys are two different unique indexes, so which one to
  -- check follows the row being edited.
  if v_row.list_id is null then
    if exists (
      select 1 from public.product_catalog
      where list_id is null and search_text = v_search and id <> p_id
    ) then
      raise exception 'Another product already has that name and brand.'
        using errcode = 'P0001', detail = 'duplicate_name';
    end if;

    if v_barcode is not null and exists (
      select 1 from public.product_catalog
      where list_id is null and barcode = v_barcode and id <> p_id
    ) then
      raise exception 'Another product already claims that barcode.'
        using errcode = 'P0001', detail = 'duplicate_barcode';
    end if;
  else
    if exists (
      select 1 from public.product_catalog
      where list_id = v_row.list_id and search_text = v_search and id <> p_id
    ) then
      raise exception 'That list already has a product with that name and brand.'
        using errcode = 'P0001', detail = 'duplicate_name';
    end if;
  end if;

  -- add_count, contributed_by, list_id and source are all left alone. The
  -- first is earned, the second and third are a record of who asked for this and
  -- cannot be edited into being true, and the fourth is a licensing fact.
  update public.product_catalog
  set name        = v_name,
      maker       = v_maker,
      search_text = v_search,
      barcode     = v_barcode,
      base_weight = greatest(coalesce(p_base_weight, base_weight), 0)
  where id = p_id;

  perform public.log_security_event(
    'admin_product_updated',
    v_row.list_id,
    jsonb_build_object(
      'actor', requesting_user_id(),
      'product', p_id,
      'from', jsonb_build_object('name', v_row.name, 'maker', v_row.maker),
      'to', jsonb_build_object('name', v_name, 'maker', v_maker)
    )
  );
end;
$$;

comment on function public.admin_update_product(uuid, text, text, text, integer) is
  'Correct a product in place, scoped or global. Admin only. Leaves add_count, '
  'contributed_by, list_id and source untouched.';

revoke all on function public.admin_update_product(uuid, text, text, text, integer)
  from public, anon;
grant execute on function public.admin_update_product(uuid, text, text, text, integer)
  to authenticated;

-- ─── delete ──────────────────────────────────────────────────────────────────
-- A hard delete, unlike lists. See the header: nothing references this
-- table and list items carry their own text, so this removes a suggestion and
-- nothing else. A soft delete would mean teaching every read path to filter, for
-- a row nobody can lose anything by.
create or replace function public.admin_delete_product(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.product_catalog%rowtype;
begin
  perform public.admin_guard();

  select * into v_row from public.product_catalog where id = p_id;

  -- Idempotent, matching admin_restore_list: a second click, or two admins
  -- on the same row, is not an error worth showing anybody.
  if not found then
    return;
  end if;

  delete from public.product_catalog where id = p_id;

  -- The whole row goes into the audit detail rather than just its id, because
  -- after this statement the id resolves to nothing and an entry saying only
  -- that a uuid was deleted answers no question anyone would later ask.
  perform public.log_security_event(
    'admin_product_deleted',
    v_row.list_id,
    jsonb_build_object(
      'actor', requesting_user_id(),
      'product', p_id,
      'name', v_row.name,
      'maker', v_row.maker,
      'barcode', v_row.barcode,
      'source', v_row.source,
      'add_count', v_row.add_count,
      'list_id', v_row.list_id,
      'contributed_by', v_row.contributed_by
    )
  );
end;
$$;

comment on function public.admin_delete_product(uuid) is
  'Remove a product from the app catalog. Admin only, idempotent, and a hard '
  'delete: nothing references this table and list items carry their own text.';

revoke all on function public.admin_delete_product(uuid) from public, anon;
grant execute on function public.admin_delete_product(uuid) to authenticated;

-- ─── the audit trail ─────────────────────────────────────────────────────────
-- security_events is the nearest thing this system has to an error stream, and
-- until now the only way to read it was the SQL editor or the digest poller's
-- login role. This is the third door and it is the narrowest: admins only, and
-- read only.
create or replace function public.admin_security_events(
  p_kind   text        default null,
  p_since  timestamptz default null,
  p_actor  text        default null,
  p_limit  integer     default 50,
  p_offset integer     default 0,
  -- Only what admins did (every admin_* kind). Health's audit trail reads this:
  -- what members do is their own business and, at scale, a firehose.
  p_admin_only boolean default false
)
returns table (
  id           bigint,
  created_at   timestamptz,
  kind         text,
  actor        text,
  actor_name   text,
  actor_image_url text,
  list_id uuid,
  list_name text,
  detail       jsonb,
  total_count  bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform public.admin_guard();

  return query
  with matched as (
    select se.*
    from public.security_events se
    where (p_kind  is null or se.kind = p_kind)
      and (not coalesce(p_admin_only, false) or se.kind like 'admin\_%')
      and (p_actor is null or se.actor = p_actor)
      and (p_since is null or se.created_at >= p_since)
  )
  select
    m.id, m.created_at, m.kind, m.actor, p.display_name, p.image_url,
    m.list_id, hh.name, m.detail,
    count(*) over () as total_count
  from matched m
  left join public.profiles p on p.user_id = m.actor
  left join public.lists hh on hh.id = m.list_id
  order by m.created_at desc, m.id desc
  limit v_limit
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_security_events(text, timestamptz, text, integer, integer, boolean) from public, anon;
grant execute on function public.admin_security_events(text, timestamptz, text, integer, integer, boolean) to authenticated;

-- The same shape security_digest() produces, but reachable by an admin rather
-- than only by service_role. Kept separate from that function rather than
-- widening its grant: the poller's contract should not change because a
-- dashboard wanted the numbers.
create or replace function public.admin_event_digest(p_since timestamptz default null)
returns table (
  kind            text,
  events          bigint,
  distinct_actors bigint,
  first_seen      timestamptz,
  last_seen       timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select e.kind, count(*), count(distinct e.actor), min(e.created_at), max(e.created_at)
  from public.security_events e
  where e.created_at >= coalesce(p_since, now() - interval '7 days')
  group by e.kind
  order by count(*) desc, e.kind;
end;
$$;

revoke all on function public.admin_event_digest(timestamptz) from public, anon;
grant execute on function public.admin_event_digest(timestamptz) to authenticated;

-- ─── rate limiting, as it stands right now ───────────────────────────────────
-- Which buckets are currently filling. Anything near its ceiling is either
-- someone being throttled or a limit set too low, and the two look identical
-- from inside the app.
create or replace function public.admin_rate_limits(p_limit integer default 50)
returns table (
  actor        text,
  kind         text,
  window_start timestamptz,
  hits         integer,
  actor_name   text,
  actor_image_url text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    rl.actor,
    rl.kind,
    rl.window_start,
    rl.hits,
    -- Resolved where the actor happens to be a Clerk user id with a profile.
    -- rate_limit_hit() is also called on paths with no session, where the actor
    -- is not an account at all, so a null name and a null photo here are normal
    -- rather than a missing join.
    p.display_name,
    p.image_url
  from public.rate_limit_counters rl
  left join public.profiles p on p.user_id = rl.actor
  order by rl.window_start desc, rl.hits desc
  limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

revoke all on function public.admin_rate_limits(integer) from public, anon;
grant execute on function public.admin_rate_limits(integer) to authenticated;

-- ─── database health ─────────────────────────────────────────────────────────
-- What the server itself will say about its condition. Row estimates come from
-- the planner's statistics rather than count(*) on purpose: this is a health
-- panel that should stay cheap however large the tables get, and "about this
-- many" is the right precision for it. The exact counts are in admin_overview().
create or replace function public.admin_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'server_time',   now(),
    'server_version', current_setting('server_version'),
    'database',      current_database(),
    'database_size', pg_database_size(current_database()),
    'connections', jsonb_build_object(
      'total',  (select count(*) from pg_stat_activity where datname = current_database()),
      'active', (select count(*) from pg_stat_activity
                  where datname = current_database() and state = 'active'),
      'idle_in_transaction',
                (select count(*) from pg_stat_activity
                  where datname = current_database() and state = 'idle in transaction'),
      'max',    current_setting('max_connections')
    ),
    'tables', coalesce((
      select jsonb_agg(t order by t.total_bytes desc)
      from (
        select
          c.relname                                   as table_name,
          s.n_live_tup                                as live_rows,
          s.n_dead_tup                                as dead_rows,
          pg_total_relation_size(c.oid)               as total_bytes,
          pg_relation_size(c.oid)                     as heap_bytes,
          pg_indexes_size(c.oid)                      as index_bytes,
          greatest(s.last_autovacuum, s.last_vacuum)  as last_vacuum,
          greatest(s.last_autoanalyze, s.last_analyze) as last_analyze,
          s.seq_scan,
          s.idx_scan
        from pg_stat_user_tables s
        join pg_class c on c.oid = s.relid
        where s.schemaname = 'public'
      ) t
    ), '[]'::jsonb),
    -- Which migrations this database believes it has applied. The one fact that
    -- explains most "it works locally" reports, and it is invisible from the app.
    -- Guarded because a database built by `supabase db reset` in a bare test
    -- harness may not have the CLI's bookkeeping schema.
    'migrations', case
      when to_regclass('supabase_migrations.schema_migrations') is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(t order by t.version)
        from (
          select version, name from supabase_migrations.schema_migrations
        ) t
      ), '[]'::jsonb)
    end,
    -- Freshness: the newest row in each table that stamps a time. A table whose
    -- newest row is old is either quiet or broken, and the dashboard shows both
    -- so the reader can tell which.
    'freshness', jsonb_build_object(
      'lists',      (select max(created_at)   from public.lists),
      'list_members', (select max(joined_at)  from public.list_members),
      'shopping_list_items', (select max(created_at) from public.shopping_list_items),
      'purchase_history', (select max(purchased_at) from public.purchase_history),
      'product_catalog', (select max(created_at)   from public.product_catalog),
      'security_events', (select max(created_at)   from public.security_events),
      'profiles',        (select max(updated_at)   from public.profiles)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_health() from public, anon;
grant execute on function public.admin_health() to authenticated;

-- ─── the only two writes ─────────────────────────────────────────────────────
-- Granting and revoking admin. Both audited through the existing
-- log_security_event(), so the admin list has a history even though the table
-- itself only holds the present.
--
-- BOOTSTRAPPING. There is no admin yet on a fresh database, so neither of these
-- can be called. The first row goes in by hand, with the service role, from the
-- Supabase SQL editor:
--
--   insert into public.admin_users (user_id, note)
--   values ('user_xxxxxxxxxxxxxxxxxxxxxxxxx', 'owner')
--   on conflict (user_id) do nothing;
--
-- That is deliberately not automated. A migration that inserts a hardcoded Clerk
-- id would put a real account identifier in a public repo and would grant it on
-- every database this file is ever run against, including a contributor's local
-- one.
create or replace function public.admin_grant(p_user_id text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'admin_grant: p_user_id is required';
  end if;

  insert into public.admin_users (user_id, note, granted_by)
  values (btrim(p_user_id), nullif(btrim(coalesce(p_note, '')), ''), requesting_user_id())
  on conflict (user_id) do update
    set note = excluded.note;

  perform public.log_security_event(
    'admin_granted', null,
    jsonb_build_object('target', btrim(p_user_id))
  );
end;
$$;

revoke all on function public.admin_grant(text, text) from public, anon;
grant execute on function public.admin_grant(text, text) to authenticated;

-- Revoking your own admin is refused. Not because it would be a disaster -- the
-- bootstrap statement above always works -- but because it needs the service
-- role and the SQL editor to undo, and the person doing it is invariably about
-- to find that out at the worst moment.
create or replace function public.admin_revoke(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  if btrim(coalesce(p_user_id, '')) = requesting_user_id() then
    raise exception 'admin_revoke: refusing to revoke your own admin access'
      using errcode = '42501';
  end if;

  delete from public.admin_users where user_id = btrim(p_user_id);

  if found then
    perform public.log_security_event(
      'admin_revoked', null,
      jsonb_build_object('target', btrim(p_user_id))
    );
  end if;
end;
$$;

revoke all on function public.admin_revoke(text) from public, anon;
grant execute on function public.admin_revoke(text) to authenticated;

-- Who else holds this. Its own function rather than a column on admin_list_users
-- because the admin roster is short, is read on one screen, and includes people
-- who may have no profile row yet.
create or replace function public.admin_list_admins()
returns table (
  user_id      text,
  display_name text,
  image_url    text,
  note         text,
  granted_by   text,
  granted_by_name text,
  granted_by_image_url text,
  granted_at   timestamptz,
  is_self      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    a.user_id, p.display_name, p.image_url, a.note,
    a.granted_by, g.display_name, g.image_url, a.granted_at,
    a.user_id = requesting_user_id()
  from public.admin_users a
  left join public.profiles p on p.user_id = a.user_id
  left join public.profiles g on g.user_id = a.granted_by
  order by a.granted_at;
end;
$$;

revoke all on function public.admin_list_admins() from public, anon;
grant execute on function public.admin_list_admins() to authenticated;

-- ─── what search succeeded at, and what it missed ────────────────────────────
-- Both of these belong to the Search Analytics section, and both need saying
-- plainly: NEITHER IS A SEARCH LOG. Bagful records no searches at all --
-- search_catalog() is a stable function that selects rows and writes nothing, so
-- no query string, result count or timing exists in any of the three databases.
--
-- What these two return is the pair of things downstream of a search that ARE
-- recorded, and they are useful precisely because of which half of the funnel
-- each one sits in.

-- Demand the catalog served: what lists actually bought. Aggregated across
-- every list, so it is a product ranking rather than anyone's shopping
-- list, and `lists` is what separates one family's staple from a real
-- pattern.
--
-- Read from purchase_history rather than from shopping_list_items because a
-- checkout is a stronger signal than an add: an item added and deleted was a
-- mistake, an item bought was wanted.
create or replace function public.admin_top_purchases(
  p_since timestamptz default null,
  p_limit integer default 20
)
returns table (
  name        text,
  maker       text,
  times       bigint,
  quantity    bigint,
  lists  bigint,
  last_bought timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    ph.name,
    ph.maker,
    count(*)                            as times,
    sum(ph.quantity)::bigint            as quantity,
    count(distinct ph.list_id)     as lists,
    max(ph.purchased_at)                as last_bought
  from public.purchase_history ph
  where p_since is null or ph.purchased_at >= p_since
  group by ph.name, ph.maker
  order by count(*) desc, sum(ph.quantity) desc, ph.name
  limit greatest(coalesce(p_limit, 20), 1);
end;
$$;

revoke all on function public.admin_top_purchases(timestamptz, integer) from public, anon;
grant execute on function public.admin_top_purchases(timestamptz, integer) to authenticated;

-- The catalog's misses, and the closest thing to a zero-result report that
-- exists without recording searches.
--
-- WHY A CONTRIBUTED PRODUCT IS A FAILED SEARCH. add_custom_product() is what
-- runs when someone typed a name, the suggestions came back with nothing they
-- wanted, and they added it anyway. So every row here with a list_id is a
-- search that returned nothing AND that the person cared enough about to fix by
-- hand -- which is a narrower and more actionable set than a raw zero-result log,
-- though it is not the same thing and the dashboard says so.
--
-- Grouped on the normalized search key rather than on the raw name, so "Lapte
-- Zuzu" and "lapte zuzu " are one miss and not two. `lists` counts distinct
-- contributors, which is the same number the promotion gate measures: at three
-- distinct lists the scoped rows collapse into a global one, so a product
-- sitting at two is a gap about to close on its own.
create or replace function public.admin_catalog_misses(p_limit integer default 30)
returns table (
  name       text,
  maker      text,
  lists bigint,
  add_count  bigint,
  first_seen timestamptz,
  last_seen  timestamptz,
  promoted   boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    -- The longest spelling seen, on the grounds that the fuller name is the more
    -- useful one to read in a report about what to import.
    (array_agg(pc.name order by char_length(pc.name) desc))[1] as name,
    (array_agg(pc.maker order by char_length(coalesce(pc.maker, '')) desc))[1] as maker,
    count(distinct coalesce(pc.list_id::text, pc.contributed_by)) as lists,
    sum(pc.add_count)::bigint as add_count,
    min(pc.created_at) as first_seen,
    max(pc.created_at) as last_seen,
    -- True once a global row exists for the same key: the gap has closed and
    -- this is history rather than a request.
    bool_or(pc.list_id is null) as promoted
  from public.product_catalog pc
  where pc.source = 'community'
  group by pc.search_text
  order by count(distinct coalesce(pc.list_id::text, pc.contributed_by)) desc,
           sum(pc.add_count) desc,
           max(pc.created_at) desc
  limit greatest(coalesce(p_limit, 30), 1);
end;
$$;

revoke all on function public.admin_catalog_misses(integer) from public, anon;
grant execute on function public.admin_catalog_misses(integer) to authenticated;


-- ─── deletion and bans ───────────────────────────────────────────────────────
--
-- The only destructive-looking things this dashboard can do, and neither
-- destroys anything. A list is flagged and its contents disappear through
-- active_list_ids(); a person is flagged and the app stops letting them
-- in. Both reverse with one write.
--
-- That is what makes the audit rows below worth writing. A hard delete leaves a
-- security_events row pointing at a list that no longer exists; these point
-- at one that does, so "what did this remove?" stays an answerable question.

create or replace function public.admin_delete_list(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.lists
  set deleted_at = now()
  where id = p_id and deleted_at is null;

  -- Idempotent: already deleted, or no such list. A dashboard that
  -- double-submits should not produce two audit rows saying different times.
  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_list_deleted',
    p_id,
    jsonb_build_object('actor', requesting_user_id())
  );
end;
$$;

create or replace function public.admin_restore_list(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.lists
  set deleted_at = null
  where id = p_id and deleted_at is not null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_list_restored',
    p_id,
    jsonb_build_object('actor', requesting_user_id())
  );
end;
$$;

-- Deliberately does NOT touch list_members.
--
-- Ownership is list_members.role, not a column on lists, so deleting
-- a banned person's memberships deletes the list's admin -- ban the founder
-- of a one-person list and nobody can administer it. The upsert guard in
-- 003 already stops the person at the door, so the membership is inert. Removing
-- somebody from a list is a separate, explicit act, not a side effect.
create or replace function public.admin_ban_user(p_user_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.profiles
  set banned_at = now()
  where user_id = p_user_id and banned_at is null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_user_banned',
    null,
    jsonb_build_object(
      'actor', requesting_user_id(),
      'target', p_user_id,
      'reason', nullif(btrim(coalesce(p_reason, '')), '')
    )
  );
end;
$$;

create or replace function public.admin_unban_user(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.profiles
  set banned_at = null
  where user_id = p_user_id and banned_at is not null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_user_unbanned',
    null,
    jsonb_build_object('actor', requesting_user_id(), 'target', p_user_id)
  );
end;
$$;

-- Half of what the Bans view lists. The counts are of what is still inside,
-- which is the number that answers "is this safe to leave deleted?"
create or replace function public.admin_deleted_lists()
returns table (
  id          uuid,
  name        text,
  emoji       text,
  deleted_at  timestamptz,
  members     integer,
  items_total integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    h.id,
    h.name,
    h.emoji,
    h.deleted_at,
    (select count(*)::integer from public.list_members m where m.list_id = h.id),
    (select count(*)::integer from public.shopping_list_items i where i.list_id = h.id)
  from public.lists h
  where h.deleted_at is not null
  order by h.deleted_at desc;
end;
$$;

-- The other half of the Bans view: every account the app currently refuses.
--
-- Banning happens on one user's detail page, and until this existed it vanished
-- the instant it was done -- nothing anywhere listed who was banned, so auditing
-- it meant opening accounts one at a time and hoping you remembered which. That
-- is the same hole soft delete had before admin_deleted_lists(), and it
-- gets the same answer: a reversible action needs a list of what it has been
-- applied to, or "reversible" is a claim nobody can act on.
--
-- Read off admin_user_facts() rather than profiles directly, for the reason the
-- header of this file gives about the user list and the user detail page: the
-- list count beside a banned name is then the SAME number the Users list
-- shows for them, rather than a second query that agrees by coincidence.
--
-- ─── WHY THE REASON COMES OUT OF THE AUDIT TRAIL ────────────────────────────
--
-- admin_ban_user() takes a reason and writes it to security_events, not to the
-- profile. That was the right call -- a profile column would hold only the
-- latest of several bans, and the audit row has to exist regardless -- but it
-- means the reason has no home to read it from, so it is read back out of the
-- event: the newest admin_user_banned naming this account as its target.
--
-- Null is ordinary here and must not be rendered as an error. A ban may be
-- given with no reason at all (admin_ban_user nullifs a blank one), and the
-- events table is append-only but not eternal.
create or replace function public.admin_banned_users()
returns table (
  user_id      text,
  display_name text,
  image_url    text,
  banned_at    timestamptz,
  lists   bigint,
  reason       text,
  banned_by    text,
  -- The admin who gave it, resolved. The id alone is what the audit row holds,
  -- and an id is not something a reader recognises at a glance.
  banned_by_name text,
  banned_by_image_url text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select
    f.user_id,
    f.display_name,
    f.image_url,
    f.banned_at,
    f.lists,
    e.detail->>'reason'  as reason,
    e.detail->>'actor'   as banned_by,
    b.display_name       as banned_by_name,
    b.image_url          as banned_by_image_url
  from public.admin_user_facts() f
  -- Lateral rather than a group-by: one row per banned account, and the newest
  -- event wins. A ban that was lifted and given again reads as the second one,
  -- which is the one banned_at is describing.
  left join lateral (
    select s.detail
    from public.security_events s
    where s.kind = 'admin_user_banned'
      and s.detail->>'target' = f.user_id
    order by s.created_at desc
    limit 1
  ) e on true
  -- After the lateral, because it resolves the actor the lateral just found.
  left join public.profiles b on b.user_id = e.detail->>'actor'
  where f.banned_at is not null
  order by f.banned_at desc;
end;
$$;

revoke all on function public.admin_delete_list(uuid) from public, anon;
revoke all on function public.admin_restore_list(uuid) from public, anon;
revoke all on function public.admin_ban_user(text, text) from public, anon;
revoke all on function public.admin_unban_user(text) from public, anon;
revoke all on function public.admin_deleted_lists() from public, anon;
revoke all on function public.admin_banned_users() from public, anon;
grant execute on function public.admin_delete_list(uuid) to authenticated;
grant execute on function public.admin_restore_list(uuid) to authenticated;
grant execute on function public.admin_ban_user(text, text) to authenticated;
grant execute on function public.admin_unban_user(text) to authenticated;
grant execute on function public.admin_deleted_lists() to authenticated;
grant execute on function public.admin_banned_users() to authenticated;
