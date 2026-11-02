-- AI agent: Google Docs order synchronization (an EXISTING staff-maintained Google Doc).
-- Run this in the Supabase SQL editor BEFORE relying on the matching app code. Not applied automatically.
--
-- Additive and idempotent (safe to run twice). Nothing here reads or changes an order, customer or message row, and
-- nothing switches the feature on: every business starts with sync DISABLED and no Google account connected.
-- The app works without this file: the dashboard shows "setup pending" and no order write ever touches a document.
--
--   ai_agent_google_connections   one per business: the connected Google account and its OAuth refresh token, ENCRYPTED by
--                                 the app (AES-256-GCM, key in GOOGLE_TOKEN_ENCRYPTION_KEY, bound to the business slug).
--                                 No dashboard role can read this table (service role only), so a token never reaches a browser.
--   ai_agent_gdoc_settings        one per business: the document, line format, insertion position, handling of completed /
--                                 cancelled / corrected orders, and the sync lease. enabled defaults to false.
--   ai_agent_gdoc_lines           one per (business, document, order): the stable line tag, the exact text the app last wrote
--                                 (used to detect a staff edit before anything is rewritten), and its state.
--   claim_gdoc_sync() / release_gdoc_sync()
--                                 a time-limited lease so two overlapping runs (cron + a message + a button) never write
--                                 to the same document at once.
--
-- DEPENDS ON: 20261022000000 (ai_agent: touch_ai_agent_updated_at, is_admin), 20261101000000 (ai_agent_orders).

-- ── 1. Google connection (secrets: service role only) ────────────────────────
create table if not exists public.ai_agent_google_connections (
  business_slug text primary key,
  account_email text not null,
  -- "v1.<iv>.<tag>.<ciphertext>" (base64url). Never logged, never returned by an API.
  refresh_token_enc text not null,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'revoked', 'error')),
  last_error text,
  connected_by text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_touch_ai_agent_google_connections on public.ai_agent_google_connections;
create trigger trg_touch_ai_agent_google_connections before update on public.ai_agent_google_connections
  for each row execute function public.touch_ai_agent_updated_at();

alter table public.ai_agent_google_connections enable row level security;
revoke all on public.ai_agent_google_connections from anon, authenticated;
grant all on public.ai_agent_google_connections to service_role;

-- ── 2. Per-business document settings ────────────────────────────────────────
create table if not exists public.ai_agent_gdoc_settings (
  business_slug text primary key,
  enabled boolean not null default false,
  document_id text,
  document_title text,
  -- The connected account may edit this document (checked from Google when the link is saved and when sync is enabled).
  can_edit boolean not null default false,
  access_verified_at timestamptz,
  -- Line format: { fields: [{ key, enabled }], separator, placeholders } — validated by the app (lib/aiAgent/gdocFormat.ts).
  format jsonb not null default '{}'::jsonb,
  -- Where the AI-managed section goes the FIRST time: { kind: top | end | after_text, text? }.
  insertion jsonb not null default '{"kind":"top"}'::jsonb,
  on_completed text not null default 'mark' check (on_completed in ('leave', 'mark', 'remove')),
  on_cancelled text not null default 'mark' check (on_cancelled in ('leave', 'mark', 'remove')),
  on_corrected text not null default 'update' check (on_corrected in ('update', 'review')),
  -- Orders that still miss details (shown with a visible marker) are listed too; turn off to list complete orders only.
  include_incomplete boolean not null default true,
  -- Only orders created after this moment sync automatically (older ones need the one-time, explicit import).
  sync_since timestamptz,
  section_created_at timestamptz,
  last_sync_at timestamptz,
  last_attempt_at timestamptz,
  -- ok | needs_reconnect | no_access | doc_not_found | section_problem | error
  health text not null default 'ok',
  last_error text,
  lock_token text,
  lock_until timestamptz,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_touch_ai_agent_gdoc_settings on public.ai_agent_gdoc_settings;
create trigger trg_touch_ai_agent_gdoc_settings before update on public.ai_agent_gdoc_settings
  for each row execute function public.touch_ai_agent_updated_at();

alter table public.ai_agent_gdoc_settings enable row level security;
drop policy if exists "Admins can read ai_agent_gdoc_settings" on public.ai_agent_gdoc_settings;
create policy "Admins can read ai_agent_gdoc_settings" on public.ai_agent_gdoc_settings
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_gdoc_settings from anon;
grant select on public.ai_agent_gdoc_settings to authenticated;
grant all on public.ai_agent_gdoc_settings to service_role;

-- ── 3. One row per synced order line ─────────────────────────────────────────
create table if not exists public.ai_agent_gdoc_lines (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  document_id text not null,
  order_id uuid not null references public.ai_agent_orders (id) on delete cascade,
  -- The stable id written at the end of the line, e.g. "E-7K2QX" (the order's ref code).
  tag text not null,
  -- synced | pending_review | conflict | missing | failed
  state text not null default 'failed' check (state in ('synced', 'pending_review', 'conflict', 'missing', 'failed')),
  -- The exact line text (without the tag) the app last wrote, and the order version / status it reflected.
  last_text text,
  synced_version integer,
  synced_status text,
  -- What the app wants to write but has not (a conflict or a held correction), and why.
  pending_text text,
  pending_action text check (pending_action is null or pending_action in ('update', 'mark', 'remove', 'insert')),
  pending_reason text,
  -- What the document held when a conflict was found (so staff can compare).
  found_text text,
  attempts integer not null default 0,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ai_agent_gdoc_lines_order_idx on public.ai_agent_gdoc_lines (business_slug, document_id, order_id);
create unique index if not exists ai_agent_gdoc_lines_tag_idx on public.ai_agent_gdoc_lines (business_slug, document_id, tag);
create index if not exists ai_agent_gdoc_lines_state_idx on public.ai_agent_gdoc_lines (business_slug, state);

drop trigger if exists trg_touch_ai_agent_gdoc_lines on public.ai_agent_gdoc_lines;
create trigger trg_touch_ai_agent_gdoc_lines before update on public.ai_agent_gdoc_lines
  for each row execute function public.touch_ai_agent_updated_at();

alter table public.ai_agent_gdoc_lines enable row level security;
drop policy if exists "Admins can read ai_agent_gdoc_lines" on public.ai_agent_gdoc_lines;
create policy "Admins can read ai_agent_gdoc_lines" on public.ai_agent_gdoc_lines
  for select to authenticated using (public.is_admin());
revoke all on public.ai_agent_gdoc_lines from anon;
grant select on public.ai_agent_gdoc_lines to authenticated;
grant all on public.ai_agent_gdoc_lines to service_role;

-- ── 4. Sync lease ────────────────────────────────────────────────────────────
-- True when this caller now holds the lease (nobody had it, or it had expired). The lease is time-limited so a crashed
-- run never blocks the next one for long.
create or replace function public.claim_gdoc_sync(p_business_slug text, p_token text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.ai_agent_gdoc_settings
     set lock_token = p_token,
         lock_until = now() + make_interval(secs => greatest(p_ttl_seconds, 5)),
         last_attempt_at = now()
   where business_slug = p_business_slug
     and (lock_until is null or lock_until < now() or lock_token = p_token);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.release_gdoc_sync(p_business_slug text, p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_agent_gdoc_settings
     set lock_token = null, lock_until = null
   where business_slug = p_business_slug and lock_token = p_token;
$$;

revoke all on function public.claim_gdoc_sync(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_gdoc_sync(text, text) from public, anon, authenticated;
grant execute on function public.claim_gdoc_sync(text, text, integer) to service_role;
grant execute on function public.release_gdoc_sync(text, text) to service_role;

-- Verification (optional):
--   select count(*) from public.ai_agent_gdoc_settings;                       -- Expected: 0 (no business has it configured)
--   select count(*) from public.ai_agent_google_connections;                  -- Expected: 0
