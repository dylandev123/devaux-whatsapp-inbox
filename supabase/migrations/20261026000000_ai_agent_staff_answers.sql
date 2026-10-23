-- Assisted AI WhatsApp Agent: staff answers as a two-way control and learning loop.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app now writes the new table/columns and posts the new outbox kind).
-- Not applied automatically.
--
-- DEPENDS ON: 20261022000000_ai_agent.sql, 20261024000000_ai_agent_observe_staff_notices.sql,
--             20261025000000_ai_agent_batching_memory.sql
--
-- Additive, with two replaced functions (claim_ai_agent_outbox,
-- forget_ai_agent_customer) that keep their signatures. Nothing is enabled and
-- no existing row changes behaviour.
--
-- WHAT THIS ADDS
--   1. Outbox kind 'staff_draft': the drafted customer reply posted in the
--      staff group after a staff answer (a staff-group kind, like staff_notice),
--      and an optional reply_to_message_id so the bridge may post it as a
--      WhatsApp quote of the staff member's message.
--   2. ai_agent_staff_answers: one row per staff message that answers an
--      escalation — the audit record (source message, timestamp, business,
--      escalation reference), the idempotency key for repeated WhatsApp events,
--      the draft and what happened to it, the classified items, and the
--      time-bounded temporary facts. No foreign keys, like the other agent
--      tables, so the 7-day message purge can never touch it.
--   3. Learning candidates carry their source (staff message, time, ref code),
--      a suggested kind/title and any conflicts with approved knowledge, and
--      one escalation can now yield several candidates.
--   4. approve_ai_agent_learning_candidate(): atomic approval, with an explicit
--      resolution when a candidate conflicts with an existing entry (the old
--      entry is archived, never overwritten).
--   5. claim_ai_agent_outbox also hands out staff_draft in Observe mode (same
--      rule as staff_notice: staff_notices_enabled AND the staff group).
--   6. forget_ai_agent_customer also scrubs staff answers and candidate context.

-- ── 1. Outbox ────────────────────────────────────────────────────────────────
alter table public.ai_agent_outbox drop constraint if exists ai_agent_outbox_kind_check;
alter table public.ai_agent_outbox
  add constraint ai_agent_outbox_kind_check
  check (kind in ('customer_reply', 'holding_reply', 'staff_notice', 'staff_draft', 'staff_relay', 'staff_feedback'));

alter table public.ai_agent_outbox add column if not exists reply_to_message_id text;

-- ── 2. Staff answers ─────────────────────────────────────────────────────────
create table if not exists public.ai_agent_staff_answers (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  escalation_id uuid not null,
  ref_code text not null,
  -- The CUSTOMER's chat the escalation belongs to (denormalised for isolation and deletion).
  chat_id text not null,
  source text not null default 'whatsapp' check (source in ('whatsapp', 'admin_ui')),
  -- WhatsApp id of the staff message (admin UI: a synthetic id). Unique per
  -- business: a repeated WhatsApp event can never record, draft or send twice.
  source_message_id text not null,
  source_event_id uuid,
  sender_jid text,
  matched_via text check (matched_via is null or matched_via in ('quote', 'ref', 'admin_ui')),
  command text not null check (command in ('answer', 'send')),
  -- The staff's words, verbatim.
  body text not null,
  staff_message_at timestamptz,
  state text not null default 'processing' check (state in ('processing', 'done', 'failed')),
  draft text,
  draft_source text check (draft_source is null or draft_source in ('model', 'staff_text', 'stored_draft')),
  -- sent = queued for the customer; withheld = the draft was not sent (see withheld_reason).
  customer_action text check (customer_action is null or customer_action in ('sent', 'withheld')),
  withheld_reason text,
  draft_dedupe_key text,
  customer_dedupe_key text,
  -- Classified items and what happened to each (candidate, temporary, customer memory, recorded only).
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  -- Temporary operational facts: only ever usable until valid_until, and only
  -- in this conversation unless a fact is explicitly business-wide.
  temporary_facts jsonb not null default '[]'::jsonb check (jsonb_typeof(temporary_facts) = 'array'),
  valid_until timestamptz,
  model text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_staff_answers_message_uniq unique (business_slug, source_message_id)
);

create index if not exists ai_agent_staff_answers_escalation_idx
  on public.ai_agent_staff_answers (business_slug, escalation_id, created_at desc);
create index if not exists ai_agent_staff_answers_live_idx
  on public.ai_agent_staff_answers (business_slug, valid_until) where valid_until is not null;
create index if not exists ai_agent_staff_answers_draft_idx
  on public.ai_agent_staff_answers (business_slug, draft_dedupe_key) where draft_dedupe_key is not null;

drop trigger if exists trg_touch_ai_agent_staff_answers on public.ai_agent_staff_answers;
create trigger trg_touch_ai_agent_staff_answers before update on public.ai_agent_staff_answers
  for each row execute function public.touch_ai_agent_updated_at();

-- ── 3. Learning candidates ───────────────────────────────────────────────────
-- 'staff_answer' = a legacy raw staff answer; 'durable' = a classified permanent
-- fact. Only durable facts are ever proposed now.
alter table public.ai_agent_learning_candidates
  add column if not exists category text not null default 'staff_answer',
  add column if not exists suggested_kind text,
  add column if not exists suggested_title text,
  add column if not exists source_message text,
  add column if not exists source_message_at timestamptz,
  add column if not exists source_message_id text,
  add column if not exists ref_code text,
  add column if not exists answer_id uuid,
  add column if not exists fingerprint text,
  add column if not exists conflicts jsonb not null default '[]'::jsonb;

alter table public.ai_agent_learning_candidates
  drop constraint if exists ai_agent_learning_candidates_escalation_id_key;
-- The same fact from the same escalation is proposed once (also after a reject: no
-- re-nagging). Not a partial index on purpose: the app upserts with
-- ON CONFLICT (business_slug, escalation_id, fingerprint), which cannot name a
-- predicate. Legacy rows have a null fingerprint, and nulls never collide.
create unique index if not exists ai_agent_learning_candidates_fact_idx
  on public.ai_agent_learning_candidates (business_slug, escalation_id, fingerprint);

-- ── 4. approve_ai_agent_learning_candidate ───────────────────────────────────
-- One transaction: lock the candidate, optionally archive the entry it replaces,
-- create the approved knowledge entry, close the candidate. Exactly one caller
-- can approve a candidate; a second gets 'already_reviewed'.
--   p_require_resolution  the app found conflicts with approved knowledge; the
--                         admin must then choose 'replace' or 'keep_both'.
--   p_resolution          'none' | 'replace' | 'keep_both'
-- Replacing archives the old entry (kept for audit); it is never edited in place.
create or replace function public.approve_ai_agent_learning_candidate(
  p_business_slug text,
  p_candidate_id uuid,
  p_admin uuid,
  p_kind text,
  p_title text,
  p_content text,
  p_resolution text default 'none',
  p_replace_knowledge_id uuid default null,
  p_require_resolution boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.ai_agent_learning_candidates%rowtype;
  v_archived uuid;
  v_new uuid;
begin
  select * into c from public.ai_agent_learning_candidates
   where id = p_candidate_id and business_slug = p_business_slug
   for update;
  if not found then
    raise exception 'candidate_not_found';
  end if;
  if c.status <> 'pending' then
    raise exception 'already_reviewed';
  end if;
  if p_resolution not in ('none', 'replace', 'keep_both') then
    raise exception 'invalid_resolution';
  end if;
  if p_require_resolution and p_resolution = 'none' then
    raise exception 'resolution_required';
  end if;

  if p_resolution = 'replace' then
    if p_replace_knowledge_id is null then
      raise exception 'replace_target_required';
    end if;
    update public.ai_agent_knowledge
       set status = 'archived', updated_by = p_admin
     where id = p_replace_knowledge_id and business_slug = p_business_slug and status = 'approved'
     returning id into v_archived;
    if v_archived is null then
      raise exception 'replace_target_not_found';
    end if;
  end if;

  insert into public.ai_agent_knowledge
    (business_slug, kind, title, content, status, source, source_ref, approved_by, approved_at, created_by, updated_by)
  values
    (p_business_slug, p_kind, left(trim(p_title), 200), left(trim(p_content), 4000), 'approved', 'staff_correction',
     c.escalation_id::text, p_admin, now(), p_admin, p_admin)
  returning id into v_new;

  update public.ai_agent_learning_candidates
     set status = 'approved', knowledge_id = v_new, reviewed_by = p_admin, reviewed_at = now()
   where id = c.id;

  return jsonb_build_object('knowledge_id', v_new, 'archived_id', v_archived);
end;
$$;

-- ── 5. claim_ai_agent_outbox ─────────────────────────────────────────────────
-- Same as 20261024000000, plus staff_draft in Observe mode.
create or replace function public.claim_ai_agent_outbox(
  p_business_slug text default null,
  p_limit integer default 20
)
returns setof public.ai_agent_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.ai_agent_outbox o
     set status = 'dispatched', dispatched_at = now()
   where o.id in (
     select p.id from public.ai_agent_outbox p
      join public.ai_agent_settings s on s.business_slug = p.business_slug
      where p.status = 'pending'
        and s.enabled
        and (
          s.mode = 'assisted'
          or (s.mode = 'observe' and s.staff_notices_enabled
              and p.kind in ('staff_notice', 'staff_draft') and p.to_jid = s.staff_group_jid)
        )
        and (p_business_slug is null or p.business_slug = p_business_slug)
      order by p.created_at
      limit greatest(least(p_limit, 100), 1)
      for update of p skip locked
   )
  returning o.*;
end;
$$;

-- ── 6. forget_ai_agent_customer ──────────────────────────────────────────────
-- Same as 20261025000000, plus: with p_include_logs the staff answers of this
-- customer's chats are deleted and the customer's words are removed from the
-- learning candidates that came from them (the business fact itself stays).
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

-- ── 7. Grants + RLS ──────────────────────────────────────────────────────────
revoke all on function public.approve_ai_agent_learning_candidate(text, uuid, uuid, text, text, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.approve_ai_agent_learning_candidate(text, uuid, uuid, text, text, text, text, uuid, boolean) to service_role;
revoke all on function public.claim_ai_agent_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_outbox(text, integer) to service_role;
revoke all on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) to service_role;

alter table public.ai_agent_staff_answers enable row level security;
drop policy if exists "Admins can read ai_agent_staff_answers" on public.ai_agent_staff_answers;
create policy "Admins can read ai_agent_staff_answers" on public.ai_agent_staff_answers
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_staff_answers from anon;
grant select on public.ai_agent_staff_answers to authenticated;
grant all on public.ai_agent_staff_answers to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_staff_answers;                       -- Expected: 0
--   select conname from pg_constraint where conname = 'ai_agent_outbox_kind_check';
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_agent_outbox_kind_check';
--     -- Expected: includes 'staff_draft'
