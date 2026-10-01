-- ─── product catalog ─────────────────────────────────────────────────────────
-- The products offered while typing in the add-item box, and the throttled ways
-- the catalog grows.
--
-- Scope lives in one column:
--   list_id is null  - global. Written by catalog-importer with the service
--                        role key, and suggested to everyone. A few hundred
--                        'curated' rows predate it, from a seed script deleted
--                        in 9a4366e -- they are still in production and nothing
--                        in the repo regenerates them, which is why the import
--                        is careful never to overwrite one (guarantee 2 below).
--   list_id = <uuid> - contributed via add_custom_product(), suggested only
--                        back to that list until enough OTHER lists add the
--                        same product, at which point it is promoted to global.
--
-- That promotion rule is what makes a user-writable catalog safe. A misspelling
-- one list types stays scoped to them forever; a product several lists
-- independently ask for earns its way in on its own. No moderation queue, and no
-- way for one list's spelling to leak into everyone else's suggestions — the
-- threshold counts distinct contributing *accounts* (contributed_by) AND the
-- distinct lists they contributed from, and both must reach it. Crossing it
-- takes three separate people who each added the product in their own list.
-- One account belonging to three lists and typing the same junk into all
-- three counts as one account and cannot self-promote; three accounts one person
-- controls inside a single list count as one list and cannot either.
--
-- Clients never write this table. RLS grants SELECT and nothing else; the two
-- SECURITY DEFINER RPCs at the bottom are the only writes reachable from the
-- app, and both are rate-limited (002_security_audit.sql).
--
-- Ranking is the sum of two columns, kept apart so re-seeding never wipes earned
-- usage:
--   base_weight - editorial cold-start baseline. The importer overwrites it
--                 freely on every run for rows it owns.
--   add_count   - times the product was actually added. Only the RPCs touch it.
-- popularity is their stored sum, and suggestions order by it descending.

create table if not exists public.product_catalog (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,   -- e.g. "Apa Plata 2L"
  maker       text,                   -- e.g. "Dorna", shown as a subtitle
  -- Lowercased, diacritic-free "name maker" that typed input is matched against,
  -- so "apă" typed with or without accents finds "Apa Plata 2L Dorna". Derived by
  -- product_search_text() below — never supplied by a client.
  search_text text        not null,
  -- Null for the global catalog; the contributing list otherwise.
  list_id   uuid        references public.lists(id) on delete cascade,
  -- Who first contributed a scoped row; null for globals. Promotion counts
  -- distinct values of this, so it is the identity the anti-abuse gate measures.
  contributed_by text,
  base_weight integer     not null default 0,
  add_count   integer     not null default 0,
  popularity  integer     generated always as (base_weight + add_count) stored,
  -- EAN/GTIN. From an upstream catalog on imported rows, and from the scan that
  -- missed on a contributed one — naming a product the scanner could not find is
  -- what puts a code on a community row. Null for seeded rows, and for anything
  -- typed in without a scan.
  barcode     text,
  -- curated = the editorial seed, community = add_custom_product(), and the
  -- three open* values = catalog-importer. Provenance is a licensing fact here,
  -- not a nicety, which is why every writer names it explicitly rather than
  -- leaning on this default. The allowlist is restated as an ALTER below; see
  -- the note there before changing it here.
  source      text        not null default 'community',
  -- Identity of this row in the upstream catalog. What makes a re-import update
  -- rather than duplicate.
  source_ref  text,
  -- Which import run produced this row, e.g. off-2026-07-01. Lets one run be
  -- reverted on its own.
  source_version text,
  created_at  timestamptz not null default now(),
  constraint product_catalog_name_length
    check (char_length(name) between 1 and 120),
  constraint product_catalog_maker_length
    check (maker is null or char_length(maker) between 1 and 60),
  constraint product_catalog_search_text_length
    check (char_length(search_text) between 1 and 200),
  constraint product_catalog_base_weight_check
    check (base_weight between 0 and 1000000),
  constraint product_catalog_add_count_check
    check (add_count >= 0),
  constraint product_catalog_barcode_format
    check (barcode is null or barcode ~ '^[0-9]{8,14}$'),
  constraint product_catalog_source_check
    check (source in (
      'curated', 'community',
      'openfoodfacts', 'openproductsfacts', 'openbeautyfacts'
    )),
  constraint product_catalog_source_ref_length
    check (source_ref is null or char_length(source_ref) between 1 and 100),
  constraint product_catalog_source_version_length
    check (source_version is null or char_length(source_version) between 1 and 40),
  -- NULLS NOT DISTINCT so a maker-less product cannot be inserted twice within a
  -- scope. list_id is part of the key so two lists can each contribute their
  -- own "Olive Oil". Also the only TOTAL unique constraint here, and therefore
  -- the only conflict target PostgREST's .upsert() can infer.
  constraint product_catalog_name_maker_list_unique
    unique nulls not distinct (name, maker, list_id)
);

-- ─── bounds and columns that have to be restated ─────────────────────────────
-- Everything inside `create table if not exists` above applies only when the
-- table is created, so on every database this file has already run against it is
-- skipped entirely. Changing the source allowlist up there alone would widen it
-- on a fresh clone and leave production rejecting the two new import sources —
-- the same trap 003 documents at length for lists_name_length_check.
alter table public.product_catalog drop constraint if exists product_catalog_source_check;
alter table public.product_catalog add constraint product_catalog_source_check
  check (source in (
    'curated',            -- the editorial seed
    'community',          -- add_custom_product()
    'openfoodfacts',      -- catalog-importer
    'openproductsfacts',  -- catalog-importer, non-food
    'openbeautyfacts'     -- catalog-importer, toiletries
  ));

-- Extra words a product can be found by, beyond its own name: the Open Food
-- Facts category taxonomy resolved into the languages the app speaks. A
-- Romanian bottled water tagged en:natural-mineral-waters carries "natural
-- mineral waters apa minerala mineralwasser agua mineral eau minerale acqua
-- minerale", which is what lets somebody type "water" and reach "Apă minerală
-- Borsec".
--
-- Deliberately NOT folded into search_text. That column is the merge key behind
-- product_catalog_global_search, add_custom_product() and every collapse rule in
-- import_catalog_products; widening it would stop two products with the same
-- name but different categories from colliding, which is the opposite of what
-- the key is for.
alter table public.product_catalog add column if not exists search_aliases text;

alter table public.product_catalog drop constraint if exists product_catalog_search_aliases_length;
alter table public.product_catalog add constraint product_catalog_search_aliases_length
  check (search_aliases is null or char_length(search_aliases) between 1 and 400);

-- One column to match against, so a multi-word query needs one index rather than
-- an OR across two. Stored because the trigram index has to be built on it.
alter table public.product_catalog add column if not exists search_blob text
  generated always as (search_text || coalesce(' ' || search_aliases, '')) stored;

alter table public.product_catalog enable row level security;

-- Kept as database comments, not just SQL comments: the provenance columns are
-- read from the SQL editor when auditing where a row came from, and a licensing
-- question is exactly when nobody has this file open.
comment on column public.product_catalog.barcode is
  'EAN/GTIN. From the upstream catalog on imported rows; from the scan that missed on a contributed one. Null for seeded rows and for products typed in without a scan.';
comment on column public.product_catalog.source is
  'curated = the editorial seed, community = add_custom_product(), openfoodfacts/openproductsfacts/openbeautyfacts = catalog-importer. All three import sources are ODbL and require attribution in the app.';
comment on column public.product_catalog.search_aliases is
  'Normalized extra search terms (Open Food Facts category names across the app languages). Never displayed; matched against alongside search_text via search_blob.';
comment on column public.product_catalog.source_ref is
  'Identity of this row in the upstream catalog (the upstream code). What makes a re-import update rather than duplicate.';
comment on column public.product_catalog.source_version is
  'Which import run produced this row, e.g. off-2026-07-01. Lets one run be reverted on its own.';

-- Match anywhere in the text ("dorna" finds "apa plata 2l dorna"), not just at
-- the start. On search_blob rather than search_text so a query can also reach a
-- product through its category aliases, in a language the product is not named
-- in. search_catalog() below is the only reader.
create index if not exists product_catalog_search_blob_trgm
  on public.product_catalog
  using gin (search_blob extensions.gin_trgm_ops);

-- Superseded by the index above. search_text is still the merge key, but every
-- lookup against it is an equality served by the unique btree indexes below; the
-- only substring search over it was the client-built ilike that search_catalog()
-- replaced. Two trigram GIN indexes over a catalog heading for six figures is
-- real disk for nothing.
drop index if exists public.product_catalog_search_text_trgm;

-- Orders the (small) trigram-filtered match set, with name as the tiebreak.
create index if not exists product_catalog_popularity
  on public.product_catalog (popularity desc, name);

-- The real key for contributed rows, and the arbiter add_custom_product() upserts
-- against. Stricter than the unique constraint above: "Olive Oil" and "olive oil"
-- share a search_text, so this stops one list accumulating near-duplicate rows
-- that would read as two identical suggestions.
create unique index if not exists product_catalog_list_search
  on public.product_catalog (list_id, search_text)
  where list_id is not null;

-- One global row per search key. Stops two seed rows — or a promotion landing
-- beside an existing global — from creating two globals that normalize alike,
-- which would both be bumped on every add and read as duplicates to everyone.
create unique index if not exists product_catalog_global_search
  on public.product_catalog (search_text)
  where list_id is null;

-- One global row per barcode. Partial on list_id so that scoped rows are
-- exempt: a list naming a product the scanner could not find records the
-- code on their own row, and must not be blocked by a global that already claims
-- it under a different name. Promotion is where the two meet, and it declines to
-- carry a code rather than collide — see add_custom_product_unthrottled.
create unique index if not exists product_catalog_global_barcode
  on public.product_catalog (barcode)
  where list_id is null and barcode is not null;

-- "Has this upstream record already landed?" — scoped by source so two different
-- upstream catalogs can share an identifier space without colliding.
create unique index if not exists product_catalog_source_ref_unique
  on public.product_catalog (source, source_ref)
  where source_ref is not null;

-- Deliberately no index on source alone: the one query that filters by it is a
-- bulk delete of an entire import, which is a sequential scan either way.

-- Read-only for signed-in users, and contributed rows only for the list that
-- owns them. There are no insert/update/delete policies at all. Scoping the reads
-- here rather than in the client's query is what stops a hand-crafted request
-- from pulling another list's products.
drop policy if exists "authenticated users can read the product catalog" on public.product_catalog;
create policy "authenticated users can read the product catalog"
  on public.product_catalog for select
  to authenticated
  using (
    -- Global rows belong to nobody, so no list's deletion hides them.
    list_id is null
    or list_id in (select public.active_list_ids())
  );

-- Revoke first, then grant. The header of this file says "Clients never write
-- this table. RLS grants SELECT and nothing else" — production had INSERT, UPDATE,
-- DELETE and TRUNCATE granted to authenticated at provisioning, and only the
-- absence of a write policy made the sentence true (TRUNCATE would not even have
-- been stopped by a policy: it ignores RLS). See the long note at the end of
-- 003_lists_and_members.sql.
--
-- service_role is revoked here and re-granted at the bottom of this file, where
-- the seed script's and importer's write access is declared.
revoke all on public.product_catalog from anon, authenticated, service_role;

grant select on public.product_catalog to authenticated;

-- ─── the matching key ────────────────────────────────────────────────────────
-- The one authority on what a product's matching key is. normalizeSearchText()
-- in src/lib/productSearch.ts mirrors it on the query side, and the importer
-- vendors a byte-identical copy of that file: lowercase, strip
-- diacritics, collapse whitespace. Those two use NFD + \p{Diacritic}; unaccent is
-- dictionary-based and agrees with them across Latin text, which is all any of
-- the three ever sees. search_path includes extensions because unaccent/1
-- resolves its dictionary by name through it.
create or replace function public.product_search_text(p_name text, p_maker text default null)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select lower(
    regexp_replace(
      btrim(extensions.unaccent(
        btrim(p_name) || coalesce(' ' || nullif(btrim(p_maker), ''), '')
      )),
      '\s+', ' ', 'g'
    )
  );
$$;

-- Internal helper. The functions below are SECURITY DEFINER and owned by the same
-- role, so they keep their own EXECUTE; clients have no reason to call this.
revoke all on function public.product_search_text(text, text) from public, anon, authenticated;

-- ─── contribution and promotion ──────────────────────────────────────────────
-- The body, unthrottled. add_custom_product() below is the public entry point and
-- adds the rate limit; this is split out because a plpgsql function cannot be
-- "extended", and restating ninety lines of contribution and promotion logic
-- inside a throttled copy would be two things to keep in step.
--
-- Silently no-ops rather than raising for anything the caller cannot fix (not a
-- member, overlong text): this is fire-and-forget from the client and must never
-- surface an error on top of an add that already succeeded.
-- Adding p_barcode does not replace the three-argument function, it overloads
-- it: Postgres identifies a function by its argument list, so `create or
-- replace` with a new parameter leaves the old one in place — still granted,
-- still callable, and still writing rows without a barcode. Dropping it first is
-- what makes this a change rather than an addition. Safe to re-run: the drop is
-- guarded, and everything below recreates from scratch.
drop function if exists public.add_custom_product_unthrottled(uuid, text, text);

create or replace function public.add_custom_product_unthrottled(
  p_list_id uuid,
  p_name text,
  p_maker text default null,
  -- The code this product was scanned from, when the catalog had nothing for it.
  -- Null for anything typed in by hand.
  p_barcode text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- How many distinct accounts, in that many distinct lists, must contribute
  -- a product before it goes global. Low enough that genuinely common products
  -- graduate, high enough that one account's spelling (or a two-account
  -- coincidence) cannot drag junk in.
  promote_at constant integer := 3;

  -- Ceiling on distinct products one list may contribute, so a member cannot
  -- bloat the catalog. Far above any real list; only repeat adds to
  -- products already contributed are allowed past it.
  max_products constant integer := 500;

  v_user   text := requesting_user_id();
  v_name   text := btrim(p_name);
  v_maker  text := nullif(btrim(coalesce(p_maker, '')), '');
  -- Mirrors product_catalog_barcode_format rather than letting it raise, the
  -- same way the length checks below do. Anything that is not a barcode is
  -- simply not one: the product still gets contributed, it just carries no code.
  v_barcode text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_search text;
  v_contributors integer;
  v_lists integer;
  v_first  record;
  -- Kept separate from v_barcode, which is this caller's code. This one is what
  -- the scoped rows collectively agree on, and the two are only ever the same by
  -- coincidence.
  v_promote_barcode text;
begin
  if v_barcode is not null and v_barcode !~ '^[0-9]{8,14}$' then
    v_barcode := null;
  end if;

  if v_user is null or p_list_id is null then
    return;
  end if;

  -- Mirror this table's length checks instead of letting them raise.
  if v_name = '' or char_length(v_name) > 120 then
    return;
  end if;
  if v_maker is not null and char_length(v_maker) > 60 then
    return;
  end if;

  -- Contribute only to a list you are actually in. SECURITY DEFINER bypasses
  -- RLS, so this is the whole tenancy check.
  if not exists (
    select 1 from public.list_members fm
    where fm.list_id = p_list_id and fm.user_id = v_user
  ) then
    return;
  end if;

  v_search := public.product_search_text(v_name, v_maker);
  if v_search = '' or char_length(v_search) > 200 then
    return;
  end if;

  -- Serialize every contribution and promotion for this product key. Without it a
  -- promotion's delete can race a concurrent contribution from another list: the
  -- contribution re-inserts a scoped row just after the delete removed it, leaving
  -- that list looking at both the new global row and an orphaned scoped one.
  -- Transaction-scoped, so it releases on commit or rollback.
  perform pg_advisory_xact_lock(hashtext(v_search));

  -- Already global: nothing to contribute, so count the add against it the way
  -- bump_product_popularity would. Matching on search_text rather than name/maker
  -- means a differently-accented spelling still finds it.
  --
  -- v_barcode is deliberately dropped on this path rather than written to the
  -- global row. Writing it would let a single account attach a code to a product
  -- everyone sees, on nothing but their own say-so — scan a cola, name it
  -- "milk", and every list scanning that cola is offered milk. The
  -- promotion path below is the only way a code reaches a global row, and it
  -- gets there behind the same distinct-contributor gate that guards spellings.
  -- The cost is that a global product the importer never gave a code to stays
  -- unscannable, which is where it started.
  if exists (
    select 1 from public.product_catalog
    where list_id is null and search_text = v_search
  ) then
    update public.product_catalog
    set add_count = add_count + 1
    where list_id is null and search_text = v_search;
    return;
  end if;

  -- Refuse a brand-new product once the list is at its ceiling; a repeat add to
  -- a product they already contributed still goes through (it is not a new row).
  if not exists (
    select 1 from public.product_catalog
    where list_id = p_list_id and search_text = v_search
  ) and (
    select count(*) from public.product_catalog where list_id = p_list_id
  ) >= max_products then
    return;
  end if;

  -- Contribute, or count a repeat add if this list already contributed it.
  -- contributed_by records who first added it and is left untouched on the repeat
  -- (do update only bumps add_count). base_weight stays 0: that column belongs to
  -- the seed script, so earned usage has to live in add_count or the next
  -- re-seed would wipe it.
  -- The barcode is filled in but never overwritten: a product first typed by
  -- hand and later scanned gains its code, and a second scan reporting something
  -- different cannot take the first one's place. Scoped rows are not covered by
  -- the barcode unique index (it is partial on list_id is null), so nothing
  -- here can conflict.
  insert into public.product_catalog as pc
    (name, maker, search_text, list_id, contributed_by, base_weight, add_count, source, barcode)
  values (v_name, v_maker, v_search, p_list_id, v_user, 0, 1, 'community', v_barcode)
  on conflict (list_id, search_text) where list_id is not null
  do update set add_count = pc.add_count + 1,
                barcode = coalesce(pc.barcode, excluded.barcode);

  -- Both counts, and both have to clear the bar: three distinct accounts, spread
  -- over three distinct lists. They defeat different abuses, and neither
  -- alone is the rule.
  --
  -- Accounts is what stops one person who belongs to three lists typing the
  -- same junk into all three (test 7i). Lists is what stops three accounts
  -- one person controls doing it from inside a single list.
  --
  -- That second one is, today, already impossible: product_catalog_list_search
  -- is unique on (list_id, search_text), so a list holds at most one
  -- scoped row per product, and three distinct contributed_by therefore cannot
  -- come from fewer than three lists. It is counted anyway. The property the
  -- header promises should be readable here rather than inferred from an index two
  -- hundred lines up, and relaxing that index later must break this rule loudly
  -- instead of quietly widening what reaches every list's suggestions.
  select count(distinct pc.contributed_by), count(distinct pc.list_id)
    into v_contributors, v_lists
  from public.product_catalog pc
  where pc.list_id is not null and pc.search_text = v_search;

  if v_contributors < promote_at or v_lists < promote_at then
    return;
  end if;

  -- Promote. The first contributor's spelling wins; the rows all share a
  -- search_text, so they differ only in case, accents, or spacing anyway.
  select name, maker into v_first
  from public.product_catalog
  where list_id is not null and search_text = v_search
  order by created_at, id
  limit 1;

  -- Which barcode, if any, the promoted row should carry: the one the scoped
  -- rows agree on, meaning a single distinct value among those that carry a code
  -- at all. Contributors who typed the name without scanning are not counted as
  -- dissent — they said nothing about the code — so one scanner and two typists
  -- promote that scanner's code unopposed.
  --
  -- So agreement resolves CONFLICTING scans; it is not what stops a bad one.
  -- That job belongs to promote_at above: a code cannot reach a global row
  -- without three distinct accounts having contributed the name it rides on,
  -- the same gate the spelling has to clear. One person who scanned the wrong
  -- package cannot promote anything on their own.
  --
  -- When two contributors did scan different packages the product still gets
  -- promoted; it just arrives without a code, exactly as a typed one would.
  select case when count(distinct barcode) = 1 then min(barcode) end
    into v_promote_barcode
  from public.product_catalog
  where list_id is not null and search_text = v_search and barcode is not null;

  -- Collapse the scoped rows into one global in a single statement, carrying
  -- their add_counts so the product arrives ranked by the usage it earned rather
  -- than at zero. Leaving the scoped rows would show their lists the same
  -- product twice.
  --
  -- ON CONFLICT folds the carried count into an existing global instead of
  -- dropping it. The advisory lock does not cover the seed script (service role,
  -- no lock), so a seed can insert this global between the "already global?"
  -- check above and this insert; without the DO UPDATE the delete would still
  -- fire and the earned counts would just vanish.
  --
  -- Each list's share is capped at promote_at, for calibration as much as for
  -- abuse: seeded base_weight is 10 for an ordinary product and 100 for a staple,
  -- so an uncapped sum would let one list re-adding a niche product outrank
  -- bottled water for everyone.
  with scoped as (
    delete from public.product_catalog
    where list_id is not null and search_text = v_search
    returning add_count
  )
  insert into public.product_catalog
    (name, maker, search_text, list_id, base_weight, add_count, source)
  select v_first.name, v_first.maker, v_search, null::uuid, 0,
         coalesce(sum(least(add_count, promote_at)), 0)::integer, 'community'
  from scoped
  on conflict (search_text) where list_id is null
  do update set add_count = public.product_catalog.add_count + excluded.add_count;

  -- The code goes on afterwards, in its own block, and never as part of the
  -- insert above. product_catalog_global_barcode is unique across globals, so a
  -- code another global already claims would raise — and this function is
  -- fire-and-forget from the client, called after an add that has already
  -- succeeded, so it must not. Promotion is the outcome that matters; the scan
  -- shortcut is a bonus, and losing it costs the user nothing they had.
  if v_promote_barcode is not null then
    begin
      update public.product_catalog
      set barcode = v_promote_barcode
      where list_id is null and search_text = v_search and barcode is null;
    exception when unique_violation then
      null;
    end;
  end if;
end;
$$;

-- Not callable by a client, which is the whole point of splitting it out.
--
-- This is a deliberate behaviour change from the schema this file replaces, and
-- the one place the consolidation is not a pure restatement. Previously the
-- throttle was retrofitted by RENAMING the granted function
-- (`alter function add_custom_product rename to add_custom_product_unthrottled`)
-- and creating a wrapper over it. A rename carries the function's grants with
-- it, and `revoke ... from public` does not touch a grant held explicitly by
-- `authenticated` — so the unthrottled function stayed directly callable by any
-- signed-in user, and the 120/hour limit was one RPC name away from being
-- bypassed entirely. Defining the inner function outright, never granting it, is
-- what closes that.
revoke all on function public.add_custom_product_unthrottled(uuid, text, text, text) from public, anon, authenticated;

-- Dropped for the same reason the inner function is: the three-argument version
-- is granted to `authenticated`, and leaving it behind would leave a second,
-- barcode-less entry point in place with its grant intact.
drop function if exists public.add_custom_product(uuid, text, text);

-- The public entry point: 120 contributions per hour, then silence.
create or replace function public.add_custom_product(
  p_list_id uuid,
  p_name text,
  p_maker text default null,
  p_barcode text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.rate_limit_hit('catalog_contribute', 120, interval '1 hour') then
    return;
  end if;
  perform public.add_custom_product_unthrottled(p_list_id, p_name, p_maker, p_barcode);
end;
$$;

revoke all on function public.add_custom_product(uuid, text, text, text) from public, anon;
grant execute on function public.add_custom_product(uuid, text, text, text) to authenticated;

-- ─── popularity ──────────────────────────────────────────────────────────────
-- Count one add against a product without opening the table to client writes.
-- Matches the way the app's merge key does — case/space-insensitive name +
-- maker — so a null and an empty maker are treated alike. An unknown product is
-- a silent no-op.
--
-- The scope matters now that a name+maker can exist in more than one list. The
-- add happened in exactly one list (p_list_id), so bump only that list's
-- row and any global it matches — never the same product the caller happens to
-- have contributed in a *different* list they belong to, which would inflate
-- that list's count toward a promotion the add never earned.
--
-- 240 bumps per hour. A person adding groceries fires one per item; a busy shop
-- is a few dozen. A script inflating a global ranking needs thousands, and the
-- gap between those two numbers is the whole point.
create or replace function public.bump_product_popularity(
  p_name text,
  p_maker text default null,
  p_list_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user text := requesting_user_id();
begin
  if public.rate_limit_hit('catalog_bump', 240, interval '1 hour') then
    return;
  end if;

  update public.product_catalog pc
  set add_count = pc.add_count + 1
  where lower(btrim(pc.name)) = lower(btrim(p_name))
    and lower(btrim(coalesce(pc.maker, ''))) = lower(btrim(coalesce(p_maker, '')))
    and (
      pc.list_id is null
      or (
        pc.list_id = p_list_id
        and exists (
          select 1 from public.list_members fm
          where fm.list_id = p_list_id and fm.user_id = v_user
        )
      )
    );
end;
$$;

revoke all on function public.bump_product_popularity(text, text, uuid) from public, anon;
grant execute on function public.bump_product_popularity(text, text, uuid) to authenticated;

-- ─── searching the catalog ───────────────────────────────────────────────────
-- What the client used to do: one `ilike '%' || query || '%'` over search_text.
-- Two things were wrong with it, and neither is about how many rows there are.
--
-- Word order was load-bearing. The pattern is one contiguous substring, so
-- "borsec apa" found nothing that "apa borsec" found. Every token is matched
-- separately here, in any order.
--
-- And it could only ever match the language a product was named in. The app
-- speaks six; the catalog is largely Romanian. Matching search_blob brings the
-- category aliases in, so "water" and "wasser" both reach "Apă minerală Borsec".
--
-- SECURITY DEFINER, like add_custom_product() and bump_product_popularity().
-- Not for the writes — this only reads — but because tokenizing means calling
-- product_search_text(), and EXECUTE on that is revoked from authenticated.
-- Granting it instead would put the merge-key function in reach of every
-- client. That choice has a cost: RLS does not run for a definer function, so
-- the list scoping below is doing real work rather than restating the
-- policy, and p_list_id is verified rather than believed.
create or replace function public.search_catalog(
  p_query        text,
  p_list_id uuid default null,
  p_limit        integer default 100
)
returns table (name text, maker text, popularity integer)
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  -- Bounded so a pasted paragraph cannot become a hundred-way AND. Six is
  -- already far more words than anyone types into an add-item box.
  max_tokens constant integer := 6;

  -- At or below this length a token must match at the START OF A WORD; above
  -- it, anywhere in search_text still counts. A three-letter query lands in
  -- the middle of unrelated words far too easily — "apa" (water) matched
  -- p-APA-s, ce-APA and APA-rate in production. The same rule and the same
  -- number as the catalog project's search_catalog; the two have to agree.
  short_token constant integer := 4;

  v_patterns  text[];
  v_primary   text;
  v_rest      text[];
  v_word_pats text[];
  v_list uuid := null;
  v_limit     integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  -- Fold the query exactly the way search_text was folded, so "Apă" and "apa"
  -- are the same search. There is one authority for that and this is a caller
  -- of it, not a second copy.
  --
  -- Escaping matters even after folding: product_search_text lowercases and
  -- strips accents but leaves % and _ alone, so without this a typed underscore
  -- matches any character and a typed % matches the entire catalog.
  select array_agg(
           '%' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           order by char_length(tok) desc
         )
    into v_patterns
  from (
    select tok
    from regexp_split_to_table(
      public.product_search_text(coalesce(p_query, ''), null), '\s+'
    ) as tok
    where tok <> ''
    limit max_tokens
  ) t;

  if v_patterns is null then
    return;
  end if;

  -- Longest token first: it is the most selective, and it is the one predicate
  -- the trigram index drives from. The rest filter what it returns. Written as
  -- one indexable LIKE plus a quantified ALL rather than an AND chain built by
  -- string concatenation, so no SQL is assembled from user input at all.
  v_primary := v_patterns[1];
  v_rest    := v_patterns[2:];

  -- One pattern per SHORT token, anchored to the start of a word.
  --
  -- No regex: search_blob is space-separated folded text, so "starts a word"
  -- is exactly "preceded by a space" once a leading space is prepended to the
  -- blob below. That reuses the LIKE escaping above rather than introducing a
  -- second escaping language whose metacharacters differ.
  select array_agg(
           '% ' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         )
    into v_word_pats
  from (
    select tok
    from regexp_split_to_table(
      public.product_search_text(coalesce(p_query, ''), null), '\s+'
    ) as tok
    where tok <> '' and char_length(tok) <= short_token
    limit max_tokens
  ) t;

  -- Membership checked, not assumed. A list id arriving here came from
  -- client state, and the RLS policy that would otherwise reject a forged one
  -- does not run for a definer function. Resolving it to null on a miss means a
  -- bad id degrades to the global catalog rather than erroring.
  if p_list_id is not null then
    select hm.list_id
      into v_list
    from public.list_members hm
    where hm.list_id = p_list_id
      and hm.user_id = public.requesting_user_id()
    limit 1;
  end if;

  return query
  select pc.name, pc.maker, pc.popularity
  from public.product_catalog pc
  where (pc.list_id is null or pc.list_id = v_list)
    and pc.search_blob like v_primary
    and pc.search_blob like all (v_rest)
    -- Null when every token was long enough to be trusted anywhere.
    and (v_word_pats is null or (' ' || pc.search_blob) like all (v_word_pats))
  -- This list's own contributions first, then popularity.
  --
  -- Without the first term they compete on popularity against the whole global
  -- catalog and lose every time: a contributed row starts at base_weight 0 and
  -- earns add_count one tap at a time, so at this catalog's size a list's
  -- own "Olive Oil" never reaches a pool filled by globally-popular strangers.
  -- The client's matchListStats already recovers products they have BOUGHT
  -- recently; this covers the ones they typed in and have not bought yet.
  --
  -- A list is capped at 500 contributed products, so this can crowd out
  -- globals only for somebody who contributed hundreds of matches for one
  -- query — at which point those are the rows they meant.
  order by (pc.list_id is not null) desc, pc.popularity desc, pc.name
  limit v_limit;
end;
$$;

revoke all on function public.search_catalog(text, uuid, integer) from public, anon;
grant execute on function public.search_catalog(text, uuid, integer) to authenticated;

-- ─── bulk import ─────────────────────────────────────────────────────────────
-- Load a batch of externally-sourced products into the global catalog.
--
-- WHY THIS IS AN RPC AND NOT supabase-js .upsert()
--
-- PostgREST can only infer ON CONFLICT against a *total* unique constraint. Of
-- the three keys that govern a global row, only
-- product_catalog_name_maker_list_unique qualifies —
-- product_catalog_global_search and product_catalog_global_barcode are both
-- partial indexes, and `.upsert({ onConflict: 'barcode' })` against either fails
-- at runtime with "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification". If a later change ever "simplifies" this back to a
-- client-side upsert, that is the error it will produce.
--
-- WHAT IT GUARANTEES
--
-- 1. search_text is computed here, by product_search_text(). The database stays
--    the sole authority on the matching key, so the importer's own copy of the
--    normalizer can only affect its client-side collapsing and can never
--    disagree with the unique index.
-- 2. An import may never change the name, maker, base_weight, or source of a row
--    whose source is not this import's source. Curated wins, always. A curated
--    row gets the upstream barcode filled in for free and keeps everything else.
-- 3. add_count is never written, with exactly one exception — the final step,
--    which folds already-earned counts off scoped rows the import supersedes.
--    Earned usage survives every re-import.
--
-- SECURITY DEFINER, so the body always runs as this function's owner whatever
-- role called it. Two concrete failures forced that, both invisible to a test
-- suite running as superuser because superusers bypass privilege checks:
--   1. As INVOKER the body ran as service_role, which has no EXECUTE on
--      product_search_text, so every real import died with "permission denied".
--   2. The staging table is created by whoever calls, so a second call from a
--      different role in the same session cannot drop the first one's table.
create or replace function public.import_catalog_products(
  p_rows           jsonb,
  p_source         text default 'openfoodfacts',
  p_source_version text default null,
  p_dry_run        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- Same cap add_custom_product_unthrottled() uses when it folds scoped counts
  -- into a global, for the same reason: one enthusiastic list must not outrank
  -- the editorial baseline on its own.
  promote_at constant integer := 3;

  v_key                text;
  v_skipped_invalid    integer := 0;
  v_deduped            integer := 0;
  v_batch_dup_barcode  integer := 0;
  v_skipped_barcode    integer := 0;
  v_inserted           integer := 0;
  v_updated_imported   integer := 0;
  v_updated_provenance integer := 0;
  v_collapsed_scoped   integer := 0;
begin
  -- 'curated' belongs to the seed and 'community' to add_custom_product().
  -- Refusing them here keeps this from being the back door that lets an import
  -- launder itself into a provenance it did not earn. The list is the import
  -- subset of product_catalog_source_check, and has to be widened alongside it.
  if coalesce(p_source, '') not in
     ('openfoodfacts', 'openproductsfacts', 'openbeautyfacts') then
    raise exception 'import_catalog_products: p_source must be an import source, got %',
      coalesce(p_source, '<null>');
  end if;

  -- Dropped explicitly rather than relying on ON COMMIT DROP: the pgTAP suite
  -- runs every call inside one transaction, so a second call in the same
  -- transaction would otherwise collide with the first call's table.
  -- Unqualified on purpose: pg_temp is implicitly searched first for relation
  -- names even though it is not named in this function's search_path.
  drop table if exists catalog_import_staging;
  drop table if exists catalog_import_inserted;

  create temp table catalog_import_staging on commit drop as
  select
    nullif(btrim(coalesce(r.barcode, '')), '')            as barcode,
    btrim(coalesce(r.name, ''))                           as name,
    nullif(btrim(coalesce(r.maker, '')), '')              as maker,
    greatest(0, coalesce(r.base_weight, 0))               as base_weight,
    nullif(btrim(coalesce(r.source_ref, r.barcode, '')), '') as source_ref,
    -- Folded here rather than trusted: the importer normalizes these already,
    -- but search_aliases feeds a LIKE and a hand-assembled batch must be held to
    -- the same shape as search_text.
    nullif(left(public.product_search_text(
      coalesce(r.search_aliases, ''), null
    ), 400), '')                                          as search_aliases,
    public.product_search_text(
      btrim(coalesce(r.name, '')),
      nullif(btrim(coalesce(r.maker, '')), '')
    )                                                     as search_text
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
    as r(barcode text, name text, maker text, base_weight integer,
         source_ref text, search_aliases text);

  -- Mirror the table's own checks instead of letting them raise mid-chunk. A
  -- logged drop of one bad row beats losing the other 499.
  delete from catalog_import_staging
  where name = ''
     or char_length(name) > 120
     or (maker is not null and char_length(maker) > 60)
     or search_text is null
     or search_text = ''
     or char_length(search_text) > 200
     or base_weight > 1000000
     or (barcode is not null and barcode !~ '^[0-9]{8,14}$');
  get diagnostics v_skipped_invalid = row_count;

  -- Collapse rows that normalize alike. The importer does this too and picks the
  -- winner the same way (highest base_weight, then lowest barcode); repeating it
  -- here means the two can never disagree, and that a hand-assembled batch is
  -- held to the same rule.
  delete from catalog_import_staging s
  where s.ctid <> (
    select s2.ctid from catalog_import_staging s2
    where s2.search_text = s.search_text
    order by s2.base_weight desc, s2.barcode asc nulls last
    limit 1
  );
  get diagnostics v_deduped = row_count;

  -- Same again for one barcode appearing under two different names in a single
  -- batch, which product_catalog_global_barcode would reject. Counted as dedupe
  -- rather than conflict: nothing outside this batch was involved.
  delete from catalog_import_staging s
  where s.barcode is not null and s.ctid <> (
    select s2.ctid from catalog_import_staging s2
    where s2.barcode = s.barcode
    order by s2.base_weight desc, s2.search_text asc
    limit 1
  );
  get diagnostics v_batch_dup_barcode = row_count;
  v_deduped := v_deduped + v_batch_dup_barcode;

  -- A barcode already held by a *different* global. Upstream catalogs contain
  -- reused and mistyped codes, so this is routine rather than an error — but it
  -- is silent data loss if it goes uncounted, hence skipped_barcode_conflict in
  -- the report.
  delete from catalog_import_staging s
  using public.product_catalog pc
  where s.barcode is not null
    and pc.list_id is null
    and pc.barcode = s.barcode
    and pc.search_text <> s.search_text;
  get diagnostics v_skipped_barcode = row_count;

  -- Serialize against add_custom_product_unthrottled(), which takes the same lock
  -- on the same hash. Ordered, so an import and a promotion running at once can
  -- never deadlock by grabbing two keys in opposite orders.
  for v_key in
    select distinct search_text from catalog_import_staging order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(v_key));
  end loop;

  if p_dry_run then
    -- A separate read-only branch rather than a rollback, so a dry run can never
    -- partially apply.
    select
      count(*) filter (where g.id is null),
      count(*) filter (where g.id is not null and g.source = p_source),
      count(*) filter (where g.id is not null and g.source <> p_source)
    into v_inserted, v_updated_imported, v_updated_provenance
    from catalog_import_staging s
    left join public.product_catalog g
      on g.list_id is null and g.search_text = s.search_text;

    select count(*) into v_collapsed_scoped
    from public.product_catalog pc
    join catalog_import_staging s on s.search_text = pc.search_text
    where pc.list_id is not null
      and not exists (
        select 1 from public.product_catalog g
        where g.list_id is null and g.search_text = s.search_text
      );
  else
    -- Rows this import already owns: fully refreshed, because a better normalizer
    -- or a newer dump is exactly why you re-run. name and maker can only differ
    -- here in case, accents, or spacing — anything more would have changed
    -- search_text and so would not have joined.
    update public.product_catalog pc
    set name           = s.name,
        maker          = s.maker,
        base_weight    = s.base_weight,
        barcode        = coalesce(s.barcode, pc.barcode),
        source_ref     = coalesce(s.source_ref, pc.source_ref),
        search_aliases = s.search_aliases,
        source_version = coalesce(p_source_version, pc.source_version)
    from catalog_import_staging s
    where pc.list_id is null
      and pc.source = p_source
      and pc.search_text = s.search_text;
    get diagnostics v_updated_imported = row_count;

    -- Rows this import does not own: provenance only, and only where it is
    -- missing. This single statement is guarantee 2 above. A curated product
    -- gains the upstream barcode — useful later for scanning — and keeps its
    -- editorial name, weight, and source.
    update public.product_catalog pc
    set barcode        = coalesce(pc.barcode, s.barcode),
        source_ref     = coalesce(pc.source_ref, s.source_ref),
        -- Additive, like the barcode beside it: a curated row gains search
        -- terms it had none of, and never loses the ones it has. Its name,
        -- weight and source stay untouched, which is guarantee 2.
        search_aliases = coalesce(pc.search_aliases, s.search_aliases)
    from catalog_import_staging s
    where pc.list_id is null
      and pc.source <> p_source
      and pc.search_text = s.search_text
      and (pc.barcode is null or pc.source_ref is null or pc.search_aliases is null)
      and (s.barcode is not null or s.source_ref is not null
           or s.search_aliases is not null);
    get diagnostics v_updated_provenance = row_count;

    create temp table catalog_import_inserted (search_text text primary key) on commit drop;

    with ins as (
      insert into public.product_catalog
        (name, maker, search_text, search_aliases, list_id, base_weight,
         barcode, source, source_ref, source_version)
      select s.name, s.maker, s.search_text, s.search_aliases, null::uuid,
             s.base_weight, s.barcode, p_source, s.source_ref, p_source_version
      from catalog_import_staging s
      where not exists (
        select 1 from public.product_catalog pc
        where pc.list_id is null and pc.search_text = s.search_text
      )
      on conflict (search_text) where list_id is null do nothing
      returning search_text
    )
    insert into catalog_import_inserted (search_text)
    select search_text from ins;
    get diagnostics v_inserted = row_count;

    -- A list may have contributed this product before it was imported. Their
    -- scoped row and the new global read as the same product twice, forever, so
    -- collapse them the way a promotion would — and carry the counts they earned,
    -- capped per list. This is the sole exception to "add_count is never
    -- written", and it only ever adds counts that already existed.
    with scoped as (
      delete from public.product_catalog pc
      using catalog_import_inserted i
      where pc.list_id is not null
        and pc.search_text = i.search_text
      returning pc.search_text, pc.add_count
    ),
    folded as (
      select search_text,
             sum(least(add_count, promote_at))::integer as carried,
             count(*)::integer as scoped_rows
      from scoped
      group by search_text
    ),
    applied as (
      update public.product_catalog pc
      set add_count = pc.add_count + f.carried
      from folded f
      where pc.list_id is null and pc.search_text = f.search_text
      returning f.scoped_rows
    )
    select coalesce(sum(scoped_rows), 0)::integer into v_collapsed_scoped from applied;
  end if;

  return jsonb_build_object(
    'inserted',                 v_inserted,
    'updated_imported',         v_updated_imported,
    'updated_provenance_only',  v_updated_provenance,
    'skipped_invalid',          v_skipped_invalid,
    'skipped_barcode_conflict', v_skipped_barcode,
    'deduped',                  v_deduped,
    'collapsed_scoped',         v_collapsed_scoped,
    'source',                   p_source,
    'source_version',           p_source_version,
    'dry_run',                  p_dry_run
  );
end;
$$;

revoke all on function public.import_catalog_products(jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.import_catalog_products(jsonb, text, text, boolean) to service_role;

-- The seed script and the importer both reach this table directly (the importer
-- reads it to build its load diff), so the service role needs more than the RPC
-- gives it. Same reasoning as the authenticated grants elsewhere: hosted projects
-- get these at provisioning, a database built from migrations alone does not.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.product_catalog to service_role;
