-- Adds a pipeline `stage` to customer profiles.
-- Run this in the Supabase SQL editor (no DB credentials available from the app).
--
-- Everything else Priority 4 asked for already exists from
-- supabase/migrations/20260622000000_customers.sql: phone_number (unique not
-- null), whatsapp_name, first_name, last_name, email, notes, tags (text[]),
-- source_business, last_message_at, created_at, updated_at. This migration
-- only adds the missing piece: `stage`.

alter table customers add column if not exists stage text;

create index if not exists customers_stage_idx on customers (stage);

-- Free text rather than a DB-level check constraint — the only defined stage
-- list so far is for By Sea Tours specifically, and other businesses may
-- need their own list later without another migration. The current default
-- options (enforced in the UI dropdown, not the database) are:
--   New Lead, Quoting, Waiting on Guest, Deposit Pending, Booked,
--   Completed, Follow Up, Not Interested
--
-- No RLS changes needed: the existing "Authenticated can update customers"
-- policy (using (true) with check (true)) already covers this new column.
