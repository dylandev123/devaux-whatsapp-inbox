// Daily order tracking: the pure rules (lib/aiAgent/orders.ts) — merge, confirmation, cancellation, target
// resolution, timezone scheduling and the morning report.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseModelProposal, type OrderRequestDraft } from "../lib/aiAgent/engine.ts";
import { groundOrderDraft } from "../lib/aiAgent/escalationUpdates.ts";
import {
  buildOrderSummary,
  CATCH_UP_HOURS,
  computeMissing,
  isPureConfirmation,
  isUpdateCommand,
  isWholeOrderCancellation,
  localParts,
  mergeDraft,
  orderItemText,
  formatLine,
  planOrderUpdate,
  resolveOrderTarget,
  scheduleState,
  turnIsConfirmation,
  type OrderFields,
  type TrackedOrder,
} from "../lib/aiAgent/orders.ts";

const draft = (over: Partial<OrderRequestDraft> = {}): OrderRequestDraft => ({
  items: [{ product: "Monello Chicken", quantity: "2", size: "15kg" }],
  delivery_address: "12 Main St, Gros Islet",
  delivery_preference: "delivery",
  notes: null,
  requested_for: "Friday morning",
  ...over,
});

const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => ({
  id: "o1",
  ref_code: "O-AAAAA",
  business_slug: "dog_food",
  chat_id: "17585550101@s.whatsapp.net",
  contact_number: "17585550101",
  customer_name: "Jane",
  status: "awaiting_confirmation",
  items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: "15kg" }],
  fulfilment_method: "delivery",
  delivery_preference: "delivery",
  delivery_address: "12 Main St, Gros Islet",
  requested_for: "Friday morning",
  notes: null,
  missing_fields: [],
  attention: null,
  source_message_ids: ["m1"],
  first_message_at: "2026-10-26T14:00:00Z",
  last_message_at: "2026-10-26T14:00:00Z",
  awaiting_since: "2026-10-26T14:00:00Z",
  manual_locked_fields: [],
  field_conflicts: {},
  confirmed_by: null,
  confirmed_at: null,
  customer_confirmed_at: null,
  cancelled_at: null,
  cancel_reason: null,
  fulfilled_at: null,
  version: 1,
  created_at: "2026-10-26T14:00:00Z",
  updated_at: "2026-10-26T14:00:00Z",
  ...over,
});

const NOW = new Date("2026-10-27T12:30:00Z"); // 08:30 in St Lucia (UTC-4, no DST)

describe("confirmation needs the customer's own unambiguous words", () => {
  test("clear confirmations", () => {
    for (const t of ["yes", "Yes please", "confirmed", "I confirm", "yes confirm", "go ahead", "Yes, that's correct", "correct", "yes please proceed".replace("please proceed", "go ahead")]) {
      assert.equal(isPureConfirmation(t), true, t);
    }
  });
  test("ambiguous or hedged replies never confirm", () => {
    for (const t of ["ok", "okay", "sure", "👍", "maybe", "I think so", "yes but make it 3", "yes?", "not yet", "let me check", "no", "yes tomorrow instead", "thanks", "alright"]) {
      assert.equal(isPureConfirmation(t), false, t);
    }
  });
  test("a turn is a confirmation only when every message is one or a pleasantry", () => {
    assert.equal(turnIsConfirmation(["yes", "thanks"]), true);
    assert.equal(turnIsConfirmation(["thanks"]), false);
    assert.equal(turnIsConfirmation(["yes", "also add one bag of rice"]), false);
  });
});

describe("planOrderUpdate", () => {
  const base = { fields: order() as OrderFields, now: NOW, customerTexts: ["yes"] };

  test("awaiting + complete + 'yes' + a person wrote since → confirmed by the customer", () => {
    const plan = planOrderUpdate({ ...base, existing: order(), contentChanged: false, outboundSinceAwaiting: true, customerMayConfirm: true });
    assert.equal(plan.status, "confirmed");
    assert.equal(plan.confirmedByCustomer, true);
  });

  test("rollout default: the customer's yes is recorded but only staff can finalize", () => {
    const plan = planOrderUpdate({ ...base, existing: order(), contentChanged: false, outboundSinceAwaiting: true });
    assert.equal(plan.status, "awaiting_confirmation");
    assert.equal(plan.event, "customer_replied_yes");
    assert.equal(plan.attention, "customer_replied_yes");
    assert.ok(plan.customerConfirmedAt);
    // A second yes changes nothing; a change to the order voids the recorded yes.
    const replied = order({ attention: "customer_replied_yes", customer_confirmed_at: "2026-10-27T12:00:00Z" });
    assert.equal(planOrderUpdate({ ...base, existing: replied, contentChanged: false, outboundSinceAwaiting: true }).event, "no_change");
    const changed = planOrderUpdate({ ...base, existing: replied, contentChanged: true, outboundSinceAwaiting: false, customerTexts: ["make it 3"] });
    assert.equal(changed.customerConfirmedAt, null);
    assert.equal(changed.attention, null);
  });

  test("nothing for the customer to say yes to: no confirmation", () => {
    const plan = planOrderUpdate({ ...base, existing: order(), contentChanged: false, outboundSinceAwaiting: false });
    assert.equal(plan.status, "awaiting_confirmation");
  });

  test("a 'yes' that also changes the order is a correction, not a confirmation", () => {
    const plan = planOrderUpdate({ ...base, existing: order(), contentChanged: true, outboundSinceAwaiting: true });
    assert.notEqual(plan.status, "confirmed");
  });

  test("an incomplete order cannot be confirmed", () => {
    const o = order({ status: "possible", delivery_address: null, missing_fields: ["delivery_address"] });
    const plan = planOrderUpdate({ existing: o, fields: { ...o }, contentChanged: false, customerTexts: ["yes"], outboundSinceAwaiting: true, now: NOW });
    assert.equal(plan.status, "possible");
  });

  test("a new order is possible until complete, then awaiting confirmation — never confirmed", () => {
    const incomplete = mergeDraft(null, draft({ delivery_address: null }), []).fields;
    assert.equal(planOrderUpdate({ existing: null, fields: incomplete, contentChanged: true, customerTexts: ["2 bags"], outboundSinceAwaiting: false, now: NOW }).status, "possible");
    const complete = mergeDraft(null, draft(), []).fields;
    assert.equal(planOrderUpdate({ existing: null, fields: complete, contentChanged: true, customerTexts: ["2 bags"], outboundSinceAwaiting: false, now: NOW }).status, "awaiting_confirmation");
  });

  test("changing a confirmed order sends it back for confirmation and flags it", () => {
    const o = order({ status: "confirmed", confirmed_by: "customer" });
    const plan = planOrderUpdate({ existing: o, fields: o, contentChanged: true, customerTexts: ["make it 3"], outboundSinceAwaiting: false, now: NOW });
    assert.equal(plan.status, "awaiting_confirmation");
    assert.equal(plan.attention, "changed_after_confirmation");
  });

  test("whole-order cancellation cancels an unconfirmed order; a confirmed one is only flagged", () => {
    assert.equal(planOrderUpdate({ existing: order(), fields: order(), contentChanged: false, customerTexts: ["please cancel my order"], outboundSinceAwaiting: false, now: NOW }).status, "cancelled");
    const confirmed = order({ status: "confirmed" });
    const plan = planOrderUpdate({ existing: confirmed, fields: confirmed, contentChanged: false, customerTexts: ["please cancel my order"], outboundSinceAwaiting: false, now: NOW });
    assert.equal(plan.status, "confirmed");
    assert.equal(plan.attention, "cancellation_requested");
  });

  test("partial or ambiguous cancellation is flagged, not applied", () => {
    assert.equal(isWholeOrderCancellation("cancel the chicken, keep the rice"), false);
    assert.equal(isWholeOrderCancellation("cancel the delivery, I'll collect"), false);
    assert.equal(isWholeOrderCancellation("cancel my order"), true);
    const plan = planOrderUpdate({ existing: order(), fields: order(), contentChanged: false, customerTexts: ["cancel the chicken"], outboundSinceAwaiting: false, now: NOW });
    assert.equal(plan.status, "awaiting_confirmation");
    assert.equal(plan.attention, "cancellation_requested");
  });
});

describe("merging corrections and respecting manual edits", () => {
  test("a correction replaces the quantity; the rest is kept", () => {
    const merged = mergeDraft(order(), draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "15kg" }], delivery_address: null, requested_for: null }), []);
    assert.equal(merged.fields.items[0].quantity, "3");
    assert.equal(merged.fields.delivery_address, "12 Main St, Gros Islet");
    assert.deepEqual(merged.changes.map((c) => c.field), ["items"]);
  });
  test("an identical draft changes nothing", () => {
    assert.equal(mergeDraft(order(), draft(), []).changes.length, 0);
  });
  test("a field a person edited is never overwritten by the AI", () => {
    const merged = mergeDraft(order(), draft({ delivery_address: "Somewhere else" }), ["delivery_address"]);
    assert.equal(merged.fields.delivery_address, "12 Main St, Gros Islet");
  });
  test("collection needs no address; delivery does", () => {
    assert.deepEqual(computeMissing({ items: order().items, fulfilment_method: "collection", delivery_address: null, requested_for: "Fri" }), []);
    assert.deepEqual(computeMissing({ items: order().items, fulfilment_method: "delivery", delivery_address: null, requested_for: "Fri" }), ["delivery_address"]);
    assert.deepEqual(computeMissing({ items: [{ product: "x", quantity: null, variant: null, size: null }], fulfilment_method: null, delivery_address: null, requested_for: null }), ["quantity", "fulfilment_method", "requested_for"]);
  });
});

describe("which order does a turn belong to", () => {
  const a = order({ id: "a", ref_code: "O-AAAAA" });
  const b = order({ id: "b", ref_code: "O-BBBBB", items: [{ product: "Rice", quantity: "1", variant: null, size: null }] });
  const rice = draft({ items: [{ product: "Rice", quantity: "2" }] });

  test("a valid reference wins; an invented one is ignored", () => {
    assert.equal(resolveOrderTarget([a, b], "O-BBBBB", rice).kind === "merge" && (resolveOrderTarget([a, b], "O-BBBBB", rice) as { order: TrackedOrder }).order.id, "b");
    const invented = resolveOrderTarget([a, b], "O-ZZZZZ", draft({ items: [{ product: "Treats", quantity: "1" }] }));
    assert.equal(invented.kind, "create");
  });
  test("'new' starts another order (multiple orders per customer)", () => {
    assert.equal(resolveOrderTarget([a], "new", draft({ items: [{ product: "Treats", quantity: "1" }] })).kind, "create");
  });
  test("the same order again is never a second copy", () => {
    const again = resolveOrderTarget([a], "new", draft());
    assert.equal(again.kind, "merge");
  });
  test("one open order and no reference: it joins that order", () => {
    assert.equal(resolveOrderTarget([a], null, draft({ items: [{ product: "Treats", quantity: "1" }] })).kind, "merge");
  });
  test("several open orders, no reference, no overlap: a flagged new order, nothing guessed", () => {
    const r = resolveOrderTarget([a, b], null, draft({ items: [{ product: "Treats", quantity: "1" }] }));
    assert.deepEqual(r, { kind: "create", flag: "check_if_duplicate" });
  });
});

describe("model output and grounding for tracking", () => {
  test("variant, size, requested_for, order_target and other_orders are parsed; absent keys stay absent", () => {
    const p = parseModelProposal(
      JSON.stringify({
        decision: "ESCALATE",
        intent: "order",
        order_target: "O-AAAAA",
        order_request: { items: [{ product: "Monello", quantity: 2, variant: "Chicken", size: "15kg" }], delivery_address: null, delivery_preference: "delivery", notes: null, requested_for: "Friday" },
        other_orders: [{ target: "new", order_request: { items: [{ product: "Treats", quantity: "1" }] } }],
      })
    );
    assert.equal(p.order_target, "O-AAAAA");
    assert.deepEqual(p.order_request?.items[0], { product: "Monello", quantity: "2", variant: "Chicken", size: "15kg" });
    assert.equal(p.order_request?.requested_for, "Friday");
    assert.equal(p.other_orders?.length, 1);
    const plain = parseModelProposal(JSON.stringify({ decision: "ASK", intent: "order", order_request: { items: [{ product: "Bag", quantity: "2" }] } }));
    assert.deepEqual(plain.order_request?.items, [{ product: "Bag", quantity: "2" }]);
    assert.equal("order_target" in plain, false);
  });
  test("nothing the customer did not write survives grounding (no invented variant, size or time)", () => {
    const grounded = groundOrderDraft(
      { items: [{ product: "Monello Chicken", quantity: "2", variant: "Salmon", size: "20kg" }], delivery_address: null, delivery_preference: null, notes: null, requested_for: "Tuesday at 3pm" },
      null,
      ["I want 2 Monello Chicken please"]
    )!;
    assert.deepEqual(grounded.items, [{ product: "Monello Chicken", quantity: "2" }]);
    assert.equal(grounded.requested_for, undefined);
  });
  test("grounding keeps what the customer wrote", () => {
    const grounded = groundOrderDraft(
      { items: [{ product: "Monello Chicken", quantity: "2", size: "15kg" }], delivery_address: null, delivery_preference: null, notes: null, requested_for: "Friday morning" },
      null,
      ["2 Monello Chicken 15kg for Friday morning"]
    )!;
    assert.equal(grounded.items[0].size, "15kg");
    assert.equal(grounded.requested_for, "Friday morning");
  });
});

describe("timezone-aware schedule", () => {
  const tz = "America/St_Lucia";
  test("localParts uses St Lucia time (UTC-4)", () => {
    assert.deepEqual(localParts(new Date("2026-10-27T11:59:00Z"), tz), { dateKey: "2026-10-27", minutes: 7 * 60 + 59 });
    assert.deepEqual(localParts(new Date("2026-10-27T03:30:00Z"), tz), { dateKey: "2026-10-26", minutes: 23 * 60 + 30 });
  });
  test("not due before 08:00, due from 08:00 St Lucia time (12:00 UTC)", () => {
    const at = (iso: string) => scheduleState({ now: new Date(iso), timezone: tz, hour: 8, lastRunDate: null }).state;
    assert.equal(at("2026-10-27T11:59:00Z"), "not_yet");
    assert.equal(at("2026-10-27T12:00:00Z"), "due");
    assert.equal(at("2026-10-27T15:00:00Z"), "due");
  });
  test("a day already run is done; the next local day is due again", () => {
    assert.equal(scheduleState({ now: new Date("2026-10-27T13:00:00Z"), timezone: tz, hour: 8, lastRunDate: "2026-10-27" }).state, "done");
    assert.equal(scheduleState({ now: new Date("2026-10-28T12:01:00Z"), timezone: tz, hour: 8, lastRunDate: "2026-10-27" }).state, "due");
  });
  test("a long outage is recorded as missed, not sent as a late 'morning' report", () => {
    const late = new Date(`2026-10-27T${String(12 + CATCH_UP_HOURS).padStart(2, "0")}:00:00Z`);
    assert.equal(scheduleState({ now: late, timezone: tz, hour: 8, lastRunDate: null }).state, "missed");
    assert.equal(scheduleState({ now: new Date("2026-10-27T17:59:00Z"), timezone: tz, hour: 8, lastRunDate: null }).state, "due");
  });
  test("the date in the key is the business's local date, not UTC", () => {
    // 01:00 UTC on the 28th is still the 27th in St Lucia.
    assert.equal(localParts(new Date("2026-10-28T01:00:00Z"), tz).dateKey, "2026-10-27");
  });
});

describe("!update is exactly that command", () => {
  test("recognition", () => {
    for (const t of ["!update", "!UPDATE", "  !update  ", "!update."]) assert.equal(isUpdateCommand(t), true, t);
    for (const t of ["update", "!update the price", "please !update", "!updates", "!status"]) assert.equal(isUpdateCommand(t), false, t);
  });
});

describe("the morning report", () => {
  const today = "2026-10-27T10:30:00Z"; // 06:30 St Lucia, the same local day as NOW
  const confirmed = order({ id: "c1", ref_code: "O-CONF1", status: "confirmed", confirmed_by: "customer", first_message_at: today, last_message_at: today });
  const carried = order({ id: "c2", ref_code: "O-CARRY", status: "confirmed", first_message_at: "2026-10-25T14:00:00Z", customer_name: "Marcus", contact_number: "17585550102" });
  const needs = order({ id: "n1", ref_code: "O-NEED1", status: "possible", delivery_address: null, missing_fields: ["delivery_address", "requested_for"], customer_name: "Priya", contact_number: null, first_message_at: today, last_message_at: today });
  const stale = order({ id: "s1", ref_code: "O-STALE", status: "possible", last_message_at: "2026-10-10T14:00:00Z", first_message_at: "2026-10-10T14:00:00Z" });
  const input = { businessLabel: "Dog Food", timezone: "America/St_Lucia", now: NOW, trigger: "scheduled" as const };

  test("groups Confirmed and Open orders, numbers them, and prints only what is known", () => {
    const r = buildOrderSummary({ ...input, orders: [confirmed, carried, needs] });
    assert.equal(r.confirmed, 2);
    assert.equal(r.attention, 1);
    assert.equal(r.carriedForward, 1);
    assert.match(r.text, /^📋 \*DAILY ORDERS — 27 OCT\*\n3 orders · 2 confirmed · 1 open/);
    assert.match(r.text, /✅ \*CONFIRMED\*\n/);
    assert.match(r.text, /📦 \*OPEN ORDERS\*\n/);
    assert.match(r.text, /\*3\. Priya · #NEED1\*/);
    assert.match(r.text, /\*[12]\. Marcus · #CARRY\*\n\+1 758-555-0102|\*[12]\. Marcus · #CARRY\*\n555-0102/);
    assert.match(r.text, /2 × Monello Chicken 15kg/);
    // Priya lacks an address and a phone: nothing is said about either.
    const priya = r.text.slice(r.text.indexOf("*3. Priya"));
    assert.doesNotMatch(r.text, /Needs |Status:|Missing:|Phone:|phone not verified|carried forward|Unnamed|none|None|⚠️|quantity needed/i);
    assert.equal((priya.match(/\n/g) ?? []).length, 2, "name line, one product line, delivery");
  });
  test("an unknown quantity shows only the product name", () => {
    const o = order({ ref_code: "O-NOQTY", status: "possible", items: [{ product: "Pool Salt", quantity: null, variant: null, size: null }, { product: "Bandit", quantity: "2", variant: null, size: "15kg" }] });
    const text = buildOrderSummary({ ...input, orders: [o] }).text;
    assert.match(text, /\nPool Salt\n2 × Bandit 15kg\n/);
    assert.doesNotMatch(text, /\?|needed/);
  });
  test("headings appear only for sections that have orders", () => {
    const onlyOpen = buildOrderSummary({ ...input, orders: [needs] });
    assert.doesNotMatch(onlyOpen.text, /CONFIRMED/);
    assert.match(onlyOpen.text, /1 order · 0 confirmed · 1 open/);
    const onlyConfirmed = buildOrderSummary({ ...input, orders: [confirmed] });
    assert.match(onlyConfirmed.text, /✅ \*CONFIRMED\*/);
    assert.doesNotMatch(onlyConfirmed.text, /OPEN ORDERS|⚠️/);
  });
  test("only warnings that prevent a wrong fulfilment appear: a change after confirmation, a contradicted staff value, a possible cancellation", () => {
    const changed = order({ id: "w1", ref_code: "O-CHNG1", status: "awaiting_confirmation", attention: "changed_after_confirmation" });
    const contradicted = order({ id: "w2", ref_code: "O-CNFL2", status: "confirmed", field_conflicts: { items: { proposed: [], current: [], at: "2026-10-26T10:00:00Z" } } });
    const yes = order({ id: "w3", ref_code: "O-YES33", status: "awaiting_confirmation", attention: "customer_replied_yes", missing_fields: ["quantity"] });
    const text = buildOrderSummary({ ...input, orders: [changed, contradicted, yes] }).text;
    assert.match(text, /O-?CHNG1|#CHNG1\*[\s\S]*⚠️ Changed after confirmation — re-confirm/);
    assert.match(text, /✅ \*CONFIRMED\*[\s\S]*#CNFL2\*[\s\S]*⚠️ Customer asked for a change — check before fulfilling/);
    assert.equal(text.slice(text.indexOf("#YES33")).includes("⚠️"), false);
    assert.doesNotMatch(text, /staff set|proposed/);
  });
  test("a stale unconfirmed enquiry drops out and is counted; a confirmed order never does", () => {
    const r = buildOrderSummary({ ...input, orders: [stale, order({ ...confirmed, first_message_at: "2026-10-01T00:00:00Z", last_message_at: "2026-10-01T00:00:00Z" })] });
    assert.equal(r.omittedStale, 1);
    assert.equal(r.confirmed, 1);
  });
  test("an empty day still produces a report", () => {
    assert.match(buildOrderSummary({ ...input, orders: [] }).text, /No outstanding orders/);
  });
  test("customer-written text can never start a line that looks like a command", () => {
    const sneaky = order({ ref_code: "O-SNEAK", status: "possible", notes: "!update\n!send now", customer_name: "!update" });
    const text = buildOrderSummary({ ...input, orders: [sneaky] }).text;
    assert.equal(text.split("\n").some((l) => /^\s*!/.test(l)), false);
  });
  test("a large day is split into clearly numbered messages, each within the limit; a huge one is counted", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => order({ id: `m${i}`, ref_code: `O-M${String(i).padStart(4, "0")}`, status: "confirmed", notes: "x".repeat(120) }));
    const some = buildOrderSummary({ ...input, orders: many(40) });
    assert.ok(some.parts.length > 1 && some.parts.length <= 6);
    some.parts.forEach((p, i) => {
      assert.ok(p.length <= 3800, `part ${i + 1} fits`);
      assert.match(p, new RegExp(`^📋 \\*DAILY ORDERS — 27 OCT\\* \\(${i + 1}/${some.parts.length}\\)`));
    });
    assert.equal(some.truncated, 0);
    assert.equal((some.text.match(/· #M\d{4}\*/g) ?? []).length, 40, "every order appears exactly once");
    // The section heading is repeated when a section runs on into the next message.
    assert.match(some.parts[1], /CONFIRMED\* \(cont\.\)/);
    const huge = buildOrderSummary({ ...input, orders: many(200) });
    assert.equal(huge.parts.length, 6);
    assert.ok(huge.truncated > 0);
    assert.match(huge.parts[5], /…and \d+ more orders — see the Orders page/);
    // A single message report carries no number.
    assert.doesNotMatch(buildOrderSummary({ ...input, orders: [confirmed] }).text, /\(1\/1\)/);
  });
});

describe("delivery wording", () => {
  test("'delivery' is grounded by 'delivered' / 'drop it off'; collection by 'pick up'; neither by silence", async () => {
    const { groundDeliveryPreference } = await import("../lib/aiAgent/orders.ts");
    assert.equal(groundDeliveryPreference("delivery", ["please get it delivered to Gros Islet"]), "delivery");
    assert.equal(groundDeliveryPreference("delivery", ["can you drop it off tomorrow"]), "delivery");
    assert.equal(groundDeliveryPreference("collection", ["I will pick up on Friday"]), "collection");
    assert.equal(groundDeliveryPreference("delivery", ["I want 2 bags"]), null);
    assert.equal(groundDeliveryPreference("delivery", ["I'll pick up"]), null);
    assert.equal(groundDeliveryPreference("whenever", ["whenever"]), null);
  });
});

describe("who may receive the order summary", () => {
  test("the outbox gate: a separate orders group takes the summary only, in the modes the staff group takes notices", async () => {
    const { outboxAllowed, canPostOrderSummary, ordersGroupJid } = await import("../lib/aiAgent/engine.ts");
    const base = {
      business_slug: "dog_food", enabled: true, mode: "approval_pilot", contact_scope: "all", autonomy: 30,
      staff_group_jid: "staff@g.us", staff_group_name: null, auto_takeover_minutes: 0, max_auto_replies_per_hour: 5,
      send_holding_reply: false, staff_notices_enabled: false, batching_enabled: false, batch_quiet_seconds: 0,
      batch_max_wait_seconds: 10, customer_memory_enabled: false, orders_summary_enabled: true, orders_group_jid: "orders@g.us",
    } as never as import("../lib/aiAgent/engine.ts").AgentSettings;
    const s = (over: object) => ({ ...base, ...over }) as import("../lib/aiAgent/engine.ts").AgentSettings;

    assert.equal(ordersGroupJid(s({ orders_group_jid: null })), "staff@g.us");
    assert.equal(outboxAllowed(base, { kind: "staff_notice", toJid: "orders@g.us" }), true);
    assert.equal(outboxAllowed(base, { kind: "staff_feedback", toJid: "orders@g.us" }), true);
    // Never a customer kind, never to a group nobody configured.
    for (const kind of ["customer_reply", "holding_reply", "staff_relay", "staff_draft"]) assert.equal(outboxAllowed(base, { kind, toJid: "orders@g.us" }), false, kind);
    assert.equal(outboxAllowed(base, { kind: "staff_notice", toJid: "other@g.us" }), false);
    // Off, or the agent off: nothing.
    assert.equal(outboxAllowed(s({ orders_summary_enabled: false }), { kind: "staff_notice", toJid: "orders@g.us" }), false);
    assert.equal(outboxAllowed(s({ enabled: false }), { kind: "staff_notice", toJid: "orders@g.us" }), false);
    // Observe: only with staff notices on, and only the notice kind.
    assert.equal(outboxAllowed(s({ mode: "observe" }), { kind: "staff_notice", toJid: "orders@g.us" }), false);
    assert.equal(outboxAllowed(s({ mode: "observe", staff_notices_enabled: true }), { kind: "staff_notice", toJid: "orders@g.us" }), true);
    assert.equal(outboxAllowed(s({ mode: "observe", staff_notices_enabled: true }), { kind: "staff_feedback", toJid: "orders@g.us" }), false);
    // The staff group's own rules are unchanged.
    assert.equal(outboxAllowed(base, { kind: "staff_notice", toJid: "staff@g.us" }), true);
    assert.equal(outboxAllowed(s({ mode: "observe" }), { kind: "staff_notice", toJid: "staff@g.us" }), false);
    assert.equal(canPostOrderSummary(s({ orders_group_jid: null, staff_group_jid: null })), false);
  });
});

describe("locked fields and incomplete products", () => {
  const base: OrderFields = { customer_name: null, items: [{ product: "Monello", quantity: "3", variant: null, size: null }], fulfilment_method: "delivery", delivery_preference: "delivery", delivery_address: "Cap Estate", requested_for: null, notes: null };
  test("a locked field is kept and the contradiction is returned only when stated this turn", () => {
    const d = draft({ items: [{ product: "Monello", quantity: "5" }], delivery_address: "Cap Estate", requested_for: null });
    const kept = mergeDraft(base, d, ["items"], null, () => true);
    assert.equal(kept.fields.items[0].quantity, "3");
    assert.deepEqual(kept.changes, []);
    assert.deepEqual(kept.conflicts.map((c) => c.field), ["items"]);
    assert.deepEqual(mergeDraft(base, d, ["items"], null, () => false).conflicts, []);
    assert.deepEqual(mergeDraft(base, d, ["items"]).conflicts, []);
  });
  test("a quantity-less product reads 'quantity needed', never '? ×'", () => {
    const line = { product: "Monello", quantity: null, variant: null, size: "25kg" };
    assert.equal(orderItemText(line), "Monello 25kg — quantity needed");
    assert.equal(formatLine(line), "Monello (25kg) — quantity needed");
    assert.equal(orderItemText({ ...line, quantity: "2" }), "2 × Monello 25kg");
  });
});
