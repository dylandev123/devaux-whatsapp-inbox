// Conversation understanding for orders: southern delivery regions, order intent (invoice talk vs real orders),
// delivery days committed by staff (and accepted offers) and the timezone boundaries they are resolved in. Pure rules.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyDeliveryRegion, configuredSouthLocations } from "../lib/aiAgent/deliveryRegions.ts";
import { classifyOrderIntent, type IntentInput } from "../lib/aiAgent/orderIntent.ts";
import { agreedDeliveryDate, isAffirmation, readStaffDeliveryDate, type ConversationLine } from "../lib/aiAgent/staffDelivery.ts";

const TZ = "America/St_Lucia"; // UTC-4, no daylight saving
const at = (iso: string) => new Date(iso);

describe("southern delivery regions", () => {
  test("a reviewed southern place is south, grouped by where it is going", () => {
    assert.deepEqual(classifyDeliveryRegion("Beanfield, Vieux Fort"), { region: "south", group: "Vieux Fort" });
    assert.deepEqual(classifyDeliveryRegion("near the Laborie bay"), { region: "south", group: "Laborie" });
    assert.deepEqual(classifyDeliveryRegion("Saltibus, Choiseul"), { region: "south", group: "Choiseul" });
    assert.deepEqual(classifyDeliveryRegion("Soufrière town"), { region: "south", group: "Soufrière" });
    assert.deepEqual(classifyDeliveryRegion("Soufriere"), { region: "south", group: "Soufrière" });
    assert.deepEqual(classifyDeliveryRegion("MON REPOS, micoud"), { region: "south", group: "Micoud" });
  });
  test("a missing address, an unknown street or a northern place is never south", () => {
    assert.deepEqual(classifyDeliveryRegion(null), { region: "unknown", reason: "no_address" });
    assert.deepEqual(classifyDeliveryRegion("  "), { region: "unknown", reason: "no_address" });
    assert.deepEqual(classifyDeliveryRegion("Rodney Bay, Gros Islet"), { region: "unknown", reason: "not_listed" });
    assert.deepEqual(classifyDeliveryRegion("2nd house after the school, main road"), { region: "unknown", reason: "not_listed" });
  });
  test("an address naming a southern and a non-southern place, or two districts, or an ambiguous name, is not guessed", () => {
    assert.deepEqual(classifyDeliveryRegion("Vieux Fort road, Castries"), { region: "unknown", reason: "conflicting" });
    assert.deepEqual(classifyDeliveryRegion("Laborie, near Vieux Fort"), { region: "unknown", reason: "conflicting" });
    assert.deepEqual(classifyDeliveryRegion("Belle Vue, Vieux Fort"), { region: "unknown", reason: "ambiguous" });
    assert.deepEqual(classifyDeliveryRegion("Beausejour, Micoud"), { region: "unknown", reason: "ambiguous" });
  });
  test("a place name inside a longer word is not a match", () => {
    assert.equal(classifyDeliveryRegion("Choiseulville").region, "unknown");
    assert.equal(classifyDeliveryRegion("Praslinesque Rd").region, "unknown");
  });
  test("correcting the address changes the group by itself (it is computed from the address every time)", () => {
    assert.deepEqual(classifyDeliveryRegion("Gros Islet"), { region: "unknown", reason: "not_listed" });
    assert.deepEqual(classifyDeliveryRegion("Laborie"), { region: "south", group: "Laborie" });
  });
  test("the table is configurable and a broken override cannot switch the safeguards off", () => {
    const custom = configuredSouthLocations('{"south":[{"group":"Dennery South","names":["Fond Assau"]}]}');
    assert.deepEqual(classifyDeliveryRegion("Fond Assau", custom), { region: "south", group: "Dennery South" });
    assert.equal(classifyDeliveryRegion("Laborie", custom).region, "unknown");
    const broken = configuredSouthLocations("{not json");
    assert.deepEqual(classifyDeliveryRegion("Laborie", broken), { region: "south", group: "Laborie" });
    assert.ok(configuredSouthLocations('{"south":"nope"}').ambiguous.length > 0);
  });
});

const intent = (over: Partial<IntentInput> = {}) =>
  classifyOrderIntent({ segments: [], recent: [], modelIntent: "order", items: [{ quantity: "1" }], hasAddress: false, hasDay: false, ...over });
const line = (who: "Customer" | "Staff", text: string, iso: string, extra: Partial<ConversationLine> = {}): ConversationLine => ({ who, text, at: iso, ...extra });

describe("order intent: what is an order and what is only talk", () => {
  test("an explicit request is an order", () => {
    for (const text of ["I need 2 bags of Monello 15kg", "Can you send me 3 bags of Bandit please", "pls deliver 1 bag of Pedigree tomorrow", "I'd like to order two Monello", "put me down for a bag of Monello"]) {
      assert.deepEqual(intent({ segments: [text] }), { kind: "confirmed", reason: "explicit_request" }, text);
    }
  });
  test("invoice, quotation and receipt talk is never an order, even with products and quantities in it", () => {
    for (const text of ["Can you send the invoice for the 3 inch tablets and chlorine powder", "Please send me a quotation for 2 pails of chlorine", "I paid the invoice for the 25kg bags", "What is the balance on my account for the 2 bags?"]) {
      assert.equal(intent({ segments: [text] }).kind, "non_order", text);
    }
  });
  test("price and availability questions are not orders", () => {
    assert.equal(intent({ segments: ["How much is the 15kg Monello?"], items: [{ quantity: null }] }).kind, "non_order");
    assert.equal(intent({ segments: ["Do you have Bandit 25kg in stock?"], items: [{ quantity: null }] }).kind, "non_order");
    assert.equal(intent({ segments: ["Which size is better for a lab?"], items: [{ quantity: null }] }).kind, "non_order");
  });
  test("a request that mentions an invoice as the thing to send is still not an order; one that orders goods beside it is", () => {
    assert.equal(intent({ segments: ["Please send the invoice for 3 pails"] }).kind, "non_order");
    assert.equal(intent({ segments: ["Please send 3 pails of chlorine and the invoice with the driver"] }).kind, "confirmed");
  });
  test("#JXBDS: an answer to an earlier question is not itself an order request, so it goes to review", () => {
    const verdict = intent({ segments: ['It is 3" tablests  and chlorine powder- one pail each'], recent: [line("Customer", "Morning", "2026-10-27T13:11:00Z")] });
    assert.deepEqual(verdict, { kind: "possible", reason: "clarification" });
  });
  test("products stated with quantities and an address or day are an order; bare quantities by an 'order' reading are too", () => {
    assert.equal(intent({ segments: ["2 bags Monello 15kg to Cap Estate"], hasAddress: true }).kind, "confirmed");
    assert.equal(intent({ segments: ["2 bags Monello 15kg Friday"], hasDay: true }).kind, "confirmed");
    assert.equal(intent({ segments: ["2 bags Monello 15kg"] }).kind, "confirmed");
  });
  test("a plain product mention the model read as an order stays an order; one it did not read as an order goes to review", () => {
    assert.equal(intent({ segments: ["This one 55lbs"], items: [{ quantity: null }] }).kind, "confirmed");
    assert.equal(intent({ segments: ["some Monello please"], items: [{ quantity: null }] }).kind, "confirmed");
    assert.equal(intent({ segments: ["Monello"], items: [{ quantity: null }], modelIntent: "other" }).kind, "possible");
    // "This one" with no readable photo names no product at all.
    assert.equal(intent({ segments: ["This one 55lbs"], items: [{ quantity: null, product: "This one" }] }).kind, "possible");
    assert.equal(intent({ segments: ["This one 55lbs"], items: [{ quantity: null, product: "Bandit" }] }).kind, "confirmed");
    assert.equal(intent({ segments: ["Monello"], items: [{ quantity: null }], modelIntent: null }).kind, "possible");
  });
  test("recent invoice talk makes an unclear follow-up a review item, but an explicit request still wins", () => {
    const recent = [line("Staff", "I will email the invoice now", "2026-10-27T13:00:00Z"), line("Customer", "ok thanks", "2026-10-27T13:01:00Z")];
    assert.deepEqual(intent({ segments: ["2 pails chlorine"], recent }), { kind: "possible", reason: "document_context" });
    assert.equal(intent({ segments: ["Please bring 2 pails of chlorine tomorrow"], recent }).kind, "confirmed");
  });
  test("a customer accepting a staff delivery offer is an order", () => {
    assert.deepEqual(intent({ segments: ["Yes sure"], items: [{ quantity: null }], staffAgreement: true }), { kind: "confirmed", reason: "staff_agreement" });
  });
});

describe("delivery days committed by staff", () => {
  const msg = "2026-10-27T15:01:00Z"; // Tue 27 Oct 11:01 in Saint Lucia
  test("an explicit staff commitment resolves from the message's own timestamp", () => {
    const r = readStaffDeliveryDate("We will deliver tomorrow morning", at(msg), TZ);
    assert.equal(r.kind, "commitment");
    assert.equal(r.date, "2026-10-28");
    assert.equal(r.label, "Wed 28 Oct");
  });
  test("'today' and weekdays resolve against the message, not against now", () => {
    assert.equal(readStaffDeliveryDate("Driver will bring it today", at(msg), TZ).date, "2026-10-27");
    assert.equal(readStaffDeliveryDate("We'll deliver on Friday", at(msg), TZ).date, "2026-10-30");
    assert.equal(readStaffDeliveryDate("Your order will be delivered Saturday", at(msg), TZ).date, "2026-10-31");
    assert.equal(readStaffDeliveryDate("Delivery is scheduled for 30 Oct", at(msg), TZ).date, "2026-10-30");
  });
  test("timezone boundaries: 'tomorrow' at 22:30 local is the next local day; at 00:30 UTC it is still the local evening", () => {
    // 2026-10-28T02:30Z = Tue 27 Oct 22:30 in Saint Lucia
    assert.equal(readStaffDeliveryDate("We will deliver tomorrow", at("2026-10-28T02:30:00Z"), TZ).date, "2026-10-28");
    // 2026-10-27T03:59Z = Mon 26 Oct 23:59 local; "today" is Monday
    assert.equal(readStaffDeliveryDate("We will deliver today", at("2026-10-27T03:59:00Z"), TZ).date, "2026-10-26");
    assert.equal(readStaffDeliveryDate("We will deliver today", at("2026-10-27T04:01:00Z"), TZ).date, "2026-10-27");
    // The same UTC instant is two different local days: UTC date arithmetic would be wrong here.
    assert.equal(readStaffDeliveryDate("We will deliver tomorrow", at("2026-10-27T04:01:00Z"), TZ).date, "2026-10-28");
  });
  test("questions, hedges and 'it'll have to be' are offers, never commitments", () => {
    assert.equal(readStaffDeliveryDate("Would you like us to put you down for tomorrow", at(msg), TZ).kind, "offer");
    assert.equal(readStaffDeliveryDate("Can we deliver Friday?", at(msg), TZ).kind, "offer");
    assert.equal(readStaffDeliveryDate("We might be able to deliver tomorrow", at(msg), TZ).kind, "offer");
    assert.equal(readStaffDeliveryDate("Hopefully we can deliver on Friday", at(msg), TZ).kind, "offer");
    assert.equal(readStaffDeliveryDate("It'll have to be tomorrow as our driver leaves at 9am every morning for deliveries", at(msg), TZ).kind, "offer");
  });
  test("refusals, policies, collections, past deliveries and unreadable days read as nothing", () => {
    for (const text of [
      "We can't deliver tomorrow",
      "No delivery on Friday",
      "We deliver every Friday",
      "Deliveries usually go out in the morning",
      "It will be ready for collection tomorrow",
      "We delivered today already",
      "We will deliver next Friday",
      "We will deliver tomorrow or Friday",
      "We will send the invoice tomorrow",
      "I'll email the quotation on Friday",
      "Thanks for your order",
    ]) {
      assert.equal(readStaffDeliveryDate(text, at(msg), TZ).kind, "none", text);
    }
  });
  test("a weekday written on that same weekday is not guessed", () => {
    assert.equal(readStaffDeliveryDate("We will deliver on Tuesday", at(msg), TZ).kind, "none");
  });
});

describe("a customer accepting a staff offer (#KBNYW)", () => {
  const offerAt = "2026-10-27T15:01:20Z"; // Tue 27 Oct 11:01 local
  const recent: ConversationLine[] = [
    line("Customer", "This one 55lbs", "2026-10-27T15:00:10Z"),
    line("Staff", "Yes we can deliver the dog food", "2026-10-27T15:01:05Z", { id: "A1" }),
    line("Staff", "It’ll have to be tomorrow as our driver leaves at 9am every morning for deliveries", "2026-10-27T15:01:10Z", { id: "A2" }),
    line("Staff", "Would you like us to put you down for tomorrow", offerAt, { id: "2A24C915" }),
  ];
  test("'Yes sure' agrees to tomorrow, counted from the staff message", () => {
    const agreed = agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent, quotedId: "2A24C915", timezone: TZ });
    assert.ok(agreed);
    assert.equal(agreed.date, "2026-10-28");
    assert.equal(agreed.basis, "offer_accepted");
    assert.equal(agreed.staffMessageId, "2A24C915");
  });
  test("works without the quote, when the offer is the last staff line and the customer said nothing else", () => {
    assert.equal(agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent, timezone: TZ })?.date, "2026-10-28");
  });
  test("the day is the day the OFFER meant, even when the yes arrives after midnight", () => {
    const agreed = agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-28T09:00:00Z", recent, quotedId: "2A24C915", timezone: TZ });
    assert.equal(agreed, null, "a yes more than 12 hours later is not tied to the offer");
    const late = agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-28T02:30:00Z", recent, quotedId: "2A24C915", timezone: TZ });
    assert.equal(late?.date, "2026-10-28", "11:30 PM local the same evening: still tomorrow as the staff meant it");
  });
  test("no agreement when the reply is not a bare yes, rejects the offer, answers something else or the offer has no day", () => {
    for (const reply of ["No thanks", "Friday is better", "Yes but make it Friday", "How much is it?", "Can you do Friday?"]) {
      assert.equal(agreedDeliveryDate({ segments: [reply], at: "2026-10-27T15:05:00Z", recent, quotedId: "2A24C915", timezone: TZ }), null, reply);
    }
    const noDay = [line("Staff", "Yes we can deliver the dog food", "2026-10-27T15:01:05Z", { id: "A1" })];
    assert.equal(agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent: noDay, timezone: TZ }), null);
  });
  test("a customer message after the offer that is not the quote breaks the link", () => {
    const interrupted = [...recent, line("Customer", "How much for the 25kg?", "2026-10-27T15:02:00Z")];
    assert.equal(agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent: interrupted, timezone: TZ }), null);
    assert.equal(agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent: interrupted, quotedId: "2A24C915", timezone: TZ })?.date, "2026-10-28", "…unless they quoted the offer itself");
  });
  test("an offer a customer rejected earlier is not resurrected by a later yes to something else", () => {
    const rejected = [
      line("Staff", "Would you like us to put you down for tomorrow", "2026-10-27T15:01:00Z", { id: "S1" }),
      line("Customer", "No, Friday please", "2026-10-27T15:02:00Z"),
      line("Staff", "Ok noted", "2026-10-27T15:03:00Z", { id: "S2" }),
    ];
    assert.equal(agreedDeliveryDate({ segments: ["Yes sure"], at: "2026-10-27T15:05:00Z", recent: rejected, timezone: TZ }), null);
  });
  test("what counts as accepting", () => {
    for (const t of ["Yes sure", "yes please", "Ok", "Okay thanks", "Sounds good", "👍", "That works"]) assert.ok(isAffirmation(t), t);
    for (const t of ["No", "Yes but later", "Maybe", "How much?"]) assert.ok(!isAffirmation(t), t);
  });
});
