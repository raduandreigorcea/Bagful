-- ─── lists, members, and profiles ─────────────────────────────────────────
-- Who exists, who belongs to what, and who is allowed to change it.
--
-- Three tables, in dependency order: profiles (identity), lists (the group),
-- list_members (the join, which references both).
--
-- The permission model in one paragraph: a list has exactly one owner, the
-- account in lists.created_by, and it can never be reassigned. The owner may
-- rename the list, delete it, and grant or revoke the moderator rank.
-- Moderators may change operational settings and remove plain members. Everyone
-- else may read the roster and remove only themselves. Policies decide who may
-- touch a row; triggers decide which columns of it, because a policy cannot see
-- the difference between renaming a list and changing its owner.

-- ─── profiles ────────────────────────────────────────────────────────────────
-- One source of truth for member identity.
--
-- A user's Clerk display name and avatar is stored once, here, keyed by Clerk
-- user id. list_members and the active shopping list carry only the user id
-- and resolve name/avatar by joining this table, so a profile edit shows up
-- everywhere at once.
--
-- purchase_history (005) deliberately does NOT do this: it keeps its own
-- added_by_name / added_by_image_url columns, because history is an archive and
-- is meant to freeze who added an item and how they looked at the time. That is
-- a snapshot, not redundancy.
create table if not exists public.profiles (
  user_id      text        primary key,            -- Clerk user id
  display_name text        not null default 'Member',
  image_url    text,
  updated_at   timestamptz not null default now(),
  constraint profiles_display_name_length
    check (char_length(display_name) between 1 and 80),
  -- Clerk's image host only. An arbitrary scheme lets a member point an <img
  -- src> at a logging/beacon endpoint — but so does an arbitrary https HOST,
  -- which is what this check allowed for a while: every co-member's browser
  -- fetches whatever is here, handing the person who chose it their IP, device
  -- and viewing time. Clerk serves every avatar from img.clerk.com whatever the
  -- original source, so nothing legitimate is excluded. The client mirrors this
  -- in deriveProfileFields() (src/lib/userIdentity.ts), but this is the authority.
  constraint profiles_image_url_scheme
    check (
      image_url is null
      or (image_url ~ '^https://img\.clerk\.com/' and char_length(image_url) <= 2048)
    )
);

-- Restated as an explicit ALTER for the reason the lists block below spells
-- out at length: everything inside `create table if not exists` is skipped on a
-- database where the table already exists, which is every database this file has
-- run against more than once. The bound above therefore reaches new databases
-- only, and tightening it there alone would leave production accepting the
-- arbitrary https host this was changed to close.
alter table public.profiles drop constraint if exists profiles_image_url_scheme;
alter table public.profiles add constraint profiles_image_url_scheme
  check (
    image_url is null
    or (image_url ~ '^https://img\.clerk\.com/' and char_length(image_url) <= 2048)
  );

-- ─── a ban, which is not a delete ────────────────────────────────────────────
--
-- Deleting a profile row does not stick. The app upserts display_name and
-- image_url on every boot to keep them fresh (see the note above
-- join_list_with_code), so the row returns the moment that person opens
-- Bagful -- and their Clerk account, which this database cannot touch, is
-- what let them in. A delete here removes a row, not a person.
--
-- So the row stays and the upsert refuses to revive it. The person can still
-- sign into Clerk; Bagful turns them away. See the banned_at guard in the two
-- profile upserts below.
alter table public.profiles
  add column if not exists banned_at timestamptz;

comment on column public.profiles.banned_at is
  'When an admin barred this account from the app. Null means allowed. The profile upserts raise when it is set, so the person can still sign into Clerk but Bagful refuses them.';

alter table public.profiles enable row level security;

-- ─── lists ────────────────────────────────────────────────────────────────
-- The client mirrors these caps in src/lib/limits.ts so the UI can refuse early,
-- but every value here is the authority.
create table if not exists public.lists (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  invite_code text        not null unique,
  created_by  text        not null,   -- Clerk user ID; the owner, permanently
  -- How many active items each member of this list may hold. Owner- and
  -- moderator-configurable.
  max_items_per_member integer not null default 50,
  -- Optional emoji identifying the list in the switcher. Capped generously
  -- enough for one multi-codepoint emoji (flags, ZWJ family sequences).
  emoji       text,
  created_at  timestamptz not null default now(),
  constraint lists_name_length_check
    check (char_length(btrim(name)) between 1 and 25),
  -- Mirrors the generator and validator in src/lib/inviteCode.ts. The alphabet
  -- omits I, O, 0 and 1 because the code gets read aloud and typed by hand.
  constraint lists_invite_code_format_check
    check (invite_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  constraint lists_max_items_per_member_check
    check (max_items_per_member between 1 and 50),
  constraint lists_emoji_length_check
    check (emoji is null or char_length(emoji) <= 16)
);

-- ─── bounds that have to be restated ─────────────────────────────────────────
-- Everything inside `create table if not exists` above applies only when the
-- table is created. On a database where lists already exists — which is every
-- database this file has run against more than once — that whole block is
-- skipped, so changing a bound here never reaches it.
--
-- That is not hypothetical. Production allowed 40-character list names while
-- this file said 25, and re-running the file could not converge it: the server
-- was quietly more permissive than both this schema and the client, which caps
-- the form at LIST_NAME_MAX_LENGTH (src/lib/limits.ts). A hand-crafted request
-- could set a name longer than anything the UI is built to show.
--
-- Restating the bound as an explicit ALTER is what makes re-running this file
-- actually converge it. Only this constraint is restated, because only this one
-- has drifted — but any bound in the block above needs the same treatment the
-- day it changes, or it will silently apply to new databases only.
alter table public.lists drop constraint if exists lists_name_length_check;
alter table public.lists add constraint lists_name_length_check
  check (char_length(btrim(name)) between 1 and 25);

-- ─── soft delete ─────────────────────────────────────────────────────────────
--
-- Null means live. An admin sets it; everything inside the list then
-- disappears through active_list_ids() below, and admin_restore_list()
-- puts it back. Nothing is destroyed, which is the whole point: the cascade
-- from this table reaches members, list items, purchase history and contributed
-- products, so a hard delete is a family's entire history gone on one click.
--
-- Declared out here rather than in the create-table block above for the reason
-- that block's own comment gives at length.
alter table public.lists
  add column if not exists deleted_at timestamptz;

comment on column public.lists.deleted_at is
  'When an admin soft-deleted this list. Null means live. Its contents are hidden through active_list_ids(); nothing is destroyed and admin_restore_list() reverses it.';

-- Partial: the only query that wants the non-null side is the dashboard Trash
-- view, and every live row has null here.
create index if not exists lists_deleted_at
  on public.lists (deleted_at) where deleted_at is not null;

alter table public.lists enable row level security;

-- One list owned per account. A unique index rather than a policy check, so
-- two concurrent inserts cannot both slip past it. Joining another list is
-- unaffected: this caps ownership, not membership.
--
-- SUPERSEDED BY 009, which makes this index partial on `deleted_at is null`.
-- The version below is what a fresh database builds first; 009 replaces it a
-- moment later, and an existing database gets the replacement on its own.
--
-- The original reasoning was that a soft delete should NOT free the slot: a
-- partial index would let the owner create a replacement while the original sat
-- in the trash, and restoring it would then violate the index and fail, so
-- holding the slot kept undo unconditional.
--
-- What that missed is what it cost the owner. Nothing purges lists, so the
-- slot was held forever -- and the SELECT policy below hides deleted rows, so
-- the owner was permanently unable to create a list, blocked by a row they
-- could not see, and told to delete the thing that had already been deleted.
-- That is a silent ban on someone whose list was moderated rather than on
-- someone who was; profiles.banned_at is what bans an account. 009 has the
-- full argument.
create unique index if not exists lists_one_per_owner
  on public.lists (created_by);

-- ─── list_members ──────────────────────────────────────────────────────────
create table if not exists public.list_members (
  id        uuid        primary key default gen_random_uuid(),
  list_id uuid        not null references public.lists(id) on delete cascade,
  -- FK to profiles so PostgREST can embed profiles(...) in the roster query, and
  -- so every member is guaranteed to have identity to render. Named explicitly
  -- rather than left to Postgres: PostgREST resolves an embed by constraint, and
  -- the disambiguating hint syntax (profiles!<constraint>) names it directly, so
  -- the name is part of the API surface rather than an implementation detail.
  user_id   text        not null
              constraint list_members_user_id_profiles_fkey
              references public.profiles(user_id),
  -- 'admin' is a legacy spelling of 'moderator' that predates the rename. It
  -- cannot occur on a database created from these migrations, and is kept in the
  -- constraint only so the rank set matches what normalizeMemberRole()
  -- (src/lib/memberRoles.ts) still defensively accepts. Narrowing it would be a
  -- behaviour change, not a cleanup.
  role      text        not null default 'member'
              check (role in ('admin', 'moderator', 'member')),
  joined_at timestamptz not null default now(),
  unique (list_id, user_id)
);

alter table public.list_members enable row level security;

-- Every roster read and every is_member_of_list() call filters on list_id.
create index if not exists idx_list_members_list_id
  on public.list_members (list_id);

-- ─── policy helpers ──────────────────────────────────────────────────────────
-- All three are SECURITY DEFINER on purpose. A policy on list_members that
-- subqueries list_members recurses into that table's own SELECT policy, which
-- only exposes the requester's own rows — so the check would answer the wrong
-- question. Running as the owner sidesteps RLS for the lookup itself while the
-- policy above it still decides what the caller sees.

create or replace function public.is_member_of_list(target_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.list_members fm
    join public.lists h on h.id = fm.list_id
    where fm.list_id = target_list_id
      and fm.user_id = requesting_user_id()
      -- The tenth site, and the one an audit for the inlined subquery misses:
      -- this helper does the same job through a different shape, so the policy
      -- that calls it never mentions list_members at all. Without the join
      -- a deleted list still hands its members the roster -- everything
      -- else about it hidden, and "who else is in here" still readable.
      and h.deleted_at is null
  );
$$;

grant execute on function public.is_member_of_list(uuid) to anon, authenticated;

create or replace function public.is_list_owner_or_moderator(target_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.lists f
    where f.id = target_list_id
      and (
        f.created_by = requesting_user_id()
        or exists (
          select 1
          from public.list_members fm
          where fm.list_id = target_list_id
            and fm.user_id = requesting_user_id()
            and fm.role in ('admin', 'moderator')
        )
      )
  );
$$;

grant execute on function public.is_list_owner_or_moderator(uuid) to anon, authenticated;

-- Co-membership, for the profiles read policy: may I see this person's avatar?
create or replace function public.shares_list_with(target_user_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.list_members me
    join public.list_members them on them.list_id = me.list_id
    where me.user_id = requesting_user_id()
      and them.user_id = target_user_id
  );
$$;

grant execute on function public.shares_list_with(text) to authenticated;

-- ─── which lists the caller is actually in ──────────────────────────────
--
-- Eight policy sites across 003-006 each inlined the same subquery: the
-- list_ids this user is a member of. One of them wrote it with an alias, so
-- a grep for the exact text found seven. Eight copies of one rule is how the
-- rule drifts.
--
-- It matters more than tidiness now. Soft delete needs every one of those sites
-- to also exclude deleted lists, and missing one fails SILENTLY: the app
-- keeps serving rows from a list an admin believes they removed, with no
-- error anywhere to notice. One definition called from eight places cannot be
-- half-applied.
--
-- security definer because it reads lists and list_members from inside
-- a policy on those same tables, where the caller's own RLS would otherwise
-- recurse. search_path pinned for the usual reason.
create or replace function public.active_list_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select hm.list_id
  from public.list_members hm
  join public.lists h on h.id = hm.list_id
  where hm.user_id = requesting_user_id()
    and h.deleted_at is null
$$;

revoke all on function public.active_list_ids() from public, anon;
grant execute on function public.active_list_ids() to authenticated;

-- ─── policies: profiles ──────────────────────────────────────────────────────
-- You can read your own profile and that of anyone who shares a list with you,
-- so their avatar renders in the roster and on their list items. You can create
-- and edit only your own.
drop policy if exists "read own or co-member profiles" on public.profiles;
create policy "read own or co-member profiles"
  on public.profiles for select
  to authenticated
  using (user_id = requesting_user_id() or public.shares_list_with(user_id));

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert
  to authenticated
  with check (user_id = requesting_user_id());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update
  to authenticated
  using (user_id = requesting_user_id())
  with check (user_id = requesting_user_id());

-- ─── policies: lists ──────────────────────────────────────────────────────
drop policy if exists "list members can read their list" on public.lists;
create policy "list members can read their list"
  on public.lists for select
  using (id in (select public.active_list_ids()));

-- Covers the create-list INSERT ... RETURNING, before the creator's
-- list_members row exists. Scoped so it never exposes other tenants' rows.
-- Note there is deliberately no "read any list by invite code" policy: joining
-- goes through join_list_with_code() below, which is the only thing that ever
-- resolves a code.
drop policy if exists "list owners can read own lists" on public.lists;
create policy "list owners can read own lists"
  on public.lists for select
  -- The deleted_at check is NOT redundant with the members policy above. SELECT
  -- policies are OR'd, so without it the creator of a deleted list still
  -- reads it through this branch -- and the deletion appears to have done
  -- nothing for exactly one person, the one most likely to notice.
  using (created_by = requesting_user_id() and deleted_at is null);

drop policy if exists "authenticated users can create a list" on public.lists;
create policy "authenticated users can create a list"
  on public.lists for insert
  with check (created_by = requesting_user_id());

-- Owners and moderators may update the list; the triggers below decide which
-- columns each of them may actually touch.
--
-- Both halves check the same thing on purpose. USING is evaluated against the
-- OLD row and answers "may you touch this list"; WITH CHECK is evaluated
-- against the NEW one and is what stops an update producing a row the caller
-- could not have reached. Leaving WITH CHECK as `true` — as an earlier revision
-- of this policy did — makes the triggers the only guard, and a trigger that
-- silently falls out of step with the schema is a real failure mode this project
-- has already hit once.
drop policy if exists "list owner or moderator can update list" on public.lists;
create policy "list owner or moderator can update list"
  on public.lists for update
  using (public.is_list_owner_or_moderator(id))
  with check (public.is_list_owner_or_moderator(id));

drop policy if exists "list owner can delete list" on public.lists;
create policy "list owner can delete list"
  on public.lists for delete
  using (created_by = requesting_user_id());

-- ─── policies: list_members ────────────────────────────────────────────────
-- List-wide read, so every member can see the roster (avatars in the top nav).
drop policy if exists "list members can read list memberships" on public.list_members;
create policy "list members can read list memberships"
  on public.list_members for select
  using (public.is_member_of_list(list_id));

-- The ONLY direct insert path, and it is narrow: a list creator seeding their
-- own membership row immediately after creating the list. Everyone else joins
-- through join_list_with_code(), which is the only path that checks the invite
-- code. This is what makes rotating a code genuinely lock someone out — without
-- it, anyone who ever knew a list's uuid could re-insert themselves forever.
drop policy if exists "list creators can seed own membership" on public.list_members;
create policy "list creators can seed own membership"
  on public.list_members for insert
  with check (
    user_id = requesting_user_id()
    and exists (
      select 1 from public.lists f
      where f.id = list_id
        and f.created_by = requesting_user_id()
    )
  );

-- Members may always remove themselves; the owner may remove anyone; a moderator
-- may remove only plain members (never the owner, never another moderator).
drop policy if exists "list owner or moderator or self can delete memberships" on public.list_members;
create policy "list owner or moderator or self can delete memberships"
  on public.list_members for delete
  using (
    user_id = requesting_user_id()
    or exists (
      select 1 from public.lists f
      where f.id = list_id
        and f.created_by = requesting_user_id()
    )
    or (
      public.is_list_owner_or_moderator(list_id)
      and role = 'member'
      and user_id is distinct from (
        select f.created_by from public.lists f where f.id = list_id
      )
    )
  );

-- List-wide so the owner can change roles; the promotion trigger below narrows
-- it to owner-only for the role column itself.
drop policy if exists "list owner or moderator can update memberships" on public.list_members;
create policy "list owner or moderator can update memberships"
  on public.list_members for update
  using (public.is_list_owner_or_moderator(list_id))
  with check (public.is_list_owner_or_moderator(list_id));

-- ─── column-level rules the policies cannot express ──────────────────────────

-- The owner is permanent. Deleting the list is the only way to end it.
create or replace function public.prevent_list_owner_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'List owner cannot be changed.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Moderators may change operational settings, but the list's name is the
-- owner's to choose.
create or replace function public.prevent_moderator_list_name_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if requesting_user_id() is distinct from old.created_by
     and new.name is distinct from old.name then
    raise exception 'Only the list owner can change the list name.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- A membership row identifies one person in one list, and neither half of that
-- may be rewritten after the fact.
--
-- The UPDATE policy above gates the row, not the columns: it asks "may you touch
-- this list's memberships", which a moderator may. Without this trigger a
-- moderator could point somebody else's row at a different account entirely —
-- and that one statement walks past four rules stated elsewhere in this file.
-- The DELETE policy lets a moderator remove plain members only, never the owner
-- and never another moderator; rewriting user_id evicts either one just the same.
-- join_list_with_code() is meant to be the only way in, so a rewrite admits an
-- account that never presented the invite code — the same removed-member-rejoin
-- vector the narrow INSERT policy exists to close. The 3-list cap below is
-- BEFORE INSERT, so it never sees the new membership. And neither audit trigger
-- fires: member_removed is on DELETE, member_role_changed needs role to change,
-- so the whole thing leaves no trace for security_digest() to find.
--
-- Same shape and same reason as prevent_item_ownership_change() in
-- 004_shopping_list.sql: a WITH CHECK expression cannot compare old against new,
-- so a policy cannot express this and a trigger has to.
create or replace function public.prevent_membership_identity_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'Membership cannot be reassigned to another user.'
      using errcode = 'P0001';
  end if;

  if new.list_id is distinct from old.list_id then
    raise exception 'Membership cannot be moved between lists.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Only the owner grants or revokes the moderator rank. Without this, a moderator
-- could promote others (or themselves via a second account) indefinitely.
create or replace function public.prevent_moderator_promotion_to_moderator()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner_user_id text;
begin
  select f.created_by
    into owner_user_id
  from public.lists f
  where f.id = new.list_id;

  if requesting_user_id() is distinct from owner_user_id
     and new.role is distinct from old.role then
    raise exception 'Only the list owner can change member roles.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- A user may belong to at most 3 lists. Ownership is separately capped at 1
-- (lists_one_per_owner above), so a user can own one and join two more, or
-- join three.
--
-- A trigger rather than a policy so it holds against every write path (the join
-- RPC and the creator seeding their own row alike).
--
-- The count is serialized per user with a transaction-scoped advisory lock keyed
-- on the user id: without it, two concurrent joins each read a stale count under
-- READ COMMITTED (neither sees the other's uncommitted row) and both slip past,
-- leaving the user over the cap.
create or replace function public.enforce_list_membership_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  member_limit constant integer := 3;
begin
  -- An idempotent re-join (join_list_with_code upserts ON CONFLICT DO NOTHING)
  -- is not a new membership, so it must not trip the cap. The BEFORE trigger fires
  -- before the conflict is resolved, so guard on the existing row explicitly.
  if exists (
    select 1 from public.list_members
    where list_id = new.list_id and user_id = new.user_id
  ) then
    return new;
  end if;

  -- Serialize concurrent membership inserts for this user (see header note). The
  -- lock is released automatically at transaction end. hashtextextended keeps the
  -- text user_id inside the bigint key space the advisory-lock API expects.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id, 0));

  if (
    select count(*) from public.list_members where user_id = new.user_id
  ) >= member_limit then
    raise exception 'You can be part of at most % lists.', member_limit
      using errcode = 'P0001', detail = 'list_membership_limit_exceeded';
  end if;

  return new;
end;
$$;

-- ─── auditing ────────────────────────────────────────────────────────────────
-- Role changes are the privilege-escalation surface (member → moderator grants
-- rename and kick powers), and removals are how someone loses access. Both go
-- through plain UPDATE/DELETE under RLS rather than an RPC, so a trigger is the
-- only place that sees every path.
create or replace function public.audit_member_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    perform public.log_security_event(
      'member_role_changed',
      new.list_id,
      jsonb_build_object('target', new.user_id, 'from', old.role, 'to', new.role)
    );
  end if;
  return new;
end;
$$;

-- Leaving and being removed are logged under different kinds, not one kind with
-- a flag. security_digest() (002_security_audit.sql) groups by kind and cannot
-- see inside detail, so a single 'member_removed' bucket mixed "three people left
-- a list" with "someone is emptying a list" — and the poller alerting on that
-- bucket could only ever cry wolf. The `self` flag is still recorded, because it
-- is the thing to read when the digest sends you looking.
create or replace function public.audit_member_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self boolean := old.user_id is not distinct from requesting_user_id();
begin
  perform public.log_security_event(
    case when v_self then 'member_left' else 'member_removed' end,
    old.list_id,
    jsonb_build_object(
      'target', old.user_id,
      'role', old.role,
      'self', v_self
    )
  );
  return old;
end;
$$;

drop trigger if exists trg_prevent_list_owner_change on public.lists;
create trigger trg_prevent_list_owner_change
before update on public.lists
for each row
execute function public.prevent_list_owner_change();

drop trigger if exists trg_prevent_moderator_list_name_change on public.lists;
create trigger trg_prevent_moderator_list_name_change
before update on public.lists
for each row
execute function public.prevent_moderator_list_name_change();

-- Named to sort ahead of the role guard below, so who a row belongs to is
-- settled before what rank it carries. BEFORE triggers fire in name order;
-- deliberate but not load-bearing, since either rejection rolls the whole
-- statement back.
drop trigger if exists trg_prevent_membership_identity_change on public.list_members;
create trigger trg_prevent_membership_identity_change
before update on public.list_members
for each row
execute function public.prevent_membership_identity_change();

drop trigger if exists trg_prevent_moderator_promotion_to_moderator on public.list_members;
create trigger trg_prevent_moderator_promotion_to_moderator
before update on public.list_members
for each row
execute function public.prevent_moderator_promotion_to_moderator();

drop trigger if exists trg_enforce_list_membership_limit on public.list_members;
create trigger trg_enforce_list_membership_limit
before insert on public.list_members
for each row
execute function public.enforce_list_membership_limit();

drop trigger if exists trg_audit_member_role_change on public.list_members;
create trigger trg_audit_member_role_change
after update on public.list_members
for each row
execute function public.audit_member_role_change();

drop trigger if exists trg_audit_member_removal on public.list_members;
create trigger trg_audit_member_removal
after delete on public.list_members
for each row
execute function public.audit_member_removal();

-- ─── the profile write ceiling ───────────────────────────────────────────────
-- profiles is the one table a client may write freely about itself: the app
-- upserts display_name and image_url on every boot to keep them fresh, so unlike
-- the list there is no breadth cap to lean on — a member can rewrite their own
-- row forever, and every rewrite is visible to everyone who shares a list with
-- them (the roster and every list item render from here).
--
-- 120 an hour. HomeView upserts this on every app load, so the number has to
-- clear a person reloading hard — during development, or on a flaky connection
-- that keeps remounting — and not just ordinary use. Crossing a ceiling writes a
-- rate_limited row that the daily digest alerts on, so a limit tight enough to
-- trip on reloading would turn the alerting into noise, which is worse than not
-- having this limit at all. A script rewriting a name in a loop still needs
-- thousands. Same shape as the item ceiling in 004_shopping_list.sql, including
-- why the crossing call is allowed through — see the long note there.
create or replace function public.enforce_profile_write_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  write_limit   constant integer  := 120;
  window_length constant interval := interval '1 hour';
  v_actor text := requesting_user_id();
  v_hits  integer;
begin
  -- No JWT means the seed path, the service role, or the pgTAP suite — not the
  -- traffic this limits. Note join_list_with_code() does NOT land here with a
  -- null actor: it is SECURITY DEFINER but still runs under the caller's JWT, so
  -- its profile upsert costs the joiner one write, which is correct.
  if v_actor is null then
    return new;
  end if;

  if not public.rate_limit_hit('profile_write', write_limit, window_length) then
    return new;
  end if;

  select rl.hits into v_hits
  from public.rate_limit_counters rl
  where rl.actor = v_actor
    and rl.kind = 'profile_write'
    and rl.window_start = date_bin(window_length, now(), timestamptz 'epoch');

  if coalesce(v_hits, 0) <= write_limit + 1 then
    return new;
  end if;

  raise exception 'Too many profile updates in a short time. Try again shortly.'
    using errcode = 'P0001',
          detail = 'profile_write_rate_limit_exceeded';
end;
$$;

revoke all on function public.enforce_profile_write_rate_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_profile_write_rate_limit on public.profiles;
create trigger trg_enforce_profile_write_rate_limit
before insert or update on public.profiles
for each row
execute function public.enforce_profile_write_rate_limit();

-- ─── creating a list ────────────────────────────────────────────────────
-- The counterpart to join_list_with_code below, and it exists for the same
-- reason that one does: a list is not one row, and doing it in pieces from
-- the client means the pieces can come apart.
--
-- Creation used to be three client writes — upsert the profile (the FK target),
-- insert the list, insert the membership — with a compensating DELETE if
-- the third failed. That compensation is itself a network call, and when it
-- failed the result was unrecoverable by the user:
--
--   • lists_one_per_owner is a unique index on created_by, so the orphan
--     permanently occupies the account's one ownership slot;
--   • every list in the app is derived from list_members, so the
--     orphan appears nowhere the user could leave or delete it;
--   • the setup screen's own ownership probe reads lists by created_by, so
--     it finds the orphan and correctly hides the create option — telling the
--     user they already own a list they cannot see.
--
-- A function body is one transaction, so the membership limit trigger raising
-- now rolls the list insert back with it. There is no window to compensate
-- for, which is a different thing from a smaller one.
--
-- The invite code still comes from the client (src/lib/inviteCode.ts mints it
-- with a CSPRNG) rather than being generated here, so this change is only about
-- atomicity. The format is re-checked below anyway: lists_invite_code_format_check
-- would catch a malformed one, but as a constraint violation rather than as the
-- named error the caller can act on.
create or replace function public.create_list(
  p_name text,
  p_invite_code text,
  p_display_name text default null,
  p_image_url text default null
)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user text := requesting_user_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_list_id uuid;
begin
  if v_user is null then
    return;
  end if;

  -- Mirrors lists_name_length_check and src/lib/limits.ts. Raised by name
  -- so the client can tell this apart from the ownership conflict below.
  if char_length(v_name) < 1 or char_length(v_name) > 25 then
    raise exception 'list name must be 1-25 characters'
      using detail = 'list_name_invalid';
  end if;

  if coalesce(p_invite_code, '') !~ '^[A-HJ-NP-Z2-9]{8}$' then
    raise exception 'invite code is malformed'
      using detail = 'invite_code_invalid';
  end if;

  -- Same clamping as the join path: an overlong name or a non-https avatar is
  -- trimmed rather than allowed to fail the whole creation.
  -- A banned account is refused HERE because here is the door. The app upserts
  -- a profile on every boot, so refusing the upsert is the whole mechanism that
  -- makes a ban stick -- flagging the row alone would be undone by the next
  -- launch. Raising rather than silently skipping, for the reason admin_guard()
  -- raises: a refusal and a no-op look identical from the client, and only one
  -- of them is worth telling someone about.
  if exists (
    select 1 from public.profiles
    where user_id = v_user and banned_at is not null
  ) then
    raise exception 'This account has been suspended.'
      using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, display_name, image_url, updated_at)
  values (
    v_user,
    coalesce(nullif(left(btrim(p_display_name), 80), ''), 'Member'),
    -- Clamped to null rather than allowed to hit profiles_image_url_scheme:
    -- these two RPCs are how someone creates or joins a list, and an avatar
    -- the check would reject must cost them their photo, not their membership.
    case
      when p_image_url ~ '^https://img\.clerk\.com/' and char_length(p_image_url) <= 2048
      then p_image_url
      else null
    end,
    now()
  )
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        image_url = excluded.image_url,
        updated_at = now();

  -- lists_one_per_owner raises 23505 here for a second list. Left to
  -- surface as-is: the caller already recognises the constraint name, and unlike
  -- the checks above it is not something this function can phrase better.
  insert into public.lists (name, invite_code, created_by)
  values (v_name, p_invite_code, v_user)
  returning lists.id into v_list_id;

  -- The membership limit trigger can raise here. That rollback taking the
  -- list row with it is the entire point of this function.
  insert into public.list_members (list_id, user_id, role)
  values (v_list_id, v_user, 'moderator');

  return query select v_list_id, v_name;
end;
$$;

revoke all on function public.create_list(text, text, text, text) from public;
grant execute on function public.create_list(text, text, text, text) to authenticated;

-- ─── joining by invite code ──────────────────────────────────────────────────
-- The invite code is a real credential, and this is the only thing that checks
-- it. Verifying the code, upserting the joiner's profile and inserting the
-- membership all happen in one server-side step; the direct INSERT policy above
-- covers only the creator-seeding case, so there is no client path that joins a
-- list without presenting a valid code.
--
-- Throttling, honestly scoped: the limit is per Clerk user, because PostgREST
-- does not hand the database a client IP. Someone willing to mint many Clerk
-- accounts can still spread attempts across them — Clerk's own signup rate
-- limiting is what covers that, and a 32^8 (~1.1 trillion) code space is what
-- makes the exercise pointless. The goal here is a ceiling plus a trail, not an
-- impregnable gate.
--
-- Note what does NOT exist: any function that merely resolves a code to a list
-- without joining. Such a lookup is a free yes/no oracle — exactly the primitive
-- a brute-forcer wants, and cheaper to call than this. Every invite-code check
-- goes through this throttled, audited path.
create or replace function public.join_list_with_code(
  p_code text,
  p_display_name text default null,
  p_image_url text default null
)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Ten wrong codes in fifteen minutes. A real person mistyping an 8-character
  -- code does not get near this; a script does so immediately.
  max_failures  constant integer  := 10;
  window_length constant interval := interval '15 minutes';
  v_user   text := requesting_user_id();
  v_list record;
  v_recent_failures integer;
begin
  if v_user is null then
    return;
  end if;

  select count(*)::integer into v_recent_failures
  from public.security_events
  where actor = v_user
    and kind = 'invite_code_failed'
    and created_at > now() - window_length;

  if v_recent_failures >= max_failures then
    perform public.log_security_event(
      'invite_rate_limited',
      null,
      jsonb_build_object('failures_in_window', v_recent_failures)
    );
    -- Return empty rather than raising, for two reasons.
    --
    -- 1. Correctness: RAISE would abort the transaction, and the audit row just
    --    written above would roll back with it — the log would be blank at exactly
    --    the moment it mattered. Postgres has no autonomous transactions, so a
    --    clean return is the only way the record survives.
    -- 2. Security: the caller cannot distinguish "throttled" from "wrong code", so
    --    the throttle itself leaks nothing about whether guesses were landing.
    --
    -- The cost is that a user who really did mistype ten times sees "No list
    -- found with that invite code" until the window clears. Rare enough, and a
    -- softer failure than a scary error.
    return;
  end if;

  select f.id, f.name into v_list
  from public.lists f
  where f.invite_code = p_code;

  if not found then
    -- The code itself is deliberately not logged: it is a credential, and an
    -- audit table that accumulates near-miss guesses would become a place worth
    -- stealing. The count is what tells the story.
    perform public.log_security_event('invite_code_failed');
    return;
  end if;

  -- Clamp to what the profiles constraints allow rather than failing the join on
  -- an overlong name or a non-https avatar URL.
  -- A banned account is refused HERE because here is the door. The app upserts
  -- a profile on every boot, so refusing the upsert is the whole mechanism that
  -- makes a ban stick -- flagging the row alone would be undone by the next
  -- launch. Raising rather than silently skipping, for the reason admin_guard()
  -- raises: a refusal and a no-op look identical from the client, and only one
  -- of them is worth telling someone about.
  if exists (
    select 1 from public.profiles
    where user_id = v_user and banned_at is not null
  ) then
    raise exception 'This account has been suspended.'
      using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, display_name, image_url, updated_at)
  values (
    v_user,
    coalesce(nullif(left(btrim(p_display_name), 80), ''), 'Member'),
    -- Clamped to null rather than allowed to hit profiles_image_url_scheme:
    -- these two RPCs are how someone creates or joins a list, and an avatar
    -- the check would reject must cost them their photo, not their membership.
    case
      when p_image_url ~ '^https://img\.clerk\.com/' and char_length(p_image_url) <= 2048
      then p_image_url
      else null
    end,
    now()
  )
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        image_url = excluded.image_url,
        updated_at = now();

  insert into public.list_members (list_id, user_id, role)
  values (v_list.id, v_user, 'member')
  on conflict (list_id, user_id) do nothing;  -- already a member: idempotent

  perform public.log_security_event('invite_join_succeeded', v_list.id);

  return query select v_list.id, v_list.name;
end;
$$;

revoke all on function public.join_list_with_code(text, text, text) from public;
grant execute on function public.join_list_with_code(text, text, text) to authenticated;

-- ─── grants ──────────────────────────────────────────────────────────────────
-- RLS above decides which rows; these decide that the role may reach the tables
-- at all. Note profiles gets no DELETE: a profile is the FK target for every
-- membership, and there is no product flow that removes one.
-- Revoke first, then grant, so what these three tables allow is exactly what the
-- next three lines say rather than that plus whatever the platform left behind.
-- See the note below for what was left behind and why it mattered.
revoke all on public.lists, public.list_members, public.profiles
  from anon, authenticated, service_role;

grant select, insert, update, delete on public.lists, public.list_members to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- service_role reads for ops and triage, and because
-- supabase/functions/push-on-item-insert resolves recipients from list_members
-- and names from profiles. It writes none of them.
grant select on public.lists, public.list_members, public.profiles to service_role;

-- ─── and the privileges nobody granted ───────────────────────────────────────
-- Hosted Supabase hands anon, authenticated and service_role broad table
-- privileges when a project is provisioned. Every file here only ever ADDS
-- grants, so those defaults survived untouched: production had DELETE on
-- profiles for authenticated, and full read/write for anon, on tables these
-- files describe as tightly scoped. RLS blocked all of it, which is why nothing
-- was ever wrong — but it meant the second gate this schema keeps talking about
-- was open the whole time, and the files were describing an intent rather than a
-- state.
--
-- Closing it, once, for the three roles:
--
--   anon          — nothing at all. Every policy here resolves through
--                   requesting_user_id(), which is null without a JWT, so an
--                   anonymous caller could already read nothing. The difference
--                   is that it now gets a permission error instead of an empty
--                   result, which is the honest answer: an unauthenticated read
--                   is a bug, not an empty shopping list.
--   authenticated — exactly what the grants above name, nothing more.
--   service_role  — reads everything (it is the ops and triage identity, and
--                   the push function reads list_members and profiles with
--                   it), but writes only where a script genuinely writes:
--                   product_catalog, in 006.
--
-- WHY THIS REVOKES ALL AND RE-GRANTS RATHER THAN SUBTRACTING
--
-- `revoke insert, update, delete` looks like enough and is not. The provisioning
-- default also includes TRUNCATE, and TRUNCATE is not subject to row level
-- security — a role holding it empties the table whatever the policies say. It
-- is not reachable through PostgREST, which speaks CRUD and not raw SQL, and
-- `authenticated` cannot log in directly, so nothing could actually use it. But
-- "unreachable today" is a weak thing to rest a table's contents on when the
-- alternative is one word. REFERENCES and TRIGGER came along for the same ride.
--
-- 004, 005 and 006 do the same for their own tables.
