// Conversational order teaching, customer preferences, command variations and saved-name precedence — the pure rules, no I/O.
// The end-to-end behaviour (WhatsApp messages, sessions, proposals, SQL) is tests/aiAgentTeachSessionsSql.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderCommand } from "../lib/aiAgent/orderCommands.ts";
import { parseProposalCode } from "../lib/aiAgent/orderTeach.ts";
import { emptyState, isCancelReply, parseTeachUnderstanding, planTeaching, similarNames, type TeachPlanInput } from "../lib/aiAgent/orderTeachSession.ts";
import { pickCustomerName, type TrackedOrder } from "../lib/aiAgent/orders.ts";
import { resolveGenericProduct } from "../lib/aiAgent/orderConversation.ts";
import { resolveContactName } from "../lib/contactName.ts";

const order = (over: Partial<TrackedOrder> = {}): TrackedOrder =>
  ({
    id: "o1", ref_code: "O-JBEKR", business_slug: "dog_food", chat_id: "1758@s.whatsapp.net", contact_number: "1758", customer_name: "Jonathan Calderon", status: "confirmed",
    items: [], fulfilment_method: null, delivery_preference: null, delivery_address: null, requested_for: null, notes: null, missing_fields: [], attention: null,
    source_message_ids: [], first_message_at: "2026-10-29T10:00:00Z", last_message_at: "2026-10-29T10:00:00Z", awaiting_since: null, manual_locked_fields: [], field_conflicts: {},
    confirmed_by: null, confirmed_at: null, customer_confirmed_at: null, cancelled_at: null, cancel_reason: null, fulfilled_at: null, version: 3,
    created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-29T10:00:00Z", ...over,
  }) as TrackedOrder;

const AT = new Date("2026-10-29T15:00:00Z");
const KNOWN = { products: [{ text: "Bandit 25kg", source: "history" as const }, { text: "Monello Chicken 25kg", source: "knowledge" as const }] };

const understand = (json: object) => parseTeachUnderstanding(JSON.stringify(json))!;
const input = (turns: string[], json: object, over: Partial<TeachPlanInput> = {}): TeachPlanInput => ({
  order: order(), understanding: understand(json), turns, state: emptyState(), known: KNOWN, customerName: "Jonathan Calderon", at: AT, timezone: "America/St_Lucia", ...over,
});

describe("command variations are recognised, never silent", () => {
  test("a space after the bang, and 'teach' before the reference, are the canonical command", () => {
    const canonical = parseOrderCommand("!order #DLXX2 teach location is cap estate");
    assert.equal(canonical?.kind, "teach");
    assert.deepEqual(parseOrderCommand("! Order #DLXX2 teach location is cap estate"), canonical);
    assert.deepEqual(parseOrderCommand("!order teach #DLXX2 location is cap estate"), canonical);
    assert.deepEqual(parseOrderCommand("!ORDER #dlxx2 Teach: location is cap estate"), canonical);
  });

  test("'!order teach #CODE and location is cap estate for weixin Lin' gets the teach help, not silence", () => {
    assert.deepEqual(parseOrderCommand("!order teach #CODE and location is cap estate for weixin Lin"), { kind: "help", reason: "teach" });
  });

  test("a numbered order works in every position", () => {
    assert.deepEqual(parseOrderCommand("!order 1"), { kind: "info", selector: { type: "number", n: 1 } });
    assert.equal(parseOrderCommand("!order 1 teach bags are bandit")?.kind, "teach");
    assert.equal(parseOrderCommand("!order teach 2 bags are bandit")?.kind, "teach");
    assert.deepEqual(parseOrderCommand("!order 1 completed"), { kind: "update", selector: { type: "number", n: 1 }, action: { type: "complete" } });
  });

  test("'order #REF teach …' without the bang is answered with the corrected command, and is never acted on", () => {
    const c = parseOrderCommand("Order #JBEKR teach the bags taken are bandit 25kg");
    assert.deepEqual(c, { kind: "help", reason: "no_bang", suggestion: "!Order #JBEKR teach the bags taken are bandit 25kg" });
    assert.equal(parseOrderCommand("order 3 completed")?.kind, "help");
  });

  test("ordinary chatter that merely starts with 'order' is left alone", () => {
    assert.equal(parseOrderCommand("order the bandit tomorrow please"), null);
    assert.equal(parseOrderCommand("orders are late today"), null);
    assert.equal(parseOrderCommand("order number 5 teach"), null);
  });

  test("P- codes belong to customer preferences; K-, M-, E- stay with their own flows", () => {
    assert.deepEqual(parseProposalCode("P-ABCDE"), { kind: "customer_preference", code: "P-ABCDE" });
    assert.equal(parseProposalCode("K-ABCDE"), null);
    assert.equal(parseOrderCommand("!confirm P-ABCDE")?.kind, "proposal");
  });

  test("cancel words end a conversation; ordinary answers do not", () => {
    for (const t of ["cancel", "Never mind", "stop", "forget it", "ignore that"]) assert.ok(isCancelReply(t), t);
    for (const t of ["yes, save it", "2 bags", "he wants cancelled orders removed"]) assert.ok(!isCancelReply(t), t);
  });
});

describe("spelling variations never reject an instruction whose order is known", () => {
  test("Jonathon / Jonathan, Wei Xin / Weixin", () => {
    assert.ok(similarNames("Jonathon", "Jonathan Calderon"));
    assert.ok(similarNames("Weixin Lin", "Wei Xin Lin"));
    assert.ok(!similarNames("Maria", "Jonathan Calderon"));
  });

  test("a respelt name is the same customer: the order keeps its name and the plan carries on", () => {
    const plan = planTeaching(input(["Jonathon wants 2 bags of bandit 25kg"], { customer_name: "Jonathon", items: [{ product: "Bandit", quantity: "2", size: "25kg" }] }));
    assert.equal(plan.kind, "propose");
    assert.deepEqual(plan.correction!.changes.map((c) => c.field), ["items"]);
    assert.ok(plan.notes.some((n) => /Kept the name Jonathan Calderon/.test(n)));
  });

  test("a different name is not applied unless staff are renaming", () => {
    const keep = planTeaching(input(["Maria wants 2 bags of bandit 25kg"], { customer_name: "Maria", items: [{ product: "Bandit", quantity: "2", size: "25kg" }] }));
    assert.deepEqual(keep.correction!.changes.map((c) => c.field), ["items"]);
    const rename = planTeaching(input(["the name is Maria"], { customer_name: "Maria" }));
    assert.deepEqual(rename.correction!.changes.map((c) => c.field), ["customer_name"]);
  });
});

describe("missing quantities and products become questions, never inventions", () => {
  test("'Jonathon ordered bags … bandit 25kg' asks how many, even if the model guesses a quantity", () => {
    const said = "Jonathon ordered bags. There is no specific bags set but the bags he takes are bandit 25kg";
    for (const quantity of [null, "1", "2"]) {
      const plan = planTeaching(input([said], { customer_name: "Jonathon", items: [{ product: "Bandit", quantity, size: "25kg" }] }));
      assert.equal(plan.kind, "ask");
      assert.match(plan.questions[0].text, /How many bags of Bandit 25kg does Jonathan Calderon want\?/);
      assert.equal(plan.correction, null);
    }
  });

  test("a product that is neither in the words nor in verified records is asked about, with the known options", () => {
    const plan = planTeaching(input(["he wants 2 bags"], { items: [{ product: "Birbo Meat", quantity: "2", size: null }] }));
    assert.equal(plan.kind, "ask");
    assert.match(plan.questions[0].text, /Which product is it\? .*“Birbo Meat”.*Bandit 25kg/);
  });

  test("a product named only by verified records is accepted, and the preview says where it came from", () => {
    const plan = planTeaching(input(["he wants 2 bags"], { items: [{ product: "Bandit 25kg", quantity: "2", size: null }] }));
    assert.equal(plan.kind, "propose");
    assert.ok(plan.notes.some((n) => /comes from .*verified earlier orders, not from your words/.test(n)));
  });

  test("the answer to a question completes the same instruction (the whole conversation is read)", () => {
    const first = planTeaching(input(["Jonathon ordered bandit 25kg"], { items: [{ product: "Bandit", quantity: null, size: "25kg" }] }));
    assert.equal(first.kind, "ask");
    const second = planTeaching(input(["Jonathon ordered bandit 25kg", "2 bags"], { items: [{ product: "Bandit", quantity: "2", size: "25kg" }] }, { state: first.state }));
    assert.equal(second.kind, "propose");
    assert.equal(second.correction!.changes[0].after, "2 × Bandit 25kg");
  });

  test("an address that is not in the words is asked about, not applied", () => {
    const plan = planTeaching(input(["send it tomorrow"], { delivery_address: "Rodney Bay", requested_for: "tomorrow" }));
    assert.equal(plan.kind, "ask");
    assert.match(plan.questions[0].text, /address “Rodney Bay” is not in what you wrote/);
  });
});

describe("customer preferences are separate from the order, and never saved on inference", () => {
  const usual = { product: "Bandit", size: "25kg", save: null, for_order: null };

  test("'usually orders Bandit 25kg' asks whether to save it AND whether it is for this order; nothing is proposed", () => {
    const plan = planTeaching(input(["Jonathon usually orders Bandit 25kg"], { usual_product: usual }));
    assert.equal(plan.kind, "ask");
    assert.deepEqual(plan.questions.map((q) => q.key), ["save_usual", "apply_usual"]);
    assert.match(plan.questions[0].text, /Should I save Bandit 25kg as Jonathan Calderon's usual product/);
    assert.match(plan.questions[1].text, /also the product for .*current order/);
    assert.deepEqual(plan.facts, []);
  });

  test("the model saying save:true is not enough without staff's words or a yes to our question", () => {
    const plan = planTeaching(input(["Jonathon usually orders Bandit 25kg"], { usual_product: { ...usual, save: true } }));
    assert.equal(plan.kind, "ask");
    assert.deepEqual(plan.facts, []);
  });

  test("an explicit 'save' answer plus a quantity gives a separate order change and customer fact", () => {
    const asked = planTeaching(input(["Jonathon usually orders Bandit 25kg"], { usual_product: usual }));
    const plan = planTeaching(
      input(["Jonathon usually orders Bandit 25kg", "Yes, save it. He wants 2 bags today."], { usual_product: { ...usual, save: true, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }], requested_for: "today" }, { state: asked.state })
    );
    assert.equal(plan.kind, "propose");
    assert.deepEqual(plan.correction!.changes.map((c) => c.field).sort(), ["items", "requested_for"]);
    assert.deepEqual(plan.facts.map((f) => [f.type, f.label]), [["usual_product", "Bandit 25kg"]]);
  });

  test("'No, just this order' saves nothing, and the order change still proceeds", () => {
    const asked = planTeaching(input(["Jonathon usually orders Bandit 25kg"], { usual_product: usual }));
    const plan = planTeaching(input(["Jonathon usually orders Bandit 25kg", "No, just this order, 2 bags"], { usual_product: { ...usual, save: false, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }] }, { state: asked.state }));
    assert.equal(plan.kind, "propose");
    assert.deepEqual(plan.facts, []);
    assert.deepEqual(plan.correction!.changes.map((c) => c.field), ["items"]);
  });

  test("the usual product does not go on the order unless staff say so", () => {
    const plan = planTeaching(input(["Remember that Jonathon usually orders Bandit 25kg, don't change today's order"], { usual_product: { ...usual, save: true, for_order: false }, items: [{ product: "Bandit", quantity: "1", size: "25kg" }] }));
    assert.equal(plan.kind, "propose");
    assert.equal(plan.correction, null);
    assert.equal(plan.facts.length, 1);
  });

  test("a place for this order only is an order change; 'usually' makes it a question about the customer's default", () => {
    const only = planTeaching(input(["location is cap estate"], { delivery_address: "Cap Estate", saved_location: { value: "Cap Estate", save: null } }));
    assert.equal(only.kind, "propose");
    assert.deepEqual(only.facts, []);
    assert.deepEqual(only.correction!.changes.map((c) => c.field), ["delivery_address"]);
    const usually = planTeaching(input(["he usually gets deliveries at Cap Estate"], { saved_location: { value: "Cap Estate", save: null } }));
    assert.equal(usually.kind, "ask");
    assert.equal(usually.questions[0].key, "save_location");
  });

  test("a display name needs the staff member to ask for it, and the words must contain the name", () => {
    const set = planTeaching(input(["call him Jon C"], { display_name: "Jon C" }));
    assert.deepEqual(set.facts.map((f) => [f.type, f.label]), [["display_name", "Jon C"]]);
    const inferred = planTeaching(input(["Jon C wants nothing today"], { display_name: "Jon C" }));
    assert.deepEqual(inferred.facts, []);
    const invented = planTeaching(input(["call him something nice"], { display_name: "Bobby" }));
    assert.deepEqual(invented.facts, []);
  });

  test("a question is not asked forever", () => {
    let state = emptyState();
    for (let i = 0; i < 3; i += 1) {
      const plan = planTeaching(input(["Jonathon usually orders Bandit 25kg", "hmm"], { usual_product: usual }, { state }));
      state = plan.state;
      if (i >= 2) assert.ok(!plan.questions.some((q) => q.key === "save_usual"), "stopped asking");
    }
  });

  test("model replies that are not JSON are unusable, never a plan", () => {
    assert.equal(parseTeachUnderstanding("I think they want more food"), null);
    assert.equal(parseTeachUnderstanding("{ not json"), null);
    assert.equal(understand({ related: false }).related, false);
  });
});

describe("approved preferences feed later order extraction", () => {
  const line = { product: "Bag", quantity: "1", variant: null, size: null };
  const usual = { product: "Bandit 25kg", quantity: null, variant: null, size: null };

  test("a staff-saved usual product answers 'send me a bag' ahead of any statistic, and says where it came from", () => {
    const res = resolveGenericProduct({ line, held: [], confirmed: null, pool: [], staffUsual: usual });
    assert.equal(res.kind, "resolved");
    if (res.kind === "resolved") {
      assert.equal(res.line.product, "Bandit 25kg");
      assert.equal(res.line.quantity, "1", "the customer's own quantity is kept");
      assert.deepEqual(res.source, { source: "staff_saved", product: "Bandit 25kg" });
    }
  });

  test("with nothing saved and no history it is still unresolved: nothing is invented", () => {
    assert.equal(resolveGenericProduct({ line, held: [], confirmed: null, pool: [], staffUsual: null }).kind, "unresolved");
  });

  test("the product already on the order still wins over the saved one", () => {
    const held = [{ product: "Monello", quantity: "1", variant: null, size: null }];
    const res = resolveGenericProduct({ line, held, confirmed: null, pool: [], staffUsual: usual });
    assert.equal(res.kind === "resolved" && res.source.source, "open_order");
  });
});

describe("saved-name precedence", () => {
  test("a staff-entered name beats the saved address-book name, which beats the WhatsApp profile name", () => {
    assert.deepEqual(pickCustomerName({ crmName: "Jon C", savedName: "Jonny (saved)", profileName: "jj" }).source, "staff");
    assert.deepEqual(pickCustomerName({ savedName: "Jonny (saved)", profileName: "Profile Jon" }), { name: "Jonny (saved)", source: "saved", all: ["Jonny (saved)", "Profile Jon"] });
    assert.equal(pickCustomerName({ profileName: "Profile Jon" }).source, "profile");
    assert.equal(pickCustomerName({ orderNameLocked: "Locked", crmName: "Crm" }).name, "Locked");
  });

  test("the Inbox shows the same order: first/last, then saved, then profile, then phone", () => {
    assert.equal(resolveContactName({ firstName: "Jon", lastName: "C", businessContactName: "Saved", whatsappName: "Profile", phoneNumber: "1758" }), "Jon C");
    assert.equal(resolveContactName({ businessContactName: "Saved", whatsappName: "Profile", phoneNumber: "1758" }), "Saved");
    assert.equal(resolveContactName({ whatsappName: "Profile", phoneNumber: "1758" }), "Profile");
    assert.equal(resolveContactName({ phoneNumber: "1758" }), "1758");
  });

  test("an unreliable synced name (a number, a placeholder) never wins", () => {
    assert.equal(pickCustomerName({ savedName: "17585550123", profileName: "Real Name" }).name, "Real Name");
    assert.equal(pickCustomerName({ savedName: "Unknown", profileName: null }).name, null);
  });
});
