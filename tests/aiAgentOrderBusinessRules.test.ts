// Business rules for tracked orders (Cool & Pool / dog food): delivery by default, the 9 AM day default, conversation
// context, customer identity, alternate contacts, verified locations, and the repair of existing orders.
//
// Part 1 is pure. Part 2 runs the app's REAL server code against the REAL migrations in a throwaway Postgres (skipped when no
// Postgres binaries are installed); only the language model is a scripted stand-in.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import {
  DEFAULT_ORDER_CUTOFF_HOUR,
  defaultOrderDate,
  deliveryContactIn,
  effectiveDate,
  effectiveMethod,
  groundedContactPhone,
  isPhoneOnlyNote,
  isTimeOnlyPhrase,
  keepDefaultedDay,
  nameStated,
  phonesIn,
  withCreationDefaults,
  withDeliveryContact,
} from "../lib/aiAgent/orderDefaults.ts";
import { addressProvenance, addressSourceLine, addressTag, type AddressEvent } from "../lib/aiAgent/orderAddress.ts";
import { moreInfoReply } from "../lib/aiAgent/orderCommands.ts";
import { orderContextWindow, ORDER_CONTEXT_MESSAGES } from "../lib/aiAgent/orderMonitor.ts";
import { askForMissingFields, missingOrderFields } from "../lib/aiAgent/engine.ts";
import { detectHistoryCue, resolveFromHistory, type FillContext, type HistoryCue, type HistoryOrder } from "../lib/aiAgent/orderHistory.ts";
import { planRepair, type RepairContext, type RepairMessage } from "../lib/aiAgent/orderRepair.ts";
import { buildOrdersView, bucketOf, dayContext, orderDate, orderGaps } from "../lib/aiAgent/orderViews.ts";
import { computeMissing, emptyFields, isReliableName, type OrderFields, type TrackedOrder } from "../lib/aiAgent/orders.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const TZ = "America/St_Lucia"; // UTC-4, no daylight saving

let n = 0;
const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => {
  n += 1;
  return {
    id: `o${n}`, ref_code: `O-BRL${String(n).padStart(2, "0")}`, business_slug: "dog_food", chat_id: "17585550101@s.whatsapp.net", contact_number: "17585550101",
    customer_name: "Jane", status: "possible", items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: "25kg" }],
    fulfilment_method: null, delivery_preference: null, delivery_address: "Cap Estate", requested_for: null, notes: null, missing_fields: [], attention: null,
    source_message_ids: [], first_message_at: "2026-10-26T14:00:00Z", last_message_at: "2026-10-26T14:30:00Z", awaiting_since: null, manual_locked_fields: [],
    field_conflicts: {}, confirmed_by: null, confirmed_at: null, customer_confirmed_at: null, cancelled_at: null, cancel_reason: null, fulfilled_at: null,
    version: 3, created_at: "2026-10-26T14:00:00Z", updated_at: "2026-10-26T14:30:00Z", ...over,
  };
};

describe("default order day: before 9:00 AM Saint Lucia time it is today, from 9:00 it is tomorrow", () => {
  test("the cutoff is exactly 9:00 local, counted from when the customer wrote the request", () => {
    assert.equal(DEFAULT_ORDER_CUTOFF_HOUR, 9);
    assert.equal(defaultOrderDate("2026-10-28T12:59:59Z", TZ), "2026-10-28", "08:59:59 local → today");
    assert.equal(defaultOrderDate("2026-10-28T13:00:00Z", TZ), "2026-10-29", "09:00:00 local → tomorrow");
    assert.equal(defaultOrderDate("2026-10-28T04:00:00Z", TZ), "2026-10-28", "00:00 local → today");
    assert.equal(defaultOrderDate("2026-10-28T03:59:59Z", TZ), "2026-10-28", "23:59:59 on the 27th local: UTC is already the 28th, local says tomorrow = the 28th");
  });
  test("the local date, not the UTC date, decides: a late-evening message is for the next LOCAL day", () => {
    // 22:30 on Wed 28 Oct in St Lucia is 02:30 UTC on the 29th.
    assert.equal(defaultOrderDate("2026-10-29T02:30:00Z", TZ), "2026-10-29");
    // 06:00 local on the 29th is 10:00 UTC the same day.
    assert.equal(defaultOrderDate("2026-10-29T10:00:00Z", TZ), "2026-10-29");
  });
  test("month and year boundaries roll correctly", () => {
    assert.equal(defaultOrderDate("2026-12-31T15:00:00Z", TZ), "2027-01-01");
    assert.equal(defaultOrderDate("2026-02-28T15:00:00Z", TZ), "2026-03-01");
  });
  test("an unreadable timestamp gives no default instead of a wrong day", () => {
    assert.equal(defaultOrderDate("not a time", TZ), null);
  });
  test("the day is assigned from the order's own timestamp: it does not move when midnight passes or time goes on", () => {
    const o = order({ first_message_at: "2026-10-28T12:30:00Z" }); // 08:30 local on the 28th → today (the 28th)
    assert.equal(orderDate(o, TZ), "2026-10-28");
    // Looked at on the 28th, the 29th or the 30th, it is the same day: the buckets move, the order does not.
    assert.equal(bucketOf(o, dayContext(new Date("2026-10-28T20:00:00Z"), TZ)), "today");
    assert.equal(bucketOf(o, dayContext(new Date("2026-10-29T16:00:00Z"), TZ)), "overdue");
    assert.equal(orderDate(order({ ...o, last_message_at: "2026-10-30T20:00:00Z" }), TZ), "2026-10-28", "a later message does not shift it");
  });
  test("an explicit date wins over the default, and an explicit time keeps its wording", () => {
    const stated = order({ requested_for: "Fri 30 Oct (Friday morning)", first_message_at: "2026-10-28T12:30:00Z" });
    assert.deepEqual(effectiveDate(stated, TZ), { date: "2026-10-30", source: "stated" });
    const timeOnly = order({ requested_for: "morning", first_message_at: "2026-10-28T12:30:00Z" });
    assert.deepEqual(effectiveDate(timeOnly, TZ), { date: "2026-10-28", source: "default" }, "'morning' names no day: the default applies, the time stays on the order");
    const vague = order({ requested_for: "sometime next week" });
    assert.deepEqual(effectiveDate(vague, TZ), { date: null, source: "unreadable" }, "words nobody can read are not replaced by a guess");
  });
  test("time-only wording is recognised, day words are not", () => {
    for (const t of ["morning", "around 3pm please", "before noon", "ASAP", "at 10:30 am", "afternoon if possible"]) assert.equal(isTimeOnlyPhrase(t), true, t);
    for (const t of ["Friday morning", "30 Oct", "next week", "tomorrow", "Marigot Bay"]) assert.equal(isTimeOnlyPhrase(t), false, t);
  });
  test("a default day is never a 'missing' gap, an unreadable one is", () => {
    assert.deepEqual(orderGaps(order({ requested_for: null }), TZ), []);
    assert.deepEqual(orderGaps(order({ requested_for: "morning" }), TZ), []);
    assert.deepEqual(orderGaps(order({ requested_for: "sometime next week" }), TZ), ["requested_for"]);
  });
});

describe("delivery is the default; collection only when the customer says so", () => {
  test("no stated method is a delivery, marked as a default, and never missing", () => {
    assert.deepEqual(effectiveMethod({ fulfilment_method: null }), { method: "delivery", defaulted: true });
    assert.deepEqual(effectiveMethod({ fulfilment_method: "delivery" }), { method: "delivery", defaulted: false });
    assert.deepEqual(effectiveMethod({ fulfilment_method: "collection" }), { method: "collection", defaulted: false });
    const items = [{ product: "Monello", quantity: "1", variant: null, size: null }];
    assert.ok(!computeMissing({ items, fulfilment_method: null, delivery_address: "Cap Estate", requested_for: null }).includes("fulfilment_method"));
    assert.deepEqual(orderGaps(order({ fulfilment_method: null, delivery_address: "Cap Estate" }), TZ), []);
  });
  test("a default delivery still needs an address; an explicit collection does not", () => {
    assert.deepEqual(orderGaps(order({ fulfilment_method: null, delivery_address: null }), TZ), ["delivery_address"]);
    assert.deepEqual(orderGaps(order({ fulfilment_method: "collection", delivery_address: null }), TZ), []);
  });
  test("pickup is preserved in the report and listed as collection", () => {
    const o = order({ fulfilment_method: "collection", delivery_address: null, requested_for: "Thu 29 Oct (tomorrow)", customer_name: "Marcus", first_message_at: "2026-10-28T13:00:00Z" });
    const d = order({ customer_name: "Dee", requested_for: "Thu 29 Oct (tomorrow)", first_message_at: "2026-10-28T13:00:00Z" });
    const text = buildOrdersView({ view: { type: "tomorrow" }, orders: [o, d], now: new Date("2026-10-28T14:00:00Z"), timezone: TZ }).parts.join("\n");
    assert.match(text, /🚚 \*Delivery\*[\s\S]*Dee[\s\S]*🛍 \*Collection\*[\s\S]*Marcus[\s\S]*🛍 collection/);
    assert.doesNotMatch(text, /delivery or collection/i, "no 'delivery or collection' prompt anywhere");
  });
  test("the customer-facing questions never offer or advertise pick-up and never ask for delivery vs collection", () => {
    assert.deepEqual(missingOrderFields(null), ["items", "quantity", "delivery_address"]);
    assert.deepEqual(missingOrderFields({ items: [{ product: "Monello", quantity: "2" }], delivery_address: "Cap Estate", delivery_preference: null, notes: null }), []);
    for (const fields of [["items", "quantity", "delivery_address"], ["delivery_address"], ["delivery_preference"]] as const) {
      assert.doesNotMatch(askForMissingFields([...fields]), /collect|pick[- ]?up|or to collect/i);
    }
  });
  test("a customer who asks to collect is not asked for an address", () => {
    assert.deepEqual(missingOrderFields({ items: [{ product: "Monello", quantity: "2" }], delivery_address: null, delivery_preference: "I'll collect", notes: null }), []);
  });
});

describe("customer identity and phone numbers", () => {
  test("placeholders, numbers and JIDs are never a name", () => {
    for (const bad of ["Unknown Contact", "customer", "+1 758 555 0101", "17585550101@s.whatsapp.net", "N/A", "👍", ""]) assert.equal(isReliableName(bad), false, bad);
    for (const good of ["Marcus", "Jane Doe", "Dr. Alleyne"]) assert.equal(isReliableName(good), true, good);
  });
  test("a stated name must be in the customer's own words", () => {
    assert.equal(nameStated("Marcus", ["Hi it's Marcus, 2 bags please"]), true);
    assert.equal(nameStated("Marcus Joseph", ["this is marcus"]), false);
    assert.equal(nameStated("Anna", ["2 bags of Monello"]), false);
  });
  test("phone numbers are told apart from quantities, prices and dates", () => {
    assert.deepEqual(phonesIn("call me on 758 123 4567 please"), ["7581234567"]);
    assert.deepEqual(phonesIn("+1 (758) 555-0101"), ["17585550101"]);
    assert.deepEqual(phonesIn("2 bags at 12.50 each on 30/10/2026"), []);
    assert.deepEqual(phonesIn("deliver 2026-10-30"), []);
  });
  test("a note that is only a phone number is a contact, a note with real instructions is not", () => {
    assert.equal(isPhoneOnlyNote("758 123 4567"), true);
    assert.equal(isPhoneOnlyNote("call 758-123-4567 on arrival"), true);
    assert.equal(isPhoneOnlyNote("gate code 4412, leave with the guard"), false);
    assert.equal(isPhoneOnlyNote("call 758 123 4567 and leave it with the guard at the blue gate"), false);
  });
  test("an alternate delivery contact is grounded in the customer's words and is never the sender's own number", () => {
    const said = ["Please call my driver on 758 123 4567 when you arrive"];
    assert.equal(groundedContactPhone({ contact_phone: "+17581234567" }, said, "17585550101"), "7581234567");
    assert.equal(groundedContactPhone({ contact_phone: "758 999 0000" }, said, "17585550101"), null, "the model made it up");
    assert.equal(groundedContactPhone({ contact_phone: "758 555 0101" }, ["call me on 758 555 0101"], "17585550101"), null, "that is the sender's own number");
    assert.equal(groundedContactPhone({ notes: "758 123 4567" }, said, "17585550101"), "7581234567", "a bare-number note becomes the contact");
  });
  test("the delivery contact lives in the notes, replaces an older contact, and keeps the rest of the note", () => {
    const first = withDeliveryContact("gate code 4412", "7581234567");
    assert.equal(first, "gate code 4412 · Delivery contact: 758-123-4567");
    assert.equal(deliveryContactIn(first), "7581234567");
    const second = withDeliveryContact(first, "7589990000");
    assert.equal(second, "gate code 4412 · Delivery contact: 758-999-0000");
    assert.equal(withDeliveryContact(second, "7589990000"), second, "idempotent");
  });
});

describe("automatic delivery location (pure)", () => {
  const past = (id: string, address: string | null, over: Partial<HistoryOrder> = {}): HistoryOrder => ({
    id, ref_code: `O-${id}`, status: "fulfilled", items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: null }],
    fulfilment_method: "delivery", delivery_address: address, manual_locked_fields: [], last_message_at: "2026-10-20T14:00:00Z", ...over,
  });
  const none: HistoryCue = detectHistoryCue([]);
  const fill = (history: HistoryOrder[], over: Partial<FillContext> = {}) =>
    resolveFromHistory(history, none, ["a bag of Monello"], { current: null, draftItems: [], draftAddress: null, implicitLocation: true, ...over });

  test("priority: the stated location, then the saved default, then one unambiguous verified address, else nothing", () => {
    const h = [past("1", "Cap Estate")];
    assert.equal(fill(h, { draftAddress: "Rodney Bay" }).address, null, "the customer's own location is never replaced");
    assert.deepEqual([fill(h, { defaultLocation: "Marigot Bay" }).address, fill(h, { defaultLocation: "Marigot Bay" }).sources.delivery_address], ["Marigot Bay", "saved location"]);
    assert.deepEqual([fill(h).address, fill(h).sources.delivery_address], ["Cap Estate", "O-1"]);
    assert.equal(fill([]).address, null);
  });
  test("two different verified places are ambiguous; an unconfirmed enquiry, a cancelled or a collection order is not a source", () => {
    assert.equal(fill([past("1", "Cap Estate"), past("2", "Rodney Bay", { last_message_at: "2026-10-22T14:00:00Z" })]).address, null);
    assert.equal(fill([past("1", "Cap Estate"), past("2", "Cap  estate")]).address?.toLowerCase().replace(/\s+/g, " "), "cap estate");
    assert.equal(fill([past("1", "Gros Islet", { status: "possible" })]).address, null);
    assert.equal(fill([past("1", "Gros Islet", { status: "cancelled" })]).address, null);
    assert.equal(fill([past("1", "Vigie", { fulfilment_method: "collection" })]).address, null);
    assert.equal(fill([past("1", "Hand typed", { status: "possible", manual_locked_fields: ["delivery_address"] })]).address, "Hand typed", "an address staff typed is verified");
  });
  test("nothing is filled for a collecting customer, for 'somewhere else', or when the order already has an address", () => {
    const h = [past("1", "Cap Estate")];
    assert.equal(fill(h, { collecting: true }).address, null);
    assert.equal(resolveFromHistory(h, detectHistoryCue(["somewhere else please"]), ["somewhere else please"], { current: null, draftItems: [], draftAddress: null, implicitLocation: true }).address, null);
    assert.equal(fill(h, { current: { id: "9", items: [], delivery_address: "Pigeon Island", fulfilment_method: null } }).address, null);
    assert.equal(fill(h, { implicitLocation: false }).address, null, "off unless asked for");
  });
});

describe("persisted creation defaults (pure)", () => {
  const blank = (over: Partial<OrderFields> = {}): OrderFields => ({ ...emptyFields(), ...over });
  test("delivery and a day are chosen from the request time; the stored day says it is a default", () => {
    const early = withCreationDefaults(blank(), "2026-10-28T11:30:00Z", TZ); // 07:30 local
    assert.deepEqual([early.fields.fulfilment_method, early.fields.requested_for, early.defaulted], ["delivery", "Wed 28 Oct (default)", ["fulfilment_method", "requested_for"]]);
    assert.equal(withCreationDefaults(blank(), "2026-10-28T13:00:00Z", TZ).fields.requested_for, "Thu 29 Oct (default)");
    assert.equal(withCreationDefaults(blank({ requested_for: "morning" }), "2026-10-28T13:00:00Z", TZ).fields.requested_for, "Thu 29 Oct (default, morning)");
  });
  test("explicit values, unreadable words and an existing default are left exactly as they are", () => {
    const explicit = withCreationDefaults(blank({ fulfilment_method: "collection", requested_for: "Fri 30 Oct (Friday)" }), "2026-10-28T13:00:00Z", TZ);
    assert.deepEqual([explicit.fields.fulfilment_method, explicit.fields.requested_for, explicit.defaulted], ["collection", "Fri 30 Oct (Friday)", []]);
    assert.equal(withCreationDefaults(blank({ requested_for: "next week" }), "2026-10-28T13:00:00Z", TZ).fields.requested_for, "next week");
    const again = withCreationDefaults(blank({ requested_for: "Thu 29 Oct (default)" }), "2026-11-05T13:00:00Z", TZ);
    assert.equal(again.fields.requested_for, "Thu 29 Oct (default)", "a later run never recalculates");
  });
  test("a stored default reads back as the same day, marked default, wherever and whenever it is read", () => {
    assert.deepEqual(effectiveDate({ requested_for: "Thu 29 Oct (default, morning)", first_message_at: "2026-10-28T13:00:00Z" }, TZ), { date: "2026-10-29", source: "default" });
    assert.equal(keepDefaultedDay("Thu 29 Oct (default)", "morning"), "Thu 29 Oct (default, morning)");
    assert.equal(keepDefaultedDay("Thu 29 Oct (default)", "Saturday"), "Saturday");
    assert.equal(keepDefaultedDay("Fri 30 Oct (Friday)", "morning"), "morning");
  });
});

describe("conversation context", () => {
  test("a wide window feeds grounding, a narrower one feeds the model, and stale chat is left out", () => {
    const at = "2026-10-28T15:00:00Z";
    const msgs = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.parse(at) - (30 - i) * 60_000).toISOString(), i }));
    const old = { at: "2026-10-20T15:00:00Z", i: -1 };
    const w = orderContextWindow([old, ...msgs], at);
    assert.equal(w.forModel.length, ORDER_CONTEXT_MESSAGES);
    assert.equal(w.forGrounding.length, 30, "the 8-day-old message is not part of this order");
    assert.ok(!w.forGrounding.includes(old));
    assert.equal(w.forModel.at(-1)?.i, 29, "newest last");
  });
  test("'same place' is recognised in the ways customers say it, and 'somewhere else' cancels it", () => {
    for (const t of ["same place please", "same address", "deliver to the same location", "delivery is the same", "address is the same as always", "same as last time for the delivery", "my usual location"]) {
      assert.equal(detectHistoryCue([t]).sameLocation, true, t);
    }
    for (const t of ["same day delivery please", "the same bag as before", "deliver somewhere else", "2 bags"]) assert.equal(detectHistoryCue([t]).sameLocation, false, t);
  });
});

// ── Repair planner ───────────────────────────────────────────────────────────

const msg = (id: string, who: "Customer" | "Staff", text: string, at: string): RepairMessage => ({ id, who, text, at });
const ctx = (over: Partial<RepairContext> = {}): RepairContext => ({
  messages: [], senderPhone: "17585550101", profileName: null, savedLocation: null, verifiedAddress: null, timezone: TZ, ...over,
});

describe("repairing existing open orders (planner)", () => {
  test("a stated pickup that was missed becomes collection, with the customer's words as evidence", () => {
    const o = order({ source_message_ids: ["m1"], delivery_address: null });
    const plan = planRepair(o, ctx({ messages: [msg("m1", "Customer", "2 bags of Monello, I'll collect tomorrow", "2026-10-26T14:00:00Z")] }))!;
    const c = plan.changes.find((x) => x.field === "fulfilment_method")!;
    assert.deepEqual([c.before, c.after], [null, "collection"]);
    assert.match(c.evidence ?? "", /collect tomorrow/);
    assert.ok(plan.changes.some((x) => x.field === "requested_for" && x.after === "Tue 27 Oct"), "and the written day is filled from the message time");
    assert.deepEqual(plan.changes.find((x) => x.field === "status"), { field: "status", before: "possible", after: "awaiting_confirmation", reason: plan.changes.at(-1)!.reason, evidence: null });
  });
  test("with no pickup in the conversation the method is left alone (delivery is the default, nothing to repair)", () => {
    const plan = planRepair(order(), ctx({ messages: [msg("m1", "Customer", "2 bags of Monello to Cap Estate", "2026-10-26T14:00:00Z")], }))!;
    assert.deepEqual(plan.changes.map((c) => c.field), ["status"], "only the status follows: delivery and the day are no longer required");
  });
  test("a possible order that was only 'incomplete' because of the old defaults becomes awaiting confirmation", () => {
    const plan = planRepair(order({ status: "possible", missing_fields: ["fulfilment_method", "requested_for"] }), ctx())!;
    assert.deepEqual(plan.changes.map((c) => [c.field, c.before, c.after]), [["status", "possible", "awaiting_confirmation"]]);
  });
  test("an order that really lacks an address stays possible and the planner says to ask", () => {
    const plan = planRepair(order({ delivery_address: null }), ctx())!;
    assert.deepEqual(plan.changes, []);
    assert.ok(plan.review.some((r) => /address: none given/.test(r)));
  });
  test("a written date is used; a different readable date on the order is shown for a person, never swapped", () => {
    const m = [msg("m1", "Customer", "deliver on 30 Oct please", "2026-10-26T14:00:00Z")];
    const fills = planRepair(order({ source_message_ids: ["m1"] }), ctx({ messages: m }))!;
    assert.deepEqual(fills.changes.find((c) => c.field === "requested_for")?.after, "Fri 30 Oct");
    const differs = planRepair(order({ source_message_ids: ["m1"], requested_for: "Tue 27 Oct (tomorrow)" }), ctx({ messages: m }))!;
    assert.ok(!differs.changes.some((c) => c.field === "requested_for"));
    assert.ok(differs.review.some((r) => /day:/.test(r)));
  });
  test("a bare phone number in the notes becomes the delivery contact only when the customer wrote it", () => {
    const m = [msg("m1", "Customer", "call 758 123 4567 when you arrive", "2026-10-26T14:00:00Z")];
    const o = order({ source_message_ids: ["m1"], notes: "758 123 4567" });
    const plan = planRepair(o, ctx({ messages: m }))!;
    assert.deepEqual(plan.changes.find((c) => c.field === "notes")?.after, "Delivery contact: 758-123-4567");
    const unseen = planRepair(o, ctx({ messages: [] }))!;
    assert.ok(!unseen.changes.some((c) => c.field === "notes"), "no evidence in the conversation: not touched");
    assert.ok(unseen.review.some((r) => /only a phone number/.test(r)));
    const own = planRepair(order({ notes: "758 555 0101" }), ctx())!;
    assert.deepEqual(own.changes.find((c) => c.field === "notes")?.after, null, "the customer's own number is not a note");
    assert.equal(own.changes.some((c) => c.field === "notes" && c.after && /0101/.test(String(c.after))), false);
  });
  test("a placeholder name is replaced by a reliable profile name, else cleared; never invented", () => {
    const o = order({ customer_name: "Unknown Contact" });
    assert.equal(planRepair(o, ctx({ profileName: "Jane Doe" }))!.changes.find((c) => c.field === "customer_name")?.after, "Jane Doe");
    assert.equal(planRepair(o, ctx())!.changes.find((c) => c.field === "customer_name")?.after, null);
  });
  test("'same place' resolves to a staff-saved location first, then a verified order, and otherwise asks", () => {
    const m = [msg("m1", "Customer", "1 bag of Monello, same place please", "2026-10-26T14:00:00Z")];
    const o = order({ source_message_ids: ["m1"], delivery_address: null });
    const saved = planRepair(o, ctx({ messages: m, savedLocation: "Marigot Bay", verifiedAddress: { ref: "O-OLD11", address: "Cap Estate" } }))!;
    assert.equal(saved.changes.find((c) => c.field === "delivery_address")?.after, "Marigot Bay");
    const verified = planRepair(o, ctx({ messages: m, verifiedAddress: { ref: "O-OLD11", address: "Cap Estate" } }))!;
    assert.equal(verified.changes.find((c) => c.field === "delivery_address")?.after, "Cap Estate");
    assert.match(verified.changes.find((c) => c.field === "delivery_address")!.reason, /verified order #OLD11/);
    const none = planRepair(o, ctx({ messages: m }))!;
    assert.ok(!none.changes.some((c) => c.field === "delivery_address"));
    assert.ok(none.review.some((r) => /no verified location/.test(r)));
    const quiet = planRepair(o, ctx({ messages: [msg("m1", "Customer", "1 bag of Monello", "2026-10-26T14:00:00Z")], savedLocation: "Marigot Bay" }))!;
    assert.ok(!quiet.changes.some((c) => c.field === "delivery_address"), "a saved location is never applied unless the customer pointed at it");
  });
  test("staff-edited fields are skipped, a confirmed order is only repaired cosmetically, closed orders are not planned", () => {
    const m = [msg("m1", "Customer", "I'll collect tomorrow", "2026-10-26T14:00:00Z")];
    const lockedPlan = planRepair(order({ source_message_ids: ["m1"], manual_locked_fields: ["fulfilment_method", "requested_for"] }), ctx({ messages: m }))!;
    assert.ok(!lockedPlan.changes.some((c) => c.field === "fulfilment_method" || c.field === "requested_for"));
    assert.deepEqual(lockedPlan.skipped.map((s) => s.field).sort(), ["fulfilment_method", "requested_for"]);
    const confirmed = planRepair(order({ status: "confirmed", source_message_ids: ["m1"], customer_name: "Unknown Contact" }), ctx({ messages: m, profileName: "Jane" }))!;
    assert.deepEqual(confirmed.changes.map((c) => c.field), ["customer_name"]);
    assert.ok(confirmed.review.some((r) => /confirmed/.test(r)), "the pickup is surfaced for a person, not applied");
    for (const status of ["fulfilled", "cancelled"] as const) assert.equal(planRepair(order({ status }), ctx({ messages: m })), null, status);
  });
  test("it is idempotent: the same input gives the same fingerprint, and a repaired order plans nothing", () => {
    const m = [msg("m1", "Customer", "I'll collect on 30 Oct", "2026-10-26T14:00:00Z")];
    const o = order({ source_message_ids: ["m1"], delivery_address: null });
    const a = planRepair(o, ctx({ messages: m }))!;
    assert.equal(a.fingerprint, planRepair(o, ctx({ messages: m }))!.fingerprint);
    const repaired = order({ ...o, fulfilment_method: "collection", requested_for: "Fri 30 Oct", status: "awaiting_confirmation", version: o.version + 1 });
    assert.deepEqual(planRepair(repaired, ctx({ messages: m }))!.changes, []);
    assert.notEqual(planRepair({ ...o, version: o.version + 1 }, ctx({ messages: m }))!.fingerprint, a.fingerprint, "a changed version never matches an old preview");
  });
  test("only the order's own conversation counts: another customer's or a later order's messages are ignored", () => {
    const o = order({ source_message_ids: ["m1"], first_message_at: "2026-10-26T14:00:00Z", last_message_at: "2026-10-26T14:10:00Z", delivery_address: null });
    const m = [
      msg("m1", "Customer", "2 bags of Monello to Cap", "2026-10-26T14:00:00Z"),
      msg("late", "Customer", "I'll collect the next one", "2026-10-28T09:00:00Z"),
      msg("staff", "Staff", "we can deliver tomorrow, or you collect", "2026-10-26T14:05:00Z"),
    ];
    assert.ok(!planRepair(o, ctx({ messages: m }))!.changes.some((c) => c.field === "fulfilment_method"));
  });
});

describe("where an address came from (pure, from the order's own history)", () => {
  const ev = (kind: string, actor: string, changes: AddressEvent["changes"], min: number): AddressEvent => ({ kind, actor_kind: actor, changes, created_at: `2026-10-28T12:${String(10 + min).padStart(2, "0")}:00Z` });
  const filledFromSaved = (addr: string, min = 0) => ev("created", "ai", { delivery_address: { before: null, after: addr }, inferred: { before: null, after: { delivery_address: "saved location" } } }, min);
  const filledFromOrder = (addr: string, ref: string, min = 0) => ev("created", "ai", { delivery_address: { before: null, after: addr }, inferred: { before: null, after: { delivery_address: ref } } }, min);
  const o = (address: string, locked: string[] = []) => order({ delivery_address: address, manual_locked_fields: locked });

  test("explicit, saved and previous addresses are told apart; the WhatsApp labels stay short", () => {
    const stated = addressProvenance(o("Cap Estate"), [ev("created", "ai", { delivery_address: { before: null, after: "Cap Estate" } }, 0)]);
    assert.deepEqual(stated, { origin: "customer" });
    assert.equal(addressTag(stated), "");
    const saved = addressProvenance(o("Marigot Bay"), [filledFromSaved("Marigot Bay")]);
    assert.equal(saved.origin, "saved");
    assert.equal(addressTag(saved), " (Saved address)");
    const previous = addressProvenance(o("Gros Islet"), [filledFromOrder("Gros Islet", "O-K3PD7")]);
    assert.deepEqual(previous, { origin: "previous", fromRef: "O-K3PD7" });
    assert.equal(addressTag(previous), " (Previous address)");
    assert.equal(addressSourceLine(previous), "Address: Previous address (from #K3PD7) — not stated in this chat");
    assert.equal(addressSourceLine(saved), "Address: Saved address — not stated in this chat");
    assert.equal(addressSourceLine(stated), "Address: given by the customer");
  });
  test("no evidence is never read as inferred: old orders, no history, and no address all stay plain", () => {
    assert.equal(addressProvenance(o("Cap Estate"), []).origin, "customer");
    assert.equal(addressProvenance(order({ delivery_address: null }), [filledFromSaved("Marigot Bay")]).origin, null);
    assert.equal(addressProvenance(o("Cap Estate", ["delivery_address"]), []).origin, "staff");
  });
  test("overridden: a customer or staff change after the fill makes it an ordinary address, however the events are ordered", () => {
    const customerChange = ev("ai_update", "ai", { delivery_address: { before: "Marigot Bay", after: "Rodney Bay" } }, 5);
    for (const events of [[filledFromSaved("Marigot Bay"), customerChange], [customerChange, filledFromSaved("Marigot Bay")]]) {
      assert.equal(addressProvenance(o("Rodney Bay"), events).origin, "customer");
    }
    const staffEdit = ev("manual_edit", "admin", { delivery_address: { before: "Marigot Bay", after: "Pigeon Island" } }, 5);
    assert.equal(addressProvenance(o("Pigeon Island", ["delivery_address"]), [filledFromSaved("Marigot Bay"), staffEdit]).origin, "staff");
    // Cleared ("somewhere else") and then given again by the customer.
    const cleared = ev("ai_update", "ai", { delivery_address: { before: "Marigot Bay", after: null } }, 5);
    const given = ev("ai_update", "ai", { delivery_address: { before: null, after: "Vigie" } }, 6);
    assert.equal(addressProvenance(o("Vigie"), [filledFromSaved("Marigot Bay"), cleared, given]).origin, "customer");
  });
  test("confirmed: the customer replying yes, writing the same address, or staff confirming it ends 'inferred'", () => {
    for (const confirm of [
      ev("customer_replied_yes", "customer", { status: { before: "awaiting_confirmation", after: "awaiting_confirmation" } }, 5),
      ev("address_confirmed", "customer", { delivery_address: { before: "Marigot Bay", after: "Marigot Bay" } }, 5),
      ev("manual_confirm", "admin", { status: { before: "awaiting_confirmation", after: "confirmed" } }, 5),
      ev("staff_whatsapp_confirm", "staff", { status: { before: "awaiting_confirmation", after: "confirmed" } }, 5),
    ]) {
      assert.equal(addressProvenance(o("Marigot Bay"), [filledFromSaved("Marigot Bay"), confirm]).origin, "customer", confirm.kind);
    }
  });
  test("an unrelated later update (a quantity, a note) leaves a filled address inferred", () => {
    const later = ev("ai_update", "ai", { items: { before: [], after: [] } }, 5);
    assert.equal(addressProvenance(o("Marigot Bay"), [filledFromSaved("Marigot Bay"), later]).origin, "saved");
  });
  test("an address that is no longer the one that was filled is never labelled inferred (history cut short, direct edit)", () => {
    assert.equal(addressProvenance(o("Somewhere New"), [filledFromSaved("Marigot Bay")]).origin, "customer");
    assert.equal(addressProvenance(o("MARIGOT  bay"), [filledFromSaved("Marigot Bay")]).origin, "saved", "spelling and spacing do not matter");
  });
  test("!order #REF says where the address came from, and no longer lists a changed address as 'from earlier orders'", () => {
    const text = (address: string, events: AddressEvent[]) =>
      moreInfoReply({ order: o(address), name: undefined, events: events.map((e) => ({ ...e, changes: e.changes ?? {} })), timezone: TZ });
    assert.match(text("Marigot Bay", [filledFromSaved("Marigot Bay")]), /Address: Saved address — not stated in this chat/);
    assert.match(text("Gros Islet", [filledFromOrder("Gros Islet", "O-K3PD7")]), /Address: Previous address \(from #K3PD7\)/);
    const changed = text("Rodney Bay", [filledFromSaved("Marigot Bay"), ev("ai_update", "ai", { delivery_address: { before: "Marigot Bay", after: "Rodney Bay" } }, 5)]);
    assert.match(changed, /Address: given by the customer/);
    assert.doesNotMatch(changed, /Saved address|Previous address|address from/);
    assert.match(text("Pigeon Island", []).replace("Edited by staff", ""), /given by the customer/);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

const GROUP = "120363000000000001@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let repair: typeof import("../lib/server/aiAgent/orderRepair.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE", intent: "other", reply: null, confidence: 0.2, knowledge_ids: [], escalation_reason: "needs staff",
  priority: null, summary: null, order_request: null, memory_facts: [], ...over,
});
let script: () => Proposal = () => proposal();
const draft = (over: Partial<Draft> = {}): Draft => ({
  items: [{ product: "Monello Chicken", quantity: "1", size: "25kg" }], delivery_address: null, delivery_preference: null, notes: null, requested_for: null, ...over,
});
const modelOrders = (d: Draft | null) => {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order" });
};

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}) {
  const settings = {
    enabled: true, mode: "approval_pilot", contact_scope: "all", staff_group_jid: GROUP, staff_notices_enabled: true,
    customer_memory_enabled: false, batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"], orders_tracking_enabled: true, orders_summary_enabled: true, orders_group_jid: null,
    orders_timezone: "America/St_Lucia", orders_summary_hour: 8, orders_customer_confirms: false, orders_tracking_since: null, ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = 'dog_food';`);
}

/** Wednesday 28 Oct 2026, 08:30 in Saint Lucia. */
const MORNING = "2026-10-28T12:30:00.000Z";
const AFTER_NINE = "2026-10-28T13:15:00.000Z";

async function say(c: Customer, text: string, opts: { id?: string; at?: string; store?: boolean } = {}) {
  const at = opts.at ?? MORNING;
  const id = opts.id ?? `CUST-${++seq}`;
  // The bridge stores every message before it reaches the agent; the conversation context is read from there.
  if (opts.store !== false) {
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
      values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, 'inbound', ${lit(text)}, ${lit(id)}, ${lit(at)});`);
  }
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: id, chatId: c.chat, contactNumber: c.phone, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: at,
  });
}
async function groupSays(text: string) {
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: `GRP-${++seq}`, chatId: GROUP, contactNumber: null, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: STAFF, senderPhone: null, timestamp: new Date().toISOString(),
  });
}
const allOrders = () => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = 'dog_food' order by created_at, id`);
const events = (orderId: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_events where order_id = ${lit(orderId)} order by created_at, id`);
const asTracked = (o: Record<string, any>) => o as unknown as TrackedOrder;

describe("Order business rules (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, contact_name text, business_contact_name text,
        direction text, message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );
      create table if not exists public.customers (
        phone_number text primary key, first_name text, last_name text, whatsapp_name text, business_contact_name text
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    repair = await import("../lib/server/aiAgent/orderRepair.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async () => ({ proposal: script(), model: "scripted", error: null }));
    model.setOrderUpdateProposerForTests(async () => {
      const p = script();
      return { proposal: { intent: p.intent, order_request: p.order_request, order_target: p.order_target, other_orders: p.other_orders, staff_action: null }, model: "scripted", error: null };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    model?.setOrderUpdateProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });
  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts,
        public.ai_agent_shadow_results, public.ai_agent_customer_staff_memory, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure();
    script = () => proposal();
  });

  test("a plain order is stored as a delivery by default: recorded as a default, nothing flagged missing, complete once it has an address", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], delivery_address: "Cap Estate" }));
    await say(JANE, "2 bags of Monello Chicken 25kg to Cap Estate please");
    const [o] = await allOrders();
    assert.equal(o.fulfilment_method, "delivery", "the default method is persisted when the order is created");
    const [created] = await events(o.id);
    assert.deepEqual(created.changes.defaulted.after.fields, ["fulfilment_method", "requested_for"], "the order's history says which values the business rules chose");
    assert.equal(o.status, "awaiting_confirmation", "delivery and the day are not required");
    assert.deepEqual(o.missing_fields.filter((m: string) => m !== "requested_for"), []);
    assert.deepEqual(orderGaps(asTracked(o), TZ), []);
    assert.equal(await customerBound(), 0, "no customer reply, promise or confirmation");
  });

  test("the day defaults to today before 9:00 and to tomorrow from 9:00, from the customer's message time", async () => {
    modelOrders(draft({ delivery_address: "Cap Estate" }));
    await say(JANE, "a bag of Monello to Cap Estate", { at: MORNING });
    await say(MARCUS, "a bag of Monello to Rodney Bay", { at: AFTER_NINE });
    const [a, b] = await allOrders();
    assert.equal(orderDate(asTracked(a), TZ), "2026-10-28");
    assert.equal(orderDate(asTracked(b), TZ), "2026-10-29");
    assert.equal(a.requested_for, "Wed 28 Oct (default)", "stored from the customer's message time, marked as a default");
    assert.equal(b.requested_for, "Thu 29 Oct (default)");
    // Looked at days later the dates have not moved: the stored value, not the clock, decides.
    assert.equal(orderDate(asTracked(a), TZ), "2026-10-28");
    assert.equal(effectiveDate({ requested_for: a.requested_for, first_message_at: a.first_message_at }, TZ).source, "default");
    const report = (await groupSays("!orders all")).outbox.map((x) => x.body).join("\n");
    assert.match(report, /Wed 28 Oct/);
    assert.doesNotMatch(report, /default day/, "provenance stays in the stored value, not in the WhatsApp line");
    assert.doesNotMatch(report, /Missing: [^\n]*(day|delivery or collection)/);
  });

  test("an explicit date beats the default, and an explicit pickup is kept (no address needed)", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], delivery_preference: "collection", requested_for: "Friday 30 Oct" }));
    await say(JANE, "2 bags of Monello Chicken 25kg, I'll collect on Friday 30 Oct", { at: AFTER_NINE });
    const [o] = await allOrders();
    assert.equal(o.fulfilment_method, "collection");
    assert.equal(o.status, "awaiting_confirmation");
    assert.equal(orderDate(asTracked(o), TZ), "2026-10-30");
    assert.deepEqual(orderGaps(asTracked(o), TZ), []);
  });

  test("an order built over several messages is one order, and the latest correction wins", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }] }));
    await say(JANE, "2 bags of Monello Chicken 25kg", { at: MORNING });
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], delivery_address: "Rodney Bay marina" }));
    await say(JANE, "deliver to Rodney Bay marina", { at: "2026-10-28T12:32:00Z" });
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }], delivery_address: "Rodney Bay marina" }));
    await say(JANE, "actually make it 3 bags", { at: "2026-10-28T12:34:00Z" });
    const all = await allOrders();
    assert.equal(all.length, 1, "no duplicate order");
    assert.deepEqual(all[0].items.map((i: any) => [i.product, i.quantity]), [["Monello Chicken", "3"]]);
    assert.equal(all[0].delivery_address, "Rodney Bay marina");
    assert.equal(all[0].status, "awaiting_confirmation");
    assert.equal(await customerBound(), 0);
  });

  test("an address given many messages earlier still grounds the order (the window is wider than eight lines)", async () => {
    await say(JANE, "my address is Pigeon Island Road, Gros Islet", { at: "2026-10-28T12:00:00Z" });
    for (let i = 0; i < 11; i += 1) await say(JANE, `chat message ${i}`, { at: new Date(Date.parse("2026-10-28T12:01:00Z") + i * 60_000).toISOString() });
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], delivery_address: "Pigeon Island Road, Gros Islet" }));
    await say(JANE, "2 bags of Monello Chicken 25kg please", { at: "2026-10-28T12:20:00Z" });
    const [o] = await allOrders();
    assert.equal(o.delivery_address, "Pigeon Island Road, Gros Islet");
  });

  test("a customer who gives their name is named; a verified profile name is never overwritten; a guessed name is dropped", async () => {
    modelOrders({ ...draft({ delivery_address: "Cap Estate" }), customer_name: "Marcus" });
    await say(MARCUS, "hi it's Marcus, a bag of Monello to Cap Estate");
    modelOrders({ ...draft({ delivery_address: "Cap Estate" }), customer_name: "Janet" });
    await pg.run(`insert into public.customers (phone_number, first_name, last_name) values (${lit(JANE.phone)}, 'Jane', 'Staffname');`);
    await say(JANE, "this is Janet, a bag of Monello to Cap Estate");
    modelOrders({ ...draft({ delivery_address: "Cap Estate" }), customer_name: "Priya" });
    const PRIYA = { chat: "17585550103@s.whatsapp.net", phone: "17585550103" };
    await say(PRIYA, "a bag of Monello to Cap Estate");
    const byChat = Object.fromEntries((await allOrders()).map((o) => [o.chat_id, o]));
    assert.equal(byChat[MARCUS.chat].customer_name, "Marcus");
    assert.equal(byChat[JANE.chat].customer_name, "Jane Staffname", "the verified profile wins over a name typed in a message");
    assert.equal(byChat[PRIYA.chat].customer_name, null, "a name the customer never wrote is not stored; the verified phone is the fallback");
    assert.equal(byChat[PRIYA.chat].contact_number, PRIYA.phone);
  });

  test("a phone number inside the message is an alternate delivery contact: the customer's own number is untouched", async () => {
    modelOrders({ ...draft({ delivery_address: "Cap Estate", notes: "758 123 4567" }), contact_phone: "758 123 4567" });
    await say(JANE, "a bag of Monello to Cap Estate, call my driver on 758 123 4567");
    let [o] = await allOrders();
    assert.equal(o.contact_number, JANE.phone, "the verified sender stays the customer");
    assert.equal(o.notes, "Delivery contact: 758-123-4567");
    // A later turn that restates the order without repeating the number keeps it.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], delivery_address: "Cap Estate", notes: "leave with the guard" }));
    await say(JANE, "make it 2 bags and leave with the guard", { at: "2026-10-28T12:40:00Z" });
    [o] = await allOrders();
    assert.equal(o.notes, "leave with the guard · Delivery contact: 758-123-4567");
    assert.equal(o.contact_number, JANE.phone);
    assert.equal((await allOrders()).length, 1);
    const report = (await groupSays("!orders all")).outbox.map((x) => x.body).join("\n");
    assert.match(report, /\*1\. 555-0101 · /, "the verified sender number is still what identifies the customer");
    assert.match(report, /Delivery contact: 758-123-4567/);
  });

  test("a number the model invented is not stored, and the customer's own number is never an 'alternate'", async () => {
    modelOrders({ ...draft({ delivery_address: "Cap Estate" }), contact_phone: "758 999 0000" });
    await say(JANE, "a bag of Monello to Cap Estate");
    modelOrders({ ...draft({ delivery_address: "Cap Estate", notes: "758 555 0101" }), contact_phone: "17585550101" });
    await say(MARCUS, "a bag of Monello to Cap Estate, my number is 758 555 0102");
    const all = await allOrders();
    assert.ok(all.every((o) => !/Delivery contact/.test(o.notes ?? "")), JSON.stringify(all.map((o) => o.notes)));
  });

  test("'same place' uses the staff-saved location and never changes saved customer memory", async () => {
    await pg.run(`insert into public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status, content, fingerprint) values ('dog_food', ${lit(JANE.phone)}, 'delivery_location', 'active', 'Marigot Bay', 'mb');`);
    const memoryBefore = await rows(`select * from public.ai_agent_customer_staff_memory`);
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }] }));
    await say(JANE, "2 bags of Monello Chicken 25kg, delivery address is the same");
    const [o] = await allOrders();
    assert.equal(o.delivery_address, "Marigot Bay");
    assert.deepEqual(await rows(`select * from public.ai_agent_customer_staff_memory`), memoryBefore, "saved memory is read, never written");
    // A customer who does not point at it does not get it silently.
    modelOrders(draft());
    await say(MARCUS, "a bag of Monello please");
    const marcus = (await allOrders()).find((x) => x.chat_id === MARCUS.chat)!;
    assert.equal(marcus.delivery_address, null);
    assert.ok(orderGaps(asTracked(marcus), TZ).includes("delivery_address"), "a genuinely unresolved location is flagged");
  });

  // ── Automatic location, persisted defaults ─────────────────────────────────

  const PAST_ITEMS = `'[{"product":"Monello Chicken","quantity":"2","variant":null,"size":"25kg"}]'::jsonb`;
  async function seedPast(ref: string, c: Customer, address: string | null, over: { status?: string; method?: string | null; locked?: string; at?: string } = {}) {
    await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, status, items, fulfilment_method, delivery_address, requested_for, missing_fields, source_message_ids, manual_locked_fields, first_message_at, last_message_at)
      values (${lit(ref)}, 'dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${lit(over.status ?? "fulfilled")}, ${PAST_ITEMS}, ${over.method === undefined ? "'delivery'" : over.method ? lit(over.method) : "null"},
        ${address ? lit(address) : "null"}, null, '{}', '{}', array[${(over.locked ?? "").split(",").filter(Boolean).map(lit).join(",")}]::text[],
        ${lit(over.at ?? "2026-10-20T14:00:00Z")}, ${lit(over.at ?? "2026-10-20T14:00:00Z")});`);
  }
  const orderOf = async (c: Customer) => (await allOrders()).find((x) => x.chat_id === c.chat && ["possible", "awaiting_confirmation", "confirmed"].includes(x.status))!;

  test("no location given: the staff-saved default is used without the customer pointing at it; their own location always wins", async () => {
    await pg.run(`insert into public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status, content, fingerprint) values ('dog_food', ${lit(JANE.phone)}, 'delivery_location', 'active', 'Marigot Bay', 'mb');`);
    const memoryBefore = await rows(`select * from public.ai_agent_customer_staff_memory`);
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    const jane = await orderOf(JANE);
    assert.equal(jane.delivery_address, "Marigot Bay");
    const filled = (await events(jane.id)).find((e) => e.changes.inferred);
    assert.equal(filled?.changes.inferred.after.delivery_address, "saved location", "the order's history says where the address came from");
    // The customer states a place: that, not the saved one.
    await pg.run(`insert into public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status, content, fingerprint) values ('dog_food', ${lit(MARCUS.phone)}, 'delivery_location', 'active', 'Marigot Bay', 'mb2');`);
    modelOrders(draft({ delivery_address: "Cap Estate" }));
    await say(MARCUS, "a bag of Monello Chicken 25kg to Cap Estate");
    assert.equal((await orderOf(MARCUS)).delivery_address, "Cap Estate");
    assert.equal((await rows(`select * from public.ai_agent_customer_staff_memory where customer_key = ${lit(JANE.phone)}`)).length, 1);
    assert.deepEqual((await rows(`select * from public.ai_agent_customer_staff_memory where customer_key = ${lit(JANE.phone)}`)), memoryBefore.filter((m: any) => m.customer_key === JANE.phone), "saved memory is read, never written");
    assert.equal(await customerBound(), 0);
  });

  test("no saved default: one unambiguous verified earlier address is used; two different ones, a collection order's, or a collecting customer are not", async () => {
    const DEV = { chat: "17585550104@s.whatsapp.net", phone: "17585550104" };
    const ANN = { chat: "17585550105@s.whatsapp.net", phone: "17585550105" };
    await seedPast("O-OLD1", JANE, "Cap Estate");
    await seedPast("O-OLD2", JANE, "cap  estate", { at: "2026-10-22T14:00:00Z" }); // the same place, written differently
    await seedPast("O-OLD3", MARCUS, "Cap Estate");
    await seedPast("O-OLD4", MARCUS, "Rodney Bay", { at: "2026-10-22T14:00:00Z" });
    await seedPast("O-OLD6", DEV, "Vigie", { method: "collection" });
    modelOrders(draft());
    for (const c of [JANE, MARCUS, DEV]) await say(c, "a bag of Monello Chicken 25kg please");
    assert.match((await orderOf(JANE)).delivery_address, /^cap\s+estate$/i);
    assert.equal((await orderOf(MARCUS)).delivery_address, null, "two different verified places: nobody guesses which");
    assert.equal((await orderOf(DEV)).delivery_address, null);
    assert.ok(orderGaps(asTracked(await orderOf(MARCUS)), TZ).includes("delivery_address"), "still flagged for a person");
    // Collecting, or asking for another place, never gets an address.
    await seedPast("O-OLD7", ANN, "Cap Estate");
    modelOrders(draft({ delivery_preference: "collection" }));
    await say(ANN, "a bag of Monello Chicken 25kg, I'll collect");
    assert.equal((await orderOf(ANN)).delivery_address, null);
  });

  test("a saved default beats an earlier order's address; a staff-locked address on the order is never overwritten", async () => {
    await seedPast("O-OLD1", JANE, "Cap Estate");
    await pg.run(`insert into public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status, content, fingerprint) values ('dog_food', ${lit(JANE.phone)}, 'delivery_location', 'active', 'Marigot Bay', 'mb');`);
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    const order = await orderOf(JANE);
    assert.equal(order.delivery_address, "Marigot Bay");
    const srv = await import("../lib/server/aiAgent/orders.ts");
    const edited = await srv.updateOrderManually({ businessSlug: "dog_food", orderId: order.id, adminId: "u", action: "edit", expectedVersion: order.version, patch: { delivery_address: "Pigeon Island" } });
    assert.ok(edited.ok);
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }] }));
    await say(JANE, "make that 3 bags", { at: "2026-10-28T12:40:00.000Z" });
    assert.equal((await orderOf(JANE)).delivery_address, "Pigeon Island", "a staff correction survives later turns");
  });

  test("a new order is stored with delivery and a day from the customer's message time; later reads and turns never move it", async () => {
    modelOrders(draft({ delivery_address: "Cap Estate", requested_for: "morning" }));
    await say(JANE, "a bag of Monello Chicken 25kg to Cap Estate in the morning", { at: AFTER_NINE });
    const o = await orderOf(JANE);
    assert.equal(o.fulfilment_method, "delivery");
    assert.equal(o.requested_for, "Thu 29 Oct (default, morning)", "after 9:00 → tomorrow, the customer's time of day kept");
    assert.equal(o.first_message_at.slice(0, 10), "2026-10-28");
    // A later turn that only repeats the time of day, or arrives on another day, does not recompute it.
    modelOrders(draft({ delivery_address: "Cap Estate", requested_for: "morning", items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }] }));
    await say(JANE, "make it 2 bags", { at: "2026-10-30T15:00:00.000Z" });
    assert.equal((await orderOf(JANE)).requested_for, "Thu 29 Oct (default, morning)");
    assert.equal(orderDate(asTracked(await orderOf(JANE)), TZ), "2026-10-29");
    // Naming a day replaces the default; it is then no longer a default.
    modelOrders(draft({ delivery_address: "Cap Estate", requested_for: "Saturday" }));
    await say(JANE, "actually Saturday please", { at: "2026-10-30T15:05:00.000Z" });
    const after = await orderOf(JANE);
    assert.match(after.requested_for, /^Sat 31 Oct/);
    assert.equal(effectiveDate(asTracked(after), TZ).source, "stated");
  });

  test("explicit customer dates and collection are never replaced by defaults, and a staff-corrected day survives", async () => {
    modelOrders(draft({ delivery_address: "Cap Estate", requested_for: "Friday 30 Oct" }));
    await say(JANE, "a bag of Monello Chicken 25kg to Cap Estate on Friday 30 Oct", { at: AFTER_NINE });
    assert.match((await orderOf(JANE)).requested_for, /^Fri 30 Oct/);
    assert.ok(!(await orderOf(JANE)).requested_for.includes("default"));
    modelOrders(draft({ delivery_preference: "collection" }));
    await say(MARCUS, "a bag of Monello Chicken 25kg, I'll collect", { at: MORNING });
    const marcus = await orderOf(MARCUS);
    assert.equal(marcus.fulfilment_method, "collection");
    assert.equal(marcus.requested_for, "Wed 28 Oct (default)");
    const srv = await import("../lib/server/aiAgent/orders.ts");
    const res = await srv.updateOrderManually({ businessSlug: "dog_food", orderId: marcus.id, adminId: "u", action: "edit", expectedVersion: marcus.version, patch: { requested_for: "Mon 2 Nov" } });
    assert.ok(res.ok);
    modelOrders(draft({ delivery_preference: "collection", requested_for: "morning" }));
    await say(MARCUS, "morning please", { at: "2026-10-28T12:50:00.000Z" });
    assert.equal((await orderOf(MARCUS)).requested_for, "Mon 2 Nov");
  });

  // ── Historical repair ──────────────────────────────────────────────────────

  async function seedHistorical() {
    // Written by the OLD rules: no method/day, so 'possible'; a phone number parked in notes; a placeholder name.
    const insert = (ref: string, chat: Customer, over: Record<string, string | null>) =>
      pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_address, requested_for, notes, missing_fields, source_message_ids, manual_locked_fields, first_message_at, last_message_at)
        values (${lit(ref)}, 'dog_food', ${lit(chat.chat)}, ${lit(chat.phone)}, ${over.name ? lit(over.name) : "null"}, ${lit(over.status ?? "possible")},
          '[{"product":"Monello Chicken","quantity":"2","variant":null,"size":"25kg"}]'::jsonb, null, ${over.address ? lit(over.address) : "null"}, null, ${over.notes ? lit(over.notes) : "null"},
          '{fulfilment_method,requested_for}', array[${lit(over.msg ?? "none")}], array[${(over.locked ?? "").split(",").filter(Boolean).map(lit).join(",")}]::text[],
          '2026-10-26T14:00:00Z', '2026-10-26T14:10:00Z');`);
    const store = (chat: Customer, id: string, text: string, at: string, dir = "inbound") =>
      pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
        values ('dog_food', ${lit(chat.chat)}, ${lit(chat.phone)}, ${lit(dir)}, ${lit(text)}, ${lit(id)}, ${lit(at)});`);
    await store(JANE, "J1", "2 bags of Monello Chicken 25kg to Cap Estate, I'll collect tomorrow", "2026-10-26T14:00:00Z");
    await insert("O-HIST1", JANE, { name: "Unknown Contact", address: "Cap Estate", msg: "J1" });
    await store(MARCUS, "M1", "2 bags of Monello Chicken 25kg to Rodney Bay, call 758 123 4567 on arrival", "2026-10-26T14:00:00Z");
    await insert("O-HIST2", MARCUS, { name: "Marcus", address: "Rodney Bay", notes: "758 123 4567", msg: "M1" });
    const PRIYA = { chat: "17585550103@s.whatsapp.net", phone: "17585550103" };
    await store(PRIYA, "P1", "2 bags of Monello Chicken 25kg to Cap Estate", "2026-10-26T14:00:00Z");
    await insert("O-HIST3", PRIYA, { name: "Priya", address: "Cap Estate", status: "confirmed", msg: "P1" });
    const DEV = { chat: "17585550104@s.whatsapp.net", phone: "17585550104" };
    await store(DEV, "D1", "I'll collect tomorrow", "2026-10-26T14:00:00Z");
    await insert("O-HIST4", DEV, { name: "Dev", address: "Cap Estate", msg: "D1", locked: "fulfilment_method,requested_for" });
    await insert("O-HIST5", { chat: "17585550105@s.whatsapp.net", phone: "17585550105" }, { name: "Done", address: "Cap Estate", status: "fulfilled" });
  }

  test("the preview lists proposed corrections with evidence and writes nothing", async () => {
    await seedHistorical();
    const before = await allOrders();
    const outboxBefore = await count(`select 1 from public.ai_agent_outbox`);
    const preview = await repair.previewOrderRepair("dog_food");
    assert.deepEqual(await allOrders(), before, "a preview writes nothing");
    assert.equal(await count(`select 1 from public.ai_agent_outbox`), outboxBefore);
    assert.equal(await count(`select 1 from public.ai_agent_order_events where kind = 'order_repair'`), 0);
    const byRef = Object.fromEntries(preview.items.map((i) => [i.ref, i]));
    assert.ok(!("O-HIST5" in byRef), "a completed order is never part of a repair");
    assert.equal(preview.summary.open, 4);
    const pickup = byRef["O-HIST1"].changes.find((c) => c.field === "fulfilment_method")!;
    assert.equal(pickup.after, "collection");
    assert.match(pickup.evidence ?? "", /collect tomorrow/);
    assert.equal(byRef["O-HIST1"].changes.find((c) => c.field === "customer_name")?.after, null, "a placeholder name is cleared, not guessed");
    assert.equal(byRef["O-HIST2"].changes.find((c) => c.field === "notes")?.after, "Delivery contact: 758-123-4567");
    assert.deepEqual(byRef["O-HIST2"].changes.find((c) => c.field === "status")?.after, "awaiting_confirmation");
    assert.ok(!byRef["O-HIST3"] || byRef["O-HIST3"].changes.every((c) => c.field === "customer_name" || c.field === "notes"), "a confirmed order is not changed by the rules");
    assert.ok(byRef["O-HIST4"].skipped.length >= 1, "staff-locked fields are reported as skipped");
  });

  test("apply changes exactly the previewed fields once; repeating it, or a stale preview, changes nothing; staff edits survive", async () => {
    await seedHistorical();
    const preview = await repair.previewOrderRepair("dog_food");
    const approved = preview.items.filter((i) => i.changes.length > 0).map((i) => ({ orderId: i.orderId, fingerprint: i.fingerprint }));
    assert.ok(approved.length >= 2);
    const staffLockedBefore = (await allOrders()).find((o) => o.ref_code === "O-HIST4")!;
    const first = await repair.applyOrderRepair({ businessSlug: "dog_food", adminId: "admin-1", approved });
    assert.ok(first.every((r) => r.outcome === "applied"), JSON.stringify(first));
    const after = Object.fromEntries((await allOrders()).map((o) => [o.ref_code, o]));
    assert.equal(after["O-HIST1"].fulfilment_method, "collection");
    assert.equal(after["O-HIST1"].customer_name, null);
    assert.equal(after["O-HIST1"].contact_number, JANE.phone, "the verified phone is never touched");
    assert.equal(after["O-HIST2"].notes, "Delivery contact: 758-123-4567");
    assert.equal(after["O-HIST2"].status, "awaiting_confirmation");
    assert.equal(Date.parse(after["O-HIST2"].last_message_at), Date.parse("2026-10-26T14:10:00Z"), "customer activity time is not rewritten");
    assert.equal(after["O-HIST4"].fulfilment_method, staffLockedBefore.fulfilment_method, "a staff-locked field is not overwritten");
    assert.equal(after["O-HIST5"].status, "fulfilled");
    // Audit history is kept: a repair event with the before/after and the reason, and an audit entry.
    const evs = await events(after["O-HIST1"].id);
    const ev = evs.at(-1)!;
    assert.equal(ev.kind, "order_repair");
    assert.deepEqual(ev.changes.fulfilment_method, { before: null, after: "collection" });
    assert.match(JSON.stringify(ev.changes.repair), /asked to collect/);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'order.repair'`), first.length);
    // Idempotent: the same approval again applies nothing; a fresh preview has nothing left to apply.
    const again = await repair.applyOrderRepair({ businessSlug: "dog_food", adminId: "admin-1", approved });
    assert.ok(again.every((r) => r.outcome === "nothing_to_apply" || r.outcome === "already_applied"), JSON.stringify(again));
    assert.equal(await count(`select 1 from public.ai_agent_order_events where kind = 'order_repair'`), first.length);
    const next = await repair.previewOrderRepair("dog_food");
    assert.equal(next.summary.withChanges, 0, "a repaired book plans nothing");
    // Nothing reached a customer, no order was created or removed, and !update does not announce the repair.
    assert.equal(await customerBound(), 0);
    assert.equal((await allOrders()).length, 5);
  });

  test("a preview that went stale (the order changed) is refused for that order only", async () => {
    await seedHistorical();
    const preview = await repair.previewOrderRepair("dog_food");
    const one = preview.items.find((i) => i.ref === "O-HIST1")!;
    const two = preview.items.find((i) => i.ref === "O-HIST2")!;
    await pg.run(`update public.ai_agent_orders set version = version + 1, notes = 'staff typed this' where ref_code = 'O-HIST1';`);
    const res = await repair.applyOrderRepair({ businessSlug: "dog_food", adminId: "admin-1", approved: [one, two].map((i) => ({ orderId: i.orderId, fingerprint: i.fingerprint })) });
    assert.deepEqual(Object.fromEntries(res.map((r) => [r.ref, r.outcome])), { "O-HIST1": "changed_since_preview", "O-HIST2": "applied" });
    assert.equal((await allOrders()).find((o) => o.ref_code === "O-HIST1")!.notes, "staff typed this");
  });

  test("completed and cancelled orders are never previewed or applied; confirmed and staff-locked orders keep their protected fields", async () => {
    await seedHistorical();
    await pg.run(`update public.ai_agent_orders set status = 'cancelled' where ref_code = 'O-HIST2';`);
    const before = await allOrders();
    const preview = await repair.previewOrderRepair("dog_food");
    const refs = preview.items.map((i) => i.ref);
    assert.ok(!refs.includes("O-HIST5") && !refs.includes("O-HIST2"), "fulfilled and cancelled orders are not planned");
    const byId = new Map(before.map((o) => [o.ref_code, o.id]));
    const res = await repair.applyOrderRepair({
      businessSlug: "dog_food", adminId: "admin-1",
      approved: [{ orderId: byId.get("O-HIST5")!, fingerprint: "x" }, { orderId: byId.get("O-HIST2")!, fingerprint: "x" }],
    });
    assert.deepEqual(res.map((r) => r.outcome), ["not_found", "not_found"]);
    // Confirmed (HIST3) and locked (HIST4): applying everything offered changes no protected field.
    const approved = preview.items.filter((i) => i.changes.length > 0).map((i) => ({ orderId: i.orderId, fingerprint: i.fingerprint }));
    await repair.applyOrderRepair({ businessSlug: "dog_food", adminId: "admin-1", approved });
    const after = await allOrders();
    const pick = (list: Record<string, any>[], ref: string) => list.find((o) => o.ref_code === ref)!;
    for (const ref of ["O-HIST2", "O-HIST5"]) assert.deepEqual(pick(after, ref), pick(before, ref), `${ref} is untouched`);
    const confirmed = pick(after, "O-HIST3");
    assert.deepEqual([confirmed.status, confirmed.fulfilment_method, confirmed.requested_for, confirmed.delivery_address], ["confirmed", null, null, "Cap Estate"]);
    const locked = pick(after, "O-HIST4");
    assert.deepEqual([locked.fulfilment_method, locked.requested_for], [pick(before, "O-HIST4").fulfilment_method, pick(before, "O-HIST4").requested_for], "staff-locked fields stay");
    assert.equal(await customerBound(), 0, "a repair never messages anyone");
  });

  test("a repair never crosses businesses", async () => {
    await seedHistorical();
    const preview = await repair.previewOrderRepair("by_sea");
    assert.equal(preview.summary.open, 0);
    const res = await repair.applyOrderRepair({ businessSlug: "by_sea", adminId: "admin-1", approved: [{ orderId: (await allOrders())[0].id, fingerprint: "x" }] });
    assert.deepEqual(res.map((r) => r.outcome), ["not_found"]);
  });

  // ── Where the address came from ────────────────────────────────────────────

  const SAVED = async (c: Customer, place: string) =>
    pg.run(`insert into public.ai_agent_customer_staff_memory (business_slug, customer_key, kind, status, content, fingerprint) values ('dog_food', ${lit(c.phone)}, 'delivery_location', 'active', ${lit(place)}, ${lit(`fp-${place}-${c.phone}`)});`);
  const refOf = (o: Record<string, any>) => `#${String(o.ref_code).slice(2)}`;
  const provenanceOf = async (o: Record<string, any>) => (await (await import("../lib/server/aiAgent/orders.ts")).loadAddressProvenance("dog_food", [asTracked(o)]))[o.id];
  const orderList = async () => (await groupSays("!orders all")).outbox.map((x) => x.body).join("\n");
  const orderInfo = async (o: Record<string, any>) => (await groupSays(`!order ${refOf(o)}`)).outbox.map((x) => x.body).join("\n");

  test("saved address: marked in !orders, !order #REF and the website data; an explicit address is not", async () => {
    await SAVED(JANE, "Marigot Bay");
    await SAVED(MARCUS, "Marigot Bay");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    modelOrders(draft({ delivery_address: "Cap Estate" }));
    await say(MARCUS, "a bag of Monello Chicken 25kg to Cap Estate");
    const jane = await orderOf(JANE);
    const marcus = await orderOf(MARCUS);
    assert.deepEqual(await provenanceOf(jane), { origin: "saved" });
    assert.deepEqual(await provenanceOf(marcus), { origin: "customer" });
    const list = await orderList();
    assert.match(list, /Marigot Bay \(Saved address\)/);
    assert.match(list, /Cap Estate(?! \()/);
    assert.doesNotMatch(list, /Cap Estate \((Saved|Previous) address\)/);
    assert.match(await orderInfo(jane), /Address: Saved address — not stated in this chat/);
    assert.match(await orderInfo(marcus), /Address: given by the customer/);
  });

  test("previous address: a single verified earlier address is labelled with its order; two different ones fill nothing", async () => {
    await seedPast("O-OLD1", JANE, "Cap Estate");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    const jane = await orderOf(JANE);
    assert.deepEqual(await provenanceOf(jane), { origin: "previous", fromRef: "O-OLD1" });
    assert.match(await orderList(), /Cap Estate \(Previous address\)/);
    assert.match(await orderInfo(jane), /Address: Previous address \(from #OLD1\) — not stated in this chat/);
  });

  test("overridden by the customer: the new address is theirs, and nothing is labelled inferred any more", async () => {
    await SAVED(JANE, "Marigot Bay");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    assert.equal((await provenanceOf(await orderOf(JANE))).origin, "saved");
    modelOrders(draft({ delivery_address: "Rodney Bay", delivery_preference: "delivery" }));
    await say(JANE, "actually deliver to Rodney Bay", { at: "2026-10-28T12:40:00.000Z" });
    const jane = await orderOf(JANE);
    assert.equal(jane.delivery_address, "Rodney Bay");
    assert.equal((await provenanceOf(jane)).origin, "customer");
    const list = await orderList();
    assert.match(list, /Rodney Bay/);
    assert.doesNotMatch(list, /Saved address|Previous address/);
    const info = await orderInfo(jane);
    assert.match(info, /Address: given by the customer/);
    assert.doesNotMatch(info, /address from/);
  });

  test("the customer writing the same place the AI filled in confirms it; a turn that only changes the quantity does not", async () => {
    await SAVED(JANE, "Marigot Bay");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }] }));
    await say(JANE, "make that 3 bags", { at: "2026-10-28T12:35:00.000Z" });
    assert.equal((await provenanceOf(await orderOf(JANE))).origin, "saved", "an unrelated change leaves it inferred");
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }], delivery_address: "Marigot Bay", delivery_preference: "delivery" }));
    await say(JANE, "yes deliver to Marigot Bay", { at: "2026-10-28T12:45:00.000Z" });
    const jane = await orderOf(JANE);
    assert.equal(jane.delivery_address, "Marigot Bay");
    assert.equal((await provenanceOf(jane)).origin, "customer");
    assert.doesNotMatch(await orderList(), /Saved address/);
    // The model merely echoing the address back, when the customer wrote nothing of the sort, confirms nothing.
    await SAVED(MARCUS, "Vigie");
    modelOrders(draft());
    await say(MARCUS, "a bag of Monello Chicken 25kg please");
    modelOrders(draft({ delivery_address: "Vigie" }));
    await say(MARCUS, "thanks", { at: "2026-10-28T12:50:00.000Z" });
    assert.equal((await provenanceOf(await orderOf(MARCUS))).origin, "saved");
  });

  test("staff-corrected: an edit (even to the same address) or a staff confirmation ends 'inferred'; the correction survives later turns", async () => {
    const srv = await import("../lib/server/aiAgent/orders.ts");
    await SAVED(JANE, "Marigot Bay");
    await SAVED(MARCUS, "Marigot Bay");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    await say(MARCUS, "a bag of Monello Chicken 25kg please");
    const jane = await orderOf(JANE);
    const edited = await srv.updateOrderManually({ businessSlug: "dog_food", orderId: jane.id, adminId: "u", action: "edit", expectedVersion: jane.version, patch: { delivery_address: "Pigeon Island" } });
    assert.ok(edited.ok);
    assert.deepEqual(await provenanceOf(await orderOf(JANE)), { origin: "staff" });
    assert.match(await orderInfo(await orderOf(JANE)), /Address: set by staff/);
    // Staff retype the very same address: it is now staff-checked.
    const marcus = await orderOf(MARCUS);
    assert.equal((await provenanceOf(marcus)).origin, "saved");
    assert.ok((await srv.updateOrderManually({ businessSlug: "dog_food", orderId: marcus.id, adminId: "u", action: "edit", expectedVersion: marcus.version, patch: { delivery_address: "Marigot Bay" } })).ok);
    assert.equal((await provenanceOf(await orderOf(MARCUS))).origin, "staff");
    const list = await orderList();
    assert.doesNotMatch(list, /Saved address|Previous address/);
    // A later customer turn does not bring the label back.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }] }));
    await say(JANE, "make that 3 bags", { at: "2026-10-28T12:40:00.000Z" });
    assert.equal((await provenanceOf(await orderOf(JANE))).origin, "staff");
  });

  test("staff confirming an order with a filled address ends 'inferred'; reading provenance writes and sends nothing", async () => {
    const srv = await import("../lib/server/aiAgent/orders.ts");
    await SAVED(JANE, "Marigot Bay");
    modelOrders(draft());
    await say(JANE, "a bag of Monello Chicken 25kg please");
    const jane = await orderOf(JANE);
    assert.equal((await provenanceOf(jane)).origin, "saved");
    const before = JSON.stringify([await allOrders(), await events(jane.id)]);
    await orderList();
    await orderInfo(jane);
    await provenanceOf(jane);
    assert.equal(JSON.stringify([await allOrders(), await events(jane.id)]), before, "the reports are read-only");
    const confirmed = await srv.updateOrderManually({ businessSlug: "dog_food", orderId: jane.id, adminId: "u", action: "confirm", expectedVersion: jane.version });
    assert.ok(confirmed.ok);
    assert.equal((await provenanceOf(await orderOf(JANE))).origin, "customer");
    assert.equal(await customerBound(), 0);
  });
});
