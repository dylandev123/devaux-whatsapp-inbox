-- AI agent: "!update" as a short summary of new and changed orders.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261101000000_ai_agent_daily_orders.sql (ai_agent_orders, ai_agent_order_events, the outbox).
--
-- Additive and idempotent (safe to run twice): one new table. No existing row, column or function is changed, and nothing
-- is switched on. Orders keep living only in ai_agent_orders; this table records WHEN each "!update" looked, nothing else.
--
--   ai_agent_order_update_posts   one row per "!update" answer. window_start..window_end is the span of order changes it
--                                 covered; outbox_id is the WhatsApp message that carried it.
--
-- The "since when" of the next "!update" is the window_end of the newest post whose message is PROVABLY SENT (outbox status
-- 'sent'). A post that failed, was blocked, or may or may not have reached the group does not move it, so the changes it
-- would have shown are shown again rather than lost. The point is shared by the whole group (it records what the group
-- was last shown, not what any one person has reviewed), and it never changes an order.

create table if not exists public.ai_agent_order_update_posts (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  group_jid text not null,
  -- The verified WhatsApp sender id of whoever typed "!update".
  requested_by text,
  -- The WhatsApp event that asked. Unique per business: a redelivered "!update" finds its own row instead of making another.
  event_id uuid,
  window_start timestamptz not null,
  -- Taken from the database clock when the row is created, the same clock that stamps order events.
  window_end timestamptz not null default now(),
  outbox_id uuid,
  new_count integer not null default 0,
  changed_count integer not null default 0,
  cancelled_count integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_order_update_posts_event_idx
  on public.ai_agent_order_update_posts (business_slug, event_id) where event_id is not null;
create index if not exists ai_agent_order_update_posts_recent_idx
  on public.ai_agent_order_update_posts (business_slug, group_jid, created_at desc);

alter table public.ai_agent_order_update_posts enable row level security;
drop policy if exists "Admins can read ai_agent_order_update_posts" on public.ai_agent_order_update_posts;
create policy "Admins can read ai_agent_order_update_posts" on public.ai_agent_order_update_posts
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_order_update_posts from anon;
grant select on public.ai_agent_order_update_posts to authenticated;
grant all on public.ai_agent_order_update_posts to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_order_update_posts;   -- Expected: 0
