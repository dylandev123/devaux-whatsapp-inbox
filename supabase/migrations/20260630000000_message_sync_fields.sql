-- Message sync/dedupe fields, for full bidirectional WhatsApp sync.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.
-- Depends on every prior migration in this project having already been run.
--
-- IMPORTANT: this app has no access to the external WhatsApp bridge service
-- (WHATSAPP_API_URL) that actually writes rows into whatsapp_messages — that
-- backend lives outside this repo. Adding these columns here only makes them
-- available to be populated; it does not make the bridge populate them.
-- whatsapp_message_id, business_account_id, sender_phone, and recipient_phone
-- will stay null on every row (existing and new) until/unless the bridge is
-- updated to send them. Same situation as business_contact_name in
-- 20260623000900_contact_phone_improvements.sql.

-- `direction` already exists in production (every existing query in this app
-- reads it) — this is a no-op guard, not a new column, kept here only so a
-- fresh database created from these migrations alone ends up with the same
-- shape as the live one.
alter table whatsapp_messages add column if not exists direction text;

alter table whatsapp_messages add column if not exists sender_phone text;
alter table whatsapp_messages add column if not exists recipient_phone text;
alter table whatsapp_messages add column if not exists contact_phone text;
alter table whatsapp_messages add column if not exists whatsapp_message_id text;
alter table whatsapp_messages add column if not exists business_account_id text;
alter table whatsapp_messages add column if not exists synced_at timestamptz;

-- Backfill what's derivable from existing columns. sender_phone/recipient_phone
-- are inferred from direction + contact_number — best-effort, since contact_number
-- already represents "the customer in this conversation" regardless of direction
-- (see the upsert_customer_from_message comment in the prior migration).
update whatsapp_messages
  set contact_phone = contact_number
  where contact_phone is null and contact_number is not null;

update whatsapp_messages
  set sender_phone = case when lower(coalesce(direction, '')) like '%out%' then null else contact_number end,
      recipient_phone = case when lower(coalesce(direction, '')) like '%out%' then contact_number else null end
  where sender_phone is null and recipient_phone is null and contact_number is not null;

update whatsapp_messages
  set business_account_id = business_slug
  where business_account_id is null;

update whatsapp_messages
  set synced_at = coalesce(synced_at, created_at, timestamp, now())
  where synced_at is null;

-- Dedupe key for whenever the bridge starts sending whatsapp_message_id:
-- guards against the same WhatsApp message being inserted twice for the same
-- business (e.g. a retried webhook/poll). Partial index — most existing rows
-- have no whatsapp_message_id yet and must stay insertable without one.
create unique index if not exists whatsapp_messages_dedupe_idx
  on whatsapp_messages (business_slug, whatsapp_message_id)
  where whatsapp_message_id is not null;

-- No RLS changes needed — same as business_contact_name before it, these are
-- new columns on a table that already has RLS policies covering every column.
