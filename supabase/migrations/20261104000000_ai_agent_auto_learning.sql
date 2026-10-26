-- AI agent: automatic business learning from the business's own outgoing messages, with batched staff digests.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261030000000_ai_agent_approval_pilot.sql (learning candidates, short codes) and the earlier
-- knowledge table (20261022000000_ai_agent.sql).
--
--   1. ai_agent_settings.auto_learning_enabled (default FALSE): the explicit per-business opt-in. Off = nothing
--      is learned automatically; the previous suggestion-only behaviour is unchanged.
--   2. ai_agent_knowledge: history and identity columns. A replaced or forgotten fact is ARCHIVED, never edited
--      or deleted, so price changes and corrections stay on record (superseded_by / supersedes_id).
--      source 'auto' = learned automatically from a human message of the business account.
--   3. ai_agent_learning_candidates.review_reason + source 'auto_staff_chat': an automatic fact that needs a
--      person (conflicting price, ambiguous product, risky policy…). Shown in the dashboard, never in the group.
--   4. ai_agent_learning_events: one row per genuinely new or materially updated fact, waiting to be counted
--      into a digest. ai_agent_learning_digests: one row per digest, created by claim_ai_agent_learning_digest()
--      in a single transaction, so a batch can never be sent twice.
--   5. learn_ai_agent_fact(): the ONLY writer of automatic knowledge. One transaction: duplicate / blocked /
--      stale checks, optional archive of the entry it replaces, the new approved entry, and its event.
--
-- Additive: new columns with defaults, two new tables, two new functions. No data is changed.

alter table public.ai_agent_settings add column if not exists auto_learning_enabled boolean not null default false;

-- ── Knowledge: identity and history ──────────────────────────────────────────
alter table public.ai_agent_knowledge
  add column if not exists short_code text,
  add column if not exists subject_key text,
  add column if not exists price_amount numeric(12, 2),
  add column if not exists fingerprint text,
  add column if not exists learned_message_id text,
  add column if not exists learned_message_at timestamptz,
  add column if not exists supersedes_id uuid,
  add column if not exists superseded_by uuid,
  add column if not exists archived_reason text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

alter table public.ai_agent_knowledge drop constraint if exists ai_agent_knowledge_source_check;
alter table public.ai_agent_knowledge
  add constraint ai_agent_knowledge_source_check check (source in ('admin', 'staff_correction', 'import', 'whatsapp', 'auto'));

create unique index if not exists ai_agent_knowledge_short_code_idx
  on public.ai_agent_knowledge (business_slug, short_code) where short_code is not null;
-- The same fact from the same WhatsApp message is learned once, however often the bridge retries.
create unique index if not exists ai_agent_knowledge_auto_message_idx
  on public.ai_agent_knowledge (business_slug, learned_message_id, fingerprint)
  where source = 'auto' and learned_message_id is not null;
create index if not exists ai_agent_knowledge_subject_idx
  on public.ai_agent_knowledge (business_slug, subject_key) where status = 'approved' and subject_key is not null;
create index if not exists ai_agent_knowledge_fingerprint_idx
  on public.ai_agent_knowledge (business_slug, fingerprint) where fingerprint is not null;

-- ── Learning candidates: why a person must look ─────────────────────────────
alter table public.ai_agent_learning_candidates add column if not exists review_reason text;
alter table public.ai_agent_learning_candidates drop constraint if exists ai_agent_learning_candidates_source_check;
alter table public.ai_agent_learning_candidates
  add constraint ai_agent_learning_candidates_source_check
  check (source in ('staff_answer', 'whatsapp_teach', 'passive_staff_group', 'passive_staff_chat', 'auto_staff_chat'));

-- ── Events and digests ───────────────────────────────────────────────────────
create table if not exists public.ai_agent_learning_digests (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  fact_count integer not null check (fact_count > 0),
  -- Pending reviews at the moment the digest was claimed (shown as a count, never as individual notices).
  pending_count integer not null default 0,
  -- Set once the staff-group message exists in the outbox (its dedupe key is learning_digest:<id>).
  enqueued_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ai_agent_learning_digests_open_idx
  on public.ai_agent_learning_digests (business_slug, created_at) where enqueued_at is null;

create table if not exists public.ai_agent_learning_events (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  knowledge_id uuid not null,
  kind text not null check (kind in ('learned', 'updated')),
  code text,
  -- One short deterministic line for the digest ("25ft hose — $128"). No chat text.
  summary text not null,
  source_message_id text,
  digest_id uuid references public.ai_agent_learning_digests (id),
  created_at timestamptz not null default now()
);
create index if not exists ai_agent_learning_events_unbatched_idx
  on public.ai_agent_learning_events (business_slug, created_at) where digest_id is null;
create index if not exists ai_agent_learning_events_digest_idx
  on public.ai_agent_learning_events (digest_id) where digest_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['ai_agent_learning_events', 'ai_agent_learning_digests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins can read %1$s" on public.%1$I', t);
    execute format(
      'create policy "Admins can read %1$s" on public.%1$I for select to authenticated using (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ── learn_ai_agent_fact ──────────────────────────────────────────────────────
-- result: 'learned' | 'updated' | 'duplicate' | 'blocked' | 'stale'
--   duplicate  the same fact is already approved, or this message already produced it
--   blocked    the fact was forgotten (or its suggestion rejected) in the last p_block_days days
--   stale      the entry to replace changed or was archived since the app looked: nothing was written
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
  p_block_days integer default 30
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

  -- A short code unique across this business's knowledge AND candidates (!confirm / !forget share one namespace).
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
     learned_message_id, learned_message_at, supersedes_id, approved_at)
  values
    (p_business_slug, p_kind, p_title, p_content, 'approved', 'auto', p_message_id, v_code, p_subject_key, p_price_amount, p_fingerprint,
     p_message_id, p_message_at, p_replace_id, now())
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

revoke all on function public.learn_ai_agent_fact(text, text, text, text, text, numeric, text, text, timestamptz, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.learn_ai_agent_fact(text, text, text, text, text, numeric, text, text, timestamptz, uuid, text, integer) to service_role;

-- ── claim_ai_agent_learning_digest ───────────────────────────────────────────
-- Atomically turns the business's waiting events into ONE digest when at least p_threshold have gathered.
-- Two concurrent callers serialise on the advisory lock; the second finds nothing left and gets no rows.
-- The events are stamped with the digest id in the same transaction, so each is counted exactly once.
create or replace function public.claim_ai_agent_learning_digest(p_business_slug text, p_threshold integer default 10)
returns table (digest_id uuid, fact_count integer, pending_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_pending integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('digest:' || p_business_slug));

  -- Only events whose fact is still active count: a fact forgotten before the digest is not announced.
  select count(*) into v_count
    from public.ai_agent_learning_events e
    join public.ai_agent_knowledge k on k.id = e.knowledge_id
    where e.business_slug = p_business_slug and e.digest_id is null and k.status = 'approved';
  if v_count < greatest(p_threshold, 1) then
    return;
  end if;

  select count(*) into v_pending from public.ai_agent_learning_candidates c
    where c.business_slug = p_business_slug and c.status = 'pending'
      and (c.proposal_expires_at is null or c.proposal_expires_at > now());

  insert into public.ai_agent_learning_digests (business_slug, fact_count, pending_count)
  values (p_business_slug, v_count, v_pending)
  returning id into v_id;

  update public.ai_agent_learning_events e set digest_id = v_id
    from public.ai_agent_knowledge k
    where k.id = e.knowledge_id and e.business_slug = p_business_slug and e.digest_id is null and k.status = 'approved';

  digest_id := v_id; fact_count := v_count; pending_count := v_pending;
  return next;
end;
$$;

revoke all on function public.claim_ai_agent_learning_digest(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_learning_digest(text, integer) to service_role;

-- Verification (optional):
--   select business_slug, auto_learning_enabled from public.ai_agent_settings order by 1;   -- Expected: false everywhere
--   select count(*) from public.ai_agent_learning_events;                                    -- Expected: 0
