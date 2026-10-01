-- RLS / security-invariant tests for Bagful.
--
-- Run with the Supabase CLI against the local stack (it applies migrations first):
--   supabase test db
--
-- These assert the guarantees the app leans on but can't verify from the client:
--   1. A member of one list cannot read another list's items (no cross-tenant leak).
--   2. The unthrottled invite-code lookup RPC is gone: joining is the only path
--      that resolves a code, and it is throttled and audited.
--   3. The per-member active-item cap is enforced by the DB trigger, not just the UI.
--   4. Purchase history is written only by buy_items(): the RPC is scoped to
--      the caller's lists, and direct inserts (forged names/timestamps) are
--      rejected outright.
--   5. The invite code is checked by the database at join time: a direct
--      membership insert fails even with a known list uuid (the removed-
--      member-rejoin vector), and join_list_with_code() is the only way in.
--      Nor can an existing membership row be rewritten into one: a moderator
--      cannot repoint another member's row -- the owner's included -- at a
--      different account, which would be an eviction and an uninvited join in
--      one unaudited statement (003_lists_and_members.sql).
--   6. The product catalog is readable by any signed-in user but writable
--      only by the service role (the seed script) and the catalog RPCs.
--   7. A list's contributed products stay theirs: add_custom_product() scopes
--      them to a list the caller is actually in, other lists cannot see
--      them, and they go global only once enough distinct accounts (contributed_by)
--      add the same product.
--   8. A user can own at most one list (003_lists_and_members.sql) -- a complementary
--      product rule alongside the contributed_by promotion gate.
--   9. Bulk-imported catalog rows say where they came from, clients cannot reach
--      the import path at all, and an import can never rewrite a curated
--      product or spend a product's earned popularity (006_product_catalog.sql).
--  10. The security audit log is unreadable and unforgeable from a client role,
--      invite-code guessing is capped per user, and privilege changes and member
--      removals leave a record (002_security_audit.sql, 003_lists_and_members.sql).
--  11. Catalog ranking cannot be inflated without limit: the global add_count
--      stops climbing at the hourly ceiling, the counters are unreachable from a
--      client, and crossing the limit is audited once per window (002_security_audit.sql).
--  12. The list itself has a rate ceiling and not just the 50-item breadth cap:
--      inserts stop at the hourly limit, crossing it leaves exactly one audit row
--      that survives the rejection, and the seed/service-role path with no JWT is
--      unaffected (004_shopping_list.sql).
--  13. Leaving a list and being removed from one are logged as different kinds,
--      so the digest can tell "people left" from "someone is emptying a list"
--      (003_lists_and_members.sql).
--  14. Profile writes have an hourly ceiling too -- it is the one table a client
--      may rewrite about itself with no breadth cap above it
--      (003_lists_and_members.sql).
--  15. Table privileges match what the policies describe: anon reaches nothing,
--      and a signed-in user cannot write purchase_history or product_catalog even
--      though hosted Supabase grants those at provisioning (003-006).
--  16. Creating a list is all-or-nothing: a membership the limit trigger
--      rejects takes the lists row back with it. Done as three client
--      writes, a failed compensating delete left an orphan that permanently
--      occupied the account's one ownership slot and that no screen in the app
--      could reach (003_lists_and_members.sql).
--
-- Tests run inside a transaction that is rolled back, so they leave no data behind.

begin;
select plan(136);

-- ── Seed as the migration/superuser role (bypasses RLS) ──────────────────────
-- Three lists, because promoting a contributed product to the global catalog
-- takes three distinct ones (006_product_catalog.sql).
insert into public.lists (id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000000a1', 'List A', 'AAAAAAA2', 'user_a'),
  ('00000000-0000-0000-0000-0000000000b1', 'List B', 'BBBBBBB2', 'user_b'),
  ('00000000-0000-0000-0000-0000000000c1', 'List C', 'CCCCCCC2', 'user_c');

-- Every list_members row now references a profiles row (003_lists_and_members.sql's FK),
-- so each test account needs a profile before its membership is seeded below.
insert into public.profiles (user_id, display_name) values
  ('user_a', 'User A'),
  ('user_b', 'User B'),
  ('user_c', 'User C'),
  ('user_d', 'User D'),
  ('user_e', 'User E'),
  ('user_f', 'User F'),
  ('attacker', 'Attacker'),
  -- Three accounts one person controls, all inside a single list (7j).
  ('sock_one', 'Sock One'),
  ('sock_two', 'Sock Two'),
  ('sock_three', 'Sock Three');

insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'user_a', 'moderator'),
  ('00000000-0000-0000-0000-0000000000b1', 'user_b', 'moderator'),
  ('00000000-0000-0000-0000-0000000000c1', 'user_c', 'moderator');

-- Fixture for 7i: three more lists, each owned by a distinct account, plus one
-- "attacker" account that is a member of all three. Promotion counts distinct
-- contributed_by, so this account contributing the same product to all three still
-- counts as one -- under the old distinct-owner count these three owners would have
-- crossed the threshold.
insert into public.lists (id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000000d1', 'List D', 'DDDDDDD2', 'user_d'),
  ('00000000-0000-0000-0000-0000000000e1', 'List E', 'EEEEEEE2', 'user_e'),
  ('00000000-0000-0000-0000-0000000000f1', 'List F', 'FFFFFFF2', 'user_f');

insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000d1', 'user_d', 'moderator'),
  ('00000000-0000-0000-0000-0000000000e1', 'user_e', 'moderator'),
  ('00000000-0000-0000-0000-0000000000f1', 'user_f', 'moderator'),
  ('00000000-0000-0000-0000-0000000000d1', 'attacker', 'member'),
  ('00000000-0000-0000-0000-0000000000e1', 'attacker', 'member'),
  ('00000000-0000-0000-0000-0000000000f1', 'attacker', 'member');

-- Fixture for 7j: three separate accounts that all live in ONE list. The
-- mirror image of 7i -- distinct contributors, a single list between them.
insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000d1', 'sock_one', 'member'),
  ('00000000-0000-0000-0000-0000000000d1', 'sock_two', 'member'),
  ('00000000-0000-0000-0000-0000000000d1', 'sock_three', 'member');

-- 8. One list per owner. Asserted here as the superuser, so RLS is out of the
-- way and the unique index (003_lists_and_members.sql) is the only thing that can reject the
-- second list -- a complementary product rule alongside the contributed_by
-- promotion gate. user_a already owns List A above.
select throws_ok(
  $$ insert into public.lists (name, invite_code, created_by)
     values ('List A2', 'AAAAAAA3', 'user_a') $$,
  '23505',
  null,
  'a user can own at most one list'
);

-- 8b. Quantity is bounded at both ends, 1..999. The floor was always here;
-- the ceiling exists because the client's 99 (ITEM_QUANTITY_MAX in
-- src/lib/limits.ts) is a stepper product decision a hand-crafted request never
-- sees, and without a server bound such a request could park 2^31-1 on a shared
-- row. 999 rather than 99 because merges legitimately sum quantities past the
-- stepper's cap. Asserted as the superuser: this is a check constraint, and RLS
-- has no say in it.
select lives_ok(
  $$ insert into public.shopping_list_items (id, list_id, name, added_by, checked, quantity)
     values ('00000000-0000-0000-0000-0000000000a9',
             '00000000-0000-0000-0000-0000000000a1', 'ceiling probe', 'user_a', true, 999) $$,
  'quantity 999 is inside the bound'
);

-- The probe row must not survive into the fixtures: section 4 buys every
-- checked item user_a holds in List A and counts what it archived.
delete from public.shopping_list_items
where id = '00000000-0000-0000-0000-0000000000a9';

select throws_ok(
  $$ insert into public.shopping_list_items (list_id, name, added_by, quantity)
     values ('00000000-0000-0000-0000-0000000000a1', 'ceiling probe', 'user_a', 1000) $$,
  '23514',
  null,
  'quantity 1000 is rejected by the check constraint'
);

-- Checked, so only the membership check in buy_items() can protect it.
insert into public.shopping_list_items (id, list_id, name, added_by, checked) values
  ('00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000b1', 'list B secret', 'user_b', true);

-- Cap List A at one active item so the trigger is easy to trip.
update public.lists
set max_items_per_member = 1
where id = '00000000-0000-0000-0000-0000000000a1';

-- One curated row, of the kind the deleted seed script left in production --
-- including the provenance stamp (006_product_catalog.sql), which is what
-- protects it from being rewritten by a bulk import.
insert into public.product_catalog (name, maker, search_text, source)
values ('Apa Plata 2L', 'Dorna', 'apa plata 2l dorna', 'curated');

-- ── Act as user_a (authenticated role + JWT sub claim) ───────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

-- 1. Cross-tenant read is blocked.
select is(
  (select count(*)::int from public.shopping_list_items
   where list_id = '00000000-0000-0000-0000-0000000000b1'),
  0,
  'user_a cannot read List B items'
);

-- 2. No unthrottled invite-code lookup exists. An earlier schema had a
-- find_list_by_invite_code() RPC, which let any signed-in caller test a
-- guessed code for free — the exact primitive a brute-forcer wants, and cheaper
-- to call than joining. Nothing in supabase/migrations creates it now, and this
-- asserts that stays true: joining is the only path that resolves a code, and it
-- is throttled and audited (003_lists_and_members.sql).
select is(
  (select count(*)::int from pg_proc
   where proname = 'find_list_by_invite_code'
     and pronamespace = 'public'::regnamespace),
  0,
  'the unthrottled invite-code lookup RPC no longer exists'
);

-- 3. Per-member active-item cap is enforced (limit is 1; second insert must fail).
insert into public.shopping_list_items (list_id, name, added_by)
values ('00000000-0000-0000-0000-0000000000a1', 'first item', 'user_a');

select throws_ok(
  $$ insert into public.shopping_list_items (list_id, name, added_by)
     values ('00000000-0000-0000-0000-0000000000a1', 'second item', 'user_a') $$,
  'P0001',
  'You reached your limit of 1 active items.',
  'DB trigger blocks exceeding the per-member active-item cap'
);

-- ── 4. Purchase history is written only through buy_items ────────────────────

-- 4a. buy_items is scoped to the caller's lists, even for checked items
-- named by id (buy_items is SECURITY DEFINER, so this guard is all there is).
select is(
  public.buy_items(array['00000000-0000-0000-0000-0000000000b2']::uuid[]),
  0,
  'buy_items ignores items in lists the caller is not a member of'
);

-- 4b. Buying own checked item archives it...
update public.shopping_list_items
set checked = true
where list_id = '00000000-0000-0000-0000-0000000000a1' and added_by = 'user_a';

select is(
  public.buy_items(array(
    select id from public.shopping_list_items
    where list_id = '00000000-0000-0000-0000-0000000000a1' and added_by = 'user_a'
  )),
  1,
  'buy_items archives the caller''s checked item'
);

-- 4c. ...into history, server-stamped with a checkout id.
select is(
  (select count(*)::int from public.purchase_history
   where list_id = '00000000-0000-0000-0000-0000000000a1'
     and purchased_by = 'user_a'
     and checkout_id is not null),
  1,
  'the purchase landed in history with a checkout id'
);

-- 4d. Direct inserts (forged author fields / future timestamps) are rejected.
select throws_ok(
  $$ insert into public.purchase_history (checkout_id, list_id, name, purchased_by)
     values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'forged', 'user_a') $$,
  '42501',
  null,
  'clients cannot insert purchase history directly'
);

-- ── 5. The invite code is a real credential at join time ─────────────────────

-- 5a. Knowing a list uuid is not enough to (re)join it: the direct insert a
-- removed member could replay is blocked by RLS.
select throws_ok(
  $$ insert into public.list_members (list_id, user_id, role)
     values ('00000000-0000-0000-0000-0000000000b1', 'user_a', 'member') $$,
  '42501',
  null,
  'direct membership insert without being the list creator is rejected'
);

-- 5b. The join RPC admits a valid code...
select is(
  (select name from public.join_list_with_code('BBBBBBB2', 'User A', null)),
  'List B',
  'join RPC resolves a valid invite code and returns the list'
);

select is(
  (select count(*)::int from public.list_members
   where list_id = '00000000-0000-0000-0000-0000000000b1' and user_id = 'user_a'),
  1,
  'join RPC created the membership row'
);

-- 5c. ...and an unknown code joins nothing.
select is(
  (select count(*)::int from public.join_list_with_code('ZZZZZZZ2', 'User A', null)),
  0,
  'join RPC returns nothing for an unknown code'
);

-- ── 6. The product catalog is read-only for clients ──────────────────────────

select is(
  (select count(*)::int from public.product_catalog
   where name = 'Apa Plata 2L' and maker = 'Dorna'),
  1,
  'signed-in users can read the product catalog'
);

select throws_ok(
  $$ insert into public.product_catalog (name, maker, search_text)
     values ('forged product', 'nobody', 'forged product nobody') $$,
  '42501',
  null,
  'clients cannot insert into the product catalog'
);

-- A client cannot bump popularity by writing the table directly...
select throws_ok(
  $$ update public.product_catalog set add_count = add_count + 100
     where name = 'Apa Plata 2L' $$,
  '42501',
  null,
  'clients cannot update the product catalog directly'
);

-- ...only through the RPC, which counts exactly one add and lifts popularity.
select public.bump_product_popularity('Apa Plata 2L', 'Dorna');

select is(
  (select popularity from public.product_catalog
   where name = 'Apa Plata 2L' and maker = 'Dorna'),
  1,
  'bump_product_popularity increments popularity by one'
);

-- The maker is part of the match: a wrong maker bumps nothing.
select public.bump_product_popularity('Apa Plata 2L', 'Wrong Maker');

select is(
  (select popularity from public.product_catalog
   where name = 'Apa Plata 2L' and maker = 'Dorna'),
  1,
  'bump_product_popularity ignores a product whose maker does not match'
);

-- ── 7. Contributed products are scoped, and go global only on merit ──────────
-- Still acting as user_a, who is now in List A and (since 5b) List B.

-- 7a. Contributing creates a row scoped to the list, not a global one.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000a1', 'Olive Oil 500ml', 'Bertolli'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'
     and list_id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'add_custom_product contributes a product scoped to the caller''s list'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  0,
  'a freshly contributed product is not global'
);

-- 7b. The server derives search_text, so the client cannot forge the value that
-- would become everyone's matching key on promotion. Diacritics are folded.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000a1', 'Ulei de Măsline', null
);

select is(
  (select search_text from public.product_catalog
   where list_id = '00000000-0000-0000-0000-0000000000a1'
     and name = 'Ulei de Măsline'),
  'ulei de masline',
  'the server derives search_text and folds diacritics'
);

-- 7c. Re-adding the same product (here in a different case) counts a repeat
-- rather than splitting the list's suggestions across near-duplicate rows.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000a1', 'OLIVE OIL 500ML', 'bertolli'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'
     and list_id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'a differently-cased spelling folds into the list''s existing row'
);

select is(
  (select add_count from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'
     and list_id = '00000000-0000-0000-0000-0000000000a1'),
  2,
  'contributing the same product again counts an add instead of duplicating it'
);

-- Push List A past the per-list cap that promotion applies (7g), so the sum
-- carried global cannot be inflated by one list re-adding a product.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000a1', 'Olive Oil 500ml', 'Bertolli'
);
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000a1', 'Olive Oil 500ml', 'Bertolli'
);

select is(
  (select add_count from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'
     and list_id = '00000000-0000-0000-0000-0000000000a1'),
  4,
  'a list''s own add_count keeps climbing past the cap while scoped'
);

-- 7d. Contributing into a list you are not in. SECURITY DEFINER bypasses RLS,
-- so the membership check inside the RPC is the only thing stopping this;
-- user_c asserts below that it wrote nothing.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000c1', 'Smuggled Product', null
);

-- ── Act as user_c (List C only) ────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"user_c"}';

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'smuggled product'),
  0,
  'add_custom_product writes nothing for a list the caller is not in'
);

-- 7e. List A's contribution is invisible to a list that did not make it —
-- the property that makes opening this write path safe.
select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'),
  0,
  'another list''s contributed product is not visible'
);

-- 7f. Two lists wanting a product is not enough to inflict it on everyone.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000c1', 'Olive Oil 500ml', 'Bertolli'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  0,
  'two lists are not enough to promote a product'
);

-- ── Act as user_b (List B) ─────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"user_b"}';

-- 7g. The third distinct list promotes it to the global catalog.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000b1', 'olive oil 500ml', 'BERTOLLI'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  1,
  'a third distinct list promotes the product to the global catalog'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is not null),
  0,
  'promotion collapses the list-scoped rows into the global one'
);

-- The promoted row keeps one of the contributed spellings. Which one is the
-- earliest by created_at, but every add_custom_product call in this suite shares
-- one transaction, so all three scoped rows carry the same now() and the tiebreak
-- falls to a random id -- assert the invariant that actually matters (the winner
-- is a real contributed spelling, case aside), not a coin-flip. In production the
-- calls are separate transactions with distinct timestamps, so the earliest wins.
select is(
  lower((select name from public.product_catalog
         where search_text = 'olive oil 500ml bertolli' and list_id is null)),
  'olive oil 500ml',
  'promotion keeps a contributed spelling'
);

-- The product arrives ranked by the usage it earned rather than at zero, but
-- each list's share is capped at 3: List A's four adds count as three, plus
-- one each from Lists C and B.
select is(
  (select add_count from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  5,
  'the promoted product carries its contributors'' adds, capped per list'
);

-- 7h. Now that it is global, contributing it again just counts against it.
select public.add_custom_product(
  '00000000-0000-0000-0000-0000000000b1', 'Olive Oil 500ml', 'Bertolli'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'olive oil 500ml bertolli'),
  1,
  'contributing an already-global product does not re-create a scoped row'
);

select is(
  (select add_count from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  6,
  'contributing an already-global product counts an add against it'
);

-- ── 7i. Membership breadth is not contributor count ──────────────────────────
-- The attacker account is a member of Lists D, E and F (three distinct
-- owners). Contributing the same product to each creates three scoped rows that
-- all share one contributed_by, so the distinct-contributor count is 1 and it is
-- never promoted -- the self-promotion vector the contributed_by gate closes.
set local request.jwt.claims = '{"sub":"attacker"}';
select public.add_custom_product('00000000-0000-0000-0000-0000000000d1', 'Attacker Junk', null);
select public.add_custom_product('00000000-0000-0000-0000-0000000000e1', 'Attacker Junk', null);
select public.add_custom_product('00000000-0000-0000-0000-0000000000f1', 'Attacker Junk', null);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'attacker junk' and list_id is null),
  0,
  'one account in three lists cannot self-promote a product'
);

-- ── 7j. Contributor count is not list breadth ───────────────────────────
-- The mirror of 7i, and the half the gate did not state. Three distinct accounts
-- contribute the same product from inside ONE list. Promotion needs three
-- distinct lists as well as three distinct accounts, so this stays scoped.
--
-- It cannot reach the threshold today for a second reason:
-- product_catalog_list_search is unique on (list_id, search_text), so
-- these three calls collapse onto one row carrying one contributed_by. That is
-- exactly why this is worth asserting -- the rule must be what refuses it, not a
-- unique index two hundred lines away that could be relaxed for its own reasons.
set local request.jwt.claims = '{"sub":"sock_one"}';
select public.add_custom_product('00000000-0000-0000-0000-0000000000d1', 'Sock Puppet Juice', null);
set local request.jwt.claims = '{"sub":"sock_two"}';
select public.add_custom_product('00000000-0000-0000-0000-0000000000d1', 'Sock Puppet Juice', null);
set local request.jwt.claims = '{"sub":"sock_three"}';
select public.add_custom_product('00000000-0000-0000-0000-0000000000d1', 'Sock Puppet Juice', null);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'sock puppet juice' and list_id is null),
  0,
  'three accounts inside one list cannot promote a product'
);

select is(
  (select count(distinct list_id)::int from public.product_catalog
   where search_text = 'sock puppet juice' and list_id is not null),
  1,
  'their contributions stay scoped to the one list they share'
);

-- ── 9. Provenance and bulk import (006_product_catalog.sql) ────────────────────────────
-- The catalog now has a third kind of row: products imported in bulk from an
-- external database. These assert the two guarantees that make that safe --
-- clients cannot reach the import path at all, and an import cannot damage a row
-- it does not own.

-- 9a. Still acting as the authenticated role. The import RPC is granted to
-- service_role alone, so it is not merely unhelpful to a client, it is closed.
select throws_ok(
  $$ select public.import_catalog_products('[]'::jsonb) $$,
  '42501',
  null,
  'the bulk import RPC is closed to signed-in users'
);

-- ── Back to the migration/superuser role, standing in for the service role ────
reset role;

-- 9b. A barcode is digits or nothing.
select throws_ok(
  $$ insert into public.product_catalog (name, search_text, barcode)
     values ('Bad Barcode', 'bad barcode', 'ABC12345') $$,
  '23514',
  null,
  'a non-numeric barcode is rejected'
);

insert into public.product_catalog (name, search_text, barcode, source, source_ref)
values ('Barcode Holder', 'barcode holder', '5941000000001', 'openfoodfacts', '5941000000001');

-- 9c. One global row per barcode, so a re-import can key on it.
select throws_ok(
  $$ insert into public.product_catalog (name, search_text, barcode)
     values ('Barcode Thief', 'barcode thief', '5941000000001') $$,
  '23505',
  null,
  'two global products cannot share a barcode'
);

-- 9d. ...but the uniqueness is partial, so the thousands of rows that have no
-- barcode do not collide with each other.
select lives_ok(
  $$ insert into public.product_catalog (name, search_text) values
       ('No Barcode One', 'no barcode one'),
       ('No Barcode Two', 'no barcode two') $$,
  'many global products may have no barcode at all'
);

-- 9e-9g. Every row says where it came from.
select is(
  (select source from public.product_catalog where search_text = 'apa plata 2l dorna'),
  'curated',
  'a seeded product is stamped curated'
);

select is(
  (select source from public.product_catalog where search_text = 'ulei de masline'),
  'community',
  'a contributed product is stamped community'
);

select is(
  (select source from public.product_catalog
   where search_text = 'olive oil 500ml bertolli' and list_id is null),
  'community',
  'a promoted product is still community once global'
);

-- 9h-9i. A plain import of a product nobody has seen before.
select is(
  (select (public.import_catalog_products(
    '[{"barcode":"5941000000010","name":"Iaurt Grecesc 400g","maker":"Olympus","base_weight":5}]'::jsonb,
    'openfoodfacts', 'off-test-1') ->> 'inserted')::int),
  1,
  'the import RPC inserts a product the catalog does not have'
);

select is(
  (select source || '|' || coalesce(barcode, '') || '|' || base_weight::text || '|' || add_count::text
   from public.product_catalog where search_text = 'iaurt grecesc 400g olympus'),
  'openfoodfacts|5941000000010|5|0',
  'the imported row carries its provenance and weight, and starts at zero adds'
);

-- 9j. The invariant the whole split of base_weight and add_count exists for: a
-- re-import refreshes the editorial weight and cannot touch earned usage.
update public.product_catalog set add_count = 7
where search_text = 'iaurt grecesc 400g olympus';

select public.import_catalog_products(
  '[{"barcode":"5941000000010","name":"Iaurt Grecesc 400g","maker":"Olympus","base_weight":9}]'::jsonb,
  'openfoodfacts', 'off-test-2');

select is(
  (select base_weight::text || '|' || add_count::text || '|' || popularity::text
   from public.product_catalog where search_text = 'iaurt grecesc 400g olympus'),
  '9|7|16',
  'a re-import updates base_weight and leaves earned add_count alone'
);

-- 9k-9l. Curated wins. The upstream record normalizes onto the seeded row, in a
-- shoutier spelling and with a weight that would outrank it.
select public.import_catalog_products(
  '[{"barcode":"5941000000020","name":"APA PLATA 2L","maker":"DORNA","base_weight":9}]'::jsonb,
  'openfoodfacts', 'off-test-3');

select is(
  (select name || '|' || base_weight::text || '|' || source
   from public.product_catalog where search_text = 'apa plata 2l dorna'),
  'Apa Plata 2L|0|curated',
  'an import cannot rewrite a curated product''s name, weight or provenance'
);

select is(
  (select barcode from public.product_catalog where search_text = 'apa plata 2l dorna'),
  '5941000000020',
  'a curated product still gains the upstream barcode'
);

-- 9m-9n. Two upstream records for the same product. The partial unique index on
-- search_text would reject the second, so the batch is collapsed first and the
-- heavier row wins.
select is(
  (select (public.import_catalog_products(
    '[{"barcode":"5941000000030","name":"Paine Alba 500g","maker":"Vel Pitar","base_weight":3},
      {"barcode":"5941000000031","name":"paine alba 500g","maker":"vel pitar","base_weight":8}]'::jsonb,
    'openfoodfacts', 'off-test-4') ->> 'inserted')::int),
  1,
  'two barcodes that normalize alike collapse into one global product'
);

select is(
  (select barcode from public.product_catalog where search_text = 'paine alba 500g vel pitar'),
  '5941000000031',
  'the collapse keeps the heavier of the two upstream rows'
);

-- 9o. Re-running an import is a no-op, which is what makes it safe to schedule.
select is(
  (select (public.import_catalog_products(
    '[{"barcode":"5941000000031","name":"paine alba 500g","maker":"vel pitar","base_weight":8}]'::jsonb,
    'openfoodfacts', 'off-test-4') ->> 'inserted')::int),
  0,
  'running the same import again inserts nothing'
);

-- 9p-9q. A dry run reports, and writes nothing at all -- it is a separate
-- read-only branch rather than a rollback, so it cannot half-apply.
select is(
  (select (public.import_catalog_products(
    '[{"barcode":"5941000000040","name":"Cascaval Rucar 350g","maker":"Hochland","base_weight":4}]'::jsonb,
    'openfoodfacts', 'off-test-5', true) ->> 'inserted')::int),
  1,
  'a dry run reports what it would have inserted'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'cascaval rucar 350g hochland'),
  0,
  'a dry run writes nothing'
);

-- 9r-9t. Lists D, E and F each contributed "Attacker Junk" (7i), so three
-- scoped rows exist and no global. An import of the same product has to collapse
-- them the way a promotion would, or those lists see it twice forever.
select is(
  (select (public.import_catalog_products(
    '[{"barcode":"5941000000050","name":"Attacker Junk","base_weight":2}]'::jsonb,
    'openfoodfacts', 'off-test-6') ->> 'collapsed_scoped')::int),
  3,
  'importing a product lists already contributed collapses their scoped rows'
);

select is(
  (select count(*)::int from public.product_catalog
   where search_text = 'attacker junk' and list_id is not null),
  0,
  'no scoped duplicate survives the import'
);

select is(
  (select add_count from public.product_catalog
   where search_text = 'attacker junk' and list_id is null),
  3,
  'the import folds the contributors'' earned adds, capped per list, into the global row'
);

-- 9u. The canary for the normalizer that exists in three places: this SQL
-- function, src/lib/productSearch.ts, and the importer's vendored copy of that
-- file. If this changes, all three have drifted. (It was four until the seed
-- script was deleted in 9a4366e.)
select is(
  public.product_search_text('Apă Plată', 'Dorna'),
  'apa plata dorna',
  'product_search_text lowercases, folds diacritics and joins name to maker'
);

-- 9v. As the role that actually runs imports, not as the superuser.
--
-- Every assertion above this point runs as the migration/superuser role, which
-- bypasses privilege checks entirely. That made them all pass while the real
-- importer failed on its first call with "permission denied for function
-- product_search_text": import_catalog_products is SECURITY INVOKER, so its
-- body executes as service_role, and service_role had no EXECUTE on the helper
-- it calls. A whole class of grant bug is invisible to a superuser test, so at
-- least one call has to be made as the role the client uses.
set local role service_role;

select lives_ok(
  $$ select public.import_catalog_products(
       '[{"barcode":"5941000000060","name":"Ceai Verde 20 plicuri","maker":"Alevia","base_weight":4}]'::jsonb,
       'openfoodfacts', 'off-test-7') $$,
  'the service role can run an import end to end'
);

reset role;

select is(
  (select source || '|' || base_weight::text from public.product_catalog
   where search_text = 'ceai verde 20 plicuri alevia'),
  'openfoodfacts|4',
  'the service-role import actually landed its row'
);

-- 9w. The widened source allowlist. Open Products Facts and Open Beauty Facts
-- carry the aisles Open Food Facts excludes, and both had to get past two
-- separate gates: the CHECK constraint on the column, and the explicit
-- allowlist inside import_catalog_products. The constraint is the one that
-- matters here — it lives inside `create table if not exists`, so it reaches a
-- fresh database from the table body and production only from the restated
-- ALTER below it. A test on a freshly-reset database passes either way, which
-- is exactly why this assertion is worth so little on its own and the ALTER is
-- worth so much.
select lives_ok(
  $$ select public.import_catalog_products(
       '[{"barcode":"5941000000077","name":"Pastă de dinți Menta","maker":"Colgate","base_weight":3,
          "search_aliases":"toothpastes pasta de dinti zahnpasta dentifrice"}]'::jsonb,
       'openbeautyfacts', 'obf-test-1') $$,
  'an Open Beauty Facts import is accepted'
);

select is(
  (select source from public.product_catalog where search_text = 'pasta de dinti menta colgate'),
  'openbeautyfacts',
  'the non-food source is stamped on the row'
);

select throws_ok(
  $$ select public.import_catalog_products('[]'::jsonb, 'curated') $$,
  'P0001',
  null,
  'curated is storable but still not importable'
);

-- 9x. search_aliases is folded by the server, not trusted from the caller.
-- It feeds a LIKE, and a hand-assembled batch must be held to the same shape
-- search_text is.
select is(
  (select search_aliases from public.product_catalog where search_text = 'pasta de dinti menta colgate'),
  'toothpastes pasta de dinti zahnpasta dentifrice',
  'aliases are stored folded'
);

select is(
  (select search_blob from public.product_catalog where search_text = 'pasta de dinti menta colgate'),
  'pasta de dinti menta colgate toothpastes pasta de dinti zahnpasta dentifrice',
  'search_blob is name and aliases together'
);

-- 9y. The whole point of the exercise: a query in a language the product is not
-- named in, and a query whose words arrive in the wrong order.
select is(
  (select count(*)::integer from public.search_catalog('toothpaste', null, 10)),
  1,
  'an English query reaches a Romanian product through its category aliases'
);

select is(
  (select count(*)::integer from public.search_catalog('zahnpasta', null, 10)),
  1,
  'so does a German one'
);

select is(
  (select count(*)::integer from public.search_catalog('menta pasta', null, 10)),
  1,
  'every token matches in any order, which the old contiguous ilike could not do'
);

select is(
  (select count(*)::integer from public.search_catalog('pasta unicorn', null, 10)),
  0,
  'and every token must match — one miss rejects the row'
);

-- 9z. LIKE metacharacters are escaped. product_search_text folds accents and
-- case but leaves % and _ alone, so without escaping a typed percent would
-- match the entire catalog.
select is(
  (select count(*)::integer from public.search_catalog('%', null, 10)),
  0,
  'a bare percent matches nothing rather than everything'
);

select is(
  (select count(*)::integer from public.search_catalog('p_sta', null, 10)),
  0,
  'a typed underscore is a literal, not a wildcard'
);

-- 9aa. search_catalog is SECURITY DEFINER, so RLS does not run and the
-- list scoping inside it is the only thing standing between one list
-- and another's contributed products. p_list_id arrives from client state.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select lives_ok(
  $$ select * from public.search_catalog('pasta', null, 10) $$,
  'an authenticated user may search'
);

select throws_ok(
  $$ insert into public.product_catalog (name, search_text, source)
     values ('smuggled', 'smuggled', 'openfoodfacts') $$,
  '42501',
  null,
  'but still cannot write to the catalog'
);

reset role;

-- A scoped row belonging to a list user_a is not a member of.
insert into public.product_catalog (name, search_text, list_id, contributed_by, source)
values ('Secret Sauce', 'secret sauce',
        '00000000-0000-0000-0000-0000000000d1', 'user_d', 'community');

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select is(
  (select count(*)::integer from public.search_catalog(
     'secret', '00000000-0000-0000-0000-0000000000d1'::uuid, 10)),
  0,
  'naming a list you do not belong to does not open its contributed rows'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_d"}';

select is(
  (select count(*)::integer from public.search_catalog(
     'secret', '00000000-0000-0000-0000-0000000000d1'::uuid, 10)),
  1,
  'a member of that list does see it'
);

reset role;

-- ── 10. Security audit trail + invite throttle (002_security_audit.sql, 003_lists_and_members.sql) ─────────

-- 10a. The audit log is unreachable from a client role. RLS with no policies
-- would already return zero rows; the explicit revoke means it does not even get
-- that far. An attacker with a valid token can neither read the log recording
-- them nor delete their own entries.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_rl"}';

select throws_ok(
  $$ select * from public.security_events $$,
  '42501',
  null,
  'a signed-in user cannot read the security audit log'
);

select throws_ok(
  $$ insert into public.security_events (kind) values ('forged') $$,
  '42501',
  null,
  'a signed-in user cannot forge audit rows'
);

-- 10b. A wrong code is recorded rather than passing silently.
select lives_ok(
  $$ select public.join_list_with_code('ZZZZZZZ9') $$,
  'a wrong invite code returns cleanly rather than erroring'
);

reset role;

select is(
  (select count(*)::int from public.security_events
   where actor = 'user_rl' and kind = 'invite_code_failed'),
  1,
  'a failed invite attempt is written to the audit log'
);

-- 10c. Past the ceiling, even a *valid* code stops resolving — and the caller
-- cannot tell throttling apart from a bad code. Nine more failures puts user_rl
-- at the limit of ten.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_rl"}';

do $$
begin
  for i in 1..9 loop
    perform public.join_list_with_code('ZZZZZZZ9');
  end loop;
end $$;

select is(
  (select count(*)::int from public.join_list_with_code('BBBBBBB2')),
  0,
  'a throttled caller gets no result even for a valid invite code'
);

reset role;

select is(
  (select count(*)::int from public.list_members
   where user_id = 'user_rl'),
  0,
  'the throttled join really did not create a membership'
);

select is(
  (select count(*)::int from public.security_events
   where actor = 'user_rl' and kind = 'invite_rate_limited'),
  1,
  'hitting the ceiling is itself recorded, so the attempt is visible'
);

-- 10d. Privilege changes and removals are audited. These go through plain
-- UPDATE/DELETE under RLS rather than an RPC, so only a trigger sees every path.
--
-- user_a owns List A, and only the owner may change roles (003_lists_and_members.sql), so
-- the promotion below has to run as user_a against List A.
insert into public.profiles (user_id, display_name) values ('user_g', 'User G');
insert into public.list_members (list_id, user_id, role)
values ('00000000-0000-0000-0000-0000000000a1', 'user_g', 'member');

set local request.jwt.claims = '{"sub":"user_a"}';

-- Assert the update *works*, not merely that it is audited.
--
-- This exists because of a real outage. A trigger named
-- prevent_member_profile_tamper once guarded list_members.display_name /
-- image_url; a later migration moved both columns to profiles and dropped them,
-- but left the trigger in place. PL/pgSQL resolves record fields at execution
-- time, so it did not fail on deploy — it failed on the next UPDATE of any
-- list_members row, which is every promote and demote. Nothing in this suite
-- exercised a role change, so the feature was dead in production and unnoticed.
--
-- That trigger no longer exists in any migration here (profiles' own RLS gives
-- the same guarantee one layer down). The lesson it left is this assertion.
select lives_ok(
  $$ update public.list_members set role = 'moderator'
     where list_id = '00000000-0000-0000-0000-0000000000a1' and user_id = 'user_g' $$,
  'the list owner can actually promote a member'
);

select is(
  (select detail->>'to' from public.security_events
   where kind = 'member_role_changed' and detail->>'target' = 'user_g'),
  'moderator',
  'a role change records what it changed to'
);

delete from public.list_members
where list_id = '00000000-0000-0000-0000-0000000000a1' and user_id = 'user_g';

select is(
  (select detail->>'self' from public.security_events
   where kind = 'member_removed' and detail->>'target' = 'user_g'),
  'false',
  'a removal records that it was not the member leaving voluntarily'
);

-- ── 10e. A membership cannot be reassigned to another account ────────────────
-- The UPDATE policy on list_members gates the row, not the columns, and a
-- moderator satisfies it. Until prevent_membership_identity_change()
-- (003_lists_and_members.sql) existed, that let a moderator PATCH somebody
-- else's row and point it at any account with a profile — evicting the target
-- and admitting the new account in one statement.
--
-- Worth spelling out what that walked past, because each is a rule asserted
-- elsewhere in this file: the DELETE policy protects the owner and fellow
-- moderators (10d's fixtures), the invite code is the only way in (assertion 5),
-- the membership cap is BEFORE INSERT so it never sees the row, and neither
-- audit trigger fires — so nothing above reaches security_digest().
--
-- Run as `authenticated` rather than the superuser: the point is that the whole
-- stack rejects this, policy and trigger together, on the path a hand-crafted
-- PostgREST call actually takes.
insert into public.profiles (user_id, display_name) values
  ('user_mod', 'User Mod'),
  ('user_victim', 'User Victim'),
  ('user_alt', 'User Alt');

-- A moderator who is NOT the owner (user_a owns List A), in two lists so
-- the list_id assertion below is rejected by the trigger rather than by the
-- policy's WITH CHECK.
insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'user_mod', 'moderator'),
  ('00000000-0000-0000-0000-0000000000b1', 'user_mod', 'moderator'),
  ('00000000-0000-0000-0000-0000000000a1', 'user_victim', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_mod"}';

select throws_ok(
  $$ update public.list_members set user_id = 'user_alt'
     where list_id = '00000000-0000-0000-0000-0000000000a1'
       and user_id = 'user_victim' $$,
  'P0001',
  null,
  'a moderator cannot repoint another member''s row at a different account'
);

-- The owner's own row, which the DELETE policy explicitly refuses to let a
-- moderator remove. An UPDATE must not be the way around that.
select throws_ok(
  $$ update public.list_members set user_id = 'user_alt'
     where list_id = '00000000-0000-0000-0000-0000000000a1'
       and user_id = 'user_a' $$,
  'P0001',
  null,
  'a moderator cannot evict the list owner by rewriting their membership row'
);

-- Moving a row between two lists the actor moderates: the policy is satisfied
-- at both ends, so only the trigger can refuse it.
select throws_ok(
  $$ update public.list_members
     set list_id = '00000000-0000-0000-0000-0000000000b1'
     where list_id = '00000000-0000-0000-0000-0000000000a1'
       and user_id = 'user_victim' $$,
  'P0001',
  null,
  'a membership cannot be moved into another list'
);

reset role;

-- And the trigger is not so broad that it blocks the legitimate update on the
-- very row the attack targets. Same lesson as the promote assertion above: a
-- guard nobody exercises is a guard that can silently kill a feature.
set local request.jwt.claims = '{"sub":"user_a"}';

select lives_ok(
  $$ update public.list_members set role = 'moderator'
     where list_id = '00000000-0000-0000-0000-0000000000a1'
       and user_id = 'user_victim' $$,
  'the owner can still change a role on a row whose identity is now frozen'
);

-- ── 10b. The lists UPDATE policy constrains the new row ───────────────────
-- An earlier revision of this policy carried `with check (true)`: USING
-- correctly asked "may you touch this list", but nothing constrained the row
-- the update produced, leaving the triggers as the only guard. The outage
-- described just above is what that costs when a trigger drifts. Asserted
-- against the catalog rather than by attempting an update, because what is being
-- protected is the policy's own invariant: a future edit that drops back to
-- `true` should fail here, whatever the triggers happen to cover that day. Same
-- shape as assertion 2, which guards against a function coming back.
reset role;

select isnt(
  (select with_check from pg_policies
   where schemaname = 'public'
     and tablename = 'lists'
     and policyname = 'list owner or moderator can update list'),
  'true',
  'the lists UPDATE policy constrains the new row, not only the old one'
);

-- ── 11. Catalog write rate limiting (002_security_audit.sql) ──────────────────────────
-- bump_product_popularity increments add_count on *global* rows, and add_count
-- drives the suggestion ranking every list sees. Unlimited, it let one account
-- push any product to the top of everyone's list. A Vercel firewall rule cannot
-- reach this: the browser calls Supabase directly, so the limiter lives here.

-- Dedicated fixtures: a global product and an account that no earlier assertion
-- has touched, so the counts below are exact rather than relative to whatever
-- budget section 7 already spent.
insert into public.product_catalog (name, maker, search_text, source, list_id, add_count)
values ('Throttle Probe', 'Acme', 'throttle probe acme', 'curated', null, 0);

-- 11a. The counter table is as locked down as the audit log.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_rate"}';

select throws_ok(
  $$ select * from public.rate_limit_counters $$,
  '42501',
  null,
  'a signed-in user cannot read the rate-limit counters'
);

select throws_ok(
  $$ update public.rate_limit_counters set hits = 0 $$,
  '42501',
  null,
  'a signed-in user cannot reset their own rate-limit counter'
);

reset role;

-- 11b. Normal use is unaffected. A handful of bumps still lands.
set local request.jwt.claims = '{"sub":"user_rate"}';

do $$
begin
  for i in 1..5 loop
    perform public.bump_product_popularity('Throttle Probe', 'Acme', null);
  end loop;
end $$;

select is(
  (select add_count::int from public.product_catalog
   where search_text = 'throttle probe acme' and list_id is null),
  5,
  'ordinary bumps are counted, not throttled'
);

-- 11c. Past the ceiling the increments stop. 240/hour is the limit, so another
-- 300 calls must leave add_count at 240 rather than 305.
do $$
begin
  for i in 1..300 loop
    perform public.bump_product_popularity('Throttle Probe', 'Acme', null);
  end loop;
end $$;

select is(
  (select add_count::int from public.product_catalog
   where search_text = 'throttle probe acme' and list_id is null),
  240,
  'ranking inflation stops dead at the hourly ceiling'
);

-- 11d. Crossing the limit is audited exactly once per window, not once per call,
-- so hammering leaves a readable trail rather than burying it.
select is(
  (select count(*)::int from public.security_events
   where actor = 'user_rate' and kind = 'rate_limited'
     and detail->>'for' = 'catalog_bump'),
  1,
  'crossing the ceiling logs one audit row per window, not one per request'
);

-- 11e. The digest rolls the log up for a human to read. It is service-role only:
-- SECURITY DEFINER lets it read the locked-down table, so the grant is the only
-- thing between a signed-in user and the audit trail.
select throws_ok(
  $$ set local role authenticated;
     select * from public.security_digest() $$,
  '42501',
  null,
  'a signed-in user cannot read the audit digest'
);

select ok(
  (select count(*) from public.security_digest(7)) > 0,
  'the digest summarizes the events recorded by this suite'
);

-- ── 12. The item-insert ceiling (004_shopping_list.sql) ─────────────
-- The list had a breadth cap (50 active items per member) but no rate cap, so an
-- account could add, check out and re-add forever -- and every insert fires the
-- push fan-out at everyone else in the list.
--
-- Note the fixtures use checked = true rows on purpose. The per-member active
-- item cap (004_shopping_list.sql) returns early for checked rows, so this
-- exercises the rate limiter against a ceiling of 300 without the 50-item cap
-- rejecting everything first. The unique index is likewise partial on unchecked
-- rows, so repeat names do not collide either.
reset role;
set local request.jwt.claims = '{"sub":"user_ins"}';

-- 12a. Ordinary use is untouched. A normal shop is a few dozen adds.
do $$
begin
  for i in 1..5 loop
    insert into public.shopping_list_items (list_id, name, added_by, checked)
    values ('00000000-0000-0000-0000-0000000000a1', 'RL Probe ' || i, 'user_ins', true);
  end loop;
end $$;

select is(
  (select count(*)::int from public.shopping_list_items where added_by = 'user_ins'),
  5,
  'ordinary item adds are not throttled'
);

-- 12b. Past the ceiling the inserts stop.
--
-- 301 rather than 300 is the designed behaviour, not an off-by-one. The call
-- that crosses the limit is allowed to commit so that the audit row
-- rate_limit_hit() writes on that same call survives -- raising there would roll
-- the row back with the item and the throttle would fire forever leaving no
-- trace. 12c is the assertion that this actually works.
--
-- Each rejected insert is caught in its own subtransaction, which also rolls
-- back that attempt's counter increment; that is why the persisted count settles
-- at limit + 1 rather than climbing with every attempt.
do $$
begin
  for i in 6..400 loop
    begin
      insert into public.shopping_list_items (list_id, name, added_by, checked)
      values ('00000000-0000-0000-0000-0000000000a1', 'RL Probe ' || i, 'user_ins', true);
    exception when others then
      null;  -- throttled; keep attempting so the count below is a ceiling, not a stop
    end;
  end loop;
end $$;

select is(
  (select count(*)::int from public.shopping_list_items where added_by = 'user_ins'),
  301,
  'item inserts stop dead at the hourly ceiling however many are attempted'
);

-- 12c. The ceiling being hit is recorded. This is the assertion that the whole
-- "let the crossing call commit" design exists for: without it the audit row
-- rolls back with the rejected insert every single time, and the one signal that
-- someone is hammering the list never reaches security_events.
select is(
  (select count(*)::int from public.security_events
   where actor = 'user_ins' and kind = 'rate_limited'
     and detail->>'for' = 'item_insert'),
  1,
  'crossing the item ceiling is audited once per window'
);

-- 12d. The limiter is for authenticated clients. The seed path, the service role
-- and this suite insert with no JWT, and rate_limit_hit() refuses an actorless
-- caller outright -- so without the early return in the trigger every superuser
-- insert above would have failed.
set local request.jwt.claims = '{}';

select lives_ok(
  $$ insert into public.shopping_list_items (list_id, name, added_by, checked)
     values ('00000000-0000-0000-0000-0000000000a1', 'Seeded Row', 'user_seed', true) $$,
  'an insert with no authenticated actor is not throttled'
);

-- ── 13. Leaving is not the same event as being removed ──────────────────────
-- Both used to log 'member_removed' with a `self` flag in detail.
-- security_digest() groups by kind and cannot see inside detail, so the poller
-- reading it could only alert on the mixed bucket -- "three people left" looked
-- exactly like "someone is emptying a list". 10a above still covers the kick.
reset role;
set local request.jwt.claims = '{"sub":"user_leave"}';

insert into public.profiles (user_id, display_name) values ('user_leave', 'Leaver');
insert into public.list_members (list_id, user_id, role)
values ('00000000-0000-0000-0000-0000000000a1', 'user_leave', 'member');

delete from public.list_members
where list_id = '00000000-0000-0000-0000-0000000000a1' and user_id = 'user_leave';

select is(
  (select kind from public.security_events where detail->>'target' = 'user_leave'),
  'member_left',
  'a member removing themselves is logged as leaving, not as being removed'
);

-- ── 14. The profile write ceiling (003_lists_and_members.sql) ─────────────
-- profiles is the one table a client writes freely about itself -- the app
-- refreshes display_name and image_url on every boot -- so there is no breadth
-- cap to lean on, and everyone sharing a list renders from it.
set local request.jwt.claims = '{"sub":"user_prof"}';

-- Write 1 of the window.
insert into public.profiles (user_id, display_name) values ('user_prof', 'P1');

-- Writes 2..121. 121 is the ceiling plus the crossing call, which is allowed
-- through so its audit row survives -- see 004_shopping_list.sql for why.
do $$
begin
  for i in 2..121 loop
    update public.profiles set display_name = 'P' || i where user_id = 'user_prof';
  end loop;
end $$;

select is(
  (select display_name from public.profiles where user_id = 'user_prof'),
  'P121',
  'ordinary profile writes are not throttled'
);

select throws_ok(
  $$ update public.profiles set display_name = 'over the line' where user_id = 'user_prof' $$,
  'P0001',
  null,
  'profile writes stop at the hourly ceiling'
);

-- ── 15. Table privileges match what the policies describe ───────────────────
-- Grants and RLS are separate gates, and hosted Supabase opens the first one for
-- anon, authenticated and service_role at provisioning. Every file here only ever
-- added grants, so those defaults survived: production had INSERT/UPDATE/DELETE on
-- purchase_history and product_catalog for authenticated, and full access for anon,
-- on tables these files describe as read-only. Only the absence of a matching
-- policy made the descriptions true.
--
-- These assertions are cheap insurance rather than a reproduction: a database built
-- from these migrations alone never had the stray grants to begin with. What they
-- catch is the next stray grant, whoever adds it.
reset role;
set local role anon;

select throws_ok(
  $$ select * from public.lists $$,
  '42501',
  null,
  'an anonymous caller cannot reach the lists table at all'
);

-- Functions too. `revoke ... from public` leaves the EXECUTE that the platform
-- grants anon by name (see 002), and search_catalog has no signed-in check of
-- its own, so it answered anyone holding the anon key.
reset role;
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_list', 'join_list_with_code', 'buy_items',
                       'add_custom_product', 'bump_product_popularity', 'search_catalog')
     and has_function_privilege('anon', p.oid, 'execute')),
  null,
  'an anonymous caller cannot execute the signed-in RPCs'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

-- The header of 005 says a direct insert path would let a member forge author
-- names and post-date purchased_at. buy_items() is the only writer.
select throws_ok(
  $$ insert into public.purchase_history (checkout_id, list_id, name, purchased_by)
     values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'forged', 'user_a') $$,
  '42501',
  null,
  'a signed-in user cannot write purchase history directly'
);

-- The header of 006 says "Clients never write this table."
select throws_ok(
  $$ insert into public.product_catalog (name, search_text, source)
     values ('Smuggled', 'smuggled', 'community') $$,
  '42501',
  null,
  'a signed-in user cannot write the product catalog directly'
);

-- ── An avatar may only point at Clerk ───────────────────────────────────────
-- profiles.image_url is member-controlled and rendered as an <img src> for every
-- co-member, so an arbitrary https host is a beacon: it reports their IP, device
-- and viewing time to whoever chose it. Clerk serves every avatar from
-- img.clerk.com whatever the original source, so nothing legitimate is lost.
--
-- Asserted here because the bound lives inside `create table if not exists` as
-- well as in an explicit ALTER, and only the ALTER reaches a database that
-- already exists. A future edit to the inline copy alone would look right and
-- change nothing.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_avatar"}';

select throws_ok(
  $$ insert into public.profiles (user_id, display_name, image_url)
     values ('user_avatar', 'Beacon', 'https://attacker.example/pixel.png') $$,
  '23514',
  null,
  'a profile avatar cannot point at an arbitrary https host'
);

select lives_ok(
  $$ insert into public.profiles (user_id, display_name, image_url)
     values ('user_avatar', 'Legit', 'https://img.clerk.com/abc123.png') $$,
  'a Clerk-hosted avatar is accepted'
);

-- ── create_list() is all-or-nothing ────────────────────────────────────
-- Creating a list is three writes (profile, list, membership) and it
-- used to be three round trips from the client, with a compensating DELETE if
-- the last one failed. When that compensation failed too, the leftover list
-- permanently occupied the account's one ownership slot
-- (lists_one_per_owner) while being invisible to every list in the app --
-- all of which are built from list_members. Nothing in the UI could reach
-- it to leave or delete it.
--
-- These two cases are the guarantee that replaced it: the failure path leaves
-- nothing behind, and the success path leaves a list with its creator
-- already in it.
-- Seeded as the superuser so RLS is out of the way, the same way the fixtures at
-- the top of this file are: the direct-insert policy only covers a creator
-- seeding their own list, which is not what is being set up here.
reset role;

-- user_cap is already at the membership ceiling (3), so the membership insert
-- inside create_list() is guaranteed to be rejected by the limit trigger.
insert into public.profiles (user_id, display_name) values ('user_cap', 'Capped');
insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'user_cap', 'member'),
  ('00000000-0000-0000-0000-0000000000b1', 'user_cap', 'member'),
  ('00000000-0000-0000-0000-0000000000c1', 'user_cap', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_cap"}';

-- The message is asserted, not just the SQLSTATE: create_list() raises
-- P0001 for a malformed name and a malformed invite code too, so a bare code
-- check here would pass on the wrong rejection entirely. (It did, first time --
-- the code below originally contained a 0 and a 1, which the alphabet excludes.)
select throws_ok(
  $$ select public.create_list('Fourth', 'CREATEAB', 'Capped', null) $$,
  'P0001',
  'You can be part of at most 3 lists.',
  'creating a fourth list is refused by the membership limit'
);

-- The whole point. Before this function existed, the lists row survived a
-- rejected membership and there was no way for its owner to reach it again.
select is(
  (select count(*)::int from public.lists where created_by = 'user_cap'),
  0,
  'a refused membership rolls the list row back with it, leaving no orphan'
);

-- And the success path, so the rollback above is not passing merely because the
-- function never writes anything.
set local request.jwt.claims = '{"sub":"user_make"}';
select is(
  (select name from public.create_list('Made', 'CREATECD', 'Maker', null)),
  'Made',
  'create_list returns the list it created'
);

select is(
  (select role from public.list_members m
    join public.lists h on h.id = m.list_id
   where h.created_by = 'user_make' and m.user_id = 'user_make'),
  'moderator',
  'the creator is seeded as a moderator of the list in the same transaction'
);

-- 13. Soft delete and bans: the columns exist and start empty.
--
-- Thin on purpose. What these guard is that the columns reached the database at
-- all -- both are declared outside the create-table block, where a mistake is
-- silent and shows up only as "column does not exist" against production weeks
-- later. The behaviour they carry is tested in 14 and 15 below.
select has_column('public', 'lists', 'deleted_at',
  'lists.deleted_at exists');
select has_column('public', 'profiles', 'banned_at',
  'profiles.banned_at exists');
select is(
  (select count(*)::int from public.lists where deleted_at is not null),
  0,
  'no list starts out deleted'
);

-- 14. active_list_ids() is the one definition, and it excludes the deleted.
--
-- Note the claims are never RESET between these: lists has an update
-- trigger that parses request.jwt.claims as json, and a reset leaves it as the
-- empty string rather than absent, so the trigger fails on input it cannot
-- parse. Every update below therefore keeps a valid claims object set, and only
-- the role changes to bypass RLS for the admin-side writes.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select isnt(
  (select count(*)::int from public.active_list_ids()),
  0,
  'user_a is in at least one live list'
);

reset role;
update public.lists set deleted_at = now()
  where id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;

select is(
  (select count(*)::int from public.active_list_ids() as h
   where h = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a deleted list drops out of active_list_ids()'
);

-- 15. A deleted list hides everything inside it, and destroys nothing.
--
-- The failure this guards is silent: get one policy wrong and the app keeps
-- serving rows from a list an admin believes they removed, with nothing
-- anywhere reporting it. Hence the contents, not just the list row.
select is(
  (select count(*)::int from public.lists
   where id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see their deleted list'
);

select is(
  (select count(*)::int from public.shopping_list_items
   where list_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see items inside a deleted list'
);

select is(
  (select count(*)::int from public.purchase_history
   where list_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see purchase history inside a deleted list'
);

select is(
  (select count(*)::int from public.product_catalog
   where list_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see list-scoped products inside a deleted list'
);

-- The roster too. This one reaches the database through is_member_of_list()
-- rather than the inlined subquery, so an audit that greps for the subquery
-- misses it -- and a list with everything else hidden would still tell its
-- members who else was in it.
select is(
  (select count(*)::int from public.list_members
   where list_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see the roster of a deleted list'
);

-- Nor can one be checked out of it. buy_items is SECURITY DEFINER, so no policy
-- stands in its way: it has to ask active_list_ids() itself, and it used to
-- read list_members, which a soft delete leaves in place. A member whose
-- phone still holds the ids from before the delete could empty the frozen list.
reset role;
insert into public.shopping_list_items (id, list_id, name, added_by, checked) values
  ('00000000-0000-0000-0000-0000000000a8',
   '00000000-0000-0000-0000-0000000000a1', 'frozen checked item', 'user_a', true);
set local role authenticated;

select is(
  public.buy_items(array['00000000-0000-0000-0000-0000000000a8']::uuid[]),
  0,
  'buy_items moves nothing out of a deleted list'
);

-- Soft, not hard: the rows are still there for an admin to restore.
reset role;
select isnt(
  (select count(*)::int from public.shopping_list_items
   where list_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'the items are physically present: this is a soft delete'
);

update public.lists set deleted_at = null
  where id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;

select is(
  (select count(*)::int from public.lists
   where id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'restoring makes the list visible again'
);

reset role;

-- 16. A ban sticks, because the profile upsert refuses to revive the row.
--
-- The reason banned_at exists rather than a deleted_at on profiles: the app
-- upserts display_name and image_url on every boot, so a deleted profile row
-- returns the moment that person opens Bagful. Their Clerk account is a
-- separate system this database cannot reach. Flagging the row is only half of
-- it; refusing the upsert is the half that works.
--
-- A fresh account that owns nothing, deliberately. Reusing a seeded user made
-- the unban assertion fail against lists_one_per_owner rather than against
-- anything to do with bans -- a green-looking test measuring the wrong rule.
reset role;
insert into public.profiles (user_id, display_name) values ('user_banned', 'Banned Person');
update public.profiles set banned_at = now() where user_id = 'user_banned';

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_banned"}';

select throws_ok(
  $$ select * from public.create_list('Banned Attempt', 'ZZZZZZZ2', 'Nope', null) $$,
  'P0001',
  'This account has been suspended.',
  'a banned account cannot create a list: the profile upsert refuses'
);

reset role;
select is(
  (select count(*)::int from public.lists where name = 'Banned Attempt'),
  0,
  'and nothing was created on the way to being refused'
);

update public.profiles set banned_at = null where user_id = 'user_banned';
set local role authenticated;

select lives_ok(
  $$ select * from public.create_list('Unbanned Attempt', 'ZZZZZZZ3', 'Fine', null) $$,
  'lifting the ban lets the same account through again'
);

-- The OTHER upsert. Both doors need the guard, and a guard with no test on it is
-- the one that gets refactored away.
reset role;
update public.profiles set banned_at = now() where user_id = 'user_banned';
set local role authenticated;

select throws_ok(
  $$ select * from public.join_list_with_code('BBBBBBB2', 'Nope', null) $$,
  'P0001',
  'This account has been suspended.',
  'a banned account cannot join a list either'
);

reset role;

-- 17. merge_items folds a row into its twin in one step.
--
-- It replaced two client writes (the quantity, then the delete) whose undo could
-- be lost, counting the quantity twice. List C is used because A is capped
-- at one active item above.
insert into public.shopping_list_items (id, list_id, name, added_by, checked, quantity) values
  ('00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000c1', 'merge target', 'user_c', false, 600),
  ('00000000-0000-0000-0000-0000000000c3',
   '00000000-0000-0000-0000-0000000000c1', 'merge source', 'user_c', true, 600);

-- A stranger reaches neither row: RLS hides both, so nothing is summed.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select throws_ok(
  $$ select public.merge_items('00000000-0000-0000-0000-0000000000c3',
                               '00000000-0000-0000-0000-0000000000c2') $$,
  'P0001',
  'Nothing to merge.',
  'merge_items refuses rows in a list the caller is not in'
);

set local request.jwt.claims = '{"sub":"user_c"}';

-- The sum comes from the rows and is held at the quantity bound.
select is(
  public.merge_items('00000000-0000-0000-0000-0000000000c3',
                     '00000000-0000-0000-0000-0000000000c2'),
  999,
  'merge_items sums the two rows, held at 999'
);

select is(
  (select count(*)::int from public.shopping_list_items
   where id = '00000000-0000-0000-0000-0000000000c3'),
  0,
  'and the source row is gone'
);

select is(
  (select quantity from public.shopping_list_items
   where id = '00000000-0000-0000-0000-0000000000c2'),
  999,
  'and the target holds the sum'
);

-- A source that no longer exists leaves the target untouched: both or neither.
select throws_ok(
  $$ select public.merge_items('00000000-0000-0000-0000-0000000000c3',
                               '00000000-0000-0000-0000-0000000000c2') $$,
  'P0001',
  'Nothing to merge.',
  'merge_items refuses a source that is already gone'
);

reset role;

select * from finish();
rollback;
