-- Customer profiles, unified across all WhatsApp businesses.
-- Run this in the Supabase SQL editor (or via `supabase db push` if you adopt the CLI).
-- The app has no DB credentials beyond the anon/auth session, so this cannot be applied
-- automatically from the frontend.

create extension if not exists pgcrypto;

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  whatsapp_name text,
  first_name text,
  last_name text,
  email text,
  notes text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  source_business text
);

create index if not exists customers_phone_number_idx on customers (phone_number);
create index if not exists customers_tags_idx on customers using gin (tags);

-- Identity fields (id, phone_number, created_at) are never editable from the app;
-- only profile fields (name, email, tags, notes) can change via UPDATE.
create or replace function protect_customer_identity()
returns trigger as $$
begin
  new.id := old.id;
  new.phone_number := old.phone_number;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_protect_customer_identity on customers;
create trigger trg_protect_customer_identity
  before update on customers
  for each row execute function protect_customer_identity();

-- Auto-create or refresh a customer profile whenever an inbound (customer-authored)
-- message arrives for any business. Runs as SECURITY DEFINER so it works regardless
-- of which role/service inserts into whatsapp_messages (anon, authenticated, or the
-- WhatsApp bridge's own service key) and bypasses the customers RLS policies below.
create or replace function upsert_customer_from_message()
returns trigger as $$
begin
  if new.contact_number is null then
    return new;
  end if;
  if new.direction is not null and lower(new.direction) like '%out%' then
    return new;
  end if;

  insert into customers (phone_number, whatsapp_name, last_message_at, source_business)
  values (new.contact_number, new.contact_name, new.timestamp, new.business_slug)
  on conflict (phone_number) do update
    set whatsapp_name = coalesce(excluded.whatsapp_name, customers.whatsapp_name),
        last_message_at = greatest(customers.last_message_at, excluded.last_message_at),
        updated_at = now();

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_upsert_customer_from_message on whatsapp_messages;
create trigger trg_upsert_customer_from_message
  after insert on whatsapp_messages
  for each row execute function upsert_customer_from_message();

-- RLS: staff (any authenticated app user) can read every customer and edit profile
-- fields. There is intentionally no insert/delete policy for authenticated — rows
-- are only ever created by the trigger above.
alter table customers enable row level security;

drop policy if exists "Authenticated can read customers" on customers;
create policy "Authenticated can read customers"
  on customers for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can update customers" on customers;
create policy "Authenticated can update customers"
  on customers for update
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Future extensions (NOT implemented yet — listed here so the next migration
-- has an obvious place to slot in, per the "prepare for future features" ask):
--
--   * Staff assignment   -> `staff_assignments(customer_id, staff_id, assigned_at)`
--   * Internal notes/log -> `customer_activity(customer_id, author_id, body, created_at)`
--   * Follow-up reminders-> `customer_reminders(customer_id, due_at, note, completed_at)`
--   * AI summaries       -> `customer_summary(customer_id, summary, generated_at)`
--   * Customer status    -> `alter table customers add column status text
--                             check (status in ('lead','active','vip')) default 'lead';`
-- ---------------------------------------------------------------------------
