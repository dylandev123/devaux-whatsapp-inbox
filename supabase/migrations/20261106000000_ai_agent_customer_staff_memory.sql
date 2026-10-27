-- Staff-managed customer memory: a default delivery location per customer, and staff-confirmed customer notes.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261025000000_ai_agent_batching_memory.sql (touch_ai_agent_updated_at, forget_ai_agent_customer),
--             20261101000000_ai_agent_daily_orders.sql (the latest forget_ai_agent_customer, redefined below).
--
-- Additive: one new table, one new function, and forget_ai_agent_customer re-created with ONE extra delete.
-- Nothing is enabled or backfilled; no existing row is changed.
--
-- Why a separate table (and not ai_agent_customer_memory): that table holds what the CUSTOMER said or staff resolved,
-- is written by the AI pipeline, and is read in bulk into prompts. This one holds what STAFF decided, has a
-- lifecycle (proposed / active / superseded / removed) and keeps every change with who, when and from which message.
-- Like the other agent tables it has no foreign keys, so the 7-day message purge never touches it.
--
-- customer_key is the same key as ai_agent_customer_memory: the VERIFIED phone digits, or 'chat:<chat_id>' for an
-- @lid chat WhatsApp gave no phone for. Never a display name.

create table if not exists public.ai_agent_customer_staff_memory (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  customer_key text not null,
  kind text not null check (kind in ('delivery_location', 'note')),
  -- delivery_location: active (the one current default) -> superseded (replaced).
  -- note: proposed -> active | discarded; active -> removed.
  status text not null check (status in ('proposed', 'active', 'superseded', 'discarded', 'removed')),
  content text not null check (char_length(trim(content)) > 0 and char_length(content) <= 300),
  -- Normalised content: two spellings of the same location/note are one memory.
  fingerprint text not null,
  -- Staff-readable code for a note (M-ABCDE); null for locations.
  short_code text,
  -- Who and where it came from. set_by is the VERIFIED sender id (phone digits or <digits>@lid), never a name.
  source text not null default 'staff_whatsapp' check (source in ('staff_whatsapp', 'admin')),
  set_by text,
  source_message_id text,
  source_event_id uuid,
  -- The chat the command was resolved to, and a display label, for the audit trail only (never used to match).
  source_chat_id text,
  customer_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by text,
  ended_at timestamptz,
  ended_by text,
  replaces_id uuid,
  replaced_by_id uuid
);

-- At most ONE active default location per customer key: two contradictory defaults cannot exist.
create unique index if not exists ai_agent_customer_staff_memory_one_location_idx
  on public.ai_agent_customer_staff_memory (business_slug, customer_key)
  where kind = 'delivery_location' and status = 'active';
-- The same note cannot be active or waiting twice.
create unique index if not exists ai_agent_customer_staff_memory_note_dup_idx
  on public.ai_agent_customer_staff_memory (business_slug, customer_key, fingerprint)
  where kind = 'note' and status in ('proposed', 'active');
create unique index if not exists ai_agent_customer_staff_memory_code_idx
  on public.ai_agent_customer_staff_memory (business_slug, short_code) where short_code is not null;
-- A WhatsApp message makes at most one change of each kind: a redelivered command is a no-op.
create unique index if not exists ai_agent_customer_staff_memory_message_idx
  on public.ai_agent_customer_staff_memory (business_slug, source_message_id, kind) where source_message_id is not null;
create index if not exists ai_agent_customer_staff_memory_lookup_idx
  on public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status);

drop trigger if exists trg_touch_ai_agent_customer_staff_memory on public.ai_agent_customer_staff_memory;
create trigger trg_touch_ai_agent_customer_staff_memory before update on public.ai_agent_customer_staff_memory
  for each row execute function public.touch_ai_agent_updated_at();

-- ── set_ai_agent_customer_location ───────────────────────────────────────────
-- Saves or replaces ONE customer's default delivery location in one transaction.
--   p_customer_key   the key new data is stored under
--   p_keys           every key that provably belongs to the same customer (verified phone + known chats); an active
--                    default under ANY of them is the one being replaced, so a customer never ends up with two
-- result: 'created' | 'updated' | 'unchanged' | 'replayed'
--   unchanged  the same location is already the default: nothing written (no duplicate, no new history row)
--   replayed   this very WhatsApp message already made the change: nothing written
create or replace function public.set_ai_agent_customer_location(
  p_business_slug text,
  p_customer_key text,
  p_keys text[],
  p_location text,
  p_fingerprint text,
  p_set_by text,
  p_source_message_id text,
  p_source_event_id uuid,
  p_source_chat_id text,
  p_customer_label text
)
returns table (result text, id uuid, previous_location text, previous_set_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.ai_agent_customer_staff_memory%rowtype;
  v_new uuid;
  v_keys text[] := array(select distinct k from unnest(coalesce(p_keys, '{}') || p_customer_key) k);
begin
  if coalesce(trim(p_location), '') = '' then
    raise exception 'location is required';
  end if;
  -- Serialises concurrent changes for one business (low volume: staff typing).
  perform pg_advisory_xact_lock(hashtext('staff_memory:' || p_business_slug));

  if p_source_message_id is not null then
    select * into v_current from public.ai_agent_customer_staff_memory m
     where m.business_slug = p_business_slug and m.source_message_id = p_source_message_id and m.kind = 'delivery_location';
    if found then
      return query select 'replayed'::text, v_current.id, null::text, null::timestamptz;
      return;
    end if;
  end if;

  select * into v_current from public.ai_agent_customer_staff_memory m
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'delivery_location' and m.status = 'active'
   order by m.created_at desc limit 1;

  if found and v_current.fingerprint = p_fingerprint then
    return query select 'unchanged'::text, v_current.id, v_current.content, v_current.created_at;
    return;
  end if;

  -- Every active default of this customer (under any of its keys) ends first; the new one takes over.
  update public.ai_agent_customer_staff_memory m
     set status = 'superseded', ended_at = now(), ended_by = p_set_by
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'delivery_location' and m.status = 'active';

  insert into public.ai_agent_customer_staff_memory
    (business_slug, customer_key, kind, status, content, fingerprint, source, set_by, source_message_id, source_event_id,
     source_chat_id, customer_label, confirmed_at, confirmed_by, replaces_id)
  values
    (p_business_slug, p_customer_key, 'delivery_location', 'active', trim(p_location), p_fingerprint, 'staff_whatsapp', p_set_by,
     p_source_message_id, p_source_event_id, p_source_chat_id, left(p_customer_label, 120), now(), p_set_by, v_current.id)
  returning ai_agent_customer_staff_memory.id into v_new;

  update public.ai_agent_customer_staff_memory m set replaced_by_id = v_new
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'delivery_location' and m.status = 'superseded' and m.replaced_by_id is null and m.id <> v_new;

  return query select (case when v_current.id is null then 'created' else 'updated' end)::text, v_new, v_current.content, v_current.created_at;
end;
$$;

revoke all on function public.set_ai_agent_customer_location(text, text, text[], text, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_ai_agent_customer_location(text, text, text[], text, text, text, text, uuid, text, text) to service_role;

-- ── forget_ai_agent_customer: also erase staff-written memory ─────────────────
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
  v_staff integer := 0;
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

  -- Staff-written memory (default delivery location, notes) is customer data too.
  delete from public.ai_agent_customer_staff_memory
   where business_slug = p_business_slug and customer_key = any (v_keys);
  get diagnostics v_staff = row_count;
  v_memory := v_memory + v_staff;

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

-- ── RLS: admins may read; only the service role (the app server) writes ─────
alter table public.ai_agent_customer_staff_memory enable row level security;
drop policy if exists "Admins can read ai_agent_customer_staff_memory" on public.ai_agent_customer_staff_memory;
create policy "Admins can read ai_agent_customer_staff_memory" on public.ai_agent_customer_staff_memory
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_customer_staff_memory from anon;
grant select on public.ai_agent_customer_staff_memory to authenticated;
grant all on public.ai_agent_customer_staff_memory to service_role;
