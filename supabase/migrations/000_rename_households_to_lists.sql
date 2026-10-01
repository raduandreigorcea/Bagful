-- ─── households → lists ──────────────────────────────────────────────────────
-- A one-time rename of the entity this app is built around, the second one. A
-- household here was always exactly one shared shopping list plus the people on
-- it, and people think of it as "our list", not as a household; a person in
-- three of them has three lists. So the table, its columns, the functions and
-- the policies all say list now.
--
-- This file replaces 000_rename_families_to_households.sql, which did the same
-- job one step earlier (families → households). That one has run on every
-- database that exists; its guard on `public.families` is false everywhere, so
-- nothing is lost by retiring it.
--
-- WHY THIS FILE SORTS BEFORE 001
--
-- The files after this one restate the schema as it IS, so they are all
-- `create table if not exists`. Re-running them with the new names against a
-- database that still holds `households` would not rename anything: it would
-- find no `lists`, create a fresh empty one, and leave every existing row
-- stranded in a table nothing queries any more. The rename has to happen first,
-- and then 001-009 rebuild every policy, function and trigger on top of the
-- already-renamed tables. Hence 000.
--
-- So the push is the documented dance from CLAUDE.md, over all ten:
--
--   npx supabase migration repair --status reverted 000 001 002 003 004 005 006 007 008 009 --linked
--   npx supabase db push --dry-run --include-all --linked
--   npx supabase db push --include-all --linked
--
-- `--include-all` is required: this file sorts before every applied migration.
-- 000 is in the repair list too, because production records version 000 as the
-- families rename; without reverting it, this file (same version) is skipped.
--
-- WHY IT IS SAFE TO RE-RUN
--
-- Everything below is wrapped in one guard on `public.households` still
-- existing. On a database built from the updated 001-009 the tables are already
-- named correctly, the guard is false, and the whole file is a no-op. On
-- production it runs exactly once and the guard is false forever after. The
-- second block renames by pattern, so once nothing matches it does nothing.
--
-- WHAT IS DELIBERATELY NOT RENAMED
--
-- * Nothing in localStorage: this migration cannot reach phones. The client
--   renames the old snapshot and active-list keys itself (src/lib/legacyStorage),
--   and the values inside may carry householdId / household_id (or the older
--   familyId / family_id), which src/lib/listCache.ts and the offline queue
--   read in every shape; see the notes there.
-- * The product aisle called `household` (cleaning supplies, paper towels).
--   It is a category of product, not this entity, and it lives in the app and
--   the catalog, not in this schema.

do $$
declare
  r record;
begin
  -- The whole file, gated once. `to_regclass` returns null rather than raising
  -- when the table is absent, which is what makes this safe on a fresh database.
  if to_regclass('public.households') is null then
    raise notice 'households not present; rename already applied or database is new';
    return;
  end if;

  -- ─── 1. policies ───────────────────────────────────────────────────────────
  -- Dropped wholesale rather than by name. Most of them carry "household" in
  -- their own name or call a function that is dropped below, 001-009 recreate
  -- every one of them later in this same push, and enumerating them by hand is
  -- the one step here where a typo would leave a table quietly unprotected.
  --
  -- There is no exposure window: RLS stays ENABLED on every table, and a table
  -- with RLS on and no policies denies every row to every non-superuser. The
  -- failure mode between here and 009 is "denied", never "readable".
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'households', 'household_members', 'profiles',
        'shopping_list_items', 'purchase_history', 'product_catalog',
        'security_events'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
  end loop;

  -- ─── 2. functions whose identity changes ───────────────────────────────────
  -- Three reasons a function has to be dropped rather than left to the
  -- `create or replace` in 001-009:
  --
  --   * its name changes: a replace would leave the old name in place too, and
  --     a stale is_member_of_household() outliving the table it queries is
  --     exactly the drift this schema's notes keep warning about;
  --   * only an input parameter's name changes: Postgres refuses to rename one
  --     through CREATE OR REPLACE ("cannot change name of input parameter"), so
  --     p_household_id → p_list_id needs a drop as well;
  --   * only a RETURNS TABLE / OUT column's name changes (household_id,
  --     household_name, owned_households...): that changes the return row type,
  --     and CREATE OR REPLACE refuses it ("cannot change return type of
  --     existing function").
  --
  -- The list was taken from the catalog of a database built from the old files,
  -- by matching `household` against each function's name, its argument names
  -- (which include OUT and TABLE columns) and its result type. Exact signatures:
  -- a `drop function if exists` with the wrong argument types drops nothing.
  --
  -- CASCADE takes the triggers built on these functions with them (and any
  -- policy on a table not listed above that calls one); 003 through 009
  -- recreate every one. It does NOT touch other functions that merely call
  -- them, because a plpgsql body is not a tracked dependency; those callers are
  -- rebuilt later in this push regardless.

  -- name changes
  drop function if exists public.is_member_of_household(uuid) cascade;
  drop function if exists public.is_household_owner_or_moderator(uuid) cascade;
  drop function if exists public.shares_household_with(text) cascade;
  drop function if exists public.active_household_ids() cascade;
  drop function if exists public.prevent_household_owner_change() cascade;
  drop function if exists public.prevent_moderator_household_name_change() cascade;
  drop function if exists public.enforce_household_membership_limit() cascade;
  drop function if exists public.create_household(text, text, text, text) cascade;
  drop function if exists public.join_household_with_code(text, text, text) cascade;
  drop function if exists public.admin_household_facts() cascade;
  drop function if exists public.admin_list_households(text, text, text, integer, integer) cascade;
  drop function if exists public.admin_household_detail(uuid) cascade;
  drop function if exists public.admin_delete_household(uuid) cascade;
  drop function if exists public.admin_restore_household(uuid) cascade;
  drop function if exists public.admin_deleted_households() cascade;

  -- input parameter name changes only (p_household_id)
  drop function if exists public.log_security_event(text, uuid, jsonb) cascade;
  drop function if exists public.add_custom_product(uuid, text, text, text) cascade;
  drop function if exists public.add_custom_product_unthrottled(uuid, text, text, text) cascade;
  drop function if exists public.bump_product_popularity(text, text, uuid) cascade;
  drop function if exists public.search_catalog(text, uuid, integer) cascade;

  -- result column name changes only
  drop function if exists public.admin_user_facts() cascade;
  drop function if exists public.admin_banned_users() cascade;
  drop function if exists public.admin_activity_series(timestamptz, text) cascade;
  drop function if exists public.admin_recent_activity(integer) cascade;
  drop function if exists public.admin_list_users(text, text, text, integer, integer) cascade;
  drop function if exists public.admin_local_products(text, text, text, integer, integer) cascade;
  drop function if exists public.admin_security_events(text, timestamptz, text, integer, integer) cascade;
  drop function if exists public.admin_top_purchases(timestamptz, integer) cascade;
  drop function if exists public.admin_catalog_misses(integer) cascade;

  -- ─── 3. tables ─────────────────────────────────────────────────────────────
  -- Metadata-only in Postgres: no table rewrite, no lock held longer than the
  -- statement, and every foreign key pointing at households follows
  -- automatically. So do the push webhook triggers on shopping_list_items and
  -- purchase_history (007): they belong to those tables, not to a function
  -- dropped above, and survive untouched.
  alter table public.households        rename to lists;
  alter table public.household_members rename to list_members;

  -- ─── 4. columns ────────────────────────────────────────────────────────────
  -- Each guarded independently: 002's security_events.household_id has no
  -- foreign key (see the note in that file), so it is possible for it to have
  -- been renamed already while the rest has not.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'list_members'
               and column_name = 'household_id') then
    alter table public.list_members rename column household_id to list_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'shopping_list_items'
               and column_name = 'household_id') then
    alter table public.shopping_list_items rename column household_id to list_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'purchase_history'
               and column_name = 'household_id') then
    alter table public.purchase_history rename column household_id to list_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'product_catalog'
               and column_name = 'household_id') then
    alter table public.product_catalog rename column household_id to list_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'security_events'
               and column_name = 'household_id') then
    alter table public.security_events rename column household_id to list_id;
  end if;

  -- ─── 5. audit event kinds ──────────────────────────────────────────────────
  -- security_events.kind is data, not schema, but admin labels an event by its
  -- kind, and 001-009 now write list_created, admin_list_deleted and so on. An
  -- old row still saying household_created would show up unlabelled next to the
  -- new ones.
  update public.security_events
     set kind = replace(kind, 'household', 'list')
   where kind like '%household%';
end
$$;

-- ─── 6. constraint, index and trigger names ──────────────────────────────────
-- Renaming a table or a column rewrites what its constraints MEAN but not what
-- they are CALLED, so without this a lists table keeps a set of
-- households_*_check constraints and PostgREST keeps advertising
-- household_members_user_id_profiles_fkey.
--
-- Done by pattern rather than by list because several of these names were
-- generated by Postgres, not written here (households_pkey,
-- household_members_household_id_user_id_key), and guessing them is how a
-- rename misses one.
--
-- Two of them are load-bearing rather than cosmetic:
--
--   households_name_length_check       003 restates this bound as an explicit
--                                      drop-and-add, so a leftover under the old
--                                      name would survive as a second, duplicate
--                                      constraint on the same column.
--   household_members_user_id_..._fkey named on purpose in 003 because PostgREST
--                                      resolves an embedded profiles(...) by
--                                      constraint name; it is API surface, not
--                                      an implementation detail.
--
-- Triggers: every trigger named after households is built on a function
-- dropped above, so CASCADE already took it and 003 recreates it under the new
-- name. The loop is there for one made outside these files (the dashboard),
-- which would otherwise keep its old name forever.
do $$
declare
  r record;
  new_name text;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public'
      and c.conname like '%household%'
  loop
    new_name := replace(replace(r.conname, 'households', 'lists'), 'household', 'list');
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, new_name);
  end loop;

  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'i'
      and c.relname like '%household%'
      -- Index-backed constraints were renamed by the loop above; their indexes
      -- came along with them, and renaming those again here would fail.
      and not exists (select 1 from pg_constraint pc where pc.conindid = c.oid)
  loop
    new_name := replace(replace(r.relname, 'households', 'lists'), 'household', 'list');
    execute format('alter index public.%I rename to %I', r.relname, new_name);
  end loop;

  for r in
    select t.tgname, t.tgrelid::regclass::text as tbl
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgname like '%household%'
  loop
    new_name := replace(replace(r.tgname, 'households', 'lists'), 'household', 'list');
    execute format('alter trigger %I on %s rename to %I', r.tgname, r.tbl, new_name);
  end loop;
end
$$;
