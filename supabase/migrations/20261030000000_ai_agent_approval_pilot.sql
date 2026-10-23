-- AI agent: Approval Pilot mode and WhatsApp business learning.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app reads/writes the new table, columns and RPCs). Not applied automatically.
--
-- DEPENDS ON: 20261029000000_ai_agent_evaluation.sql (and, through it, every earlier
-- 20261022–20261028 agent migration, applied in order).
-- DEPLOY ORDER: bridge (WhatsappOperation) first, then this migration, then the app.
-- Until the bridge knows mode 'approval_pilot' it fails closed and sends nothing in it.
--
--   1. ai_agent_settings.mode accepts 'approval_pilot' (between Observe and Assisted):
--      the AI never sends on its own; only an explicitly authorized staff member's
--      !approve / !send reaches a customer (outbox kind staff_relay, same single path).
--   2. ai_agent_settings.passive_learning_scope (default 'off') and
--      knowledge_confirm_via_whatsapp (default FALSE): explicit per-business opt-ins.
--   3. ai_agent_pilot_drafts: every customer-reply DRAFT VERSION, immutable text, with the
--      staff decision (approved / edited / rejected / replaced) and the evaluation verdict.
--      Approval is one atomic compare-and-set (approve_ai_agent_pilot_draft) bound to
--      the draft id AND its text hash, creating the outbox row in the same transaction.
--   4. Learning candidates gain a source, proposer, confidence, expiry and a short K- code so
--      WhatsApp can confirm them; status 'expired' is added. Knowledge gains source 'whatsapp'.
--   5. approve_ai_agent_learning_candidate also accepts a WhatsApp approver and an expiry.
--   6. claim_ai_agent_outbox: Approval Pilot hands out staff-group kinds and staff_relay only.
--   7. forget_ai_agent_customer also deletes the customer's pilot drafts (with p_include_logs).
--
-- Additive; the replaced functions keep their result keys. Nothing is switched on: every
-- business keeps its current mode, passive learning is 'off', WhatsApp confirmation is off.

-- ── 1. Mode ──────────────────────────────────────────────────────────────────
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_mode_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_mode_check check (mode in ('observe', 'approval_pilot', 'assisted'));

-- ── 2. Opt-ins ───────────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists passive_learning_scope text not null default 'off',
  add column if not exists knowledge_confirm_via_whatsapp boolean not null default false;
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_passive_learning_scope_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_passive_learning_scope_check
  check (passive_learning_scope in ('off', 'staff_group', 'staff_group_and_chats'));

-- ── 3. Pilot drafts ──────────────────────────────────────────────────────────
create table if not exists public.ai_agent_pilot_drafts (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  escalation_id uuid not null,
  chat_id text not null,
  version integer not null check (version >= 1),
  -- ai = the AI's own proposal for the turn; staff_edit = !edit; staff_answer = drafted from a staff answer.
  source text not null check (source in ('ai', 'staff_edit', 'staff_answer')),
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 2000),
  body_hash text not null,
  -- true = customer-ready as it stands; false = a person must confirm the facts first (needs_confirmation).
  ready boolean not null default false,
  confirm_notes text[] not null default '{}',
  -- What the AI knew when it wrote it (the draft is never rewritten by later knowledge).
  knowledge_ids uuid[] not null default '{}',
  knowledge_version text,
  -- The draft answers the customer's messages up to here; a customer message after it makes it stale.
  basis_at timestamptz not null,
  valid_until timestamptz,
  created_by text,
  status text not null default 'current' check (status in ('current', 'approved', 'rejected', 'superseded')),
  decided_by text,
  decided_at timestamptz,
  decision_message_id text,
  -- The text that finally reached the customer, when it differs from this draft (!send <text>).
  final_text text,
  approval_outbox_id uuid,
  -- Evaluation: what staff did with the AI's draft, and whether it was right.
  outcome text check (outcome is null or outcome in ('approved_as_is', 'approved_after_confirm', 'edited', 'rejected', 'replaced_by_staff_text', 'superseded')),
  verdict text check (verdict is null or verdict in ('correct', 'missing_information', 'factually_wrong')),
  verdict_source text check (verdict_source is null or verdict_source in ('staff', 'inferred')),
  verdict_note text check (verdict_note is null or char_length(verdict_note) <= 500),
  created_at timestamptz not null default now(),
  constraint ai_agent_pilot_drafts_version_uniq unique (escalation_id, version)
);

-- At most one draft per escalation is the one a bare approval can mean.
create unique index if not exists ai_agent_pilot_drafts_current_idx
  on public.ai_agent_pilot_drafts (escalation_id) where status = 'current';
create index if not exists ai_agent_pilot_drafts_recent_idx on public.ai_agent_pilot_drafts (business_slug, created_at desc);
create index if not exists ai_agent_pilot_drafts_chat_idx on public.ai_agent_pilot_drafts (business_slug, chat_id);

alter table public.ai_agent_pilot_drafts enable row level security;
drop policy if exists "Admins can read ai_agent_pilot_drafts" on public.ai_agent_pilot_drafts;
create policy "Admins can read ai_agent_pilot_drafts" on public.ai_agent_pilot_drafts
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_pilot_drafts from anon;
grant select on public.ai_agent_pilot_drafts to authenticated;
grant all on public.ai_agent_pilot_drafts to service_role;

-- Atomic approval. One transaction: lock the draft, check it is still THE current draft with the
-- exact text the approver was shown (id + hash), the escalation is open, and nothing is already
-- queued under the send key; then mark it approved and create the customer-bound outbox row.
-- Two concurrent approvals (or a retried command) can never both succeed: the second finds the
-- draft no longer 'current', or hits the unique dedupe key, and gets a refusal code instead.
-- The caller has already run the central send policy (planCustomerSend) and passes its key.
create or replace function public.approve_ai_agent_pilot_draft(
  p_business_slug text,
  p_draft_id uuid,
  p_expected_hash text,
  p_approver text,
  p_message_id text,
  p_outcome text,
  p_chat_id text,
  p_to_jid text,
  p_body text,
  p_dedupe_key text,
  p_event_id uuid default null,
  p_status text default 'dispatched'
)
returns table (outbox_id uuid, result text)
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.ai_agent_pilot_drafts%rowtype;
  e_status text;
  v_id uuid;
begin
  if p_status not in ('pending', 'dispatched') then
    raise exception 'invalid outbox status %', p_status;
  end if;
  if p_outcome not in ('approved_as_is', 'approved_after_confirm', 'edited') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  select * into d from public.ai_agent_pilot_drafts x
   where x.id = p_draft_id and x.business_slug = p_business_slug
   for update;
  if not found then
    outbox_id := null; result := 'not_found'; return next; return;
  end if;
  if d.status <> 'current' then
    outbox_id := null; result := case d.status when 'approved' then 'already_approved' else 'not_current' end; return next; return;
  end if;
  if d.body_hash <> p_expected_hash then
    outbox_id := null; result := 'changed'; return next; return;
  end if;

  select status into e_status from public.ai_agent_escalations
   where id = d.escalation_id and business_slug = p_business_slug for update;
  if e_status is null or e_status in ('resolved', 'cancelled') then
    outbox_id := null; result := 'closed'; return next; return;
  end if;

  insert into public.ai_agent_outbox
    (business_slug, chat_id, kind, to_jid, body, dedupe_key, event_id, escalation_id, status, dispatched_at)
  values
    (p_business_slug, p_chat_id, 'staff_relay', p_to_jid, left(p_body, 4096), p_dedupe_key, p_event_id,
     d.escalation_id, p_status, case when p_status = 'dispatched' then now() end)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    outbox_id := null; result := 'duplicate_send'; return next; return;
  end if;

  update public.ai_agent_pilot_drafts
     set status = 'approved', decided_by = p_approver, decided_at = now(), decision_message_id = p_message_id,
         approval_outbox_id = v_id, outcome = p_outcome
   where id = d.id;

  outbox_id := v_id; result := 'approved'; return next;
end;
$$;

revoke all on function public.approve_ai_agent_pilot_draft(text, uuid, text, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_ai_agent_pilot_draft(text, uuid, text, text, text, text, text, text, text, text, uuid, text) to service_role;

-- ── 4. Learning candidates ───────────────────────────────────────────────────
alter table public.ai_agent_learning_candidates
  add column if not exists source text not null default 'staff_answer',
  add column if not exists proposed_by text,
  add column if not exists confidence numeric(3, 2),
  -- The suggestion lapses if nobody confirms it by then.
  add column if not exists proposal_expires_at timestamptz,
  -- A temporary fact (stock, "today"): the knowledge entry created from it expires then.
  add column if not exists fact_expires_at timestamptz,
  add column if not exists short_code text,
  add column if not exists approved_via text,
  add column if not exists approved_by_sender text;

alter table public.ai_agent_learning_candidates drop constraint if exists ai_agent_learning_candidates_source_check;
alter table public.ai_agent_learning_candidates
  add constraint ai_agent_learning_candidates_source_check
  check (source in ('staff_answer', 'whatsapp_teach', 'passive_staff_group', 'passive_staff_chat'));
alter table public.ai_agent_learning_candidates drop constraint if exists ai_agent_learning_candidates_status_check;
alter table public.ai_agent_learning_candidates
  add constraint ai_agent_learning_candidates_status_check check (status in ('pending', 'approved', 'rejected', 'expired'));
alter table public.ai_agent_learning_candidates drop constraint if exists ai_agent_learning_candidates_approved_via_check;
alter table public.ai_agent_learning_candidates
  add constraint ai_agent_learning_candidates_approved_via_check check (approved_via is null or approved_via in ('admin', 'whatsapp'));

-- A WhatsApp-proposed fact is proposed once while pending (escalation_id is null for these, and nulls
-- never collide in the escalation index), and its short code is unique within the business.
create unique index if not exists ai_agent_learning_candidates_pending_fact_idx
  on public.ai_agent_learning_candidates (business_slug, fingerprint)
  where escalation_id is null and status = 'pending' and fingerprint is not null;
create unique index if not exists ai_agent_learning_candidates_short_code_idx
  on public.ai_agent_learning_candidates (business_slug, short_code) where short_code is not null;

alter table public.ai_agent_knowledge drop constraint if exists ai_agent_knowledge_source_check;
alter table public.ai_agent_knowledge
  add constraint ai_agent_knowledge_source_check check (source in ('admin', 'staff_correction', 'import', 'whatsapp'));

-- ── 5. approve_ai_agent_learning_candidate ───────────────────────────────────
-- Same as 20261026000000, plus: an approval from WhatsApp (p_admin null, p_via 'whatsapp',
-- p_sender = the verified WhatsApp id) and an expiry for temporary facts. The old 9-argument
-- function is dropped so the name stays unambiguous; the app's admin call keeps working.
drop function if exists public.approve_ai_agent_learning_candidate(text, uuid, uuid, text, text, text, text, uuid, boolean);
create or replace function public.approve_ai_agent_learning_candidate(
  p_business_slug text,
  p_candidate_id uuid,
  p_admin uuid,
  p_kind text,
  p_title text,
  p_content text,
  p_resolution text default 'none',
  p_replace_knowledge_id uuid default null,
  p_require_resolution boolean default false,
  p_via text default 'admin',
  p_sender text default null,
  p_expires_at timestamptz default null
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
  if c.proposal_expires_at is not null and c.proposal_expires_at <= now() then
    raise exception 'candidate_expired';
  end if;
  if p_resolution not in ('none', 'replace', 'keep_both') then
    raise exception 'invalid_resolution';
  end if;
  if p_via not in ('admin', 'whatsapp') then
    raise exception 'invalid_via';
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
    (business_slug, kind, title, content, status, source, source_ref, expires_at, approved_by, approved_at, created_by, updated_by)
  values
    (p_business_slug, p_kind, left(trim(p_title), 200), left(trim(p_content), 4000), 'approved',
     case when p_via = 'whatsapp' then 'whatsapp' else 'staff_correction' end,
     coalesce(c.escalation_id::text, 'candidate:' || c.id::text), p_expires_at, p_admin, now(), p_admin, p_admin)
  returning id into v_new;

  update public.ai_agent_learning_candidates
     set status = 'approved', knowledge_id = v_new, reviewed_by = p_admin, reviewed_at = now(),
         approved_via = p_via, approved_by_sender = p_sender
   where id = c.id;

  return jsonb_build_object('knowledge_id', v_new, 'archived_id', v_archived);
end;
$$;

revoke all on function public.approve_ai_agent_learning_candidate(text, uuid, uuid, text, text, text, text, uuid, boolean, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.approve_ai_agent_learning_candidate(text, uuid, uuid, text, text, text, text, uuid, boolean, text, text, timestamptz) to service_role;

-- ── 6. claim_ai_agent_outbox ─────────────────────────────────────────────────
-- Same as 20261026000000, plus Approval Pilot: staff-group kinds to the staff group, and
-- staff_relay (an explicitly authorized staff send). Never customer_reply or holding_reply.
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
          or (s.mode = 'approval_pilot'
              and ((p.kind in ('staff_notice', 'staff_draft', 'staff_feedback') and p.to_jid = s.staff_group_jid)
                   or p.kind = 'staff_relay'))
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

revoke all on function public.claim_ai_agent_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_outbox(text, integer) to service_role;

-- ── 7. forget_ai_agent_customer ──────────────────────────────────────────────
-- Same as 20261029000000, plus the customer's pilot drafts (they quote the customer's request).
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
  v_drafts integer := 0;
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
    delete from public.ai_agent_shadow_results
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    get diagnostics v_shadow = row_count;
    v_logs := v_logs + v_shadow;
    -- Pilot drafts quote the customer's request and may repeat their details.
    delete from public.ai_agent_pilot_drafts
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    get diagnostics v_drafts = row_count;
    v_logs := v_logs + v_drafts;
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
--   select business_slug, mode, passive_learning_scope, knowledge_confirm_via_whatsapp from public.ai_agent_settings order by 1;
--     -- Expected: modes unchanged, 'off' and false everywhere
--   select count(*) from public.ai_agent_pilot_drafts;   -- Expected: 0
