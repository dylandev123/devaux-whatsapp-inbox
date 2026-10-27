-- Staff-managed customer memory, part 2: "!location clear" and expiring "!remember" proposals.
-- Run this in the Supabase SQL editor AFTER 20261106000000_ai_agent_customer_staff_memory.sql and BEFORE deploying the
-- matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261106000000_ai_agent_customer_staff_memory.sql (the ai_agent_customer_staff_memory table).
--
-- Additive and idempotent (safe to run twice): one new column, two widened status lists, one new function.
-- No existing row is changed.
--
--   * status 'removed' is now also valid for a delivery_location (a cleared default). Notes already used it.
--   * status 'expired' is new: a note proposal nobody confirmed within 7 days. The app marks it (ended_at set, ended_by
--     null = the system) and refuses to confirm it; the confirming UPDATE is also guarded by created_at, so a race cannot confirm a stale one.
--   * ended_message_id remembers WHICH WhatsApp message ended a row, so a redelivered "!location clear" is a no-op.

alter table public.ai_agent_customer_staff_memory add column if not exists ended_message_id text;

alter table public.ai_agent_customer_staff_memory drop constraint if exists ai_agent_customer_staff_memory_status_check;
alter table public.ai_agent_customer_staff_memory
  add constraint ai_agent_customer_staff_memory_status_check
  check (status in ('proposed', 'active', 'superseded', 'discarded', 'removed', 'expired'));

create index if not exists ai_agent_customer_staff_memory_ended_message_idx
  on public.ai_agent_customer_staff_memory (business_slug, ended_message_id) where ended_message_id is not null;
-- Finds stale proposals quickly.
create index if not exists ai_agent_customer_staff_memory_proposed_idx
  on public.ai_agent_customer_staff_memory (business_slug, created_at) where kind = 'note' and status = 'proposed';

-- ── clear_ai_agent_customer_location ─────────────────────────────────────────
-- Removes ONE customer's default delivery location in one transaction. The row is kept (status 'removed') with who and
-- when, so the history shows what was cleared.
--   p_customer_key   the key the command resolved to
--   p_keys           every key that provably belongs to the same customer; an active default under ANY of them is cleared
-- result: 'cleared' | 'none' | 'replayed'
--   none      no default location was saved: nothing written
--   replayed  this very WhatsApp message already cleared it: nothing written
create or replace function public.clear_ai_agent_customer_location(
  p_business_slug text,
  p_customer_key text,
  p_keys text[],
  p_cleared_by text,
  p_source_message_id text
)
returns table (result text, id uuid, previous_location text, previous_set_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.ai_agent_customer_staff_memory%rowtype;
  v_keys text[] := array(select distinct k from unnest(coalesce(p_keys, '{}') || p_customer_key) k);
begin
  -- Same lock as set_ai_agent_customer_location: a set and a clear for one business never interleave.
  perform pg_advisory_xact_lock(hashtext('staff_memory:' || p_business_slug));

  if p_source_message_id is not null then
    select * into v_current from public.ai_agent_customer_staff_memory m
     where m.business_slug = p_business_slug and m.ended_message_id = p_source_message_id
       and m.kind = 'delivery_location' and m.status = 'removed'
     limit 1;
    if found then
      return query select 'replayed'::text, v_current.id, v_current.content, v_current.created_at;
      return;
    end if;
  end if;

  select * into v_current from public.ai_agent_customer_staff_memory m
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'delivery_location' and m.status = 'active'
   order by m.created_at desc limit 1;

  if not found then
    return query select 'none'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  update public.ai_agent_customer_staff_memory m
     set status = 'removed', ended_at = now(), ended_by = p_cleared_by, ended_message_id = p_source_message_id
   where m.business_slug = p_business_slug and m.customer_key = any (v_keys)
     and m.kind = 'delivery_location' and m.status = 'active';

  return query select 'cleared'::text, v_current.id, v_current.content, v_current.created_at;
end;
$$;

revoke all on function public.clear_ai_agent_customer_location(text, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.clear_ai_agent_customer_location(text, text, text[], text, text) to service_role;
