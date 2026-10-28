-- AI agent: natural-language order corrections ("!order #REF teach …") and safe bulk completion ("!orders complete all").
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261101000000_ai_agent_daily_orders.sql (ai_agent_orders).
--
-- Additive and idempotent (safe to run twice): two new tables. No existing row, column or function is changed, and no
-- order or customer memory is touched. Nothing here switches a feature on.
--
--   ai_agent_order_proposals   one row per proposed correction or bulk completion. A proposal is only a PREVIEW: nothing it
--                              describes has happened until staff confirm it with its one-time code (C-XXXXX / B-XXXXX).
--                              It expires, can be replaced by a newer one, and can be applied once (status transitions are
--                              conditional updates, so a repeated or racing confirm is a no-op).
--   ai_agent_order_feedback    one row per APPLIED correction: what staff said, what the order was and became. Structured
--                              feedback about extraction mistakes. It is a record, not knowledge: nothing reads it as a
--                              fact about a customer or the business.
--
-- Both tables reference the order with ON DELETE CASCADE, so forgetting a customer's orders (forget_ai_agent_customer)
-- also erases the staff wording about them. A bulk proposal holds order ids, versions and references only.

create table if not exists public.ai_agent_order_proposals (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  kind text not null check (kind in ('correction', 'bulk_complete')),
  -- The one-time token staff type: C-XXXXX for a correction, B-XXXXX for a bulk completion. Unique per business.
  code text not null,
  status text not null default 'pending'
    check (status in ('pending', 'applying', 'applied', 'partial', 'discarded', 'expired', 'superseded', 'stale', 'failed')),
  -- The group the proposal was made in: a confirmation from anywhere else is refused.
  group_jid text not null,
  created_by text,
  -- The WhatsApp message that asked. Unique per business and kind: a redelivered command finds its own proposal.
  source_message_id text not null,
  -- Corrections only: the order and the version the preview was computed from. A newer version makes the proposal stale.
  order_id uuid references public.ai_agent_orders (id) on delete cascade,
  order_version integer,
  -- The staff member's own words (corrections only).
  instruction text,
  -- Corrections: the validated field changes and the preview. Bulk: the day, and each order's id, reference and version.
  payload jsonb not null default '{}'::jsonb,
  -- Bulk: what happened to each order.
  result jsonb,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_order_proposals_code_idx on public.ai_agent_order_proposals (business_slug, code);
create unique index if not exists ai_agent_order_proposals_message_idx on public.ai_agent_order_proposals (business_slug, source_message_id, kind);
create index if not exists ai_agent_order_proposals_open_idx on public.ai_agent_order_proposals (business_slug, kind, status);
create index if not exists ai_agent_order_proposals_order_idx on public.ai_agent_order_proposals (order_id) where order_id is not null;

create table if not exists public.ai_agent_order_feedback (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  order_id uuid not null references public.ai_agent_orders (id) on delete cascade,
  -- One feedback row per applied proposal: re-applying cannot record it twice.
  proposal_id uuid not null references public.ai_agent_order_proposals (id) on delete cascade,
  instruction text not null,
  fields text[] not null default '{}',
  before jsonb not null default '{}'::jsonb,
  after jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_order_feedback_proposal_idx on public.ai_agent_order_feedback (proposal_id);
create index if not exists ai_agent_order_feedback_recent_idx on public.ai_agent_order_feedback (business_slug, created_at desc);

alter table public.ai_agent_order_proposals enable row level security;
alter table public.ai_agent_order_feedback enable row level security;
drop policy if exists "Admins can read ai_agent_order_proposals" on public.ai_agent_order_proposals;
create policy "Admins can read ai_agent_order_proposals" on public.ai_agent_order_proposals
  for select to authenticated using (public.is_admin());
drop policy if exists "Admins can read ai_agent_order_feedback" on public.ai_agent_order_feedback;
create policy "Admins can read ai_agent_order_feedback" on public.ai_agent_order_feedback
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_order_proposals from anon;
revoke all on public.ai_agent_order_feedback from anon;
grant select on public.ai_agent_order_proposals to authenticated;
grant select on public.ai_agent_order_feedback to authenticated;
grant all on public.ai_agent_order_proposals to service_role;
grant all on public.ai_agent_order_feedback to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_order_proposals;   -- Expected: 0
--   select count(*) from public.ai_agent_order_feedback;    -- Expected: 0
