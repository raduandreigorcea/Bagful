-- ─────────────────────────────────────────────────────────────────────────────
-- Duplicate / stray-row audit for Bagful.
--
-- Every statement here is a read-only SELECT: safe to run against production,
-- nothing is written or deleted. Paste a section into the Supabase SQL editor
-- (or run the whole file) and read the result.
--
-- Convention: for most checks, EMPTY RESULT = CLEAN. Checks marked "[info]"
-- can legitimately return rows — they surface state to eyeball, not a defect.
--
-- The two sections are grouped by subject rather than by prerequisite: A covers
-- the catalog, lists and list rows, B covers profiles. (B used to require a
-- migration that had not landed everywhere; profiles is part of the base schema
-- now — see 003_lists_and_members.sql — so both sections always run.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══ SECTION A — works on the current schema ═════════════════════════════════

-- A1. product_catalog: two contributed rows for the same list that normalize
-- to the same key (would read as two identical suggestions to that list).
-- Guarded by the unique index product_catalog_list_search — expect EMPTY.
select list_id, search_text, count(*) as copies, array_agg(id) as ids
from public.product_catalog
where list_id is not null
group by list_id, search_text
having count(*) > 1
order by copies desc;

-- A2. product_catalog: two GLOBAL rows that normalize to the same key (everyone
-- sees the duplicate). Guarded by product_catalog_global_search — expect EMPTY.
select search_text, count(*) as copies, array_agg(id) as ids
from public.product_catalog
where list_id is null
group by search_text
having count(*) > 1
order by copies desc;

-- A3. product_catalog: a list-scoped row whose product already exists globally.
-- Promotion is supposed to collapse the scoped rows into the global; any rows
-- here mean a list sees the same product twice (their scoped one + the global).
-- A real de-dup candidate if it returns anything.
select s.id as scoped_id, s.list_id, s.name, s.maker, s.search_text, s.add_count
from public.product_catalog s
join public.product_catalog g
  on g.list_id is null and g.search_text = s.search_text
where s.list_id is not null
order by s.search_text;

-- A4. shopping_list_items: duplicate ACTIVE rows for the same product in a list
-- (same trimmed/lowercased name + maker, unchecked). Guarded by
-- shopping_list_items_unique_active_name — expect EMPTY.
select
  list_id,
  lower(btrim(name)) as name_key,
  lower(btrim(coalesce(maker, ''))) as maker_key,
  count(*) as copies,
  array_agg(id) as ids
from public.shopping_list_items
where checked = false
group by list_id, lower(btrim(name)), lower(btrim(coalesce(maker, '')))
having count(*) > 1
order by copies desc;

-- A5. list_members: the same user listed twice in one list.
-- Guarded by the unique(list_id, user_id) constraint — expect EMPTY.
select list_id, user_id, count(*) as copies
from public.list_members
group by list_id, user_id
having count(*) > 1;

-- A6. lists: two lists sharing an invite code.
-- Guarded by the unique invite_code constraint — expect EMPTY.
select invite_code, count(*) as copies, array_agg(id) as ids
from public.lists
group by invite_code
having count(*) > 1;

-- A7. lists: more than one owned by the same account.
-- Guarded by lists_one_per_owner — expect EMPTY.
select created_by, count(*) as lists_owned, array_agg(id) as ids
from public.lists
group by created_by
having count(*) > 1;

-- A8. Users over the 3-list membership cap.
-- Guarded by the enforce_list_membership_limit trigger — expect EMPTY.
select user_id, count(*) as list_count
from public.list_members
group by user_id
having count(*) > 3
order by list_count desc;

-- A9. [info] Lists with no members at all (an orphan the create flow normally
-- cleans up). Not a duplicate, but a stray row worth knowing about.
select f.id, f.name, f.created_by, f.created_at
from public.lists f
where not exists (
  select 1 from public.list_members fm where fm.list_id = f.id
)
order by f.created_at;

-- A10. [info] What the profiles table is worth: users who belong to more than one
-- list. A schema that copied name+avatar onto every membership would store one
-- copy per row below; profiles stores one, full stop. The sum of (copies - 1) is
-- roughly how many redundant copies that design avoids.
select user_id, count(*) as copies_across_lists
from public.list_members
group by user_id
having count(*) > 1
order by copies_across_lists desc;


-- ═══ SECTION B — profiles ════════════════════════════════════════════════════

-- B1. list_members whose user has NO profile row. Must be EMPTY: the FK
-- list_members_user_id_profiles_fkey enforces it. Running it is a quick
-- confirmation that nothing has been inserted around the constraint.
select fm.user_id, count(*) as memberships
from public.list_members fm
left join public.profiles p on p.user_id = fm.user_id
where p.user_id is null
group by fm.user_id;

-- B2. [info] Orphan profiles: a profile row for someone who is in no list right
-- now. Harmless (e.g. someone who left, or an old list-item author the backfill
-- captured), but this is where you'd prune if you ever want to.
select p.user_id, p.display_name, p.updated_at
from public.profiles p
where not exists (
  select 1 from public.list_members fm where fm.user_id = p.user_id
)
order by p.updated_at;

-- B3. [info] Active list items whose author is no longer a member of that list.
-- After 026 their row avatar falls back to an initial (the roster can't resolve
-- them). Not a duplicate — shows where a "?" avatar will appear.
select s.list_id, s.added_by, count(*) as items
from public.shopping_list_items s
where not exists (
  select 1 from public.list_members fm
  where fm.list_id = s.list_id and fm.user_id = s.added_by
)
group by s.list_id, s.added_by
order by items desc;
