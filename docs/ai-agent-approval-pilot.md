# Approval Pilot and WhatsApp business learning

Staff can test, correct, approve and teach the AI entirely from the authorized WhatsApp staff group. The website
stays the audit, evaluation and knowledge-management dashboard. There is **one** AI agent, **one** send decision
(`planCustomerSend()` in `lib/server/aiAgent/customerSend.ts`) and **one** outbox. Nothing here adds a second send path.

Files: `lib/aiAgent/pilot.ts` (pure rules), `lib/server/aiAgent/pilot.ts` (drafts, approve / edit / reject / status),
`lib/server/aiAgent/teach.ts` (`!teach`, `!confirm`, `!discard`, passive extraction), `lib/server/aiAgent/staffGroup.ts` (routing),
migration `supabase/migrations/20261030000000_ai_agent_approval_pilot.sql`, tests `tests/aiAgentApprovalPilot.test.ts`
(and `test/approvalPilot.test.ts` in the bridge repo).

## Modes

| Mode | AI sends on its own | Staff-approved sends | Staff-group posts |
|---|---|---|---|
| Observe | never | never | notice + draft only, if `staff_notices_enabled` |
| **Approval Pilot** (new) | **never** | `!approve`, `!send <text>`, dashboard "Send to customer" | notice, draft, feedback |
| Assisted | yes (existing rules) | yes (existing rules) | all |

Observe and Assisted behave exactly as before (including the classic notice text and a quoted "send"). In Approval Pilot a
casual "send it" / "go ahead" is **never** a send; only an explicit `!command` is.

## Commands (staff group, Approval Pilot unless noted)

A message is a command only if it **starts** with it. Target an escalation by **quoting** one of its messages (notice,
draft post, confirmation) or by including its code `#E-XXXXX`. A command with no unambiguous target changes nothing and
says so. Two codes, or a quote that disagrees with the code, are refused.

| Command | Who | What it does |
|---|---|---|
| `!approve` | authorized | Sends the **exact current draft**. Bound to that draft's id and text hash (atomic SQL compare-and-set). Quoting a draft post approves that version; quoting the original notice approves version 1; a code alone approves the current draft. |
| `!approve v2` | authorized | Same, and refuses unless v2 is the draft the message resolves to. |
| `!approve confirm` | authorized | Required when the draft was marked "confirm the facts first". The staff attest the facts; recorded as `approved_after_confirm`. |
| `!edit <text>` | authorized | Creates a **replacement draft version** from exact wording. Sends nothing; it must be approved. The replaced version is kept as history. |
| `!send <text>` | authorized | Sends exactly that wording (existing behavior, same central policy). A bare `!send` is refused in the pilot; use `!approve`. |
| `!reject [wrong\|missing] [why]` | authorized | Drops the current draft. Nothing is sent. `wrong` / `missing` records the AI as factually wrong / missing information. |
| `!moreinfo` | authorized | A separate, detailed, **read-only** staff-group message: customer name and verified phone, the full current order (product, variant, size, quantity, delivery/collection, address, day), what is missing, recent order changes and cancellations, knowledge gaps and unverified claims, why the draft may be risky, the approval status, and whether the quoted draft is still actionable (a stale or replaced one is labelled **STALE**). Quote a notice, or add `#E-XXXXX`. Built from stored data: no model call, no change to the draft, order, request or approval, nothing to the customer. Works on a stale or closed request. Answers once per request every 45 s and at most 12 per business per 10 min (extra requests are silent and audited). |
| `!status` | anyone in the group | With a target: draft version, readiness, stale warning. Without: the open requests. Read-only. |
| `!teach [for 6h\|until YYYY-MM-DD] <fact>` | authorized (any mode) | Proposes a business fact (see below). Quote an escalation (or add its code) to tie the fact to the question it fixes. |
| `!confirm K-XXXX [replace\|keep]` | authorized, **only if** "WhatsApp confirmation" is enabled | Approves a suggestion into knowledge. |
| `!discard K-XXXX` | authorized | Rejects a suggestion. |
| `!note`, `!close`, `!takeover`, `!resume` | unchanged | |

"Authorized" = the sender's verified WhatsApp id is on the business's allow-list (`staff_authorized_senders`; matched on
the id/number WhatsApp reports, never a display name). Everyone else can still *write* an answer (information) and run `!status`.
In Observe the commands never speak in the group and never send; in Assisted `!approve` replies "only works in Approval Pilot".

## The staff notice

Short on purpose. One message per request:

```
#E-ABCDE · Jane

Customer: “2 bags of Monello chicken 15kg, delivered Friday”

AI suggests:
“Sure! What delivery address should we use?”

⚠️ It states a day or time that approved knowledge doesn't contain

!approve confirm · !edit <text> · !reject · !moreinfo
```

* The suggestion is the **exact** text `!approve` would send. The AI's internal reasoning, confidence, knowledge ids, order history and the full
  missing-field list are not shown: they are in `!moreinfo` and the dashboard.
* **Warnings** are only what a person must act on before approving (at most two): the draft states something approved knowledge does not back
  (price, stock, day/time, offer, a promise), it is a sensitive request, or the customer wants to cancel. A warning-free notice shows `!approve`;
  one with warnings shows `!approve confirm` (the approver attests the facts).
* No suggestion: `AI suggests: nothing — it needs a person to answer.` and `!send <text> · !moreinfo`.
* `!send`, `!status`, `!teach`, `!confirm`, `!discard`, `!note` and `!close` still work; they are just not repeated in every notice.

### One actionable approval per request

Rapid customer messages are batched into one turn (existing batching) and answered by **one** notice. When the customer later adds something that
matters (an order change, a question, a cancellation), staff get **one short replacement**:

```
#E-ABCDE · Jane — updated

Customer: “make it 3 bags”
Changed: Quantity changed: Monello Chicken 15kg 2 → 3

AI suggests (replaces the earlier one):
“Got it, 3 bags. Delivery or collection?”

Quote this message: !approve · !edit <text> · !reject · !moreinfo
```

The earlier draft is superseded (kept for Evaluation) and can no longer be approved; quoting it is refused and names the current one. A pleasantry or
a repeat posts nothing.

### Quiet messages

In Approval Pilot a message that needs no answer creates **no** request, notice or draft: a thank-you / "ok" / greeting, or small talk with no question.
It is still stored, still counted in Activity, and still updates the customer's orders. Never silenced: an order or order change, a cancellation, a
complaint or other sensitive topic, a question, or anything while staff already own the request.

### Dashboard approval queue

AI Agent page → "Pending approvals" (Approval Pilot only): each open request with the customer's latest message, the exact draft, and **Approve / Edit /
Reject / More info**. It is a second *view* of the same pilot, not a second send path: Approve calls the same `approveDraftCore()` as `!approve`
(central send policy, draft freshness, atomic id + hash compare-and-set, duplicate and unknown-send holds), the reply is the one `staff_relay` outbox
row (status `pending`, claimed by the bridge's poll), and the audit log records the admin. A stale draft shows "out of date" and cannot be approved;
an unconfirmed draft needs "I have checked these facts". One request at a time: there is no bulk action.

## What `!approve` checks (nothing relaxed)

Same policy as an Assisted `!send`: business match; agent enabled; Approval Pilot or Assisted (never Observe); contact scope /
allow / exclude; human takeover; recent human activity; safe text; sender authorized; **draft not stale** (any customer message
since the draft's basis); **draft not expired** (`valid_until`); not already sent, in flight, or of unknown outcome. Then the
approval and the outbox row are created in **one transaction** (`approve_ai_agent_pilot_draft`): a second approval, a retried
command, or an edit racing the approval finds the draft no longer current / the hash changed / the dedupe key taken, and sends
nothing. The bridge re-checks mode, kind, hold-after-unknown-send and the staff group on its side.
If the bridge provably did not deliver an approved reply (blocked, `not_sent`) the draft returns to *current* and can be approved
again through the full policy; an ambiguous send stays approved and is never retried.

## Business learning

Three ways in, one way out. A fact is **never** knowledge until it is approved.

1. `!teach <fact>`: creates a pending **candidate** (`ai_agent_learning_candidates`, source `whatsapp_teach`, confidence 1.0) with a
   `K-XXXX` code, the sender's verified id, timestamp, business, a kind guessed from keywords (no model call) and a 7-day proposal expiry.
   Already-known facts are not proposed again. A fact that overlaps an approved entry is flagged: a changed price needs
   `!confirm K-XXXX replace` (the old entry is **archived**, never edited) or `keep`; replace refuses unless exactly one entry overlaps.
   Stock/"today"/shortage wording is **temporary**: it gets an expiry (12h default, or `for 6h` / `until 2026-11-01`), becomes an
   *expiring* knowledge entry, and expired entries are no longer given to the AI. Instructions aimed at the AI, links, e-mails and
   phone numbers are refused.
2. **Passive extraction** (off by default; per business: *Off* / *Staff group* / *Staff group + this business's own messages in customer chats*).
   A staff-group message from an **authorized sender**, or the business's own outgoing message in a customer chat (never a customer's,
   never an excluded contact, never another business), is pre-filtered for free (factual wording, not a question/command, not our
   own post). Only then **one** model call (the existing staff-analysis call, max 12 per business per hour) classifies it. Only
   *durable* facts and *business-wide temporary* facts become **pending** candidates (confidence 0.5). One-off deals,
   customer-specific facts, conversation-only notes and anything with a phone number/e-mail/link are dropped. The chat text and chat
   id are **not** stored, only the extracted fact, source kind, message id and time.
3. Staff answers to escalations (unchanged): durable facts become candidates.

`!confirm` goes through the same `approveCandidate()` as the dashboard (duplicate check, conflict resolution, temporary facts,
atomic RPC), records `approved_via = whatsapp` and the approver's verified id, and is a **separate opt-in** (`knowledge_confirm_via_whatsapp`,
default off). When it is off, suggestions are approved on the dashboard Review tab. A suggestion nobody confirms lapses
(`expired`). Approved facts are in `ai_agent_knowledge` and therefore in the next customer turn's retrieval; nothing is re-entered.

## Evaluation

`ai_agent_pilot_drafts` keeps every draft version as an immutable snapshot (text, hash, readiness and reasons, the knowledge ids and
version it was written from, basis time). Decisions only set status/outcome/verdict fields. The Evaluation tab shows, per request:
the AI's draft exactly as staff saw it, the final approved reply (or the wording staff sent instead), the outcome (`approved_as_is`,
`approved_after_confirm`, `edited`, `rejected`, `replaced_by_staff_text`), the verdict **correct / missing information / factually
wrong**, and the knowledge candidates staff taught for that request (the gap). Verdicts: approved unchanged = correct (inferred);
`!reject wrong|missing` = staff verdict; an edit/own text that changes a price or time in the draft = factually wrong, one that adds a
price or time the draft lacked = missing information (both *inferred*); wording-only changes get no verdict. This works whether or not
shadow capture is on. Retention: see Refinements (90 days) and "Forget customer (with logs)".

## Settings (Setup tab → Agent)

Mode (adds *Approval Pilot*), "Notice facts staff mention on their own" (passive scope), "Authorized senders can confirm suggestions from
WhatsApp". Both new options default off.

## Refinements (migration `20261031000000_ai_agent_pilot_refinements.sql`)

* **Invalidation stays strict.** Any customer message after the draft (even "thanks") makes it unapprovable. The check now also uses the agent's own
  inbound event log, so it no longer depends on the bridge having stored the message.
* **Quoted `!approve`** needs no version or code: a quoted draft post approves that draft, a quoted notice approves v1 (refused if replaced), a quoted
  feedback message resolves the escalation's current draft. `!confirm` / `!discard` work whatever escalation (even a closed one) the quote points at.
  Approval is still the atomic id + hash compare-and-set.
* **Teach and confirm** by the same authorized person is allowed; `learning.approve` audit records `proposed_by`, `self_confirmed`, `sender_verified`.
  `!confirm` still needs the per-business opt-in.
* **Passive learning**: a verified authorized staff-group sender → verified candidate. The business account's own messages → `sender_verified = false`,
  confidence 0.3, only at scope "staff group + business account messages", always pending, never auto-approved, labelled UNVERIFIED in WhatsApp and the Review tab.
* **Verdict override** (Evaluation tab): an admin picks a verdict and must give a reason (3–500 chars); only for decided drafts; history is append-only
  (`ai_agent_pilot_verdict_history`) plus an audit entry; later automatic inference never overwrites it.
* **Retention**: draft wording (body, final text, notes, verdict note) is blanked after **90 days**; ids, hash, chat id, status, outcome, verdict and timestamps stay.
  A still-open draft is closed first, and a purged draft can never be approved. Runs from the existing due-batch sweep (2% of idle sweeps) via
  `purge_ai_agent_pilot_drafts()`. Forget Customer (with logs) still deletes drafts and verdict history. Not purged: `ai_agent_escalations.proposed_reply`
  and the shadow results (their own retention, or Forget Customer).
* **Test Again** (per pilot review): re-runs the request's first customer turn with today's approved knowledge through the existing simulation
  (same guards, cache per knowledge version, shared hourly limit). Shown as "Simulation" beside "Historical — AI draft as staff saw it"; nothing is sent, the draft is untouched.
* **Unsupported claims**: a draft is "customer-ready" only if prices, links **and** stock/availability claims, days/times and offers (free delivery, discounts)
  appear in the knowledge it cited (staff-answer drafts: in the staff's words or approved knowledge). Also, a ready draft whose cited knowledge was changed,
  archived or expired after it was written now needs `!approve confirm`. Staff-typed `!edit` wording is staff-attested and stays ready.

## Multi-message conversations and orders

The pilot keeps the conversation going; it never stops after the first approved reply.

* **One request per customer turn.** A reply to something staff approved is a **new** request (new `#E-` code, new AI suggestion v1), not an
  edit of the answered one. The order collected so far lives in the customer's open order request and is handed to the model every turn,
  so earlier answers are never asked for again.
* **Customer writes again before staff act.** The update notice now carries the AI's **fresh suggestion** (v2, v3…) for the new state of the
  conversation. The earlier version is superseded (kept for Evaluation). Quote *that* update to approve it; quoting an older notice or
  suggestion is refused and names the current one. If the AI has nothing to suggest the update says so and the old draft stays unapprovable.
* **Review mode.** In Approval Pilot the model is told staff approve every reply, so it always writes the next customer message (it no longer
  goes quiet because a request is open) and names what it is missing in `escalation_reason`.
* **Order slots**, gathered a step at a time: product and variant (and bag size), quantity, delivery or collection, delivery address (only for
  delivery), contact only if unknown, notes. Corrections win, cancelled items drop out, several products are kept. When nothing is left to
  ask, the draft summarises the order for staff and needs `!approve confirm` (stock, total and delivery are never promised by the AI). The AI
  never quotes a price, fee, time or stock unless approved knowledge says it, and never says an order is confirmed.
* **Not every message is an order.** Product, price, hours and delivery questions are answered from approved knowledge or flagged as a
  knowledge gap (`⚠️ confirm the facts`, with the reason) and no order is started.
* A draft that only asks for the next order detail is **customer-ready** (plain `!approve`); one that states a price, stock, day/time or offer
  without approved knowledge still needs `!approve confirm` or `!edit`.
* The notice is compact (see above). The order so far, what is missing and the risks are in `!moreinfo` and the dashboard.

## Rollout stages (existing controls only)

| Stage | Setting | Result |
|---|---|---|
| 1. Personal testing | Mode *Approval Pilot*, contact scope *Selected*, **one** *Allow* rule (your test customer), your number in *Authorized senders* | Only that chat reaches the AI; every reply needs `!approve` |
| 2. Selected customers | Add *Allow* rules one by one (Setup → Contacts) | Same approval for every reply |
| 3. Supervised automation | Not built or enabled. Would be a per-customer, per-step opt-in on top of *Assisted*, using verified knowledge only; order finalisation, payments, complaints, exceptions and unverified facts stay staff-controlled | — |
| 4. Broader automation | Not built or enabled | — |

Any contact that is not allowed gets no reply, no draft and no staff notice (`contact_not_permitted`).

## Deployment order

0. The bridge **must** poll `/outbox/claim` in this mode and know `approval_pilot` (bridge commit "Approval Pilot mode" after `e1ee0e7`). Notices from batched
   turns and approved replies are `pending` until it does; messages queued while an older bridge ran are delivered, once, when the new one starts.
1. Deploy the **bridge** (WhatsappOperation) with Approval Pilot support. Until then it fails closed in that mode (sends nothing).
2. Run `supabase/migrations/20261030000000_ai_agent_approval_pilot.sql`, then `20261031000000_ai_agent_pilot_refinements.sql`, in the Supabase SQL editor (after the 20261022–20261029 agent migrations).
3. Deploy this app. Nothing changes until an admin picks *Approval Pilot* for a business; every setting defaults to today's behavior.
4. Add the approvers' numbers to the staff allow-list. Switch the business to Approval Pilot.

## Limitations and product decisions

* **Staleness is conservative**: any customer message after a draft (even "thanks") makes it unapprovable; staff `!edit` a new one.
* **Notice and updates**: the concise format is for Approval Pilot only. Observe and Assisted keep their existing notice wording.
* `!teach` / `!confirm` can be done by the **same** person. Requiring a second approver is a product decision.
* WhatsApp confirmation of knowledge lets an authorized sender add knowledge the AI will state to customers without an admin. It is off by default.
* In Observe the group is never spoken to, so `!teach` there only records a suggestion for the dashboard.
* Messages sent from the business account itself (customer chats, or the linked phone in the staff group) never identify *who* wrote them,
  so they are never treated as authorized staff facts: with the widest opt-in they become **unverified** pending suggestions only (see Refinements).
* Verdicts from edits are heuristic (prices and times only); an admin can override one (see Refinements).
* Dashboard "Send to customer" in the pilot is an admin's explicit send under the same policy.
