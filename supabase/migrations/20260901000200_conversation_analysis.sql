-- AI conversation analysis (Phase 1): classification + summary, cached per
-- conversation. Run this in the Supabase SQL editor — the app has no DB
-- credentials beyond the authenticated user's own session, so this can't be
-- applied automatically.
--
-- A "conversation" isn't a real row anywhere in this schema — same as
-- conversation_reads/conversation_status, it's derived by grouping
-- whatsapp_messages by (business_slug, chat_id). This table caches one AI
-- analysis result per conversation, keyed the same way, so the dashboard
-- never has to re-run the model on page load — only an explicit "Analyze"
-- action (single conversation or a capped batch of new/stale ones) writes
-- here. Nothing in this migration or the app code that reads/writes it ever
-- touches whatsapp_messages, whatsapp_sessions, or sends anything back to
-- WhatsApp — read-only classification, per the Phase 1 scope.
--
-- customer_name/phone_display/contact_number are a point-in-time display
-- snapshot captured when the analysis ran (resolved the same way the inbox
-- itself resolves them — see lib/contactName.ts / lib/whatsapp.ts's
-- resolveConversationPhone), so the dashboard can render a full row without
-- re-querying/re-joining whatsapp_messages or customers on every load. Like
-- the rest of the row, it goes stale until the next (re-)analysis — that's
-- expected, not a bug.

create table if not exists conversation_analysis (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,

  category text not null check (category in (
    'Order placed',
    'Order inquiry',
    'Booking inquiry',
    'Payment',
    'Complaint/concern',
    'Follow-up needed',
    'General question',
    'Positive feedback',
    'Cancellation/change',
    'Other'
  )),
  summary text not null,
  extracted jsonb not null default '{}'::jsonb,
  urgency text not null default 'low' check (urgency in ('low', 'medium', 'high')),
  needs_action boolean not null default false,
  next_action text,
  confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  -- Display snapshot (see comment above) — not used for any lookup/join key.
  customer_name text,
  phone_display text,
  contact_number text,

  -- Staleness detection: a conversation whose current message_count/last
  -- message timestamp has moved past what's stored here has new messages
  -- since this analysis ran, and is what the dashboard's "Analyze new"
  -- bulk action targets. Manual re-analysis ignores this and always re-runs.
  message_count integer not null default 0,
  last_message_at timestamptz,

  model text,
  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,

  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (business_slug, chat_id)
);

create index if not exists conversation_analysis_business_category_idx
  on conversation_analysis (business_slug, category);

-- RLS: authenticated users only, same permissive "any staff member can do
-- anything" model as customers/conversation_status — this is shared inbox
-- tooling, not per-user data. Writes happen server-side (the /api/analysis
-- route, using the service-role key) rather than through these policies
-- directly, but they're included for completeness/future direct access and
-- to match this project's established RLS pattern for every shared table.
alter table conversation_analysis enable row level security;

drop policy if exists "Authenticated can read conversation analysis" on conversation_analysis;
create policy "Authenticated can read conversation analysis"
  on conversation_analysis for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert conversation analysis" on conversation_analysis;
create policy "Authenticated can insert conversation analysis"
  on conversation_analysis for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update conversation analysis" on conversation_analysis;
create policy "Authenticated can update conversation analysis"
  on conversation_analysis for update
  to authenticated
  using (true)
  with check (true);

-- Nothing in this migration touches whatsapp_messages/whatsapp_sessions.
-- No triggers, no auto-run — this table is only ever written by the
-- explicit /api/analysis/run action.
