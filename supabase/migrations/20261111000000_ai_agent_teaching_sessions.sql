-- AI agent: conversational order teaching and staff-approved customer preferences.
-- Run this in the Supabase SQL editor BEFORE relying on the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261106000000 (ai_agent_customer_staff_memory), 20261109000000 (ai_agent_order_proposals).
--
-- Additive and idempotent (safe to run twice). No order, customer, memory or message row is read or changed, and nothing
-- here switches a feature on. The app works without this file (see "Fallback" below), it just cannot hold a conversation
-- or save a customer preference until this has been run.
--
--   ai_agent_teach_sessions   one row per "!order #REF teach …" conversation: the order, who started it, the transcript of
--                             staff turns and our questions, and what is still outstanding. A reply is bound to its session
--                             by the quoted question (our question's outbox row carries the session id in its dedupe key) or,
--                             without a quote, by the same sender having exactly one open session in the same group.
--                             Sessions expire; a restart supersedes the old one. A session never applies anything: it only
--                             ends in the existing proposals (C-CODE for the order, P-CODE for the customer).
--   ai_agent_order_proposals  now also accepts kind 'customer_preference' (code P-XXXXX): a preview of what to remember about
--                             the CUSTOMER (usual product, default location, display name). Same one-time-code rules as C-/B-.
--   ai_agent_customer_staff_memory
--                             now also accepts kind 'usual_product': the product staff confirmed the customer usually orders.
--                             One active per customer; replacing it keeps the old row as 'superseded' (history).
--   set_ai_agent_customer_usual_product()
--                             the one place a usual product is saved: serialised per business, replayable by source message.
--
-- Fallback: without this migration the app answers "setup pending" for conversations and preferences, and a complete
-- one-message "!order #REF teach …" still produces the usual C-CODE correction preview.

-- ── 1. Teaching sessions ─────────────────────────────────────────────────────
create table if not exists public.ai_agent_teach_sessions (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  -- The group the conversation happens in: a reply from anywhere else never binds to it.
  group_jid text not null,
  -- The VERIFIED sender who started it (phone digits or <digits>@lid). Only they can answer it.
  started_by text not null,
  order_id uuid not null references public.ai_agent_orders (id) on delete cascade,
  order_ref text not null,
  -- The order version the conversation started from: a changed order ends the conversation.
  order_version integer not null,
  -- The "!order … teach" message that started it. A redelivered message finds its own session.
  source_message_id text not null,
  status text not null default 'open' check (status in ('open', 'proposed', 'cancelled', 'expired', 'superseded', 'failed')),
  -- Incremented by every accepted reply: a conditional update on it makes two racing replies safe.
  turn integer not null default 1,
  -- [{ "by": "staff" | "assistant", "text": "...", "at": "...", "messageId": "..." }, …]
  transcript jsonb not null default '[]'::jsonb,
  -- { "asked": { key: n }, "decided": { key: bool }, "questions": [{ key, text }] }
  state jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists ai_agent_teach_sessions_message_idx on public.ai_agent_teach_sessions (business_slug, source_message_id);
create index if not exists ai_agent_teach_sessions_open_idx on public.ai_agent_teach_sessions (business_slug, group_jid, status, started_by);
create index if not exists ai_agent_teach_sessions_order_idx on public.ai_agent_teach_sessions (order_id);

drop trigger if exists trg_touch_ai_agent_teach_sessions on public.ai_agent_teach_sessions;
create trigger trg_touch_ai_agent_teach_sessions before update on public.ai_agent_teach_sessions
  for each row execute function public.touch_ai_agent_updated_at();

alter table public.ai_agent_teach_sessions enable row level security;
drop policy if exists "Admins can read ai_agent_teach_sessions" on public.ai_agent_teach_sessions;
create policy "Admins can read ai_agent_teach_sessions" on public.ai_agent_teach_sessions
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_teach_sessions from anon;
grant select on public.ai_agent_teach_sessions to authenticated;
grant all on public.ai_agent_teach_sessions to service_role;

-- ── 2. Customer-preference proposals ─────────────────────────────────────────
alter table public.ai_agent_order_proposals drop constraint if exists ai_agent_order_proposals_kind_check;
alter table public.ai_agent_order_proposals
  add constraint ai_agent_order_proposals_kind_check check (kind in ('correction', 'bulk_complete', 'customer_preference'));

-- ── 3. A usual product in staff memory ───────────────────────────────────────
alter table public.ai_agent_customer_staff_memory drop constraint if exists ai_agent_customer_staff_memory_kind_check;
alter table public.ai_agent_customer_staff_memory
  add constraint ai_agent_customer_staff_memory_kind_check check (kind in ('delivery_location', 'note', 'usual_product'));

create unique index if not exists ai_agent_customer_staff_memory_one_usual_idx
  on public.ai_agent_customer_staff_memory (business_slug, customer_key)
  where kind = 'usual_product' and status = 'active';

create or replace function public.set_ai_agent_customer_usual_product(
  p_business_slug text,
  p_customer_key text,
  p_keys text[],
  p_product text,
  p_fingerprint text,
  p_set_by text,
  p_source_message_id text,
  p_source_event_id uuid,
  p_source_chat_id text,
  p_customer_label text
)
returns table (result text, id uuid, previous_product text, previous_set_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.ai_agent_customer_staff_memory%rowtype;
  v_new uuid;
  v_keys text[] := array(select distinct k from unnest(coalesce(p_keys, '{}') || p_customer_key) k);
begin
  if coalesce(trim(p_product), '') = '' then
    raise exception 'product is required';
  end if;
  perform pg_advisory_xact_lock(hashtext('staff_memory:' || p_business_slug));

  if p_source_message_id is not null then
    select * into v_current from public.ai_agent_customer_staff_memory m
     where m.business_slug = p_business_slug and m.source_message_id = p_source_message_id and m.kind = 'usual_product';
    if found then
      return query select 'replayed'::text, v_current.id, null::text, null::timestamptz;
      return;
    end if;
  end if;

  select * into v_current from public.ai_agent_customer_staff_memory m
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'usual_product' and m.status = 'active'
   order by m.created_at desc limit 1;

  if found and v_current.fingerprint = p_fingerprint then
    return query select 'unchanged'::text, v_current.id, v_current.content, v_current.created_at;
    return;
  end if;

  update public.ai_agent_customer_staff_memory m
     set status = 'superseded', ended_at = now(), ended_by = p_set_by
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'usual_product' and m.status = 'active';

  insert into public.ai_agent_customer_staff_memory
    (business_slug, customer_key, kind, status, content, fingerprint, source, set_by, source_message_id, source_event_id,
     source_chat_id, customer_label, confirmed_at, confirmed_by, replaces_id)
  values
    (p_business_slug, p_customer_key, 'usual_product', 'active', trim(p_product), p_fingerprint, 'staff_whatsapp', p_set_by,
     p_source_message_id, p_source_event_id, p_source_chat_id, left(p_customer_label, 120), now(), p_set_by, v_current.id)
  returning ai_agent_customer_staff_memory.id into v_new;

  update public.ai_agent_customer_staff_memory m set replaced_by_id = v_new
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'usual_product' and m.status = 'superseded' and m.replaced_by_id is null and m.id <> v_new;

  return query select (case when v_current.id is null then 'created' else 'updated' end)::text, v_new, v_current.content, v_current.created_at;
end;
$$;

revoke all on function public.set_ai_agent_customer_usual_product(text, text, text[], text, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_ai_agent_customer_usual_product(text, text, text[], text, text, text, text, uuid, text, text) to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_teach_sessions;   -- Expected: 0
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_agent_order_proposals_kind_check';   -- includes customer_preference
