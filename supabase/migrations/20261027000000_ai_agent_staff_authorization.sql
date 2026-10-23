-- AI agent: who may make the agent message a customer from the staff group,
-- and the bookkeeping that makes a failed staff answer safe to retry.
--
--   1. ai_agent_settings.staff_authorized_senders — the per-business allow-list
--      of VERIFIED WhatsApp identities (phone digits, or an exact "<digits>@lid"
--      JID) whose "!send" is honoured. Default: empty = nobody. Existing
--      businesses therefore stop sending customer messages from WhatsApp until
--      an admin adds their staff (the dashboard "Send to customer" button is
--      unaffected: it is authenticated by the admin session).
--   2. ai_agent_staff_answers — who sent the message (verified id), which draft
--      a "send" approved (so a retry can never pick a different draft), and how
--      often a failed answer was retried.
--
-- Nothing here enables anything. Safe to re-run.

-- ── 1. Allow-list ────────────────────────────────────────────────────────────
alter table public.ai_agent_settings
  add column if not exists staff_authorized_senders text[] not null default '{}';

-- Every entry is phone digits (8-15) or an exact "<digits>@lid" id. A function, not a
-- regex over the joined array, so no single entry can smuggle in a separator.
create or replace function public.ai_agent_valid_senders(p_senders text[])
returns boolean
language sql
immutable
as $$
  select p_senders is not null
     and cardinality(p_senders) <= 50
     and not exists (select 1 from unnest(p_senders) e where e is null or e !~ '^([0-9]{8,15}|[0-9]+@lid)$');
$$;

alter table public.ai_agent_settings
  drop constraint if exists ai_agent_settings_staff_authorized_senders_check;
alter table public.ai_agent_settings
  add constraint ai_agent_settings_staff_authorized_senders_check
  check (public.ai_agent_valid_senders(staff_authorized_senders));

-- ── 2. Staff answers ─────────────────────────────────────────────────────────
-- sender_id: the verified identifier that identified the sender (never a display name).
-- sender_authorized: whether it was on the allow-list when the message arrived.
-- approves_answer_id: for a "send" that approved a stored draft, the answer that produced it.
--   Deliberately no foreign key: audit rows must not depend on purgeable data.
alter table public.ai_agent_staff_answers
  add column if not exists sender_id text,
  add column if not exists sender_authorized boolean not null default false,
  add column if not exists approves_answer_id uuid,
  add column if not exists retry_count integer not null default 0 check (retry_count >= 0),
  add column if not exists last_retry_at timestamptz;

-- The dashboard lists failed answers that need attention.
create index if not exists ai_agent_staff_answers_failed_idx
  on public.ai_agent_staff_answers (business_slug, created_at desc) where state = 'failed';

-- A failed answer is picked up by exactly one retry: the claim is a conditional
-- state change (failed -> processing) made in one statement.
create or replace function public.claim_ai_agent_staff_answer_retry(p_business_slug text, p_answer_id uuid)
returns setof public.ai_agent_staff_answers
language sql
security definer
set search_path = public
as $$
  update public.ai_agent_staff_answers
     set state = 'processing', retry_count = retry_count + 1, last_retry_at = now(), error = null
   where id = p_answer_id and business_slug = p_business_slug and state = 'failed'
  returning *;
$$;

revoke all on function public.claim_ai_agent_staff_answer_retry(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_staff_answer_retry(text, uuid) to service_role;
