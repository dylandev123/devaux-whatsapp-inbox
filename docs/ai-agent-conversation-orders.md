# Conversation-based order understanding

The agent reads a customer's and the business's messages as **one evolving conversation**, keeps the order book accurate from it, and
remembers what the customer has verifiably bought. It builds on [order understanding](ai-agent-order-understanding.md) and
[daily orders](ai-agent-daily-orders.md); it adds no new AI agent and **no migration**.

What did not change: nothing here can create a customer-bound message (no outbox item of kind `customer_reply`, `holding_reply` or
`staff_relay` is produced), Approval Pilot is untouched, staff-only commands are still authorized by the verified allow-list, every write
is version-checked and idempotent through `apply_ai_agent_order`, and every business is isolated.

| Area | Where |
|---|---|
| Reading staff questions and customer answers; the latest confirmed product; "send me one bag"; what staff state | `lib/aiAgent/orderConversation.ts` (pure rules, no model) |
| Writing an answer or a staff statement into an order (locks, conflicts, late messages) | `applyFieldPatch`, `applyConversationAnswer`, `applyStaffChanges` in `lib/server/aiAgent/orders.ts` |
| Wiring | `trackOrders` (step 0b, generic products), `monitorCustomerTurn` / `monitorStaffMessage` in `lib/server/aiAgent/orderMonitor.ts` |
| Read-only review of existing orders | `lib/aiAgent/orderReview.ts` |

## 1. Staff questions and customer answers

Read **by rules** from the conversation lines the server already loads (`recent`, with quoted replies). Examples:

| Staff | Customer | Result |
|---|---|---|
| "Which bag did you want, Bandit 25kg?" | "Yes, that one." | the order's product is **Bandit 25kg** (quantity kept) |
| "Where should we deliver?" / "What's your delivery address?" | "Cap Estate" | delivery address **Cap Estate** |
| "How many bags?" | "two" / "just one" / "3 bags please" | quantity set on the one line that has none |
| "Would you like us to put you down for tomorrow?" | "Yes sure" | the delivery day, counted from the **staff message's** time in America/St_Lucia (existing rule) |

* **A staff suggestion nobody answered is never a confirmation.** Only the customer's own explicit answer counts. A weak "ok"/"sure"/👍
  counts only when a yes/no question named exactly one product.
* **Two products and a bare "yes" picks neither.** The order is left alone and flagged `customer_answer_unclear` with the question and the
  answer in its history. "The monello one" / "the 25kg one" picks the one it names.
* The reply must directly follow the staff message (nothing from the customer in between), within 12 hours, **or quote it** (up to 72 hours).
* A reply that is not a plain answer (a question, a change of mind, a longer request) goes through the normal order reading.
* An answer needs exactly one order that needs that detail (or exactly one open order); with several, nothing is guessed
  (`order_answer_ambiguous_order`). A short reply is never turned into a second order.
* No `!teach` is needed. The reply costs **no model call**: the monitoring path skips the model when the turn is an answer.
* **"Which one?" vs "do you want the X?"**: if the order says "dog food" and staff ask *which* bag, a yes refines the line. A yes/no
  question never replaces a different specific product ("Monello Chicken 25kg"): that becomes a conflict for a person.
* What it records: event `conversation_answer` with `answer_source` (the staff question, its time and WhatsApp id, the customer's words) and
  both message ids; `!moreinfo` shows "Product from the chat: staff asked …, the customer replied …".

## 2. Customer purchase memory ("one bag", "same as last time")

Reuses the existing verified order history (`ai_agent_orders`, found by the customer's identity and **this business only**); no new store.

* Only **verified purchases** are a source: fulfilled or confirmed orders, or products a person corrected. Quotations, products only
  discussed, cancelled orders and unconfirmed drafts are never a source.
* A request that names no product ("send me one bag", "a sack") is resolved in this order of trust:
  1. the one product already on this order;
  2. the product the customer **explicitly confirmed in this conversation** (a staff question that named it and their yes), the latest one;
  3. the customer's only verified product.
  **Several plausible products is never a choice:** no product is added, the request is kept as a note on the order, flagged
  `history_unresolved`, and `!moreinfo` says which products it could have been.
* The source is recorded on the order's history (`product_source`: conversation, earlier order reference, or the order itself) and shown in
  `!moreinfo` ("Product chosen: … the customer confirmed it in this chat").
* "Same as last time", "my usual" and "same location" behave as before. Nothing here writes to the customer's saved location,
  preferences or memory: a purchasing pattern from one conversation never becomes a permanent preference.

## 3. What staff state

A staff message in a customer chat is read once by the existing small order model call (only when an order is open and the wording could
matter) and by rules for delivery days. It no longer raises the generic warning.

| Staff message | Result |
|---|---|
| A **statement** of what is or will be done: "We'll send 2 bags of Bandit 25kg to Cap Estate", "I've put you down for collection" | applied to the order, event `staff_change_applied` (actor `staff`), staff message id and words kept as the source; the order's status is kept and a staff message is not customer activity |
| "We will deliver tomorrow" | the delivery day, by rules, from the message's own time (unchanged) |
| A **question, offer, suggestion or hedge** ("Would you like…?", "Which bag…?", "we might…", "I can check…") | nothing |
| A statement that cannot be mapped to a field | flag `staff_change_unclear`, with the staff words in the order's history and in `!moreinfo` |
| "Confirmed" / "cancelled" | still only a flag to verify (`staff_confirmed_in_chat` / `staff_cancelled_in_chat`) |

* Every value must be in the staff words (the same grounding as for customers); a value the model made up is dropped.
* The retired **"Staff changed in chat — check"** (`staff_changed_in_chat`) is never raised again. It is still displayed on old orders and is
  cleared when an understood staff change is applied to the order.
* Chat statements do **not** lock fields (locks are for people editing in the dashboard).

## 4. Locks, conflicts and ordering

* A field a person edited (locked) is never overwritten. A customer answer or a staff statement that contradicts it is recorded in
  `field_conflicts` with who proposed it (`source`: `customer` / `staff_chat`), the value, the current value and the words (`evidence`). The
  report says "Customer asked for a change" or "Staff wrote a different detail in chat than the order has"; `!moreinfo` shows the words.
* A **late** message (a newer customer message was already processed) may fill an empty field but never replaces a value.
* A redelivered message or reply changes nothing the second time (idempotency keys `<event>:answer`, `:staffchange`, `:answerflag`).

## 5. `!update` is retired

* `!update` (alone and with an order) is no longer handled anywhere: not in the staff group, not in the Orders group, not in `!rules`/`!help`,
  not in the dashboard text. Typing it is ordinary staff chatter.
* `!orders` is the operational report. The 8 AM summary (`runScheduledSummary`), its catch-up/miss rules, the dashboard's *Send summary now*
  and the outbox notifications are untouched.
* The order actions that lived under it are now `!order #REF confirmed | cancelled | 2 bags | delivery tomorrow` (the **reference is
  required**; a name or phone only searches).
* The table `ai_agent_order_update_posts` and its rows are kept as history; nothing writes to it any more. No data was dropped.

## 6. Review of existing orders (read-only)

Orders → *Check orders against their conversations* (`GET /api/ai-agent/orders/review`, admin only) now also suggests, with the messages as
evidence and a before → after:

* **Address answered in chat**: staff asked, the customer answered, the order has no address;
* **Product confirmed in chat**: a staff-named product the customer confirmed;
* **Quantity answered in chat** / **Quantity corrected**: a number given later, "make that 3", or one staff stated;
* **Staff warning can be cleared**: the old generic staff warning, when what staff wrote reads plainly (a delivery day or a quantity);
* plus the existing might-not-be-an-order, staff-agreed delivery day and unresolved-photo findings.

It makes no model call, writes nothing, and ignores orders staff edited, confirmed, completed or cancelled. **No production order is
repaired automatically.**

## 7. Deployment and rollback

No migration, no new environment variable, no setting, **no bridge change**. Deploy the app. Roll back by deploying the previous app
version: events written by this release (`conversation_answer`, `staff_change_applied`, the new `answer_source` / `product_source` entries) are
ordinary rows the old code ignores, and the attention codes `staff_change_unclear` / `customer_answer_unclear` fall back to a plain-text label.
Anyone who used `!update #REF …` should use `!order #REF …` from this release on.

### Limits

* Product names staff mention are recognised from the customer's verified history, the open orders, or a **capitalised name next to a weight**
  ("Bandit 25kg"); a lower-case product the customer has never bought is not recognised and is left to the normal order reading.
* A staff statement is only read when an order is open and the wording has an order signal (a number, deliver/send/bring/collect/…); other
  staff messages are skipped for cost.
* The business phone cannot say *which* person wrote a staff message; a statement is therefore applied as "staff", never as an authorized
  dashboard edit, and never locks a field.
