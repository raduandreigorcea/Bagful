-- Deleting an account (003_lists_and_members.sql, delete_my_account()).
--
-- The owned list goes to the member picked, or is deleted for everyone; the
-- caller's memberships, profile and audit rows go; items they added in other
-- lists stay; history forgets their name and photo. And the owner is still
-- permanent for every path that is not this function.
--
-- Run with `supabase test db` after `supabase db reset`.

begin;
select plan(21);

insert into public.profiles (user_id, display_name, image_url) values
  ('own',  'Owner',  'https://img.clerk.com/own'),
  ('mem',  'Member', null),
  ('busy', 'Busy',   null),
  ('solo', 'Solo',   null),
  ('m3',   'M3',     null),
  ('ban',  'Banned', 'https://img.clerk.com/ban');

update public.profiles set banned_at = now() where user_id = 'ban';
insert into public.security_events (kind, actor, detail)
values ('admin_user_banned', 'an_admin', '{"target":"ban"}');

insert into public.lists (id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-00000000ac01', 'Owned', 'ACCAAAA2', 'own'),
  ('00000000-0000-0000-0000-00000000ac02', 'Busy',  'ACCBBBB2', 'busy'),
  ('00000000-0000-0000-0000-00000000ac03', 'Solo',  'ACCCCCC2', 'solo');

insert into public.list_members (list_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000ac01', 'own',  'moderator'),
  ('00000000-0000-0000-0000-00000000ac01', 'mem',  'member'),
  ('00000000-0000-0000-0000-00000000ac01', 'busy', 'member'),
  ('00000000-0000-0000-0000-00000000ac02', 'busy', 'moderator'),
  ('00000000-0000-0000-0000-00000000ac02', 'own',  'member'),
  ('00000000-0000-0000-0000-00000000ac03', 'solo', 'moderator'),
  ('00000000-0000-0000-0000-00000000ac03', 'm3',   'member');

-- What 'own' left in a list they do not own.
insert into public.shopping_list_items (list_id, name, added_by) values
  ('00000000-0000-0000-0000-00000000ac02', 'Milk', 'own');
insert into public.purchase_history
  (checkout_id, list_id, name, added_by, added_by_name, added_by_image_url, purchased_by)
values
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000ac02', 'Bread',
   'own', 'Owner', 'https://img.clerk.com/own', 'own');
insert into public.security_events (kind, actor) values ('test_event', 'own');

set local role authenticated;
set local request.jwt.claims = '{"sub":"own"}';

select is(
  (select array_agg(user_id || ':' || owns_list order by user_id)
   from public.account_transfer_candidates()),
  array['busy:true', 'mem:false'],
  'candidates are the other members, flagged when they already own a list'
);

select throws_ok(
  $$ update public.lists set created_by = 'mem'
     where id = '00000000-0000-0000-0000-00000000ac01' $$,
  'P0001',
  'List owner cannot be changed.',
  'the owner still cannot be changed directly'
);

select throws_ok(
  $$ select public.delete_my_account('busy') $$,
  'P0001',
  'The new owner already owns a list.',
  'a member who owns a list cannot take this one'
);

select throws_ok(
  $$ select public.delete_my_account('m3') $$,
  'P0001',
  'The new owner must be a member of the list.',
  'someone outside the list cannot take it'
);

select lives_ok(
  $$ select public.delete_my_account('mem') $$,
  'deleting with a new owner succeeds'
);

reset role;

select is(
  (select created_by from public.lists where id = '00000000-0000-0000-0000-00000000ac01'),
  'mem',
  'the list now belongs to the member picked'
);

select is(
  (select role from public.list_members
   where list_id = '00000000-0000-0000-0000-00000000ac01' and user_id = 'mem'),
  'moderator',
  'the new owner carries the rank an owner is created with'
);

select is(
  (select count(*)::int from public.list_members where user_id = 'own'),
  0,
  'every membership is gone'
);

select is(
  (select count(*)::int from public.profiles where user_id = 'own'),
  0,
  'the profile is gone'
);

select is(
  (select count(*)::int from public.shopping_list_items where added_by = 'own'),
  1,
  'items added to someone else''s list stay'
);

select is(
  (select row(added_by, added_by_name, added_by_image_url, purchased_by)::text
   from public.purchase_history where name = 'Bread'),
  row(null::text, null::text, null::text, 'deleted'::text)::text,
  'history forgets who added and bought it'
);

select is(
  (select count(*)::int from public.security_events where actor = 'own' and kind = 'test_event'),
  1,
  'the audit log is kept: deleting cannot erase what was logged about the account'
);

select is(
  (select count(*)::int from public.security_events
   where kind = 'account_deleted' and actor is null),
  1,
  'the deletion itself is counted, anonymously'
);

-- Not naming anyone deletes the list for everyone.
set local role authenticated;
set local request.jwt.claims = '{"sub":"solo"}';

select lives_ok(
  $$ select public.delete_my_account() $$,
  'deleting without a new owner succeeds'
);

reset role;

select is(
  (select count(*)::int from public.lists where id = '00000000-0000-0000-0000-00000000ac03'),
  0,
  'the list nobody took over is deleted'
);

select is(
  (select count(*)::int from public.list_members
   where list_id = '00000000-0000-0000-0000-00000000ac03'),
  0,
  'and its other members go with it'
);

-- A ban survives: the row stays, without the name and photo.
set local role authenticated;
set local request.jwt.claims = '{"sub":"ban"}';

select throws_ok(
  $$ update public.profiles set banned_at = null where user_id = 'ban' $$,
  '42501',
  null,
  'a banned account cannot clear banned_at itself'
);

select lives_ok(
  $$ select public.delete_my_account() $$,
  'a banned account can still delete its data'
);

reset role;

select is(
  (select row(display_name, image_url, banned_at is not null)::text
   from public.profiles where user_id = 'ban'),
  row('Member'::text, null::text, true)::text,
  'the banned profile stays, banned and anonymous'
);

select is(
  (select count(*)::int from public.security_events
   where kind = 'admin_user_banned' and detail->>'target' = 'ban'),
  1,
  'and the record of the ban survives'
);

set local role anon;
select throws_ok(
  $$ select public.delete_my_account() $$,
  '42501',
  null,
  'anon cannot call it'
);
reset role;

select * from finish();
rollback;
