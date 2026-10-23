# AI agent: message batching and long-term customer memory

Status: implemented in the Inbox, **not deployed, not committed, migration not applied**.
Both features ship switched OFF for every business.

## 1. Architecture

### Batching (durable, database-backed)

```
bridge ─POST /message─▶ processBridgeMessage ──(batching on, eligible customer msg)──▶ enqueue_ai_agent_batch_message()
                                                                                        │  one "collecting" batch per chat
                                                                                        ▼  due_at = min(now + quiet, first + max)
 ┌──────────────── scheduler triggers (any of them, any number at once) ───────────────┐
 │ bridge outbox poll (/outbox/claim, every ~10 s)  ·  any forwarded message           │
 │ POST/GET /api/cron/ai-agent/batches (cron / pg_cron)                                │
 └──────────────────────────────────────┬─────────────────────────────────────────────┘
                                        ▼
                    claim_ai_agent_batches()  (FOR UPDATE SKIP LOCKED, 150 s lease, ≤4 attempts)
                                        ▼
        processClaimedBatch → buildCustomerTurn → handleCustomerTurn  (the SAME pipeline as a single message)
                                        ▼
        ONE decision · ONE escalation · outboxAllowed() filter · outbox rows `pending`
                                        ▼
        bridge's next /outbox/claim poll hands them out (claim_ai_agent_outbox re-checks mode in SQL)
```

* **State lives only in Postgres** (`ai_agent_batches`, `ai_agent_batch_messages`). There are no in-memory
  timers (a test enforces this), so Vercel restarts, bridge restarts and cold starts lose nothing.
* **Timer reset / ceiling**: every new message sets `due_at = least(now() + quiet, first_message_at + max_wait)`.
  Computed inside the SQL function from the business's own settings row, so a caller cannot bypass it.
* **Idempotency**: `ai_agent_events` (unique per business + WhatsApp id, unchanged) and
  `ai_agent_batch_messages` (same uniqueness). A duplicate webhook changes nothing and does not reset the timer.
  A message whose first delivery died before reaching its batch is resumed on retry.
* **Concurrent workers / restarts**: a batch is leased to exactly one worker. A crashed worker's lease expires and the
  batch is re-offered (`attempts` capped at 4, then `failed`, fail-closed: nothing sent). Only the lease holder can
  complete a batch.
* **Messages during processing** open a *new* collecting batch (the unique index covers `collecting` only). A chat's
  batches are processed strictly in creation order and never in parallel.
* **Ordering**: messages are sorted by their original WhatsApp timestamp, arrival order breaking ties; a message with no
  timestamp keeps its arrival slot. The model sees `[HH:MM:SS] text` lines (UTC).
* **Eligibility** is checked when the message arrives (agent on, contact permitted/not excluded, no human takeover,
  1:1 chat) and **again when the batch is processed** (settings re-read, takeover re-checked). A staff message sent while
  the customer was typing therefore stops the AI for that turn. Staff (`fromMe`) and staff-group messages are never
  batched or delayed.
* **Observe mode** is unchanged and enforced three times: `outboxAllowed()` on the batch path, `canSend()` guards on
  every customer-bound item, and `claim_ai_agent_outbox` in SQL (only a `staff_notice` to the staff group, only with
  `staff_notices_enabled`).
* **Follow-ups on an open escalation** append to it (one open escalation per chat, DB-enforced). Each new customer
  message is logged in `context.updates` (shown in the admin Escalations tab) even when Observe mode posts no second
  notice. Assisted mode posts one follow-up notice per batch, not per message.

### Customer memory (extends existing tables)

| Layer | Source | Trust |
|---|---|---|
| Confirmed purchases | `customer_orders` with `order_status` **Added / Completed** (staff processed them) | **Verified** |
| Earlier requests | `customer_orders` with `Needs adding` / no status, and `ai_agent_order_requests` | Unverified. Never a purchase |
| Stated preferences | new `ai_agent_customer_memory` (`source = customer_stated`, with the customer's verbatim words) | Customer said it |
| Resolved issues | `ai_agent_customer_memory` (`staff_confirmed`, written when staff `!close` a complaint-type escalation) | Staff confirmed |
| AI inferences | `customer_ai_profile` (unchanged) | Unverified, always labelled so |

* **Retention**: `customer_orders` and the memory table have no foreign keys to `whatsapp_messages`, so the 7-day
  message purge cannot touch them. Memory facts expire after 2 years unless an admin entry says otherwise. Batch
  message text is purged 7 days after a batch finishes.
* **Identity**: a customer is matched only by a verified phone number or one of their own chats (the existing
  `lib/aiAgent/identity.ts` rules). `@lid` digits are never treated as a phone number; an unresolved `@lid` chat gets
  memory keyed `chat:<jid>` and orders matched by that chat only. Names are never used to join identities. Every
  query is scoped by `business_slug`.
* **Capture is validated, not trusted**: the model may propose preferences, but a fact is stored only if the customer's
  exact words (case/punctuation-insensitive) appear in the turn, it is not a question, it contains no price, stock claim,
  delivery promise, payment or link, and it passes the prompt-injection filter. Max 3 per turn. Off by default
  (`customer_memory_enabled`).
* **"Same as last time"** (`resolveRepeatOrder`): looks only at verified orders. One reading (or identical repeats, or
  a product named in the message that matches one order) → the request is seeded with that order's items; address and
  delivery day are always asked again; staff still approve. Several readings → the agent asks which one, from verified
  records, without the model. No usable verified order → escalated to staff. Nothing is guessed.
* **Prompt size**: at most 3 verified orders (5 when repeating), 2 unconfirmed, 6 facts, 200 characters per inference.
  Never whole conversations.
* **Admin** (Admin → AI Agent → *Memory*, admin-only): inspect orders (verified vs unconfirmed), facts, inferences;
  correct or delete facts; add notes; exclude an order from what the agent remembers; clear an inference; delete all
  agent data for a customer (typed `DELETE`; recorded orders and activity-log text only if ticked). Audit entries hold
  ids and counts, never the remembered text.

## 2. Settings (per business, Setup tab)

| Setting | Default | Range |
|---|---|---|
| Message batching | **off** | on/off |
| Quiet period after latest message | 45 s | 0–120 (0 = handle immediately) |
| Maximum total wait | 180 s | 10–600, never below the quiet period |
| Customer memory capture | **off** | on/off |

Batching defaults to **off** so deploying changes no behaviour until the scheduler is verified.

## 3. Migration

`supabase/migrations/20261025000000_ai_agent_batching_memory.sql` — additive, re-runnable, applied by hand in the
Supabase SQL editor **before** deploying the app (the app selects the new settings columns). Depends on the 20261022,
20261023, 20261024, `customer_ai_profile` and `customer_orders` migrations.

Adds: 4 settings columns (+ check constraints), `ai_agent_batches`, `ai_agent_batch_messages`,
`ai_agent_customer_memory`, `ai_agent_events.batch_id` and a `BATCHED` decision value, `customer_orders.ai_memory_excluded`,
and six service-role-only functions: `enqueue_ai_agent_batch_message`, `claim_ai_agent_batches`,
`complete_ai_agent_batch`, `release_ai_agent_batch`, `purge_ai_agent_batches`, `forget_ai_agent_customer`.
`claim_ai_agent_outbox` is untouched. RLS: admin read-only, writes via the service role, like every other agent table.

Rollback: the migration is additive; switching `batching_enabled` off restores today's per-message path immediately.
Any batch already waiting is still processed by the scheduler.

## 4. Scheduler requirements

Due batches must be processed even if the customer never writes again. Triggers (all idempotent, all optional
individually; use at least one that does not depend on customer traffic):

1. **Bridge outbox poll** (already exists, every ~10 s): `/api/bridge/ai-agent/outbox/claim` schedules a sweep after it
   responds. No bridge change. Reliable whenever the bridge is up, which is also the only time anything can be sent.
2. **`/api/cron/ai-agent/batches`** (`GET` for Vercel Cron with `CRON_SECRET`, `POST` with `x-ai-agent-secret`).
   Vercel Cron on the Hobby plan is limited to once per day, so on Hobby use option 3 or rely on option 1.
3. **Supabase pg_cron + pg_net** (not applied by anything here), once a minute:
   `select net.http_post(url := 'https://<app>/api/cron/ai-agent/batches', headers := jsonb_build_object('x-ai-agent-secret', '<secret>'));`
   (keep the secret in Vault, not in the cron command).
4. Any forwarded message also triggers a sweep (throttled per instance, as an optimisation only).

Latency from the end of the quiet period to the staff notice ≈ the poll interval (≤10 s) + one model call.
Route `maxDuration` is 60 s; each sweep is bounded to ~40 s and a batch that does not finish is retried after its lease.

New env var: `CRON_SECRET` (optional, only for Vercel Cron). Nothing else.

## 5. Bridge contract changes

None required. A batched message returns `{ status: "done", decision: null, reasons: ["batched"], outbox: [] }`
(nothing to send), and results arrive through the existing `/outbox/claim` poll. `/config` gains informational
`batchingEnabled / batchQuietSeconds / batchMaxWaitSeconds`. See `docs/ai-agent-bridge-contract.md` §3.2, §3.4.

## 6. Operating cost

* Model calls drop from one per customer message to one per turn (a customer sending five messages in a minute costs one
  call, not five). Memory adds ~150–500 prompt tokens per call; no extra calls.
* Database: ≈ 6–10 small queries per forwarded message (as before, plus one RPC), ≈ 15 per processed batch, one indexed
  claim RPC per poll (~8,600/day per bridge). Batch text is purged after 7 days.
* No new infrastructure or paid add-on is required.

## 7. Tests

`npm test` (≈180 tests). New: `aiAgentBatching`, `aiAgentMemory`, `aiAgentBatchWiring` (pure), and
`aiAgentBatchingSql` which starts a throwaway local PostgreSQL, applies the real migrations and exercises timer resets,
the maximum wait, duplicate and simultaneous deliveries, parallel workers (including 8 racing for one batch), lease expiry /
restarts, attempt caps, mid-processing arrivals, strict per-chat ordering, business isolation, retention purge, customer
deletion and the Observe-mode outbox claim. That file skips itself when PostgreSQL binaries are not installed (set `PG_BIN`
to point at them).

Not covered by automated tests: the orchestration in `decide.ts` against a live Supabase and the live model (see §8).

## 8. Deployment sequence

1. Review the migration; run it in the Supabase SQL editor. Run the verification queries at its end.
2. Deploy the app (batching and memory capture are off, so behaviour is unchanged). Optionally set `CRON_SECRET`.
3. Confirm the scheduler: `curl -X POST $APP/api/cron/ai-agent/batches -H "x-ai-agent-secret: …"` returns `{ok:true,claimed:0,…}`.
4. Pick one **Observe-mode** business with staff notices on. In the admin Test console, send a few messages including
   "same as last time"; check the Memory tab shows verified vs unconfirmed orders correctly.
5. Turn batching on for that business with a short window (e.g. 10 s quiet / 30 s max). Send 3 quick messages from an
   allowed test contact: expect one Activity row per message (`BATCHED`), then one decision and one staff notice. Send a
   message mid-processing and confirm it starts a second batch.
6. Raise the window to 45 / 180 s. Watch Activity and `ai_agent_batches` (`status`, `attempts`, `error`) for a day.
7. Only then consider customer memory capture, then (separately, deliberately) Assisted mode. Nothing in this change
   enables sending; production sending stays under the existing master switch, mode and `AGENT_SEND_ENABLED` controls.

Known limits: a retried batch after a crash between escalation creation and the outbox write may skip the Assisted-mode
holding reply (fails safe); two workers can only both touch one chat if a lease expires while the first is still running
(side effects are keyed by batch id so they are not duplicated); `orders` verification relies on staff keeping the Orders
Queue statuses up to date.
