-- AI agent: Google Docs sync becomes APPEND-ONLY at the top of the document (no document reads on the normal path).
-- Run this in the Supabase SQL editor AFTER 20261112000000 (already applied in production). Not applied automatically.
--
-- Additive and idempotent (safe to run twice). It changes no order, customer, message or existing line row, and it does not
-- switch anything on: sync stays DISABLED until someone turns it on in the dashboard.
--
-- Why: the app now only ever inserts one new line at the very start of the document's first tab. To make that safe against
-- retries, concurrent runs and a crash between "Google accepted the write" and "we recorded it", every order's line row is
-- claimed BEFORE the write (state 'inserting', one attempt id), finished after it ('synced'), and any attempt whose outcome is
-- unknown stays 'inserting' / 'unconfirmed' until the order's small tag is found (or not) in the document, or staff decide.
--
--   state 'inserting'    an insert was started; Google may or may not have applied it (crash window)
--   state 'unconfirmed'  the outcome is unknown and could not be verified yet; shown to staff, never guessed
--   state 'skipped'      staff chose not to put this order in the document
--   claim_gdoc_line()    atomic "start an attempt for this order": succeeds for a new order or one whose last attempt
--                        definitely failed; refuses everything else, so two runners can never both write the same order.
--
-- The older states (conflict, pending_review, missing) stay allowed so existing rows remain valid; the app no longer creates
-- them. The columns/settings for section markers and completed/cancelled/corrected handling are kept but no longer used.
--
-- DEPENDS ON: 20261112000000 (ai_agent_gdoc_lines, ai_agent_gdoc_settings).

alter table public.ai_agent_gdoc_lines
  add column if not exists attempt_id uuid,
  add column if not exists attempt_started_at timestamptz,
  add column if not exists verify_attempts integer not null default 0,
  add column if not exists last_verify_at timestamptz;

alter table public.ai_agent_gdoc_lines drop constraint if exists ai_agent_gdoc_lines_state_check;
alter table public.ai_agent_gdoc_lines
  add constraint ai_agent_gdoc_lines_state_check
  check (state in ('synced', 'pending_review', 'conflict', 'missing', 'failed', 'inserting', 'unconfirmed', 'skipped'));

create index if not exists ai_agent_gdoc_lines_inflight_idx
  on public.ai_agent_gdoc_lines (business_slug, document_id)
  where state in ('inserting', 'unconfirmed', 'failed');

-- True when this caller now owns the (single) insert attempt for the order. A row is only (re)claimed from 'failed', i.e. when
-- the previous attempt is known not to have reached the document.
create or replace function public.claim_gdoc_line(p_business_slug text, p_document_id text, p_order_id uuid, p_tag text, p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.ai_agent_gdoc_lines as l (business_slug, document_id, order_id, tag, state, attempt_id, attempt_started_at, attempts)
  values (p_business_slug, p_document_id, p_order_id, p_tag, 'inserting', p_attempt_id, now(), 1)
  on conflict (business_slug, document_id, order_id) do update
     set state = 'inserting',
         attempt_id = excluded.attempt_id,
         attempt_started_at = now(),
         attempts = l.attempts + 1,
         last_error = null
   where l.state = 'failed';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.claim_gdoc_line(text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_gdoc_line(text, text, uuid, text, uuid) to service_role;

-- Verification (optional):
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_agent_gdoc_lines_state_check';
--   select count(*) from public.ai_agent_gdoc_lines;     -- Expected: 0 in production today
