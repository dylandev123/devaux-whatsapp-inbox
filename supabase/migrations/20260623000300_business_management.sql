-- Dynamic WhatsApp business management.
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- Not run automatically — same constraint as every prior migration in this
-- project: the app has no DB credentials beyond the user's own auth session.

create extension if not exists pgcrypto;

create table if not exists whatsapp_businesses (
  id uuid primary key default gen_random_uuid(),
  business_slug text unique not null,
  display_name text not null,
  colour text default 'slate',
  is_active boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists whatsapp_businesses_active_sort_idx
  on whatsapp_businesses (is_active, sort_order);

create or replace function touch_whatsapp_businesses_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_whatsapp_businesses_updated_at on whatsapp_businesses;
create trigger trg_touch_whatsapp_businesses_updated_at
  before update on whatsapp_businesses
  for each row execute function touch_whatsapp_businesses_updated_at();

insert into whatsapp_businesses (business_slug, display_name, colour, sort_order)
values
  ('dog_food', 'Dog Food St. Lucia', 'green', 1),
  ('by_sea', 'By Sea Tours', 'blue', 2),
  ('cool_pool', 'Cool & Pool Products', 'teal', 3),
  ('candock', 'Candock Carib', 'orange', 4),
  ('supplify', 'Supplify SLU', 'purple', 5)
on conflict (business_slug) do nothing;

alter table whatsapp_businesses enable row level security;

-- NOTE on this SELECT policy, exactly as specified ("select active
-- businesses"): once a business is deactivated, it disappears from every
-- authenticated query against this table — including the admin management
-- list itself, since RLS is enforced regardless of which UI is asking. There
-- is currently no way to see/reactivate a deactivated business from the app;
-- it would need to be done with a direct SQL update, or by loosening this
-- policy later (e.g. to `using (true)`) if you want admins to retain
-- visibility into inactive rows.
drop policy if exists "Authenticated can read active businesses" on whatsapp_businesses;
create policy "Authenticated can read active businesses"
  on whatsapp_businesses for select
  to authenticated
  using (is_active = true);

drop policy if exists "Authenticated can insert businesses" on whatsapp_businesses;
create policy "Authenticated can insert businesses"
  on whatsapp_businesses for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update businesses" on whatsapp_businesses;
create policy "Authenticated can update businesses"
  on whatsapp_businesses for update
  to authenticated
  using (true)
  with check (true);
