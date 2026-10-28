// South Deliveries in the !orders report, orders under review, customer-name priority and the day line in !order #REF.
// Pure (no database): the same functions the WhatsApp reports and the dashboard use.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { moreInfoReply } from "../lib/aiAgent/orderCommands.ts";
import { bucketOf, buildOrdersView, countOrders, dayContext, parseOrdersView, selectOrders, southDeliveries } from "../lib/aiAgent/orderViews.ts";
import { ORDER_REVIEW_ATTENTION, pickCustomerName, type TrackedOrder } from "../lib/aiAgent/orders.ts";
import { reviewOrder, type ReviewLine } from "../lib/aiAgent/orderReview.ts";

const TZ = "America/St_Lucia";
const NOW = new Date("2026-10-28T14:00:00Z"); // Wed 28 Oct, 10:00 in Saint Lucia
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
    requested_for: "Thu 29 Oct",
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
const view = (v: string, orders: TrackedOrder[]) => buildOrdersView({ view: parseOrdersView(v, NOW, TZ)!, orders, now: NOW, timezone: TZ }).parts.join("\n\n");

describe("South Deliveries under each date", () => {
  const orders = [
    order({ customer_name: "Ann", delivery_address: "Beanfield, Vieux Fort" }),
    order({ customer_name: "Bo", delivery_address: "Laborie village" }),
    order({ customer_name: "Cy", delivery_address: "Cap Estate" }),
    order({ customer_name: "Di", delivery_address: "Vieux Fort", fulfilment_method: "collection", delivery_preference: "collection" }),
    order({ customer_name: "Ed", delivery_address: "Castries and Vieux Fort" }),
    order({ customer_name: "Flo", delivery_address: null }),
    order({ customer_name: "Gus", delivery_address: "Vieux Fort", requested_for: "Fri 30 Oct" }),
  ];
  test("southern deliveries are grouped by destination under the date; every order appears exactly once", () => {
    const text = view("all", orders);
    const thu = text.slice(text.indexOf("THU"), text.indexOf("FRI") > 0 ? text.indexOf("FRI") : undefined);
    assert.match(text, /South Deliveries/);
    assert.match(text, /📍 \*Vieux Fort\* \(1\)/);
    assert.match(text, /📍 \*Laborie\* \(1\)/);
    for (const name of ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"]) assert.equal(text.split(`${name} ·`).length - 1, 1, `${name} listed once`);
    assert.ok(text.indexOf("Ann ·") > text.indexOf("South Deliveries"), "Ann is under South Deliveries");
    assert.ok(text.indexOf("Cy ·") < text.indexOf("South Deliveries"), "Cy stays in the ordinary Delivery list");
    void thu;
  });
  test("collections stay separate even when the place is southern; ambiguous and missing addresses are not south", () => {
    const text = view("all", orders);
    const south = text.slice(text.indexOf("South Deliveries"), text.indexOf("Collection"));
    assert.ok(!south.includes("Di ·"), "a southern COLLECTION is not a south delivery");
    assert.ok(!south.includes("Ed ·"), "an address naming north and south is not guessed");
    assert.ok(!south.includes("Flo ·"), "no address, not south");
    assert.ok(text.indexOf("Di ·") > text.indexOf("Collection"));
  });
  test("each date has its own South Deliveries section, and the same orders appear in the per-day filters", () => {
    const tomorrow = view("tomorrow", orders);
    assert.match(tomorrow, /South Deliveries/);
    assert.ok(!tomorrow.includes("Gus ·"), "Friday's order is not in tomorrow's list");
    assert.match(view("30 Oct", orders), /South Deliveries[\s\S]*Vieux Fort[\s\S]*Gus ·/);
  });
  test("southDeliveries is computed from the address: a correction moves the order by itself", () => {
    const o = order({ delivery_address: "Gros Islet" });
    assert.equal(southDeliveries([o]).length, 0);
    assert.deepEqual(southDeliveries([{ ...o, delivery_address: "Choiseul" }]).map((g) => g.group), ["Choiseul"]);
    assert.equal(southDeliveries([{ ...o, delivery_address: "Gros Islet" }]).length, 0);
  });
  test("no South section when nothing is going south", () => {
    assert.ok(!view("all", [order()]).includes("South Deliveries"));
  });
  test("the other filters keep working: overdue, missing, undated, all", () => {
    const late = order({ requested_for: "Mon 26 Oct", delivery_address: "Soufriere" });
    assert.match(view("overdue", [late]), /South Deliveries/);
    assert.match(view("missing", [order({ delivery_address: null })]), /address needed/);
    assert.match(view("undated", [order({ requested_for: "sometime next week" })]), /next week/);
  });
});

describe("orders waiting for review are on no delivery list", () => {
  const review = order({ customer_name: "Soco", status: "possible", attention: ORDER_REVIEW_ATTENTION, requested_for: "Thu 29 Oct" });
  const real = order({ customer_name: "Real" });
  test("not in today, tomorrow, a day, all-by-day, missing or undated; counted once as review", () => {
    for (const v of ["today", "tomorrow", "29 Oct", "missing", "undated", "overdue"]) assert.ok(!view(v, [review, real]).includes("Soco ·"), v);
    assert.equal(bucketOf(review, ctx), "review");
    const counts = countOrders([review, real], ctx);
    assert.equal(counts.review, 1);
    assert.equal(counts.tomorrow, 1);
    assert.equal(counts.open, 2);
  });
  test("they have their own view, a pointer in the default view, and a section at the end of 'all'", () => {
    assert.match(view("review", [review, real]), /POSSIBLE ORDERS TO REVIEW[\s\S]*Soco ·/);
    assert.ok(!view("review", [review, real]).includes("Real ·"));
    assert.match(view("", [review, real]), /1 possible order to review.*!orders review/);
    assert.match(view("all", [review, real]), /MIGHT NOT BE AN ORDER \(1\)[\s\S]*Soco ·/);
    assert.equal(selectOrders({ type: "review" }, [review, real], ctx).length, 1);
  });
  test("once staff confirm it (the flag is cleared) it is an ordinary order", () => {
    const confirmed = { ...review, status: "confirmed" as const, attention: null };
    assert.equal(bucketOf(confirmed, ctx), "tomorrow");
  });
});

describe("customer names", () => {
  test("staff-confirmed first (a correction is never overridden), then the saved contact, the WhatsApp profile name, the order's own name", () => {
    const all = { orderNameLocked: "Staff Fixed", savedName: "Saved Name", crmName: "Staff Typed", profileName: "Profile Name", orderName: "Order Name" };
    assert.deepEqual(pickCustomerName(all), { name: "Staff Fixed", source: "staff", all: ["Staff Fixed", "Staff Typed", "Saved Name", "Profile Name", "Order Name"] });
    assert.deepEqual([pickCustomerName({ ...all, orderNameLocked: null }).name, pickCustomerName({ ...all, orderNameLocked: null }).source], ["Staff Typed", "staff"]);
    assert.deepEqual([pickCustomerName({ ...all, orderNameLocked: null, crmName: null }).name, pickCustomerName({ ...all, orderNameLocked: null, crmName: null }).source], ["Saved Name", "saved"]);
    assert.equal(pickCustomerName({ profileName: "Profile Name", orderName: "Order Name" }).name, "Profile Name");
  });
  test("a name whose origin was not kept is never called a profile or saved name", () => {
    assert.equal(pickCustomerName({ orderName: "Maddie" }).source, "order");
    assert.equal(pickCustomerName({ profileName: "Maddie" }).source, "profile");
    assert.equal(pickCustomerName({ savedName: "Maddie" }).source, "saved");
  });
  test("unreliable values never win: numbers, JIDs and placeholders fall through, the phone is the fallback", () => {
    assert.equal(pickCustomerName({ savedName: "17585200082", profileName: "42924070961342@lid", orderName: "Unknown Contact" }).name, null);
    assert.equal(pickCustomerName({ savedName: "+1 758 520 0082", profileName: "Maddie" }).name, "Maddie", "an ambiguous contact (a number saved as the name) does not beat a real profile name");
  });
  test("the order detail shows no 'WhatsApp profile name' style source label", () => {
    const o = order({ customer_name: "Maddie" });
    const text = moreInfoReply({ order: o, name: pickCustomerName({ profileName: "Maddie" }), events: [], timezone: TZ });
    assert.ok(!/profile name|saved contact|entered by staff|Name:/i.test(text), text);
    assert.match(text, /Maddie/);
  });
  test("the day line shows the actual date only — no 'default' wording", () => {
    for (const requested_for of [null, "Thu 29 Oct (default)", "Thu 29 Oct (default, morning)", "Thu 29 Oct (tomorrow)"]) {
      const text = moreInfoReply({ order: order({ requested_for }), name: undefined, events: [], timezone: TZ });
      assert.ok(!/default|no day given/i.test(text.replace(/Method: [^\n]*/, "")), `${requested_for}: ${text}`);
      assert.match(text, /Day: \w{3} \d{1,2} \w{3}/);
    }
    assert.match(moreInfoReply({ order: order({ requested_for: "Thu 29 Oct (default, morning)" }), name: undefined, events: [], timezone: TZ }), /Day: Thu 29 Oct · morning/);
  });
});

describe("review of existing orders (read-only)", () => {
  const T = (iso: string) => iso;
  const line = (who: "Customer" | "Staff", text: string, at: string, id: string, extra: Partial<ReviewLine> = {}): ReviewLine => ({ who, text, at, id, ...extra });

  test("#KBNYW: staff said 'tomorrow' and the customer accepted: the order is suggested for Wed 28 Oct, with the messages as evidence", () => {
    const o = order({ id: "k", ref_code: "O-KBNYW", customer_name: "Maddie", status: "possible", requested_for: "Thu 29 Oct (default)", first_message_at: T("2026-10-27T14:59:25Z"), source_message_ids: ["ACF", "AC39"], items: [{ product: "This one", quantity: null, size: "55lbs", variant: null }] });
    const lines: ReviewLine[] = [
      line("Customer", "This one 55lbs", "2026-10-27T15:00:00Z", "AC39", { mediaKind: "image", mediaUrl: "http://h/media/x/a.jpg" }),
      line("Staff", "Yes we can deliver the dog food", "2026-10-27T15:01:05Z", "S1"),
      line("Staff", "Would you like us to put you down for tomorrow", "2026-10-27T15:01:20Z", "2A24C915"),
      line("Customer", "Yes sure", "2026-10-27T15:05:00Z", "ACDA", { quotedId: "2A24C915" }),
    ];
    const review = reviewOrder({ order: o, lines, timezone: TZ, readings: { AC39: { kind: "product", visibleText: ["Bandit", "25kg"], product: "Bandit", size: "25kg" } } });
    const day = review.findings.find((f) => f.kind === "delivery_day");
    assert.ok(day, "a delivery-day suggestion");
    assert.equal(day.suggested, "Wed 28 Oct");
    assert.equal(day.current, "Thu 29 Oct");
    assert.ok(day.evidence.some((e) => e.text.includes("put you down for tomorrow")));
    const pic = review.findings.find((f) => f.kind === "picture_unresolved");
    assert.ok(pic && /Bandit/.test(pic.summary) && pic.suggested === "Bandit 25kg");
    assert.ok(!review.findings.some((f) => f.kind === "might_not_be_order"), "staff offered delivery and the customer accepted: it is an order");
  });
  test("#JXBDS: an answer to an earlier question with nothing else around it is suggested for review, not changed", () => {
    const o = order({ ref_code: "O-JXBDS", status: "possible", source_message_ids: ["B"], items: [{ product: '3" tablests', quantity: "1", size: null, variant: null }, { product: "chlorine powder", quantity: "1", size: null, variant: null }] });
    const lines = [line("Customer", "Morning", "2026-10-27T13:11:00Z", "A"), line("Customer", 'It is 3" tablests  and chlorine powder- one pail each', "2026-10-27T13:13:41Z", "B")];
    const review = reviewOrder({ order: { ...o, first_message_at: "2026-10-27T13:13:41Z" }, lines, timezone: TZ });
    assert.deepEqual(review.findings.map((f) => f.kind), ["might_not_be_order"]);
  });
  test("an order staff edited, confirmed or already holds the right day gets no suggestion; nothing is ever written", () => {
    const lines = [line("Staff", "We will deliver tomorrow", "2026-10-28T13:30:00Z", "S")];
    assert.equal(reviewOrder({ order: order({ manual_locked_fields: ["requested_for"], requested_for: "Mon 26 Oct" }), lines, timezone: TZ }).findings.length, 0);
    assert.equal(reviewOrder({ order: order({ status: "confirmed", confirmed_at: "2026-10-28T13:10:00Z", requested_for: "Mon 26 Oct" }), lines, timezone: TZ }).findings.length, 0);
    assert.equal(reviewOrder({ order: order({ requested_for: "Thu 29 Oct" }), lines, timezone: TZ }).findings.length, 0, "tomorrow from the staff message IS Thu 29 Oct");
    const frozen = order({ requested_for: "Mon 26 Oct" });
    const before = JSON.stringify(frozen);
    reviewOrder({ order: frozen, lines, timezone: TZ });
    assert.equal(JSON.stringify(frozen), before, "the order object is untouched");
  });
});
