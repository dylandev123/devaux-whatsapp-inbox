# Order understanding: intent, staff-agreed days, photos, South Deliveries

Improves how the Inbox reads whole conversations for orders. It builds on [daily orders](ai-agent-daily-orders.md) and changes
nothing about who may reply: **no customer-facing message is ever created by any of this**, Approval Pilot is untouched, and every
write goes through the same version-checked `apply_ai_agent_order` with an idempotency key. **No migration is required.**

| Area | Where |
|---|---|
| Is it an order? (confirmed / possible / not an order) | `lib/aiAgent/orderIntent.ts` (rules), wired in `trackOrders` |
| Delivery days stated by staff or accepted by the customer | `lib/aiAgent/staffDelivery.ts` (rules), `applyDeliveryDay` in `lib/server/aiAgent/orders.ts` |
| Photos ("this one") | `lib/aiAgent/orderImages.ts` (rules), `lib/server/aiAgent/orderImages.ts` (fetch + one vision call), `readTurnPictures` / `loadRecentMessages` in `context.ts` |
| South Deliveries | `lib/aiAgent/deliveryRegions.ts`, `lib/aiAgent/orderViews.ts`, Orders dashboard |
| Review of existing orders (read-only) | `lib/aiAgent/orderReview.ts`, `GET /api/ai-agent/orders/review`, Orders → "Check orders against their conversations" |

Deterministic rules decide timestamps, location grouping, display formatting, intent guards and day resolution. The only model
calls are the ones that already existed (the reply call / the small order-reading call) plus **at most one small vision call per
customer photo, ever** (cached).

## What the live data showed (read-only, 28 Oct 2026)

* **Migrations.** `supabase migration list` is meaningless here (migrations are applied by hand in the SQL editor). The real
  schema was checked instead: every `ai_agent_order*` table exists, including `ai_agent_order_proposals` and
  `ai_agent_order_feedback` from `20261109000000`. Nothing in this change needs a new one.
* **Saved contact names.** 0 of 13,938 stored `cool_pool` messages (0 of 1,499 `customers`) carry `business_contact_name`, in 1:1 `@lid`
  and phone chats alike, while profile names (`contact_name`) are present on almost every inbound row. The Inbox already reads all three
  name sources and ranks them (staff-set → saved contact → profile → name the order recorded), so the gap is upstream: the Baileys bridge
  is not delivering address-book names to the rows it saves. The bridge code (`src/whatsapp.ts`, `updateContactNames`) handles
  `contacts.upsert` / `contacts.update` / `messaging-history.set` and logs a `contact event: received=… withSavedName=… mapSize=…` line.
  The bridge runs on a server this session cannot reach, so **nothing was changed or deployed there**. Next step for a person:
  `docker logs devaux-whatsapp | grep "contact event"`. `withSavedName=0` means WhatsApp is not sending names to that linked session; a
  non-zero count that never reaches the rows would point at the in-memory-only map being emptied on restart.
* **#JXBDS (Soco House).** Only two messages are stored for that chat: "Morning" and `It is 3" tablests and chlorine powder- one pail
  each`. There is no invoice text and no staff reply stored (the earlier exchange is not in the database). "It is …" reads as an answer to a
  question nobody stored, so under the new rules it is **held for review**, not an active order. The order itself was not touched.
* **#KBNYW (Maddie).** The customer's photo is a screenshot of a **Bandit 25kg** bag (brand, "OMEGA 6" and "25kg" printed on it), captioned
  "This one 55lbs". Staff said "Yes we can deliver the dog food", "It'll have to be tomorrow as our driver leaves at 9am every morning" and
  "Would you like us to put you down for tomorrow" (11:01 local, Tue 27 Oct); the customer replied "Yes sure", quoting that question. The
  order holds the product "This one" and no day. The agreed day is **Wed 28 Oct**. The order was not touched; the review panel lists this
  as a suggestion.

## Customer names

* Ranking (unchanged): staff-set name (the order's locked name, or one staff typed on the customer profile) → saved contact name →
  WhatsApp profile name → the name the order recorded. Unreliable values (numbers, JIDs, placeholders) never win; the phone is the fallback.
* A name whose origin was not kept is now source `order`, no longer mislabelled as a profile name. `saved` is only used for a value that
  really came from `business_contact_name`.
* The "Name: WhatsApp profile name" style line is gone from `!order #REF`; the dashboard never showed one. Staff name corrections are
  locked and still win.

## Is it an order?

For a **new** order candidate, `classifyOrderIntent` looks at the customer's words, the recent lines (staff included), quoted replies and
the draft:

| Result | When | What happens |
|---|---|---|
| confirmed | explicit request ("I need…", "please send/deliver…", "put me down for…"); a customer accepting a staff delivery offer; "same as last time"; a plain order the model read as one with nothing against it | normal order |
| possible | the message is an *answer* ("It is …", "That's the one"); a follow-up to invoice/quote talk; a product that is only "this one" with no readable photo; the model did not read it as an order | kept with attention `review_order_intent`, **on no delivery list**, shown under Review / `!orders review` / "Might not be an order" |
| not an order | invoice, quotation, receipt, payment or account talk; a price or availability question; a product question; no request in it | no order is created (`order_not_created_non_order` on the event) |

A request that names goods before paperwork ("send 3 pails of chlorine and the invoice") is still an order; "send the invoice for 3
pails" is not. Nothing here cancels, deletes or demotes an order that already exists. Staff pressing **Confirm** clears the review flag;
**Cancel** closes it; a later explicit request on a held order, or staff offering delivery and the customer accepting, releases it.
The model prompts also say invoice/quotation/price/product-question talk is not an order and explain the `(replying to …)` and
`[photo — …]` notes.

## Delivery days from staff conversations

`readStaffDeliveryDate` reads a staff message **by rules**: a *commitment* ("we will deliver tomorrow", "driver will bring it Friday",
"delivery is scheduled for 30 Oct"), an *offer* (a question, a hedge such as "might"/"hopefully"/"if possible", or "it'll have to be
tomorrow"), or *nothing* (refusals, "every Friday" policies, collection times, past deliveries, "next Friday", a weekday said on that
same weekday, two possible days). The day is counted from **that message's own timestamp in America/St_Lucia** (so "tomorrow" at 22:30
local = 02:30 UTC is the next local day, not two days on).

* A commitment sets the day of the chat's **one** open order (several open orders → not guessed). It never overwrites a day staff edited
  (locked field), and never one that was changed after the staff message. It is not customer activity (`last_message_at` is unchanged).
* An offer changes nothing until the customer's bare "yes" (a quoted staff message when the bridge supplied one, otherwise the last staff
  line with nothing from the customer in between, within 12 hours). The day is the one the *offer* meant.
* History keeps the provenance (`delivery_day_agreed` event, `date_source` = staff commitment / offer accepted, the staff message id and
  words). Operational order details show **only the date**. "(default — no day given)" and "default day" wording are gone from `!order #REF`
  and the dashboard; the stored `(default)` marker still exists internally so the before-9-AM / tomorrow default keeps working, and is not
  presented as the customer's request.

## Photos

A photo is read only when the customer's words point at it ("this one", "the one in the picture", "same as the photo"), it is the customer's,
it is under 24 hours old, and the address is an image file in **this business's** `/media/<business>/` folder on `WHATSAPP_MEDIA_ORIGIN`
(any other business, host, query string, path trick or credentials in the address is never requested). At most 2 per turn, 4 MB each, 8 s
fetch timeout, 40 reads per business per hour, 2 attempts per photo. The one vision call (model from `AI_AGENT_IMAGE_MODEL`, else the
configured AI model) is asked to transcribe only readable label text; the server keeps a product or size only if its words are in that
visible text. The reading (label text and product name, never the image) is stored in `ai_agent_audit_log` (`orders.picture_read`) and
reused by every later turn, retry or replay. The order reader sees `[photo — label reads: “Bandit”, “25kg”; product: Bandit]`; label text
can ground a product, variant or size but **never a quantity, address or day**. An expired, missing, oversized, unreadable or non-image
photo, or a missing model, simply gives `[photo — not read]` and no product. Voice messages are marked `[voice message — not transcribed]`.
Photos are never stored by the Inbox, shown to another business, or sent anywhere except the vision call.

## South Deliveries

Under each date, deliveries to a reviewed southern destination are listed together under **🧭 South Deliveries**, grouped by where
they go (Vieux Fort, Laborie, Choiseul, Soufrière, Micoud); everything else stays under Delivery and collections stay under Collection.
Each order appears once. It works in `!orders` (today, tomorrow, a date, all, overdue) and in the dashboard, and is computed from the
**current** address on every read, so an address correction moves the order by itself. No address, an unlisted place, a place that exists in
more than one part of the island (Belle Vue, Union, La Ressource, Beausejour…) or an address naming a southern *and* a northern place
(or two southern districts) is **never** treated as south.

**The table needs the business's sign-off.** `SOUTH_LOCATIONS` in `lib/aiAgent/deliveryRegions.ts` was written from Saint Lucia's
district geography, kept deliberately short (district seats plus localities I am confident about), and is data, not logic. Edit it, or set
`AI_AGENT_SOUTH_LOCATIONS_JSON` (`{"south":[{"group":"Laborie","names":["Laborie"]}],"ambiguous":[…],"nonSouth":[…]}`); a malformed value
falls back to the built-in table and can never switch the safeguards off.

## Reviewing existing orders (read-only)

Orders → **Check orders against their conversations** (`GET /api/ai-agent/orders/review`, admin only) loads each outstanding order's stored
conversation and lists suggestions with the messages that support them: might not be an order, a delivery day staff stated or the customer
accepted, a "this one" order whose photo shows a product. It makes no model call (it only reads picture readings that already exist), writes
nothing, and ignores orders staff edited, confirmed, completed or cancelled. Customer memories, staff locks and approved corrections are
never touched. A person applies any change with the normal Orders actions (or `!update`). **#JXBDS and #KBNYW were not repaired.**

## Deployment and rollback

* No migration. No bridge change. New optional settings: `WHATSAPP_MEDIA_ORIGIN` (already required by the media proxy; picture reading
  does nothing without it), `AI_AGENT_IMAGE_MODEL` (optional; the model must accept images), `AI_AGENT_SOUTH_LOCATIONS_JSON` (optional).
* Rollback is a plain redeploy of the previous Inbox build; nothing in the database depends on it. Orders flagged `review_order_intent`
  are ordinary rows: after a rollback they show as normal orders with an unknown attention text, and the staff can confirm or cancel them.
* The new `!orders review` view and the Review tab are the only new staff-visible surfaces.

## Limits

* Staff commitments are read by rules, not understanding: a commitment phrased in an unusual way is simply not applied (the order keeps
  its day; the normal staff-flag reading still runs). Conversely nothing doubtful is applied.
* A staff commitment that arrives while the chat has no open order is not applied retroactively.
* Voice notes are not transcribed. Photos are only read when words point at them.
* The vision call needs a model that accepts images; otherwise photos read as "not read".
