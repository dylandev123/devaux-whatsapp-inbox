// Natural-language order corrections, bulk completion and the cleaner report — pure, no database. Covers: the command
// parsers (and that K-/M-/E- codes are left to their own commands), validation of the model's JSON, grounding every value in
// the staff member's words, multi-field corrections, ambiguity, date handling across the St Lucia midnight boundary, the
// bulk-completion scope, the preview texts and the report lines that no longer print "default day".

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isCorrectionCommand, parseOrderCommand } from "../lib/aiAgent/orderCommands.ts";
import {
  BULK_REPLY,
  bulkResultText,
  bulkScope,
  CORRECTION_REPLY,
  parseCorrectionProposal,
  parseProposalCode,
  planCorrection,
  type CorrectionProposal,
} from "../lib/aiAgent/orderTeach.ts";
import { buildOrdersView, dayContext, orderViewBlock } from "../lib/aiAgent/orderViews.ts";
import { buildRulesMessages, STAFF_COMMANDS } from "../lib/aiAgent/commandRegistry.ts";
import type { TrackedOrder } from "../lib/aiAgent/orders.ts";

const TZ = "America/St_Lucia"; // UTC-4, no daylight saving
const NOW = new Date("2026-10-28T14:00:00Z"); // Wed 28 Oct 2026, 10:00 in St Lucia

let n = 0;
const order = (over: Partial<TrackedOrder> = {}): TrackedOrder => {
  n += 1;
  return {
    id: `o${n}`,
    ref_code: `O-ZWL${String(n).padStart(2, "0")}`.slice(0, 7).replace(/[01]/g, "7"),
    business_slug: "dog_food",
    chat_id: `1758555${1000 + n}@s.whatsapp.net`,
    contact_number: `1758555${1000 + n}`,
    customer_name: null,
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

const proposal = (over: Partial<CorrectionProposal> = {}): CorrectionProposal => ({
  items: null, customer_name: null, fulfilment_method: null, delivery_address: null, requested_for: null, contact_phone: null, note: null, ambiguities: [], reusable: [], ...over,
});
const plan = (o: TrackedOrder, p: Partial<CorrectionProposal>, instruction: string, at = NOW) => planCorrection(o, proposal(p), { instruction, at, timezone: TZ });
const fields = (p: ReturnType<typeof plan>) => p.changes.map((c) => c.field).sort();

describe("command parsing", () => {
  test("!order #REF teach <words> needs an order reference and an instruction", () => {
    const c = parseOrderCommand("!order #ZWL67 teach The address is Cap Estate and the food is 1 Bandit 25kg");
    assert.equal(c?.kind, "teach");
    assert.deepEqual(c && c.kind === "teach" ? [c.selector, c.instruction] : null, [{ type: "ref", ref: "O-ZWL67" }, "The address is Cap Estate and the food is 1 Bandit 25kg"]);
    assert.equal(isCorrectionCommand(c!), true);
    // A name or phone could match the wrong order; an empty or very long instruction gets the usage.
    for (const text of ["!order Jason teach 2 bags", "!order 17585550123 teach 2 bags", "!order #ZWL67 teach", "!order #ZWL67 teach   ", `!order #ZWL67 teach ${"x".repeat(700)}`]) {
      assert.deepEqual(parseOrderCommand(text), { kind: "help", reason: "teach" }, text);
    }
  });

  test("existing order commands still parse exactly as before", () => {
    assert.equal(parseOrderCommand("!order #ZWL67")?.kind, "info");
    assert.equal(parseOrderCommand("!order #ZWL67 completed")?.kind, "update");
    assert.equal(parseOrderCommand("!order #ZWL67 reopen")?.kind, "update");
    assert.equal(parseOrderCommand("!order Jason")?.kind, "search");
    assert.equal(parseOrderCommand("!order #ZWL67 2 bags")?.kind, "update");
    assert.equal(parseOrderCommand("!orders tomorrow")?.kind, "orders");
    assert.equal(parseOrderCommand("!update"), null);
    assert.equal(parseOrderCommand("!moreinfo #ZWL67")?.kind, "info");
    assert.equal(parseOrderCommand("!moreinfo"), null, "an escalation !moreinfo is not ours");
  });

  test("!orders complete all is exact; any other 'complete' argument gets the usage, never a completion", () => {
    assert.deepEqual(parseOrderCommand("!orders complete all"), { kind: "bulk_complete" });
    assert.deepEqual(parseOrderCommand("  !ORDERS   Complete   ALL. "), { kind: "bulk_complete" });
    for (const text of ["!orders complete", "!orders complete tomorrow", "!orders complete all tomorrow", "!orders complete overdue", "!orders completed all"]) {
      assert.deepEqual(parseOrderCommand(text)?.kind === "bulk_complete" ? "BULK" : parseOrderCommand(text), { kind: "help", reason: text.includes("completed") ? "orders" : "complete_all" }, text);
    }
  });

  test("!confirm / !discard take only our C- and B- codes; knowledge, note and request codes are left alone", () => {
    assert.deepEqual(parseOrderCommand("!confirm C-ABCDE"), { kind: "proposal", action: "confirm", code: "C-ABCDE", proposalKind: "correction" });
    assert.deepEqual(parseOrderCommand("!discard #b-abcde"), { kind: "proposal", action: "discard", code: "B-ABCDE", proposalKind: "bulk_complete" });
    for (const text of ["!confirm K-7QX2", "!confirm K-7QX2 replace", "!discard K-7QX2", "!confirm E-ABCDE", "!confirm M-ABCDE", "!confirm", "!confirm C-ABCDE and more", "!confirm C-ABCD", "!confirm C-ABCDO"]) {
      assert.equal(parseOrderCommand(text), null, text);
    }
    assert.equal(parseProposalCode("C-ABCDE")?.kind, "correction");
    assert.equal(parseProposalCode("K-ABCDE"), null);
  });
});

describe("the model's JSON is validated", () => {
  test("fenced or noisy JSON is read; anything else is 'not understood'", () => {
    const p = parseCorrectionProposal('```json\n{"items":[{"product":"Bandit","quantity":1,"size":"25kg"}],"delivery_address":"Cap Estate","ambiguities":[],"reusable":[]}\n```');
    assert.deepEqual(p?.items, [{ product: "Bandit", quantity: "1", variant: null, size: "25kg" }]);
    assert.equal(p?.delivery_address, "Cap Estate");
    for (const bad of [null, "", "sure!", "[1,2]", "{not json", '"just a string"']) assert.equal(parseCorrectionProposal(bad), null, String(bad));
  });

  test("unknown methods, huge lists and control characters are cleaned, not trusted", () => {
    const p = parseCorrectionProposal(JSON.stringify({ fulfilment_method: "teleport", items: Array.from({ length: 40 }, (_, i) => ({ product: `P${i}` })), customer_name: "Jo\u0000hn\n", reusable: [{ scope: "everyone", text: "x" }, { scope: "customer", text: "Always at the gate" }] }));
    assert.equal(p?.fulfilment_method, null);
    assert.equal(p?.items?.length, 20);
    assert.equal(p?.customer_name, "Jo hn");
    assert.deepEqual(p?.reusable, [{ scope: "customer", text: "Always at the gate" }]);
  });
});

describe("planning a correction", () => {
  test("several fields in one instruction: address and product", () => {
    const o = order({ items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: "25kg" }], delivery_address: null });
    const p = plan(o, { delivery_address: "Cap Estate", items: [{ product: "Bandit", quantity: "1", variant: null, size: "25kg" }] }, "The address is Cap Estate and the food is 1 Bandit 25kg");
    assert.deepEqual(p.ambiguities, []);
    assert.deepEqual(fields(p), ["delivery_address", "items"]);
    assert.deepEqual(p.patch.delivery_address, "Cap Estate");
    assert.match(p.changes.find((c) => c.field === "items")!.after, /1 × Bandit 25kg/);
    assert.equal(p.changes.find((c) => c.field === "delivery_address")!.before, "not set");
  });

  test("name, product, quantity and delivery place from one sentence", () => {
    const o = order({ delivery_address: null });
    const p = plan(o, { customer_name: "Jason", fulfilment_method: "delivery", delivery_address: "Gros Islet", items: [{ product: "Birbo Meat", quantity: "2", variant: null, size: "25kg" }] }, "Jason wants 2 Birbo Meat 25kg delivered to Gros Islet");
    assert.deepEqual(p.ambiguities, []);
    assert.deepEqual(fields(p), ["customer_name", "delivery_address", "items"], "delivery is already the default, so it is not a change");
  });

  test("collection with a day: relative days count from when STAFF wrote the instruction, in St Lucia time", () => {
    const o = order({ customer_name: "Customer", requested_for: "Wed 28 Oct (default)" });
    const instruction = "Blondie is collecting tomorrow morning";
    const wrote = (iso: string) => plan(o, { customer_name: "Blondie", fulfilment_method: "collection", requested_for: "tomorrow morning" }, instruction, new Date(iso));
    // 23:30 on Tue 27 Oct in St Lucia is already 03:30Z on the 28th: "tomorrow" is still Wed 28 Oct.
    const before = wrote("2026-10-28T03:30:00Z");
    assert.deepEqual(before.ambiguities, []);
    assert.equal(before.patch.requested_for, "Wed 28 Oct (tomorrow morning)");
    assert.equal(before.patch.fulfilment_method, "collection");
    assert.equal(before.patch.customer_name, "Blondie");
    // One hour later it is 00:30 on the 28th locally: "tomorrow" is Thu 29 Oct.
    assert.equal(wrote("2026-10-28T04:30:00Z").patch.requested_for, "Thu 29 Oct (tomorrow morning)");
    assert.equal(before.changes.find((c) => c.field === "requested_for")!.after, "Wed 28 Oct, morning");
  });

  test("a time alone keeps the order's own day, and keeps a default day marked as a default", () => {
    const defaulted = order({ requested_for: "Thu 29 Oct (default)" });
    const p = plan(defaulted, { requested_for: "morning" }, "make it morning");
    assert.equal(p.patch.requested_for, "Thu 29 Oct (default, morning)");
    assert.equal(p.changes[0].before, "Thu 29 Oct");
    assert.equal(p.changes[0].after, "Thu 29 Oct, morning");
    const stated = order({ requested_for: "Fri 30 Oct (Friday)" });
    assert.equal(plan(stated, { requested_for: "3pm" }, "3pm please").patch.requested_for, "Fri 30 Oct (3pm)");
  });

  test("a written date is read, an unreadable one is an ambiguity", () => {
    assert.equal(plan(order(), { requested_for: "30 Oct" }, "deliver on 30 Oct").patch.requested_for, "Fri 30 Oct (30 Oct)");
    const vague = plan(order(), { requested_for: "next week" }, "deliver next week");
    assert.deepEqual(fields(vague), []);
    assert.match(vague.ambiguities.join(" "), /could not read “next week” as one day/);
  });

  test("a value the instruction never mentions is refused, not applied", () => {
    const o = order();
    const cases: [Partial<CorrectionProposal>, string, RegExp][] = [
      [{ items: [{ product: "Bandit", quantity: "1", variant: null, size: null }] }, "the address is Cap Estate", /“Bandit” is not in what you wrote/],
      [{ delivery_address: "Rodney Bay" }, "2 bags please", /address “Rodney Bay” is not in what you wrote/],
      [{ customer_name: "Marcus" }, "collect tomorrow", /name “Marcus” is not clearly/],
      [{ requested_for: "Friday" }, "make it 3 bags", /day “Friday” is not in what you wrote/],
      [{ items: [{ product: "Monello Chicken", quantity: "9", variant: null, size: "25kg" }] }, "change the Monello order", /quantity for Monello Chicken is not in what you wrote/],
      [{ fulfilment_method: "collection" }, "Jason, Cap Estate", /did not say whether it is collected/],
      [{ contact_phone: "7585550123" }, "call the driver", /number 7585550123 is not clearly in what you wrote/],
      [{ note: "gate code 4412" }, "leave it with the guard", /note “gate code 4412” is not in what you wrote/],
    ];
    for (const [p, text, expected] of cases) {
      const result = plan(o, p, text);
      assert.match(result.ambiguities.join(" | "), expected, text);
    }
  });

  test("anything the model flags as ambiguous is carried through", () => {
    const p = plan(order(), { items: [{ product: "Monello Chicken", quantity: "3", variant: null, size: "25kg" }], ambiguities: ["Which Monello — Chicken or Beef?"] }, "make it 3 Monello");
    assert.deepEqual(p.ambiguities, ["Which Monello — Chicken or Beef?"]);
  });

  test("a value equal to the current one is not a change", () => {
    const o = order({ delivery_address: "Cap Estate", customer_name: "Jason" });
    const p = plan(o, { delivery_address: "cap estate", customer_name: "JASON", items: o.items }, "address Cap Estate for Jason, 2 Monello Chicken 25kg");
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.ambiguities, []);
  });

  test("an empty product list is an ambiguity, never an order with no products", () => {
    assert.match(plan(order(), { items: [] }, "no food").ambiguities.join(" "), /could not tell which products/);
  });

  test("a field staff edited earlier is flagged as replaced; the lock stays", () => {
    const o = order({ manual_locked_fields: ["delivery_address"] });
    const p = plan(o, { delivery_address: "Gros Islet" }, "address is Gros Islet");
    assert.equal(p.changes[0].wasLocked, true);
    assert.match(CORRECTION_REPLY.preview(o, undefined, p, "C-ABCDE", "address is Gros Islet"), /replaces a value staff set earlier/);
  });

  test("an alternate contact number is added to the notes, never replaces them, and the customer's own number is refused", () => {
    const o = order({ notes: "Call on arrival", contact_number: "17585550123" });
    const p = plan(o, { contact_phone: "758 555 0199" }, "driver is on 758 555 0199");
    assert.equal(p.patch.notes, "Call on arrival · Delivery contact: 758-555-0199");
    const own = plan(o, { contact_phone: "7585550123" }, "call 7585550123");
    assert.deepEqual(own.changes, [], "the number they write from is not an alternate contact");
  });

  test("notes are appended, not duplicated", () => {
    const o = order({ notes: "Gate is blue" });
    assert.equal(plan(o, { note: "Call on arrival" }, "call on arrival please").patch.notes, "Gate is blue · Call on arrival");
    assert.deepEqual(plan(o, { note: "gate is blue" }, "the gate is blue").changes, []);
  });

  test("reusable suggestions survive only when the words generalise, and never carry numbers", () => {
    const suggestion = [{ scope: "customer" as const, text: "Jason always collects in the morning" }];
    assert.deepEqual(plan(order(), { requested_for: "morning", reusable: suggestion }, "Jason always collects in the morning").reusable, suggestion);
    assert.deepEqual(plan(order(), { requested_for: "morning", reusable: suggestion }, "make it morning, Jason collects").reusable, [], "one order's wording is not a general rule");
    assert.deepEqual(plan(order(), { reusable: [{ scope: "customer", text: "Jason always calls 7585550199 first" }] }, "Jason always calls 7585550199 first").reusable, []);
  });
});

describe("previews and replies", () => {
  test("a correction preview shows before/after, the one-time code, the expiry and that nobody is messaged", () => {
    const o = order({ customer_name: "Jason", status: "confirmed" });
    const p = plan(o, { delivery_address: "Gros Islet" }, "address is Gros Islet");
    const text = CORRECTION_REPLY.preview(o, undefined, p, "C-ABCDE", "!address is Gros Islet");
    assert.match(text, /Proposed correction/);
    assert.match(text, /Delivery address: Cap Estate → \*Gros Islet\*/);
    assert.match(text, /already confirmed/);
    assert.match(text, /!confirm C-ABCDE/);
    assert.match(text, /!discard C-ABCDE/);
    assert.match(text, /Valid for 30 minutes/);
    assert.match(text, /customer is not messaged/);
    assert.doesNotMatch(text, /“!/, "staff text never starts a line with a command character");
    assert.ok(text.length < 600);
  });

  test("after applying, reusable facts are offered as commands, not saved", () => {
    const o = order({ customer_name: "Jason" });
    const text = CORRECTION_REPLY.applied(o, undefined, [{ field: "notes", label: "Notes", before: "", after: "", beforeValue: null, afterValue: "x", wasLocked: false }], [{ scope: "customer", text: "Jason always collects" }, { scope: "business", text: "We deliver to Gros Islet on Fridays" }]);
    assert.match(text, /Nothing is saved from this/);
    assert.match(text, /!remember #[A-Z0-9]{5} Jason always collects/);
    assert.match(text, /!teach We deliver to Gros Islet on Fridays/);
    assert.match(text, /customer was not messaged/);
    assert.match(text, /staff-set/);
  });

  test("an ambiguous reply changes nothing and asks for specifics", () => {
    const text = CORRECTION_REPLY.ambiguous(order(), undefined, ["Which Monello?"]);
    assert.match(text, /Nothing changed/);
    assert.match(text, /Which Monello\?/);
  });
});

describe("bulk completion scope", () => {
  const ctx = dayContext(NOW, TZ);
  const day = (requested_for: string | null, over: Partial<TrackedOrder> = {}) => order({ requested_for, ...over });
  const today = day("Wed 28 Oct (today)", { status: "confirmed" });
  const todayDefault = day("Wed 28 Oct (default)", { status: "possible" });
  const tomorrow = day("Thu 29 Oct (tomorrow)");
  const later = day("Sat 31 Oct (Saturday)");
  const overdue = day("Mon 26 Oct (Monday)");
  const undated = day("sometime next week");
  const done = day("Wed 28 Oct (today)", { status: "fulfilled" });
  const cancelled = day("Wed 28 Oct (today)", { status: "cancelled" });

  test("only open orders for today are in scope; tomorrow, later, overdue and undated are counted, never included", () => {
    const scope = bulkScope([tomorrow, today, later, overdue, undated, done, cancelled, todayDefault], ctx);
    assert.deepEqual(scope.today.map((o) => o.id).sort(), [today.id, todayDefault.id].sort());
    assert.deepEqual(scope.excluded, { tomorrow: 1, later: 1, overdue: 1, undated: 1 });
  });

  test("the St Lucia midnight decides what is 'today'", () => {
    const evening = bulkScope([today, tomorrow], dayContext(new Date("2026-10-29T03:59:00Z"), TZ)); // 23:59 on Wed 28th
    assert.deepEqual(evening.today.map((o) => o.id), [today.id]);
    const after = bulkScope([today, tomorrow], dayContext(new Date("2026-10-29T04:01:00Z"), TZ)); // 00:01 on Thu 29th
    assert.deepEqual(after.today.map((o) => o.id), [tomorrow.id]);
    assert.deepEqual(after.excluded.overdue, 1, "yesterday's order is overdue now, so it is no longer swept up");
  });

  test("the preview states the count, what is left alone, that completed means fulfilled, and the token", () => {
    const scope = bulkScope([today, todayDefault, tomorrow, overdue], ctx);
    const text = BULK_REPLY.preview({ code: "B-ABCDE", dateKey: ctx.today, scope });
    assert.match(text, /Complete all of today's outstanding orders — Wed 28 Oct/);
    assert.match(text, /2 orders will be marked \*completed \(fulfilled\)\*/);
    assert.match(text, /1 order not confirmed yet/);
    assert.match(text, /Left alone: 1 tomorrow, 1 overdue/);
    assert.match(text, /fulfilled — delivered or collected — not just hidden/);
    assert.match(text, /NOT messaged/);
    assert.match(text, /!confirm B-ABCDE/);
    assert.match(text, /!discard B-ABCDE/);
  });

  test("a big list is capped in the message, never in the count", () => {
    const many = Array.from({ length: 30 }, () => day("Wed 28 Oct (today)"));
    const text = BULK_REPLY.preview({ code: "B-ABCDE", dateKey: ctx.today, scope: bulkScope(many, ctx) });
    assert.match(text, /30 orders will be marked/);
    assert.match(text, /…and 10 more/);
    assert.ok(text.length < 3500);
  });

  test("nothing to complete says so, and says what was left alone", () => {
    assert.match(BULK_REPLY.none(ctx.today, { tomorrow: 2, later: 0, overdue: 1, undated: 0 }), /Nothing outstanding for today[\s\S]*3 other open orders left alone/);
  });

  test("the result lists completed, skipped and failed orders and how to retry", () => {
    const text = bulkResultText("B-ABCDE", [
      { ref: "O-AAA22", outcome: "completed" },
      { ref: "O-AAA33", outcome: "already_completed" },
      { ref: "O-AAA44", outcome: "skipped", reason: "changed after the preview" },
      { ref: "O-AAA55", outcome: "failed", reason: "timeout" },
    ], ctx.today);
    assert.match(text, /Completed: 1 \(\+1 already completed\)/);
    assert.match(text, /Skipped: 1\n• #AAA44 — changed after the preview/);
    assert.match(text, /Failed: 1\n• #AAA55 — timeout/);
    assert.match(text, /!confirm B-ABCDE again retries only the failed ones/);
    assert.match(text, /Completed = fulfilled/);
  });
});

describe("the cleaner order report", () => {
  const dayless = order({ customer_name: "Dayless Dan", requested_for: "Wed 28 Oct (default)" });
  const stated = order({ customer_name: "Stated Sue", requested_for: "Wed 28 Oct (today)" });
  const timed = order({ customer_name: "Timed Tim", requested_for: "Wed 28 Oct (default, morning)" });
  const explicitTime = order({ customer_name: "Pm Pat", requested_for: "Wed 28 Oct (3pm today)" });
  const unreadable = order({ customer_name: "Vague Vic", requested_for: "sometime next week" });

  test("a line never says 'default day', whether or not the day was defaulted", () => {
    for (const o of [dayless, stated, timed, explicitTime]) {
      const line = orderViewBlock(o, 1, undefined, { timezone: TZ });
      assert.doesNotMatch(line, /default/i, line);
      assert.doesNotMatch(line, /🗓/, "the TODAY/TOMORROW heading already carries the date");
    }
  });

  test("an explicit time is still shown, defaulted day or not", () => {
    assert.match(orderViewBlock(timed, 1, undefined, { timezone: TZ }), /🕐 morning/);
    assert.match(orderViewBlock(explicitTime, 1, undefined, { timezone: TZ }), /🕐 3pm/);
    assert.doesNotMatch(orderViewBlock(stated, 1, undefined, { timezone: TZ }), /🕐/);
  });

  test("where no heading shows the day, the actual date is shown without the provenance", () => {
    const line = orderViewBlock(dayless, 1, undefined, { timezone: TZ, showDate: true });
    assert.match(line, /🗓 Wed 28 Oct(?! \()/);
    assert.doesNotMatch(line, /default/i);
    assert.match(orderViewBlock(unreadable, 1, undefined, { timezone: TZ, showDate: true }), /🗓 “sometime next week” \(no date read\)/);
  });

  test("the whole !orders text never prints the old wording, and the stored value keeps its provenance", () => {
    const view = buildOrdersView({ view: { type: "all" }, orders: [dayless, stated, timed], now: NOW, timezone: TZ }).parts.join("\n");
    assert.doesNotMatch(view, /default day|\(default\)/);
    assert.match(view, /📅 \*TODAY — Wed 28 Oct\* \(3\)/);
    assert.equal(dayless.requested_for, "Wed 28 Oct (default)", "rendering never rewrites the stored day");
  });

  test("scheduling is untouched: a defaulted order is still today's order", () => {
    const view = buildOrdersView({ view: { type: "today" }, orders: [dayless], now: NOW, timezone: TZ }).parts.join("\n");
    assert.match(view, /Dayless Dan/);
  });
});

describe("!rules", () => {
  const text = buildRulesMessages().join("\n");
  test("documents teach, the confirm/discard workflow, complete all and the existing order commands", () => {
    for (const part of ["!order <name, phone or #REF> | #REF confirmed | #REF cancelled | #REF 2 bags | #REF delivery tomorrow | #REF completed | #REF reopen | #REF teach <instruction>", "!orders complete all", "!confirm C-ABCDE", "!discard C-ABCDE", "!orders [today|tomorrow"]) {
      assert.ok(text.includes(part), part);
    }
    assert.match(text, /C- code first; nothing changes until you !confirm C-ABCDE/);
    assert.match(text, /B- code first and changes nothing until you !confirm B-ABCDE/);
    assert.match(text, /fulfilled — delivered or collected, not just hidden/);
    assert.match(text, /knowledge only, not orders/);
  });

  test("every advertised order command really parses", () => {
    assert.equal(parseOrderCommand("!order #ZWL67 teach address is Cap Estate")?.kind, "teach");
    assert.equal(parseOrderCommand("!orders complete all")?.kind, "bulk_complete");
    assert.equal(parseOrderCommand("!confirm C-ABCDE")?.kind, "proposal");
    assert.equal(parseOrderCommand("!discard B-ABCDE")?.kind, "proposal");
    assert.ok(STAFF_COMMANDS.find((c) => c.name === "order")!.summary.includes("never messaged"));
  });
});
