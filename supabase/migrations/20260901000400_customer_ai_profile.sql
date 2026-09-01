-- Lightweight, AI-maintained customer memory — stable facts learned across
-- conversations over time, fed back into future analysis runs instead of
-- re-reading a conversation's full history every time. Run this in the
-- Supabase SQL editor — the app has no DB credentials beyond the
-- authenticated user's own session, so this can't be applied automatically.
--
-- Keyed by (business_slug, contact_number) — one profile per customer per
-- business, matching the rest of this analysis feature (conversation_status,
-- conversation_analysis) treating "keep businesses separate" as a hard
-- requirement: a customer's order habits/preferences with one business have
-- no bearing on another.
--
-- SECURITY / DATA INTEGRITY: this table is intentionally separate from
-- `customers` and never written by anything except the analysis engine
-- (lib/server/analysisEngine.ts). Every field here is an AI-inferred guess,
-- never a verified fact — nothing in this app ever copies a value from this
-- table into `customers` (first_name/last_name/email/business_contact_name
-- etc, which are staff-entered/verified). Keeping this as its own table,
-- rather than columns on `customers`, is what makes "never let an AI guess
-- overwrite a verified field" true by construction instead of by convention.

create table if not exists customer_ai_profile (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  contact_number text not null,

  -- All soft/inferred facts, in plain text (not strictly typed — these are
  -- prose summaries the model maintains, not structured data anything else
  -- in the app queries by field).
  preferences text,
  common_orders text,
  addresses text,
  payment_habits text,
  important_notes text,
  last_known_intent text,

  updated_at timestamptz not null default now(),

  unique (business_slug, contact_number)
);

create or replace function touch_customer_ai_profile_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_customer_ai_profile_updated_at on customer_ai_profile;
create trigger trg_touch_customer_ai_profile_updated_at
  before update on customer_ai_profile
  for each row execute function touch_customer_ai_profile_updated_at();

create index if not exists customer_ai_profile_lookup_idx
  on customer_ai_profile (business_slug, contact_number);

-- RLS: authenticated users only, same permissive "any staff member can read
-- this shared inbox intelligence" model as conversation_analysis — this
-- isn't a secret like ai_settings.api_key, it's business intelligence
-- staff already have access to via the conversations themselves. Writes
-- happen server-side (the /api/analysis route, via the service-role key).
alter table customer_ai_profile enable row level security;

drop policy if exists "Authenticated can read customer AI profiles" on customer_ai_profile;
create policy "Authenticated can read customer AI profiles"
  on customer_ai_profile for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert customer AI profiles" on customer_ai_profile;
create policy "Authenticated can insert customer AI profiles"
  on customer_ai_profile for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update customer AI profiles" on customer_ai_profile;
create policy "Authenticated can update customer AI profiles"
  on customer_ai_profile for update
  to authenticated
  using (true)
  with check (true);
