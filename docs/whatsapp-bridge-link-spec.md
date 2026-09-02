# Bridge spec: 2-day history import + saved-contact-name capture

Target: the external Baileys ("WhatsApp bridge") service that owns the
`makeWASocket` connection and writes to `whatsapp_messages` /
`whatsapp_sessions` / `customers` in this project's Supabase DB. That code
does not live in this repo — see `WHATSAPP_API_URL` / `WHATSAPP_ADMIN_SECRET`
in `lib/server/whatsappBridge.ts`. This document is the implementation spec
to hand to whoever maintains that service.

This repo's DB schema already supports both features below with **no
migration required** — the bridge just needs to start populating columns
that already exist. The name-display and dedupe logic on the frontend side
is already done (see `lib/contactName.ts`, and the
`whatsapp_messages_dedupe_idx` unique index).

## Status update (2026-09-02, checked live against Supabase)

- **§1 dedupe (`whatsapp_message_id`): done on the bridge side.** Confirmed
  13,280/13,280 `whatsapp_messages` rows now have `whatsapp_message_id` set.
  Nothing further needed here.
- **§2 saved/device contact name (`business_contact_name`): still not
  implemented.** Confirmed 0/13,280 message rows and 0/70 `customers` rows
  have `business_contact_name` set. Five sampled `raw` payloads (the full
  Baileys message JSON) contain only `key`, `status`, `message`, `pushName`,
  `broadcast`, `verifiedBizName`, `messageTimestamp` — **no `contacts.upsert`
  / `contacts.set` data reaches Supabase at all**, under any field name. The
  bridge either isn't listening for those Baileys contact-store events, or
  isn't persisting anything from them. This is the root cause of "saved
  WhatsApp/device names don't display" — it's not a frontend bug; the
  frontend resolver chain (`lib/contactName.ts` → `resolveContactName()`)
  is verified correct and simply has nothing to read yet. §2 below is still
  the accurate spec for fixing this.
- Incidental finding, not a substitute for §2: `raw.verifiedBizName` *is*
  already present on some rows (WhatsApp's own "this sender is a verified
  Business account" name — e.g. a customer who is themselves a verified
  WhatsApp Business). That's a different concept from a phone's saved
  contact-list entry (it's WhatsApp-verified, not phone-book-saved, and is
  only ever set for senders who are verified businesses) — don't substitute
  it for `contact.name` in §2.

## 1. Import last 2 days of history on link/relink

### Trigger
Baileys emits `messaging-history.set` on the socket's `ev` emitter after a
fresh QR link or a session restore, when `syncFullHistory` is enabled (or a
partial sync otherwise). Handle it once per connection:

```ts
sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
  // see below — do not await this inline in a handler shared with
  // messages.upsert; dispatch it so realtime handling is never blocked.
  void importHistory(businessSlug, messages).catch((err) =>
    logger.error({ err, businessSlug }, "history import failed")
  );
});
```

### Filtering (apply before insert)
1. **Time window**: keep only messages where
   `messageTimestamp >= nowSeconds - 2 * 24 * 60 * 60` (Baileys timestamps
   are Unix seconds, not ms — watch the unit when comparing).
2. **System/status/broadcast noise**: drop when any of the following:
   - `key.remoteJid === "status@broadcast"` or `key.remoteJid.endsWith("@broadcast")`
     (mirrors `isSystemChatId()` in `lib/whatsapp.ts:213-216` — keep both
     sides consistent if that function's rules change).
   - `message.protocolMessage` present (key distribution, app-state sync,
     etc.) with no `conversation`/`extendedTextMessage` alongside it.
   - `message.historySyncNotification` present.
   - `messageStubType` set (these are WhatsApp-generated stub events, not
     real messages).
3. Everything else — including media, reactions, and deleted-message
   (`protocolMessage.type === REVOKE`) events — should still be imported;
   the frontend already knows how to render or skip those
   (`resolveBubbleText()` in `lib/whatsapp.ts:203-209`).

### Write path — reuse the live path exactly
Historical rows must be written through the **same** row-shaping function
the live `messages.upsert` handler already uses (same `chat_id` derivation,
same `contact_number`/`contact_name`/`sender_*` extraction, same `raw`
column). Do not write a parallel/simplified shape for history — that's what
"preserve existing threading" requires: `chat_id` must match exactly what a
live message for the same chat would get, or the conversation splits into
two threads.

### Dedupe
Set `whatsapp_message_id` on **every** inserted row (history and live) to
Baileys' `key.id`, scoped per chat via the existing
`(business_slug, whatsapp_message_id)` unique partial index
(`whatsapp_messages_dedupe_idx`, already created by
`supabase/migrations/20260723000000_repair_whatsapp_bridge_schema.sql:61-63`).
Note: as of the last audit, **no code path populates `whatsapp_message_id`
today, including the live handler** — this needs to start happening for
both live and historical inserts, not just historical ones, or dedupe won't
actually engage.

Use an upsert, not a plain insert:

```sql
insert into whatsapp_messages (..., whatsapp_message_id, ...)
values (..., $whatsapp_message_id, ...)
on conflict (business_slug, whatsapp_message_id) where whatsapp_message_id is not null
do nothing;
```

(`do nothing` is correct here — a history-synced copy of a message should
never overwrite a row already written by the live path, and vice versa.)

### Don't block realtime
- Never `await` the history import inside the same call stack as the
  `messages.upsert` handler.
- Batch the insert (e.g. chunks of 100–500 rows via a single multi-row
  upsert or Postgres `COPY`) rather than one round-trip per message, so a
  large backlog doesn't starve the DB connection pool the live handler
  shares.
- If the bridge uses a single-threaded queue for all Supabase writes,
  enqueue history rows at lower priority / after live rows so a live
  message sent mid-import still appears immediately.

## 2. Capture Baileys saved/device contact name, separately from pushName

Baileys' `Contact` object (from `contacts.upsert` / `contacts.set` /
`chats.set`) exposes:
- `contact.name` — the name saved for this contact in the **linked phone's
  own address book** (device/saved contact name). This is what's needed.
- `contact.notify` — effectively the same value as the `pushName` already
  read off individual messages (`key`/message metadata) today; not new.
- `contact.verifiedName` — WhatsApp Business verified name, only present
  when messaging *from* a verified WA Business account; not the customer's
  identity, don't use it for this.

### Where to write it
Both target columns already exist and are currently always `null`:
- `whatsapp_messages.business_contact_name` (added by
  `supabase/migrations/20260623000900_contact_phone_improvements.sql:14`)
- `customers.business_contact_name` (same migration, line 15)

Despite the "business_contact_name" naming (a holdover from when this was
assumed to be a WhatsApp Business phonebook field), this is exactly Baileys'
device/saved contact name — no new column, no migration needed. Just start
writing `contact.name` into it:

1. On every inbound/outbound message insert, look up the sender/recipient's
   `Contact` from your in-memory contact store (or `sock.store` /
   equivalent) by JID, and set `business_contact_name = contact?.name ?? null`
   alongside the existing `contact_name` (pushName) field on that same row.
2. On `contacts.upsert`/`contacts.set` events themselves, also upsert
   directly into `customers.business_contact_name` by phone number, so the
   name updates even between messages (e.g. the business owner renames the
   contact in their phone without either side sending anything).
   - A DB trigger (`upsert_customer_from_message()`, defined in
     `supabase/migrations/20260723000000_repair_whatsapp_bridge_schema.sql:73-97`)
     already copies `whatsapp_messages.business_contact_name` into
     `customers.business_contact_name` on every message insert via
     `coalesce()` (never overwrites a known name with null) — so (1) alone
     is sufficient to reach `customers` eventually; (2) just makes it show
     up sooner, without waiting for the next message.

### pushName — no change needed
pushName is already captured today (as `contact_name` on 1:1 rows, and via
`raw->>pushName` JSON-path selects — see `lib/contactName.ts` comment and
`components/whatsapp/Inbox.tsx:161`). Keep writing it exactly as today;
just make sure it's never conflated with `business_contact_name` going
forward — they must be two independently-sourced values on the same row.

### Result once both are wired up
The frontend's display-priority chain
(`lib/contactName.ts` → `resolveContactName()`) already reads, in order:
**verified CRM name (`customers.first_name`/`last_name`) → saved/device
contact name (`business_contact_name`) → pushName (`whatsapp_name`) →
phone number**, and a secondary "WhatsApp: {pushName}" label
(`resolveSecondaryWhatsappLabel()`) is shown next to the phone number
wherever the primary name isn't already the pushName
(`ConversationList.tsx`, `MessageThread.tsx`). No further frontend changes
are needed once the bridge populates `business_contact_name`.

## Summary of DB objects involved (none of these need to change)

| Object | Purpose | Status |
|---|---|---|
| `whatsapp_messages.whatsapp_message_id` | dedupe key | exists, unpopulated by any current writer |
| `whatsapp_messages_dedupe_idx` (unique, partial) | enforces dedupe | exists |
| `whatsapp_messages.business_contact_name` | saved/device contact name per message | exists, unpopulated |
| `customers.business_contact_name` | saved/device contact name per customer | exists, unpopulated |
| `upsert_customer_from_message()` trigger | propagates message → customer, coalesce-safe | exists |
