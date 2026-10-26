-- AI agent: Daily Order Summary.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261031000000_ai_agent_pilot_refinements.sql (and every earlier 20261022–20261030 agent migration).
--
--   1. Per-business settings (all OFF by default): order tracking, the 8 AM summary, the destination group
--      (null = the staff group), the timezone (America/St_Lucia), the hour, whether a customer's "yes" may
--      finalize an order (default: no, staff verify) and when tracking started.
--   2. ai_agent_orders          the authoritative order records (one row per distinct order).
--      ai_agent_order_events    append-only change history, also the idempotency record for retried turns.
--      ai_agent_order_summary_runs  one row per scheduled day (unique) / manual !update: the delivery audit.
--   3. apply_ai_agent_order()   atomic, idempotent, optimistic-locked write of one order change.
--   4. claim_ai_agent_outbox()  also hands out a staff_notice addressed to the separate orders group.
--   5. forget_ai_agent_customer also deletes the customer's tracked orders (with p_include_orders).
--
-- Additive. Nothing is switched on. Approval Pilot, ai_agent_order_requests and customer_orders are untouched.

-- ── 1. Settings ──────────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists orders_tracking_enabled boolean not null default false,
  add column if not exists orders_summary_enabled boolean not null default false,
  add column if not exists orders_group_jid text,
  add column if not exists orders_group_name text,
  add column if not exists orders_timezone text not null default 'America/St_Lucia',
  add column if not exists orders_summary_hour smallint not null default 8,
  -- Rollout safety: false = a customer's "yes" is only RECORDED (staff verify and confirm); true = it can finalize.
  add column if not exists orders_customer_confirms boolean not null default false,
  -- When tracking was last switched on: the report says that earlier conversations were not analysed.
  add column if not exists orders_tracking_since timestamptz;
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_orders_hour_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_orders_hour_check check (orders_summary_hour between 0 and 23);
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_orders_group_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_orders_group_check check (orders_group_jid is null or orders_group_jid like '%@g.us');

-- ── 2. Orders ────────────────────────────────────────────────────────────────
create table if not exists public.ai_agent_orders (
  id uuid primary key default gen_random_uuid(),
  ref_code text not null unique,
  business_slug text not null,
  chat_id text not null,
  -- Verified phone digits only (never the digits of an @lid); null when WhatsApp reported none.
  contact_number text,
  customer_name text,
  status text not null default 'possible'
    check (status in ('possible', 'awaiting_confirmation', 'confirmed', 'fulfilled', 'cancelled')),
  -- [{ product, quantity, variant, size }]
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  fulfilment_method text check (fulfilment_method is null or fulfilment_method in ('delivery', 'collection')),
  delivery_preference text,
  delivery_address text,
  requested_for text,
  notes text,
  missing_fields text[] not null default '{}',
  -- Why a person should look: changed_after_confirmation | cancellation_requested | check_if_duplicate.
  attention text,
  -- WhatsApp message ids (not text) of the customer messages this order was built from.
  source_message_ids text[] not null default '{}',
  first_message_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  awaiting_since timestamptz,
  -- Fields a person edited: the AI never overwrites these.
  manual_locked_fields text[] not null default '{}',
  -- 'customer' | 'admin:<user id>'. A customer reply is recorded in customer_confirmed_at even when only staff may finalize.
  confirmed_by text,
  confirmed_at timestamptz,
  customer_confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  fulfilled_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_agent_orders_open_idx on public.ai_agent_orders (business_slug, status);
create index if not exists ai_agent_orders_chat_idx on public.ai_agent_orders (business_slug, chat_id);
create index if not exists ai_agent_orders_recent_idx on public.ai_agent_orders (business_slug, updated_at desc);

create table if not exists public.ai_agent_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.ai_agent_orders (id) on delete cascade,
  business_slug text not null,
  kind text not null,
  actor_kind text not null check (actor_kind in ('ai', 'customer', 'admin', 'staff', 'system')),
  actor_id text,
  changes jsonb not null default '{}'::jsonb,
  whatsapp_message_ids text[] not null default '{}',
  -- Set for AI/customer changes: "<batch or event id>:<n>". A retried turn finds its key and changes nothing.
  idempotency_key text,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_order_events_key_idx on public.ai_agent_order_events (idempotency_key) where idempotency_key is not null;
create index if not exists ai_agent_order_events_order_idx on public.ai_agent_order_events (order_id, created_at);

create table if not exists public.ai_agent_order_summary_runs (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  local_date date not null,
  -- "<business>:<local date>" for scheduled runs: the unique key that makes the daily summary happen once.
  scheduled_key text unique,
  status text not null default 'claimed' check (status in ('claimed', 'queued', 'missed', 'skipped')),
  skip_reason text,
  requested_by text,
  event_id uuid,
  outbox_id uuid,
  group_jid text,
  attempts integer not null default 1,
  confirmed_count integer,
  attention_count integer,
  carried_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_agent_order_summary_runs_recent_idx on public.ai_agent_order_summary_runs (business_slug, created_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['ai_agent_orders', 'ai_agent_order_summary_runs'] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$s
         for each row execute function public.touch_ai_agent_updated_at()', t);
  end loop;
  foreach t in array array['ai_agent_orders', 'ai_agent_order_events', 'ai_agent_order_summary_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins can read %1$s" on public.%1$I', t);
    execute format('create policy "Admins can read %1$s" on public.%1$I for select to authenticated using (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ── 3. apply_ai_agent_order ──────────────────────────────────────────────────
-- One order change, atomically: the idempotency check, the insert/update (optimistic lock on version), and the
-- history event. p_row carries EVERY mutable column (the app merged it); p_order_id null = create.
-- Results: applied | duplicate (this key was already applied) | conflict (version moved: re-read and retry) | not_found.
create or replace function public.apply_ai_agent_order(
  p_key text,
  p_business_slug text,
  p_order_id uuid,
  p_expected_version integer,
  p_row jsonb,
  p_event_kind text,
  p_actor_kind text,
  p_actor_id text,
  p_changes jsonb,
  p_message_ids text[]
)
returns table (result text, order_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_cur public.ai_agent_orders%rowtype;
begin
  if p_key is not null then
    select e.order_id into v_id from public.ai_agent_order_events e where e.idempotency_key = p_key;
    if found then
      result := 'duplicate'; order_id := v_id; return next; return;
    end if;
  end if;

  if p_order_id is null then
    insert into public.ai_agent_orders
      (ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method,
       delivery_preference, delivery_address, requested_for, notes, missing_fields, attention, source_message_ids,
       first_message_at, last_message_at, awaiting_since, manual_locked_fields, confirmed_by, confirmed_at,
       customer_confirmed_at, cancelled_at, cancel_reason, fulfilled_at)
    values
      (p_row->>'ref_code', p_business_slug, p_row->>'chat_id', p_row->>'contact_number', p_row->>'customer_name',
       coalesce(p_row->>'status', 'possible'), coalesce(p_row->'items', '[]'::jsonb), p_row->>'fulfilment_method',
       p_row->>'delivery_preference', p_row->>'delivery_address', p_row->>'requested_for', p_row->>'notes',
       array(select jsonb_array_elements_text(coalesce(p_row->'missing_fields', '[]'::jsonb))),
       p_row->>'attention',
       array(select jsonb_array_elements_text(coalesce(p_row->'source_message_ids', '[]'::jsonb))),
       coalesce((p_row->>'first_message_at')::timestamptz, now()), coalesce((p_row->>'last_message_at')::timestamptz, now()),
       (p_row->>'awaiting_since')::timestamptz,
       array(select jsonb_array_elements_text(coalesce(p_row->'manual_locked_fields', '[]'::jsonb))),
       p_row->>'confirmed_by', (p_row->>'confirmed_at')::timestamptz, (p_row->>'customer_confirmed_at')::timestamptz,
       (p_row->>'cancelled_at')::timestamptz,
       p_row->>'cancel_reason', (p_row->>'fulfilled_at')::timestamptz)
    returning id into v_id;
  else
    select * into v_cur from public.ai_agent_orders o where o.id = p_order_id and o.business_slug = p_business_slug for update;
    if not found then
      result := 'not_found'; order_id := null; return next; return;
    end if;
    if v_cur.version <> p_expected_version then
      result := 'conflict'; order_id := p_order_id; return next; return;
    end if;
    update public.ai_agent_orders set
      contact_number = p_row->>'contact_number',
      customer_name = p_row->>'customer_name',
      status = coalesce(p_row->>'status', v_cur.status),
      items = coalesce(p_row->'items', v_cur.items),
      fulfilment_method = p_row->>'fulfilment_method',
      delivery_preference = p_row->>'delivery_preference',
      delivery_address = p_row->>'delivery_address',
      requested_for = p_row->>'requested_for',
      notes = p_row->>'notes',
      missing_fields = array(select jsonb_array_elements_text(coalesce(p_row->'missing_fields', '[]'::jsonb))),
      attention = p_row->>'attention',
      source_message_ids = array(select jsonb_array_elements_text(coalesce(p_row->'source_message_ids', '[]'::jsonb))),
      last_message_at = coalesce((p_row->>'last_message_at')::timestamptz, v_cur.last_message_at),
      awaiting_since = (p_row->>'awaiting_since')::timestamptz,
      manual_locked_fields = array(select jsonb_array_elements_text(coalesce(p_row->'manual_locked_fields', '[]'::jsonb))),
      confirmed_by = p_row->>'confirmed_by',
      confirmed_at = (p_row->>'confirmed_at')::timestamptz,
      customer_confirmed_at = (p_row->>'customer_confirmed_at')::timestamptz,
      cancelled_at = (p_row->>'cancelled_at')::timestamptz,
      cancel_reason = p_row->>'cancel_reason',
      fulfilled_at = (p_row->>'fulfilled_at')::timestamptz,
      version = v_cur.version + 1
    where id = p_order_id;
    v_id := p_order_id;
  end if;

  insert into public.ai_agent_order_events (order_id, business_slug, kind, actor_kind, actor_id, changes, whatsapp_message_ids, idempotency_key)
  values (v_id, p_business_slug, p_event_kind, p_actor_kind, p_actor_id, coalesce(p_changes, '{}'::jsonb), coalesce(p_message_ids, '{}'), p_key);

  result := 'applied'; order_id := v_id; return next;
end;
$$;

revoke all on function public.apply_ai_agent_order(text, text, uuid, integer, jsonb, text, text, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.apply_ai_agent_order(text, text, uuid, integer, jsonb, text, text, text, jsonb, text[]) to service_role;

-- ── 4. claim_ai_agent_outbox ─────────────────────────────────────────────────
-- Same as 20261030000000, plus: a staff_notice addressed to a SEPARATE orders group (orders_group_jid, when the
-- summary is on). With no separate group the summary goes to the staff group and the existing rules already cover it.
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
                   or (p.kind in ('staff_notice', 'staff_feedback') and s.orders_summary_enabled and p.to_jid = s.orders_group_jid)
                   or p.kind = 'staff_relay'))
          or (s.mode = 'observe' and s.staff_notices_enabled
              and ((p.kind in ('staff_notice', 'staff_draft') and p.to_jid = s.staff_group_jid)
                   or (p.kind = 'staff_notice' and s.orders_summary_enabled and p.to_jid = s.orders_group_jid)))
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

-- ── 5. forget_ai_agent_customer ──────────────────────────────────────────────
-- Same as 20261031000000, plus the customer's tracked orders (and, by cascade, their change history).
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
  v_tracked integer := 0;
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
    -- Tracked daily orders (their change history is deleted with them).
    delete from public.ai_agent_orders
     where business_slug = p_business_slug
       and (chat_id = any (coalesce(p_chat_ids, '{}')) or (p_phone is not null and p_phone <> '' and contact_number = p_phone));
    get diagnostics v_tracked = row_count;
    v_orders := v_orders + v_tracked;
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
--   select count(*) from public.ai_agent_orders;                                   -- Expected: 0
--   select business_slug, orders_tracking_enabled, orders_summary_enabled, orders_group_jid, orders_timezone, orders_summary_hour
--     from public.ai_agent_settings order by 1;                                    -- Expected: false, false, null, America/St_Lucia, 8
