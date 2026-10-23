# AI evaluation (shadow answers)

Admin → AI Agent → **Evaluation**. Shows what the AI would have said **on its own** for customer turns that
staff actually handled, next to the staff answer, the staff-assisted draft and what was really delivered.
Shadow answers are never sent to customers or to the staff group.

## Two kinds of result, never mixed

| | Captured at the time (`historical`) | Simulation (`simulation`) |
|---|---|---|
| Made | During the live turn, from the model call the pipeline already made | Later, when an admin clicks **Simulate** on a past turn |
| Knowledge | Approved, unexpired entries at that moment | Today's approved entries (entries changed since the turn are flagged) |
| Conversation | What the model saw then | Only messages from *before* the turn |
| Live state | n/a | Open escalation, collected order and send rate are ignored (they describe today) |
| Extra model call | **No** | One (admin-triggered) |
| Label in UI / DB | "Captured at the time", `uses_current_knowledge = false` | "Simulation (current knowledge)", `uses_current_knowledge = true` |

A DB `CHECK` ties `kind` to `uses_current_knowledge`, so a simulation cannot be stored as a historical result.
Staff answers, later knowledge edits and expired stock facts never alter a historical row: it is written once.

## What is captured (only when the business switches it on)

`ai_agent_settings.shadow_capture_enabled` defaults to **false** everywhere. When on, a turn is stored if the AI
does **not** answer the customer itself: Observe mode, or a customer in Staff First / Manual Only.
Not stored (and no extra call, since capture reuses the live call): turns the AI answers directly
(Assisted + Auto-Reply), acknowledgements, prompt-injection attempts, gate-blocked turns, follow-ups on an open
escalation (the model is told not to answer there), duplicate deliveries and batch retries (one row per turn:
`hist:<event id>`).

Each row records: customer question (≤1000 chars), the engine's independent decision, reply / draft reply,
confidence vs. required, reason codes and the model's escalation reason, request category, model, timestamp,
cited knowledge ids, a knowledge version fingerprint + entry count, whether memory was included, and token usage
(API-reported when available, otherwise estimated at ~4 characters/token and marked "(estimated)").
The staff answer, assisted draft and delivery states are joined at read time from the escalation, staff answers
and outbox; they are never copied into the shadow row.

## Simulation guards (all before any model call)

Already has a historical result → returned as is. Same turn and unchanged knowledge → returned from the earlier
simulation. Acknowledgements, injection attempts, media-only/purged text, contacts the agent may not engage with
(`contact_excluded`, `contact_not_permitted`, unresolved `@lid`), other businesses' events, non-customer events and
more than 30 simulations per business per hour are refused. A simulation writes only `ai_agent_shadow_results` and
the audit log.

## Ratings and gaps

Admins rate each result **Correct / Needs improvement / Incorrect** with optional feedback (audited).
"Recurring gaps" groups results by request category where the AI escalated for lack of approved knowledge or was
rated down, and shows verbatim example questions once a pattern repeats (2+). It is read-only: nothing is created,
approved or changed; knowledge is still added through the Knowledge and Review tabs.

## Privacy, isolation, retention

All queries are scoped by `business_slug`; the tables are admin-read-only under RLS; the module has no import path to
the outbox. Rows are deleted after 90 days (`purge_ai_agent_shadow_results`, run opportunistically by the batch
sweep) and by **Forget customer** with "logs" (counted under `logs`).

## Model-cost impact

* Historical capture: **zero** additional calls.
* Simulation: one call of the existing reply prompt (≈ the live call; the Evaluation tab totals tokens per result).
  Capped at 30/hour/business, and only on an explicit admin click.
* Evaluation page loads and ratings make no model calls.

## Deploy

1. Run `supabase/migrations/20261029000000_ai_agent_evaluation.sql` (after 20261028). Additive; replaces
   `forget_ai_agent_customer` with the same signature and result keys.
2. Deploy the app. The Evaluation tab shows a "run the migration" notice until step 1 is done; live decisions are
   unaffected either way (capture failures are logged and swallowed).
3. Switch capture on per business in the Evaluation tab when ready.
