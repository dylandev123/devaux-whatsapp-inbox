-- AI agent: customer messages that contradict a staff-locked order field.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261101000000_ai_agent_daily_orders.sql (and 20261102000000_ai_agent_order_monitoring.sql).
--
--   1. ai_agent_orders.field_conflicts: { "<field>": { "proposed": ..., "current": ..., "at": "<iso>" } }. What a customer
--      asked for in a field staff had locked. The staff value is never overwritten; the proposal waits here until staff
--      apply it, keep their value, or edit the field (which clears it).
--   2. apply_ai_agent_order(): same signature and behaviour, now also writing field_conflicts from p_row.
--
-- Additive: one column with a default, and a function replaced with an identical signature. No data is changed.

alter table public.ai_agent_orders add column if not exists field_conflicts jsonb not null default '{}'::jsonb
  check (jsonb_typeof(field_conflicts) = 'object');

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
       first_message_at, last_message_at, awaiting_since, manual_locked_fields, field_conflicts, confirmed_by, confirmed_at,
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
       coalesce(p_row->'field_conflicts', '{}'::jsonb),
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
      field_conflicts = coalesce(p_row->'field_conflicts', '{}'::jsonb),
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

-- Verification (optional):
--   select count(*) from public.ai_agent_orders where field_conflicts <> '{}'::jsonb;   -- Expected: 0
