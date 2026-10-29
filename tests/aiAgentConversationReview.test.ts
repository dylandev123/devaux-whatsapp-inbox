// The read-only order review, extended for continuous order understanding: addresses, products and quantities the chat answered or
// corrected, and the retired generic staff warning. Pure: no database, no model. It only ever SUGGESTS; the order objects are untouched.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { reviewOrder, type ReviewLine } from "../lib/aiAgent/orderReview.ts";
import type { TrackedOrder } from "../lib/aiAgent/orders.ts";

const TZ = "America/St_Lucia";
const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => ({
  id: "o1",
  ref_code: "O-JOSH1",
  business_slug: "dog_food",
  chat_id: "17585550301@lid",
  contact_number: "17585550301",
  customer_name: "Josh",
  status: "awaiting_confirmation",
  items: [{ product: "dog food", quantity: "1", variant: null, size: null }],
  fulfilment_method: "delivery",
  delivery_preference: "delivery",
  delivery_address: null,
  requested_for: "Wed 28 Oct",
  notes: null,
  missing_fields: ["delivery_address"],
  attention: null,
  source_message_ids: ["C1"],
  first_message_at: "2026-10-27T14:00:00Z",
  last_message_at: "2026-10-27T14:00:00Z",
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
  created_at: "2026-10-27T14:00:00Z",
  updated_at: "2026-10-27T14:00:00Z",
  ...over,
});
const line = (who: "Customer" | "Staff", text: string, min: number, id: string, extra: Partial<ReviewLine> = {}): ReviewLine => ({
  who,
  text,
  at: new Date(Date.UTC(2026, 9, 27, 14, 0) + min * 60_000).toISOString(),
  id,
  ...extra,
});
const first = line("Customer", "I need a bag of dog food please", 0, "C1");
const kinds = (o: TrackedOrder, lines: ReviewLine[]) => reviewOrder({ order: o, lines: [first, ...lines], timezone: TZ }).findings.map((f) => f.kind);

describe("the review finds what the chat answered", () => {
  test("a missing address the customer gave later, with the question and the answer as evidence", () => {
    const r = reviewOrder({ order: order(), lines: [first, line("Staff", "Where should we deliver?", 3, "S1"), line("Customer", "Cap Estate", 4, "C2")], timezone: TZ });
    const f = r.findings.find((x) => x.kind === "address_answered")!;
    assert.equal(f.current, "No address");
    assert.equal(f.suggested, "Cap Estate");
    assert.deepEqual(f.evidence.map((e) => [e.who, e.text]), [["Staff", "Where should we deliver?"], ["Customer", "Cap Estate"]]);
  });

  test("a product staff named and the customer confirmed (Josh/Kyle)", () => {
    const r = reviewOrder({ order: order({ delivery_address: "Cap Estate" }), lines: [first, line("Staff", "Which bag did you want, Bandit 25kg?", 3, "S1"), line("Customer", "Yes, that one.", 4, "C2")], timezone: TZ });
    const f = r.findings.find((x) => x.kind === "product_confirmed")!;
    assert.equal(f.current, "1 × dog food");
    assert.equal(f.suggested, "1 × Bandit 25kg");
  });

  test("a quantity staff asked for and the customer gave", () => {
    const o = order({ delivery_address: "Cap Estate", items: [{ product: "Bandit", quantity: null, variant: null, size: "25kg" }] });
    const f = reviewOrder({ order: o, lines: [first, line("Staff", "How many bags?", 3, "S1"), line("Customer", "two", 4, "C2")], timezone: TZ }).findings.find((x) => x.kind === "quantity_answered")!;
    assert.match(f.current!, /quantity needed/);
    assert.equal(f.suggested, "2 × Bandit 25kg");
  });

  test("a quantity corrected in a follow-up the order was not built from, and one staff stated", () => {
    const o = order({ delivery_address: "Cap Estate" });
    const corrected = reviewOrder({ order: o, lines: [line("Customer", "make that 3 bags please", 10, "C9")], timezone: TZ }).findings.find((x) => x.kind === "quantity_corrected")!;
    assert.equal(corrected.suggested, "3 × dog food");
    const stated = reviewOrder({ order: o, lines: [line("Staff", "So that's 4 bags, we'll send them tomorrow", 11, "S9")], timezone: TZ }).findings.find((x) => x.kind === "quantity_corrected")!;
    assert.equal(stated.suggested, "4 × dog food");
    assert.match(stated.summary, /staff stated the quantity/);
  });

  test("the retired generic staff warning is explained when what staff wrote is plain", () => {
    const o = order({ delivery_address: "Cap Estate", attention: "staff_changed_in_chat", requested_for: "Wed 28 Oct" });
    const r = reviewOrder({ order: o, lines: [first, line("Staff", "We will deliver on Friday", 5, "S1")], timezone: TZ });
    const day = r.findings.find((f) => f.kind === "delivery_day")!;
    assert.match(day.suggested!, /Fri 30 Oct/);
    const warn = r.findings.find((f) => f.kind === "staff_warning_resolvable")!;
    assert.match(warn.summary, /Staff changed it|Staff wrote about changes/);
    assert.match(warn.summary, /delivery on Fri 30 Oct/);
  });
});

describe("what the review leaves alone", () => {
  test("an answer to nothing, an unanswered suggestion, and a yes to two products give no suggestion", () => {
    const o = order({ delivery_address: "Cap Estate" });
    assert.deepEqual(kinds(o, [line("Customer", "Cap Estate", 4, "C2")]), []);
    assert.deepEqual(kinds(o, [line("Staff", "Which bag did you want, Bandit 25kg?", 3, "S1")]), []);
    assert.deepEqual(kinds(o, [line("Staff", "Do you want the Bandit 25kg or the Monello Chicken 25kg?", 3, "S1"), line("Customer", "Yes", 4, "C2")]), []);
  });

  test("orders staff edited or confirmed, and a field staff locked, are never suggested for change", () => {
    const talk = [line("Staff", "Where should we deliver?", 3, "S1"), line("Customer", "Cap Estate", 4, "C2")];
    assert.deepEqual(kinds(order({ status: "confirmed", confirmed_at: "2026-10-27T15:00:00Z" }), talk), []);
    assert.deepEqual(kinds(order({ manual_locked_fields: ["delivery_address"] }), talk), []);
    assert.deepEqual(kinds(order({ status: "cancelled" }), talk), []);
  });

  test("an address the order already has, and a collection order, need no address", () => {
    const talk = [line("Staff", "Where should we deliver?", 3, "S1"), line("Customer", "Cap Estate", 4, "C2")];
    assert.deepEqual(kinds(order({ delivery_address: "Cap Estate" }), talk), []);
    assert.deepEqual(kinds(order({ fulfilment_method: "collection" }), talk), []);
  });

  test("reviewing never changes the order", () => {
    const o = order();
    const before = JSON.stringify(o);
    reviewOrder({ order: o, lines: [first, line("Staff", "Where should we deliver?", 3, "S1"), line("Customer", "Cap Estate", 4, "C2")], timezone: TZ });
    assert.equal(JSON.stringify(o), before);
  });
});
