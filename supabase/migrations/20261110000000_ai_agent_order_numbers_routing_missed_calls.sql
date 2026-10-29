-- AI agent: simple order numbers (!order 2), Rules & Routing (notification groups) and the missed-call rule.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code. Not applied automatically.
--
-- DEPENDS ON: 20261101000000_ai_agent_daily_orders.sql (ai_agent_orders, claim_ai_agent_outbox), 20261109000000.
--
-- Additive and idempotent (safe to run twice). Nothing here switches a feature on:
--   * routing_rules defaults to '{}' (no routing: every notice goes where it goes today);
--   * missed_call_enabled defaults to false;
--   * no order, customer, memory or message row is read or changed.
--
--   ai_agent_settings.routing_rules   per business: { "<category>": { "enabled": bool, "group_jid": "...@g.us", "group_name": "..." } }
--                                     for complaints / urgent / approvals. (The orders category keeps using orders_group_jid.)
--   ai_agent_settings.missed_call_*   the missed-call rule: off by default, message and per-caller cooldown.
--   ai_agent_order_lists              the numbered list behind each !orders report / morning summary: which order each number
--                                     meant at the moment it was posted. "!order 2" is resolved against THIS, never against a
--                                     list that has been re-sorted since. Holds order ids, references and versions only.
--   ai_agent_call_events              audit trail of every call event the bridge reported and what was decided (replied / why not).
--   record_ai_agent_missed_call()     the one place a missed call is decided: serialised per caller, so two events for the same
--                                     caller can never both reply inside the cooldown.

-- ── 1. Settings ──────────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists routing_rules jsonb not null default '{}'::jsonb,
  add column if not exists missed_call_enabled boolean not null default false,
  add column if not exists missed_call_message text not null default 'Thanks for reaching out! Sorry we missed your call. We''re unable to answer at the moment, but how can we help you?',
  add column if not exists missed_call_cooldown_minutes integer not null default 60;
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_routing_rules_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_routing_rules_check check (jsonb_typeof(routing_rules) = 'object');
alter table public.ai_agent_settings drop constraint if exists ai_agent_settings_missed_call_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_missed_call_check check (
    missed_call_cooldown_minutes between 5 and 10080 and char_length(missed_call_message) between 1 and 500
  );

-- ── 2. The missed-call reply is its own outbox kind ──────────────────────────
alter table public.ai_agent_outbox drop constraint if exists ai_agent_outbox_kind_check;
alter table public.ai_agent_outbox
  add constraint ai_agent_outbox_kind_check
  check (kind in ('customer_reply', 'holding_reply', 'staff_notice', 'staff_draft', 'staff_relay', 'staff_feedback', 'missed_call_reply'));

-- ── 3. Numbered order lists ──────────────────────────────────────────────────
create table if not exists public.ai_agent_order_lists (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  -- The group the report was posted in: a number typed anywhere else never resolves against it.
  group_jid text not null,
  -- 'default', 'today', 'tomorrow', 'day', 'all', 'overdue', 'missing', 'undated', 'review': a newer list of the same kind replaces the older.
  view_kind text not null,
  -- The outbox dedupe key shared by the report's parts (<key>, <key>:p2, …): how a quoted report message finds its list.
  list_key text not null,
  -- [{ "n": 1, "order_id": "...", "ref": "QU6U9", "version": 3 }, …] in the order shown.
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_order_lists_key_idx on public.ai_agent_order_lists (business_slug, list_key);
create index if not exists ai_agent_order_lists_recent_idx on public.ai_agent_order_lists (business_slug, group_jid, created_at desc);

-- ── 4. Call events ───────────────────────────────────────────────────────────
create table if not exists public.ai_agent_call_events (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  -- The WhatsApp call id. One decision per call, however many times the bridge reports it.
  call_id text not null,
  caller_jid text not null,
  -- 'replied' or 'skipped'.
  decision text not null check (decision in ('replied', 'skipped')),
  -- Why: replied | disabled | agent_off | mode_not_allowed | not_missed | group_call | outgoing | uncertain | cooldown | rate_limited | duplicate | invalid_caller …
  reason text not null,
  outbox_id uuid,
  video boolean,
  call_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_agent_call_events_call_idx on public.ai_agent_call_events (business_slug, call_id);
create index if not exists ai_agent_call_events_caller_idx on public.ai_agent_call_events (business_slug, caller_jid, created_at desc);
create index if not exists ai_agent_call_events_recent_idx on public.ai_agent_call_events (business_slug, created_at desc);

alter table public.ai_agent_order_lists enable row level security;
alter table public.ai_agent_call_events enable row level security;
drop policy if exists "Admins can read ai_agent_order_lists" on public.ai_agent_order_lists;
create policy "Admins can read ai_agent_order_lists" on public.ai_agent_order_lists for select to authenticated using (public.is_admin());
drop policy if exists "Admins can read ai_agent_call_events" on public.ai_agent_call_events;
create policy "Admins can read ai_agent_call_events" on public.ai_agent_call_events for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_order_lists from anon;
revoke all on public.ai_agent_call_events from anon;
grant select on public.ai_agent_order_lists to authenticated;
grant select on public.ai_agent_call_events to authenticated;
grant all on public.ai_agent_order_lists to service_role;
grant all on public.ai_agent_call_events to service_role;

-- ── 5. record_ai_agent_missed_call ───────────────────────────────────────────
-- Decides and records ONE missed call, and queues the reply when (and only when) every rule allows it. Returns one row:
--   decision = 'replied' | 'skipped', reason, outbox_id (when replied).
-- The caller (the app) has already checked that the event is a reliably identified incoming one-to-one missed call; this
-- re-checks the settings and, under a per-caller lock, the cooldown and the hourly cap.
create or replace function public.record_ai_agent_missed_call(
  p_business_slug text,
  p_call_id text,
  p_caller_jid text,
  p_video boolean,
  p_call_at timestamptz
)
returns table (decision text, reason text, outbox_id uuid, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.ai_agent_settings%rowtype;
  v_existing public.ai_agent_call_events%rowtype;
  v_reason text := null;
  v_id uuid;
  v_event uuid;
begin
  -- One caller at a time within a business.
  perform pg_advisory_xact_lock(hashtext('missedcall:' || p_business_slug || ':' || p_caller_jid));

  select * into v_existing from public.ai_agent_call_events e where e.business_slug = p_business_slug and e.call_id = p_call_id;
  if found then
    decision := 'skipped'; reason := 'duplicate'; outbox_id := v_existing.outbox_id; message := null;
    return next; return;
  end if;

  select * into s from public.ai_agent_settings x where x.business_slug = p_business_slug;
  if not found or not s.enabled then
    v_reason := 'agent_off';
  elsif not s.missed_call_enabled then
    v_reason := 'disabled';
  elsif s.mode not in ('assisted', 'approval_pilot') then
    -- Observe never writes to a customer.
    v_reason := 'mode_not_allowed';
  elsif p_caller_jid !~ '^[^@\s]+@(s\.whatsapp\.net|lid)$' then
    v_reason := 'invalid_caller';
  elsif exists (
    select 1 from public.ai_agent_call_events e
     where e.business_slug = p_business_slug and e.caller_jid = p_caller_jid and e.decision = 'replied'
       and e.created_at > now() - make_interval(mins => s.missed_call_cooldown_minutes)
  ) then
    v_reason := 'cooldown';
  elsif (
    select count(*) from public.ai_agent_call_events e
     where e.business_slug = p_business_slug and e.decision = 'replied' and e.created_at > now() - interval '1 hour'
  ) >= 20 then
    v_reason := 'rate_limited';
  end if;

  if v_reason is not null then
    insert into public.ai_agent_call_events (business_slug, call_id, caller_jid, decision, reason, video, call_at)
    values (p_business_slug, p_call_id, p_caller_jid, 'skipped', v_reason, p_video, p_call_at);
    decision := 'skipped'; reason := v_reason; outbox_id := null; message := null;
    return next; return;
  end if;

  insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key, status, dispatched_at)
  values (p_business_slug, p_caller_jid, 'missed_call_reply', p_caller_jid, left(s.missed_call_message, 500),
          'missedcall:' || p_business_slug || ':' || p_call_id, 'dispatched', now())
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    insert into public.ai_agent_call_events (business_slug, call_id, caller_jid, decision, reason, video, call_at)
    values (p_business_slug, p_call_id, p_caller_jid, 'skipped', 'duplicate', p_video, p_call_at);
    decision := 'skipped'; reason := 'duplicate'; outbox_id := null; message := null;
    return next; return;
  end if;
  insert into public.ai_agent_call_events (business_slug, call_id, caller_jid, decision, reason, outbox_id, video, call_at)
  values (p_business_slug, p_call_id, p_caller_jid, 'replied', 'replied', v_id, p_video, p_call_at)
  returning id into v_event;

  decision := 'replied'; reason := 'replied'; outbox_id := v_id; message := s.missed_call_message;
  return next;
end;
$$;

revoke all on function public.record_ai_agent_missed_call(text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.record_ai_agent_missed_call(text, text, text, boolean, timestamptz) to service_role;

-- ── 6. Routed groups ─────────────────────────────────────────────────────────
-- True when `jid` is the group of an ENABLED rule in this business's routing_rules.
create or replace function public.ai_agent_is_routed_group(p_rules jsonb, p_jid text)
returns boolean
language sql
immutable
as $$
  select p_jid is not null and exists (
    select 1 from jsonb_each(coalesce(p_rules, '{}'::jsonb)) r(category, rule)
     where jsonb_typeof(r.rule) = 'object' and (r.rule->>'enabled') = 'true' and r.rule->>'group_jid' = p_jid
  );
$$;

-- ── 7. claim_ai_agent_outbox ─────────────────────────────────────────────────
-- Same as 20261101000000, plus: staff-group kinds addressed to an enabled routed group (same modes as the staff group), and the
-- missed-call reply (Assisted and Approval Pilot only, and only while the rule is on).
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
                   or (p.kind in ('staff_notice', 'staff_draft', 'staff_feedback') and public.ai_agent_is_routed_group(s.routing_rules, p.to_jid))
                   or (p.kind in ('staff_notice', 'staff_feedback') and s.orders_summary_enabled and p.to_jid = s.orders_group_jid)
                   or (p.kind = 'missed_call_reply' and s.missed_call_enabled)
                   or p.kind = 'staff_relay'))
          or (s.mode = 'observe' and s.staff_notices_enabled
              and ((p.kind in ('staff_notice', 'staff_draft') and p.to_jid = s.staff_group_jid)
                   or (p.kind in ('staff_notice', 'staff_draft') and public.ai_agent_is_routed_group(s.routing_rules, p.to_jid))
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

-- Verification (optional):
--   select routing_rules, missed_call_enabled, missed_call_cooldown_minutes from public.ai_agent_settings;  -- '{}' / false / 60
--   select count(*) from public.ai_agent_order_lists;    -- Expected: 0
--   select count(*) from public.ai_agent_call_events;    -- Expected: 0
