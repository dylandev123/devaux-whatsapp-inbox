-- Permanent, append-only customer order history. Run this in the Supabase SQL
-- editor — the app has no DB credentials beyond the authenticated user's own
-- session, so this can't be applied automatically. Run it BEFORE deploying the
-- code that writes to it (the analysis engine treats a missing table as a
-- logged, non-fatal error, so analysis keeps working, but orders detected in
-- the meantime are not recorded).
--
-- WHY: whatsapp_messages is purged after ~7 days, and conversation_analysis is
-- ONE row per (business_slug, chat_id) that is overwritten on every re-analysis
-- — so a customer's second order replaces the first. Each genuine order gets
-- its own row here instead, copied out of conversation_analysis.extracted.
--
-- RETENTION INDEPENDENCE: deliberately NO foreign keys to whatsapp_messages,
-- conversation_analysis, or customers. source_analysis_id is a plain uuid
-- breadcrumb. Deleting/purging any of those can never cascade into this table.
--
-- DEDUPE KEY: unique (business_slug, chat_id, order_seq). order_seq is 1 for
-- the first order detected in a conversation, 2 for the next, and so on. The
-- engine (lib/server/analysisEngine.ts) only allocates seq N+1 when the model
-- says the new messages place a distinct additional order AND the analysis has
-- seen messages newer than those already synced into order N; otherwise it
-- updates order N in place. Re-running the same analysis therefore can never
-- create a row. The unique constraint backstops concurrent runs.
--
-- WRITES: only the analysis engine (service role) inserts/updates, plus the
-- status trigger below. Staff only read.

create table if not exists public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  -- Same key as customer_ai_profile / customers.phone_number
  -- (resolveRecipientNumber(contact_number, chat_id)).
  contact_number text not null,
  order_seq integer not null check (order_seq >= 1),

  customer_name text,             -- display snapshot at sync time
  summary text not null,          -- AI summary at sync time
  -- Copy of conversation_analysis.extracted (products_services, quantity,
  -- dates, address, payment_info, booking_info). Structured JSON on purpose.
  details jsonb not null default '{}'::jsonb,
  delivery_address text,          -- = details.address, denormalized for display/search
  payment_info text,              -- = details.payment_info
  order_status text check (order_status in ('Needs adding', 'Added', 'Completed')),
  confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  -- Provenance (no FK — see above).
  source_analysis_id uuid,
  -- Timestamp of the newest message covered when this order was FIRST
  -- recorded (≈ when the order was placed) — the date shown in history.
  source_message_at timestamptz,
  -- Timestamp of the newest message covered by the latest sync. The "has the
  -- conversation moved on since this order was recorded" check for dedupe.
  source_last_message_at timestamptz,
  detected_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_orders_source_uniq unique (business_slug, chat_id, order_seq)
);

create index if not exists customer_orders_customer_idx
  on public.customer_orders (business_slug, contact_number, source_message_at desc);

create or replace function public.touch_customer_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_customer_orders_updated_at on public.customer_orders;
create trigger trg_touch_customer_orders_updated_at
  before update on public.customer_orders
  for each row execute function public.touch_customer_orders_updated_at();

-- ── Status sync ──────────────────────────────────────────────────────────────
-- The Orders Queue keeps editing conversation_analysis.order_status exactly as
-- before. Whenever that changes, mirror it onto the NEWEST order row of that
-- conversation (the one the queue entry represents). Older orders keep their
-- final status. security definer because staff have no write access here.
create or replace function public.sync_customer_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_status is not null and new.order_status is distinct from old.order_status then
    update public.customer_orders
       set order_status = new.order_status
     where id = (
       select o.id from public.customer_orders o
        where o.business_slug = new.business_slug and o.chat_id = new.chat_id
        order by o.order_seq desc
        limit 1
     );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_customer_order_status on public.conversation_analysis;
create trigger trg_sync_customer_order_status
  after update of order_status on public.conversation_analysis
  for each row execute function public.sync_customer_order_status();

-- ── RLS: same "any signed-in staff can read" model as conversation_analysis ──
alter table public.customer_orders enable row level security;

drop policy if exists "Authenticated can read customer orders" on public.customer_orders;
create policy "Authenticated can read customer orders"
  on public.customer_orders for select
  to authenticated
  using (true);

grant select on public.customer_orders to authenticated;
grant all on public.customer_orders to service_role;
