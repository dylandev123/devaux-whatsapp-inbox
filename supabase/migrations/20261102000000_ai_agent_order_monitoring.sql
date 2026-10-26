-- AI agent: order monitoring of ALL customer conversations + the opt-in historical backfill.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261101000000_ai_agent_daily_orders.sql (and every earlier 20261022–20261031 agent migration).
--
--   1. ai_agent_order_backfill_runs: the audit and progress record of an admin-started recovery of orders from the last
--      24-72 hours of stored messages that the old allow-list restriction never analysed. One running run per business.
--
-- Additive. Nothing is switched on and nothing runs by itself: a backfill only exists once an admin starts one from the
-- dashboard. No existing table, column or function is changed.

create table if not exists public.ai_agent_order_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'cancelled')),
  hours integer not null check (hours between 1 and 72),
  window_start timestamptz not null,
  window_end timestamptz not null,
  -- The conversations planned when the run started, and the ones finished so far (a step can be repeated safely:
  -- every write it makes is keyed by run + chat + chunk).
  chat_ids text[] not null default '{}',
  done_chat_ids text[] not null default '{}',
  chats_total integer not null default 0,
  chats_done integer not null default 0,
  messages_analysed integer not null default 0,
  orders_touched integer not null default 0,
  failures integer not null default 0,
  note text,
  started_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- At most one run per business is in progress; starting another resumes it instead.
create unique index if not exists ai_agent_order_backfill_one_running_idx
  on public.ai_agent_order_backfill_runs (business_slug) where status = 'running';
create index if not exists ai_agent_order_backfill_recent_idx
  on public.ai_agent_order_backfill_runs (business_slug, created_at desc);

drop trigger if exists trg_touch_ai_agent_order_backfill_runs on public.ai_agent_order_backfill_runs;
create trigger trg_touch_ai_agent_order_backfill_runs before update on public.ai_agent_order_backfill_runs
  for each row execute function public.touch_ai_agent_updated_at();

alter table public.ai_agent_order_backfill_runs enable row level security;
drop policy if exists "Admins can read ai_agent_order_backfill_runs" on public.ai_agent_order_backfill_runs;
create policy "Admins can read ai_agent_order_backfill_runs" on public.ai_agent_order_backfill_runs
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_order_backfill_runs from anon;
grant select on public.ai_agent_order_backfill_runs to authenticated;
grant all on public.ai_agent_order_backfill_runs to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_order_backfill_runs;   -- Expected: 0
