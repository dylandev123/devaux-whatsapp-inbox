-- Manual order-workflow tracking for the AI-detected order queue. Run this
-- in the Supabase SQL editor — the app has no DB credentials beyond the
-- authenticated user's own session, so this can't be applied automatically.
--
-- This is a workflow label staff manage by hand — "has someone actually
-- entered this into the real order system yet" — not something the AI ever
-- advances. The app (lib/server/analysisEngine.ts) only ever sets it once,
-- the first time a conversation's category becomes "Order placed" and no
-- status has been set yet; every later re-analysis explicitly preserves
-- whatever value is already there, even if the category changes. No auto
-- order creation happens anywhere — this only tracks staff's own manual
-- progress against an order the AI noticed.

alter table conversation_analysis
  add column if not exists order_status text
  check (order_status in ('Needs adding', 'Added', 'Completed'));

-- Backfill: any conversation already classified "Order placed" from a prior
-- analysis run (before this column existed) starts in the same default a
-- brand-new detection would get, so nothing already-detected is invisible
-- to the queue until someone happens to re-analyze it.
update conversation_analysis
set order_status = 'Needs adding'
where category = 'Order placed' and order_status is null;

-- No RLS changes needed — same as prior columns added to this table, this
-- is covered by conversation_analysis's existing "authenticated can update"
-- policy from supabase/migrations/20260901000200_conversation_analysis.sql,
-- which is how the Orders queue's status dropdown writes here directly from
-- the browser.
