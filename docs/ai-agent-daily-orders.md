# Daily order summary

Tracks the orders customers place in WhatsApp, and posts **one consolidated report per business to a staff
WhatsApp group at 8:00 AM (America/St_Lucia)**. Staff can type `!update` in that group for a fresh one.

It never messages a customer, and Approval Pilot is unchanged: tracking and reporting add no customer-bound
outbox kind, and every customer reply still needs explicit staff approval.

## How it works

| Piece | Where |
|---|---|
| Order records (authoritative) | `ai_agent_orders`, history in `ai_agent_order_events`, delivery audit in `ai_agent_order_summary_runs` |
| Extraction | Conversations the AI also answers: the **existing** per-turn model call (its JSON gains `order_target`, `other_orders`, item `variant`/`size` and `requested_for`; no extra call). Conversations the AI may **not** answer: a separate, small, incremental call (see "Monitoring every conversation"). |
| Rules (pure, tested) | `lib/aiAgent/orders.ts` |
| Server logic | `lib/server/aiAgent/orders.ts` (hooked into `handleCustomerTurn` in `decide.ts`) |
| Scheduler | One mechanism: the bridge's outbox poll (`/api/bridge/ai-agent/outbox/claim`) runs `runDueOrderSummaries()` at most once a minute. No cron job to configure. |
| Order commands (`!update …`, `!order`, `!moreinfo #REF`) | parsed in `lib/aiAgent/orderCommands.ts`; run by `handleOrderCommand` from `processStaffGroupMessage` (staff group) and `processOrdersGroupMessage` (separate Orders group) |
| Dashboard | Admin → AI agent → **Orders** tab; routes under `/api/ai-agent/orders` (admin-only, like every `/api/ai-agent/*` route) |

`ai_agent_order_requests` (the Approval Pilot's collected request) and `customer_orders` (the analysis engine)
are untouched. The new table is the single source of truth for reports.

### Statuses and confirmation

`possible` (details incomplete) → `awaiting_confirmation` (all required details present) → `confirmed` →
`fulfilled`; `cancelled` from any open state. Required: product, quantity, delivery **or** collection, and an
address for delivery. A missing day/time is reported but does not block.

There are two kinds of confirmed order, and the report and dashboard say which:

* **Staff-verified**: a person pressed *Confirm* in the dashboard (recorded with their user id). Always allowed.
* **Customer-confirmed**: the customer's own yes finalized it. **Off by default** (`orders_customer_confirms`).
  While it is off (the initial rollout) a customer's yes is only **recorded** (`customer_confirmed_at`, a
  *Customer replied yes — staff to verify* flag, listed under Needs attention) and staff verify it. A staff
  Confirm afterwards reads "verified by staff (customer also replied yes)".

Even when a yes is recorded or may finalize, **all** of these must hold, otherwise nothing changes:
the chat has exactly **one** open order and it is complete and `awaiting_confirmation` (with anything else open,
"yes" could mean any of them; the model's guess is not trusted); the turn is *only* an unambiguous yes/confirm
("yes", "yes please", "confirmed", "go ahead", "that's correct"); the turn changed nothing in the order; and **a
person** (staff-typed message or sent `!send`/`!approve`) wrote to the customer after the order became complete,
within the last 48 hours. The agent's own automatic replies do not count. A later change to the order, by the
customer or by staff, voids a recorded yes.

"ok", "sure", "maybe", "I think so", 👍, "yes but make it 3", "yes?" never confirm. The model's text never
confirms anything. Changing a confirmed order sends it back to `awaiting_confirmation` flagged
*changed after confirmation*. A cancellation request cancels an unconfirmed order only when it clearly means the
whole order; on a confirmed or ambiguous case it is **flagged for staff**, not applied.

### Merging and duplicates

* The model sees the customer's open orders (reference `O-XXXXX`) and names the one a message belongs to, or
  `"new"`. An invented reference is ignored; with several open orders and no valid reference nothing is guessed
  (join only on a shared product, else a flagged new order). An identical order is merged, never copied.
* Every AI/customer change carries an idempotency key (`<batch or event id>:<n>`), so a retried batch or
  message changes nothing the second time. Writes are version-checked (`apply_ai_agent_order`).
* Anything a person edited is locked: later AI updates never overwrite it. If the customer's NEW message (not older
  words the cumulative draft repeats) states a different value for a locked field, it is stored in
  `ai_agent_orders.field_conflicts` (`{ proposed, current, at }`), never applied. It shows in the dashboard (Use
  customer's / Keep staff's), in `!moreinfo`, and as a `Customer now says …` warning in the report, even for a
  confirmed order. It clears when staff edit that field (dashboard or `!update`) or choose Keep staff's. No extra model call.
* Unknown quantities stay `null` in the database and read `Product — quantity needed` everywhere (never `? ×`).
* Every successful `!update #REF …` answers once in the group with the reference and the change. Confirm/cancel say
  they are internal and that the customer was not messaged. The notice is keyed to the WhatsApp message, so a
  redelivery cannot post it twice.
* Products, quantities, variants, sizes, addresses and times are kept only if the customer wrote them.

### The report

Built from the database at send time (no stored AI text), the same for the 8 AM job and `!update`:

```
📋 *DAILY ORDERS — 26 OCT*
5 orders · 1 confirmed · 4 to review

✅ *CONFIRMED* (1)
*1. Jane Doe · #K3PD7*
Phone: 555-0101
2 × Monello Beef 15kg
1 × Dog Treats
Delivery: 12 Main St, Gros Islet · Tue 27 Oct (tomorrow)

⚠️ *NEEDS ATTENTION* (4)
*2. Marie Joseph · #QU6U9*
Phone: 286-7466
1 × Monello Chicken 25kg
Delivery: Cap Estate
⚠️ Needs confirmation
```

* One block per order: best name · compact reference, readable phone (St Lucia numbers as `286-7466`), `quantity × product variant size`, delivery or
  collection with address and day, a note, and **only the most actionable warning** (a flag a person must check, else the first missing required
  detail, else "Needs confirmation"). Nothing is printed for what is unknown or empty. Confirmed orders are listed apart (the heading appears when
  there is at least one; with none confirmed the summary line already says everything needs review).
* The reference is the order's `ref_code` shown without its prefix (`O-QU6U9` → `#QU6U9`). It is created once and never changes.
* A report that does not fit in one message (~3,500 characters) is split on order boundaries into numbered messages, `(1/3)`, `(2/3)`…, sent in order
  (at most 6; beyond that the count of orders not shown is stated). Everything stays in the dashboard.
* Unconfirmed enquiries with no customer activity for 7 days are left out and counted in one line. Confirmed orders never expire. Customer text is
  sanitised so it can never start a line that looks like a command.
* The only coverage line is a warning when something is wrong: tracking is OFF, conversations failed analysis or hit the hourly limit, or messages never
  reached the agent. A healthy report carries none (the dashboard still shows the full coverage detail).

### What the report claims to cover

The report is never presented as exhaustive, but it no longer explains its own plumbing: a single warning line appears **only** when coverage is known to be
incomplete (tracking switched OFF; conversations whose processing failed or hit the hourly limit; customer messages the bridge stored but never forwarded).
The Orders tab shows the full coverage notes (including when tracking started and which conversations were deliberately not read).

### Scheduling and delivery safety

* One `ai_agent_order_summary_runs` row per business per **local** day (`scheduled_key = "<business>:<date>"`, unique).
  Whoever inserts it owns the day; the outbox `dedupe_key` (`ordersummary:<business>:<date>:<attempt>`) makes the
  send itself idempotent. Overlapping, repeated or restarted callers cannot post twice.
* Due from the configured hour (default 8) in the business's timezone (default `America/St_Lucia`). After downtime
  it **catches up for 6 hours**; later than that the day is recorded as *missed* and not sent (visible on the Orders tab).
  A worker that died after claiming the day is resumed after 2 minutes.
* **Uncertain sends are never repeated**: handed to the bridge with no ack for 10 minutes, or failed with an
  ambiguous error → no automatic resend (the dashboard shows "unresolved"). Only a *provable* non-send
  (`not_sent`, or a block code such as `bridge_send_disabled`) is retried, with fresh data, at most 3 attempts per day.
* The summary is a `staff_notice` (a kind the bridge already knows) and passes the same final gate
  (`outboxAllowed`) as every staff-group message. Observe mode posts it only when "post escalation notices" is on.

### Order commands (staff group / Orders group)

Typed by an **authorized sender** (the same verified allow-list as `!send`) in the **configured orders group** (the staff group unless a separate Orders group is
set). All of them are deterministic: no model call, resolved server-side inside the business, answered with a short message to that group only. Nothing here
can message a customer.

| Command | Does |
|---|---|
| `!update` | The current report (read-only; 30 s cooldown; a retried message cannot post twice). |
| `!update #QU6U9 confirmed` | Staff-confirms the order (same rule as the dashboard: needs products, quantity, delivery/collection and an address for delivery). |
| `!update #QU6U9 cancelled` | Cancels it. |
| `!update #QU6U9 2 bags` | Sets the quantity (orders with exactly one product; otherwise "use the dashboard"). Needs a unit (`2 bags`, `x2`, `qty 2`). |
| `!update #QU6U9 delivery tomorrow` | Sets the requested delivery day. "tomorrow"/weekdays are turned into a calendar day from when the command was written, in the business's timezone. |
| `!order <name or phone>` | Lists matching **active** orders (up to 5). |
| `!moreinfo #QU6U9` or `!order #QU6U9` | Full details: status, phone, name and where it came from, items, delivery, who edited what, the last 5 changes. |

Rules: a selector (`#REF`, a phone number of 6+ digits, or a name) must identify exactly **one** active order; with two or more nothing changes and the
choices are listed. References also find closed orders (to say "already cancelled"). A change goes through the **same function as the dashboard's buttons**
(`updateOrderManually` → `apply_ai_agent_order`): version-checked, the edited field is locked against the AI, full history (`staff_whatsapp_*` events, actor
`staff`) and an audit entry (`order.*`, `via: whatsapp`). Staff can overwrite a field they locked earlier; the AI cannot.

Safety: the same WhatsApp message applied twice changes the order once (idempotency key `wa:<business>:<message id>`); a command is refused if the customer, the AI
or the dashboard changed the order **after the command was written** (two staff commands typed seconds apart both apply), if it is more than 2 hours old, or
if someone changed the order while it was being applied (version conflict); unauthorized senders get a refusal and an audit entry; the commands are
ignored (and audited) in any other group; another business's references simply do not exist. `!moreinfo` **without** an order reference, and `!moreinfo #E-…`,
still belong to the escalation / Approval Pilot logic untouched. Anything starting `!update …` that is not a recognised command stays ordinary staff chatter.

## Monitoring every conversation

With `orders_tracking_enabled` on, **every genuine 1:1 customer conversation** the bridge forwards is read for orders, whether or not the AI may reply there:
not on the allow-list, no contacts selected, excluded, **Manual Only**, staff takeover, Observe or Approval Pilot. Never read: groups (the staff group
included), status broadcasts, newsletters, system chats. The agent master switch must be on (a disabled business is ignored before anything is read).

**Monitoring never grants permission to reply.** The monitoring code has no outbox access (a test greps for it) and returns reason codes only; whether anything is
ever sent stays with the existing gate and send policy.

| Message | What happens |
|---|---|
| Customer, AI may answer | The existing single model call also fills the order (unchanged, no extra cost). |
| Customer, AI may not answer | Joins the same batch as any other (rapid messages are analysed together, in order). Then: a free **pre-filter** (`lib/aiAgent/orderMonitor.ts`) skips pleasantries, media-only and messages with no order wording while no order is open; a bare "yes" or short "cancel it" for an open order is handled by the rules (no model call); everything else, **always when an order is open** (a follow-up may change it), makes **one small model call** that sees only the open orders, the last 8 messages and the new message(s). |
| The business's own message in the chat (business phone / inbox) | Read only when an order is open and the wording could matter. It can only **flag** that order for a person (*staff wrote a confirmation / cancellation / change*, listed under Needs attention): it never creates an order, edits one, confirms or cancels one (the business phone cannot say *who* wrote, and staff verification stays a person's Confirm click), and does not count as customer activity. Never read: the agent's own sends coming back, and AI drafts (they are not messages). |

Safeguards: every write is keyed by the batch/event id (a retried message changes nothing and costs no model call), writes are version-checked, staff-edited
fields stay locked, and products/quantities/addresses/times survive only if the customer wrote them. Budget: at most **20 monitoring calls per chat and 300
per business per hour**; beyond that a message is recorded as *not analysed* and reported. Every message leaves a reason code on its event
(`orders_monitor_*`: analysed, filtered and why, over budget, failed), which is what the coverage note counts.

### Coverage, honestly

The report and the Orders tab say: conversations whose analysis **failed**; customer messages the bridge **stored but never forwarded** to the agent
(detected by comparing `whatsapp_messages` with the agent's event log, ignoring the last 10 minutes); conversations skipped because the hourly budget was
used; when tracking started. A clean report says it covers every customer chat the agent received. Messages the pre-filter judged to have no order wording
are counted on the dashboard only.

### Recovering missed orders (opt-in backfill)

Orders tab → "Recover missed orders" (24 / 48 / 72 hours). Never automatic. It plans only the conversations that have a stored customer message the live
path never read (no event, an errored event, or one the old rules stopped), skips conversations an earlier finished run covered, caps a run at 200
conversations (the rest is reported on the run), reads at most 150 messages per conversation in chunks of 25, and applies them through the same rules
(a "yes" in the past is **never** recorded; staff lines are context only). Progress is saved after every conversation, a step can be repeated safely (keys
`backfill:<run>:<chat>:<chunk>`), and `ai_agent_order_backfill_runs` plus the audit log record who started it, the window, counts and failures. It reads
stored messages and writes order records only. Retention of `whatsapp_messages` bounds how far back it can see.

## Reading customer wording

The model still does the main reading; `lib/aiAgent/orderText.ts` is the deterministic net around it, applied on both the reply path and the monitoring path:

* **Quantities**: "a bag of Monello", "one bag" = 1, "two bags" = 2, "a couple of bags" = 2 only when the order has one product or the phrase names the product.
  A product with two lines and an unnamed "two bags" stays "Needs quantity". A value the customer did not write is dropped (grounding), never invented.
* **Delivery vs collection**: "bring it to Cap", "deliver tomorrow", "drop it off" are recorded as **Delivery** immediately (the customer is not asked again);
  "I'll collect", "I'll pick up" as **Collection**. The latest statement wins; "don't deliver", "do you deliver?" and "delivery or collection?" record nothing.
* **Relative dates**: "tomorrow", "tonight", "Friday" are resolved from the **timestamp of the message that said them**, in the business's timezone
  (America/St_Lucia), and stored as `Tue 27 Oct (tomorrow)`. A retry, a backfill or the model repeating "tomorrow" in a later turn cannot move the date.
  Ambiguous wording ("next Friday", a weekday said on that weekday, two days named) stays as the customer's words.
* **Withdrawn items**: "just the Monello bags" keeps Monello and records the dropped products in the order's history (`removed_items`). If the model drops a
  product the customer never withdrew, it is restored and the turn is marked `order_item_removal_unconfirmed`.
* **Enquiry vs order** is unchanged: a product question is not an order unless one is already open; a customer's "yes" only confirms under the existing
  strict rules; staff-confirmed (`confirmed_by = staff:<id>` / `admin:<id>`) and customer-confirmed (`customer`) stay distinguishable in the dashboard and `!moreinfo`.
* Staff corrections and field locks are untouched: anything a person edited stays theirs.

## Customer names

Read fresh at report time (nothing is copied onto the order), best first: the name staff entered (the order's own name when edited, else first + last name on the
customer's profile) → the name saved for the contact on the business phone (`customers.business_contact_name`, else the latest
`whatsapp_messages.business_contact_name` of that chat) → the customer's own WhatsApp profile name (`customers.whatsapp_name` / `whatsapp_messages.contact_name`)
→ the name the order recorded when it was created → the phone number. Numbers, JIDs, placeholders ("Unknown"), symbols-only and very long values are never used as a
name. `!moreinfo` says which kind of name is shown. The Orders tab shows the same name.

## Settings (per business, Setup → "Daily orders"; all OFF by default)

`orders_tracking_enabled`, `orders_summary_enabled`, `orders_group_jid` (empty = the staff group, e.g. the
Approval Pilot group), `orders_timezone`, `orders_summary_hour`. Tracking is **independent of the AI's reply permissions**
(see "Monitoring every conversation"); it needs the agent switched on for the business.

## Deployment

**This release needs one more small migration (`20261103000000_ai_agent_order_field_conflicts.sql`: a `field_conflicts` column and the same `apply_ai_agent_order`, now writing it) and no bridge change.** Run it after the two below, before deploying the app.

**Migration (run in the Supabase SQL editor, in this order, before deploying the app):**
`supabase/migrations/20261101000000_ai_agent_daily_orders.sql` (needs 20261022–20261031 applied), then
`supabase/migrations/20261102000000_ai_agent_order_monitoring.sql` (one additive table for the opt-in backfill). Additive:
three tables, six settings columns, `apply_ai_agent_order`, a replaced `claim_ai_agent_outbox` and
`forget_ai_agent_customer` (which now also deletes the customer's tracked orders).

**Environment variables:** none new. It uses `AI_AGENT_BRIDGE_SECRET` and/or `CRON_SECRET`
(scheduler auth, same as `/api/cron/ai-agent/batches`) and `SUPABASE_SERVICE_ROLE_KEY`.

**Scheduler:** nothing to set up. The bridge already polls `/outbox/claim` every ~10 s for each business it can
send for; each poll lets the app check (at most once a minute) whether a business's local 8:00 has passed, and the
database allows one scheduled run per business per local day. No Vercel Cron, pg_cron or second endpoint. The
schedule and `!update` share no state apart from the data they read: either works without the other.
If the bridge is down or cannot send, nothing can be delivered anyway; on recovery the catch-up window applies.

**Bridge (WhatsappOperation):** *a bridge update is required only to use a separate Orders group*; with the staff
group (the default) the existing bridge works unchanged. The update (WhatsappOperation `src/agent`, 4 small
changes + tests, `dist/` rebuilt): parse `ordersGroupJid` from `/config`; forward messages from that group;
accept `staff_notice` (and `staff_feedback` outside Observe) addressed to it, never drafts or relays; and poll in
Observe when only an orders group exists. An older bridge ignores `ordersGroupJid`, so leave the Orders group empty
until the bridge is deployed.

**Order:** migration → app deploy → (only for a separate group) bridge deploy → turn settings on per business.

## End-to-end check (a pilot business)

1. Setup → Daily orders: tracking **on**, summary **on**, customer confirmation **off**, leave the group empty (uses the staff group), save.
2. From a test customer chat send "2 Monello Chicken 15kg delivered to <address> Friday morning". Orders tab: one
   order, *Awaiting confirmation*, phone shown. No customer message is sent.
3. Send "make it 3 bags": same order, quantity 3, History shows before/after. Send a second, different order: two orders.
4. Reply "yes" with no staff message in between: still *Awaiting*. Have staff write to the customer, then "yes please": the order stays *Awaiting*, flagged *Customer replied yes*; press *Confirm* → "verified by staff".
5. In the staff group, an authorized sender types `!update`: the compact report appears. Then `!update #REF confirmed`, `!update #REF 2 bags`,
   `!update #REF delivery tomorrow`, `!order <name>` and `!moreinfo #REF` each answer in the group and change the Orders tab. A non-authorized
   sender gets a refusal; the commands in another group do nothing; no message ever reaches a customer.
6. Orders tab → *Send summary now* behaves like `!update`. Edit an order (e.g. the address), `!update` again (after 30 s): the change is in the report.
7. At 8:00 St Lucia time one summary arrives (within a minute or so of the bridge's next poll); nothing further follows. The "Daily summary" card shows the run and its delivery state. Switch tracking off and `!update`: the report says it is incomplete.
8. Kill the bridge before 8:00, restart within 6 hours: the summary arrives once after restart.

## Known limits / follow-ups

* A saved contact name exists only if the business phone has the contact saved and the bridge has seen it (it reads contact events after connecting); until then the profile name, then the phone, is shown.
* A quantity set by command locks the order's products against the AI: if the customer later changes the quantity in WhatsApp, a person must update it (dashboard or `!update`).
* Dates: only "today / tonight / tomorrow / day after tomorrow / a named weekday" are turned into calendar days; "next Friday", dates like "28th" and times stay as written.
* No retention job for fulfilled/cancelled orders yet (deleting a customer via the Memory tab does remove theirs).
* A customer's yes counts only if a person wrote to them (inbox, `!send`) in the last 48 h and exactly one order is open; a phone confirmation is a *Confirm* click.
* A staff message in the chat can raise a flag but never creates an order, so an order the customer only described in a voice note and staff then wrote out is
  recorded only once the customer says it in text (or staff add it in the dashboard).
* Voice notes, images and stickers are not transcribed: media-only messages are counted (filtered) but carry no order text.
* Cost: AI-eligible turns carry ~350 extra instruction tokens and the open-order list; monitoring-only turns make one small call (~760 instruction tokens +
  open orders + 8 context lines, typically 1.2–1.5k input and 100–200 output tokens), capped per chat/business per hour.
