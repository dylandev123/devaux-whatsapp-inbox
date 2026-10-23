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
    { "businessSlug": "dog_food", "forwardMessages": false, "mode": "observe", "staffGroupJid": null }
  ]
}
```

Forward messages only for businesses with `forwardMessages: true`. Forwarding
for any other business is harmless (answered with `status: "ignored"`, nothing
written), so a stale cache is safe.

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
  "timestamp": "2026-10-22T14:03:11Z"            // informational
}
```

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
5. Ignore unknown `kind` values but still honour `send`.

`kind` values: `customer_reply`, `holding_reply` (to customer),
`staff_notice`, `staff_feedback` (to staff group), `staff_relay` (staff answer
→ customer).

Errors: `400` invalid body, `401` bad secret, `503` agent not configured,
`500` internal (fail closed).

### 3.3 `POST /api/bridge/ai-agent/ack`

```json
{ "outboxId": "a1b2…", "status": "sent", "whatsappMessageId": "3EB0…", "error": null }
```

`status` is `"sent"` or `"failed"`. `whatsappMessageId` is the id Baileys
returned for the sent message — **required for `staff_notice`**, because staff
quoted-replies to that notice are matched by this id. Responses: `200 {ok:true}`
(also for a repeated identical ack), `404` unknown id, `409` item not awaiting
an ack. Do not retry the *send* on any ack error.

For `failed`, `error` starts with a reason code (optionally followed by
`: <detail>`). The admin UI shows these codes as **blocked**: deliberately not
sent, with nothing wrong:

`agent_disabled`, `bridge_send_disabled`, `observe_mode`, `human_takeover`,
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
🔔 AI escalation #E-7K3QX (HIGH)
Customer: Jane · 17585551234
Reason: complaint
Message: "The bag arrived torn"
Suggested reply: "…"
↩️ Reply to this message (or include #E-7K3QX) with the exact text to send the customer.
Commands: !note <text> · !close · !takeover · !resume
```

A staff message is matched to an escalation **only** by (a) a quoted reply to
one of its notices (`quotedMessageId`), or (b) exactly one `#E-XXXXX` code.
No reference, several references, a quote and code that disagree, or an
unknown code → nothing is sent (the app replies in the group with a
`staff_feedback` explanation where useful). A matched plain answer is relayed
to the customer **verbatim**. `!note` stores an internal note, `!close`
resolves, `!takeover`/`!resume` pause/resume the AI for that customer.

## 6. Database objects (reference — the bridge does not access these)

Migration: `supabase/migrations/20261022000000_ai_agent.sql`.

| Table / function | Purpose |
|---|---|
| `ai_agent_settings` | Per-business config. Seeded for `dog_food` only, OFF/observe/none. Check constraint: only `dog_food` may be enabled. |
| `ai_agent_contact_rules` | `allow` / `exclude` per chat |
| `ai_agent_knowledge` | Business facts; only `approved` + unexpired are used |
| `ai_agent_conversations` | Per-chat AI/human control |
| `ai_agent_events` | One row per forwarded message; unique `(business_slug, whatsapp_message_id)` |
| `ai_agent_escalations` | Escalations with `ref_code`, priority, status, staff answer; one unanswered per chat |
| `ai_agent_order_requests` | Collected, never-confirmed order requests |
| `ai_agent_outbox` | Everything to send; unique `dedupe_key` |
| `ai_agent_learning_candidates` | Staff answers awaiting admin approval as knowledge |
| `ai_agent_audit_log` | Append-only audit trail |
| `claim_ai_agent_outbox(p_business_slug, p_limit)` | Service-role-only claim function used by 3.4 |

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
