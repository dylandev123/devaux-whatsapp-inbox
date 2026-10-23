-- AI agent: per-customer handling modes + smart escalation updates.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app now selects the new columns). Not applied automatically.
--
-- DEPENDS ON: 20261022000000_ai_agent.sql (and, through it, the pending
-- 20261024–20261027 migrations, which must be applied first and in order).
--
--   1. Customer handling modes.
--        ai_agent_conversations.customer_mode  null | 'auto_reply' | 'staff_first' | 'manual_only'
--        ai_agent_settings.default_customer_mode (default 'staff_first')
--      null on a conversation means "use the business default". Every existing
--      business and customer therefore lands on Staff First: nobody is silently
--      switched to Auto-Reply. Only an explicit admin action ever sets auto_reply.
--   2. Escalation notice bookkeeping, so a customer's later messages can update
--      an open escalation instead of being swallowed:
--        notified_seq       how many notices were posted for the escalation (compare-and-swap token)
--        notified_snapshot  the request exactly as the latest notice showed it (diff baseline)
--        last_notified_at   when that notice was queued
--   3. post_ai_agent_escalation_notice(): queues ONE staff notice (first notice or
--      update) and advances the bookkeeping in one transaction, under a row lock.
--      Concurrent workers, redelivered batches and restarts can therefore neither
--      double-post nor lose an update.
--
-- Additive and idempotent: no existing column, row, constraint or function changes
-- meaning. Safe to re-run. Nothing here enables anything.

-- ── 1. Customer modes ────────────────────────────────────────────────────────
alter table public.ai_agent_conversations
  add column if not exists customer_mode text,
  add column if not exists customer_mode_changed_by uuid,
  add column if not exists customer_mode_changed_at timestamptz;

alter table public.ai_agent_conversations
  drop constraint if exists ai_agent_conversations_customer_mode_check;
alter table public.ai_agent_conversations
  add constraint ai_agent_conversations_customer_mode_check
  check (customer_mode is null or customer_mode in ('auto_reply', 'staff_first', 'manual_only'));

alter table public.ai_agent_settings
  add column if not exists default_customer_mode text not null default 'staff_first';

alter table public.ai_agent_settings
  drop constraint if exists ai_agent_settings_default_customer_mode_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_default_customer_mode_check
  check (default_customer_mode in ('auto_reply', 'staff_first', 'manual_only'));

-- ── 2. Escalation notice bookkeeping ─────────────────────────────────────────
alter table public.ai_agent_escalations
  add column if not exists notified_seq integer not null default 0 check (notified_seq >= 0),
  add column if not exists notified_snapshot jsonb,
  add column if not exists last_notified_at timestamptz;

-- ── 3. post_ai_agent_escalation_notice ───────────────────────────────────────
-- Returns one row:
--   outcome = 'queued'    the notice row was created and the escalation advanced to seq
--   outcome = 'stale'     another worker advanced the escalation first (p_expected_seq no longer
--                         matches): nothing was written; the caller re-reads and re-decides
--   outcome = 'duplicate' this dedupe key already exists: nothing was written
--   outcome = 'closed'    the escalation is gone, belongs to another business, or is resolved/cancelled
-- The caller has already applied the business's mode rules (outboxAllowed); claim_ai_agent_outbox
-- re-checks them in SQL before anything is handed to the bridge.
create or replace function public.post_ai_agent_escalation_notice(
  p_business_slug text,
  p_escalation_id uuid,
  p_expected_seq integer,
  p_snapshot jsonb,
  p_chat_id text,
  p_to_jid text,
  p_body text,
  p_dedupe_key text,
  p_event_id uuid default null,
  p_status text default 'pending'
)
returns table (outbox_id uuid, seq integer, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.ai_agent_escalations%rowtype;
  v_id uuid;
begin
  if p_status not in ('pending', 'dispatched') then
    raise exception 'invalid outbox status %', p_status;
  end if;

  select * into e from public.ai_agent_escalations x
   where x.id = p_escalation_id and x.business_slug = p_business_slug
   for update;
  if not found or e.status in ('resolved', 'cancelled') then
    outbox_id := null; seq := null; outcome := 'closed';
    return next;
    return;
  end if;
  if e.notified_seq <> p_expected_seq then
    outbox_id := null; seq := e.notified_seq; outcome := 'stale';
    return next;
    return;
  end if;

  insert into public.ai_agent_outbox
    (business_slug, chat_id, kind, to_jid, body, dedupe_key, event_id, escalation_id, status, dispatched_at)
  values
    (p_business_slug, p_chat_id, 'staff_notice', p_to_jid, left(p_body, 4096), p_dedupe_key, p_event_id,
     p_escalation_id, p_status, case when p_status = 'dispatched' then now() end)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    outbox_id := null; seq := e.notified_seq; outcome := 'duplicate';
    return next;
    return;
  end if;

  update public.ai_agent_escalations
     set notified_seq = e.notified_seq + 1,
         notified_snapshot = p_snapshot,
         last_notified_at = now()
   where id = e.id;

  outbox_id := v_id; seq := e.notified_seq + 1; outcome := 'queued';
  return next;
end;
$$;

revoke all on function public.post_ai_agent_escalation_notice(text, uuid, integer, jsonb, text, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.post_ai_agent_escalation_notice(text, uuid, integer, jsonb, text, text, text, text, uuid, text)
  to service_role;

-- Verification (optional):
--   select business_slug, default_customer_mode from public.ai_agent_settings order by 1;
--   -- Expected: staff_first everywhere
--   select count(*) from public.ai_agent_conversations where customer_mode is not null;
--   -- Expected: 0
