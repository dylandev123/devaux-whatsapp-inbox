// Batching logic: settings maths, deadline rules (mirrors the SQL), and how a
// batch of stored messages becomes ONE ordered, timestamped customer turn that
// feeds the same safeguards, escalation history and staff notice as a single
// message. The durable scheduling itself is tested against real Postgres in
// aiAgentBatchingSql.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchingActive,
  buildCustomerTurn,
  MEDIA_ONLY_PLACEHOLDER,
  nextDueAt,
  orderBatchMessages,
  singleMessageTurn,
  type StoredBatchMessage,
  validateBatchWindow,
} from "../lib/aiAgent/batching.ts";
import {
  appendCustomerMessage,
  buildStaffNotice,
  CUSTOMER_MESSAGE_SEPARATOR,
  customerMessageSegments,
  detectSafeguards,
  evaluateGate,
} from "../lib/aiAgent/engine.ts";

let seq = 0;
const msg = (over: Partial<StoredBatchMessage> & { text: string }): StoredBatchMessage => {
  seq += 1;
  return {
    id: `id${seq}`,
    whatsappMessageId: `W${seq}`,
    eventId: `E${seq}`,
    hasMedia: false,
    messageAt: null,
    receivedAt: `2026-10-22T14:00:${String(seq % 60).padStart(2, "0")}Z`,
    position: seq,
    ...over,
  };
};

// ── Settings ─────────────────────────────────────────────────────────────────

test("batching is active only when enabled and the quiet period is above zero", () => {
  assert.equal(batchingActive({ batching_enabled: true, batch_quiet_seconds: 45 }), true);
  assert.equal(batchingActive({ batching_enabled: false, batch_quiet_seconds: 45 }), false);
  assert.equal(batchingActive({ batching_enabled: true, batch_quiet_seconds: 0 }), false);
  assert.equal(batchingActive(null), false);
});

test("batch window validation: quiet 0–120, max 10–600, max never below quiet", () => {
  assert.deepEqual(validateBatchWindow({ quiet: 45, maxWait: 180 }), { ok: true, quiet: 45, maxWait: 180 });
  assert.equal(validateBatchWindow({ quiet: 0, maxWait: 10 }).ok, true);
  assert.equal(validateBatchWindow({ quiet: 120, maxWait: 120 }).ok, true);
  for (const bad of [
    { quiet: -1, maxWait: 180 },
    { quiet: 121, maxWait: 180 },
    { quiet: 4.5, maxWait: 180 },
    { quiet: 45, maxWait: 9 },
    { quiet: 45, maxWait: 601 },
    { quiet: 100, maxWait: 60 },
    { quiet: Number.NaN, maxWait: 180 },
  ]) {
    assert.equal(validateBatchWindow(bad).ok, false, JSON.stringify(bad));
  }
});

// ── Deadline rule (same maths as enqueue_ai_agent_batch_message) ─────────────

test("each new message resets the deadline to now + quiet period", () => {
  const first = new Date("2026-10-22T14:00:00Z");
  const at10 = nextDueAt({ now: new Date(first.getTime() + 10_000), firstMessageAt: first, quietSeconds: 45, maxWaitSeconds: 180 });
  const at30 = nextDueAt({ now: new Date(first.getTime() + 30_000), firstMessageAt: first, quietSeconds: 45, maxWaitSeconds: 180 });
  assert.equal(at10.getTime() - first.getTime(), 55_000);
  assert.equal(at30.getTime() - first.getTime(), 75_000, "the later message pushed the deadline back");
});

test("the deadline never passes first message + maximum wait", () => {
  const first = new Date("2026-10-22T14:00:00Z");
  const late = nextDueAt({ now: new Date(first.getTime() + 170_000), firstMessageAt: first, quietSeconds: 45, maxWaitSeconds: 180 });
  assert.equal(late.getTime() - first.getTime(), 180_000);
  // A customer typing every 30 s for 10 minutes still gets handled at the ceiling.
  let due = first;
  for (let t = 0; t <= 600; t += 30) {
    due = nextDueAt({ now: new Date(first.getTime() + t * 1000), firstMessageAt: first, quietSeconds: 45, maxWaitSeconds: 180 });
  }
  assert.equal(due.getTime() - first.getTime(), 180_000);
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test("messages are ordered by original timestamp, not arrival", () => {
  const late = msg({ text: "second", messageAt: "2026-10-22T14:03:20Z" });
  const early = msg({ text: "first", messageAt: "2026-10-22T14:03:05Z" });
  assert.deepEqual(orderBatchMessages([late, early]).map((m) => m.text), ["first", "second"]);
});

test("equal timestamps fall back to arrival order", () => {
  const a = msg({ text: "a", messageAt: "2026-10-22T14:03:05Z" });
  const b = msg({ text: "b", messageAt: "2026-10-22T14:03:05Z" });
  assert.deepEqual(orderBatchMessages([b, a]).map((m) => m.text), ["a", "b"]);
});

test("a message without a timestamp keeps its arrival slot", () => {
  const a = msg({ text: "a", messageAt: "2026-10-22T14:03:05Z" });
  const noStamp = msg({ text: "no-stamp", messageAt: null });
  const c = msg({ text: "c", messageAt: "2026-10-22T14:03:30Z" });
  assert.deepEqual(orderBatchMessages([c, noStamp, a]).map((m) => m.text), ["a", "no-stamp", "c"]);
});

test("a duplicate WhatsApp id appears once", () => {
  const a = msg({ text: "a", whatsappMessageId: "SAME" });
  const dup = msg({ text: "a (retry)", whatsappMessageId: "SAME" });
  assert.equal(orderBatchMessages([a, dup]).length, 1);
});

// ── One coherent turn ────────────────────────────────────────────────────────

test("a batch becomes one turn with ordered, timestamped lines", () => {
  const turn = buildCustomerTurn([
    msg({ text: "also 2 bags of puppy food", messageAt: "2026-10-22T14:03:20Z" }),
    msg({ text: "Hi, do you deliver to Gros Islet?", messageAt: "2026-10-22T14:03:05Z" }),
  ]);
  assert.equal(turn.transcript, "[14:03:05] Hi, do you deliver to Gros Islet?\n[14:03:20] also 2 bags of puppy food");
  assert.equal(turn.text, "Hi, do you deliver to Gros Islet?\nalso 2 bags of puppy food");
  assert.equal(turn.firstAt, "2026-10-22T14:03:05Z");
  assert.equal(turn.lastAt, "2026-10-22T14:03:20Z");
  assert.equal(turn.messages.length, 2);
});

test("media-only messages are kept for staff but are not 'words' for the gate", () => {
  const turn = buildCustomerTurn([msg({ text: "", hasMedia: true, messageAt: "2026-10-22T14:03:05Z" }), msg({ text: "this one please", messageAt: "2026-10-22T14:03:10Z" })]);
  assert.deepEqual(turn.segments, [MEDIA_ONLY_PLACEHOLDER, "this one please"]);
  assert.equal(turn.text, "this one please");
  assert.equal(turn.hasMedia, true);
  const onlyMedia = buildCustomerTurn([msg({ text: "", hasMedia: true })]);
  assert.equal(onlyMedia.text, "");
  // Existing behaviour is preserved: a media-only turn is escalated by the gate.
  const gate = evaluateGate({
    businessSlug: "dog_food",
    chatId: "17585551234@s.whatsapp.net",
    fromMe: false,
    text: onlyMedia.text,
    hasMedia: onlyMedia.hasMedia,
    settings: {
      business_slug: "dog_food", enabled: true, mode: "observe", contact_scope: "all", autonomy: 30, staff_group_jid: null,
      staff_group_name: null, auto_takeover_minutes: 120, max_auto_replies_per_hour: 6, send_holding_reply: true,
      staff_notices_enabled: false, batching_enabled: true, batch_quiet_seconds: 45, batch_max_wait_seconds: 180, customer_memory_enabled: false,
    },
    contactRule: null,
    conversation: null,
    staffActiveAt: null,
    now: new Date(),
  });
  assert.deepEqual(gate, { pass: false, decision: "ESCALATE", reasons: ["unsupported_media"] });
});

test("the primary event is the newest message's; every event is tracked", () => {
  const turn = buildCustomerTurn([msg({ text: "one", eventId: "EV1" }), msg({ text: "two", eventId: "EV2" }), msg({ text: "three", eventId: "EV3" })]);
  assert.equal(turn.primaryEventId, "EV3");
  assert.deepEqual(turn.eventIds, ["EV1", "EV2", "EV3"]);
});

test("a multi-day batch labels each line with its date", () => {
  const turn = buildCustomerTurn([
    msg({ text: "late night", messageAt: "2026-10-22T23:59:00Z" }),
    msg({ text: "next morning", messageAt: "2026-10-23T00:01:00Z" }),
  ]);
  assert.match(turn.transcript, /^\[2026-10-22 23:59:00\] late night\n\[2026-10-23 00:01:00\] next morning$/);
});

test("a single live message is a one-message turn (batching off, or quiet period 0)", () => {
  const turn = singleMessageTurn({ whatsappMessageId: "W9", eventId: "E9", text: "How much is chicken?", hasMedia: false, timestamp: "2026-10-22T14:03:05Z" });
  assert.equal(turn.text, "How much is chicken?");
  assert.equal(turn.primaryEventId, "E9");
  assert.deepEqual(turn.whatsappMessageIds, ["W9"]);
});

// ── One decision, from the WHOLE turn ────────────────────────────────────────

test("safeguards see every message of the turn, not just the last", () => {
  const turn = buildCustomerTurn([
    msg({ text: "My order arrived and the bag was damaged", messageAt: "2026-10-22T14:03:00Z" }),
    msg({ text: "anyway can I get another 2 bags", messageAt: "2026-10-22T14:03:20Z" }),
  ]);
  assert.ok(detectSafeguards(turn.text).includes("complaint"));
  assert.deepEqual(detectSafeguards("anyway can I get another 2 bags"), []);
});

test("one escalation history for the turn, in order, without duplicates", () => {
  const turn = buildCustomerTurn([
    msg({ text: "Hi", messageAt: "2026-10-22T14:03:00Z" }),
    msg({ text: "I want 3 bags of lamb", messageAt: "2026-10-22T14:03:10Z" }),
    msg({ text: "delivered to Rodney Bay please", messageAt: "2026-10-22T14:03:15Z" }),
  ]);
  const stored = appendCustomerMessage(null, turn.segments.join(CUSTOMER_MESSAGE_SEPARATOR));
  assert.deepEqual(customerMessageSegments(stored), ["I want 3 bags of lamb", "delivered to Rodney Bay please"]);
  // Reprocessing the same batch (a retry) adds nothing.
  assert.equal(appendCustomerMessage(stored, turn.segments.join(CUSTOMER_MESSAGE_SEPARATOR)), stored);
});

test("a follow-up batch on an open escalation appends only the new messages", () => {
  const first = appendCustomerMessage(null, ["I want 3 bags of lamb", "to Rodney Bay"].join(CUSTOMER_MESSAGE_SEPARATOR));
  const next = appendCustomerMessage(first, ["to Rodney Bay", "actually make it 4 bags"].join(CUSTOMER_MESSAGE_SEPARATOR));
  assert.deepEqual(customerMessageSegments(next), ["I want 3 bags of lamb", "to Rodney Bay", "actually make it 4 bags"]);
});

test("the staff notice for a batched turn is built from every message and keeps history apart from the request", () => {
  const turn = buildCustomerTurn([
    msg({ text: "Can I get the 15kg chicken?", messageAt: "2026-10-22T14:03:00Z" }),
    msg({ text: "2 bags, deliver Friday morning", messageAt: "2026-10-22T14:03:12Z" }),
  ]);
  const notice = buildStaffNotice({
    refCode: "E-7K3QX",
    priority: "normal",
    customerLabel: "Jane · 17585551234",
    reasons: ["order_approval"],
    customerMessage: turn.segments.join(CUSTOMER_MESSAGE_SEPARATOR),
    summary: null,
    draftReply: null,
    orderRequest: {
      items: [{ product: "15kg chicken", quantity: "2" }],
      delivery_address: "Rodney Bay",
      delivery_preference: "Friday morning",
      notes: null,
    },
    followUp: false,
    observeOnly: true,
    history: ["✔ Confirmed order: 15kg chicken ×2 — 12 Oct 2026"],
  });
  assert.match(notice, /Can I get the 15kg chicken\?/);
  assert.match(notice, /2 bags, deliver Friday morning/);
  const historyAt = notice.indexOf("*Customer history*");
  const orderAt = notice.indexOf("*Order details* (NOT confirmed)");
  assert.ok(historyAt > -1 && orderAt > -1, notice);
  assert.ok(notice.indexOf("✔ Confirmed order") > historyAt);
  assert.equal((notice.match(/AI escalation #E-7K3QX/g) ?? []).length, 1);
});

test("a notice without any history has no history section", () => {
  const notice = buildStaffNotice({
    refCode: "E-AAAA1", priority: "low", customerLabel: "x", reasons: [], customerMessage: "hello there",
    summary: null, draftReply: null, orderRequest: null, followUp: false,
  });
  assert.doesNotMatch(notice, /Customer history/);
});
