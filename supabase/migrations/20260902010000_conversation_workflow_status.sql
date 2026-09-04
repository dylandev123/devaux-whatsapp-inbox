-- Manual "Done" workflow status for every analyzed conversation. Run this
-- in the Supabase SQL editor — the app has no DB credentials beyond the
-- authenticated user's own session, so this can't be applied automatically.
--
-- Deliberately a new, separate column rather than folded into order_status:
-- order_status (supabase/migrations/20260901000500_order_status.sql) only
-- ever exists for "Order placed" rows and tracks a 3-step order-entry
-- pipeline (Needs adding -> Added -> Completed); workflow_status applies to
-- every analyzed conversation regardless of category, and is a plain
-- 2-state toggle (Active/Done) that drives the dashboard's Active/Done
-- filter. The two are kept in sync by the app, not the database: marking
-- an order "delivered" via the Orders queue's quick tick-off sets both
-- order_status='Completed' and workflow_status='Done' in the same request
-- (see markOrderDelivered() in lib/analysis.ts) — so for orders there is
-- still only one staff action, not two, even though there are two columns.
--
-- "Automatically surface again" (a Done conversation gets new messages) is
-- deliberately NOT a trigger on whatsapp_messages — this table has no
-- triggers by design (see conversation_analysis's own migration comment:
-- "no auto-run"). Instead the app compares each Done row's already-stored
-- last_message_at against the conversation's current last message next
-- time the dashboard loads, and flips workflow_status back to 'Active' via
-- a normal update if it's behind — reusing last_message_at rather than
-- adding yet another column for "has new messages since Done".

alter table conversation_analysis
  add column if not exists workflow_status text not null default 'Active'
  check (workflow_status in ('Active', 'Done'));

-- Backfill: an order already sitting at order_status='Completed' before
-- this migration already meant "delivered/finished" in every practical
-- sense — start it Done here too, so running this migration doesn't
-- silently dump a pile of already-finished orders back into the active
-- queue.
update conversation_analysis
set workflow_status = 'Done'
where order_status = 'Completed';

create index if not exists conversation_analysis_workflow_status_idx
  on conversation_analysis (business_slug, workflow_status);

-- No RLS changes needed — covered by conversation_analysis's existing
-- "authenticated can update" policy from
-- 20260901000200_conversation_analysis.sql, same as order_status.
