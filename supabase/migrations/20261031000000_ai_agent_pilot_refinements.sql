-- AI agent: Approval Pilot pre-deployment refinements.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261030000000_ai_agent_approval_pilot.sql (and every earlier 20261022–20261029 agent migration).
--
--   1. Manual evaluation verdict override: verdict_source accepts 'admin'; every change is kept in
--      ai_agent_pilot_verdict_history (previous/new verdict, reason, admin, time). Atomic RPC.
--   2. 90-day retention of pilot draft CONTENT: purge_ai_agent_pilot_drafts() blanks the wording
--      (body, final_text, notes) and keeps minimal audit metadata. A purged draft can never be approved.
--   3. ai_agent_learning_candidates.sender_verified: false for facts taken from the business account's own
--      messages (no individual sender identity). Those can only ever be unverified suggestions.
--   4. forget_ai_agent_customer also deletes the customer's verdict history.
--
-- Additive. Nothing is switched on; no existing row changes meaning except that passive candidates
-- already taken from customer chats are marked unverified.

-- ── 1. Verdict override ──────────────────────────────────────────────────────
alter table public.ai_agent_pilot_drafts drop constraint if exists ai_agent_pilot_drafts_verdict_source_check;
alter table public.ai_agent_pilot_drafts
  add constraint ai_agent_pilot_drafts_verdict_source_check
  check (verdict_source is null or verdict_source in ('staff', 'inferred', 'admin'));

create table if not exists public.ai_agent_pilot_verdict_history (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  draft_id uuid not null,
  escalation_id uuid not null,
  chat_id text not null,
  previous_verdict text,
  previous_source text,
  new_verdict text not null check (new_verdict in ('correct', 'missing_information', 'factually_wrong')),
  reason text not null check (char_length(trim(reason)) >= 3 and char_length(reason) <= 500),
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists ai_agent_pilot_verdict_history_esc_idx on public.ai_agent_pilot_verdict_history (business_slug, escalation_id, changed_at desc);
create index if not exists ai_agent_pilot_verdict_history_chat_idx on public.ai_agent_pilot_verdict_history (business_slug, chat_id);

alter table public.ai_agent_pilot_verdict_history enable row level security;
drop policy if exists "Admins can read ai_agent_pilot_verdict_history" on public.ai_agent_pilot_verdict_history;
create policy "Admins can read ai_agent_pilot_verdict_history" on public.ai_agent_pilot_verdict_history
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_pilot_verdict_history from anon;
grant select on public.ai_agent_pilot_verdict_history to authenticated;
grant all on public.ai_agent_pilot_verdict_history to service_role;

-- Overrides the verdict on the AI's own draft (version 1) of one escalation. Only a draft staff already
-- decided on can be overridden (an undecided one is still being worked on). History is append-only.
create or replace function public.override_ai_agent_pilot_verdict(
  p_business_slug text,
  p_escalation_id uuid,
  p_verdict text,
  p_reason text,
  p_admin uuid
)
returns table (result text, previous_verdict text)
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.ai_agent_pilot_drafts%rowtype;
begin
  if p_verdict not in ('correct', 'missing_information', 'factually_wrong') then
    raise exception 'invalid verdict %', p_verdict;
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 500 then
    raise exception 'a reason of 3-500 characters is required';
  end if;

  select * into d from public.ai_agent_pilot_drafts x
   where x.business_slug = p_business_slug and x.escalation_id = p_escalation_id and x.source = 'ai' and x.version = 1
   for update;
  if not found then
    result := 'not_found'; previous_verdict := null; return next; return;
  end if;
  if d.status = 'current' then
    result := 'undecided'; previous_verdict := d.verdict; return next; return;
  end if;

  insert into public.ai_agent_pilot_verdict_history
    (business_slug, draft_id, escalation_id, chat_id, previous_verdict, previous_source, new_verdict, reason, changed_by)
  values
    (p_business_slug, d.id, d.escalation_id, d.chat_id, d.verdict, d.verdict_source, p_verdict, trim(p_reason), p_admin);

  update public.ai_agent_pilot_drafts set verdict = p_verdict, verdict_source = 'admin' where id = d.id;
  result := 'overridden'; previous_verdict := d.verdict; return next;
end;
$$;

revoke all on function public.override_ai_agent_pilot_verdict(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.override_ai_agent_pilot_verdict(text, uuid, text, text, uuid) to service_role;

-- ── 2. Retention of draft content ────────────────────────────────────────────
alter table public.ai_agent_pilot_drafts add column if not exists content_purged_at timestamptz;
alter table public.ai_agent_pilot_drafts drop constraint if exists ai_agent_pilot_drafts_body_check;
alter table public.ai_agent_pilot_drafts
  add constraint ai_agent_pilot_drafts_body_check
  check (content_purged_at is not null or (char_length(trim(body)) > 0 and char_length(body) <= 2000));

-- Blanks the customer-facing wording of drafts older than p_older_than. Kept: ids, business, escalation, chat id,
-- version, source, text HASH, readiness flag, knowledge ids/version, timestamps, status, decider, outcome, verdict.
-- A draft still 'current' is closed first, so a purged (empty) draft can never be approved.
create or replace function public.purge_ai_agent_pilot_drafts(p_older_than interval default interval '90 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.ai_agent_pilot_drafts
     set status = case when status = 'current' then 'superseded' else status end,
         outcome = case when status = 'current' then coalesce(outcome, 'superseded') else outcome end,
         body = '', final_text = null, confirm_notes = '{}', verdict_note = null,
         content_purged_at = now()
   where content_purged_at is null and created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.purge_ai_agent_pilot_drafts(interval) from public, anon, authenticated;
grant execute on function public.purge_ai_agent_pilot_drafts(interval) to service_role;

-- Approval refuses a purged draft (same body as 20261030000000, plus the purge check).
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
  if d.status <> 'current' or d.content_purged_at is not null then
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

-- ── 3. Unverified learning candidates ────────────────────────────────────────
alter table public.ai_agent_learning_candidates
  add column if not exists sender_verified boolean not null default true;
-- Facts noticed in the business's own customer-chat messages never had an identifiable sender.
update public.ai_agent_learning_candidates set sender_verified = false where source = 'passive_staff_chat';

-- ── 4. forget_ai_agent_customer ──────────────────────────────────────────────
-- Same as 20261030000000, plus the customer's verdict history (it names the request, not the wording).
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
    delete from public.ai_agent_pilot_drafts
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
    get diagnostics v_drafts = row_count;
    v_logs := v_logs + v_drafts;
    delete from public.ai_agent_pilot_verdict_history
     where business_slug = p_business_slug and chat_id = any (coalesce(p_chat_ids, '{}'));
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
--   select count(*) from public.ai_agent_pilot_verdict_history;                       -- Expected: 0
--   select count(*) from public.ai_agent_pilot_drafts where content_purged_at is not null;  -- Expected: 0
