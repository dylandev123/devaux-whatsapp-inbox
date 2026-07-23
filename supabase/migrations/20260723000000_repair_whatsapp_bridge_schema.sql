-- Repair migration for the new shared Supabase project.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this cannot be applied automatically.
--
-- This migration is fully idempotent: every statement uses IF NOT EXISTS,
-- CREATE OR REPLACE, or an existence-check DO block, so it is safe to re-run
-- on a database where some or all of these objects already exist.
--
-- What this fixes and why:
--
--   1. Adds five sync columns (sender_phone, recipient_phone, contact_phone,
--      business_account_id, synced_at) that 20260630000000_message_sync_fields.sql
--      provides. That migration was written during a session that predates the
--      project move and has not been run on this project.
--
--   2. Recreates the deduplication index from the same migration.
--
--   3. Ensures upsert_customer_from_message() is the latest version (from
--      20260623000900_contact_phone_improvements.sql: phone normalisation +
--      processes both inbound and outbound). CREATE OR REPLACE is a no-op if
--      the function body is already identical.
--
--   4. (Re)creates trg_upsert_customer_from_message. This trigger may be
--      absent on this project: migration 20260622000000_customers.sql attempts
--      `drop trigger if exists ... on whatsapp_messages`, but PostgreSQL raises
--      "relation does not exist" if the table is not yet present at that moment.
--      The bridge creates whatsapp_messages on its own startup, so the order in
--      which the bridge was first connected versus when the migrations were run
--      determines whether the trigger was ever created. DROP + CREATE is the
--      only idempotent trigger pattern in PostgreSQL ≤ 16. The function is
--      upsert-based, so running it twice for the same message row is harmless.
--
--   5. Enables RLS on whatsapp_messages and whatsapp_sessions. The bridge
--      creates both tables without row-level security; no prior migration in
--      this repo enables it on them. Without RLS, all WhatsApp message content
--      is publicly readable via the Supabase REST API using only the anon key.
--      Each policy required by the existing app queries is checked for existence
--      BEFORE enabling RLS so that no frontend query loses access mid-migration.
--      The bridge uses a service-role key, which bypasses RLS regardless.
--      ASSUMPTION: if your bridge uses the anon key instead of the service-role
--      key to write to Supabase, enabling RLS here will block bridge INSERTs
--      (no INSERT policy exists for anon or authenticated). Verify the bridge
--      credential type before running this migration.

-- ── 1. Missing sync columns ───────────────────────────────────────────────────
-- Exact types from 20260630000000_message_sync_fields.sql.
-- whatsapp_message_id is intentionally absent: the bridge already provides that
-- column in its own table schema, so it exists and `add column if not exists`
-- would be a harmless no-op, but omitting it here keeps intent clear.

alter table public.whatsapp_messages add column if not exists sender_phone        text;
alter table public.whatsapp_messages add column if not exists recipient_phone     text;
alter table public.whatsapp_messages add column if not exists contact_phone       text;
alter table public.whatsapp_messages add column if not exists business_account_id text;
alter table public.whatsapp_messages add column if not exists synced_at           timestamptz;

-- ── 2. Deduplication index ────────────────────────────────────────────────────
-- Partial unique index: enforced only for rows where the bridge supplies a
-- whatsapp_message_id. Rows without one (all current rows on this project) are
-- unaffected and remain freely insertable.
create unique index if not exists whatsapp_messages_dedupe_idx
  on public.whatsapp_messages (business_slug, whatsapp_message_id)
  where whatsapp_message_id is not null;

-- ── 3. Latest upsert_customer_from_message() function ────────────────────────
-- Verbatim copy of the function body from
-- 20260623000900_contact_phone_improvements.sql (lines 77-101).
-- Changes vs the original version in 20260622000000_customers.sql:
--   • Calls normalize_phone_number() so formatting variants of the same number
--     never create duplicate customer rows.
--   • Removed the outbound-skip guard: business-initiated conversations also
--     create/update a customer record now.
create or replace function public.upsert_customer_from_message()
returns trigger as $$
declare
  normalized_number text;
begin
  if new.contact_number is null then
    return new;
  end if;

  normalized_number := normalize_phone_number(new.contact_number);
  if normalized_number = '' then
    return new;
  end if;

  insert into customers (phone_number, whatsapp_name, business_contact_name, last_message_at, source_business)
  values (normalized_number, new.contact_name, new.business_contact_name, new.timestamp, new.business_slug)
  on conflict (phone_number) do update
    set whatsapp_name         = coalesce(excluded.whatsapp_name,         customers.whatsapp_name),
        business_contact_name = coalesce(excluded.business_contact_name, customers.business_contact_name),
        last_message_at       = greatest(customers.last_message_at,       excluded.last_message_at),
        updated_at            = now();

  return new;
end;
$$ language plpgsql security definer;

-- ── 4. Customer upsert trigger on whatsapp_messages ──────────────────────────
-- DROP IF EXISTS is safe here: the trigger is stateless and the function it
-- calls is fully idempotent (upsert). Recreating it does not lose any data.
drop trigger if exists trg_upsert_customer_from_message on public.whatsapp_messages;

create trigger trg_upsert_customer_from_message
  after insert on public.whatsapp_messages
  for each row
  execute function public.upsert_customer_from_message();

-- ── 5. RLS on public.whatsapp_messages ───────────────────────────────────────
-- Policy check comes BEFORE `enable row level security` so that enabling RLS
-- does not momentarily black-hole message reads for logged-in users.
-- The policy named below was added by migration
-- 20260623000400_fix_unread_rpc.sql. This DO block is a no-op if it exists.

do $$
begin
  if not exists (
    select 1
    from   pg_policies
    where  schemaname = 'public'
      and  tablename  = 'whatsapp_messages'
      and  policyname = 'Authenticated can read messages (unread repair)'
  ) then
    create policy "Authenticated can read messages (unread repair)"
      on public.whatsapp_messages
      for select
      to authenticated
      using (true);
  end if;
end $$;

-- Idempotent: re-running on an already-RLS-enabled table is a no-op.
alter table public.whatsapp_messages enable row level security;

-- ── 6. RLS on public.whatsapp_sessions ───────────────────────────────────────
-- Same pattern as whatsapp_messages above.

do $$
begin
  if not exists (
    select 1
    from   pg_policies
    where  schemaname = 'public'
      and  tablename  = 'whatsapp_sessions'
      and  policyname = 'Authenticated can read sessions (unread repair)'
  ) then
    create policy "Authenticated can read sessions (unread repair)"
      on public.whatsapp_sessions
      for select
      to authenticated
      using (true);
  end if;
end $$;

alter table public.whatsapp_sessions enable row level security;

-- ── Validation queries (run separately after applying this migration) ─────────
--
-- 1. Confirm all five columns now exist:
--    select column_name, data_type
--    from   information_schema.columns
--    where  table_schema = 'public'
--      and  table_name   = 'whatsapp_messages'
--      and  column_name  in ('sender_phone','recipient_phone','contact_phone',
--                            'business_account_id','synced_at')
--    order by column_name;
--    -- Expected: 5 rows
--
-- 2. Confirm the dedup index exists:
--    select indexname, indexdef
--    from   pg_indexes
--    where  schemaname = 'public'
--      and  tablename  = 'whatsapp_messages'
--      and  indexname  = 'whatsapp_messages_dedupe_idx';
--    -- Expected: 1 row, partial WHERE clause visible in indexdef
--
-- 3. Confirm the trigger exists and is enabled:
--    select tgname, tgenabled
--    from   pg_trigger
--    where  tgrelid  = 'public.whatsapp_messages'::regclass
--      and  tgname   = 'trg_upsert_customer_from_message';
--    -- Expected: 1 row, tgenabled = 'O' (origin)
--
-- 4. Confirm RLS is enabled on both tables:
--    select relname, relrowsecurity
--    from   pg_class
--    where  relnamespace = 'public'::regnamespace
--      and  relname in ('whatsapp_messages','whatsapp_sessions');
--    -- Expected: 2 rows, relrowsecurity = true for both
--
-- 5. Confirm the SELECT policies exist:
--    select tablename, policyname, roles, cmd
--    from   pg_policies
--    where  schemaname = 'public'
--      and  tablename  in ('whatsapp_messages','whatsapp_sessions');
--    -- Expected: at least one SELECT policy for 'authenticated' on each table
--
-- 6. Confirm whatsapp_sessions is populated once the bridge is redirected:
--    select business_slug, status, updated_at
--    from   whatsapp_sessions
--    order  by updated_at desc;
--    -- Expected: rows appear within seconds of restarting the bridge with the
--    --           new SUPABASE_URL and service-role key
