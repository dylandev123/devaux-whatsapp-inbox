// Regression tests for the three real customer messages that went wrong in production (2–3 Nov 2026), plus the rules behind them:
// quantities vs package sizes, billing instructions, sender vs recipient, signed names, one message = one order, South deliveries,
// the Google Docs line layout and the freshness stamp on order reports. Pure logic, no database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrderRequestDraft } from "../lib/aiAgent/engine.ts";
import {
  billingInstruction,
  lineRecipientNotes,
  paymentNote,
  placedByText,
  readRecipientBlock,
  reconcileLineQuantities,
  signedName,
  withNoteSegment,
} from "../lib/aiAgent/orderLines.ts";
import { refineOrderDraft } from "../lib/aiAgent/orderText.ts";
import { mergeSameTurnDrafts, type TrackedOrder } from "../lib/aiAgent/orders.ts";
import { classifyDeliveryRegion, parseSouthLocationsText, regionConfigFrom, southGroupsMentioned, southLocationsToText } from "../lib/aiAgent/deliveryRegions.ts";
import { effectiveDate, isSouthPendingDay, keepDefaultedDay, southPendingDayText, withCreationDefaults } from "../lib/aiAgent/orderDefaults.ts";
import { defaultFormat, formatOrderLine, normalizeFormat, type LineOrder } from "../lib/aiAgent/gdocFormat.ts";
import { buildOrdersView, bucketOf, countOrders, dayContext, generatedStamp } from "../lib/aiAgent/orderViews.ts";
import { emptyFields } from "../lib/aiAgent/orders.ts";

// The three exact production messages.
const GARY_MESSAGE = "Please put on this morning‘s delivery list. \n\nTamara Amos\n+1 (758) 484-7702\n1 Bandit 25kg (damaged)\n$155 Paid in store\nDeliver to Rodney Heights, building behind Dog Food St. Lucia.";
const LOUISE_MESSAGE = "Hi Richard\nWhen are you next in Soufriere \nNeed\n2 large bags Birbo Chicken for St Remy\n\n1 small Birbo Chicken for Narural at St Remy\n\nThanks\n\nLouise";
const ACID_MESSAGE = "Need 2 case acid 10 lbs cal hypo bill to anthony macnamara";

const draftOf = (items: OrderRequestDraft["items"], over: Partial<OrderRequestDraft> = {}): OrderRequestDraft => ({ items, delivery_address: null, delivery_preference: null, notes: null, ...over });
const lines = (d: OrderRequestDraft) => d.items.map((i) => [i.product, i.quantity ?? null, i.size ?? null, i.variant ?? null]);

describe("quantity vs package size (O-CR4PG: 'Need 2 case acid 10 lbs cal hypo bill to anthony macnamara')", () => {
  // What the model returned in production: the 2 copied onto the cal hypo.
  const wrong = draftOf([
    { product: "acid", quantity: "2", size: "case" },
    { product: "cal hypo", quantity: "2", size: "10 lbs" },
  ]);

  test("2 cases of acid, ONE 10 lb cal hypo", () => {
    const fixed = reconcileLineQuantities(wrong, [ACID_MESSAGE]);
    assert.deepEqual(lines(fixed), [
      ["acid", "2", "case", null],
      ["cal hypo", "1", "10 lbs", null],
    ]);
  });

  test("the same result through the full refinement pass the order flow uses", () => {
    const fixed = refineOrderDraft(wrong, [ACID_MESSAGE], [ACID_MESSAGE]);
    assert.deepEqual(lines(fixed), [
      ["acid", "2", "case", null],
      ["cal hypo", "1", "10 lbs", null],
    ]);
  });

  test("a model that left the quantity and size off still gets the counted line and sizes; the uncounted one is left for staff to ask", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "acid", quantity: null }, { product: "cal hypo", quantity: null }]), [ACID_MESSAGE]);
    assert.deepEqual(lines(fixed), [
      ["acid", "2", "case", null],
      ["cal hypo", null, "10 lbs", null],
    ]);
  });

  test("'Bill to Anthony Macnamara' is a billing instruction, not a product or a customer", () => {
    assert.equal(billingInstruction([ACID_MESSAGE]), "Bill to Anthony Macnamara");
    assert.equal(billingInstruction(["Send 2 bags Bandit, invoice to the account of mr jones please"]), "Bill to Mr Jones");
    assert.equal(billingInstruction(["Send 2 bags Bandit and bill it to Dave on Friday"]), "Bill to Dave");
    assert.equal(billingInstruction(["Please send me the bill"]), null);
    assert.equal(billingInstruction(["bill to"]), null);
  });
});

describe("a number qualifies only the product it stands in front of", () => {
  test("two products, two counts, two weights", () => {
    const fixed = reconcileLineQuantities(
      draftOf([{ product: "Monello", quantity: "2", size: "25kg" }, { product: "Bandit", quantity: "2", size: "15kg" }]),
      ["Please send 2 bags of Monello 25kg and 1 bag of Bandit 15kg"]
    );
    assert.deepEqual(lines(fixed), [["Monello", "2", "25kg", null], ["Bandit", "1", "15kg", null]]);
  });

  test("a count written after the product ('Bandit 25kg x3')", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "Bandit", quantity: null }]), ["Bandit 25kg x3"]);
    assert.deepEqual(lines(fixed), [["Bandit", "3", "25kg", null]]);
  });

  test("the previous product's count is not carried to a product with no count of its own", () => {
    const fixed = reconcileLineQuantities(
      draftOf([{ product: "Bandit", quantity: "3", size: "25kg" }, { product: "Monello", quantity: "3", size: "15kg" }]),
      ["Need 3 bandit 25kg and monello 15kg"]
    );
    assert.deepEqual(lines(fixed), [["Bandit", "3", "25kg", null], ["Monello", "1", "15kg", null]]);
  });

  test("a word number and an article: 'a case of acid and two bags of salt'", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "acid", quantity: "2" }, { product: "salt", quantity: "2" }]), ["a case of acid and two bags of salt"]);
    assert.deepEqual(lines(fixed), [["acid", "1", "case", null], ["salt", "2", null, null]]);
  });

  test("a weight is never a quantity: '25kg Bandit' is one bag", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "Bandit", quantity: "25", size: "25kg" }]), ["Need Bandit 25kg"]);
    assert.deepEqual(lines(fixed), [["Bandit", "1", "25kg", null]]);
  });

  test("no count and no size stays unknown, so staff are asked (nothing is guessed)", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "birbo dogfood", quantity: null }]), ["need some birbo dogfood"]);
    assert.deepEqual(lines(fixed), [["birbo dogfood", null, null, null]]);
  });

  test("a number the sentence uses elsewhere is not guessed onto a product", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "Bandit", quantity: null, size: "25kg" }]), ["Bandit 25kg, 2 of them"]);
    assert.deepEqual(lines(fixed), [["Bandit", null, "25kg", null]]);
  });

  test("a number from an older message never overrules the model for a product not written in this turn", () => {
    const draft = draftOf([{ product: "Bandit", quantity: "3", size: "25kg" }]);
    assert.equal(reconcileLineQuantities(draft, ["make that 3"]), draft);
  });

  test("a phone number or a price is not a count", () => {
    const fixed = reconcileLineQuantities(draftOf([{ product: "Bandit", quantity: "7", size: "25kg" }]), ["Bandit 25kg\nCall 758 484 7702 $155 paid"]);
    assert.deepEqual(lines(fixed), [["Bandit", "7", "25kg", null]], "the numbers in the phone and the price are not claimed as counts; nothing here overrules the model");
  });
});

describe("O-G5LE3 / O-EKM84: one message with two product lines is ONE order", () => {
  const twoLines = draftOf(
    [{ product: "Birbo Chicken", quantity: "2", size: "large" }, { product: "Birbo Chicken", quantity: "1", size: "small" }],
    { delivery_address: "St Remy" }
  );

  test("each Birbo line keeps its own count and size", () => {
    const fixed = reconcileLineQuantities(twoLines, [LOUISE_MESSAGE]);
    assert.deepEqual(lines(fixed), [["Birbo Chicken", "2", "large", null], ["Birbo Chicken", "1", "small", null]]);
  });

  test("the model's two separate orders for it become one", () => {
    const merged = mergeSameTurnDrafts([
      { target: "new", draft: draftOf([{ product: "Birbo Chicken", quantity: "2", size: "large" }], { delivery_address: "St Remy", customer_name: "Louise" }) },
      { target: "new", draft: draftOf([{ product: "Birbo Chicken", quantity: "1", size: "small" }], { delivery_address: "St Remy", customer_name: "Louise" }) },
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(lines(merged[0].draft), [["Birbo Chicken", "2", "large", null], ["Birbo Chicken", "1", "small", null]]);
  });

  test("clearly different deliveries stay separate: another place, another day, another recipient, a named open order", () => {
    const base = (over: Partial<OrderRequestDraft>, target = "new") => ({ target, draft: draftOf([{ product: "Monello", quantity: "1" }], { delivery_address: "Cap Estate", requested_for: "Friday", ...over }) });
    assert.equal(mergeSameTurnDrafts([base({}), base({ delivery_address: "Vieux Fort" })]).length, 2);
    assert.equal(mergeSameTurnDrafts([base({}), base({ requested_for: "Saturday" })]).length, 2);
    assert.equal(mergeSameTurnDrafts([base({ customer_name: "Anna" }), base({ customer_name: "Marcus" })]).length, 2);
    assert.equal(mergeSameTurnDrafts([base({}), base({}, "O-ABCDE")]).length, 2);
  });

  test("'for Narural at St Remy' is kept as who that line is for", () => {
    assert.deepEqual(lineRecipientNotes(twoLines.items, [LOUISE_MESSAGE]), ["small Birbo Chicken for Narural"]);
  });

  test("the signature is the sender's own name; the greeting is not", () => {
    assert.equal(signedName(LOUISE_MESSAGE), "Louise");
    assert.equal(signedName("Hi Richard\nNeed 2 bags\nThanks"), null);
    assert.equal(signedName("Need 2 bags of Monello\nthanks Louise"), null, "not a sign-off line on its own");
    assert.equal(signedName("Please send one\nRegards\nAnna Joseph"), "Anna Joseph");
  });
});

describe("South deliveries are not daily", () => {
  const regions = regionConfigFrom(null);
  test("Dennery, Vieux Fort, Choiseul, Laborie, Soufrière and the existing Micoud are all south", () => {
    for (const [place, group] of [["Dennery", "Dennery"], ["Vieux Fort", "Vieux Fort"], ["Choiseul", "Choiseul"], ["Laborie", "Laborie"], ["Soufrière", "Soufrière"], ["Soufriere town", "Soufrière"], ["Micoud", "Micoud"]] as const) {
      assert.deepEqual(classifyDeliveryRegion(place, regions), { region: "south", group }, place);
    }
    assert.notEqual(classifyDeliveryRegion("Gros Islet", regions).region, "south");
  });

  test("'St Remy' alone is unknown, but the message that says Soufrière names the destination", () => {
    assert.equal(classifyDeliveryRegion("St Remy", regions).region, "unknown");
    assert.deepEqual(southGroupsMentioned([LOUISE_MESSAGE], regions), ["Soufrière"]);
    assert.deepEqual(classifyDeliveryRegion("St Remy, Soufrière", regions), { region: "south", group: "Soufrière" });
  });

  test("a south order gets NO automatic next-day date, even when it was written after 9 AM", () => {
    const afterNine = "2026-11-03T16:20:50Z"; // 12:20 PM St Lucia
    const fields = { ...emptyFields(), items: [{ product: "Birbo Chicken", quantity: "2", variant: null, size: "large" }], delivery_address: "St Remy, Soufrière", fulfilment_method: null };
    const created = withCreationDefaults(fields, afterNine, "America/St_Lucia", regions);
    assert.equal(created.fields.requested_for, "Date to be confirmed (south)");
    assert.equal(effectiveDate({ requested_for: created.fields.requested_for, first_message_at: afterNine }).source, "pending");
    assert.equal(effectiveDate({ requested_for: created.fields.requested_for, first_message_at: afterNine }).date, null);
    // The same order to a northern address still gets the business default.
    const north = withCreationDefaults({ ...fields, delivery_address: "Gros Islet" }, afterNine, "America/St_Lucia", regions);
    assert.match(north.fields.requested_for ?? "", /\(default\)$/);
  });

  test("'when are you next in Soufrière?' is not a delivery date; a real day is", () => {
    const at = "2026-11-03T16:20:50Z";
    const base = { ...emptyFields(), delivery_address: "Soufrière" };
    const asked = withCreationDefaults({ ...base, requested_for: "when next in Soufriere" }, at, "America/St_Lucia", regions);
    assert.ok(isSouthPendingDay(asked.fields.requested_for), asked.fields.requested_for ?? "");
    const stated = withCreationDefaults({ ...base, requested_for: "Thu 5 Nov (Thursday)" }, at, "America/St_Lucia", regions);
    assert.equal(stated.fields.requested_for, "Thu 5 Nov (Thursday)");
    assert.equal(effectiveDate({ requested_for: stated.fields.requested_for, first_message_at: at }).source, "stated");
  });

  test("a time of day ('morning') cannot turn 'date to be confirmed' into a day", () => {
    assert.equal(keepDefaultedDay(southPendingDayText(), "morning"), null);
    assert.equal(keepDefaultedDay(southPendingDayText(), null), null);
  });

  test("a collection to a south place is not a south delivery", () => {
    const created = withCreationDefaults({ ...emptyFields(), delivery_address: "Soufrière", fulfilment_method: "collection" }, "2026-11-03T16:20:50Z", "America/St_Lucia", regions);
    assert.match(created.fields.requested_for ?? "", /\(default\)$/);
  });

  test("the list is editable: text round-trips, a custom list wins, a broken one changes nothing", () => {
    const text = southLocationsToText(regions.south);
    const parsed = parseSouthLocationsText(text);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.locations.map((l) => l.group), regions.south.map((l) => l.group));
    const custom = parseSouthLocationsText("Soufrière: St Remy, Fond St Jacques\nGros Islet");
    assert.ok(custom.ok);
    const config = regionConfigFrom(custom.ok ? custom.locations : null);
    assert.deepEqual(classifyDeliveryRegion("St Remy", config), { region: "south", group: "Soufrière" });
    assert.deepEqual(classifyDeliveryRegion("Gros Islet", config), { region: "south", group: "Gros Islet" }, "a place the business adds can no longer be on the built-in 'not south' list");
    assert.equal(parseSouthLocationsText("   \n").ok, false);
    assert.equal(parseSouthLocationsText("Laborie: Laborie\nVieux Fort: Laborie").ok, false, "the same name twice is refused");
    assert.equal(regionConfigFrom([{ nope: true }]).south.length, regions.south.length);
  });
});

describe("O-MF9T2: sender vs recipient (Gary Devaux orders for Tamara Amos)", () => {
  test("a name line followed by a phone line is the person the order is for", () => {
    assert.deepEqual(readRecipientBlock([GARY_MESSAGE], "17587162997"), { name: "Tamara Amos", phone: "17584847702" });
  });

  test("the sender's own number, a greeting and a plain order are never a recipient", () => {
    assert.equal(readRecipientBlock(["Gary Devaux\n+1 (758) 716-2997\n1 Bandit 25kg"], "17587162997"), null);
    assert.equal(readRecipientBlock(["Hi Richard\n758 484 7702\nneed a bag of bandit"], "17587162997"), null);
    assert.equal(readRecipientBlock(["Need 2 bags of Monello 25kg\nDeliver to Cap Estate"], "17587162997"), null);
  });

  test("payment and the damaged qualifier are kept; the price is not lost", () => {
    assert.equal(paymentNote([GARY_MESSAGE]), "$155 Paid in store");
    const fixed = reconcileLineQuantities(draftOf([{ product: "Bandit", quantity: "1", size: "25kg" }], { notes: "damaged" }), [GARY_MESSAGE]);
    assert.deepEqual(lines(fixed), [["Bandit", "1", "25kg", "damaged"]]);
    assert.equal(fixed.notes, null, "'damaged' belongs to the product, so it is not repeated as a note");
  });

  test("the sender stays in the notes, readable and editable", () => {
    const notes = withNoteSegment(withNoteSegment(null, paymentNote([GARY_MESSAGE])!), placedByText("Gary Devaux", "17587162997"), "Placed by ");
    assert.equal(notes, "$155 Paid in store · Placed by Gary Devaux (+17587162997)");
    // A newer value for the same kind of segment replaces it; nothing else is lost.
    assert.equal(withNoteSegment(notes, placedByText("Dave Driver", "17585550001"), "Placed by "), "$155 Paid in store · Placed by Dave Driver (+17585550001)");
    assert.equal(placedByText(null, "17587162997"), "Placed by +17587162997");
  });
});

describe("Google Docs line: location first, South marked at the start", () => {
  const order = (over: Partial<LineOrder> = {}): LineOrder => ({
    ref_code: "O-MF9T2",
    customer_name: "Tamara Amos",
    contact_number: "17584847702",
    items: [{ product: "Bandit", quantity: "1", variant: "damaged", size: "25kg" }],
    fulfilment_method: "delivery",
    delivery_address: "Rodney Heights, building behind Dog Food St. Lucia",
    requested_for: "Mon 2 Nov (this morning)",
    notes: "$155 Paid in store · Placed by Gary Devaux (+17587162997)",
    status: "awaiting_confirmation",
    ...over,
  });

  test("the default order is LOCATION — NAME — PHONE — PRODUCTS — NOTES — DATE — REF", () => {
    const f = defaultFormat();
    assert.deepEqual(f.fields.filter((x) => x.enabled).map((x) => x.key), ["location", "name", "phone", "items", "notes", "date", "ref"]);
    assert.equal(
      formatOrderLine(order(), f).text,
      "Rodney Heights, building behind Dog Food St. Lucia — Tamara Amos — +1 (758) 484-7702 — 1 × Bandit (damaged, 25kg) — $155 Paid in store · Placed by Gary Devaux (+17587162997) — Mon 2 Nov (this morning) — #O-MF9T2"
    );
  });

  test("a South Delivery starts with SOUTH DELIVERY and shows a pending date plainly", () => {
    const south = formatOrderLine(
      order({ customer_name: "Tara", contact_number: "17587190614", delivery_address: "St Remy, Soufrière", requested_for: "Date to be confirmed (south)", items: [{ product: "Birbo Chicken", quantity: "2", variant: null, size: "large" }, { product: "Birbo Chicken", quantity: "1", variant: null, size: "small" }], notes: "Signed by Louise (WhatsApp name: Tara)" }),
      defaultFormat()
    ).text;
    assert.equal(
      south,
      "SOUTH DELIVERY — St Remy, Soufrière — Tara — +1 (758) 719-0614 — 2 × Birbo Chicken (large), 1 × Birbo Chicken (small) — Signed by Louise (WhatsApp name: Tara) — Date to be confirmed — #O-MF9T2"
    );
    // The destination is named when the address alone does not say it.
    assert.match(formatOrderLine(order({ delivery_address: "Hewanorra House" }), defaultFormat()).text, /^SOUTH DELIVERY \(Vieux Fort\) — Hewanorra House/);
    // Never for a northern address, a collection or no address.
    assert.doesNotMatch(formatOrderLine(order(), defaultFormat()).text, /SOUTH/);
    assert.doesNotMatch(formatOrderLine(order({ fulfilment_method: "collection", delivery_address: "Soufrière" }), defaultFormat()).text, /SOUTH/);
  });

  test("a saved configuration keeps its choices; only the untouched old default ORDER moves to location-first", () => {
    // Exactly what production holds: the old default order, date switched on, a " - " separator.
    const legacy = {
      fields: [
        { key: "name", enabled: true }, { key: "phone", enabled: true }, { key: "location", enabled: true }, { key: "items", enabled: true },
        { key: "notes", enabled: true }, { key: "date", enabled: true }, { key: "ref", enabled: false }, { key: "status", enabled: false },
      ],
      separator: " - ",
      placeholders: true,
    };
    const upgraded = normalizeFormat(legacy);
    assert.deepEqual(upgraded.fields.map((f) => f.key), ["location", "name", "phone", "items", "notes", "date", "ref", "status"]);
    assert.deepEqual(upgraded.fields.filter((f) => f.enabled).map((f) => f.key), ["location", "name", "phone", "items", "notes", "date"], "the administrator's 'reference off' is kept");
    assert.equal(upgraded.separator, " - ");
    // Re-saving the upgraded value changes nothing further.
    assert.deepEqual(normalizeFormat(upgraded), upgraded);
    // An order the administrator chose themselves is never rearranged.
    const custom = { ...legacy, fields: [legacy.fields[1], legacy.fields[0], ...legacy.fields.slice(2)] };
    assert.deepEqual(normalizeFormat(custom).fields.slice(0, 2).map((f) => f.key), ["phone", "name"]);
    // An administrator who deliberately saves the old order under the new layout keeps it.
    assert.deepEqual(normalizeFormat({ ...legacy, layout: 2 }).fields.slice(0, 3).map((f) => f.key), ["name", "phone", "location"]);
  });

  test("phone numbers read '+1 (758) 484-7702'; other lengths stay plain", () => {
    assert.match(formatOrderLine(order({ contact_number: "17584847702" }), defaultFormat()).text, /\+1 \(758\) 484-7702/);
    assert.match(formatOrderLine(order({ contact_number: "442071234567" }), defaultFormat()).text, /\+442071234567/);
  });
});

describe("order reports: South section, freshness stamp, Saint Lucia date", () => {
  const tz = "America/St_Lucia";
  const base = (over: Partial<TrackedOrder>): TrackedOrder => ({
    ...emptyFields(),
    id: over.ref_code ?? "x",
    ref_code: "O-AAAAA",
    business_slug: "cool_pool",
    chat_id: "c",
    contact_number: "17585550101",
    status: "awaiting_confirmation",
    missing_fields: [],
    attention: null,
    source_message_ids: [],
    first_message_at: "2026-11-03T16:20:50Z",
    last_message_at: "2026-11-03T16:20:50Z",
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
    created_at: "2026-11-03T16:21:00Z",
    updated_at: "2026-11-03T16:21:00Z",
    fulfilment_method: "delivery",
    items: [{ product: "Birbo Chicken", quantity: "2", variant: null, size: "large" }],
    ...over,
  });

  test("the stamp is the Saint Lucia clock, not UTC", () => {
    assert.equal(generatedStamp(new Date("2026-11-04T12:00:40Z"), tz), "🕗 Generated Wed 4 Nov, 8:00 AM");
    assert.equal(generatedStamp(new Date("2026-11-05T02:30:00Z"), tz), "🕗 Generated Wed 4 Nov, 10:30 PM", "02:30 UTC is still the 4th in Saint Lucia");
    assert.equal(generatedStamp(new Date("2026-11-04T16:05:00Z"), tz), "🕗 Generated Wed 4 Nov, 12:05 PM");
  });

  test("today, tomorrow and South Deliveries are separate; completed and cancelled orders are not listed", () => {
    const now = new Date("2026-11-04T12:00:40Z");
    const orders = [
      base({ id: "1", ref_code: "O-TODAY", requested_for: "Wed 4 Nov (today)", delivery_address: "Gros Islet" }),
      base({ id: "2", ref_code: "O-TOMOR", requested_for: "Thu 5 Nov (tomorrow)", delivery_address: "Cap Estate" }),
      base({ id: "3", ref_code: "O-SOUTH", requested_for: "Date to be confirmed (south)", delivery_address: "St Remy, Soufrière", customer_name: "Tara" }),
      base({ id: "4", ref_code: "O-DONE1", status: "fulfilled", requested_for: "Wed 4 Nov (today)", delivery_address: "Gros Islet" }),
      base({ id: "5", ref_code: "O-CANC1", status: "cancelled", requested_for: "Wed 4 Nov (today)", delivery_address: "Gros Islet" }),
    ];
    const text = buildOrdersView({ view: { type: "default" }, orders, now, timezone: tz }).parts.join("\n");
    assert.match(text, /ORDERS — Wed 4 Nov\*\n🕗 Generated Wed 4 Nov, 8:00 AM/);
    assert.match(text, /TODAY — Wed 4 Nov\* \(1\)/);
    assert.match(text, /TOMORROW — Thu 5 Nov\* \(1\)/);
    assert.match(text, /South Deliveries\* — date to be confirmed \(1\)\n\n📍 \*Soufrière\* \(1\)/);
    assert.match(text, /#TODAY/);
    assert.match(text, /#TOMOR/);
    assert.match(text, /#SOUTH/);
    assert.doesNotMatch(text, /#DONE1|#CANC1/);
    // A pending south order is never overdue, never "day not clear", and not missing a day.
    assert.doesNotMatch(text, /overdue|DAY NOT CLEAR|Missing: day/);
    const ctx = dayContext(now, tz);
    assert.equal(bucketOf(orders[2], ctx), "south");
    const counts = countOrders(orders, ctx);
    assert.deepEqual({ today: counts.today, tomorrow: counts.tomorrow, south: counts.south, overdue: counts.overdue, undated: counts.undated, missing: counts.missing }, { today: 1, tomorrow: 1, south: 1, overdue: 0, undated: 0, missing: 0 });
  });

  test("a south order stays 'to be confirmed' the next day instead of becoming overdue", () => {
    const orders = [base({ id: "3", ref_code: "O-SOUTH", requested_for: "Date to be confirmed (south)", delivery_address: "Soufrière" })];
    const text = buildOrdersView({ view: { type: "default" }, orders, now: new Date("2026-11-09T12:00:00Z"), timezone: tz }).parts.join("\n");
    assert.match(text, /date to be confirmed/);
    assert.doesNotMatch(text, /overdue/i);
  });

  test("the same view is used whoever asks: scheduled and manual differ only by the stamp's time", () => {
    const orders = [base({ id: "1", ref_code: "O-TODAY", requested_for: "Wed 4 Nov (today)", delivery_address: "Gros Islet" })];
    const at8 = buildOrdersView({ view: { type: "default" }, orders, now: new Date("2026-11-04T12:00:40Z"), timezone: tz }).parts[0];
    const at1 = buildOrdersView({ view: { type: "default" }, orders, now: new Date("2026-11-04T17:22:31Z"), timezone: tz }).parts[0];
    assert.equal(at8.replace(/Generated .*AM/, "Generated X"), at1.replace(/Generated .*PM/, "Generated X"));
  });
});
