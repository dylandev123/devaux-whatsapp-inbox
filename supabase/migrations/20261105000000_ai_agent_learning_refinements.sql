-- AI agent: automatic-learning refinements (weekly digest + source traceability).
-- Run this in the Supabase SQL editor AFTER 20261104000000_ai_agent_auto_learning.sql and BEFORE deploying the
-- matching app code. Not applied automatically.
--
--   1. ai_agent_knowledge.learned_chat_id: the conversation an automatic fact came from (an identifier only —
--      the chat text itself is never copied; the original message is looked up in whatsapp_messages when viewed).
--   2. ai_agent_learning_digests.trigger_kind: 'threshold' (10 facts gathered) or 'weekly' (leftovers after 7 days).
--   3. learn_ai_agent_fact(): now records the source chat (new last parameter, default null).
--   4. claim_ai_agent_learning_digest(): ALSO claims a weekly digest when the oldest still-unannounced, still-active
--      fact is at least p_weekly_days old. Still one atomic transaction; an empty claim returns no rows.
--
-- Additive and replace-only: one nullable column, one column with a default, and two functions replaced.

alter table public.ai_agent_knowledge add column if not exists learned_chat_id text;

alter table public.ai_agent_learning_digests add column if not exists trigger_kind text not null default 'threshold';
alter table public.ai_agent_learning_digests drop constraint if exists ai_agent_learning_digests_trigger_kind_check;
alter table public.ai_agent_learning_digests
  add constraint ai_agent_learning_digests_trigger_kind_check check (trigger_kind in ('threshold', 'weekly'));

-- "Recently forgotten" lookups (suppression of a rejected claim).
create index if not exists ai_agent_knowledge_forgotten_idx
  on public.ai_agent_knowledge (business_slug, archived_at) where archived_reason = 'forgotten';

-- ── learn_ai_agent_fact (adds p_chat_id) ─────────────────────────────────────
drop function if exists public.learn_ai_agent_fact(text, text, text, text, text, numeric, text, text, timestamptz, uuid, text, integer);

create or replace function public.learn_ai_agent_fact(
  p_business_slug text,
  p_kind text,
  p_title text,
  p_content text,
  p_subject_key text,
  p_price_amount numeric,
  p_fingerprint text,
  p_message_id text,
  p_message_at timestamptz,
  p_replace_id uuid,
  p_summary text,
  p_block_days integer default 30,
  p_chat_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.ai_agent_knowledge%rowtype;
  v_id uuid;
  v_code text;
  v_event uuid;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('learn:' || p_business_slug));

  if exists (
    select 1 from public.ai_agent_knowledge k
    where k.business_slug = p_business_slug and k.source = 'auto' and k.learned_message_id = p_message_id and k.fingerprint = p_fingerprint
  ) or exists (
    select 1 from public.ai_agent_knowledge k
    where k.business_slug = p_business_slug and k.status = 'approved' and k.fingerprint = p_fingerprint
      and (k.expires_at is null or k.expires_at > now())
  ) then
    return jsonb_build_object('result', 'duplicate');
  end if;

  if exists (
    select 1 from public.ai_agent_knowledge k
    where k.business_slug = p_business_slug and k.fingerprint = p_fingerprint
      and k.archived_reason = 'forgotten' and k.archived_at > now() - make_interval(days => p_block_days)
  ) or exists (
    select 1 from public.ai_agent_learning_candidates c
    where c.business_slug = p_business_slug and c.fingerprint = p_fingerprint
      and c.status = 'rejected' and c.reviewed_at > now() - make_interval(days => p_block_days)
  ) then
    return jsonb_build_object('result', 'blocked');
  end if;

  if p_replace_id is not null then
    select * into v_old from public.ai_agent_knowledge k
      where k.id = p_replace_id and k.business_slug = p_business_slug and k.status = 'approved' for update;
    if not found then
      return jsonb_build_object('result', 'stale');
    end if;
  end if;

  loop
    v_code := 'K-' || (
      select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1), '') from generate_series(1, 4)
    );
    exit when not exists (select 1 from public.ai_agent_knowledge k where k.business_slug = p_business_slug and k.short_code = v_code)
      and not exists (select 1 from public.ai_agent_learning_candidates c where c.business_slug = p_business_slug and c.short_code = v_code);
    v_try := v_try + 1;
    if v_try > 20 then raise exception 'code_allocation_failed'; end if;
  end loop;

  insert into public.ai_agent_knowledge
    (business_slug, kind, title, content, status, source, source_ref, short_code, subject_key, price_amount, fingerprint,
     learned_message_id, learned_message_at, learned_chat_id, supersedes_id, approved_at)
  values
    (p_business_slug, p_kind, p_title, p_content, 'approved', 'auto', p_message_id, v_code, p_subject_key, p_price_amount, p_fingerprint,
     p_message_id, p_message_at, p_chat_id, p_replace_id, now())
  returning id into v_id;

  if p_replace_id is not null then
    update public.ai_agent_knowledge
      set status = 'archived', archived_reason = 'superseded', archived_at = now(), superseded_by = v_id
      where id = p_replace_id;
  end if;

  insert into public.ai_agent_learning_events (business_slug, knowledge_id, kind, code, summary, source_message_id)
  values (p_business_slug, v_id, case when p_replace_id is null then 'learned' else 'updated' end, v_code, left(p_summary, 200), p_message_id)
  returning id into v_event;

  return jsonb_build_object(
    'result', case when p_replace_id is null then 'learned' else 'updated' end,
    'knowledge_id', v_id, 'code', v_code, 'event_id', v_event, 'archived_id', p_replace_id
  );
end;
$$;

revoke all on function public.learn_ai_agent_fact(text, text, text, text, text, numeric, text, text, timestamptz, uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.learn_ai_agent_fact(text, text, text, text, text, numeric, text, text, timestamptz, uuid, text, integer, text) to service_role;

-- ── claim_ai_agent_learning_digest (adds the weekly leftovers digest) ────────
-- A digest is claimed when EITHER at least p_threshold active, unannounced facts have gathered ('threshold'),
-- OR any are left and the oldest is at least p_weekly_days old ('weekly'). Nothing waiting = no rows: an empty
-- digest is impossible. Claiming stamps the events in the same transaction, so each fact is announced exactly once.
drop function if exists public.claim_ai_agent_learning_digest(text, integer);

create or replace function public.claim_ai_agent_learning_digest(
  p_business_slug text,
  p_threshold integer default 10,
  p_weekly_days integer default 7
)
returns table (digest_id uuid, fact_count integer, pending_count integer, trigger_kind text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_oldest timestamptz;
  v_pending integer;
  v_trigger text;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('digest:' || p_business_slug));

  -- Only events whose fact is still active count: a fact forgotten before the digest is not announced.
  select count(*), min(e.created_at) into v_count, v_oldest
    from public.ai_agent_learning_events e
    join public.ai_agent_knowledge k on k.id = e.knowledge_id
    where e.business_slug = p_business_slug and e.digest_id is null and k.status = 'approved';
  if v_count = 0 then
    return;
  end if;

  if v_count >= greatest(p_threshold, 1) then
    v_trigger := 'threshold';
  elsif p_weekly_days > 0 and v_oldest <= now() - make_interval(days => p_weekly_days) then
    v_trigger := 'weekly';
  else
    return;
  end if;

  select count(*) into v_pending from public.ai_agent_learning_candidates c
    where c.business_slug = p_business_slug and c.status = 'pending'
      and (c.proposal_expires_at is null or c.proposal_expires_at > now());

  insert into public.ai_agent_learning_digests (business_slug, fact_count, pending_count, trigger_kind)
  values (p_business_slug, v_count, v_pending, v_trigger)
  returning id into v_id;

  update public.ai_agent_learning_events e set digest_id = v_id
    from public.ai_agent_knowledge k
    where k.id = e.knowledge_id and e.business_slug = p_business_slug and e.digest_id is null and k.status = 'approved';

  digest_id := v_id; fact_count := v_count; pending_count := v_pending; trigger_kind := v_trigger;
  return next;
end;
$$;

revoke all on function public.claim_ai_agent_learning_digest(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_learning_digest(text, integer, integer) to service_role;

-- Verification (optional):
--   select column_name from information_schema.columns where table_name = 'ai_agent_knowledge' and column_name = 'learned_chat_id';
--   select business_slug, trigger_kind, fact_count, enqueued_at from public.ai_agent_learning_digests order by created_at desc limit 5;
