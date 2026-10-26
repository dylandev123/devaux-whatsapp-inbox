// Customer order memory and incremental order maintenance — pure rules (no database). The end-to-end behaviour against the
// real SQL is in aiAgentOrderMemory.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptModelHistoryLine,
  detectHistoryCue,
  hasVerifiedAddress,
  type HistoryOrder,
  historyForModel,
  isReliableOrder,
  reliableHistory,
  resolveFromHistory,
  upgradeGenericLines,
  usualOrder,
} from "../lib/aiAgent/orderHistory.ts";
import { monitorPrefilter } from "../lib/aiAgent/orderMonitor.ts";
import { applyQuantityAdjustments, quantityAdjustments } from "../lib/aiAgent/orderText.ts";
import { mergeDraft, type OrderLine } from "../lib/aiAgent/orders.ts";

const line = (product: string, quantity: string | null = null, size: string | null = null, variant: string | null = null): OrderLine => ({ product, quantity, variant, size });
let n = 0;
const hist = (over: Partial<HistoryOrder> & { items: OrderLine[] }): HistoryOrder => {
  n += 1;
  return {
    id: `h${n}`,
    ref_code: `O-H${String(n).padStart(4, "0")}`,
    status: "fulfilled",
    fulfilment_method: "delivery",
    delivery_address: null,
    manual_locked_fields: [],
    last_message_at: `2026-10-${String(10 + n).padStart(2, "0")}T14:00:00Z`,
    ...over,
  };
};
const noCurrent = { current: null, draftItems: [] as OrderLine[], draftAddress: null };

describe("which earlier orders may be a source", () => {
  test("fulfilled, confirmed and staff-corrected orders count; enquiries, cancelled and empty ones never do", () => {
    const items = [line("Monello", "1")];
    assert.equal(isReliableOrder({ status: "fulfilled", items, manual_locked_fields: [] }), true);
    assert.equal(isReliableOrder({ status: "confirmed", items, manual_locked_fields: [] }), true);
    assert.equal(isReliableOrder({ status: "awaiting_confirmation", items, manual_locked_fields: ["items"] }), true, "a person corrected the products");
    assert.equal(isReliableOrder({ status: "awaiting_confirmation", items, manual_locked_fields: [] }), false);
    assert.equal(isReliableOrder({ status: "possible", items, manual_locked_fields: [] }), false);
    assert.equal(isReliableOrder({ status: "cancelled", items, manual_locked_fields: ["items"] }), false);
    assert.equal(isReliableOrder({ status: "fulfilled", items: [], manual_locked_fields: [] }), false);
  });
  test("an address is reusable only from a reliable delivery order (or one staff typed), never from collection", () => {
    assert.equal(hasVerifiedAddress(hist({ items: [line("A", "1")], delivery_address: "Cap Estate" })), true);
    assert.equal(hasVerifiedAddress(hist({ items: [line("A", "1")], delivery_address: "Cap Estate", status: "awaiting_confirmation" })), false);
    assert.equal(hasVerifiedAddress(hist({ items: [line("A", "1")], delivery_address: "Cap Estate", status: "awaiting_confirmation", manual_locked_fields: ["delivery_address"] })), true);
    assert.equal(hasVerifiedAddress(hist({ items: [line("A", "1")], delivery_address: "Shop", fulfilment_method: "collection" })), false);
  });
  test("the pool is newest first and leaves out the order being edited", () => {
    const a = hist({ items: [line("A", "1")] });
    const b = hist({ items: [line("B", "1")] });
    assert.deepEqual(reliableHistory([a, b]).map((o) => o.id), [b.id, a.id]);
    assert.deepEqual(reliableHistory([a, b], [b.id]).map((o) => o.id), [a.id]);
  });
});

describe("what the customer's words point back at", () => {
  test("last time, the usual, same location, somewhere else, this time", () => {
    assert.equal(detectHistoryCue(["Same as last time please"]).repeat, "last");
    assert.equal(detectHistoryCue(["same again"]).repeat, "last");
    assert.equal(detectHistoryCue(["the usual please"]).repeat, "usual");
    assert.equal(detectHistoryCue(["Same as usual, plus 4 pool salt"]).repeat, "usual");
    assert.equal(detectHistoryCue(["Same location"]).sameLocation, true);
    assert.equal(detectHistoryCue(["deliver it to the same place"]).sameLocation, true);
    assert.equal(detectHistoryCue(["Deliver somewhere else"]).elsewhere, true);
    assert.equal(detectHistoryCue(["Deliver somewhere else"]).sameLocation, false);
    const thisTime = detectHistoryCue(["Two bags this time"]);
    assert.deepEqual([thisTime.repeat, thisTime.thisTimeOnly], ["last", true]);
    assert.equal(detectHistoryCue(["same dog food as last time"]).product, "dog food");
  });
  test("ordinary orders and questions are not pointers", () => {
    for (const t of ["2 bags of Monello please", "what time do you open?", "I'll collect", "bring it to Cap"]) {
      const c = detectHistoryCue([t]);
      assert.deepEqual([c.repeat, c.sameLocation, c.elsewhere], [null, false, false], t);
    }
  });
});

describe("same as last time / the usual / same location", () => {
  const older = hist({ items: [line("Monello Chicken", "2", "25kg")], delivery_address: "Gros Islet" });
  const latest = hist({ items: [line("Bandit", "1", "15kg"), line("Monello Chicken", "1", "25kg")], delivery_address: "Cap Estate" });

  test("'same as last time' takes the most recent reliable order, products and quantities", () => {
    const fill = resolveFromHistory([older, latest], detectHistoryCue(["same as last time"]), ["same as last time"], noCurrent);
    assert.deepEqual(fill.items.map((l) => [l.product, l.quantity]), [["Bandit", "1"], ["Monello Chicken", "1"]]);
    assert.equal(fill.sources.items, latest.ref_code);
    assert.equal(fill.address, null, "an address is only reused when the customer says so");
    assert.deepEqual(fill.unresolved, []);
  });
  test("an unconfirmed enquiry is never the source: with only that, it stays unresolved", () => {
    const enquiry = hist({ status: "awaiting_confirmation", items: [line("Bandit", "9")] });
    const fill = resolveFromHistory([enquiry], detectHistoryCue(["same as last time"]), ["same as last time"], noCurrent);
    assert.deepEqual(fill.items, []);
    assert.equal(fill.unresolved.length, 1);
    // A reliable older order still wins over a newer enquiry.
    const fill2 = resolveFromHistory([older, enquiry], detectHistoryCue(["same as last time"]), ["same as last time"], noCurrent);
    assert.equal(fill2.sources.items, older.ref_code);
  });
  test("'two bags this time' reuses the one product of the last order with the new quantity; several products stay unresolved", () => {
    const single = hist({ items: [line("Monello Chicken", "1", "25kg")] });
    const fill = resolveFromHistory([single], detectHistoryCue(["Two bags this time"]), ["Two bags this time"], noCurrent);
    assert.deepEqual(fill.items.map((l) => [l.product, l.quantity, l.size]), [["Monello Chicken", "2", "25kg"]]);
    const fill2 = resolveFromHistory([latest], detectHistoryCue(["Two bags this time"]), ["Two bags this time"], noCurrent);
    assert.deepEqual(fill2.items, []);
    assert.equal(fill2.unresolved.length, 1);
  });
  test("what the customer already has on the order is never duplicated or overwritten", () => {
    const current = { id: "cur", items: [line("Bandit", "5", "15kg")], delivery_address: null, fulfilment_method: null };
    const fill = resolveFromHistory([latest], detectHistoryCue(["same as last time"]), ["same as last time"], { current, draftItems: current.items, draftAddress: null });
    assert.deepEqual(fill.items.map((l) => l.product), ["Monello Chicken"], "Bandit is already there with the customer's own quantity");
  });
  test("'same dog food as last time' narrows to the lines that match what was named; no match leaves it unresolved", () => {
    const mixed = hist({ items: [line("Monello Chicken Dog Food", "1"), line("Pool Salt", "4")] });
    const fill = resolveFromHistory([mixed], detectHistoryCue(["same dog food as last time"]), ["same dog food as last time"], noCurrent);
    assert.deepEqual(fill.items.map((l) => l.product), ["Monello Chicken Dog Food"]);
    const none = resolveFromHistory([mixed], detectHistoryCue(["same cat food as last time"]), ["same cat food as last time"], noCurrent);
    assert.deepEqual(none.items, []);
    assert.equal(none.unresolved.length, 1);
  });
  test("'same location' reuses the most recent verified address, once, and only when the order has none", () => {
    const fill = resolveFromHistory([older, latest], detectHistoryCue(["same location"]), ["same location"], noCurrent);
    assert.equal(fill.address, "Cap Estate");
    assert.equal(fill.setDelivery, true);
    assert.equal(fill.sources.delivery_address, latest.ref_code);
    const has = resolveFromHistory([older, latest], detectHistoryCue(["same location"]), ["same location"], { ...noCurrent, draftAddress: "Rodney Bay" });
    assert.equal(has.address, null, "the customer's explicit address wins");
    const none = resolveFromHistory([hist({ items: [line("A", "1")], delivery_address: null })], detectHistoryCue(["same location"]), ["same location"], noCurrent);
    assert.equal(none.address, null);
    assert.equal(none.unresolved.length, 1);
  });
  test("'deliver somewhere else' reuses nothing and clears an address the order holds", () => {
    const cur = { id: "cur", items: [], delivery_address: "Cap Estate", fulfilment_method: "delivery" };
    const fill = resolveFromHistory([latest], detectHistoryCue(["Deliver somewhere else"]), ["Deliver somewhere else"], { current: cur, draftItems: [], draftAddress: "Cap Estate" });
    assert.equal(fill.address, null);
    assert.equal(fill.clearAddress, true);
  });
});

describe("the usual order", () => {
  test("the basket that repeats most, with a strict lead, is the usual", () => {
    const a = () => hist({ items: [line("Monello Chicken", "2", "25kg")] });
    const pool = reliableHistory([a(), a(), hist({ items: [line("Bandit", "1")] })]);
    const usual = usualOrder(pool);
    assert.deepEqual(usual?.lines.map((l) => [l.product, l.quantity]), [["Monello Chicken", "2"]]);
  });
  test("a tie, or one-off orders, give no usual order", () => {
    const x = () => hist({ items: [line("Monello Chicken", "2")] });
    const y = () => hist({ items: [line("Bandit", "1")] });
    assert.equal(usualOrder(reliableHistory([x(), x(), y(), y()])), null);
    assert.equal(usualOrder(reliableHistory([x(), y()])), null);
  });
  test("the same products with varying quantities keep the products and leave the quantity unknown", () => {
    const pool = reliableHistory([hist({ items: [line("Monello Chicken", "2")] }), hist({ items: [line("Monello Chicken", "3")] })]);
    assert.deepEqual(usualOrder(pool)?.lines.map((l) => [l.product, l.quantity]), [["Monello Chicken", null]]);
  });
  test("'same as usual, plus 4 pool salt' fills the usual lines and leaves the customer's own line alone", () => {
    const a = () => hist({ items: [line("Monello Chicken", "2", "25kg")] });
    const fill = resolveFromHistory([a(), a()], detectHistoryCue(["Same as usual, plus 4 pool salt"]), ["Same as usual, plus 4 pool salt"], { ...noCurrent, draftItems: [line("Pool Salt", "4")] });
    assert.deepEqual(fill.items.map((l) => [l.product, l.quantity]), [["Monello Chicken", "2"]]);
  });
  test("an unclear usual order is unresolved, not guessed", () => {
    const fill = resolveFromHistory([hist({ items: [line("A", "1")] }), hist({ items: [line("B", "1")] })], detectHistoryCue(["the usual"]), ["the usual"], noCurrent);
    assert.deepEqual(fill.items, []);
    assert.equal(fill.unresolved.length, 1);
  });
});

describe("generic product names", () => {
  const monello = () => hist({ items: [line("Monello Chicken", "1", "25kg")] });
  test("every word the customer wrote fits exactly one history product: it becomes that product, size included", () => {
    const pool = reliableHistory([monello(), hist({ items: [line("Pool Salt", "4")] })]);
    const { lines, sources } = upgradeGenericLines([line("Monello", "1")], pool, []);
    assert.deepEqual(lines.map((l) => [l.product, l.quantity, l.size]), [["Monello Chicken", "1", "25kg"]]);
    assert.equal(sources.length, 1);
  });
  test("several products fit without a clear favourite: left exactly as the customer wrote it", () => {
    const pool = reliableHistory([hist({ items: [line("Monello Chicken", "1", "25kg")] }), hist({ items: [line("Monello Beef", "1", "15kg")] })]);
    assert.deepEqual(upgradeGenericLines([line("Monello", "1")], pool, []).lines, [line("Monello", "1")]);
  });
  test("a clear favourite (seen at least twice and three times as often) is used", () => {
    const pool = reliableHistory([monello(), monello(), monello(), hist({ items: [line("Monello Beef", "1", "15kg")] })]);
    assert.equal(upgradeGenericLines([line("Monello", "1")], pool, []).lines[0].product, "Monello Chicken");
  });
  test("lines with their own variant or size, or already on the order, are never changed", () => {
    const pool = reliableHistory([monello()]);
    assert.deepEqual(upgradeGenericLines([line("Monello", "1", "15kg")], pool, []).lines, [line("Monello", "1", "15kg")]);
    assert.deepEqual(upgradeGenericLines([line("Monello", "1")], pool, [line("Monello", "2", "15kg")]).lines, [line("Monello", "1")]);
  });
  test("a model nomination is accepted only for a product that really is in the cited order and clearly dominates", () => {
    const a = monello();
    const b = monello();
    const bandit = hist({ items: [line("Bandit", "1", "15kg")] });
    const pool = reliableHistory([a, b, monello(), bandit]);
    const ok = acceptModelHistoryLine({ product: "Monello Chicken", size: "25kg", from_history: a.ref_code.toLowerCase() }, pool);
    assert.equal(ok?.line.product, "Monello Chicken");
    assert.equal(ok?.line.quantity, null, "the quantity is never taken from history here");
    assert.equal(acceptModelHistoryLine({ product: "Monello Chicken", from_history: "O-NOPE1" }, pool), null, "an invented reference");
    assert.equal(acceptModelHistoryLine({ product: "Bandit", from_history: bandit.ref_code }, pool), null, "a product that is not the clear favourite");
    assert.equal(acceptModelHistoryLine({ product: "Invented Kibble", from_history: a.ref_code }, pool), null, "a product the cited order does not hold");
  });
});

describe("monitoring still reads these messages", () => {
  test("wording that points back at an earlier order is analysed even when no order is open, and a plain greeting is not", () => {
    for (const t of ["Same as last time", "the usual please", "Deliver to the same place", "Two bags this time", "Deliver somewhere else"]) {
      assert.equal(monitorPrefilter({ author: "customer", segments: [t], hasMedia: false, openOrders: 0 }).action, "analyse", t);
    }
    assert.equal(monitorPrefilter({ author: "customer", segments: ["good morning"], hasMedia: false, openOrders: 0 }).action, "skip");
  });
});

describe("what the model is shown", () => {
  test("nothing without reliable history; otherwise a bounded, compact view", () => {
    assert.equal(historyForModel([hist({ status: "possible", items: [line("A", "1")] })]), null);
    const many = Array.from({ length: 12 }, (_, i) => hist({ items: [line(`Product ${i % 3}`, "1")], delivery_address: `Place ${i}` }));
    const view = historyForModel(many) as { recent_orders: unknown[]; most_repeated_products: unknown[]; delivery_addresses: unknown[] };
    assert.equal(view.recent_orders.length, 3);
    assert.ok(view.most_repeated_products.length <= 5);
    assert.ok(view.delivery_addresses.length <= 3);
    assert.ok(JSON.stringify(view).length < 1500);
  });
});

describe("quantity changes the words give", () => {
  const prior = [{ product: "Monello Chicken", quantity: "2", size: "25kg" }];
  const draftOf = (items: { product: string; quantity: string | null }[]) => ({ items, delivery_address: null, delivery_preference: null, notes: null });

  test("parsing", () => {
    assert.deepEqual(quantityAdjustments(["Another bag"]).map((a) => [a.kind, a.n]), [["more", 1]]);
    assert.deepEqual(quantityAdjustments(["2 more bags please"]).map((a) => [a.kind, a.n]), [["more", 2]]);
    assert.deepEqual(quantityAdjustments(["one more"]).map((a) => [a.kind, a.n]), [["more", 1]]);
    assert.deepEqual(quantityAdjustments(["make that 3"]).map((a) => [a.kind, a.n]), [["set", 3]]);
    assert.deepEqual(quantityAdjustments(["a bag of Monello", "add 4 pool salt"]), []);
  });
  test("'another bag' adds one to the only line, whatever number the model guessed", () => {
    const out = applyQuantityAdjustments(prior, draftOf([{ product: "Monello Chicken", quantity: "2" }]), ["Another bag"]);
    assert.equal(out.items[0].quantity, "3");
    const guessed = applyQuantityAdjustments(prior, draftOf([{ product: "Monello Chicken", quantity: "7" }]), ["Another bag"]);
    assert.equal(guessed.items[0].quantity, "3", "the grounded base plus one, not the model's number");
  });
  test("with several lines it needs a named product; otherwise nothing changes", () => {
    const two = [...prior, { product: "Bandit", quantity: "1", size: "15kg" }];
    const d = draftOf([{ product: "Monello Chicken", quantity: "2" }, { product: "Bandit", quantity: "1" }]);
    assert.deepEqual(applyQuantityAdjustments(two, d, ["another bag"]).items.map((i) => i.quantity), ["2", "1"]);
    assert.deepEqual(applyQuantityAdjustments(two, d, ["another bag of Bandit"]).items.map((i) => i.quantity), ["2", "2"]);
  });
  test("an unknown starting quantity is not guessed", () => {
    const out = applyQuantityAdjustments([{ product: "Monello", quantity: null }], draftOf([{ product: "Monello", quantity: null }]), ["another bag"]);
    assert.equal(out.items[0].quantity, null);
  });
  test("'make that 3' sets the single line; two increments in one turn add up", () => {
    assert.equal(applyQuantityAdjustments(prior, draftOf([{ product: "Monello Chicken", quantity: "2" }]), ["make that 3"]).items[0].quantity, "3");
    assert.equal(applyQuantityAdjustments(prior, draftOf([{ product: "Monello Chicken", quantity: "2" }]), ["another bag", "and 2 more"]).items[0].quantity, "5");
  });
  test("'another bag of X' for a product not on the order adds it with quantity 1", () => {
    const out = applyQuantityAdjustments(prior, draftOf([{ product: "Monello Chicken", quantity: "2" }, { product: "Bandit", quantity: null }]), ["another bag of Bandit"]);
    assert.deepEqual(out.items.map((i) => [i.product, i.quantity]), [["Monello Chicken", "2"], ["Bandit", "1"]]);
  });
});

describe("staff locks: additions merge, contradictions are recorded", () => {
  const base = {
    customer_name: null,
    items: [line("Monello Chicken", "3", "25kg")],
    fulfilment_method: null,
    delivery_preference: null,
    delivery_address: null,
    requested_for: null,
    notes: null,
  };
  const draftOf = (items: OrderLine[]) => ({ items: items.map((i) => ({ product: i.product, quantity: i.quantity, ...(i.size ? { size: i.size } : {}) })), delivery_address: null, delivery_preference: null, notes: null });
  const stated = () => true;

  test("a new product is added even though the products are locked, and is not a conflict", () => {
    const m = mergeDraft(base, draftOf([line("Monello Chicken", "3", "25kg"), line("Pool Salt", "4")]), ["items"], null, stated);
    assert.deepEqual(m.fields.items.map((i) => [i.product, i.quantity]), [["Monello Chicken", "3"], ["Pool Salt", "4"]]);
    assert.deepEqual(m.conflicts, []);
    assert.equal(m.changes.length, 1);
  });
  test("a detail staff left blank is filled; the staff quantity is untouched", () => {
    const blank = { ...base, items: [line("Monello Chicken", null, "25kg")] };
    const m = mergeDraft(blank, draftOf([line("Monello Chicken", "2", "25kg")]), ["items"], null, stated);
    assert.equal(m.fields.items[0].quantity, "2");
    assert.deepEqual(m.conflicts, []);
  });
  test("a different quantity for a staff-locked product is a conflict and the staff value stays", () => {
    const m = mergeDraft(base, draftOf([line("Monello Chicken", "5", "25kg")]), ["items"], null, stated);
    assert.equal(m.fields.items[0].quantity, "3");
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0].field, "items");
    assert.equal(m.changes.length, 0);
  });
  test("a quantity the customer did not restate this turn is not a conflict (the draft repeats older words)", () => {
    const m = mergeDraft(base, draftOf([line("Monello Chicken", "5", "25kg")]), ["items"], null, () => false);
    assert.deepEqual(m.conflicts, []);
  });
  test("an addition plus a contradiction: the addition applies, the contradiction is recorded", () => {
    const m = mergeDraft(base, draftOf([line("Monello Chicken", "5", "25kg"), line("Pool Salt", "4")]), ["items"], null, stated);
    assert.deepEqual(m.fields.items.map((i) => [i.product, i.quantity]), [["Monello Chicken", "3"], ["Pool Salt", "4"]]);
    assert.equal(m.conflicts.length, 1);
  });
  test("withdrawing a staff-locked product is recorded for review, not applied", () => {
    const two = { ...base, items: [line("Monello Chicken", "3", "25kg"), line("Bandit", "1")] };
    const m = mergeDraft(two, draftOf([line("Monello Chicken", "3", "25kg")]), ["items"], null, () => false);
    assert.equal(m.fields.items.length, 2);
    assert.equal(m.conflicts.length, 1);
  });
  test("other locked fields still contradict as before, and unlocked items still replace as a whole", () => {
    const m = mergeDraft({ ...base, delivery_address: "Cap Estate" }, { ...draftOf(base.items), delivery_address: "Rodney Bay" }, ["delivery_address"], null, stated);
    assert.equal(m.fields.delivery_address, "Cap Estate");
    assert.equal(m.conflicts[0].field, "delivery_address");
    const free = mergeDraft(base, draftOf([line("Monello Chicken", "5", "25kg")]), [], null, stated);
    assert.equal(free.fields.items[0].quantity, "5");
  });
});
