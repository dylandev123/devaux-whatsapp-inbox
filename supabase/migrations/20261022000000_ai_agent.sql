-- Assisted AI WhatsApp Agent (pilot: Dog Food St. Lucia only).
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.
--
-- DEPENDS ON (must already be applied):
--   * 20260623000800_admin_roles.sql        (profiles)
--   * 20261007000000_scheduled_messages.sql (public.is_admin())
--   * 20260901000400_customer_ai_profile.sql, 20261008000000_customer_orders.sql
--     (read by the agent for customer memory; not altered here)
--
-- Purely additive: new tables/functions only. Nothing existing is altered, so
-- the inbox, analysis engine and bridge keep working unchanged.
--
-- EXECUTION MODEL (same split as scheduled messages): the web app owns every
-- AI decision (lib/server/aiAgent/*). The WhatsApp bridge ("WhatsappOperation")
-- never decides anything — it forwards messages to POST /api/bridge/ai-agent/message
-- and sends exactly the outbox items it is handed. Full contract:
-- docs/ai-agent-bridge-contract.md.
--
-- SAFETY DEFAULTS:
--   * Only a dog_food settings row is seeded, enabled = false, mode = observe,
--     contact_scope = none. Nothing replies until an admin turns it on.
--   * ai_agent_settings_pilot_only: enabled can only be true for dog_food.
--     Extending the pilot is a deliberate migration, not a UI click.
--
-- RETENTION: deliberately NO foreign keys to whatsapp_messages, customers,
-- conversation_analysis or customer_orders — the 7-day message purge can never
-- cascade into agent memory, escalations or the audit trail. Event/escalation
-- rows keep a short message excerpt for audit.
--
-- RLS: every table here is admin-read-only through RLS; ALL writes go through
-- the app's server routes with the service role (admin routes are gated by
-- middleware.ts + requireAdmin(); bridge routes by AI_AGENT_BRIDGE_SECRET).

create extension if not exists pgcrypto;

-- ── Settings (one row per business) ──────────────────────────────────────────
create table if not exists public.ai_agent_settings (
  business_slug text primary key,
  enabled boolean not null default false,
  mode text not null default 'observe' check (mode in ('observe', 'assisted')),
  contact_scope text not null default 'none' check (contact_scope in ('none', 'all', 'selected')),
  autonomy integer not null default 30 check (autonomy between 0 and 100),
  staff_group_jid text check (staff_group_jid is null or staff_group_jid like '%@g.us'),
  staff_group_name text,
  -- A manual staff message in a chat pauses the agent there for this long.
  auto_takeover_minutes integer not null default 120 check (auto_takeover_minutes between 0 and 10080),
  max_auto_replies_per_hour integer not null default 6 check (max_auto_replies_per_hour between 0 and 60),
  send_holding_reply boolean not null default true,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_settings_pilot_only check (not enabled or business_slug = 'dog_food')
);

insert into public.ai_agent_settings (business_slug) values ('dog_food')
on conflict (business_slug) do nothing;

-- ── Contact rules (selected allow-list + exclusions) ─────────────────────────
-- contact_scope = 'selected' → only 'allow' rows may get AI replies.
-- contact_scope = 'all'      → everyone except 'exclude' rows.
create table if not exists public.ai_agent_contact_rules (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  display_name text,
  rule text not null check (rule in ('allow', 'exclude')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (business_slug, chat_id)
);

-- ── Business knowledge (the ONLY source of facts the agent may state) ───────
create table if not exists public.ai_agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  kind text not null check (kind in ('product', 'price', 'policy', 'hours', 'delivery', 'faq', 'tone', 'other')),
  title text not null check (char_length(trim(title)) > 0),
  content text not null check (char_length(trim(content)) > 0 and char_length(content) <= 4000),
  -- Only 'approved' and unexpired entries are ever given to the model.
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  source text not null default 'admin' check (source in ('admin', 'staff_correction', 'import')),
  source_ref text,
  expires_at timestamptz,
  version integer not null default 1,
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_agent_knowledge_active_idx
  on public.ai_agent_knowledge (business_slug, status);

-- ── Per-conversation control state ───────────────────────────────────────────
create table if not exists public.ai_agent_conversations (
  business_slug text not null,
  chat_id text not null,
  contact_number text,
  control text not null default 'ai' check (control in ('ai', 'human')),
  -- null with control = 'human' means "until an admin resumes".
  human_until timestamptz,
  control_reason text,
  control_changed_by uuid,
  control_changed_at timestamptz,
  last_decision text,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_slug, chat_id)
);

-- ── Escalations ──────────────────────────────────────────────────────────────
create table if not exists public.ai_agent_escalations (
  id uuid primary key default gen_random_uuid(),
  -- Human-typeable reference used in the staff group ("#E-7K3Q").
  ref_code text not null unique check (ref_code ~ '^E-[A-Z0-9]{4,8}$'),
  business_slug text not null,
  chat_id text not null,
  contact_number text,
  customer_name text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'notified', 'answered', 'resolved', 'cancelled')),
  reason text not null,
  reason_codes text[] not null default '{}',
  customer_message text,
  ai_summary text,
  proposed_reply text,
  context jsonb not null default '{}'::jsonb,
  -- WhatsApp id of the notice posted in the staff group; quoted replies to it
  -- are matched exactly. Unique so a quote can never match two escalations.
  notice_message_id text unique,
  staff_answer text,
  answered_by text,
  answered_via text check (answered_via is null or answered_via in ('whatsapp', 'admin_ui')),
  answered_at timestamptz,
  resolved_at timestamptz,
  source_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_agent_escalations_open_idx
  on public.ai_agent_escalations (business_slug, status, created_at desc);
create index if not exists ai_agent_escalations_chat_idx
  on public.ai_agent_escalations (business_slug, chat_id, created_at desc);

-- At most one unanswered escalation per conversation: further customer
-- messages are appended to it (and staff get a follow-up notice) instead of
-- opening a second one. Backstops concurrent inbound messages.
create unique index if not exists ai_agent_escalations_one_open_idx
  on public.ai_agent_escalations (business_slug, chat_id)
  where status in ('open', 'notified');

-- ── Order requests (collected, NEVER confirmed by the agent) ─────────────────
-- Kept separate from customer_orders on purpose: customer_orders' order_seq is
-- allocated by the analysis engine, and a second writer would race it. Staff
-- approve here; the analysis engine still records the real order from the
-- conversation as it does today.
create table if not exists public.ai_agent_order_requests (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  contact_number text,
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  delivery_address text,
  delivery_preference text,
  notes text,
  status text not null default 'collecting'
    check (status in ('collecting', 'pending_approval', 'approved', 'rejected', 'cancelled')),
  escalation_id uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one in-progress request per conversation.
create unique index if not exists ai_agent_order_requests_one_open_idx
  on public.ai_agent_order_requests (business_slug, chat_id)
  where status in ('collecting', 'pending_approval');

-- ── Events: one row per message the bridge forwards (idempotency key) ───────
create table if not exists public.ai_agent_events (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  whatsapp_message_id text not null,
  kind text not null check (kind in ('customer_inbound', 'staff_outbound', 'staff_group', 'ignored')),
  status text not null default 'processing' check (status in ('processing', 'done', 'error')),
  message_excerpt text,
  decision text check (decision is null or decision in ('REPLY', 'ASK', 'ESCALATE', 'NO_REPLY', 'HUMAN')),
  reason_codes text[] not null default '{}',
  confidence numeric(3, 2),
  proposed_reply text,
  mode text,
  autonomy integer,
  model text,
  knowledge_ids uuid[] not null default '{}',
  escalation_id uuid,
  error text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint ai_agent_events_message_uniq unique (business_slug, whatsapp_message_id)
);

create index if not exists ai_agent_events_recent_idx
  on public.ai_agent_events (business_slug, created_at desc);
create index if not exists ai_agent_events_chat_idx
  on public.ai_agent_events (business_slug, chat_id, created_at desc);

-- ── Outbox: everything the bridge is asked to send (at-most-once) ────────────
-- pending → dispatched (handed to the bridge) → sent | failed.
-- A 'dispatched' item is never handed out again, so a bridge crash between
-- send and ack can lose an ack but never double-send.
create table if not exists public.ai_agent_outbox (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  kind text not null check (kind in ('customer_reply', 'holding_reply', 'staff_notice', 'staff_relay', 'staff_feedback')),
  to_jid text not null,
  body text not null check (char_length(body) between 1 and 4096),
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'sent', 'failed')),
  event_id uuid,
  escalation_id uuid,
  -- Unique per logical send, e.g. "<event_id>:customer_reply".
  dedupe_key text not null unique,
  whatsapp_message_id text,
  error text,
  dispatched_at timestamptz,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_outbox_pending_idx
  on public.ai_agent_outbox (business_slug, created_at) where status = 'pending';
create index if not exists ai_agent_outbox_chat_idx
  on public.ai_agent_outbox (business_slug, chat_id, created_at desc);

-- ── Learning candidates (staff corrections awaiting admin approval) ─────────
create table if not exists public.ai_agent_learning_candidates (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  escalation_id uuid,
  question text,
  staff_answer text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  knowledge_id uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (escalation_id)
);

-- ── Audit log (append-only) ──────────────────────────────────────────────────
create table if not exists public.ai_agent_audit_log (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  actor_kind text not null check (actor_kind in ('admin', 'staff', 'bridge', 'system')),
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_audit_log_recent_idx
  on public.ai_agent_audit_log (business_slug, created_at desc);

-- ── updated_at triggers ──────────────────────────────────────────────────────
create or replace function public.touch_ai_agent_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ai_agent_settings', 'ai_agent_knowledge', 'ai_agent_conversations',
    'ai_agent_escalations', 'ai_agent_order_requests'
  ] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$s
         for each row execute function public.touch_ai_agent_updated_at()', t);
  end loop;
end $$;

-- ── claim_ai_agent_outbox ────────────────────────────────────────────────────
-- Bridge-only (service role). Atomically hands out pending outbox items and
-- marks them dispatched. SKIP LOCKED makes concurrent pollers safe.
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
      where p.status = 'pending'
        and (p_business_slug is null or p.business_slug = p_business_slug)
      order by p.created_at
      limit greatest(least(p_limit, 100), 1)
      for update skip locked
   )
  returning o.*;
end;
$$;

revoke all on function public.claim_ai_agent_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_outbox(text, integer) to service_role;

-- ── RLS: admins read; nobody writes except the service role ─────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'ai_agent_settings', 'ai_agent_contact_rules', 'ai_agent_knowledge',
    'ai_agent_conversations', 'ai_agent_escalations', 'ai_agent_order_requests',
    'ai_agent_events', 'ai_agent_outbox', 'ai_agent_learning_candidates',
    'ai_agent_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins can read %1$s" on public.%1$I', t);
    execute format(
      'create policy "Admins can read %1$s" on public.%1$I for select to authenticated using (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ── Verification (optional, run after the migration) ─────────────────────────
--   select business_slug, enabled, mode, contact_scope, autonomy from ai_agent_settings;
--   -- Expected: one row, dog_food, false, observe, none, 30
--   update ai_agent_settings set enabled = true where business_slug = 'by_sea';
--   -- Expected: 0 rows (no row) — and inserting an enabled non-dog_food row fails
--   -- the ai_agent_settings_pilot_only check.
