-- Admin role support.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function touch_profiles_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_profiles_updated_at on profiles;
create trigger trg_touch_profiles_updated_at
  before update on profiles
  for each row execute function touch_profiles_updated_at();

-- Auto-create a `staff` profile for every new auth user. This is the
-- standard Supabase pattern for keeping a public-schema profile row in sync
-- with auth.users (which the app can never query directly via RLS).
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'staff')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill profiles for any auth user that already existed before this
-- migration ran (everyone who has ever logged into this app so far).
insert into public.profiles (id, email, role)
select id, email, 'staff' from auth.users
on conflict (id) do nothing;

-- RLS: a user can only ever read their own profile/role. No insert policy —
-- rows are only ever created by the trigger above (security definer, bypasses
-- RLS). No update policy — role changes are an out-of-band SQL operation for
-- now (see the promotion below); nothing in the app can self-promote.
alter table profiles enable row level security;

drop policy if exists "Users can read their own profile" on profiles;
create policy "Users can read their own profile"
  on profiles for select
  to authenticated
  using (id = auth.uid());

-- Promote the one admin requested. If this affects 0 rows, that account
-- hasn't signed up / been created in Supabase Auth yet — create it first
-- (Supabase dashboard, or have them sign in once), then re-run just this
-- statement.
update public.profiles
set role = 'admin'
where email = 'dylandevaux3@gmail.com';
