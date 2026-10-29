# AI agent ⇄ WhatsappOperation bridge contract

Target: the external Baileys bridge service ("WhatsappOperation"), the same
service described in `docs/whatsapp-bridge-link-spec.md`. This document is the
complete contract for the Assisted AI agent. The bridge needs no AI code, no
OpenAI key and no knowledge of the `ai_agent_*` tables.

## 1. Division of responsibility

| Concern | Owner |
|---|---|
| Every AI decision (REPLY / ASK / ESCALATE / NO_REPLY / HUMAN), safeguards, contact permissions, takeover, escalation matching | This app: `lib/aiAgent/engine.ts` (rules) + `lib/server/aiAgent/decide.ts` (orchestration) |
| Persisting messages to `whatsapp_messages` (unchanged) | Bridge |
| Forwarding messages to the agent, sending exactly what it returns, reporting send outcomes | Bridge |

The bridge must **never** compose, edit, retry with different text, or decide
to send anything on its own. If the app is unreachable or returns non-2xx, the
bridge sends nothing.

## 2. Authentication & configuration

Bridge env (new):

| Var | Value |
|---|---|
| `AI_AGENT_URL` | Base URL of this app, e.g. `https://inbox.example.com` |
| `AI_AGENT_BRIDGE_SECRET` | Long random string; **same value** set on the app deployment |

Every request carries header `x-ai-agent-secret: <AI_AGENT_BRIDGE_SECRET>`.
This is a different secret from `WHATSAPP_ADMIN_SECRET` (app → bridge); the two
directions are independently revocable. If the app's secret is unset, every
bridge endpoint returns `503` (agent off).

All bodies are JSON (`Content-Type: application/json`). Timeouts: use 30 s for
`/message` (it may call the model), 10 s for everything else.

## 3. Endpoints

### 3.1 `GET /api/bridge/ai-agent/config`

Optional optimisation; cache for ~60 s.

```json
200 {
  "pollOutboxSeconds": 10,
  "businesses": [
    { "businessSlug": "dog_food", "forwardMessages": false, "mode": "observe", "staffGroupJid": null, "staffNoticesEnabled": false },
    { "businessSlug": "by_sea", "forwardMessages": false, "mode": "observe", "staffGroupJid": null, "staffNoticesEnabled": false }
  ]
}
```

Daily order summary (additive, see `docs/ai-agent-daily-orders.md`): each entry also carries
`ordersSummaryEnabled` and `ordersGroupJid` (null = the morning list and the order commands (`!orders`, `!order`) use `staffGroupJid`, which needs no
bridge change). A non-null `ordersGroupJid` that differs from `staffGroupJid` must also be forwarded to `/message`,
and `staff_notice` items addressed to it may be sent in every mode in which `staffGroupJid` accepts notices.

One entry per business that has agent settings; each business is configured independently (own staff group, mode and on/off). A business missing from the list is not enabled. Forward messages only for businesses with `forwardMessages: true`. Forwarding
for any other business is harmless (answered with `status: "ignored"`, nothing
written), so a stale cache is safe.

Order monitoring (`docs/ai-agent-daily-orders.md`): with `orders_tracking_enabled` the agent reads **every** forwarded 1:1 customer message for orders,
including customers the AI may not answer, so the bridge must keep forwarding all inbound 1:1 messages (and human `fromMe` messages) for a business with
`forwardMessages: true` and must **not** pre-filter by contact scope. Nothing else changes for the bridge; a message it stores but does not forward shows up in
the report's coverage note.

### 3.2 `POST /api/bridge/ai-agent/message`

Call **after** the message row is written to `whatsapp_messages`, for:

- every inbound 1:1 message,
- every outbound (`fromMe`) message that a **human** sent (business phone or
  the inbox's `/api/send`) — this triggers automatic human takeover,
- every message in the configured staff group (`staffGroupJid`), from anyone,
  including `fromMe`.

**Do not forward** messages the bridge itself sent on behalf of an outbox item
(the app also detects and drops these echoes, but don't rely on it).
Do not forward status/broadcast/newsletter chats.

Request:

```json
{
  "businessSlug": "dog_food",
  "whatsappMessageId": "3EB0C767F26A1D2B1F3A",   // key.id — REQUIRED, idempotency key
  "chatId": "17585551234@s.whatsapp.net",        // same chat_id written to whatsapp_messages — REQUIRED
  "contactNumber": "17585551234",                // same contact_number written to whatsapp_messages, or null
  "fromMe": false,                               // key.fromMe — REQUIRED boolean
  "text": "Do you deliver to Gros Islet?",       // conversation / extendedText / caption; "" if none
  "hasMedia": false,                             // image/video/audio/document/sticker present
  "quotedMessageId": null,                       // contextInfo.stanzaId when replying to a message
  "senderJid": null,                             // group participant JID (staff group); null for 1:1
  "senderPhone": null,                           // staff group, @lid participants only: the phone number WhatsApp reported for it (Baileys participantPn); null when unknown
  "timestamp": "2026-10-22T14:03:11Z"            // informational
}
```

Staff-group sender identity: `senderJid` (and `senderPhone` for an `@lid`
participant) are the ONLY identifiers the app uses to decide whether a sender may
authorize a customer send (the per-business allow-list, see
docs/ai-agent-staff-answers.md §2). Send exactly what WhatsApp reported — never a
display name or push name, and never a phone number derived from the `@lid`'s own
digits. Omit `senderPhone` when WhatsApp reported none: that sender can then match
only an exact `…@lid` allow-list entry. A message with no `senderJid` (including
`fromMe` messages the bridge cannot attribute) is treated as an unauthorized sender.

Response `200`:

```json
{
  "eventId": "6d0c…",              // null when status = "ignored"
  "status": "done",                // done | duplicate | in_progress | ignored | error
  "decision": "REPLY",             // REPLY | ASK | ESCALATE | NO_REPLY | HUMAN | null
  "reasons": ["verified_answer"],
  "outbox": [
    { "id": "a1b2…", "businessSlug": "dog_food", "kind": "customer_reply", "to": "17585551234@s.whatsapp.net", "body": "…", "send": true }
  ]
}
```

Bridge rules:

1. Send **only** items with `send: true`, to `to`, with `body` **verbatim**, in
   array order.
2. After each send attempt, call `/ack` (3.3) with the outcome.
3. `status: "duplicate"` / `"in_progress"` (a retry of an already-claimed
   `whatsappMessageId`) always comes back with `send: false` — never resend.
4. `status: "error"` → nothing to send. Non-2xx → nothing to send; a retry with
   the same `whatsappMessageId` is safe.
5. Ignore unknown `kind` values but still honour `send`. (Note for Observe
   mode below: an unknown kind is NOT sendable there — see `staff_draft`.)
6. If an item carries `replyToMessageId` (staff-group items only), post it as a
   WhatsApp quote of that message in the same chat. It is optional: a bridge that
   ignores the field behaves correctly, the item's text already names the
   escalation.

**Observe mode.** A business in `observe` mode may have `send: true` items of
kind `staff_notice` **or `staff_draft`** only, addressed to `staffGroupJid`, and
only when `staffNoticesEnabled` is `true` (default `false`, set per business in
the admin UI). Every other kind, and every item addressed to a non-group chat,
must not be sent in Observe mode (ack `failed` with `observe_mode`;
`staff_notice_disabled` → ack `staff_notices_disabled`). The bridge's global
send switch (`AGENT_SEND_ENABLED=false`) blocks staff notices and drafts too. In
Observe mode the app never creates `customer_reply`, `holding_reply`,
`staff_relay` or `staff_feedback` items; a staff answer to an Observe notice is
stored for review, answered with a `staff_draft` in the staff group (a reply
staff can copy), and never forwarded to the customer. At most one notice is
posted per escalation: later customer messages append to the open escalation
without a new notice. A business with no staff group records its escalations in
the admin panel only (no item is created).

`kind` values: `customer_reply`, `holding_reply` (to customer),
`staff_notice`, `staff_draft`, `staff_feedback` (to staff group), `staff_relay`
(an explicitly authorized staff reply → customer).

**`staff_draft` (new, bridge change required for Observe mode).** The drafted
customer reply the app posts in the staff group after a staff answer. It is a
staff-group kind exactly like `staff_notice`: same Observe rule, same global
send switch, never addressed to a customer. An older bridge that ignores unknown
kinds still delivers it in Assisted mode (rule 5), but refuses it in Observe
(`observe_mode`) until it treats `staff_draft` like `staff_notice`.
**Deployment check:** if the Activity tab shows `staff_draft` rows blocked with `observe_mode` while `staff_notice` rows send, the
running bridge predates `staff_draft` support (it allows only `staff_notice` in Observe). Deploy a bridge build whose
Observe allow-list is `staff_notice` + `staff_draft`; the Inbox side needs no change. Blocked rows are final and are
never resent.
**Ack it with the WhatsApp message id** (like `staff_notice`): a staff member
quoting the draft with "send" approves exactly that draft. `staff_feedback`
acks should also carry the id (quoting a confirmation then resolves to its
escalation), but nothing breaks if they do not.

**Approval Pilot mode (`mode: "approval_pilot"`, bridge change required).** Between Observe and
Assisted: the AI never sends on its own. The bridge must send, in this mode, only
`staff_notice`, `staff_draft`, `staff_feedback` (to `staffGroupJid`, no `staffNoticesEnabled` needed) and
`staff_relay` (an approved reply to a customer: `!approve`, `!send <text>` from an authorized sender, or the
dashboard's "Send to customer"). `customer_reply`, `holding_reply` and unknown kinds are refused with ack
`failed` / `approval_pilot_mode`; a `staff_relay` addressed to a group is refused too. A `staff_relay` still
respects `held_after_unknown_send`. `/outbox/claim` is polled in this mode. A bridge that does not know the mode
fails closed (`observe_mode` for everything) **and never polls the outbox in it**, which strands every batched notice and approved reply as
`pending`. **Deployment check:** `staff_feedback` rows blocked with `observe_mode` while the business is in Approval Pilot, and `staff_notice`
rows that stay `pending`, mean the bridge predates this mode. The bridge must also re-read `/config` before refusing an item for its mode
(the admin may have just switched modes). A `staff_relay` after an unknown-outcome send to the same chat is acked `held_after_unknown_send`.
Full behavior: `docs/ai-agent-approval-pilot.md`.

**Batched messages (no bridge change).** When a business has message batching
on, a customer message is queued rather than decided: the response is
`{ "status": "done", "decision": null, "reasons": ["batched"], "outbox": [] }`
and there is nothing to send. Once the customer has been quiet for the
configured period (or the maximum wait is reached) the app decides the whole
batch as one turn, and any resulting items are `pending` outbox items that the
bridge collects from its normal `/outbox/claim` poll (§3.4). Staff messages
(`fromMe`) and staff-group messages are never batched. The `/message` contract
is otherwise unchanged; keep polling `/outbox/claim` at `pollOutboxSeconds`
(10 s) so batch results are delivered promptly. `/config` additionally reports
`batchingEnabled`, `batchQuietSeconds`, `batchMaxWaitSeconds` per business
(informational only).

Errors: `400` invalid body, `401` bad secret, `503` agent not configured,
`500` internal (fail closed).

### 3.3 `POST /api/bridge/ai-agent/ack`

```json
{ "outboxId": "a1b2…", "status": "sent", "whatsappMessageId": "3EB0…", "error": null }
```

`status` is `"sent"` or `"failed"`. `whatsappMessageId` is the id Baileys
returned for the sent message — **required for `staff_notice` and `staff_draft`**,
because staff quoted-replies to those messages are matched by this id. Responses: `200 {ok:true}`
(also for a repeated identical ack), `404` unknown id, `409` item not awaiting
an ack. Do not retry the *send* on any ack error.

For `failed`, `error` starts with a reason code (optionally followed by
`: <detail>`). The admin UI shows these codes as **blocked**: deliberately not
sent, with nothing wrong:

`agent_disabled`, `bridge_send_disabled`, `observe_mode`, `approval_pilot_mode`, `staff_notices_disabled`, `human_takeover`,
`stale_reply`, `superseded_by_newer_message`, `held_after_unknown_send`,
`unapproved_commitment`, `chat_rate_limited`, `business_rate_limited`

Every other code or text is shown as a real **failure**. Examples are
`not_sent: <detail>` (the socket call provably did not send),
`session_disconnected` and `invalid_body`. A new blocking reason must be added
to `lib/aiAgent/outboxStatus.ts` and to the list above, or admins will see it
as a failure. The stored status is still `failed` either way: the item was not
sent, so it does not count toward `max_auto_replies_per_hour`.

**Never ack an ambiguous send.** If the bridge cannot tell whether a message
reached WhatsApp (timeout, socket error, crash mid-send), it must not ack it
as `sent` or `failed`. See §4.

### 3.4 `POST /api/bridge/ai-agent/outbox/claim`

Poll every `pollOutboxSeconds` while connected. Delivers items created outside
a `/message` call (admins answering escalations in the web UI).

```json
{ "businessSlug": "dog_food", "limit": 20 }       // businessSlug optional
200 { "items": [ { "id": "…", "businessSlug": "dog_food", "kind": "staff_relay", "to": "…@s.whatsapp.net", "body": "…", "send": true } ] }
```

Each item is handed out exactly once (Postgres `FOR UPDATE SKIP LOCKED`).
Send it, then `/ack` it.

Each poll also acts as the batch scheduler's clock: after answering, the app
processes any batches that are due (see `docs/ai-agent-batching-memory.md`), so
the bridge needs no extra call. The claim only hands out items the business's
*current* mode permits, whichever path created them.

## 4. Delivery semantics

At-most-once. An outbox item is `pending → dispatched` when handed to the
bridge, then `sent | failed` on ack. A dispatched item is never handed out
again, so a crash between send and ack can lose the ack (item stays
`dispatched`, visible to admins) but can never double-send.

Admins see the outbox on `/admin/ai-agent` → Activity. An item still
`dispatched` 10 minutes after it was handed out is shown as **unresolved**: it
may or may not have been delivered. Nothing in the app or the bridge retries
it. An admin checks the chat and follows up by hand if needed. No admin action
re-queues an outbox item. The `/message`
idempotency key is `(businessSlug, whatsappMessageId)`; it is claimed before
the model is called.

## 5. Staff group conventions (handled entirely by the app)

The agent posts a notice per escalation:

```
🔔 AI escalation #E-7K3QX · HIGH
⚠️ Complaint
👤 Jane · 17585551234
…
↩️ Reply to this message (or include #E-7K3QX) with your answer. I'll draft the customer reply here — it is sent only when you reply "send".
Commands: !note <text> · !send <text> · !close · !takeover · !resume
```

A staff message is matched to an escalation **only** by (a) a quoted reply to
a message the agent posted for it (`quotedMessageId`: its notice, a draft, a
confirmation), or (b) exactly one `#E-XXXXX` code. No reference, several
references, a quote and code that disagree, or an unknown code → nothing happens
and nothing is sent to anyone (the app replies in the group with a
`staff_feedback` explanation where useful, Assisted mode only). Recency and
customer names are never used. Anything containing the agent's own message
headers ("Draft reply for #…", "AI escalation #…") is treated as an echo, never
as an instruction.

**A plain reply is information, not permission.** It is recorded, turned into a
concise customer-facing draft plus a classification of what the staff told us
(one model call), and the draft comes back to the group as a `staff_draft`:

```
✍️ Draft reply for #E-7K3QX · Jane
"Hi Jane, the 15kg bag is EC$120 and we can deliver Friday."

Not sent: your reply was saved as information only — I message the customer only when you approve it.
To send it: reply to this message with "send" (or !send <your own wording>).
```

The customer is messaged only after **explicit authorization** — `!send`, a
message that is only "send"/"send it"/"go ahead", or `!send <exact text>` — and
only if every customer policy also allows it: Assisted mode, contact scope and
exclusions, human takeover, no recent human reply in the chat, a safe draft (no
price/link the staff did not state), the draft not older than the customer's
latest message, and the same text not already sent. Otherwise the group is told
why in plain words and a `staff_relay` is never created. Observe mode never
sends, however it is authorized. If the bridge later reports the authorized
reply as not sent (kill switch, unknown-send hold, takeover…), the app posts a
`staff_feedback` ("Reply not sent for #E-7K3QX … the customer did not receive
it").

`!note` stores an internal note, `!close` resolves, `!takeover`/`!resume`
pause/resume the AI for that customer. Full behaviour:
`docs/ai-agent-staff-answers.md`.

## 6. Database objects (reference — the bridge does not access these)

Migration: `supabase/migrations/20261022000000_ai_agent.sql`.

| Table / function | Purpose |
|---|---|
| `ai_agent_settings` | Per-business config, one row per business. Rows are created OFF / observe / none with `staff_notices_enabled = false` (seeded for `dog_food`; others by `20261023000000_ai_agent_multi_business.sql` or on first admin visit; the flag comes from `20261024000000_ai_agent_observe_staff_notices.sql`). No business restriction. |
| `ai_agent_contact_rules` | `allow` / `exclude` per chat |
| `ai_agent_knowledge` | Business facts; only `approved` + unexpired are used |
| `ai_agent_conversations` | Per-chat AI/human control |
| `ai_agent_events` | One row per forwarded message; unique `(business_slug, whatsapp_message_id)` |
| `ai_agent_escalations` | Escalations with `ref_code`, priority, status, staff answer; one unanswered per chat |
| `ai_agent_order_requests` | Collected, never-confirmed order requests |
| `ai_agent_outbox` | Everything to send; unique `dedupe_key` |
| `ai_agent_batches`, `ai_agent_batch_messages` | Durable message batching (quiet period, maximum wait, leases); migration `20261025000000_ai_agent_batching_memory.sql` |
| `ai_agent_customer_memory` | Customer-stated preferences + staff-confirmed resolved issues; same migration |
| `ai_agent_staff_answers` | One row per staff message that answers an escalation: verbatim words, timestamp, business, escalation ref, the draft and whether it was sent or withheld (and why), classified items, time-bounded temporary facts; unique `(business_slug, source_message_id)`; migration `20261026000000_ai_agent_staff_answers.sql` |
| `ai_agent_learning_candidates` | Durable facts staff supplied, awaiting admin approval as knowledge (with source message, time, ref and any conflict with approved entries) |
| `ai_agent_audit_log` | Append-only audit trail |
| `claim_ai_agent_outbox(p_business_slug, p_limit)` | Service-role-only claim function used by 3.4 |
| `approve_ai_agent_learning_candidate(…)` | Atomic admin approval of a candidate; replacing an overlapping entry archives it |

RLS: admins can read; nothing but the app's service role can write.

## 7. Bridge pseudocode

```ts
sock.ev.on("messages.upsert", async ({ messages }) => {
  for (const m of messages) {
    await persistToSupabase(m);                       // unchanged
    if (sentByOutbox.has(m.key.id)) continue;         // our own send
    if (isSystemJid(m.key.remoteJid)) continue;
    const cfg = await aiConfig(businessSlug);          // cached /config
    if (!cfg?.forwardMessages) continue;
    const isStaffGroup = m.key.remoteJid === cfg.staffGroupJid;
    if (m.key.remoteJid.endsWith("@g.us") && !isStaffGroup) continue;

    void forwardToAgent(businessSlug, m).catch(log);  // never block the live handler
  }
});

async function forwardToAgent(businessSlug, m) {
  const res = await post("/api/bridge/ai-agent/message", toPayload(businessSlug, m));
  if (!res.ok) return;                                // fail closed
  for (const item of res.body.outbox) if (item.send) await sendAndAck(item.businessSlug, item);
}

async function sendAndAck(businessSlug, item) {
  try {
    const sock = sockets.get(businessSlug);
    const sent = await sock.sendMessage(item.to, { text: item.body });
    sentByOutbox.add(sent.key.id);
    await post("/api/bridge/ai-agent/ack", { outboxId: item.id, status: "sent", whatsappMessageId: sent.key.id });
  } catch (err) {
    await post("/api/bridge/ai-agent/ack", { outboxId: item.id, status: "failed", error: String(err) });
  }
}

setInterval(async () => {                             // every pollOutboxSeconds
  const { items } = await post("/api/bridge/ai-agent/outbox/claim", { limit: 20 });
  for (const item of items) await sendAndAck(item.businessSlug, item);   // send via that business's socket
}, 10_000);
```

Outbound rows the bridge writes to `whatsapp_messages` for agent sends should
carry the same `whatsapp_message_id` it acks — the agent uses that to tell its
own messages apart from a human's.
