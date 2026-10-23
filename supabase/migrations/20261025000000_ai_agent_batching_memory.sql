-- Assisted AI WhatsApp Agent: message batching + long-term customer memory.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app now selects the new settings columns). Not applied automatically.
--
-- DEPENDS ON: 20261022000000_ai_agent.sql, 20261023000000_ai_agent_multi_business.sql,
--             20261024000000_ai_agent_observe_staff_notices.sql,
--             20261008000000_customer_orders.sql, 20260901000400_customer_ai_profile.sql
--
-- Additive only. Nothing is enabled by this migration:
--   * batching_enabled defaults to FALSE for every business (today's per-message
--     behaviour is unchanged until an admin turns batching on),
--   * customer_memory_enabled defaults to FALSE (the agent writes no new memory
--     until an admin turns capture on; existing verified orders are still READ).
--
-- ── PART A: BATCHING ─────────────────────────────────────────────────────────
-- A customer message is stored in ai_agent_batch_messages and attached to the
-- chat's single "collecting" batch. Every new message pushes the batch's
-- due_at to now() + quiet period, capped at first message + max wait. A
-- worker (claim_ai_agent_batches) takes due batches with FOR UPDATE SKIP
-- LOCKED, so duplicate workers, restarts and retries are safe, and the whole
-- state lives in Postgres — no in-memory timers anywhere.
--   collecting → processing (claimed, leased) → done | failed
-- A message that arrives while a batch is processing opens a NEW collecting
-- batch (the unique index only covers 'collecting'); batches of one chat are
-- processed strictly in creation order.
--
-- ── PART B: MEMORY ───────────────────────────────────────────────────────────
-- No competing memory database. Existing systems stay the source of truth:
--   customer_orders       verified purchases (order_status Added/Completed =
--                         staff-confirmed; 'Needs adding' = an unconfirmed request)
--   customer_ai_profile   AI INFERENCES only (never presented as fact)
--   ai_agent_order_requests  collected, never-confirmed requests
-- The only new table is ai_agent_customer_memory: explicit CUSTOMER-STATED
-- preferences and STAFF-CONFIRMED resolved issues (plus admin-entered notes).
-- Like the other agent tables it has NO foreign keys, so the 7-day message
-- purge can never touch it.

-- ── 1. Settings ──────────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists batching_enabled boolean not null default false,
  add column if not exists batch_quiet_seconds integer not null default 45,
  add column if not exists batch_max_wait_seconds integer not null default 180,
  add column if not exists customer_memory_enabled boolean not null default false;

alter table public.ai_agent_settings
  drop constraint if exists ai_agent_settings_batch_quiet_check,
  drop constraint if exists ai_agent_settings_batch_max_wait_check,
  drop constraint if exists ai_agent_settings_batch_window_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_batch_quiet_check check (batch_quiet_seconds between 0 and 120),
  add constraint ai_agent_settings_batch_max_wait_check check (batch_max_wait_seconds between 10 and 600),
  add constraint ai_agent_settings_batch_window_check check (batch_max_wait_seconds >= batch_quiet_seconds);

-- ── 2. Batches ───────────────────────────────────────────────────────────────
create table if not exists public.ai_agent_batches (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  contact_number text,
  status text not null default 'collecting'
    check (status in ('collecting', 'processing', 'done', 'failed', 'cancelled')),
  first_message_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  -- Quiet-period deadline, never later than max_due_at.
  due_at timestamptz not null,
  -- Hard ceiling: first message + the business's maximum wait.
  max_due_at timestamptz not null,
  message_count integer not null default 0,
  attempts integer not null default 0,
  worker_id text,
  claimed_at timestamptz,
  lease_until timestamptz,
  decision text,
  error text,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one COLLECTING batch per chat. Processing batches are not covered,
-- which is what lets a message arriving mid-processing start the next batch.
create unique index if not exists ai_agent_batches_one_collecting_idx
  on public.ai_agent_batches (business_slug, chat_id) where status = 'collecting';
create index if not exists ai_agent_batches_due_idx
  on public.ai_agent_batches (due_at) where status = 'collecting';
create index if not exists ai_agent_batches_lease_idx
  on public.ai_agent_batches (lease_until) where status = 'processing';
create index if not exists ai_agent_batches_chat_idx
  on public.ai_agent_batches (business_slug, chat_id, created_at desc);

create table if not exists public.ai_agent_batch_messages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ai_agent_batches (id) on delete cascade,
  business_slug text not null,
  chat_id text not null,
  whatsapp_message_id text not null,
  event_id uuid,
  text text not null default '' check (char_length(text) <= 8000),
  has_media boolean not null default false,
  -- Original WhatsApp timestamp from the bridge; null when it sent none.
  message_at timestamptz,
  received_at timestamptz not null default now(),
  -- Arrival order, the tie-breaker when timestamps are equal or missing.
  position bigint generated always as identity,
  -- Idempotency: the same WhatsApp message can never join a batch twice.
  constraint ai_agent_batch_messages_uniq unique (business_slug, whatsapp_message_id)
);

create index if not exists ai_agent_batch_messages_batch_idx
  on public.ai_agent_batch_messages (batch_id, position);

alter table public.ai_agent_events
  add column if not exists batch_id uuid;
alter table public.ai_agent_events
  drop constraint if exists ai_agent_events_decision_check;
alter table public.ai_agent_events
  add constraint ai_agent_events_decision_check
  check (decision is null or decision in ('REPLY', 'ASK', 'ESCALATE', 'NO_REPLY', 'HUMAN', 'BATCHED'));

drop trigger if exists trg_touch_ai_agent_batches on public.ai_agent_batches;
create trigger trg_touch_ai_agent_batches before update on public.ai_agent_batches
  for each row execute function public.touch_ai_agent_updated_at();

-- ── 3. enqueue_ai_agent_batch_message ────────────────────────────────────────
-- Atomically attaches one customer message to the chat's collecting batch
-- (creating it if needed) and resets the quiet-period deadline. The settings
-- row is read here so the deadline maths cannot be bypassed by a caller.
-- Returns duplicate = true (and changes nothing) when the message is already
-- in a batch.
create or replace function public.enqueue_ai_agent_batch_message(
  p_business_slug text,
  p_chat_id text,
  p_contact_number text,
  p_whatsapp_message_id text,
  p_event_id uuid,
  p_text text,
  p_has_media boolean,
  p_message_at timestamptz
)
returns table (batch_id uuid, due_at timestamptz, max_due_at timestamptz, message_count integer, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quiet integer;
  v_max integer;
  v_now timestamptz := clock_timestamp();
  b public.ai_agent_batches%rowtype;
  v_inserted integer;
begin
  select s.batch_quiet_seconds, s.batch_max_wait_seconds into v_quiet, v_max
    from public.ai_agent_settings s where s.business_slug = p_business_slug;
  if not found then
    raise exception 'no ai_agent_settings for %', p_business_slug;
  end if;

  -- Same WhatsApp message delivered twice: report it, change nothing.
  select m.batch_id into batch_id from public.ai_agent_batch_messages m
   where m.business_slug = p_business_slug and m.whatsapp_message_id = p_whatsapp_message_id;
  if found then
    select x.due_at, x.max_due_at, x.message_count into due_at, max_due_at, message_count
      from public.ai_agent_batches x where x.id = batch_id;
    duplicate := true;
    return next;
    return;
  end if;

  loop
    select * into b from public.ai_agent_batches x
     where x.business_slug = p_business_slug and x.chat_id = p_chat_id and x.status = 'collecting'
     for update;
    if found then
      exit;
    end if;
    begin
      insert into public.ai_agent_batches
        (business_slug, chat_id, contact_number, first_message_at, last_message_at, due_at, max_due_at)
      values
        (p_business_slug, p_chat_id, p_contact_number, v_now, v_now,
         v_now + make_interval(secs => v_quiet), v_now + make_interval(secs => v_max))
      returning * into b;
      exit;
    exception when unique_violation then
      -- A concurrent enqueue created the collecting batch first: lock and use it.
      null;
    end;
  end loop;

  insert into public.ai_agent_batch_messages
    (batch_id, business_slug, chat_id, whatsapp_message_id, event_id, text, has_media, message_at)
  values
    (b.id, p_business_slug, p_chat_id, p_whatsapp_message_id, p_event_id, coalesce(p_text, ''), coalesce(p_has_media, false), p_message_at)
  on conflict (business_slug, whatsapp_message_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    update public.ai_agent_batches x
       set message_count = x.message_count + 1,
           last_message_at = v_now,
           contact_number = coalesce(p_contact_number, x.contact_number),
           due_at = least(v_now + make_interval(secs => v_quiet), x.max_due_at)
     where x.id = b.id
     returning * into b;
  end if;

  batch_id := b.id;
  due_at := b.due_at;
  max_due_at := b.max_due_at;
  message_count := b.message_count;
  duplicate := v_inserted = 0;
  return next;
end;
$$;

-- ── 4. claim_ai_agent_batches ────────────────────────────────────────────────
-- Worker-only. Takes due collecting batches, and processing batches whose
-- lease expired (a crashed/restarted worker), marking them processing with a
-- fresh lease. SKIP LOCKED makes concurrent workers safe. A batch is held back
-- while an OLDER batch of the same chat is still processing, so one chat is
-- never processed out of order or in parallel. Batches that already used all
-- their attempts are failed instead of retried forever.
create or replace function public.claim_ai_agent_batches(
  p_limit integer default 3,
  p_worker text default null,
  p_lease_seconds integer default 150,
  p_max_attempts integer default 4
)
returns setof public.ai_agent_batches
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_agent_batches
     set status = 'failed', finished_at = now(), error = coalesce(error, 'max_attempts_exceeded')
   where status = 'processing' and lease_until < now() and attempts >= p_max_attempts;

  return query
  update public.ai_agent_batches b
     set status = 'processing',
         attempts = b.attempts + 1,
         worker_id = p_worker,
         claimed_at = now(),
         lease_until = now() + make_interval(secs => p_lease_seconds)
   where b.id in (
     select c.id from public.ai_agent_batches c
      where (
              (c.status = 'collecting' and c.due_at <= now())
           or (c.status = 'processing' and c.lease_until < now() and c.attempts < p_max_attempts)
            )
        and not exists (
              select 1 from public.ai_agent_batches o
               where o.business_slug = c.business_slug and o.chat_id = c.chat_id
                 and o.id <> c.id and o.status = 'processing' and o.created_at < c.created_at
            )
      order by c.due_at
      limit greatest(least(p_limit, 20), 1)
      for update of c skip locked
   )
  returning b.*;
end;
$$;

-- ── 5. complete / release ────────────────────────────────────────────────────
-- Only the worker that holds the lease may finish a batch; a zombie worker
-- whose lease was taken over gets false and must not write further.
create or replace function public.complete_ai_agent_batch(
  p_batch_id uuid,
  p_worker text,
  p_status text,
  p_decision text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_status not in ('done', 'failed', 'cancelled') then
    raise exception 'invalid status %', p_status;
  end if;
  update public.ai_agent_batches
     set status = p_status, decision = p_decision, error = left(p_error, 1000), finished_at = now(), lease_until = null
   where id = p_batch_id and status = 'processing' and worker_id is not distinct from p_worker;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- A failed attempt keeps the batch 'processing' but lets another worker retry
-- it after p_retry_seconds (claim picks up expired leases).
create or replace function public.release_ai_agent_batch(
  p_batch_id uuid,
  p_worker text,
  p_error text,
  p_retry_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.ai_agent_batches
     set error = left(p_error, 1000), lease_until = now() + make_interval(secs => p_retry_seconds)
   where id = p_batch_id and status = 'processing' and worker_id is not distinct from p_worker;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Retention: batch message text is kept only as long as raw WhatsApp messages.
create or replace function public.purge_ai_agent_batches(p_older_than interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  delete from public.ai_agent_batches
   where status in ('done', 'failed', 'cancelled') and coalesce(finished_at, updated_at) < now() - p_older_than;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ── 6. Customer memory ───────────────────────────────────────────────────────
-- customer_key is a VERIFIED phone number (digits) or, when WhatsApp reported
-- no phone for an @lid chat, 'chat:<chat_id>' — never lid digits posing as a
-- phone number and never anything derived from a display name.
create table if not exists public.ai_agent_customer_memory (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  customer_key text not null,
  kind text not null check (kind in ('preference', 'delivery_preference', 'resolved_issue', 'note')),
  -- customer_stated: the customer said it (evidence is their verbatim words).
  -- staff_confirmed: staff closed/answered an escalation.
  -- admin: entered or corrected in the admin UI.
  source text not null check (source in ('customer_stated', 'staff_confirmed', 'admin')),
  content text not null check (char_length(trim(content)) > 0 and char_length(content) <= 300),
  evidence text check (evidence is null or char_length(evidence) <= 500),
  fingerprint text not null,
  source_chat_id text,
  source_message_id text,
  source_escalation_id uuid,
  -- Retention: capture sets this (default 2 years); admin entries may be null.
  expires_at timestamptz,
  last_confirmed_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_customer_memory_uniq unique (business_slug, customer_key, kind, fingerprint)
);

create index if not exists ai_agent_customer_memory_lookup_idx
  on public.ai_agent_customer_memory (business_slug, customer_key, updated_at desc);

drop trigger if exists trg_touch_ai_agent_customer_memory on public.ai_agent_customer_memory;
create trigger trg_touch_ai_agent_customer_memory before update on public.ai_agent_customer_memory
  for each row execute function public.touch_ai_agent_updated_at();

-- An admin can exclude a recorded order from what the agent remembers (a
-- correction that does not rewrite order history). The analysis engine never
-- sets or reads this column.
alter table public.customer_orders
  add column if not exists ai_memory_excluded boolean not null default false;

-- ── 7. Customer data deletion ────────────────────────────────────────────────
-- One transaction. Always removes agent memory facts, pending batch text and
-- the AI-inferred profile. Optional: recorded orders, and the message excerpts
-- kept in agent events / escalations. All scoped to one business.
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
    update public.ai_agent_escalations set customer_message = null, ai_summary = null, proposed_reply = null,
           context = '{}'::jsonb
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

-- ── 8. Grants + RLS ──────────────────────────────────────────────────────────
revoke all on function public.enqueue_ai_agent_batch_message(text, text, text, text, uuid, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_ai_agent_batches(integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_ai_agent_batch(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.release_ai_agent_batch(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.purge_ai_agent_batches(interval) from public, anon, authenticated;
revoke all on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.enqueue_ai_agent_batch_message(text, text, text, text, uuid, text, boolean, timestamptz) to service_role;
grant execute on function public.claim_ai_agent_batches(integer, text, integer, integer) to service_role;
grant execute on function public.complete_ai_agent_batch(uuid, text, text, text, text) to service_role;
grant execute on function public.release_ai_agent_batch(uuid, text, text, integer) to service_role;
grant execute on function public.purge_ai_agent_batches(interval) to service_role;
grant execute on function public.forget_ai_agent_customer(text, text[], text, boolean, boolean) to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['ai_agent_batches', 'ai_agent_batch_messages', 'ai_agent_customer_memory'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins can read %1$s" on public.%1$I', t);
    execute format(
      'create policy "Admins can read %1$s" on public.%1$I for select to authenticated using (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Verification (optional):
--   select business_slug, batching_enabled, batch_quiet_seconds, batch_max_wait_seconds, customer_memory_enabled
--     from public.ai_agent_settings order by 1;
--   -- Expected: batching_enabled = false, 45, 180, customer_memory_enabled = false everywhere
--   select count(*) from public.ai_agent_batches;  -- Expected: 0
--
-- Scheduler (NOT applied here; see docs/ai-agent-batching-memory.md): due batches are
-- processed by POST /api/cron/ai-agent/batches, and opportunistically on every bridge
-- outbox poll and forwarded message. An optional Supabase pg_cron + pg_net job can call
-- the same endpoint once a minute as a belt-and-braces trigger.
