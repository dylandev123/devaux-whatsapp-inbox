# Daily order summary

Tracks the orders customers place in WhatsApp, and posts **one morning list per business to a staff
WhatsApp group at 8:00 AM (America/St_Lucia)** (today's and tomorrow's orders). Staff type `!orders` in that group
to see what is outstanding, and `!update` for a short list of what is new or changed. Orders are organised by the
day they are **for**, not the day the message arrived: see "Order days, `!orders` and `!update`" below.

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
`fulfilled`; `cancelled` from any open state. Required: product, quantity and, unless the customer will collect, a delivery address. Delivery is the default, so a missing
delivery/collection choice and a missing day are **not** gaps (see "Business defaults" below).

There are two kinds of confirmed order, and the report and dashboard say which:

* **Staff-verified**: a person pressed *Confirm* in the dashboard (recorded with their user id). Always allowed.
* **Customer-confirmed**: the customer's own yes finalized it. **Off by default** (`orders_customer_confirms`).
  While it is off (the initial rollout) a customer's yes is only **recorded** (`customer_confirmed_at`, a
  *Customer replied yes — staff to verify* flag, shown in the dashboard and `!moreinfo`, not in the report) and staff verify it. A staff
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
* Anything a person edited is locked: later AI updates never overwrite it. **Locks protect values, not the whole order.** With the products locked, a *new*
  product (or a detail staff left blank, such as a missing quantity) is still added automatically and is not a conflict. Only a *contradiction* is
  recorded: a different quantity for a locked product the customer restated in THIS message, or a product they withdrew. A contradiction is stored in
  `ai_agent_orders.field_conflicts` (`{ proposed, current, at }`), never applied. It shows in the dashboard (Use customer's / Keep staff's), in `!moreinfo`, and
  as one short `Customer asked for a change` warning in the report, even for a confirmed order. It clears when staff edit that field (dashboard or `!update`)
  or choose Keep staff's. No extra model call. Other locked fields (address, day, method, note) behave as before.
* A material change to a **confirmed** order (a product added or changed, a new address) sends it back to `awaiting_confirmation`, clears the staff
  confirmation and flags it *changed after confirmation*, whether the change came from the customer's words or from their history.
* Unknown quantities stay `null` in the database and read `Product — quantity needed` everywhere (never `? ×`).
* Every successful `!update #REF …` answers once in the group with the reference and the change. Confirm/cancel say
  they are internal and that the customer was not messaged. The notice is keyed to the WhatsApp message, so a
  redelivery cannot post it twice.
* Products, quantities, variants, sizes, addresses and times are kept only if the customer wrote them.

### Order days, `!orders` and `!update`

**The day an order is for.** `requested_for` keeps the customer's words, resolved to a calendar day when they are
written (`Fri 30 Oct (Friday morning)`, counted from when the customer WROTE it, in the business's timezone,
`America/St_Lucia` by default). A written date (`30 Oct`, `Oct 30th`, `2026-10-30`, `30/10/2026`, day first) is
resolved the same way; with no year it is the occurrence nearest the message. `lib/aiAgent/orderText.ts`
(`resolveRequestedDay`, `requestedDate`) is the only place that reads it, and it works on what is already stored, so
**no existing order needs migrating**. Anything that could mean two days ("next Friday", "tomorrow, 30 Oct" when they
disagree, "31 Nov", "2.5 bags", "1/2 a bag") is **not guessed**: the words are kept and the order has *no day*.

| Where an order is today | Rule |
|---|---|
| Today / Tomorrow / Later | its day is today / tomorrow / after tomorrow |
| **Overdue** | its day has passed, **or** it has no day and was first mentioned on an earlier day |
| No day yet | no readable day and first mentioned today (shown in the list, under its own heading) |

At local midnight everything moves one day on: yesterday's "today" order is Overdue, never silently today's. Nothing is
ever completed, cancelled or deleted by the passage of time or by looking at a list; an old order stays under Overdue
until a person completes or cancels it. (This replaces the old "7 days without activity drops out of the report" rule.)

**Essentials.** An order lacks information when it has no products, a product without a quantity, no address (delivery), or a day written
in words nobody can read. Delivery and the day are defaulted, not missing. `!orders missing` and the website's *Missing
information* view list exactly those, and **Needs attention** = overdue + missing information + warnings.

**`!orders`** (read-only, authorized staff, the orders group): `!orders` = today and tomorrow, each day split into
Delivery / Collection / not stated, followed by one-line pointers for what is not shown (overdue, missing, later).
`!orders today|tomorrow|<date>|all|overdue|missing|undated` shows one slice (`all` = every outstanding order by day).
An argument it cannot read gets the usage, never a guess. The 8:00 AM post is the same default view.

```
📋 *ORDERS — Wed 28 Oct*

📅 *TODAY — Wed 28 Oct* (2)

🚚 *Delivery*

*1. Jane Doe · #K3PD7* ✅ confirmed
1 × Monello Beef 15kg
📍 12 Main St, Gros Islet · 🕐 morning · 📞 555-0101

🛍 *Collection*

*2. Marcus · #QU6U9* 🕓 to confirm
2 × Monello Chicken 25kg
🛍 collection
⚠️ Missing: day

⏰ 3 overdue orders — !orders overdue
⚠️ 2 orders missing information — !orders missing
```

Customer text is sanitised so it can never start a line that looks like a command; a list longer than ~3,200
characters is split on order boundaries into numbered messages (at most 5; the count of orders not shown is stated),
in order. A `⚠️` line appears only for a real hazard (changed after confirmation, the customer contradicted something
staff set, a possible cancellation or duplicate, staff wrote in the chat that it changed). The only coverage line is a
warning when something is wrong (tracking OFF, conversations that failed analysis, messages that never reached the agent).

**`!update`** (alone) is **a short summary, not the list**: the orders that are *new* and the ones *materially changed*
since the group was last shown an update, plus cancellations by the customer or the dashboard.

* Rapid edits to one order are one line: each field shows its value at the "since" point and its value now
  (`products: 1 × Monello → 4 × Monello`); a change that ends where it started is not mentioned.
* Material = products/quantity, delivery↔collection, address, the day, a cancellation, a customer contradicting a
  staff-set field, or a safety flag. Not material: the customer's name, notes, a completion/reopening, and the
  group's own `!update #REF …`/`!order …` commands (they were acknowledged in the group when typed). An order asked for and withdrawn
  between two updates is never announced.
* It is one message (at most 12 entries, then "…and N more — !orders"), and it ends *"This message does not mark anything as reviewed."*
  Looking at it changes no order, event or status.
* **The "since" point is shared by the group** (it records what the group was last shown, not what any person has
  reviewed). It is the window end of the newest `!update` whose message is **provably sent** (`ai_agent_order_update_posts`
  → the outbox row's status `sent`). A failed, blocked or possibly-delivered update does **not** move it, so the changes
  are shown again rather than lost. The first ever update looks back 24 hours. A second `!update` while the previous one is still being delivered, or within 30 s, is told
  "an order update was just posted"; the same WhatsApp message delivered twice posts once.

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
| `!orders [today\|tomorrow\|<date>\|all\|overdue\|missing\|undated]` | Outstanding orders by the day they are for (read-only; a redelivered message answers once). |
| `!update` | New and materially changed orders since the group's last delivered update (read-only for orders; 30 s cooldown; a retried message cannot post twice). |
| `!update #QU6U9 confirmed` | Staff-confirms the order (same rule as the dashboard: needs products, quantity, delivery/collection and an address for delivery). |
| `!update #QU6U9 cancelled` | Cancels it. |
| `!update #QU6U9 2 bags` | Sets the quantity (orders with exactly one product; otherwise "use the dashboard"). Needs a unit (`2 bags`, `x2`, `qty 2`). |
| `!update #QU6U9 delivery tomorrow` / `delivery 30 Oct` | Corrects the day (delivery or collection). "tomorrow"/weekdays/written dates become a calendar day from when the command was written, in the business's timezone. The correction is an audited event (who, when, before → after) and locks the field against the AI; a later customer message that disagrees is recorded as a conflict, never applied. If the words cannot be read as a day the reply says the order now has no day. |
| `!order <name or phone>` | Lists matching **active** orders (up to 5). |
| `!moreinfo #QU6U9` or `!order #QU6U9` | Full details: status, phone, name and where it came from, items, delivery, who edited what, the last 5 changes. |
| `!order #QU6U9 completed` | Marks the order completed (status `fulfilled`, `fulfilled_at` set, staff sender recorded as the event's actor). It leaves `!orders` and `!order <name>` at once; the order and its history stay and `!order #QU6U9` still shows it ("Completed … by …"). Internal only: nothing is sent to the customer and no delivery is triggered. Needs a reference, not a name or phone. Repeating it (same or new message) changes nothing and records no second event. |
| `!order #QU6U9 reopen` | Undoes a completion: back to `confirmed` if a person had confirmed it, otherwise `awaiting_confirmation` (or `possible` if details are missing). Only for completed orders; cancelled ones stay cancelled. |

Rules: a selector (`#REF`, a phone number of 6+ digits, or a name) must identify exactly **one** active order; with two or more nothing changes and the
choices are listed. References also find closed orders (to say "already cancelled"). A change goes through the **same function as the dashboard's buttons**
(`updateOrderManually` → `apply_ai_agent_order`): version-checked, the edited field is locked against the AI, full history (`staff_whatsapp_*` events, actor
`staff`) and an audit entry (`order.*`, `via: whatsapp`). Staff can overwrite a field they locked earlier; the AI cannot.

Safety: the same WhatsApp message applied twice changes the order once (idempotency key `wa:<business>:<message id>`); a command is refused if the customer, the AI
or the dashboard changed the order **after the command was written** (two staff commands typed seconds apart both apply), if it is more than 2 hours old, or
if someone changed the order while it was being applied (version conflict); unauthorized senders get a refusal and an audit entry; the commands are
ignored (and audited) in any other group; another business's references simply do not exist. `!moreinfo` **without** an order reference, and `!moreinfo #E-…`,
still belong to the escalation / Approval Pilot logic untouched. Anything starting `!update …` that is not a recognised command stays ordinary staff chatter.

## Maintaining an order from short messages

A customer message is an update to an ongoing order, not a new request. The model returns the cumulative order as before; the server adds a deterministic
safety net (`lib/aiAgent/orderText.ts`) for numbers the model's draft cannot be checked against the customer's words:

* "Add 4 pool salt" → appended. "Another bag", "one more", "2 more bags" → the line's current quantity plus that many, for the one line it clearly means (named,
  or the only line); a line with no numeric quantity is never guessed. "Another bag of Bandit" for a product not on the order → 1 × Bandit. "Make that 3" →
  the quantity of a single-line order (with several lines the model's grounded reading stands). "A bag" → 1.
* "Remove the Bandit" / "Just the Monello" → removed only when the customer's words withdraw something (otherwise a product the model dropped is restored).
* "Bring it to Cap" → Delivery: Cap. "I'll collect" → Collection. The latest statement wins.
* A turn with no draft of its own (the model returned no order for "Another bag") still updates the open order.
* Every write carries the batch/event id as an idempotency key, so a retried message or batch adds nothing twice; repeated pointers ("same as last time" twice)
  never duplicate a line either.

## Customer order memory

Repeat customers are understood from **their own earlier orders in `ai_agent_orders`** (staff corrections included), found by the same stable identity as the rest
of the agent (the verified phone and the chats known to be that contact, including a verified `@lid` mapping; an `@lid` without a verified phone only ever matches
its own chat) and **always inside the business**. No new table, store or model.

| Customer says | What happens |
|---|---|
| "Same as last time" | The most recent *reliable* order's products and quantities are added where the order lacks them. |
| "Same dog food as last time" | Only the lines of that order that match what they named. No match → unresolved. |
| "The usual" / "same as usual, plus 4 pool salt" | The order that clearly repeats (the same basket at least twice, strictly more often than any other; else the same products with a quantity only where it never varied). The customer's own extra line is kept. No clear usual → unresolved. |
| "Two bags this time" | The last order's product with quantity 2, only when that order had one product. |
| "Same location" | The most recent *verified* delivery address (reliable delivery order, or one staff typed), only when the order has no address and the customer gave none. |
| "Deliver somewhere else" | No address is reused; an address the order holds is dropped (or, if staff locked it, recorded as a conflict) until the customer gives a new one. |
| "A bag of dog food" | The customer's words stand unless exactly one history product fits (every word they wrote appears in it) or one clearly dominates (seen ≥2 times and ≥3× the next). The model may also *nominate* a history product for a generic phrase (`from_history`); the server accepts it only if that order was shown to it, really holds that product, and the product is the sole or clearly dominant one. A made-up reference is ignored. |

Rules: explicit current words always beat history; only **reliable** orders are sources (fulfilled, confirmed, or products a person corrected; never an
unconfirmed enquiry or a cancelled order); a quantity or address is never invented; ambiguity is left **unresolved**. An unresolved pointer flags the
order *Refers to an earlier order — check* (and, with no order open, records a note-only order carrying the customer's own words) instead of guessing. A
question ("is it the usual price?") never edits an order. Nothing taken from history confirms anything: the order stays *possible* / *awaiting confirmation*
for a person to verify. Backfill replays never use history.

Where it came from is tracked internally: the order's event carries `inferred: { items: [refs], delivery_address: ref, unresolved: [...] }`, shown in the
dashboard's History and in `!moreinfo` ("From earlier orders: products from #K3PD7"). Staff corrections improve later interpretations automatically because the
source is the corrected order row.

Cost: the existing reply/monitoring call gains a compact `CUSTOMER HISTORY` block (≤3 recent reliable orders, ≤5 repeated products, ≤3 addresses; roughly
150–250 input tokens) **only for customers who have reliable history**, plus ~120 tokens of rules. Resolution itself is deterministic (no call). One narrow
extra call: when the reply path's older "same as last time" check hands a turn to staff *without* asking the reply model, the small order-only call that
monitoring already uses reads the rest of the message ("…plus 4 pool salt") so the order book is not blind to it. Decisions and replies are unchanged.

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
| The business's own message in the chat (business phone / inbox) | Read only when an order is open and the wording could matter. It can only **flag** that order for a person (*staff wrote a confirmation / cancellation / change*; the report shows only the cancellation and change flags): it never creates an order, edits one, confirms or cancels one (the business phone cannot say *who* wrote, and staff verification stays a person's Confirm click), and does not count as customer activity. Never read: the agent's own sends coming back, and AI drafts (they are not messages). |

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

**This release needs one more small migration (`20261103000000_ai_agent_order_field_conflicts.sql`: a `field_conflicts` column and the same `apply_ai_agent_order`, now writing it) and no bridge change.** Run it after the two below, before deploying the app. The report simplification, order maintenance and customer order memory need **no further migration** (history lives in existing columns and event rows).

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
schedule, `!orders` and `!update` share no state apart from the data they read: any works without the others.
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
5. In the staff group, an authorized sender types `!orders`: today's and tomorrow's orders appear split by delivery/collection; `!orders overdue|missing|tomorrow|30 Oct` answer too. `!update` lists what is new. Then `!update #REF confirmed`, `!update #REF 2 bags`,
   `!update #REF delivery tomorrow`, `!order <name>` and `!moreinfo #REF` each answer in the group and change the Orders tab. A non-authorized
   sender gets a refusal; the commands in another group do nothing; no message ever reaches a customer.
6. Orders tab → *Post orders list now* behaves like `!orders`. Edit an order's address in the dashboard, wait for the previous update to be delivered and 30 s, `!update` again: the change is listed once.
7. At 8:00 St Lucia time one summary arrives (within a minute or so of the bridge's next poll); nothing further follows. The "Morning list" card shows the run and its delivery state. Switch tracking off and `!orders`: the list says it is incomplete.
8. Kill the bridge before 8:00, restart within 6 hours: the summary arrives once after restart.

## Known limits / follow-ups

* A saved contact name exists only if the business phone has the contact saved and the bridge has seen it (it reads contact events after connecting); until then the profile name, then the phone, is shown.
* A quantity set by command locks the order's products against the AI: if the customer later changes the quantity in WhatsApp, a person must update it (dashboard or `!update`).
* Dates: "today / tonight / tomorrow / day after tomorrow / a named weekday" and written dates ("30 Oct", "Oct 30th", "2026-10-30", "30/10/2026") become calendar days; "next Friday", a bare "28th", ranges and times stay as written (the order then shows as *no day*). Short slash dates ("30/10") are not read: "1/2 a bag" is a quantity.
* No retention job for fulfilled/cancelled orders yet (deleting a customer via the Memory tab does remove theirs).
* A customer's yes counts only if a person wrote to them (inbox, `!send`) in the last 48 h and exactly one order is open; a phone confirmation is a *Confirm* click.
* A staff message in the chat can raise a flag but never creates an order, so an order the customer only described in a voice note and staff then wrote out is
  recorded only once the customer says it in text (or staff add it in the dashboard).
* Customer memory reads `ai_agent_orders`, which starts filling when daily orders are switched on. Earlier orders only in the older `customer_orders` analysis
  table, or only in stored WhatsApp messages, are not used until "Recover missed orders" has brought them into the order book (history within the retention window).
* A generic phrase ("dog food") can only be mapped to a history product the model recognises and the server finds dominant; with several equally likely products it stays as written.
* "Usual" needs the same basket twice; a customer who varies every time has no usual order and is flagged for a person.
* Voice notes, images and stickers are not transcribed: media-only messages are counted (filtered) but carry no order text.
* Cost: AI-eligible turns carry ~350 extra instruction tokens and the open-order list; monitoring-only turns make one small call (~760 instruction tokens +
  open orders + 8 context lines, typically 1.2–1.5k input and 100–200 output tokens), capped per chat/business per hour.

## Order views and `!update`: deployment, notifications, website

**Migration (one, additive, idempotent):** `supabase/migrations/20261108000000_ai_agent_order_update_posts.sql` creates
`ai_agent_order_update_posts` (one row per `!update` answer: business, group, window, the outbox row that carried it). It
changes no existing row, column or function and switches nothing on. No existing order is migrated.
**Order:** run the migration in the Supabase SQL editor → deploy the app. (The old app ignores the table; the new app
needs it for `!update`.) No bridge change, no new environment variables, no settings. Roll back by deploying the previous app version; the table can stay.

**Which WhatsApp messages an order can cause (audit).** Every path below is a `staff_notice` to the staff/Orders group;
none can reach a customer.

| Path | When | Duplicate protection | Changed here |
|---|---|---|---|
| Approval request / escalation notice and its updates (`notifyStaff`, `decide.ts`) | A customer's order or question needs a person; an update when it materially changes (`diffSnapshots`) | Compare-and-swap on the escalation's `notified_seq` + outbox dedupe key; a redelivered batch cannot post twice | **Not suppressed** (Approval Pilot's drafts need these). Rapid messages are combined only when batching is on |
| Morning list (8:00) | Once per business per local day | `scheduled_key` unique per day; outbox dedupe key; an uncertain send is never repeated | Now the by-day list (today, tomorrow, counts of the rest), not every open order |
| `!update` | On request | `event_id` unique + outbox key; cooldown; the "since" point moves only on a provable delivery | Now a short change summary |
| `!orders` | On request | Outbox key = the WhatsApp message id per part | New |
| Command acknowledgements (`!update #REF …`, `!order #REF completed`) | One reply per command | Key = the WhatsApp message id | Unchanged |
| Dashboard "Post orders list now" | On request | Run row + cooldown | Now the by-day list |

**Root causes of the noise** (found by reading the code, not by measuring a live group):
1. `!update` and the 8 AM post both re-sent the **whole outstanding list**, so every use repeated every order; an order
   left the list only after 7 days without a customer message, and a *confirmed* order never did, so old orders piled up.
2. Orders were placed by the day the message was written (and "tomorrow" was left as the word), so yesterday's orders looked current.
3. Escalation updates are posted for every **material** change **per customer message** when `batching_enabled` is off
   (its default): a customer who sends "2 bags", "make it 3", "to Cap Estate" in four messages causes up to four
   notices. In Approval Pilot each carries a fresh draft to approve, so they are deliberately not suppressed.
   **Recommendation (a setting, not code): turn on batching** (`batching_enabled`, quiet period 45 s) so a burst is read once.
   `message_added` updates ("New message: …") are also posted; they cannot be told apart from "please call me" without a
   model call, so they were left alone.

The completion/reopen commands (`!order #REF completed|reopen`) were already in the branch and are reused unchanged; the
dashboard now offers the same two actions through the same function (`updateOrderManually`).

**Website (Orders tab).** Views: *Today, Tomorrow, Overdue, Missing information, No day, All outstanding, Completed,
Cancelled*, each with a count that uses the same rules as WhatsApp (`lib/aiAgent/orderViews.ts`), a banner with the
number of orders needing attention, orders grouped by day then Delivery / Collection, the day and delivery/collection
as badges, missing fields as chips, **Complete / Reopen** (existing admin authorization and version check), and, for
delivery orders, the customer's saved default delivery location (set by staff with `!location`) beside the order's own
address, flagged when they differ. It is only shown, never copied into the order. There is no second order table: the
page reads `ai_agent_orders`.

## Business defaults, identity and repair (Cool & Pool / dog food)

`lib/aiAgent/orderDefaults.ts` (pure, tested in `tests/aiAgentOrderBusinessRules.test.ts`) holds the rules. **A new order is stored with both defaults when it is created** (`withCreationDefaults`, using the order's `first_message_at` and the business timezone): `fulfilment_method = 'delivery'` and `requested_for = 'Thu 29 Oct (default)'` (or `(default, morning)` when the customer gave a time of day). The `(default…)` marker, and a `defaulted` entry in the order's creation event, tell an assumed day from a stated one; the stored day is read back as-is, so it never moves. A later message that only repeats a time of day keeps the day; a day the customer names replaces it; staff edits lock the field as always. **Orders created before this change keep empty columns and are still derived when read** (`effectiveDate` / `effectiveMethod`, same answer, same inputs), so no migration is needed.
apart, and no existing order needs migrating.

| Rule | Behaviour |
|---|---|
| Delivery | Every order is a delivery unless the customer explicitly asks to collect (`fulfilment_method = 'collection'` is kept). An empty method is shown as *Delivery (default)* on the website and in `!moreinfo`, is never "missing", and a default delivery needs an address. The AI never asks "delivery or collection?" and never offers pick-up (reply prompt, `missingOrderFields`, `askForMissingFields`). |
| Day | A day the customer named wins. Otherwise: written **before 9:00 AM** America/St_Lucia → that day, **at or after 9:00** → the next day, counted from the order's `first_message_at` (the customer's message time, never the processing time). A time with no day ("morning", "around 3pm") keeps its wording and takes the default day. Words that name no single day ("next week") stay as the customer's words and **are** reported as a gap. Because the date is a pure function of the order's own timestamp, it does not move at midnight or when a later message arrives; an old order simply becomes *overdue*. |
| Reports | `!orders`, `!orders missing/overdue/undated`, the 8 AM post, `!update` and the website all use `orderDate`/`orderGaps`/`effectiveMethod`. An assumed day is marked `🗓 default day` (WhatsApp) / `· default day` (website); "Missing:" lists only real gaps (products, quantity, address, an unreadable day). |
| Identity | Name: staff-entered → saved contact → WhatsApp profile name → a name the customer **wrote** (only when none of those exist; checked against their words) → the verified phone. Placeholders ("Unknown Contact", "customer"), numbers and JIDs are never stored as a name. `contact_number` is always the verified sender (`@lid` mappings untouched). |
| Alternate contact | A number the customer writes for the delivery (`contact_phone`, or a note that is only a number) is checked against their own words, excluded if it is the sender's own number, and stored in the notes as `Delivery contact: 758-123-4567`. It survives later turns and never replaces `contact_number`. |
| Location | Priority: the location the customer gives now → the staff-saved default (`!location`) → ONE unambiguous verified earlier delivery address (a confirmed/completed/staff-corrected order, or an address staff typed; if two different verified places exist none is used) → missing, flagged for a person. Applied automatically when the customer gives no location (not when collecting, not for "somewhere else", never over an address the order or staff already hold); "same place" works as before. The source is recorded in the order history (`inferred.delivery_address`: `saved location` or the order ref). Saved customer memory is read, never written. |
| Context | The order reader sees up to 16 messages from the last 72 h (was 8) and grounds against up to 30 of the customer's own recent messages (database read, no tokens). Reply path: the same wider grounding. Later explicit corrections win; older/other orders' chat is excluded by age. No extra model call. |

### Why orders were incomplete (root causes, from the code)

1. `computeMissing` treated *delivery/collection* as required, so every order where the customer simply said what they wanted stayed `possible` and was reported "Missing: delivery or collection".
2. A missing day was a "soft" gap that still showed as "Missing: day" and put the order under *No day given*; nothing assigned a day.
3. The customer-facing prompt and `askForMissingFields` asked "delivery or collection, and your preferred day and time", advertising pick-up.
4. The monitor path showed the model only the last 8 messages and grounded its output against those: an address or product given a few messages earlier failed grounding and was dropped, so multi-message orders looked incomplete.
5. Stored placeholder names (`Unknown Contact`, `customer`) passed the old name filter, and a name or alternate phone the customer gave had nowhere to go (no draft field), so numbers ended up as free-text notes.
6. "Same place" phrasings other than a few literal forms were not recognised, so the saved location was not consulted.

**Not verified:** orders `#SENYB`, `#ZWL67`, `#C7PX4`, `#6SNVT`, `#GQ4DQ`, `#T5KEJ` could not be inspected: this checkout has no database credentials. Run the repair preview (below) against production, which prints each order's changes, the customer's evidence and what still needs a person.

### Repairing existing open orders

The website's Orders page has an admin-only **Review existing orders** card: *Review* runs the preview (read-only), each order shows Now → Proposed values with the reason and the customer's words, nothing is ticked by default, there is no "apply all", and *Update N selected orders* asks for confirmation and applies only the ticked orders' previewed changes. Outcomes are shown per order (updated / skipped because it changed since the preview).

`GET /api/ai-agent/orders/repair?businessSlug=…` (admin only) **previews** what would change; `POST` with `{ businessSlug, approved: [{ orderId, fingerprint }] }`
applies exactly those. The planner (`lib/aiAgent/orderRepair.ts`) uses no model: it applies the rules to each order's stored conversation (the order's
source messages and the customer's messages between its first and last message).

* Proposes: collection when the customer asked to collect; a written day; a bare phone number in the notes → `Delivery contact:`; a placeholder name → a reliable profile name or cleared; "same place" → the staff-saved/verified address; `possible` → `awaiting_confirmation` when the only gaps were the old defaults.
* Never: touches completed/cancelled orders, overwrites staff-locked fields (listed as *skipped*), changes a confirmed order beyond name/phone-note cosmetics (surfaced as *review*), invents products/quantities/addresses (the customer's own messages are quoted for a person), or messages anyone.
* Safe to repeat: each order's fingerprint covers its version and every proposed value; a stale preview applies nothing for that order (`changed_since_preview`); the write is version-checked through `apply_ai_agent_order` with key `repair:<fingerprint>`; a second apply is a no-op. Each applied order gets an `order_repair` event (before/after, reasons, evidence) and an `order.repair` audit entry; `!update` does not announce repairs.

### Deployment

No migration is required (the `fulfilment_method` and `requested_for` columns already exist; older orders are derived on read; alternate contacts live in `notes`; `order_repair` is just a new event kind). Order: deploy the app → Orders page → *Review existing orders* for each business → tick the orders you agree with → update. No bridge change, no environment variables, no settings. Roll back by deploying the previous version (repaired
orders keep their audit trail).
