-- Booking CRM for By Sea Tours (and any other business later).
-- Run this in the Supabase SQL editor — same constraint as every other
-- migration in this project: the app has no DB credentials beyond the
-- authenticated user's own session, so this can't be applied automatically.

create table if not exists customer_bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  business_slug text not null,
  booking_reference text,
  booking_status text default 'Lead',
  service_type text,
  hotel_name text,
  arrival_date date,
  departure_date date,
  guest_count integer,
  deposit_paid boolean default false,
  deposit_amount numeric,
  balance_due numeric,
  booking_value numeric,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists customer_bookings_customer_idx on customer_bookings (customer_id);
create index if not exists customer_bookings_business_idx on customer_bookings (business_slug);
create index if not exists customer_bookings_arrival_idx on customer_bookings (arrival_date);
create index if not exists customer_bookings_reference_idx on customer_bookings (booking_reference);
create index if not exists customer_bookings_hotel_idx on customer_bookings (hotel_name);

create or replace function touch_customer_bookings_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_customer_bookings_updated_at on customer_bookings;
create trigger trg_touch_customer_bookings_updated_at
  before update on customer_bookings
  for each row execute function touch_customer_bookings_updated_at();

-- RLS: authenticated users only (no anon access at all — there's no policy
-- for `anon`, so RLS denies it by default once enabled). Same permissive
-- "any staff member can do anything" model as the customers table, since
-- this is an internal CRM tool, not multi-tenant.
alter table customer_bookings enable row level security;

drop policy if exists "Authenticated can read bookings" on customer_bookings;
create policy "Authenticated can read bookings"
  on customer_bookings for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert bookings" on customer_bookings;
create policy "Authenticated can insert bookings"
  on customer_bookings for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update bookings" on customer_bookings;
create policy "Authenticated can update bookings"
  on customer_bookings for update
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Future integration points (NOT implemented yet, per the brief):
--
--   * By Sea website sync -> `booking_reference` is the natural join key;
--     add `external_source text` (e.g. 'website') + `external_id text`
--     when that sync is built, rather than overloading booking_reference.
--   * Stripe deposits      -> add `stripe_payment_intent_id text` and a
--     `customer_payments(booking_id, amount, paid_at, provider)` table
--     instead of trying to cram payment history into deposit_amount.
--   * Jotform bookings     -> same pattern as the website sync: a
--     `external_source`/`external_id` pair, not a new table.
--   * Payment history      -> `customer_payments` table referenced above;
--     deposit_paid/deposit_amount/balance_due stay as the current-state
--     summary, payment history would be the append-only log behind them.
-- ---------------------------------------------------------------------------
