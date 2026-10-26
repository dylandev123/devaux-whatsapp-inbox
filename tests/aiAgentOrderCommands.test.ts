// WhatsApp order commands, the pure half (lib/aiAgent/orderCommands.ts) plus the report's reference, phone and name
// helpers (lib/aiAgent/orders.ts): parsing, selector resolution, ambiguity, name choice and reply text.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  moreInfoReply,
  ORDER_REPLY,
  parseOrderCommand,
  parseSelector,
  resolveSelector,
  searchOrders,
  searchReply,
} from "../lib/aiAgent/orderCommands.ts";
import { displayRef, formatPhone, isReliableName, orderWarning, parseOrderRef, pickCustomerName, type ResolvedName, type TrackedOrder } from "../lib/aiAgent/orders.ts";

const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => ({
  id: "o1",
  ref_code: "O-QU6U9",
  business_slug: "dog_food",
  chat_id: "17582867466@s.whatsapp.net",
  contact_number: "17582867466",
  customer_name: "Jane Doe",
  status: "awaiting_confirmation",
  items: [{ product: "Monello Chicken", quantity: "1", variant: null, size: "25kg" }],
  fulfilment_method: "delivery",
  delivery_preference: "delivery",
  delivery_address: "Cap Estate",
  requested_for: null,
  notes: null,
  missing_fields: ["requested_for"],
  attention: null,
  source_message_ids: [],
  first_message_at: "2026-10-26T14:00:00Z",
  last_message_at: "2026-10-26T14:00:00Z",
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
  created_at: "2026-10-26T14:00:00Z",
  updated_at: "2026-10-26T14:00:00Z",
  ...over,
});

describe("compact references", () => {
  test("O-QU6U9 is shown and typed as #QU6U9, in any case", () => {
    assert.equal(displayRef("O-QU6U9"), "#QU6U9");
    for (const t of ["#QU6U9", "qu6u9", "O-QU6U9", "#o-qu6u9", " #QU6U9 "]) assert.equal(parseOrderRef(t), "O-QU6U9", t);
    for (const t of ["#QU6U", "#QU6U9X", "#E-AB12C", "jane", "#0U6U9", ""]) assert.equal(parseOrderRef(t), null, t);
  });
});

describe("readable phones", () => {
  test("St Lucia numbers read as 286-7466; others keep their country code", () => {
    assert.equal(formatPhone("17582867466"), "286-7466");
    assert.equal(formatPhone("18685551234"), "+1 868-555-1234");
    assert.equal(formatPhone("447700900123"), "+447700900123");
    assert.equal(formatPhone(null), null);
    assert.equal(formatPhone("123"), null);
  });
});

describe("which name to show", () => {
  test("staff-entered first, then the saved contact name, then the WhatsApp profile name", () => {
    const all = { orderNameLocked: "Jane (staff)", crmName: "Jane CRM", savedName: "Jane Saved", profileName: "jj 🐶", orderName: "Old" };
    assert.deepEqual(pickCustomerName(all).source, "staff");
    assert.equal(pickCustomerName(all).name, "Jane (staff)");
    assert.equal(pickCustomerName({ ...all, orderNameLocked: null }).name, "Jane CRM");
    assert.equal(pickCustomerName({ ...all, orderNameLocked: null, crmName: "" }).name, "Jane Saved");
    assert.equal(pickCustomerName({ ...all, orderNameLocked: null, crmName: "", savedName: null }).name, "jj 🐶");
    assert.equal(pickCustomerName({ profileName: null, orderName: "Recorded Name" }).name, "Recorded Name");
    assert.deepEqual(pickCustomerName({}), { name: null, source: null, all: [] });
  });
  test("every reliable name stays searchable even when it does not win", () => {
    assert.deepEqual(pickCustomerName({ savedName: "Jane Saved", profileName: "JD" }).all, ["Jane Saved", "JD"]);
  });
  test("numbers, JIDs, placeholders and symbols are never shown as a name", () => {
    for (const bad of ["+1 758 286 7466", "17582867466", "17582867466@s.whatsapp.net", "123@lid", "Unknown", "WhatsApp User", ".", "🙂🙂", "~", "a", "!!!", "x".repeat(80), "‎‏", "   "]) {
      assert.equal(isReliableName(bad), false, JSON.stringify(bad));
    }
    for (const good of ["Jane", "Marie-Claire O'Neil", "Dr. Joseph", "Ana 🐶", "李雷"]) assert.equal(isReliableName(good), true, good);
    // An unreliable better-ranked name does not block a reliable lower one.
    assert.equal(pickCustomerName({ savedName: "17582867466", profileName: "Jane" }).name, "Jane");
    assert.equal(pickCustomerName({ savedName: "+1 758 286 7466", profileName: "~" }).name, null);
  });
  test("a command-looking or invisible-character name is cleaned", () => {
    assert.equal(pickCustomerName({ savedName: "!update Jane" }).name, "update Jane");
    assert.equal(pickCustomerName({ savedName: "‎Jane‏" }).name, "Jane");
  });
});

describe("parsing", () => {
  test("!update alone is the report; tolerant of case, spacing and punctuation", () => {
    for (const t of ["!update", "!UPDATE", "  !update  ", "!update."]) assert.deepEqual(parseOrderCommand(t), { kind: "report" }, t);
  });
  test("confirm, cancel, quantity and delivery date by reference", () => {
    assert.deepEqual(parseOrderCommand("!update #QU6U9 confirmed"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "confirm" } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 confirm"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "confirm" } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 cancelled"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "cancel" } });
    assert.deepEqual(parseOrderCommand("!update #qu6u9 CANCEL."), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "cancel" } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 2 bags"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "quantity", quantity: 2 } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 two bags"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "quantity", quantity: 2 } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 qty 3"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "quantity", quantity: 3 } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 delivery tomorrow"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "delivery", when: "tomorrow" } });
    assert.deepEqual(parseOrderCommand("!update #QU6U9 delivery on Friday morning"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "delivery", when: "Friday morning" } });
  });
  test("name and phone selectors", () => {
    assert.deepEqual(parseOrderCommand("!update Jane Doe confirmed"), { kind: "update", selector: { type: "name", text: "Jane Doe" }, action: { type: "confirm" } });
    assert.deepEqual(parseOrderCommand("!update 286-7466 2 bags"), { kind: "update", selector: { type: "phone", digits: "2867466" }, action: { type: "quantity", quantity: 2 } });
    assert.deepEqual(parseOrderCommand("!update +1 758 286 7466 cancelled"), { kind: "update", selector: { type: "phone", digits: "17582867466" }, action: { type: "cancel" } });
    assert.deepEqual(parseOrderCommand("!update jane delivery tomorrow"), { kind: "update", selector: { type: "name", text: "jane" }, action: { type: "delivery", when: "tomorrow" } });
  });
  test("a bare number without 'bags' is not a quantity, and zero or silly numbers are refused", () => {
    assert.equal(parseOrderCommand("!update #QU6U9 2")?.kind, "help");
    assert.equal(parseOrderCommand("!update #QU6U9 0 bags")?.kind, "help");
    assert.equal(parseOrderCommand("!update #QU6U9 banana")?.kind, "help");
    assert.equal(parseOrderCommand("!update #QU6U9")?.kind, "help");
  });
  test("ordinary staff chatter that starts with !update is not an order command", () => {
    for (const t of ["!update the price list please", "!updates", "!update everyone about the delay", "please !update", "update", "!status"]) {
      assert.equal(parseOrderCommand(t), null, t);
    }
  });
  test("!order searches by name or phone; with a reference it shows the details", () => {
    assert.deepEqual(parseOrderCommand("!order jane"), { kind: "search", query: "jane" });
    assert.deepEqual(parseOrderCommand("!order 286-7466"), { kind: "search", query: "286-7466" });
    assert.deepEqual(parseOrderCommand("!order #QU6U9"), { kind: "info", selector: { type: "ref", ref: "O-QU6U9" } });
    assert.equal(parseOrderCommand("!order")?.kind, "help");
  });
  test("!moreinfo is an order command only with an order reference; escalation uses are left alone", () => {
    assert.deepEqual(parseOrderCommand("!moreinfo #QU6U9"), { kind: "info", selector: { type: "ref", ref: "O-QU6U9" } });
    assert.deepEqual(parseOrderCommand("!more info #qu6u9"), { kind: "info", selector: { type: "ref", ref: "O-QU6U9" } });
    for (const t of ["!moreinfo", "!moreinfo #E-AB12C", "!moreinfo E-AB12C", "!more-info", "!moreinfo please"]) assert.equal(parseOrderCommand(t), null, t);
  });
  test("selectors", () => {
    assert.deepEqual(parseSelector("#QU6U9"), { type: "ref", ref: "O-QU6U9" });
    assert.deepEqual(parseSelector("QU6U9"), { type: "ref", ref: "O-QU6U9" });
    assert.deepEqual(parseSelector("Maria"), { type: "name", text: "Maria" }, "a five-letter name is a name");
    assert.equal(parseSelector("12345"), null, "too short to be a phone");
    assert.equal(parseSelector("!update"), null);
    assert.equal(parseSelector("x".repeat(80)), null);
  });
});

describe("selecting exactly one order", () => {
  const jane = order();
  const janet = order({ id: "o2", ref_code: "O-AB3CD", customer_name: "Janet Smith", contact_number: "17585550102", chat_id: "17585550102@s.whatsapp.net" });
  const jane2 = order({ id: "o3", ref_code: "O-ZZ9XX", items: [{ product: "Dog Treats", quantity: "4", variant: null, size: null }] });
  const marcus = order({ id: "o4", ref_code: "O-MN4PQ", customer_name: "Marcus", contact_number: "17585550103", chat_id: "17585550103@s.whatsapp.net" });
  const all = [jane, janet, jane2, marcus];

  test("a reference finds one order; unknown references find none", () => {
    assert.deepEqual(resolveSelector({ type: "ref", ref: "O-AB3CD" }, all), { kind: "one", order: janet });
    assert.deepEqual(resolveSelector({ type: "ref", ref: "O-NOPE2" }, all), { kind: "none" });
  });
  test("a name or phone matching several orders is never reduced to one", () => {
    const byName = resolveSelector({ type: "name", text: "jane" }, all);
    assert.equal(byName.kind, "many");
    assert.deepEqual(byName.kind === "many" ? byName.orders.map((o) => o.ref_code).sort() : [], ["O-AB3CD", "O-QU6U9", "O-ZZ9XX"]);
    assert.equal(resolveSelector({ type: "phone", digits: "2867466" }, all).kind, "many", "one customer, two orders");
    assert.equal(resolveSelector({ type: "name", text: "jane doe" }, all).kind, "many", "still two orders for Jane Doe");
  });
  test("a unique name or phone finds its one order", () => {
    assert.deepEqual(resolveSelector({ type: "name", text: "marcus" }, all), { kind: "one", order: marcus });
    assert.deepEqual(resolveSelector({ type: "name", text: "Janet S" }, all), { kind: "one", order: janet });
    assert.deepEqual(resolveSelector({ type: "phone", digits: "5550103" }, all), { kind: "one", order: marcus });
    assert.deepEqual(resolveSelector({ type: "phone", digits: "17585550103" }, all), { kind: "one", order: marcus });
    assert.deepEqual(resolveSelector({ type: "name", text: "nobody" }, all), { kind: "none" });
    assert.deepEqual(resolveSelector({ type: "phone", digits: "9999999" }, all), { kind: "none" });
  });
  test("names found through the saved contact or profile name count too", () => {
    const names = { o4: { name: "Marcus", source: "staff", all: ["Marcus", "Big Marc"] } satisfies ResolvedName };
    assert.equal(resolveSelector({ type: "name", text: "big marc" }, all, names).kind, "one");
    assert.equal(resolveSelector({ type: "name", text: "big marc" }, all).kind, "none");
  });
  test("search lists every match, by name, phone or reference", () => {
    assert.equal(searchOrders("jane", all).length, 3);
    assert.equal(searchOrders("555-0103", all).length, 1);
    assert.equal(searchOrders("#MN4PQ", all).length, 1);
    assert.equal(searchOrders("zzz", all).length, 0);
  });
});

describe("one actionable warning", () => {
  test("only warnings that could cause a wrong fulfilment appear; missing details and statuses never do", () => {
    const base = { attention: null as string | null };
    assert.equal(orderWarning({ ...base, attention: "cancellation_requested" }), "Customer may want to cancel");
    assert.equal(orderWarning({ ...base, attention: "changed_after_confirmation" }), "Changed after confirmation — re-confirm");
    assert.equal(orderWarning({ ...base, attention: "staff_cancelled_in_chat" }), "Staff cancelled in chat — verify");
    for (const quiet of ["customer_replied_yes", "staff_confirmed_in_chat", "other_customer_note"]) assert.equal(orderWarning({ ...base, attention: quiet }), null, quiet);
    assert.equal(orderWarning(base), null);
    const conflict = { field_conflicts: { items: { proposed: [], current: [], at: "2026-10-26T10:00:00Z" } } };
    assert.equal(orderWarning({ ...base, ...conflict, attention: "cancellation_requested" }), "Customer asked for a change — check before fulfilling", "a contradicted staff value outranks other flags");
  });
});

describe("replies", () => {
  test("clarification lists the candidates with their references and changes nothing", () => {
    const text = ORDER_REPLY.many("jane", [order(), order({ id: "o2", ref_code: "O-AB3CD", customer_name: "Janet" })]);
    assert.match(text, /matches 2 active orders — nothing changed/);
    assert.match(text, /#QU6U9/);
    assert.match(text, /#AB3CD/);
  });
  test("search results and details stay short and never leak the raw state", () => {
    const text = searchReply("jane", [order()]);
    assert.match(text, /1 active order for "jane"/);
    assert.match(text, /\*Jane Doe · #QU6U9\*\nOpen\n286-7466\n1 × Monello Chicken 25kg\nDelivery: Cap Estate$/m);
    const info = moreInfoReply({
      order: order({ manual_locked_fields: ["items"] }),
      name: { name: "Jane Doe", source: "saved", all: ["Jane Doe"] },
      events: [{ kind: "ai_update", actor_kind: "ai", created_at: "2026-10-26T14:05:00Z", changes: { items: { before: [{ product: "Monello", quantity: "1", variant: null, size: null }], after: [{ product: "Monello", quantity: "2", variant: null, size: null }] } } }],
      timezone: "America/St_Lucia",
    });
    assert.match(info, /Status: Awaiting confirmation/);
    assert.match(info, /Name: saved contact/);
    assert.match(info, /Edited by staff: items/);
    assert.match(info, /Recent changes:\n• 26 Oct, 10:05 ai: ai update — items 1 × Monello → 2 × Monello/);
    assert.ok(info.length < 1200);
  });
});
