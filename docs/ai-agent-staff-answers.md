# Staff answers: two-way control and learning

How an answer in the staff WhatsApp group becomes (a) a drafted customer reply
that is sent only on explicit authorization and (b) classified information that
is learned only where it belongs. It builds on the existing escalation flow, the
Inbox decision engine, approved knowledge, customer memory and the outbox — no
second agent and no second memory.

Code: `lib/aiAgent/staffAnswers.ts` (pure rules), `lib/aiAgent/engine.ts`
(matching, send policy), `lib/server/aiAgent/staffGroup.ts` (flow),
`staffKnowledge.ts` (analysis + storage), `learning.ts` (admin approval),
`model.ts` (`analyzeStaffAnswer`). Migration
`supabase/migrations/20261026000000_ai_agent_staff_answers.sql`.

## 1. Routing: a reply belongs to exactly one escalation

Every escalation has a unique reference (`#E-XXXXX`, unique across businesses),
its business, customer chat and contact, and the WhatsApp id of the notice the
agent posted for it. A staff message is tied to an escalation by:

1. **a quoted reply** to any message the agent posted for it (its notice, a
   follow-up, a draft, a confirmation) — resolved through the acked WhatsApp id
   in the outbox, within the business; else
2. **an explicit `#E-XXXXX`** in the text.

No reference, an unknown reference, two references, or a quote and a code that
disagree: nothing happens and nothing reaches a customer. The customer's name and
the most recent escalation are never consulted, so simultaneous escalations stay
isolated. Messages carrying the agent's own headers are ignored as echoes; the
bridge's echo check (WhatsApp id, then identical text) runs first.

## 2. A reply is information; sending needs authorization

| Staff writes | Meaning | Customer messaged? |
|---|---|---|
| plain text (quote or `#E-…`) | an **answer**: recorded, drafted, classified | never |
| `!send`, or just `send` / `send it` / `go ahead` | approve the draft (the quoted one, or the escalation's newest) | only if every policy passes |
| `!send <text>` | send this exact wording | only if every policy passes |
| `!note`, `!close`, `!takeover`, `!resume` | unchanged | no |

The draft is one model call (same model and key as the Inbox engine) that
rewrites the staff answer as a short, natural reply using the customer's
conversation. It may only use facts in the staff's words; a deterministic check
rejects any price or link the staff did not state and any stock/payment/delivery
promise the staff did not make (`checkStaffDraftSafety`).

A customer message is created only if **all** hold (`decideCustomerSend`):
agent enabled and **Assisted** mode; contact scope / allow / exclude;
no human takeover; no human message in the chat within
`auto_takeover_minutes`; a safe draft; a draft not older than the customer's
latest message (a newer message or escalation makes it stale); the same text not
already sent or in flight (a provably unsent attempt may be retried; an
unconfirmed one never is). Staff-group posting is a separate permission
(`canSendStaffNotice`): in Observe it needs `staff_notices_enabled`.

Otherwise the draft is posted with the reason in plain words ("Not sent: …") and
how to proceed. Reason codes are kept off WhatsApp (they are in the admin
dashboard). If the bridge later reports an authorized reply as not delivered
(global kill switch, unknown-send hold, rate limit…), the app tells the group.

Repeats: one staff message is one answer per business (unique
`(business_slug, source_message_id)`); the identical draft for an escalation is
posted once; at most 8 drafts per escalation are posted; an identical customer
text is queued once.

### Who may authorize a send (per-business allow-list)

Only senders on the business's allow-list (`ai_agent_settings.staff_authorized_senders`,
edited on the Agent settings card) can make the agent message a customer —
`!send`, `!send <text>`, or a bare "send" / "go ahead". **The default is empty:
nobody.** Anyone in the staff group can still write an answer (it becomes a
draft); an unauthorized `!send` is recorded, answered in the group ("you're not on
this business's list…"), not learned from, and sends nothing. `!note`, `!close`,
`!takeover` and `!resume` are not customer sends and are unchanged.

A sender is identified only by identifiers WhatsApp reported (`senderJid`, plus
`senderPhone` for an `@lid`): a phone JID proves its number; an `@lid` proves only
itself and a *different* plausible number the bridge reported for it. Entries are
phone digits or an exact `<digits>@lid`. Display names are never used, and `@lid`
digits are never read as a phone number. The verified id and the allow-list result
are stored on each answer. The list is per business: authorization in one business
grants nothing in another.

### One send policy for WhatsApp and the dashboard

`planCustomerSend()` (`lib/server/aiAgent/customerSend.ts`) is the only place that
decides whether a customer message is created. The WhatsApp `!send` and the
dashboard's **Send to customer** both call it, so both are subject to: agent
enabled + **Assisted** mode, contact scope / allow / exclude, human takeover,
recent human activity, safe text, authorization (allow-listed sender, or the
authenticated admin session), draft staleness (customer wrote since; for typed
dashboard text, since the page was loaded — `basedOn`) and expiry of the temporary
facts behind a draft, and duplicate / in-flight / unknown-outcome holds (the same
`staffrelay:` keys are shared, so a WhatsApp send and a dashboard click of the same
text cannot both go out). `applyStaffAction("send")` now refuses outright. In
Observe a dashboard send records the answer for review and queues nothing.

### Which draft "send" approves

A quoted draft resolves to exactly that draft, within the business and escalation
(the confirmation of an earlier send resolves to the draft it approved). If the
quoted draft cannot be resolved, nothing is sent. A bare "send" with only an `#E-`
reference or a quoted notice approves the escalation's single unsent draft; with
two different unsent drafts it asks the staff to quote the one they mean. A quote
and a `#E-` reference that disagree, or two references, send nothing. Every
approval stores the answer it approved (`approves_answer_id`).

### When processing fails

A crash while handling a staff message marks its answer **failed** (the Escalations
tab shows the error and a **Retry** button), writes a `staff_answer.failed` audit
row, and — in Assisted mode — posts a plain message in the staff group that says
whether a customer message may already have gone out. Observe has no staff
feedback kind, so there the dashboard shows it. **Retry** (admin only) re-runs the
same stored words, sender and approved draft through the same policy, once
(atomic claim), and is refused when a customer message created by that event is
pending, in flight, sent, or of unknown outcome — only a failure that proves
nothing was sent (`not_sent`, a block code) allows it. Unknown-send holds are
never overridden.

## 3. What staff tell us: four classes

The model proposes items; the server validates every one (the staff's exact
words as evidence, no number the staff did not say, no instruction-like text) and
may only move an item **toward less permanent**, never more
(`validateStaffItems`).

| Class | Examples | Stored | Reused |
|---|---|---|---|
| **Durable** | standard price, hours, delivery policy, product info, contact details | a **learning candidate** → admin approves in the dashboard → knowledge | after approval only |
| **Temporary** | stock, shortage, delivery capacity today, temporary changes | on the staff-answer row with an expiry (1 h–7 d, default 12 h) and a scope | only in that conversation (or business-wide if staff said so) and only until it expires; used for drafting, never as knowledge |
| **Customer-specific** | verified purchase, confirmed preference, delivery instruction | `ai_agent_customer_memory` (`staff_confirmed`, kind `note`) under that customer's verified key, if customer memory capture is on | that customer only |
| **One-off** | discount, negotiated price, refund exception, promise | the audit row only | never |

Stock and availability wording ("in stock", "out of stock", "none left", "running
low", "unavailable", "waiting for stock"…) is always temporary. Three backstops keep
it from becoming a stale claim: it never becomes a learning candidate; an admin
cannot approve text that states a temporary condition into permanent knowledge
(Knowledge tab with an expiry date is the place for that); and a stored draft
resting on temporary facts cannot be approved after they expire (typed wording
still can). Temporary facts feed only the staff-answer drafting call — never the
Inbox decision engine that talks to customers.

Deterministic cues override the model: a discount/“just this once”/promise cue →
one-off; “today”, “out of”, “until Thursday”, “restock” → temporary; a pronoun or
name tying the fact to one customer → customer-specific. A temporary fact about
one customer stays temporary and conversation-only. Customer memory never stores
prices, links or long numbers.

**Conflicts.** A durable candidate is compared with approved knowledge of the
same business (`assessKnowledgeCandidate`): an identical fact creates no
candidate; a different price/day/time or a same-topic entry is attached as a
conflict. Approving it requires an explicit choice — *replace* (the old entry is
archived, never edited) or *keep both*. The comparison is repeated at approval
time, and approval is one SQL transaction
(`approve_ai_agent_learning_candidate`), so two admins cannot create two entries.

**Audit.** Each staff answer stores the verbatim words, the WhatsApp timestamp,
business, escalation reference, who sent it, how it matched, the draft, what
became of the customer reply, and each item's disposition
(`ai_agent_staff_answers`). Candidates carry their source message, time and ref.
Customer data deletion (`forget_ai_agent_customer`) now also removes the
customer's staff answers and their words from candidates.

## 4. Admin dashboard

*Escalations* shows each staff answer, its draft, sent/withheld and why, and where
each piece of information went. *Review → Learning from staff answers* lists only
durable candidates with the staff's words, the escalation reference, any
overlapping entry and the replace / keep-both choice. A dashboard "Send to
customer" still sends exactly the typed text and now feeds the same learning
pipeline.

## 5. Deployment

1. Apply `20261026000000_ai_agent_staff_answers.sql` then
   `20261027000000_ai_agent_staff_authorization.sql` (before deploying the app;
   the app reads/writes the new columns).
   **Behaviour change:** the allow-list starts empty, so after this release no one
   can send a customer reply from WhatsApp until an admin adds staff numbers on the
   Agent settings card. Drafts, learning and the dashboard button are unaffected.
2. Update the bridge (see §6) — required for drafts in Observe mode.
3. Deploy. Nothing is enabled by this change: existing settings are untouched.

## 6. Bridge changes (WhatsappOperation)

- Treat `staff_draft` exactly like `staff_notice`: staff-group only, allowed in
  Observe when `staffNoticesEnabled`, blocked by the global send switch.
- Ack `staff_draft` (and ideally `staff_feedback`) with the WhatsApp message id.
- Forward `senderJid` for every staff-group message and `senderPhone` (Baileys
  `participantPn`) for `@lid` participants — see the bridge contract. Without
  `senderPhone`, an `@lid` sender can only be authorized by an exact `…@lid` entry.
- Optional: honour `replyToMessageId` by posting the item as a quote of that
  message.

Until then: Assisted mode works (unknown kinds are still sent when `send: true`);
Observe mode refuses drafts with `observe_mode` and staff see no draft.

## 7. Operating cost

- One extra model call per staff **answer** (plain reply) and per `!send <text>`
  or dashboard send (classification only). `send`/`!send` approvals of an existing
  draft, commands, unmatched chatter and echoes cost nothing.
- A call is typically 1.5–3k input tokens (instructions, up to 80 knowledge
  entries, a 10-message transcript, the customer's and the staff's words) and at
  most 900 output tokens, on the model configured in AI settings.
- The staff-group `/message` request now waits for that call (a few seconds; the
  route allows 60 s, the bridge uses 30 s).
- Database: a handful of small queries per staff message; the dashboard's
  learning list reloads approved knowledge to recompute overlaps.
