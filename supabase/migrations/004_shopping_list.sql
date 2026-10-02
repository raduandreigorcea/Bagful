-- ─── the shopping list ───────────────────────────────────────────────────────
-- The active list itself, and the rules its rows obey.
--
-- Two things worth knowing up front. First, the list carries no author identity:
-- rows store added_by (a Clerk user id) and nothing else, and the UI resolves the
-- name and avatar from profiles at render time, so a changed Clerk photo shows up
-- on every existing item at once.
--
-- Second, a checked item is still a row on this table. Checking is a state, not a
-- removal — buy_items() (005_purchase_history.sql) is the only thing that moves
-- rows off the list, and it archives them as it goes.

create table if not exists public.shopping_list_items (
  id          uuid        primary key default gen_random_uuid(),
  list_id   uuid        not null references public.lists(id) on delete cascade,
  name        text        not null,
  -- The catalog product's maker ("Dorna"), shown as a subtitle. Part of the merge
  -- key below: the same name from two makers is two different products.
  maker       text,
  quantity    integer     not null default 1,
  checked     boolean     not null default false,
  -- When the item was checked. Stamped server-side by the trigger below, so the
  -- ordering key cannot be forged by a client and is consistent across devices.
  checked_at  timestamptz,
  added_by    text        not null,   -- Clerk user ID
  created_at  timestamptz not null default now(),
  constraint shopping_list_items_name_length_check
    check (char_length(btrim(name)) between 1 and 120),
  constraint shopping_list_items_maker_length_check
    check (maker is null or char_length(maker) between 1 and 60),
  constraint shopping_list_items_quantity_check
    check (quantity between 1 and 999)
);

-- Restated as an explicit ALTER for the reason 003 spells out at length:
-- everything inside `create table if not exists` is skipped wherever the table
-- already exists, so the ceiling added above reaches new databases only.
--
-- The ceiling itself: the floor was always here, but nothing above it was, so a
-- hand-crafted request could park 2,147,483,647 on a shared row — mischief
-- inside one's own list rather than a breach, and still not a number any
-- list should be able to hold. 999 rather than the stepper's 99
-- (ITEM_QUANTITY_MAX in src/lib/limits.ts) because that cap is a product
-- decision and merges legitimately sum quantities past it; this bound only has
-- to exclude the absurd.
alter table public.shopping_list_items drop constraint if exists shopping_list_items_quantity_check;
alter table public.shopping_list_items add constraint shopping_list_items_quantity_check
  check (quantity between 1 and 999);

alter table public.shopping_list_items enable row level security;

-- ─── one active row per product ──────────────────────────────────────────────
-- Adding something already on the list bumps its quantity rather than creating a
-- second row, and this index is what makes that guarantee real against two
-- devices adding at once — the loser gets a 23505 and the client folds its
-- quantity into the winning row.
--
-- Scoped to unchecked rows only: re-adding something already bought should start
-- a fresh active item, not resurrect the checked one. Matching is
-- case/whitespace-insensitive and includes the maker, mirroring
-- normalizeItemName() and findActiveItemByName() in src/lib/shoppingList.ts.
create unique index if not exists shopping_list_items_unique_active_name
  on public.shopping_list_items (
    list_id,
    lower(btrim(name)),
    lower(btrim(coalesce(maker, '')))
  )
  where checked = false;

-- Serves the two list reads (unchecked, then checked) the app issues on load.
create index if not exists idx_shopping_list_items_list_id_checked
  on public.shopping_list_items (list_id, checked);

-- ─── policies ────────────────────────────────────────────────────────────────
-- Membership is the whole rule: you may read, add, change and remove items in
-- any list you belong to. Insert additionally pins added_by to the caller, and
-- the ownership trigger below stops an update rewriting it afterwards.
drop policy if exists "list members can read items" on public.shopping_list_items;
create policy "list members can read items"
  on public.shopping_list_items for select
  using (
    list_id in (select public.active_list_ids())
  );

drop policy if exists "list members can insert items" on public.shopping_list_items;
create policy "list members can insert items"
  on public.shopping_list_items for insert
  with check (
    added_by = requesting_user_id()
    and list_id in (select public.active_list_ids())
  );

-- WITH CHECK keeps the row inside the caller's lists; the trigger below pins
-- added_by and list_id, which a WITH CHECK expression cannot do because it
-- cannot compare old against new.
drop policy if exists "list members can update items" on public.shopping_list_items;
create policy "list members can update items"
  on public.shopping_list_items for update
  using (
    list_id in (select public.active_list_ids())
  )
  with check (
    list_id in (select public.active_list_ids())
  );

drop policy if exists "list members can delete items" on public.shopping_list_items;
create policy "list members can delete items"
  on public.shopping_list_items for delete
  using (
    list_id in (select public.active_list_ids())
  );

-- ─── row rules the policies cannot express ───────────────────────────────────

-- An item's author and its list are fixed at insert.
create or replace function public.prevent_item_ownership_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.added_by is distinct from old.added_by then
    raise exception 'Item creator cannot be changed.'
      using errcode = 'P0001';
  end if;

  if new.list_id is distinct from old.list_id then
    raise exception 'Item cannot be moved between lists.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Own checked_at entirely, ignoring whatever the client sends: stamp now() the
-- moment an item becomes checked, clear it on uncheck, and leave an existing
-- stamp alone on an unrelated update to a still-checked row (a quantity change
-- must not bump it to the top of the checked list).
create or replace function public.stamp_item_checked_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(new.checked, false) then
    if tg_op = 'INSERT' or coalesce(old.checked, false) = false then
      new.checked_at := now();
    else
      new.checked_at := old.checked_at;
    end if;
  else
    new.checked_at := null;
  end if;
  return new;
end;
$$;

-- The per-member active-item cap, at the database layer so race conditions or
-- stale client state cannot bypass the UI's own check
-- (countActiveItemsByMember in src/lib/shoppingList.ts).
create or replace function public.enforce_member_active_item_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_count integer;
  member_limit integer;
begin
  -- Only active (unchecked) items count.
  if coalesce(new.checked, false) = true then
    return new;
  end if;

  -- On UPDATE, only enforce when the row is newly becoming active (an uncheck).
  -- A row that was already active being updated for some other reason (e.g. a
  -- quantity change) is already counted below, so enforcing here would reject it
  -- the moment the list sits exactly at the cap.
  if tg_op = 'UPDATE' and coalesce(old.checked, false) = false then
    return new;
  end if;

  select coalesce(f.max_items_per_member, 50)
    into member_limit
  from public.lists f
  where f.id = new.list_id;

  -- If the list row is missing, let the FK constraint produce the canonical error.
  if member_limit is null then
    return new;
  end if;

  select count(*)::integer
    into current_count
  from public.shopping_list_items sli
  where sli.list_id = new.list_id
    and sli.added_by = new.added_by
    and sli.checked = false;

  if current_count >= member_limit then
    raise exception 'You reached your limit of % active items.', member_limit
      using errcode = 'P0001',
            detail = 'member_active_item_limit_exceeded';
  end if;

  return new;
end;
$$;

-- The cap above is breadth: how many active items a member may hold at once.
-- This is rate: how fast they may create them. The two are different rules and
-- only one of them was here — under the cap alone an account can add, check out
-- and re-add forever, and every insert fires the push fan-out in
-- supabase/functions/push-on-item-insert, so uncapped insert rate is also
-- uncapped notification volume at everyone else in the list.
--
-- A trigger rather than an RPC because the list has several write paths — the
-- direct insert in addItem(), the offline queue's replay
-- (src/lib/offlineQueue.ts), and the 23505 merge after a lost race. A trigger
-- sees all of them, including ones not written yet.
--
-- 300 per hour. Calibrated against the ceiling above it: a member may hold 50
-- active items, so a full list plus a checkout plus a full re-add is 100
-- inserts, and an offline queue flush after a long trip replays as one burst.
-- Deliberately far looser than the catalog limiters in 006 (120 and 240/hour):
-- those guard a ranking every list sees, where one account's repetition is the
-- whole attack. This guards a list's own list, where a false positive costs a
-- real person a grocery item, so it errs toward letting the shopper shop.
--
-- SECURITY DEFINER because rate_limit_hit() (002_security_audit.sql) is granted
-- to no client role; the trigger runs as the owner, which holds the execute.
create or replace function public.enforce_item_insert_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  insert_limit  constant integer  := 300;
  window_length constant interval := interval '1 hour';
  v_actor text := requesting_user_id();
  v_hits  integer;
begin
  -- No JWT means no client: the seed path, the service role and the pgTAP suite
  -- all insert with no claims set. rate_limit_hit() refuses an actorless caller
  -- outright (it returns true — "no budget"), which would otherwise turn every
  -- superuser seed into a failure. RLS already governs whether an
  -- unauthenticated insert may happen at all.
  if v_actor is null then
    return new;
  end if;

  if not public.rate_limit_hit('item_insert', insert_limit, window_length) then
    return new;
  end if;

  -- Over the limit. Now the part that is not obvious.
  --
  -- rate_limit_hit() logs the crossing to security_events on the call where hits
  -- reaches limit + 1. That INSERT is in *this* transaction, so raising here
  -- would roll it back along with the rejected item — the throttle would fire
  -- forever and leave no trace of having fired. 003_lists_and_members.sql
  -- hits the same wall in the invite throttle and answers it by returning
  -- quietly instead of raising; a trigger has no such option, because letting
  -- the insert through IS the thing being prevented.
  --
  -- So the crossing call is allowed to commit and everything after it is
  -- rejected. The counter row rate_limit_hit() just wrote tells the two apart.
  -- One item over the ceiling per window buys an audit trail that actually
  -- records the ceiling being hit, which is the whole reason it exists. Note
  -- this also means the counter never climbs past limit + 1: a rejected insert
  -- rolls its own increment back, so the persisted count is the number of
  -- inserts that actually landed.
  select rl.hits
    into v_hits
  from public.rate_limit_counters rl
  where rl.actor = v_actor
    and rl.kind = 'item_insert'
    and rl.window_start = date_bin(window_length, now(), timestamptz 'epoch');

  if coalesce(v_hits, 0) <= insert_limit + 1 then
    return new;
  end if;

  -- The detail string is the client's cue: src/lib/shoppingListActions.ts shows
  -- a "slow down" message on it rather than the generic add failure, and
  -- src/lib/offlineQueue.ts treats it as retryable so a throttled replay is kept
  -- rather than dropped as a permanent rejection.
  raise exception 'Too many items added in a short time. Try again shortly.'
    using errcode = 'P0001',
          detail = 'item_insert_rate_limit_exceeded';
end;
$$;

revoke all on function public.enforce_item_insert_rate_limit() from public, anon, authenticated;

drop trigger if exists trg_prevent_item_ownership_change on public.shopping_list_items;
create trigger trg_prevent_item_ownership_change
before update on public.shopping_list_items
for each row
execute function public.prevent_item_ownership_change();

drop trigger if exists trg_stamp_item_checked_at on public.shopping_list_items;
create trigger trg_stamp_item_checked_at
before insert or update on public.shopping_list_items
for each row
execute function public.stamp_item_checked_at();

-- INSERT and UPDATE both: unchecking an item makes it active again, which must
-- count against the cap the same way adding one does.
drop trigger if exists trg_enforce_member_active_item_limit on public.shopping_list_items;
create trigger trg_enforce_member_active_item_limit
before insert or update on public.shopping_list_items
for each row
execute function public.enforce_member_active_item_limit();

-- INSERT only: the rate ceiling is about creating rows, and unchecking one is
-- already governed by the breadth cap above. BEFORE triggers fire in name order,
-- so this runs ahead of trg_enforce_member_active_item_limit — deliberate but
-- not load-bearing, because a row rejected by either rolls the whole transaction
-- back, counter increment included, so an insert refused for being over the
-- 50-item cap costs no rate budget whichever runs first.
drop trigger if exists trg_enforce_item_insert_rate_limit on public.shopping_list_items;
create trigger trg_enforce_item_insert_rate_limit
before insert on public.shopping_list_items
for each row
execute function public.enforce_item_insert_rate_limit();

-- Revoke then grant, so the end state is exactly these two lines and not these
-- plus the provisioning defaults — TRUNCATE among them, which ignores RLS. The
-- long note at the end of 003_lists_and_members.sql explains the whole thing.
-- buy_items() deletes from this table as its owner, so service_role needs no
-- write privilege of its own.
revoke all on public.shopping_list_items from anon, authenticated, service_role;

grant select, insert, update, delete on public.shopping_list_items to authenticated;
grant select on public.shopping_list_items to service_role;

-- ─── merging a row into its twin ─────────────────────────────────────────────
-- Unticking a row whose name is already active folds it into that active row
-- (the unique index above forbids two). The app used to do that as two writes,
-- the quantity and then the delete, with a hand-written undo when the second
-- failed; a lost undo left the quantity counted twice. One function, one
-- transaction: both land or neither does.
--
-- SECURITY INVOKER, so the caller's own update and delete policies decide it,
-- exactly as the two separate writes did. The sum is read from the rows, not
-- sent by the client, and held at the quantity bound (999) the way
-- sumQuantities in src/lib/limits.ts holds it. A delete the policies filter out
-- raises rather than returning quietly, so the summed target rolls back with it.
create or replace function public.merge_items(p_source uuid, p_target uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quantity integer;
  v_deleted integer;
begin
  update public.shopping_list_items t
     set quantity = least(999, t.quantity + s.quantity)
    from public.shopping_list_items s
   where t.id = p_target
     and s.id = p_source
     and s.id <> t.id
     and s.list_id = t.list_id
     and t.checked = false
  returning t.quantity into v_quantity;

  if v_quantity is null then
    raise exception 'Nothing to merge.'
      using errcode = 'P0001',
            detail = 'merge_items_not_found';
  end if;

  delete from public.shopping_list_items where id = p_source;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'Nothing to merge.'
      using errcode = 'P0001',
            detail = 'merge_items_not_found';
  end if;

  return v_quantity;
end;
$$;

revoke all on function public.merge_items(uuid, uuid) from public, anon;
grant execute on function public.merge_items(uuid, uuid) to authenticated;

-- ─── changing a quantity by an amount ───────────────────────────────────────
-- The app used to write a quantity as the total it had worked out from its own
-- copy of the row ("milk = 2"). Two members bumping the same row at once, or a
-- phone replaying an offline bump hours later, then wrote over each other and
-- one change was lost without anyone being told. This takes the change instead
-- ("milk + 1") and applies it to whatever the row holds now, in one statement.
--
-- SECURITY INVOKER, like merge_items: the caller's update policy decides it.
-- Held to the quantity bound (1..999) rather than refused at it, the way
-- merge_items and sumQuantities hold a sum. Returns the new quantity, or null
-- when the row is gone or hidden -- a change to a row someone deleted has
-- nothing left to change, which the app treats as done.
--
-- A replay that times out after it landed is sent again and counts twice. That
-- is accepted: an extra item is visible and one tap to fix, where the lost
-- change this replaced was invisible.
create or replace function public.add_item_quantity(p_id uuid, p_delta integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quantity integer;
begin
  if p_delta is null or p_delta not between -999 and 999 then
    raise exception 'Quantity change out of range.'
      using errcode = 'P0001',
            detail = 'quantity_delta_out_of_range';
  end if;

  update public.shopping_list_items
     set quantity = least(999, greatest(1, quantity + p_delta))
   where id = p_id
  returning quantity into v_quantity;

  return v_quantity;
end;
$$;

revoke all on function public.add_item_quantity(uuid, integer) from public, anon;
grant execute on function public.add_item_quantity(uuid, integer) to authenticated;
