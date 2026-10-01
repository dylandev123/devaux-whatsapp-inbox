-- Read-only chat directory for the inbox's "Manage chats" view. Run this in
-- the Supabase SQL editor — the app has no DB credentials beyond the
-- authenticated user's own session, so this can't be applied automatically.
--
-- Why an RPC: the inbox itself only loads the last MESSAGE_HISTORY_WINDOW_DAYS
-- (7 days) of whatsapp_messages, so it only "knows" recently active chats.
-- Manage chats needs every 1:1/group chat a business has ever had, and
-- deriving that client-side would mean downloading the whole table. This
-- returns one summary row per chat_id instead, and is only called when the
-- Manage chats view is opened — it's never polled.
--
-- Visibility itself is NOT stored here: Manage chats reuses the existing
-- conversation_status.hidden flag (20260902000000_conversation_hidden.sql)
-- — On = not hidden, Off = hidden. No new table/column, no triggers, and
-- nothing in this migration writes to anything. whatsapp_messages is only
-- read; no messages are deleted or changed.
--
-- System chats (status@broadcast, broadcast lists, @newsletter channels) are
-- excluded, same rule as isSystemChatId() in lib/whatsapp.ts.
--
-- If this hasn't been run yet, the app falls back to listing only the chats
-- the inbox already has loaded (last 7 days) and says so in the UI.

create or replace function list_known_chats(p_business_slug text)
returns table (
  chat_id text,
  contact_name text,
  contact_number text,
  last_message_body text,
  last_direction text,
  last_message_at timestamptz,
  message_count bigint
)
language sql
security invoker
stable
as $$
  with chats as (
    select m.chat_id, max(m.timestamp) as last_message_at, count(*) as message_count
    from whatsapp_messages m
    where m.business_slug = p_business_slug
      and m.chat_id is not null
      and lower(m.chat_id) <> 'broadcast'
      and lower(m.chat_id) not like '%@broadcast'
      and lower(m.chat_id) not like '%@newsletter'
    group by m.chat_id
  ),
  latest as (
    select distinct on (m.chat_id) m.chat_id, m.contact_number, m.message_body, m.direction
    from whatsapp_messages m
    where m.business_slug = p_business_slug
    order by m.chat_id, m.timestamp desc nulls last
  ),
  -- Latest inbound push name per chat (for a group this is the most recent
  -- sender, same as the inbox list shows — groups have no stored subject).
  named as (
    select distinct on (m.chat_id) m.chat_id, m.contact_name
    from whatsapp_messages m
    where m.business_slug = p_business_slug
      and nullif(trim(m.contact_name), '') is not null
      and (m.direction is null or lower(m.direction) not like '%out%')
    order by m.chat_id, m.timestamp desc nulls last
  )
  select
    c.chat_id,
    n.contact_name,
    l.contact_number,
    l.message_body as last_message_body,
    l.direction as last_direction,
    c.last_message_at,
    c.message_count
  from chats c
  left join latest l on l.chat_id = c.chat_id
  left join named n on n.chat_id = c.chat_id
  order by c.last_message_at desc nulls last;
$$;

grant execute on function list_known_chats(text) to authenticated;

-- RLS: security invoker, so this relies on `authenticated` already being
-- able to SELECT whatsapp_messages — which the inbox itself already needs
-- (see 20260623000400_fix_unread_rpc.sql). No policy changes here.
