# Escalation updates and per-customer AI modes

Migration: `supabase/migrations/20261028000000_ai_agent_customer_modes_escalation_updates.sql`
(apply after 20261024–20261027, before deploying the matching app code; additive, idempotent).
No bridge change: updates are ordinary `staff_notice` outbox items, claimed and acked exactly like the first notice.

## Escalation updates

One open escalation per unresolved issue keeps a structured picture of the request (items, quantities,
address, delivery, the customer's own questions, a cancellation flag) in `ai_agent_escalations.context`.
`notified_snapshot` / `notified_seq` record what staff were last told.

On every customer turn that reaches an escalation (`notifyStaff` in `lib/server/aiAgent/decide.ts`):

| State of the escalation's notices | Result |
| --- | --- |
| none, or only ones that provably never reached WhatsApp | the **first notice**, complete |
| delivered, in flight, or possibly delivered | an **update** if `diffSnapshots(notified_snapshot, current)` is non-empty, else nothing |

Thank-yous, acknowledgements, repeats and duplicate deliveries change nothing. Notice + snapshot are written
together by `post_ai_agent_escalation_notice` (row lock, compare-and-swap on `notified_seq`), so concurrent
workers, redelivered batches and restarts cannot double-post or drop a change.

An escalation staff answered (not closed) within 24 h is **reopened** when the customer changes the order
(add / remove / quantity / address / delivery / cancel); the update is flagged "AFTER staff replied". A new
question or a closed escalation starts a new reference. A cancellation bypasses the batching quiet period
when staff are already working on that customer.

## Customer modes

`ai_agent_conversations.customer_mode` (null = business default) and `ai_agent_settings.default_customer_mode`
(default `staff_first`). Nobody is switched to Auto-Reply except by an explicit admin action.

| Mode | Behaviour |
| --- | --- |
| `auto_reply` | existing engine: answers from approved knowledge, escalates the rest; stops while an escalation is open |
| `staff_first` | replies the AI would have sent become escalations carrying the reply as a draft; no customer-bound AI message (no holding reply either) |
| `manual_only` | no model call, no reply, no escalation |

Order of precedence: kill switch → Observe → contact scope / allow-list → human takeover → customer mode.
`!send` / dashboard sends do not depend on the customer's mode; they go through `planCustomerSend` as before.
