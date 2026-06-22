-- Repair migration for the unread/read system.
--
-- Root cause investigated and confirmed directly against the live database:
-- `conversation_reads`, `mark_conversation_read`, and `conversation_unread_counts`
-- do not exist at all (verified via PostgREST: PGRST205 "Could not find the
-- table 'public.conversation_reads'" and PGRST202 for both RPCs). This is not
-- a bug in supabase/migrations/20260623000100_unread_counts.sql — that file's
-- SQL is correct, it was simply never run against this project. That's why
-- the app shows "failed to mark conversation read" / "failed to load unread
-- counts": every call 404s.
--
-- This migration is a complete, idempotent restatement of
-- 20260623000100_unread_counts.sql, so running this ONE file is enough to
-- fix it — you don't need to dig up the old one. Safe to run even if some
-- pieces already exist (everything uses create-if-not-exists / drop-if-exists).

create table if not exists conversation_reads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_slug text not null,
  chat_id text not null,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, business_slug, chat_id)
);

create index if not exists conversation_reads_user_idx on conversation_reads (user_id);
create index if not exists conversation_reads_lookup_idx
  on conversation_reads (business_slug, chat_id);

create or replace function touch_conversation_reads_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_conversation_reads_updated_at on conversation_reads;
create trigger trg_touch_conversation_reads_updated_at
  before update on conversation_reads
  for each row execute function touch_conversation_reads_updated_at();

alter table conversation_reads enable row level security;

drop policy if exists "Users can read their own conversation reads" on conversation_reads;
create policy "Users can read their own conversation reads"
  on conversation_reads for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert their own conversation reads" on conversation_reads;
create policy "Users can insert their own conversation reads"
  on conversation_reads for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their own conversation reads" on conversation_reads;
create policy "Users can update their own conversation reads"
  on conversation_reads for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function mark_conversation_read(
  p_business_slug text,
  p_chat_id text,
  p_last_read_at timestamptz
)
returns void
language plpgsql
security invoker
as $$
begin
  insert into conversation_reads (user_id, business_slug, chat_id, last_read_at)
  values (auth.uid(), p_business_slug, p_chat_id, p_last_read_at)
  on conflict (user_id, business_slug, chat_id) do update
    set last_read_at = greatest(conversation_reads.last_read_at, excluded.last_read_at),
        updated_at = now();
end;
$$;

grant execute on function mark_conversation_read(text, text, timestamptz) to authenticated;

create or replace function conversation_unread_counts()
returns table (business_slug text, chat_id text, unread_count bigint)
language sql
security invoker
stable
as $$
  select
    m.business_slug,
    m.chat_id,
    count(*) as unread_count
  from whatsapp_messages m
  left join conversation_reads r
    on r.user_id = auth.uid()
    and r.business_slug = m.business_slug
    and r.chat_id = m.chat_id
  where
    (m.direction is null or lower(m.direction) not like '%out%')
    and m.chat_id <> 'status@broadcast'
    and m.chat_id not like '%@broadcast'
    and m.chat_id not like '%@g.us'
    and m.timestamp > coalesce(r.last_read_at, 'epoch'::timestamptz)
  group by m.business_slug, m.chat_id;
$$;

grant execute on function conversation_unread_counts() to authenticated;

-- conversation_unread_counts() runs as SECURITY INVOKER (the caller's own
-- role), so it also depends on `authenticated` being able to SELECT from
-- whatsapp_messages. I can't verify your current policies on that table from
-- here (no DB admin access), so these are added defensively — if an
-- equivalent policy already exists under a different name, this just adds a
-- second permissive one, which is harmless (Postgres ORs multiple permissive
-- SELECT policies together).
drop policy if exists "Authenticated can read messages (unread repair)" on whatsapp_messages;
create policy "Authenticated can read messages (unread repair)"
  on whatsapp_messages for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can read sessions (unread repair)" on whatsapp_sessions;
create policy "Authenticated can read sessions (unread repair)"
  on whatsapp_sessions for select
  to authenticated
  using (true);

-- To confirm this worked: reload the inbox while logged in. The unread
-- badges should populate with no console errors about
-- "Could not find the function" or "Could not find the table".
