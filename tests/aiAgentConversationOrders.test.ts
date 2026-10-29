// Continuous order understanding — the pure rules (lib/aiAgent/orderConversation.ts). No database, no model.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  candidatesIn,
  isGenericProduct,
  isProductAffirmation,
  latestConfirmedProduct,
  readAddressAnswer,
  readBareQuantity,
  readStaffAsks,
  readStaffQuantity,
  resolveConversationAnswer,
  resolveGenericProduct,
  staffStatesCommitment,
} from "../lib/aiAgent/orderConversation.ts";
import { type HistoryOrder, reliableHistory } from "../lib/aiAgent/orderHistory.ts";
import type { OrderLine } from "../lib/aiAgent/orders.ts";
import type { ConversationLine } from "../lib/aiAgent/staffDelivery.ts";

const line = (product: string, size: string | null = null, variant: string | null = null): OrderLine => ({ product, quantity: null, variant, size });
const BANDIT = line("Bandit", "25kg");
const MONELLO = line("Monello", "25kg", "Chicken");
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 14, 0) + min * 60_000).toISOString();
const staff = (text: string, min: number, id: string | null = null): ConversationLine => ({ who: "Staff", text, at: at(min), id });
const customer = (text: string, min: number, id: string | null = null, quotedId: string | null = null): ConversationLine => ({ who: "Customer", text, at: at(min), id, quotedId });
const history = (ref: string, items: OrderLine[], over: Partial<HistoryOrder> = {}): HistoryOrder => ({
  id: `id-${ref}`,
  ref_code: ref,
  status: "fulfilled",
  items: items.map((i) => ({ ...i, quantity: i.quantity ?? "1" })),
  fulfilment_method: "delivery",
  delivery_address: "Cap Estate",
  manual_locked_fields: [],
  last_message_at: at(-60 * 24),
  ...over,
});

describe("what staff asked", () => {
  test("a product question names the candidate it offers", () => {
    const asks = readStaffAsks("Which bag did you want, Bandit 25kg?");
    assert.deepEqual(asks.map((a) => a.kind), ["product"]);
    assert.equal((asks[0] as { candidates: OrderLine[] }).candidates[0].product, "Bandit");
    assert.equal((asks[0] as { candidates: OrderLine[] }).candidates[0].size, "25kg");
  });
  test("known products are recognised from the customer's own history, case-insensitively", () => {
    const found = candidatesIn("did you want the bandit 25kg or the monello chicken 25kg?", [BANDIT, MONELLO]);
    assert.deepEqual(found.map((c) => c.product).sort(), ["Bandit", "Monello"]);
  });
  test("a less precise history name gives way to the specific one staff typed", () => {
    const found = candidatesIn("Do you want the Bandit 25kg?", [line("Bandit")]);
    assert.equal(found.length, 1);
    assert.equal(found[0].size, "25kg");
  });
  test("address and quantity questions", () => {
    assert.deepEqual(readStaffAsks("Where should we deliver it?").map((a) => a.kind), ["address"]);
    assert.deepEqual(readStaffAsks("What's your delivery address?").map((a) => a.kind), ["address"]);
    assert.deepEqual(readStaffAsks("How many bags would you like?").map((a) => a.kind), ["quantity"]);
    assert.deepEqual(readStaffAsks("How many bags? And where to?").map((a) => a.kind).sort(), ["address", "quantity"]);
  });
  test("statements and policy are not questions", () => {
    assert.deepEqual(readStaffAsks("We deliver to Gros Islet on Fridays."), []);
    assert.deepEqual(readStaffAsks("Bandit 25kg is $190."), []);
    assert.deepEqual(readStaffAsks("Thanks, noted"), []);
  });
});

describe("a customer answering a staff question", () => {
  const ask = (text: string, others: ConversationLine[] = []) => [...others, staff(text, 0, "S1")];

  test("Josh/Kyle: staff name the bag, the customer says yes: Bandit 25kg is the confirmed product", () => {
    const r = resolveConversationAnswer({ segments: ["Yes, that one."], at: at(2), recent: ask("Which bag did you want, Bandit 25kg?"), known: [] });
    assert.equal(r?.status, "answer");
    if (r?.status !== "answer" || r.answer.kind !== "product") throw new Error("expected a product answer");
    assert.equal(r.answer.line.product, "Bandit");
    assert.equal(r.answer.line.size, "25kg");
    assert.equal(r.answer.staff.id, "S1");
    assert.match(r.answer.staff.text, /Which bag did you want/);
  });
  test("an unanswered staff suggestion is not a confirmation", () => {
    assert.equal(resolveConversationAnswer({ segments: ["Thanks"], at: at(2), recent: ask("Which bag did you want, Bandit 25kg?"), known: [] }), null);
    assert.equal(latestConfirmedProduct(ask("Which bag did you want, Bandit 25kg?"), []), null);
  });
  test("a customer message in between breaks the link unless the reply quotes the question", () => {
    const recent = [staff("Which bag did you want, Bandit 25kg?", 0, "S1"), customer("Also do you have leash", 1)];
    assert.equal(resolveConversationAnswer({ segments: ["Yes that one"], at: at(3), recent, known: [] }), null);
    const quoted = resolveConversationAnswer({ segments: ["Yes that one"], at: at(3), recent, quotedId: "S1", known: [] });
    assert.equal(quoted?.status, "answer");
  });
  test("a no, a change of mind or a question is not a yes", () => {
    for (const text of ["No, the other one", "Yes but make it Monello", "Is it the 25kg?", "Not that one"]) {
      assert.equal(resolveConversationAnswer({ segments: [text], at: at(2), recent: ask("Which bag did you want, Bandit 25kg?"), known: [] }), null, text);
    }
  });
  test("a bare yes to two offered products picks neither", () => {
    const r = resolveConversationAnswer({ segments: ["Yes"], at: at(2), recent: ask("Bandit 25kg or Monello Chicken 25kg?"), known: [BANDIT, MONELLO] });
    assert.equal(r?.status, "ambiguous");
  });
  test("naming one of the offered products picks it", () => {
    const r = resolveConversationAnswer({ segments: ["the monello one"], at: at(2), recent: ask("Bandit 25kg or Monello Chicken 25kg?"), known: [BANDIT, MONELLO] });
    assert.equal(r?.status, "answer");
    if (r?.status === "answer" && r.answer.kind === "product") assert.equal(r.answer.line.product, "Monello");
  });
  test("a weak ok confirms only a yes/no question that names one product", () => {
    assert.equal(resolveConversationAnswer({ segments: ["ok"], at: at(2), recent: ask("Do you want the Bandit 25kg?"), known: [] })?.status, "answer");
    assert.equal(resolveConversationAnswer({ segments: ["ok"], at: at(2), recent: ask("Which bag did you want, Bandit 25kg?"), known: [] })?.status, "answer", "a single named candidate with a question mark");
    assert.equal(resolveConversationAnswer({ segments: ["ok"], at: at(2), recent: ask("We also have Bandit 25kg in stock"), known: [] }), null, "an offer that asks nothing");
    assert.equal(resolveConversationAnswer({ segments: ["ok"], at: at(2), recent: ask("Which bag did you want?"), known: [] }), null, "no candidate named");
  });
  test("the question must be recent", () => {
    assert.equal(resolveConversationAnswer({ segments: ["Yes that one"], at: at(60 * 20), recent: ask("Which bag did you want, Bandit 25kg?"), known: [] }), null);
  });

  test("a staff question for the address and a place in reply", () => {
    const r = resolveConversationAnswer({ segments: ["Cap Estate"], at: at(2), recent: ask("Where should we deliver?"), known: [] });
    assert.equal(r?.status === "answer" && r.answer.kind === "address" && r.answer.address, "Cap Estate");
    const polite = resolveConversationAnswer({ segments: ["It's at Rodney Bay, near the marina"], at: at(2), recent: ask("What's your delivery address?"), known: [] });
    assert.equal(polite?.status === "answer" && polite.answer.kind === "address" && polite.answer.address, "Rodney Bay, near the marina");
  });
  test("a reply that is not a place is not an address", () => {
    for (const text of ["Tomorrow", "Yes", "Thanks", "I'll collect", "Can you do Friday?", "2 bags", "Bandit 25kg", "07", "No"]) {
      const r = resolveConversationAnswer({ segments: [text], at: at(2), recent: ask("Where should we deliver?"), known: [BANDIT] });
      assert.ok(!(r?.status === "answer" && r.answer.kind === "address"), text);
    }
  });
  test("a quantity question and the number in reply", () => {
    for (const [text, qty] of [["two", "2"], ["2", "2"], ["Just one", "1"], ["3 bags please", "3"], ["I'll take 4", "4"]] as const) {
      const r = resolveConversationAnswer({ segments: [text], at: at(2), recent: ask("How many bags?"), known: [] });
      assert.equal(r?.status === "answer" && r.answer.kind === "quantity" && r.answer.quantity, qty, text);
    }
    assert.equal(resolveConversationAnswer({ segments: ["Bandit please"], at: at(2), recent: ask("How many bags?"), known: [] }), null);
  });
  test("with two questions in one staff run each reply answers the one it fits", () => {
    const recent = [staff("Hi Josh", 0), staff("How many bags? And where to?", 1, "S2")];
    const place = resolveConversationAnswer({ segments: ["Cap Estate"], at: at(3), recent, known: [] });
    const number = resolveConversationAnswer({ segments: ["two"], at: at(3), recent, known: [] });
    assert.equal(place?.status === "answer" && place.answer.kind, "address");
    assert.equal(number?.status === "answer" && number.answer.kind, "quantity");
  });
  test("nothing is answered when staff asked nothing", () => {
    assert.equal(resolveConversationAnswer({ segments: ["Cap Estate"], at: at(2), recent: [staff("Thanks for your order", 0)], known: [] }), null);
    assert.equal(resolveConversationAnswer({ segments: ["Cap Estate"], at: at(2), recent: [], known: [] }), null);
  });
  test("small parsers", () => {
    assert.equal(readBareQuantity("two bags"), "2");
    assert.equal(readBareQuantity("0"), null);
    assert.equal(readBareQuantity("two bags of Bandit"), null);
    assert.equal(readAddressAnswer(["", "  "]), null);
    assert.equal(isProductAffirmation("yes that one", true), true);
    assert.equal(isProductAffirmation("yes 2 of those", true), false);
    assert.equal(isProductAffirmation("sure", true), false);
    assert.equal(isProductAffirmation("sure", false), true);
  });
});

describe("the product the customer confirmed in this conversation", () => {
  test("the latest explicit confirmation wins, an earlier one is superseded", () => {
    const recent = [
      staff("Do you want the Monello Chicken 25kg?", 0, "S1"),
      customer("yes", 1),
      staff("Which bag did you want, Bandit 25kg?", 60, "S2"),
      customer("Yes, that one.", 61),
    ];
    const got = latestConfirmedProduct(recent, [MONELLO]);
    assert.equal(got?.line.product, "Bandit");
    assert.equal(got?.staff.id, "S2");
  });
  test("a suggestion nobody confirmed, and an ambiguous reply, leave nothing", () => {
    assert.equal(latestConfirmedProduct([staff("Bandit 25kg?", 0), customer("hmm", 1)], []), null);
    assert.equal(latestConfirmedProduct([staff("Bandit 25kg or Monello Chicken 25kg?", 0), customer("yes", 1)], [BANDIT, MONELLO]), null);
  });
});

describe("“send me one bag”: a request that names no product", () => {
  const generic = { product: "bag", quantity: "1", variant: null, size: null };
  const confirmed = latestConfirmedProduct([staff("Which bag did you want, Bandit 25kg?", 0, "S2"), customer("Yes, that one.", 1)], []);

  test("what counts as generic", () => {
    for (const p of ["bag", "one bag", "a sack", "bags"]) assert.equal(isGenericProduct({ product: p, variant: null, size: null }), true, p);
    for (const p of ["Bandit", "dog food", "this one", "Monello bag"]) assert.equal(isGenericProduct({ product: p, variant: null, size: null }), false, p);
    assert.equal(isGenericProduct({ product: "bag", variant: null, size: "25kg" }), false);
  });
  test("the product confirmed in the conversation is used, and the reason is recorded", () => {
    const r = resolveGenericProduct({ line: generic, held: [], confirmed, pool: [history("O-AAAA2", [MONELLO]), history("O-AAAA3", [line("Whiskas")])] });
    assert.equal(r.kind, "resolved");
    if (r.kind !== "resolved") return;
    assert.equal(r.line.product, "Bandit");
    assert.equal(r.line.quantity, "1", "the customer's own quantity is kept");
    assert.equal(r.source.source, "conversation_confirmed");
  });
  test("the customer's only verified product is used", () => {
    const r = resolveGenericProduct({ line: generic, held: [], confirmed: null, pool: [history("O-AAAA2", [MONELLO]), history("O-AAAA3", [MONELLO])] });
    assert.equal(r.kind === "resolved" && r.line.product, "Monello");
    assert.equal(r.kind === "resolved" && r.source.source, "order_history");
  });
  test("several verified products: nothing is chosen", () => {
    const r = resolveGenericProduct({ line: generic, held: [], confirmed: null, pool: [history("O-AAAA2", [MONELLO]), history("O-AAAA3", [BANDIT])] });
    assert.equal(r.kind, "unresolved");
    if (r.kind === "unresolved") assert.match(r.reason, /Monello.*Bandit|Bandit.*Monello/);
  });
  test("no verified purchase: nothing is chosen, and a quotation or cancelled order is not a purchase", () => {
    assert.equal(resolveGenericProduct({ line: generic, held: [], confirmed: null, pool: [] }).kind, "unresolved");
    const cancelled = history("O-AAAA2", [MONELLO], { status: "cancelled" });
    const draft = history("O-AAAA3", [BANDIT], { status: "possible" });
    assert.deepEqual(reliableHistory([cancelled, draft]), []);
  });
  test("a product already on the order wins; two of them is ambiguous", () => {
    assert.equal(resolveGenericProduct({ line: generic, held: [{ ...BANDIT, quantity: "2" }], confirmed: null, pool: [] }).kind, "resolved");
    assert.equal(resolveGenericProduct({ line: generic, held: [BANDIT, MONELLO], confirmed, pool: [] }).kind, "unresolved");
  });
  test("a named product is left alone", () => {
    assert.equal(resolveGenericProduct({ line: { product: "Monello", quantity: "1", variant: null, size: null }, held: [], confirmed, pool: [] }).kind, "keep");
  });
});

describe("what staff state, as against ask or suggest", () => {
  test("statements of what is or will be done", () => {
    for (const t of ["We'll send 2 bags of Bandit 25kg tomorrow", "I've put you down for collection", "That's 3 bags then, delivering to Cap Estate"]) assert.equal(staffStatesCommitment(t), true, t);
  });
  test("questions, offers, hedges and suggestions are not commitments", () => {
    for (const t of ["Would you like us to put you down for tomorrow?", "Which bag did you want, Bandit 25kg?", "We might be able to send it Friday", "I can check with the driver", "Should we send 2 bags?", "Hopefully tomorrow", "Do you want 2 bags"]) assert.equal(staffStatesCommitment(t), false, t);
  });
  test("a quantity staff commit to", () => {
    assert.equal(readStaffQuantity("So that's 3 bags, we'll send them tomorrow"), "3");
    assert.equal(readStaffQuantity("How many bags?"), null);
    assert.equal(readStaffQuantity("Maybe 3 bags"), null);
    assert.equal(readStaffQuantity("We have 3 bags in stock"), null);
  });
});

