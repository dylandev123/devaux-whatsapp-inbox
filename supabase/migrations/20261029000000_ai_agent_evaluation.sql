-- AI agent: Observe-mode evaluation (shadow answers) and simulations.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app reads/writes the new table and column). Not applied automatically.
--
-- DEPENDS ON: 20261022000000_ai_agent.sql (and, through it, the pending
-- 20261024–20261028 migrations, which must be applied first and in order).
--
--   1. ai_agent_settings.shadow_capture_enabled (default FALSE): opt-in per business.
--      Nothing is captured until an admin switches it on in AI Agent → Evaluation.
--   2. ai_agent_shadow_results: what the AI proposed on its own for a customer turn,
--      kept SEPARATE from the actual decision, the escalation, the staff answer and the
--      staff-assisted draft (those are joined at read time, never copied here).
--        kind = 'historical'  captured at the time of the turn, from the single model call the
--                             live pipeline already made (no extra call), with the knowledge,
--                             memory and context of that moment.
--        kind = 'simulation'  an admin re-ran a past turn later with CURRENT knowledge.
--      A CHECK ties kind to uses_current_knowledge so a simulation can never be stored as a
--      historical result. Nothing in this table is ever sent anywhere: no outbox row is
--      created from it, and no FK or trigger links it to the outbox.
--   3. Admin rating (correct | needs_improvement | incorrect) with optional feedback.
--   4. purge_ai_agent_shadow_results(): retention (default 90 days).
--   5. forget_ai_agent_customer() also deletes a customer's shadow rows (with p_include_logs,
--      counted in "logs"), as it does for the other logs that quote the customer.
--
-- Additive and idempotent; the only replaced function keeps its signature and result keys.
-- No foreign keys, like the other agent tables, so the 7-day message purge never touches it.

-- ── 1. Opt-in switch ─────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists shadow_capture_enabled boolean not null default false;

-- ── 2. Shadow results ────────────────────────────────────────────────────────
create table if not exists public.ai_agent_shadow_results (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  kind text not null check (kind in ('historical', 'simulation')),
  -- The turn's primary event (newest message of the turn).
  source_event_id uuid,
  -- historical: 'hist:<event>'; simulation: 'sim:<event>:<knowledge_version>'. Repeats collapse.
  dedupe_key text not null unique,
  customer_question text,
  turn_at timestamptz,
  decision text not null check (decision in ('REPLY', 'ASK', 'ESCALATE')),
  reply text,
  draft_reply text,
  confidence numeric(3, 2),
  required_confidence numeric(5, 2),
  reason_codes text[] not null default '{}',
  escalation_reason text,
  intent text,
  category text,
  model text,
  knowledge_ids uuid[] not null default '{}',
  knowledge_version text,
  knowledge_count integer,
  -- A simulation uses today's knowledge; flag the entries that did not exist (or changed) at the turn.
  uses_current_knowledge boolean not null default false,
  post_turn_knowledge_ids uuid[] not null default '{}',
  memory_used boolean,
  input_tokens integer,
  output_tokens integer,
  tokens_estimated boolean not null default true,
  captured_at timestamptz not null default now(),
  simulated_by uuid,
  rating text check (rating is null or rating in ('correct', 'needs_improvement', 'incorrect')),
  feedback text check (feedback is null or char_length(feedback) <= 1000),
  rated_by uuid,
  rated_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ai_agent_shadow_kind_matches_knowledge check ((kind = 'simulation') = uses_current_knowledge),
  constraint ai_agent_shadow_simulated_by_kind check (simulated_by is null or kind = 'simulation')
);

create index if not exists ai_agent_shadow_recent_idx on public.ai_agent_shadow_results (business_slug, created_at desc);
create index if not exists ai_agent_shadow_event_idx on public.ai_agent_shadow_results (business_slug, source_event_id);
create index if not exists ai_agent_shadow_chat_idx on public.ai_agent_shadow_results (business_slug, chat_id);

alter table public.ai_agent_shadow_results enable row level security;
drop policy if exists "Admins can read ai_agent_shadow_results" on public.ai_agent_shadow_results;
create policy "Admins can read ai_agent_shadow_results" on public.ai_agent_shadow_results
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_shadow_results from anon;
grant select on public.ai_agent_shadow_results to authenticated;
grant all on public.ai_agent_shadow_results to service_role;

-- ── 4. Retention ─────────────────────────────────────────────────────────────
create or replace function public.purge_ai_agent_shadow_results(p_older_than interval default interval '90 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.ai_agent_shadow_results where created_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_ai_agent_shadow_results(interval) from public, anon, authenticated;
grant execute on function public.purge_ai_agent_shadow_results(interval) to service_role;

-- ── 5. forget_ai_agent_customer ──────────────────────────────────────────────
-- Same as 20261026000000, plus the customer's shadow rows.
create or replace function public.forget_ai_agent_customer(
  p_business_slug text,
  p_chat_ids text[],
  p_phone text,
  p_include_orders boolean default false,
  p_include_logs boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keys text[];
  v_memory integer := 0;
  v_profile integer := 0;
  v_batches integer := 0;
  v_orders integer := 0;
  v_logs integer := 0;
  v_shadow integer := 0;
begin
  v_keys := array(select 'chat:' || c from unnest(coalesce(p_chat_ids, '{}')) c);
  if p_phone is not null and p_phone <> '' then
    v_keys := v_keys || p_phone;
  end if;
  if coalesce(array_length(v_keys, 1), 0) = 0 then
    raise exception 'nothing identifies this customer';
  end if;

  delete from public.ai_agent_customer_memory
   where business_slug = p_business_slug and customer_key = any (v_keys);
  get diagnostics v_memory = row_count;

  if p_phone is not null and p_phone <> '' then
    delete from public.customer_ai_profile
     where business_slug = p_business_slug and contact_number = p_phone;
    get diagnostics v_profile = row_count;
  end if;

  delete from public.ai_agent_batches
   where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
  get diagnostics v_batches = row_count;

  if p_include_orders then
    delete from public.customer_orders
     where business_slug = p_business_slug
       and (chat_id = any (coalesce(p_chat_ids, '{}')) or (p_phone is not null and p_phone <> '' and contact_number = p_phone));
    get diagnostics v_orders = row_count;
  end if;

  if p_include_logs then
    update public.ai_agent_events set message_excerpt = null, proposed_reply = null
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    get diagnostics v_logs = row_count;
    update public.ai_agent_learning_candidates set question = null, source_message = null
     where business_slug = p_business_slug
       and escalation_id in (
         select e.id from public.ai_agent_escalations e
          where e.business_slug = p_business_slug and e.chat_id = any (coalesce(p_chat_ids, '{}'))
       );
    -- Shadow/simulated answers quote the customer's question: they go with the rest of the logs.
    delete from public.ai_agent_shadow_results
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    get diagnostics v_shadow = row_count;
    v_logs := v_logs + v_shadow;
    delete from public.ai_agent_staff_answers
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    update public.ai_agent_escalations set customer_message = null, ai_summary = null, proposed_reply = null,
           staff_answer = null, context = '{}'::jsonb
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    update public.ai_agent_order_requests set items = '[]'::jsonb, delivery_address = null,
           delivery_preference = null, notes = null, status = 'cancelled'
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
  end if;

  return jsonb_build_object(
    'memory', v_memory, 'profile', v_profile, 'batches', v_batches, 'orders', v_orders, 'logs', v_logs
  );
end;
$$;

revoke all on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) to service_role;

-- Verification (optional):
--   select business_slug, shadow_capture_enabled from public.ai_agent_settings order by 1;  -- Expected: false everywhere
--   select count(*) from public.ai_agent_shadow_results;                                     -- Expected: 0
