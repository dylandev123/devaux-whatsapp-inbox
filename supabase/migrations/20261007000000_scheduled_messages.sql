-- Scheduled WhatsApp messages: config + history source of truth.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.
--
-- Purely additive: creates new tables/functions only. Nothing existing is
-- altered, so the current app and bridge are unaffected.
--
-- EXECUTION MODEL: nothing in this migration (or the web app) sends messages.
-- The WhatsApp bridge is the executor: it polls claim_due_schedule_runs()
-- and then sends each pending delivery. The browser/Vercel only edit config
-- and read history.
--
-- IDEMPOTENCY:
--   * scheduled_message_runs is unique on (schedule_id, scheduled_for), the
--     exact UTC occurrence time, so an occurrence can only ever be claimed once.
--   * claim_due_schedule_runs() locks due schedules with FOR UPDATE SKIP
--     LOCKED, inserts the run, snapshots recipients into deliveries and
--     advances next_run_at in ONE transaction.
--   * scheduled_message_deliveries is unique on (run_id, recipient_jid).
--   * Occurrences more than grace_minutes (default 10) late are recorded as
--     'skipped_missed' and never sent.
--
-- Timezone: America/St_Lucia (UTC-4, no DST).

create extension if not exists pgcrypto;

-- ── Admin helper ─────────────────────────────────────────────────────────────
-- security definer so RLS policies can read profiles.role without needing a
-- profiles policy for it.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

grant execute on function public.is_admin() to authenticated;

-- ── Recipient groups (reusable internal lists, per business) ─────────────────
create table if not exists public.recipient_groups (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  name text not null check (char_length(trim(name)) > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_slug, name)
);

create table if not exists public.recipient_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.recipient_groups(id) on delete cascade,
  jid text not null check (char_length(trim(jid)) > 0),
  display_name text,
  kind text not null default 'contact' check (kind in ('contact', 'group')),
  created_at timestamptz not null default now(),
  unique (group_id, jid)
);

create index if not exists recipient_group_members_group_idx
  on public.recipient_group_members (group_id);

-- ── Schedules ────────────────────────────────────────────────────────────────
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  name text not null check (char_length(trim(name)) > 0),
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 4096),
  enabled boolean not null default true,
  -- Direct recipients: [{ "jid": "...", "name": "...", "kind": "contact"|"group" }]
  recipients jsonb not null default '[]'::jsonb check (jsonb_typeof(recipients) = 'array'),
  -- Reusable internal groups, expanded to members at claim time.
  recipient_group_ids uuid[] not null default '{}',
  recurrence_type text not null check (recurrence_type in ('daily', 'weekdays', 'weekly')),
  -- 0 = Sunday … 6 = Saturday. Only used when recurrence_type = 'weekly'.
  days_of_week integer[] not null default '{}',
  time_of_day time not null,
  timezone text not null default 'America/St_Lucia',
  grace_minutes integer not null default 10 check (grace_minutes between 0 and 1440),
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_messages_weekly_days check (
    recurrence_type <> 'weekly'
    or (cardinality(days_of_week) > 0 and days_of_week <@ array[0, 1, 2, 3, 4, 5, 6])
  )
);

create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (next_run_at) where enabled;
create index if not exists scheduled_messages_business_idx
  on public.scheduled_messages (business_slug);

-- ── Runs: one row per occurrence (the idempotency key) ───────────────────────
create table if not exists public.scheduled_message_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.scheduled_messages(id) on delete cascade,
  scheduled_for timestamptz not null,
  -- pending → running → completed | partial | failed (set by the bridge)
  -- skipped_missed / skipped_no_recipients are set at claim time.
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'partial', 'failed',
                      'skipped_missed', 'skipped_no_recipients')),
  trigger_type text not null default 'scheduled' check (trigger_type in ('scheduled', 'test')),
  -- Body snapshotted when the run is created. The bridge sends THIS, never
  -- scheduled_messages.body, so editing a schedule only affects future runs.
  message_body text not null,
  claimed_by text,
  claimed_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  constraint scheduled_message_runs_occurrence_uniq unique (schedule_id, scheduled_for)
);

create index if not exists scheduled_message_runs_schedule_idx
  on public.scheduled_message_runs (schedule_id, scheduled_for desc);
create index if not exists scheduled_message_runs_status_idx
  on public.scheduled_message_runs (status) where status in ('pending', 'running');

-- ── Deliveries: one row per recipient per run (snapshotted at claim) ─────────
create table if not exists public.scheduled_message_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.scheduled_message_runs(id) on delete cascade,
  recipient_jid text not null,
  recipient_name text,
  recipient_kind text not null default 'contact' check (recipient_kind in ('contact', 'group')),
  -- 'sending' rows left stale by a crash should be marked 'unknown' (never
  -- auto-retried) by the executor: at-most-once, no double sends.
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'unknown')),
  whatsapp_message_id text,
  error text,
  attempted_at timestamptz,
  sent_at timestamptz,
  constraint scheduled_message_deliveries_recipient_uniq unique (run_id, recipient_jid)
);

create index if not exists scheduled_message_deliveries_run_idx
  on public.scheduled_message_deliveries (run_id);
create index if not exists scheduled_message_deliveries_pending_idx
  on public.scheduled_message_deliveries (status) where status in ('pending', 'sending');

-- ── compute_next_run ─────────────────────────────────────────────────────────
-- First occurrence strictly after p_after, evaluated in p_tz wall-clock time.
create or replace function public.compute_next_run(
  p_recurrence text,
  p_days integer[],
  p_time time,
  p_tz text,
  p_after timestamptz
)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_local_after timestamp := p_after at time zone p_tz;
  v_cand timestamp;
  v_dow integer;
  d integer;
begin
  for d in 0..7 loop
    v_cand := (v_local_after::date + d) + p_time;
    if v_cand > v_local_after then
      v_dow := extract(dow from v_cand)::integer;
      if p_recurrence = 'daily'
         or (p_recurrence = 'weekdays' and v_dow between 1 and 5)
         or (p_recurrence = 'weekly' and v_dow = any (p_days)) then
        return v_cand at time zone p_tz;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

grant execute on function public.compute_next_run(text, integer[], time, text, timestamptz)
  to authenticated, service_role;

-- ── Triggers: keep next_run_at / updated_at correct ──────────────────────────
-- next_run_at is recomputed ONLY when the schedule definition changes (or it
-- is enabled/created). claim_due_schedule_runs() advances it with a plain
-- UPDATE, which this trigger deliberately leaves alone.
create or replace function public.scheduled_messages_before_write()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.enabled then
    if tg_op = 'INSERT'
       or old.enabled is not true
       or old.recurrence_type is distinct from new.recurrence_type
       or old.days_of_week is distinct from new.days_of_week
       or old.time_of_day is distinct from new.time_of_day
       or old.timezone is distinct from new.timezone then
      new.next_run_at := public.compute_next_run(
        new.recurrence_type, new.days_of_week, new.time_of_day, new.timezone, now());
    end if;
  else
    new.next_run_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_scheduled_messages_before_write on public.scheduled_messages;
create trigger trg_scheduled_messages_before_write
  before insert or update on public.scheduled_messages
  for each row execute function public.scheduled_messages_before_write();

create or replace function public.touch_recipient_groups_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_recipient_groups_updated_at on public.recipient_groups;
create trigger trg_touch_recipient_groups_updated_at
  before update on public.recipient_groups
  for each row execute function public.touch_recipient_groups_updated_at();

-- ── claim_due_schedule_runs ──────────────────────────────────────────────────
-- Called by the bridge (service role only). For every enabled schedule whose
-- next_run_at has passed it, atomically: records each due occurrence as a run
-- (late ones as skipped_missed), snapshots recipients into deliveries for the
-- on-time one, and advances next_run_at. Returns only the runs it created.
-- Safe to call concurrently and repeatedly: SKIP LOCKED + the unique
-- (schedule_id, scheduled_for) key guarantee an occurrence is claimed once.
create or replace function public.claim_due_schedule_runs(
  p_limit integer default 20,
  p_worker text default null
)
returns table (
  out_run_id uuid,
  out_schedule_id uuid,
  out_business_slug text,
  out_scheduled_for timestamptz,
  out_status text,
  out_delivery_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.scheduled_messages%rowtype;
  v_due timestamptz;
  v_last timestamptz;
  v_status text;
  v_run_id uuid;
  v_count integer;
  v_iter integer;
begin
  for s in
    select sm.*
    from public.scheduled_messages sm
    where sm.enabled
      and sm.next_run_at is not null
      and sm.next_run_at <= now()
    order by sm.next_run_at
    limit greatest(p_limit, 1)
    for update skip locked
  loop
    v_due := s.next_run_at;
    v_last := null;
    v_iter := 0;

    -- Walk every occurrence that has come due (bounded; the rest is picked
    -- up on the next call).
    while v_due is not null and v_due <= now() and v_iter < 200 loop
      v_iter := v_iter + 1;
      v_last := v_due;
      v_status := case
        when now() - v_due > make_interval(mins => s.grace_minutes) then 'skipped_missed'
        else 'pending'
      end;

      v_run_id := null;
      insert into public.scheduled_message_runs
        (schedule_id, scheduled_for, status, trigger_type, message_body, claimed_by, finished_at)
      values
        (s.id, v_due, v_status, 'scheduled', s.body, p_worker,
         case when v_status = 'pending' then null else now() end)
      on conflict (schedule_id, scheduled_for) do nothing
      returning id into v_run_id;

      if v_run_id is not null then
        v_count := 0;
        if v_status = 'pending' then
          insert into public.scheduled_message_deliveries
            (run_id, recipient_jid, recipient_name, recipient_kind)
          select v_run_id, r.jid, r.name, r.kind
          from (
            select distinct on (x.jid) x.jid, x.name, x.kind
            from (
              select nullif(trim(e.value ->> 'jid'), '') as jid,
                     e.value ->> 'name' as name,
                     case when e.value ->> 'kind' = 'group' then 'group' else 'contact' end as kind,
                     1 as prio
              from jsonb_array_elements(s.recipients) as e(value)
              union all
              select m.jid, m.display_name, m.kind, 2
              from public.recipient_group_members m
              where m.group_id = any (s.recipient_group_ids)
            ) x
            where x.jid is not null
            order by x.jid, x.prio
          ) r;
          get diagnostics v_count = row_count;

          if v_count = 0 then
            v_status := 'skipped_no_recipients';
            update public.scheduled_message_runs
              set status = v_status, finished_at = now(), error = 'No recipients resolved'
              where id = v_run_id;
          end if;
        end if;

        out_run_id := v_run_id;
        out_schedule_id := s.id;
        out_business_slug := s.business_slug;
        out_scheduled_for := v_due;
        out_status := v_status;
        out_delivery_count := v_count;
        return next;
      end if;

      v_due := public.compute_next_run(
        s.recurrence_type, s.days_of_week, s.time_of_day, s.timezone, v_due);
    end loop;

    update public.scheduled_messages
      set next_run_at = v_due,
          last_run_at = coalesce(v_last, last_run_at)
      where id = s.id;
  end loop;
end;
$$;

revoke all on function public.claim_due_schedule_runs(integer, text) from public, anon, authenticated;
grant execute on function public.claim_due_schedule_runs(integer, text) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Any signed-in user can read everything (history is useful to staff);
-- only admins can write config. Runs/deliveries are written exclusively by the
-- bridge via the service role (which bypasses RLS) — no write policies here.
alter table public.recipient_groups enable row level security;
alter table public.recipient_group_members enable row level security;
alter table public.scheduled_messages enable row level security;
alter table public.scheduled_message_runs enable row level security;
alter table public.scheduled_message_deliveries enable row level security;

drop policy if exists "Authenticated can read recipient groups" on public.recipient_groups;
create policy "Authenticated can read recipient groups"
  on public.recipient_groups for select to authenticated using (true);
drop policy if exists "Admins can write recipient groups" on public.recipient_groups;
create policy "Admins can write recipient groups"
  on public.recipient_groups for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Authenticated can read recipient group members" on public.recipient_group_members;
create policy "Authenticated can read recipient group members"
  on public.recipient_group_members for select to authenticated using (true);
drop policy if exists "Admins can write recipient group members" on public.recipient_group_members;
create policy "Admins can write recipient group members"
  on public.recipient_group_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Authenticated can read scheduled messages" on public.scheduled_messages;
create policy "Authenticated can read scheduled messages"
  on public.scheduled_messages for select to authenticated using (true);
drop policy if exists "Admins can write scheduled messages" on public.scheduled_messages;
create policy "Admins can write scheduled messages"
  on public.scheduled_messages for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Authenticated can read scheduled runs" on public.scheduled_message_runs;
create policy "Authenticated can read scheduled runs"
  on public.scheduled_message_runs for select to authenticated using (true);

drop policy if exists "Authenticated can read scheduled deliveries" on public.scheduled_message_deliveries;
create policy "Authenticated can read scheduled deliveries"
  on public.scheduled_message_deliveries for select to authenticated using (true);

grant select, insert, update, delete on public.recipient_groups to authenticated;
grant select, insert, update, delete on public.recipient_group_members to authenticated;
grant select, insert, update, delete on public.scheduled_messages to authenticated;
grant select on public.scheduled_message_runs to authenticated;
grant select on public.scheduled_message_deliveries to authenticated;
grant all on public.recipient_groups, public.recipient_group_members, public.scheduled_messages,
  public.scheduled_message_runs, public.scheduled_message_deliveries to service_role;

-- ── Verification (optional, run after the migration) ─────────────────────────
-- Next weekday 4:30 PM St. Lucia time:
--   select compute_next_run('weekdays', '{}', '16:30', 'America/St_Lucia', now());
-- Tables exist:
--   select table_name from information_schema.tables
--   where table_schema = 'public' and table_name in
--     ('recipient_groups','recipient_group_members','scheduled_messages',
--      'scheduled_message_runs','scheduled_message_deliveries');
