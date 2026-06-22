-- Server-synced unread counts (per staff member, per conversation).
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- Not run automatically — same constraint as the customers migration: the app
-- has no DB credentials beyond the user's own auth session.

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

-- RLS: every staff member can only ever see/write their own read-state rows.
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

-- Upserts the caller's read marker for one conversation. `greatest()` means a
-- stale device re-marking an old timestamp can never roll the marker
-- backwards — important since this gets called from a 5s poll loop across
-- potentially multiple open tabs/devices for the same staff member.
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

-- Returns unread inbound-message counts per (business_slug, chat_id) for the
-- calling user. Excludes outbound/staff messages, status@broadcast (and any
-- other @broadcast chat), and group chats (@g.us) — groups are intentionally
-- skipped for now per the current requirements.
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
