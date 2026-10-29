# Order numbers, Rules & Routing and missed calls

Migration: `supabase/migrations/20261110000000_ai_agent_order_numbers_routing_missed_calls.sql` (run it in the SQL editor
**before** deploying the app; additive, idempotent, switches nothing on). Bridge: branch `missed-calls-routing-support` of
WhatsappOperation (optional and independent; see "Bridge" below).

## 1. Simple order numbers

`!orders` and the morning summary number their orders (1, 2, 3 …). Staff can use that number wherever a `#REF` works:

```
!order 2                      details            !order 2 completed | cancelled | confirmed | reopen
!order 2 3 bags               quantity           !order 2 delivery tomorrow
!order 2 teach Change the address to Cap Estate
```

`#REF` commands are unchanged.

**A number means what the posted report showed, never a fresh list.** When a report is posted its numbering is stored
(`ai_agent_order_lists`: order id, reference and version per number, for that business and group). A typed number is resolved
against the stored list:

| Situation | Result |
|---|---|
| The command replies to (quotes) a report message | That report's numbering decides (any part of a multi-message report). |
| No quote | The newest report of each type (`!orders`, `!orders overdue`, …) is a candidate. All candidates must agree on which order the number means; otherwise nothing changes and the choices are listed. |
| Report older than 6 hours | Refused: "expired, send `!orders` again". |
| No report in this group / number not in it | Refused, nothing changed. |
| Quote that is not a report | Refused (never guessed past). |
| The order changed after the report (its version moved) | Refused: "changed after that list was posted". Read-only `!order 2` still shows it. |
| Sender not on the allow-list, wrong group, other business | Refused by the same checks as every order command, *before* any list is read. Lists are scoped to business + group. |

The check is repeated when the change is written (the existing version-checked mutation), so a change between the check and the
write cannot land on a changed order.

## 2. Rules & Routing (AI Agent → Rules & Routing)

| Category | What it carries | Stored in |
|---|---|---|
| Orders and daily summaries | summary + order commands (order commands only, as before) | `orders_group_jid` (Setup tab) |
| Complaints and disputes | escalations with a complaint / refund / payment-claim / health / legal reason | `routing_rules.complaints` |
| Urgent escalations | escalations of urgent priority (wins over complaints) | `routing_rules.urgent` |
| AI response approvals | in Approval Pilot, the notices that carry the AI draft | `routing_rules.approvals` |

* Each rule: on/off + group (picked from this business's discovered groups, or typed). Rules wait until a staff group exists.
* **Fallback:** a disabled/empty rule, or a notice no category fits, goes to the staff group. Each notice goes to exactly one group
  (no copies), keyed as before, so a redelivered message posts nothing twice.
* **Authorization:** a group named by an enabled rule is an authorized staff group for that business: escalation answers and
  approvals are accepted there, still only from the authorized-senders list; replies go back to the group written in. Order
  commands are refused there. A routed group cannot be the Orders group and cannot be used by another business. A disabled rule's
  group stops being a staff group immediately.
* The bridge learns the groups from `routedGroupJids` in `GET /config`; the SQL claim function only hands out staff-group kinds for
  them in the same modes as the staff group (Observe: notices/drafts, and only with notices on).

## 3. Missed-call rule (AI Agent → Rules & Routing → Missed calls)

**Off by default.** Config: on/off, message (default: *"Thanks for reaching out! Sorry we missed your call. We're unable to answer
at the moment, but how can we help you?"*), per-caller cooldown (5 min – 7 days, default 60). Every call decision is recorded in
`ai_agent_call_events` (shown on the page) and the audit log.

### What the bridge can and cannot tell (Baileys 6.7.23)

Baileys emits `call` events with status `offer`, `ringing`, `accept`, `reject`, `timeout`, `terminate`, plus `isGroup`, `isVideo`,
`offline`. The bridge did not listen to them before.

* **Reliable:** `timeout` (the server's terminate with reason `timeout`: the call rang out), `accept`, `reject`; group calls; whether
  a call was created by this account (outgoing); whether an event was an offline replay.
* **Not reliable:** a plain `terminate`. It is sent when the caller hangs up, when somebody answered, when it was declined, and for a
  call answered on another device; the event alone cannot say which. **A caller who hangs up before the timeout is therefore never
  answered**: that is the price of "only reliably missed".
* **Not verified live:** the logic is tested against synthetic events following Baileys' documented model; it has not been run
  against a real call. Check the first real missed call in *Recent calls* before relying on it.

A call is answered only if **all** hold: incoming, one-to-one, offer seen live, final status `timeout`, not accepted/rejected, not an
offline replay, ended within 5 minutes, the caller is a person (`@s.whatsapp.net` / `@lid`). Missing flags count *against* replying
(both in the bridge and again in the Inbox).

The Inbox also requires: agent on, rule on, mode Assisted or Approval Pilot (Observe never writes to a customer), contact not
excluded and inside the contact scope (same as ordinary replies), no human handling the chat, caller not answered within the
cooldown, fewer than 20 replies in the last hour. The cooldown/cap are enforced in SQL under a per-caller lock
(`record_ai_agent_missed_call`), so concurrent reports cannot both reply. The reply is the fixed text (no AI), outbox kind
`missed_call_reply`; it is **not** an Approval Pilot draft and does not change how ordinary customer messages are handled.

### Bridge contract (additive)

* `GET /config` per business: `routedGroupJids: string[]`, `missedCallsEnabled: boolean`.
* `POST /api/bridge/ai-agent/call` (same secret header): `{ businessSlug, callId, callerJid, outgoing, isGroup, isVideo, offline,
  sawOffer, sawAccept, sawReject, finalStatus, offerAt, endedAt }` → `{ status: "done" | "ignored", decision, reason, outbox: [...] }`.
  The bridge sends only an item with `send: true` and kind `missed_call_reply` to a person, then acks it as usual.
  It reports calls only while `missedCallsEnabled` is true; an older bridge simply never reports, so the rule does nothing.
