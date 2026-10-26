# Automatic business learning

A genuine outgoing **human** message of the business account in a customer chat may state a reusable fact (a
standard price, a size, opening hours, a delivery rule). When the business has switched on **Learn clearly stated
facts automatically** (Agent settings → Learning from WhatsApp, off by default), that fact becomes active knowledge
without `!confirm`. Anything doubtful waits for a person in the dashboard.

Code: `lib/aiAgent/autoLearn.ts` (pure rules), `lib/server/aiAgent/autoLearn.ts` (flow),
`learningDigest.ts` (batched notification), `learningCommands.ts` (`!memory`, `!forget`). Migration
`supabase/migrations/20261104000000_ai_agent_auto_learning.sql` then `20261105000000_ai_agent_learning_refinements.sql` — **run both, in order, before deploying the app code.**

## What is read

Only `fromMe` messages in 1:1 customer chats, after the bridge's echo check (the AI's own sends, drafts, bridge and
staff-group posts, commands and media-only messages are dropped). Customers' messages are never a source: the
conversation is shown to the model only so it can **name the product** a short sentence is about, and every price and
measurement in a fact must be in the business's own words (a customer's figure can never be adopted).

Cost: a free pre-filter (price, measurement or business wording) runs first, then **one** model call per relevant
message — the existing staff-text analysis in learning mode — capped at 20 per business per hour. Learning has its own
gate, budget and failure handling and runs alongside order monitoring; neither can stop the other.

## What happens to each fact

| Outcome | When | Result |
|---|---|---|
| **Saved** | clear, complete, standard, no conflict, confidence ≥ 0.75 | approved knowledge (`source = 'auto'`, code `K-XXXX`), counted for the digest |
| **Updated** | the business explicitly corrects a fact **this system learned** (non-price) | old entry archived and linked (`superseded_by`), new entry approved, counted |
| **Duplicate** | same product + price (or same sentence) already known | nothing changes, not counted |
| **Review** | conflicting price; ambiguous / generic / unnamed product; customer-specific terms (credit, quotes, "for you"…); any policy or risky wording (refund, warranty, deposit…); price scope unclear; confidence 0.5–0.75; a correction of a staff-written entry | pending suggestion with a reason in the dashboard Review tab — **no staff-group message** |
| **Skipped** | special/negotiated price, one-off, temporary (stock, "today"), phone/e-mail/link, vague, unsupported figure, confidence < 0.5 | nothing stored |

A price is never changed automatically, even when worded as a correction: a new price for a product that already has
one always goes to review. Products are compared by a stable product key, so the 25ft and 35ft hose never conflict.

## History, removal and re-learning

Nothing is edited in place or deleted. A replaced fact is archived (`archived_reason = 'superseded'`, `superseded_by`);
a forgotten one is archived (`'forgotten'`). Each learned fact keeps its source WhatsApp message id and time, the
business, and its product key — not the chat text. Each learned fact also keeps the chat id it came from.
One message can never produce the same fact twice (unique per business, message and fact).

**Removed facts (30 days).** A fact forgotten (`!forget` / dashboard Archive) or a suggestion rejected is remembered:
- the same claim — same fingerprint, or the same product and figures reworded — is neither relearned nor re-suggested;
- a *different* value for the same product (e.g. a new price) that is **not** stated as an explicit correction is also dropped;
- an explicit correction goes to the Review tab (`corrects_removed`) for a person — never straight to knowledge;
- forgotten knowledge is never reactivated automatically; only a person can (Restore, or approving a new suggestion).
After 30 days the fact can be learned again. Enforced in `checkRemoved()` and, for identical claims, again in SQL.

## Digest (threshold + weekly)

Every genuinely new or materially updated fact writes a row to `ai_agent_learning_events`. When 10 have gathered for a
business, `claim_ai_agent_learning_digest()` turns them into one digest **in a single transaction** (advisory lock +
stamping the events), so a batch can be claimed once. The message is built from stored summaries (no model call),
enqueued as `staff_feedback` to the staff group under the key `learning_digest:<id>`, and the digest records
`enqueued_at`. A crash between claim and enqueue is repaired by the next flush (same key, so never sent twice).
It follows the staff-group rules: Approval Pilot and Assisted only; in Observe nothing is claimed and facts wait.
Whatever has not reached 10 is sent **once** as a weekly digest ("N facts learned this week") when the oldest unannounced
active fact is 7 days old — decided inside the same claim function, driven by the existing scheduler (the bridge's outbox
poll, throttled to 30 min, and the batches cron). Nothing waiting → nothing claimed: no empty digest, no repeats; a fact
forgotten before (or after) the claim is left out, and if none remain nothing is sent.
Facts forgotten before the digest are not counted. The count of pending reviews is included; reviews never notify.

## Staff commands (staff group)

- `!memory` — recent learned facts, each with its source time and chat (`chat …0101`), and pending reviews (read-only).
- `!memory K-XXXXX` — where one fact came from, including the business's **original message**, read from the inbox at that moment (`whatsapp_messages`) and shown to authorized senders only. The chat text is never copied into the knowledge tables.
- `!forget K-XXXXX` — deactivates a learned fact; authorized senders only (same allow-list as `!teach`); archives, never deletes.
- `!confirm K-XXXXX` / `!discard K-XXXXX` — unchanged (`!confirm` still needs *Authorized senders can confirm…*).

All are audited (`knowledge.forget`, `learning.reject`, `learning.approve`, `knowledge.auto_learn`, `learning.digest`…).

## Approval Pilot

Learning only writes knowledge and the staff digest. It cannot create a customer-bound message (the digest passes the
same `outboxAllowed` gate and is staff-group only), and a draft that relied on a fact that was replaced or forgotten
still needs `!approve confirm` (`knowledge_changed`). In Assisted mode the AI answers with active knowledge as before —
which now includes auto-learned facts, so enable the setting deliberately.

## Older suggestion path

With auto-learning off, `passive_learning_scope` behaves as before (pending suggestions) except that suggestions no
longer post individually to the staff group.

## Source in the dashboard

Knowledge → each auto-learned entry has "Where this came from": conversation, time sent, and the original message
(looked up on request by the admin API, scoped to the business; "no longer in the inbox" if it was purged).
