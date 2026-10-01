-- ─── purchase history ────────────────────────────────────────────────────────
-- What was bought, and the single path that records it.
--
-- Checking an item marks it as ready to buy; checking out archives every checked
-- item here and removes it from the active list. The archive is what
-- distinguishes buying from the trash button (delete = "I don't want this"), so
-- it is driven by an explicit RPC rather than a delete trigger — a trigger could
-- not tell a purchase apart from a merge-delete or an individual removal, and
-- would fill history with things nobody bought.
--
-- buy_items() is the ONLY writer. The client has select and nothing else, which
-- is deliberate and load-bearing: a direct insert path would let any member forge
-- author names and avatars, and post-date purchased_at to trick the retention
-- logic below into deleting a list's real checkouts.

create table if not exists public.purchase_history (
  id                  uuid        primary key default gen_random_uuid(),
  -- Every item bought in one checkout shares this, so the history view can
  -- separate same-day purchases by who checked out and when. Never null: every
  -- writer stamps it, and the prune below matches on it.
  checkout_id         uuid        not null,
  list_id           uuid        not null references public.lists(id) on delete cascade,
  item_id             uuid,       -- original shopping_list_items id (informational)
  name                text        not null,
  maker               text,
  quantity            integer     not null default 1,
  added_by            text,       -- who originally added the item
  -- Unlike the active list, history keeps its own copy of the author's name and
  -- avatar rather than joining profiles. That is the point: an archive should
  -- freeze who added an item and how they looked at the time. A deliberate
  -- snapshot, not the redundancy that profiles exists to remove.
  added_by_name       text,
  added_by_image_url  text,
  purchased_by        text        not null,   -- Clerk user id who checked out
  purchased_at        timestamptz not null default now()
);

alter table public.purchase_history enable row level security;

-- The history view reads newest-first within a list.
create index if not exists idx_purchase_history_list_purchased_at
  on public.purchase_history (list_id, purchased_at desc);

create index if not exists idx_purchase_history_checkout
  on public.purchase_history (list_id, checkout_id);

-- Read-only from the app, and append-only in practice: no insert, update or
-- delete policy exists. Deleting a list cascades its history away.
drop policy if exists "list members can read purchase history" on public.purchase_history;
create policy "list members can read purchase history"
  on public.purchase_history for select
  using (
    list_id in (select public.active_list_ids())
  );

-- Select only. buy_items() writes as the table owner.
--
-- Revoke first, then grant: this is the table where the provisioning defaults
-- mattered most. The header above says a direct insert path "would let any member
-- forge author names and avatars, and post-date purchased_at" — and production had
-- INSERT, UPDATE and DELETE granted to authenticated the whole time, plus TRUNCATE,
-- which ignores RLS entirely. Only the absence of any write policy made the header
-- true. Now both gates say the same thing. See the long note at the end of
-- 003_lists_and_members.sql.
--
-- service_role keeps SELECT because supabase/functions/push-on-item-insert reads
-- this table to count the items in a checkout.
revoke all on public.purchase_history from anon, authenticated, service_role;

grant select on public.purchase_history to authenticated;
grant select on public.purchase_history to service_role;

-- ─── checking out ────────────────────────────────────────────────────────────
-- Archive the given checked items and remove them from the active list in one
-- statement, so a checkout can never half-apply. Returns the number bought.
--
-- SECURITY DEFINER, because the client cannot insert here. That means RLS does
-- not guard the delete either, so membership is checked explicitly — passing ids
-- from another list archives nothing. The `checked = true` guard means an
-- unchecked row slipping into the id list is ignored rather than silently bought.
--
-- Every history field is therefore server-stamped and trustworthy, which is what
-- the retention logic below depends on: purchased_at cannot be forged, so ranking
-- by it cannot be gamed.
--
-- The archived author name/avatar are read from profiles at checkout time via a
-- left join, so an item added by someone who has since left the list still
-- archives with a 'Member' fallback rather than losing the row.
create or replace function public.buy_items(p_item_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user text := requesting_user_id();
  v_checkout_id uuid := gen_random_uuid();
  moved integer;
begin
  if v_user is null then
    return 0;
  end if;

  with removed as (
    delete from public.shopping_list_items
    where id = any(p_item_ids)
      and checked = true
      -- active_list_ids(), not list_members: a list an admin
      -- soft-deleted keeps its member rows, and this function is SECURITY
      -- DEFINER, so reading membership directly let a member with cached ids
      -- still check out of a list that every policy already hides.
      and list_id in (select public.active_list_ids())
    returning list_id, id, name, maker, quantity, added_by
  )
  insert into public.purchase_history
    (checkout_id, list_id, item_id, name, maker, quantity, added_by, added_by_name, added_by_image_url, purchased_by)
  select
    v_checkout_id, r.list_id, r.id, r.name, r.maker, r.quantity, r.added_by,
    coalesce(p.display_name, 'Member'), p.image_url, v_user
  from removed r
  left join public.profiles p on p.user_id = r.added_by;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke all on function public.buy_items(uuid[]) from public, anon;
grant execute on function public.buy_items(uuid[]) to authenticated;

-- ─── retention ───────────────────────────────────────────────────────────────
-- Each list keeps its 60 most recent checkouts, and nothing older than 30
-- days. This bound is also what lets useProductSuggestions() fetch a list's
-- whole history in one query to rank suggestions: the window is small and
-- naturally recent, so no decay maths is needed — retention already forgets.
--
-- On checkout: prune the lists a checkout touched. A statement-level trigger
-- with a transition table, so this runs once per checkout rather than once per
-- row. SECURITY DEFINER because the app role cannot delete from this table.
create or replace function public.prune_purchase_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  with affected as (
    select distinct list_id from new_rows
  ),
  checkouts as (
    select ph.list_id, ph.checkout_id, max(ph.purchased_at) as ts
    from public.purchase_history ph
    join affected a on a.list_id = ph.list_id
    group by ph.list_id, ph.checkout_id
  ),
  ranked as (
    select
      checkout_id,
      ts,
      row_number() over (partition by list_id order by ts desc, checkout_id desc) as rn
    from checkouts
  ),
  doomed as (
    select checkout_id
    from ranked
    where rn > 60
       or ts < now() - interval '30 days'
  )
  delete from public.purchase_history ph
  using doomed d
  where ph.checkout_id = d.checkout_id;

  return null;
end;
$$;

drop trigger if exists trg_prune_purchase_history on public.purchase_history;
create trigger trg_prune_purchase_history
after insert on public.purchase_history
referencing new table as new_rows
for each statement
execute function public.prune_purchase_history();

-- Daily sweep. The trigger above only prunes a list when it checks out, so a
-- list that goes quiet could keep checkouts past 30 days until its next one.
-- This deletes anything older than 30 days across every list regardless of
-- activity. Requires pg_cron.
--
-- Wrapped in a DO block so a database where pg_cron cannot be created (not on
-- the image, or insufficient privilege — e.g. `supabase test db`) still gets the
-- rest of this file: the sweep is a safety net on top of the trigger, not the
-- primary mechanism. On hosted Supabase, if this raises a warning instead of
-- scheduling, enable "pg_cron" once under Database → Extensions in the
-- dashboard, then re-run this file.
do $cron$
begin
  create extension if not exists pg_cron;

  -- cron.schedule upserts by job name, so re-running this is not a duplicate.
  -- Runs daily at 03:00 UTC.
  perform cron.schedule(
    'purge-checkouts-older-than-30-days',
    '0 3 * * *',
    $job$delete from public.purchase_history where purchased_at < now() - interval '30 days'$job$
  );
exception when others then
  raise warning 'pg_cron sweep not scheduled (%); the checkout trigger still enforces retention.', sqlerrm;
end;
$cron$;
