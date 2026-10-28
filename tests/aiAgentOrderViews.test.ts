// The order views (!orders), the !update change summary and the date rules behind them — pure, no database.
// Covers: date boundaries in America/St_Lucia, missing and unreadable dates, old orders, delivery vs collection,
// missing information, the per-order change summary (rapid edits combined, staff commands and completions not news),
// and that the command menu stays in step with the real parsers.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anchorRequestedFor, requestedDate, resolveExplicitDay, resolveRequestedDay } from "../lib/aiAgent/orderText.ts";
import { parseOrderCommand } from "../lib/aiAgent/orderCommands.ts";
import {
  bucketOf,
  buildOrdersView,
  buildUpdateSummary,
  countOrders,
  dayContext,
  needsAttention,
  orderDate,
  orderGaps,
  type OrderEventRow,
  parseOrdersView,
  selectOrders,
  summarizeUpdates,
} from "../lib/aiAgent/orderViews.ts";
import { buildRulesMessages, STAFF_COMMANDS } from "../lib/aiAgent/commandRegistry.ts";
import type { TrackedOrder } from "../lib/aiAgent/orders.ts";

const TZ = "America/St_Lucia"; // UTC-4, no daylight saving
// Wed 28 Oct 2026, 10:00 in St Lucia.
const NOW = new Date("2026-10-28T14:00:00Z");

let n = 0;
const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => {
  n += 1;
  return {
    id: `o${n}`,
    ref_code: `O-AAA${String(n).padStart(2, "0")}`,
    business_slug: "dog_food",
    chat_id: `1758555${1000 + n}@s.whatsapp.net`,
    contact_number: `1758555${1000 + n}`,
    customer_name: `Customer ${n}`,
    status: "awaiting_confirmation",
    items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: "25kg" }],
    fulfilment_method: "delivery",
    delivery_preference: "delivery",
    delivery_address: "Cap Estate",
    requested_for: null,
    notes: null,
    missing_fields: [],
    attention: null,
    source_message_ids: [],
    first_message_at: "2026-10-28T13:00:00Z",
    last_message_at: "2026-10-28T13:00:00Z",
    awaiting_since: null,
    manual_locked_fields: [],
    field_conflicts: {},
    confirmed_by: null,
    confirmed_at: null,
    customer_confirmed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    fulfilled_at: null,
    version: 1,
    created_at: "2026-10-28T13:00:00Z",
    updated_at: "2026-10-28T13:00:00Z",
    ...over,
  };
};
const ctx = dayContext(NOW, TZ);
const forDay = (label: string, over: Partial<TrackedOrder> = {}) => order({ requested_for: label, ...over });

describe("fulfilment dates", () => {
  test("a written date is read, with the year taken from the nearest occurrence", () => {
    for (const [text, date] of [["30 Oct", "2026-10-30"], ["30th October 2026", "2026-10-30"], ["Oct 30", "2026-10-30"], ["2026-10-30", "2026-10-30"], ["30/10/2026", "2026-10-30"], ["2 Jan", "2027-01-02"], ["25 oct", "2026-10-25"]] as const) {
      assert.equal(resolveExplicitDay(text, NOW, TZ)?.date, date, text);
    }
  });
  test("impossible, ambiguous and quantity-like text is not a date", () => {
    for (const text of ["31 Nov", "30 oct or 31 oct", "2.5 bags", "1/2 a bag", "sometime next week", "soon"]) assert.equal(resolveExplicitDay(text, NOW, TZ), null, text);
    assert.equal(resolveRequestedDay("tomorrow, 30 Oct", NOW, TZ), null, "tomorrow is the 29th: the two disagree, so neither is trusted");
    assert.equal(resolveRequestedDay("Friday 30 Oct", NOW, TZ)?.date, "2026-10-30");
  });
  test("'tomorrow' counts from the local day the customer wrote it, across the UTC date line", () => {
    // 22:30 on the 28th in St Lucia is already the 29th in UTC.
    assert.equal(resolveRequestedDay("tomorrow", new Date("2026-10-29T02:30:00Z"), TZ)?.date, "2026-10-29");
    assert.equal(resolveRequestedDay("tomorrow", new Date("2026-10-29T03:59:59Z"), TZ)?.date, "2026-10-29");
    assert.equal(resolveRequestedDay("tomorrow", new Date("2026-10-29T04:00:00Z"), TZ)?.date, "2026-10-30", "00:00 local is the next day");
  });
  test("the stored label is read back to the same day, whenever it is read", () => {
    const label = anchorRequestedFor("tomorrow morning", null, new Date("2026-10-27T15:00:00Z"), TZ)!;
    assert.match(label, /^Wed 28 Oct \(tomorrow morning\)$/);
    assert.equal(requestedDate(label, "2026-10-27T15:00:00Z", TZ), "2026-10-28");
    // Read a month later from a different anchor: the weekday + day still fix the year.
    assert.equal(requestedDate(label, "2026-12-01T15:00:00Z", TZ), "2026-10-28");
    assert.equal(requestedDate("Sat 2 Jan (2 Jan)", "2026-12-28T15:00:00Z", TZ), "2027-01-02", "year boundary");
  });
  test("a customer's raw words are counted from when the order was first written; unreadable words give no date", () => {
    assert.equal(requestedDate("tomorrow", "2026-10-27T15:00:00Z", TZ), "2026-10-28");
    assert.equal(requestedDate("sometime", NOW.toISOString(), TZ), null);
    assert.equal(requestedDate("next Friday", NOW.toISOString(), TZ), null, "'next Friday' could mean two days: left undated, never guessed");
    assert.equal(requestedDate(null, NOW.toISOString(), TZ), null);
    assert.equal(requestedDate("", NOW.toISOString(), TZ), null);
  });
  test("a staff correction to an explicit date is stored in the resolved form", () => {
    assert.equal(anchorRequestedFor("30 Oct", "Wed 28 Oct (tomorrow)", NOW, TZ), "Fri 30 Oct (30 Oct)");
    assert.equal(anchorRequestedFor("whenever", null, NOW, TZ), "whenever", "unreadable words are kept as written");
  });
});

describe("where an order belongs today", () => {
  test("today, tomorrow, later, overdue by the day it is FOR, not the day it was written", () => {
    const old = (over: Partial<TrackedOrder>) => order({ first_message_at: "2026-10-20T13:00:00Z", created_at: "2026-10-20T13:00:00Z", ...over });
    assert.equal(bucketOf(old({ requested_for: "Wed 28 Oct (Wednesday)" }), ctx), "today", "written a week ago, for today");
    assert.equal(bucketOf(forDay("Thu 29 Oct (tomorrow)"), ctx), "tomorrow");
    assert.equal(bucketOf(forDay("Fri 30 Oct (Friday)"), ctx), "later");
    assert.equal(bucketOf(forDay("Tue 27 Oct (yesterday)"), ctx), "overdue");
    assert.equal(bucketOf(forDay("Wed 28 Oct (today)", { first_message_at: "2026-10-28T13:00:00Z" }), ctx), "today", "written today, for today");
  });
  test("midnight in St Lucia moves everything one day on; nothing is silently carried over as 'today'", () => {
    const o = forDay("Wed 28 Oct (today)");
    const before = dayContext(new Date("2026-10-29T03:59:00Z"), TZ);
    const after = dayContext(new Date("2026-10-29T04:00:00Z"), TZ);
    assert.equal(bucketOf(o, before), "today");
    assert.equal(bucketOf(o, after), "overdue", "yesterday's order is overdue, not today's");
    assert.deepEqual(selectOrders({ type: "default" }, [o], after), [], "and it is not in today/tomorrow");
    assert.deepEqual(selectOrders({ type: "overdue" }, [o], after), [o], "but it is still reachable");
  });
  test("an order with no day gets the business default from when it was written, and goes overdue afterwards", () => {
    const early = order({ requested_for: null, first_message_at: "2026-10-28T12:59:00Z" }); // 08:59 local
    const late = order({ requested_for: null, first_message_at: "2026-10-28T13:00:00Z" }); // 09:00 local
    const stale = order({ requested_for: null, first_message_at: "2026-10-26T13:00:00Z" });
    assert.equal(bucketOf(early, ctx), "today");
    assert.equal(bucketOf(late, ctx), "tomorrow");
    assert.equal(bucketOf(stale, ctx), "overdue");
    assert.equal(selectOrders({ type: "undated" }, [early, late, stale], ctx).length, 0, "a defaulted day is a day, not a gap");
  });
  test("a day in words nobody can read is 'day not clear' on the day it was written and overdue afterwards", () => {
    const fresh = order({ requested_for: "sometime next week", first_message_at: "2026-10-28T13:00:00Z" });
    const stale = order({ requested_for: "sometime next week", first_message_at: "2026-10-26T13:00:00Z" });
    assert.equal(bucketOf(fresh, ctx), "undated");
    assert.equal(bucketOf(stale, ctx), "overdue");
    assert.equal(selectOrders({ type: "undated" }, [fresh, stale], ctx).length, 2, "both stay reachable");
  });
  test("closed orders are in no outstanding view and are never changed by looking", () => {
    const done = forDay("Wed 28 Oct (today)", { status: "fulfilled" });
    const gone = forDay("Wed 28 Oct (today)", { status: "cancelled" });
    for (const type of ["default", "today", "overdue", "missing", "undated", "all"] as const) assert.deepEqual(selectOrders({ type }, [done, gone], ctx), [], type);
    assert.equal(countOrders([done, gone], ctx).open, 0);
    assert.equal(done.status, "fulfilled");
  });
  test("an unreadable day counts as missing information", () => {
    const o = forDay("sometime next week");
    assert.equal(orderDate(o, TZ), null);
    assert.ok(orderGaps(o, TZ).includes("requested_for"));
    assert.ok(selectOrders({ type: "missing" }, [o], ctx).includes(o));
  });
});

describe("missing information and attention", () => {
  test("products, quantity and a delivery address are the essentials; delivery and the day are defaults, never gaps", () => {
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)"), TZ), []);
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { items: [] }), TZ), ["items"]);
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { items: [{ product: "Monello", quantity: null, variant: null, size: null }] }), TZ), ["quantity"]);
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { fulfilment_method: null }), TZ), [], "no stated method is a delivery, not a gap");
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { fulfilment_method: null, delivery_address: null }), TZ), ["delivery_address"], "the default is delivery, so it needs an address");
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { delivery_address: null }), TZ), ["delivery_address"]);
    assert.deepEqual(orderGaps(forDay("Thu 29 Oct (tomorrow)", { fulfilment_method: "collection", delivery_address: null }), TZ), [], "a collection needs no address");
    assert.deepEqual(orderGaps(order({ requested_for: null }), TZ), [], "no day is the business default, not a gap");
    assert.deepEqual(orderGaps(order({ requested_for: "sometime next week" }), TZ), ["requested_for"], "words nobody can read are a gap");
  });
  test("the attention count is overdue + missing information + warnings, once each", () => {
    const fine = forDay("Thu 29 Oct (tomorrow)");
    const overdue = forDay("Mon 26 Oct (Monday)");
    const missing = forDay("Thu 29 Oct (tomorrow)", { delivery_address: null });
    const both = forDay("Mon 26 Oct (Monday)", { items: [] });
    const warned = forDay("Thu 29 Oct (tomorrow)", { attention: "changed_after_confirmation" });
    const counts = countOrders([fine, overdue, missing, both, warned], ctx);
    assert.deepEqual([counts.open, counts.overdue, counts.missing, counts.attention, counts.tomorrow], [5, 2, 2, 4, 3]);
    assert.equal(needsAttention(fine, ctx), false);
  });
});

describe("!orders parsing", () => {
  const view = (text: string) => {
    const c = parseOrderCommand(text, { now: NOW, timezone: TZ });
    return c?.kind === "orders" ? c.view : c;
  };
  test("every view parses, case- and punctuation-tolerant", () => {
    assert.deepEqual(view("!orders"), { type: "default" });
    assert.deepEqual(view("!ORDERS."), { type: "default" });
    assert.deepEqual(view("!orders today"), { type: "today" });
    assert.deepEqual(view("!orders  Tomorrow!"), { type: "tomorrow" });
    assert.deepEqual(view("!orders overdue"), { type: "overdue" });
    assert.deepEqual(view("!orders missing"), { type: "missing" });
    assert.deepEqual(view("!orders undated"), { type: "undated" });
    assert.deepEqual(view("!orders all"), { type: "all" });
    assert.deepEqual(view("!orders 30 Oct"), { type: "day", date: "2026-10-30" });
    assert.deepEqual(view("!orders 2026-11-02"), { type: "day", date: "2026-11-02" });
    assert.deepEqual(view("!orders friday"), { type: "day", date: "2026-10-30" });
  });
  test("an argument we do not understand gets the usage, not silence or a guess", () => {
    for (const text of ["!orders banana", "!orders 31 Nov", "!orders next friday", "!orders " + "x".repeat(60)]) assert.deepEqual(parseOrderCommand(text, { now: NOW, timezone: TZ }), { kind: "help", reason: "orders" }, text);
  });
  test("!order, !orders, !update and !moreinfo stay separate commands", () => {
    assert.equal(parseOrderCommand("!order #QU6U9")?.kind, "info");
    assert.deepEqual(parseOrderCommand("!order #QU6U9 completed"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "complete" } });
    assert.deepEqual(parseOrderCommand("!order #QU6U9 reopen"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "reopen" } });
    assert.equal(parseOrderCommand("!order jane")?.kind, "search");
    assert.equal(parseOrderCommand("!update")?.kind, "report");
    assert.equal(parseOrderCommand("!moreinfo #QU6U9")?.kind, "info");
    assert.equal(parseOrderCommand("!orderly conduct"), null);
    assert.equal(parseOrderCommand("orders please"), null, "a command is the first word");
  });
  test("a delivery-date correction takes an explicit date", () => {
    assert.deepEqual(parseOrderCommand("!update #QU6U9 delivery 30 Oct"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "delivery", when: "30 Oct" } });
  });
});

const body = (v: Parameters<typeof parseOrdersView>[0], orders: TrackedOrder[], names?: Parameters<typeof buildOrdersView>[0]["names"]) =>
  buildOrdersView({ view: parseOrdersView(v, NOW, TZ)!, orders, now: NOW, timezone: TZ, names }).parts.join("\n\n");

describe("!orders output", () => {
  const today = forDay("Wed 28 Oct (today)", { customer_name: "Jane Doe", status: "confirmed", confirmed_at: "2026-10-28T13:30:00Z" });
  const todayCollect = forDay("Wed 28 Oct (today afternoon)", { customer_name: "Marcus", fulfilment_method: "collection", delivery_address: null });
  const tomorrow = forDay("Thu 29 Oct (tomorrow)", { customer_name: "Priya", delivery_address: "Rodney Bay" });
  const later = forDay("Sat 31 Oct (Saturday)", { customer_name: "Later Larry" });
  const overdue = forDay("Mon 26 Oct (Monday)", { customer_name: "Old Olga", first_message_at: "2026-10-24T13:00:00Z" });
  const noDay = order({ customer_name: "Dayless Dan", requested_for: null, first_message_at: "2026-10-28T12:00:00Z" }); // 08:00 local: default today
  const oldNoDay = order({ customer_name: "Ancient Abe", requested_for: null, first_message_at: "2026-10-20T12:00:00Z" }); // default 20 Oct: overdue
  const vague = order({ customer_name: "Vague Vic", requested_for: "sometime next week", first_message_at: "2026-10-28T13:00:00Z" });
  const oldVague = order({ customer_name: "Hazy Hank", requested_for: "sometime next week", first_message_at: "2026-10-20T12:00:00Z" });
  const noInfo = forDay("Thu 29 Oct (tomorrow)", { customer_name: "Hollow Hal", items: [], delivery_address: null });
  const all = [today, todayCollect, tomorrow, later, overdue, noDay, oldNoDay, vague, oldVague, noInfo, forDay("Wed 28 Oct (today)", { customer_name: "Done Dora", status: "fulfilled" })];

  test("the default view is today and tomorrow, each split into delivery and collection; the rest is counted, not listed", () => {
    const text = body("", all);
    assert.match(text, /^📋 \*ORDERS — Wed 28 Oct\*/);
    assert.match(text, /📅 \*TODAY — Wed 28 Oct\* \(3\)\n\n🚚 \*Delivery\*\n\n\*1\. Dayless Dan · #[A-Z0-9]+\* 🕓 to confirm[\s\S]*\*2\. Jane Doe · #[A-Z0-9]+\* ✅ confirmed[\s\S]*🛍 \*Collection\*\n\n\*3\. Marcus/);
    assert.doesNotMatch(text, /default day|🗓 \w{3} \d/, "under a TODAY/TOMORROW heading the day is not repeated and never labelled");
    assert.match(text, /📅 \*TOMORROW — Thu 29 Oct\* \(2\)/);
    assert.match(text, /Priya/);
    for (const hidden of ["Later Larry", "Old Olga", "Ancient Abe", "Hazy Hank", "Done Dora"]) assert.doesNotMatch(text, new RegExp(hidden), `${hidden} is not in today/tomorrow`);
    assert.match(text, /❔ \*DAY NOT CLEAR \(1\)\*[\s\S]*Vague Vic/, "unreadable words are shown under their own heading");
    assert.match(text, /⏰ 3 overdue orders — !orders overdue/);
    assert.match(text, /⚠️ \d+ orders? missing information — !orders missing/);
    assert.match(text, /🗓 1 later order — !orders <date>/);
  });
  test("today / tomorrow / a date list only that day; overdue lists older orders, oldest first, with how to resolve them", () => {
    assert.match(body("today", all), /Jane Doe[\s\S]*Marcus/);
    assert.doesNotMatch(body("today", all), /Priya/);
    assert.match(body("tomorrow", all), /Priya/);
    assert.doesNotMatch(body("tomorrow", all), /Jane/);
    assert.match(body("31 Oct", all), /📅 \*Sat 31 Oct\* \(1\)[\s\S]*Later Larry/);
    const text = body("overdue", all);
    assert.match(text, /^📋 \*OVERDUE ORDERS\*/);
    assert.match(text, /WAS DUE — Mon 26 Oct[\s\S]*Old Olga/);
    assert.match(text, /WAS DUE — Tue 20 Oct[\s\S]*Ancient Abe/, "an old order that named no day is due the day its default gave it");
    assert.match(text, /DAY NOT CLEAR — first mentioned before today \(1\)\*[\s\S]*Hazy Hank/);
    assert.doesNotMatch(text, /Dayless Dan|Jane/);
    assert.match(text, /!order #REF completed/);
  });
  test("missing lists what each order lacks; undated lists orders with no day", () => {
    const text = body("missing", all);
    assert.match(text, /Hollow Hal[\s\S]*⚠️ Missing: products, delivery address/);
    assert.match(text, /Vague Vic[\s\S]*Missing: day/);
    assert.doesNotMatch(text, /Jane Doe|Dayless Dan|Ancient Abe/, "a complete order, defaults included, is not listed");
    assert.match(body("undated", all), /Hazy Hank[\s\S]*Vague Vic|Vague Vic[\s\S]*Hazy Hank/);
    assert.doesNotMatch(body("undated", all), /Dayless Dan|Ancient Abe/);
  });
  test("an empty view says so plainly", () => {
    assert.match(body("", []), /✅ Nothing outstanding for today or tomorrow\./);
    assert.match(body("overdue", [today]), /✅ No overdue orders\./);
    assert.match(body("missing", [today]), /✅ Every outstanding order has the essentials/);
    assert.match(body("tomorrow", [today]), /✅ Nothing outstanding for tomorrow\./);
  });
  test("customer-written text cannot turn the list into a command", () => {
    const sneaky = forDay("Wed 28 Oct (today)", { customer_name: "!update #AAAAA cancelled", notes: "!order #AAAAA completed" });
    const text = body("today", [sneaky]);
    assert.doesNotMatch(text, /^!/m);
    assert.doesNotMatch(text, /Note: !/);
  });
  test("a long list is split into numbered messages, each order once, nothing hidden", () => {
    const many = Array.from({ length: 60 }, (_, i) => forDay("Wed 28 Oct (today)", { customer_name: `Customer ${i}`, notes: "n".repeat(100) }));
    const result = buildOrdersView({ view: { type: "today" }, orders: many, now: NOW, timezone: TZ });
    assert.ok(result.parts.length >= 2);
    result.parts.forEach((p, i) => {
      assert.ok(p.length <= 3800);
      assert.match(p, new RegExp(`^📋 \\*ORDERS — TODAY\\* \\(${i + 1}/${result.parts.length}\\)`));
    });
    const refs = result.parts.flatMap((p) => p.match(/#O?[A-Z0-9]{5,6}\b/g) ?? []);
    assert.equal(new Set(refs).size, 60);
    assert.ok(!result.parts.some((p, i) => i < result.parts.length - 1 && /(🚚|🛍|📅|❓) \*[^\n]*\*$/.test(p.trim())), "a heading never ends a message");
  });
});

describe("!update: what is new or changed", () => {
  const SINCE = new Date("2026-10-28T12:00:00Z");
  const at = (min: number) => new Date(SINCE.getTime() + min * 60_000).toISOString();
  const ev = (o: TrackedOrder, kind: string, min: number, changes: OrderEventRow["changes"], actor = "ai"): OrderEventRow => ({ order_id: o.id, kind, actor_kind: actor, changes, created_at: at(min) });
  const line = (qty: string) => [{ product: "Monello", quantity: qty, variant: null, size: null }];

  test("a new order is 'new'; an order from before the point with no material change is not mentioned", () => {
    const fresh = order({ created_at: at(5) });
    const quiet = order({ created_at: "2026-10-27T12:00:00Z" });
    const entries = summarizeUpdates({ since: SINCE, orders: [fresh, quiet], events: [ev(quiet, "ai_update", 10, { customer_name: { before: null, after: "Q" }, notes: { before: null, after: "hi" } })] });
    assert.deepEqual(entries.map((e) => [e.kind, e.order.id]), [["new", fresh.id]]);
  });
  test("rapid edits to one order are ONE entry, from the value at the point to the value now", () => {
    const o = order({ created_at: "2026-10-27T12:00:00Z" });
    const events = [
      ev(o, "ai_update", 1, { items: { before: line("1"), after: line("2") } }),
      ev(o, "ai_update", 2, { items: { before: line("2"), after: line("3") } }),
      ev(o, "ai_update", 3, { items: { before: line("3"), after: line("4") }, requested_for: { before: "Thu 29 Oct (tomorrow)", after: "Fri 30 Oct (Friday)" } }),
    ];
    const entries = summarizeUpdates({ since: SINCE, orders: [o], events });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].changes, ["products: 1 × Monello → 4 × Monello", "day: Thu 29 Oct → Fri 30 Oct"]);
  });
  test("a change that ends where it started is not a change", () => {
    const o = order({ created_at: "2026-10-27T12:00:00Z" });
    const events = [ev(o, "ai_update", 1, { items: { before: line("1"), after: line("2") } }), ev(o, "ai_update", 2, { items: { before: line("2"), after: line("1") } })];
    assert.deepEqual(summarizeUpdates({ since: SINCE, orders: [o], events }), []);
  });
  test("staff commands, completions and reopenings are bookkeeping, not news; the customer cancelling is", () => {
    const a = order({ created_at: "2026-10-27T12:00:00Z" });
    const b = order({ created_at: "2026-10-27T12:00:00Z", status: "fulfilled" });
    const c = order({ created_at: "2026-10-27T12:00:00Z", status: "cancelled" });
    const d = order({ created_at: "2026-10-27T12:00:00Z", status: "cancelled" });
    const events = [
      ev(a, "staff_whatsapp_edit", 1, { requested_for: { before: "x", after: "Fri 30 Oct (30 Oct)" } }, "staff"),
      ev(b, "manual_fulfil", 2, { status: { before: "confirmed", after: "fulfilled" } }, "admin"),
      ev(c, "customer_cancelled", 3, { status: { before: "confirmed", after: "cancelled" } }, "customer"),
      ev(d, "staff_whatsapp_cancel", 4, { status: { before: "confirmed", after: "cancelled" } }, "staff"),
    ];
    const entries = summarizeUpdates({ since: SINCE, orders: [a, b, c, d], events });
    assert.deepEqual(entries.map((e) => [e.kind, e.order.id]), [["cancelled", c.id]]);
  });
  test("an order asked for and withdrawn since the point is never announced", () => {
    const o = order({ created_at: at(5), status: "cancelled" });
    assert.deepEqual(summarizeUpdates({ since: SINCE, orders: [o], events: [ev(o, "customer_cancelled", 6, { status: { before: "possible", after: "cancelled" } }, "customer")] }), []);
  });
  test("a customer contradicting something staff set, and an attention flag, are surfaced", () => {
    const x = order({ created_at: "2026-10-27T12:00:00Z", field_conflicts: { items: { proposed: line("5"), current: line("3"), at: at(2) } } });
    const y = order({ created_at: "2026-10-27T12:00:00Z", attention: "changed_after_confirmation" });
    const entries = summarizeUpdates({ since: SINCE, orders: [x, y], events: [ev(x, "locked_field_conflict", 2, {}), ev(y, "attention_flagged", 3, {})] });
    assert.deepEqual(entries.map((e) => e.kind).sort(), ["attention", "changed"]);
    assert.match(entries.find((e) => e.kind === "changed")!.changes[0], /customer asked to change something staff set/);
  });
  test("events at or before the point are ignored (nothing is shown twice)", () => {
    const o = order({ created_at: "2026-10-27T12:00:00Z" });
    assert.deepEqual(summarizeUpdates({ since: SINCE, orders: [o], events: [ev(o, "ai_update", 0, { items: { before: line("1"), after: line("2") } })] }), []);
  });

  test("the message is short, one message, honest about what it is, and caps a flood", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ kind: "new" as const, order: order({ customer_name: `Customer ${i}` }), changes: [] }));
    const text = buildUpdateSummary({ entries, since: SINCE, timezone: TZ, counts: countOrders([], ctx) });
    assert.ok(text.length < 3000, `${text.length}`);
    assert.match(text, /^🔔 \*ORDER UPDATE\* — since Wed 28 Oct, 08:00/);
    assert.match(text, /30 new/);
    assert.match(text, /…and 18 more — !orders/);
    assert.match(text, /This message does not mark anything as reviewed\./);
    assert.doesNotMatch(text, /DAILY ORDERS|OPEN ORDERS/);
  });
  test("with nothing new it says so, and a first update says it looked back a day", () => {
    assert.match(buildUpdateSummary({ entries: [], since: SINCE, timezone: TZ }), /✅ No new or changed orders\./);
    assert.match(buildUpdateSummary({ entries: [], since: SINCE, timezone: TZ, firstUpdate: true }), /in the last 24 hours/);
    const waiting = buildUpdateSummary({ entries: [], since: SINCE, timezone: TZ, counts: { ...countOrders([], ctx), overdue: 3, missing: 2 } });
    assert.match(waiting, /3 overdue · 2 missing info · Full list: !orders/);
  });
});

describe("the command menu matches the parsers", () => {
  test("!rules documents !orders (every view), !update, !order and the completion commands", () => {
    const text = buildRulesMessages().join("\n");
    for (const part of ["!orders [today|tomorrow|<date>|all|overdue|missing|undated]", "!orders complete all", "!update [#REF", "!order <name, phone or #REF> | #REF completed | #REF reopen | #REF teach <instruction>"]) assert.ok(text.includes(part), part);
    const doc = STAFF_COMMANDS.find((c) => c.name === "orders")!;
    assert.deepEqual([doc.section, doc.who, doc.readOnly], ["Orders", "authorized", false], "!orders complete all can change orders, so the entry is no longer read-only");
    for (const word of ["overdue", "missing", "undated", "all", "complete all", "B-ABCDE"]) assert.match(doc.summary, new RegExp(word));
    // Everything the registry advertises for !orders really parses to the orders command.
    for (const arg of ["", "today", "tomorrow", "30 Oct", "all", "overdue", "missing", "undated"]) assert.equal(parseOrderCommand(`!orders ${arg}`.trim(), { now: NOW, timezone: TZ })?.kind, "orders", arg);
  });
});
