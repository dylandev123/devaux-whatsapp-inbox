-- Archive / Spam for conversations, without ever touching whatsapp_messages.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.
--
-- A "conversation" isn't a real row anywhere in this schema — it's derived
-- by grouping whatsapp_messages by (business_slug, chat_id). So, same
-- approach as conversation_reads: a side table keyed by that pair. Unlike
-- conversation_reads, this is NOT per-user — archiving a conversation hides
-- it for every staff member, not just the person who archived it — so there
-- is no user_id column here.
--
-- A conversation with no row here is implicitly "Active" (the app treats a
-- missing row as Active rather than requiring one row per conversation).

create table if not exists conversation_status (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  chat_id text not null,
  status text not null default 'Active' check (status in ('Active', 'Archived', 'Spam')),
  updated_at timestamptz not null default now(),
  unique (business_slug, chat_id)
);

create index if not exists conversation_status_lookup_idx on conversation_status (business_slug, chat_id);

create or replace function touch_conversation_status_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_conversation_status_updated_at on conversation_status;
create trigger trg_touch_conversation_status_updated_at
  before update on conversation_status
  for each row execute function touch_conversation_status_updated_at();

-- RLS: authenticated users only, same permissive "any staff member can do
-- anything" model as customers/customer_bookings — this is shared inbox
-- state, not per-user data.
alter table conversation_status enable row level security;

drop policy if exists "Authenticated can read conversation status" on conversation_status;
create policy "Authenticated can read conversation status"
  on conversation_status for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert conversation status" on conversation_status;
create policy "Authenticated can insert conversation status"
  on conversation_status for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update conversation status" on conversation_status;
create policy "Authenticated can update conversation status"
  on conversation_status for update
  to authenticated
  using (true)
  with check (true);

-- Nothing in this migration touches whatsapp_messages — archiving/marking
-- spam only ever writes to this new table. No messages are deleted.
