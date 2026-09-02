-- Per-conversation Hide/Unhide, app-only. Never touches whatsapp_messages
-- or WhatsApp itself — hidden conversations and their messages stay exactly
-- where they are; this only controls whether the inbox shows them.
-- Run this in the Supabase SQL editor — the app has no DB credentials
-- beyond the authenticated user's own session, so this can't be applied
-- automatically.
--
-- Reuses conversation_status (supabase/migrations/20260623000700_conversation_status.sql)
-- rather than a new table: same side-table-keyed-by-(business_slug,chat_id)
-- pattern already used for Active/Archived/Spam, shared across all staff
-- (not per-user, same as status — hiding a chat hides it for the whole
-- team). A missing row, or hidden = false, means "not hidden". Deliberately
-- independent of the `status` column rather than folded into it: a hidden
-- conversation keeps whatever Active/Archived/Spam status it already had
-- (mirrors how "Unread" is already a filter layered on top of status
-- rather than a status value itself — see lib/conversationStatus.ts).

alter table conversation_status add column if not exists hidden boolean not null default false;

-- Partial index: only rows that are actually hidden are relevant to the
-- "Hidden" inbox filter's query.
create index if not exists conversation_status_hidden_idx
  on conversation_status (business_slug, hidden)
  where hidden = true;

-- No RLS changes needed: conversation_status already has SELECT/INSERT/UPDATE
-- policies for `authenticated` covering the whole row (see
-- 20260623000700_conversation_status.sql), so the new column is already
-- readable/writable through them.
