# Compact approvals + all-conversation order monitoring: rollout

What changed (details in `docs/ai-agent-approval-pilot.md` and `docs/ai-agent-daily-orders.md`):

* **Approvals**: short staff notices, `!moreinfo`, one actionable approval per request, quiet acknowledgements, a dashboard approval queue.
* **Orders**: every genuine 1:1 customer conversation is read for orders, independent of AI reply permission, plus the business's own messages
  (as flags only), honest coverage (failures, bridge gaps, budget), and an opt-in backfill.

Nothing is enabled by this release. Every setting keeps its value; the only new table is empty.

## Order

1. **Migration** (Supabase SQL editor, after 20261022–20261101 are applied):
   `supabase/migrations/20261102000000_ai_agent_order_monitoring.sql`. Additive: one table (`ai_agent_order_backfill_runs`). No existing table, column or
   function changes, so the old app keeps working if you run it first.
2. **Deploy the app.** No new environment variables are required. Optional: `AI_AGENT_ORDER_MONITOR_MODEL` to run monitoring-only analysis on a cheaper model
   than the one configured in AI Settings (unset = the configured model).
3. **Bridge**: no code change is required if it already follows `docs/ai-agent-bridge-contract.md` (forwards every inbound 1:1 message and human `fromMe`
   message for a business with `forwardMessages: true`, and does not pre-filter by contact scope). Verify with check 1 below; the report's coverage note
   also flags any message the bridge stored but did not forward.
4. Turn it on per business (Setup → Daily orders → "Track orders from ALL customer conversations"). Existing tracking businesses get the new behavior as
   soon as the app is deployed, because tracking already meant "on".

## Live WhatsApp checklist (use a test business or a test number first)

1. **Non-allow-listed customer**: with the business in Approval Pilot and contact scope *Selected* (your test customer NOT allowed), a test number sends
   "2 bags of Monello chicken 15kg delivered to <address> Friday". Within ~a minute (or the batch quiet period): Orders tab shows the order; Activity shows the
   event with `orders_monitor_new_message`; **nothing** is posted in the staff group and **nothing** is sent to the number.
2. **Manual Only / takeover / excluded**: repeat with the customer set to Manual Only, then on takeover, then excluded: same result each time.
3. **Rapid messages**: send "2 bags", "of chicken 15kg", "delivery Friday" in 10 seconds: one order, one monitoring call (Activity), no notices.
4. **Follow-up**: "make it 3 bags": same order, quantity 3 (History shows before/after). A clearly different second order: a second record.
5. **Pleasantries**: "thanks!" produces no AI call (event reason `orders_monitor_skipped_acknowledgement`) and no notice.
6. **Staff message**: from the business phone write "Confirmed, we'll deliver Friday": the order gets *Staff wrote a confirmation in WhatsApp* under Needs
   attention and stays unconfirmed. Press Confirm in the dashboard to finalize.
7. **Customer yes**: staff write "shall I confirm?", the customer replies "yes": the order is flagged *Customer replied yes*, not confirmed (customer
   confirmation stays off).
8. **Report**: `!orders all` in the orders/staff group lists the order by the day it is for (a healthy list carries no coverage line). Switch the bridge's forwarding off for a minute, send a message, `!orders`: the report warns that a message reached the inbox but not the agent.
9. **Approval notice** (AI-eligible customer, Approval Pilot): the notice is the compact format; quote it with `!moreinfo`: one detailed message, the draft
   unchanged; `!moreinfo` again within 45 s: nothing. A non-authorized member's `!moreinfo` gets the refusal.
10. **One approval per request**: send a question, then (before approving) "also, do you deliver to <area>?": one short "— updated" notice. Quote the OLD
    notice with `!approve`: refused and names the current draft. Quote the new one: sent once.
11. **Dashboard queue**: the same request appears under "Pending approvals"; Approve sends once; a second click sends nothing.
12. **Backfill (optional)**: Orders → Recover missed orders → 24 h: progress counts, orders appear, nothing is sent; run again: nothing new.

## AI cost impact

* AI-eligible conversations: **unchanged** (they reuse the one existing call).
* Conversations the AI may not answer (new): at most one small call per relevant message or batch of rapid messages. A free pre-filter skips pleasantries,
  media-only messages and chatter with no order wording while no order is open; with an open order any real message is analysed (a follow-up may change it).
  A call is roughly **760 instruction tokens + open orders + 8 context lines + the new text: typically 1.2–1.5k input and 100–200 output tokens**,
  about a quarter to a third of a full reply call (which also carries the knowledge base, memory and a longer transcript).
* Hard caps: 20 calls per chat and 300 per business per hour; beyond that messages are recorded as not analysed and reported (never silently dropped).
* Illustration (not a measurement): 150 order-relevant messages a day from non-allow-listed customers ≈ 150 × ~1.4k ≈ 0.2M input tokens a day.
  Staff-message analysis adds a call only when an order is open and the wording could matter. The backfill is one small call per 25 messages, per
  conversation (max 6), and is manual.
* Set `AI_AGENT_ORDER_MONITOR_MODEL` to a cheaper model to reduce this further.

## Remaining limitations

* Excluded contacts are monitored for orders, as requested ("excluded from AI replies"). If some excluded numbers are personal contacts, their text is sent to
  the AI provider for analysis; there is no per-contact "do not monitor" switch yet.
* Staff messages only flag (verify and press Confirm); they never create or change an order. An order described only in a voice note and then written out
  by staff is recorded when the customer confirms it in text or staff enter it in the dashboard.
* Voice notes, images and stickers are not transcribed.
* A message the bridge never stores or forwards is invisible; the coverage note can only detect messages the bridge *stored* but did not forward.
* Backfill only reaches back as far as `whatsapp_messages` retention (messages are purged after about 7 days), at most 72 hours, 200 conversations per run.
  Run records keep conversation ids (never message text) and "Forget customer" does not remove them.
* Pre-filtering is heuristic (wording cues). It errs towards analysing, and any open order always analyses, but a first order phrased with none of the cue
  words (digits, order/want/need/bag/kg/deliver/collect…) is not picked up until a later message carries one.
* The hourly budget uses the audit log, so a failing audit write would weaken the cap (it is logged, and the model is still the only cost).
* `!moreinfo` throttling is per request (45 s) and per business (12 per 10 min); the business-wide ceiling is silent.
