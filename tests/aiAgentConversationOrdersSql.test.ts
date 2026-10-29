// Continuous order understanding end to end: the app's REAL server code (processBridgeMessage → monitor → trackOrders) against the REAL
// migrations in a throwaway Postgres. Only the language model is a scripted stand-in, and the tests also count its calls: replies to
// staff questions must cost none. Covers the Josh/Kyle shape (staff name a bag, the customer says yes), reordering "one bag", staff
// questions for an address and a quantity, staff statements applied to the order, locks and conflicts, duplicates and late messages,
// and Approval Pilot (nothing in any of this can create a customer-bound message). Skips itself without Postgres.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const JOSH = { chat: "17585550301@lid", phone: "17585550301" };
const ANNA = { chat: "17585550302@lid", phone: "17585550302" };
type Customer = typeof JOSH;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type OrderOnly = import("../lib/aiAgent/engine.ts").OrderOnlyProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
type MonitorInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setOrderUpdateProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const monitorCalls: MonitorInput[] = [];
const quiet = (): OrderOnly => ({ intent: "other", order_request: null, staff_action: null });
let monitorScript: (input: MonitorInput) => OrderOnly | null = quiet;
const draft = (over: Partial<Draft> = {}): Draft => ({ items: [{ product: "dog food", quantity: "1", variant: null, size: null }], delivery_address: null, delivery_preference: null, notes: null, requested_for: null, ...over });

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}) {
  const settings = {
    enabled: true, mode: "observe", contact_scope: "none", staff_group_jid: GROUP, staff_notices_enabled: false, customer_memory_enabled: false,
    batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first", staff_authorized_senders: ["17585550001"],
    orders_tracking_enabled: true, orders_summary_enabled: true, orders_group_jid: null, orders_timezone: "America/St_Lucia", orders_summary_hour: 8,
    orders_customer_confirms: false, orders_tracking_since: null, ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = 'dog_food';`);
}

/** A stored message exactly as the bridge saves it, then the same message forwarded to the Inbox. */
async function deliver(c: Customer, who: "customer" | "staff", text: string, at: string, opts: { id?: string; quotes?: string } = {}) {
  const id = opts.id ?? `M-${++seq}`;
  const raw = opts.quotes ? JSON.stringify({ message: { extendedTextMessage: { contextInfo: { stanzaId: opts.quotes } } } }) : JSON.stringify({});
  await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_type, message_body, media_url, whatsapp_message_id, timestamp, raw)
                values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${lit(who === "customer" ? "inbound" : "outbound")}, 'text', ${lit(text)}, null, ${lit(id)}, ${lit(at)}, ${lit(raw)}::jsonb);`);
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: id, chatId: c.chat, contactNumber: c.phone, fromMe: who === "staff", text, hasMedia: false,
    quotedMessageId: opts.quotes ?? null, senderJid: null, timestamp: at,
  });
}
const allOrders = (chat?: string) => rows<Record<string, any>>(`select * from public.ai_agent_orders ${chat ? `where chat_id = ${lit(chat)}` : ""} order by created_at, id`);
const orderEvents = (orderId?: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_events ${orderId ? `where order_id = ${lit(orderId)}` : ""} order by created_at, id`);
const lastReasons = async (chat: string) => (await rows<{ reason_codes: string[] }>(`select reason_codes from public.ai_agent_events where chat_id = ${lit(chat)} order by created_at, id`)).at(-1)?.reason_codes ?? [];
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const lines = (o: Record<string, any>) => o.items.map((i: any) => [i.product, i.quantity, i.size ?? null]);

let seeded = 0;
/** An earlier order of this customer as it sits in the book (default: fulfilled, so a verified purchase). */
async function seed(c: Customer, items: { product: string; quantity: string; size?: string | null }[], over: { status?: string; at?: string; address?: string | null } = {}) {
  seeded += 1;
  const at = over.at ?? `2026-09-${String(10 + seeded).padStart(2, "0")}T14:00:00Z`;
  const full = items.map((i) => ({ product: i.product, quantity: i.quantity, variant: null, size: i.size ?? null }));
  const address = over.address === undefined ? "Cap Estate" : over.address;
  await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, status, items, fulfilment_method, delivery_address, missing_fields, manual_locked_fields, first_message_at, last_message_at)
    values (${lit(`O-SD${String(seeded).padStart(3, "0")}`)}, 'dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${lit(over.status ?? "fulfilled")}, ${lit(JSON.stringify(full))}::jsonb, ${address ? "'delivery'" : "null"}, ${address ? lit(address) : "null"}, '{}', '{}', ${lit(at)}, ${lit(at)});`);
}
const live = async (chat: string) => (await allOrders(chat)).filter((o) => !String(o.ref_code).startsWith("O-SD0"));

/** The customer places an order for "a bag of dog food" (the model reads the product as the customer's own category word). */
async function dogFoodOrder(c: Customer, at = "2026-10-27T14:00:00Z", over: Partial<Draft> = {}) {
  monitorScript = () => ({ intent: "order", order_request: draft(over), order_target: "new", staff_action: null });
  await deliver(c, "customer", over.delivery_address ? `I need a bag of dog food delivered to ${over.delivery_address}` : "I need a bag of dog food please", at);
  monitorScript = quiet;
  const made = (await live(c.chat))[0];
  assert.ok(made, `the order was created (reasons: ${(await lastReasons(c.chat)).join(",")})`);
  return made;
}

describe("Continuous order understanding (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text, message_type text,
        message_body text, media_url text, whatsapp_message_id text, timestamp timestamptz default now(), raw jsonb
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    orders = await import("../lib/server/aiAgent/orders.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setOrderUpdateProposerForTests(async (input) => {
      monitorCalls.push(input);
      const proposal = monitorScript(input);
      return proposal ? { proposal, model: "scripted-small", error: null } : { proposal: null, model: "scripted-small", error: "model unavailable" };
    });
  });
  after(() => {
    model?.setOrderUpdateProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations,
        public.ai_agent_outbox, public.ai_agent_events, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.whatsapp_messages cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null, orders_tracking_enabled = false;`);
    await configure();
    monitorCalls.length = 0;
    monitorScript = quiet;
  });

  // ── Staff name a product, the customer confirms ────────────────────────────

  test("Josh/Kyle: staff ask which bag and name Bandit 25kg, the customer says yes: the order's product is Bandit 25kg, with no model call", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    assert.deepEqual(lines(o), [["dog food", "1", null]]);
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg?", "2026-10-27T14:03:00Z", { id: "KYLE-Q" });
    assert.deepEqual(lines((await live(JOSH.chat))[0]), [["dog food", "1", null]], "a staff question changes nothing");

    const before = monitorCalls.length;
    await deliver(JOSH, "customer", "Yes, that one.", "2026-10-27T14:05:00Z", { id: "JOSH-A" });
    assert.equal(monitorCalls.length, before, "an answer to a staff question needs no model call");
    const [after] = await live(JOSH.chat);
    assert.deepEqual(lines(after), [["Bandit", "1", "25kg"]], "the quantity the customer asked for is kept");
    assert.equal(after.delivery_address, "Cap Estate");
    assert.ok((await lastReasons(JOSH.chat)).includes("order_answer_applied_product"));
    const ev = (await orderEvents(after.id)).find((e) => e.kind === "conversation_answer")!;
    assert.equal(ev.actor_kind, "customer");
    assert.equal(ev.changes.answer_source.after.question_message_id, "KYLE-Q");
    assert.match(ev.changes.answer_source.after.question, /Which bag did you want/);
    assert.equal(ev.changes.answer_source.after.answer, "Yes, that one.");
    assert.ok(ev.whatsapp_message_ids.includes("JOSH-A") && ev.whatsapp_message_ids.includes("KYLE-Q"), "both messages are referenced");
    assert.equal(await customerBound(), 0);
    assert.equal(await count(`select 1 from public.ai_agent_outbox`), 0, "nothing was sent to anyone");
    assert.equal(after.attention, null);
  });

  test("an unanswered staff suggestion is never a confirmation, and an ambiguous yes picks nothing", async () => {
    await seed(JOSH, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }]);
    await seed(JOSH, [{ product: "Bandit", quantity: "1", size: "25kg" }]);
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "thanks", "2026-10-27T14:04:00Z");
    assert.deepEqual(lines((await live(JOSH.chat))[0]), [["dog food", "1", null]], "silence is not yes");
    // Two products offered and a bare yes: nothing is chosen.
    await deliver(JOSH, "staff", "Do you want the Bandit 25kg or the Monello Chicken 25kg?", "2026-10-27T14:10:00Z", { id: "Q2" });
    await deliver(JOSH, "customer", "Yes", "2026-10-27T14:11:00Z");
    const [after] = await live(JOSH.chat);
    assert.deepEqual(lines(after), [["dog food", "1", null]]);
    assert.equal(after.attention, "customer_answer_unclear");
    const flagged = (await orderEvents(o.id)).find((e) => e.changes.answer_unclear);
    assert.match(flagged!.changes.answer_unclear.after.question, /Bandit 25kg or the Monello/);
    assert.ok((await lastReasons(JOSH.chat)).includes("order_answer_ambiguous"));
  });

  test("naming one of two offered products picks that one", async () => {
    await seed(JOSH, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }]);
    await dogFoodOrder(JOSH);
    await deliver(JOSH, "staff", "Which one, Bandit 25kg or Monello Chicken 25kg?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "the monello one", "2026-10-27T14:04:00Z");
    assert.deepEqual(lines((await live(JOSH.chat))[0]).map((l: unknown[]) => l[0]), ["Monello Chicken"]);
  });

  test("a yes/no question never replaces a different specific product: it becomes a conflict for a person", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Monello", quantity: "2", variant: "Chicken", size: "25kg" }] }), order_target: "new", staff_action: null });
    await deliver(JOSH, "customer", "Please send 2 Monello Chicken 25kg to Cap Estate", "2026-10-27T14:00:00Z");
    monitorScript = quiet;
    await deliver(JOSH, "staff", "Do you want the Bandit 25kg?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "Yes", "2026-10-27T14:04:00Z");
    const [o] = await live(JOSH.chat);
    assert.equal(o.items[0].product, "Monello", "not overwritten");
    assert.equal(o.field_conflicts.items.proposed[0].product, "Bandit");
    assert.equal(o.field_conflicts.items.source, "customer");
    assert.equal(o.field_conflicts.items.evidence, "Yes");
    assert.match(orders.ORDER_COLUMNS, /field_conflicts/);
  });

  // ── Staff ask, the customer answers ───────────────────────────────────────

  test("staff ask for the delivery address and the customer answers: the address is filled, no model call", async () => {
    const o = await dogFoodOrder(JOSH);
    assert.equal(o.delivery_address, null);
    await deliver(JOSH, "staff", "Hi Josh, where should we deliver?", "2026-10-27T14:03:00Z", { id: "Q-ADDR" });
    const before = monitorCalls.length;
    await deliver(JOSH, "customer", "Cap Estate", "2026-10-27T14:04:00Z");
    assert.equal(monitorCalls.length, before);
    const [after] = await live(JOSH.chat);
    assert.equal(after.delivery_address, "Cap Estate");
    assert.ok(!after.missing_fields.includes("delivery_address"));
    assert.equal(after.status, "awaiting_confirmation", "complete now, nobody has confirmed it");
    assert.equal((await orderEvents(after.id)).filter((e) => e.kind === "conversation_answer").length, 1);
    assert.equal(await customerBound(), 0);
  });

  test("staff ask how many and the customer says two: the quantity is set on the line that lacks one", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Bandit", quantity: null, variant: null, size: "25kg" }], delivery_address: "Cap Estate" }), order_target: "new", staff_action: null });
    await deliver(JOSH, "customer", "Bandit 25kg to Cap Estate please", "2026-10-27T14:00:00Z");
    monitorScript = quiet;
    assert.equal((await live(JOSH.chat))[0].items[0].quantity, null);
    await deliver(JOSH, "staff", "How many bags?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "two", "2026-10-27T14:04:00Z");
    const [o] = await live(JOSH.chat);
    assert.deepEqual(lines(o), [["Bandit", "2", "25kg"]]);
    assert.equal(await customerBound(), 0);
  });

  test("a reply that is not an answer goes through the usual reading, and nothing is invented", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await deliver(JOSH, "staff", "Where should we deliver?", "2026-10-27T14:03:00Z");
    const before = monitorCalls.length;
    await deliver(JOSH, "customer", "Can you do Friday instead?", "2026-10-27T14:04:00Z");
    assert.equal(monitorCalls.length, before + 1, "a question is read by the order reader");
    assert.equal((await live(JOSH.chat))[0].delivery_address, "Cap Estate");
  });

  test("with two open orders a bare answer is not guessed", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z");
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Whiskas", quantity: "1", variant: null, size: null }] }), order_target: "new", staff_action: null });
    await deliver(JOSH, "customer", "And a box of Whiskas", "2026-10-27T14:01:00Z");
    monitorScript = quiet;
    assert.equal((await live(JOSH.chat)).length, 2);
    await deliver(JOSH, "staff", "Where should we deliver?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "Cap Estate", "2026-10-27T14:04:00Z");
    assert.deepEqual((await live(JOSH.chat)).map((o) => o.delivery_address), [null, null]);
    assert.ok((await lastReasons(JOSH.chat)).includes("order_answer_ambiguous_order"));
  });

  // ── Staff locks ────────────────────────────────────────────────────────────

  test("a customer's answer that contradicts an address staff set is a specific conflict, never an overwrite", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Rodney Bay" });
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "edit", patch: { delivery_address: "Gros Islet" } });
    await deliver(JOSH, "staff", "Is the address still Gros Islet? Where should we deliver?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "Cap Estate", "2026-10-27T14:04:00Z");
    const [after] = await live(JOSH.chat);
    assert.equal(after.delivery_address, "Gros Islet", "the staff edit stands");
    assert.equal(after.field_conflicts.delivery_address.proposed, "Cap Estate");
    assert.equal(after.field_conflicts.delivery_address.current, "Gros Islet");
    assert.equal(after.field_conflicts.delivery_address.evidence, "Cap Estate");
    assert.ok((await lastReasons(JOSH.chat)).includes("order_answer_conflict"));
    const text = (await import("../lib/aiAgent/orders.ts")).orderWarning(after as never);
    assert.equal(text, "Customer asked for a change — check before fulfilling");
  });

  // ── Duplicates and late messages ──────────────────────────────────────────

  test("a redelivered reply, and a replayed staff question, change nothing a second time", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg?", "2026-10-27T14:03:00Z", { id: "Q1" });
    await deliver(JOSH, "customer", "Yes, that one.", "2026-10-27T14:05:00Z", { id: "A1" });
    const [first] = await live(JOSH.chat);
    const events = (await orderEvents(first.id)).length;
    await decide.processBridgeMessage({ businessSlug: "dog_food", whatsappMessageId: "A1", chatId: JOSH.chat, contactNumber: JOSH.phone, fromMe: false, text: "Yes, that one.", hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: "2026-10-27T14:05:00Z" });
    await decide.processBridgeMessage({ businessSlug: "dog_food", whatsappMessageId: "Q1", chatId: JOSH.chat, contactNumber: JOSH.phone, fromMe: true, text: "Which bag did you want, Bandit 25kg?", hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: "2026-10-27T14:03:00Z" });
    const [again] = await live(JOSH.chat);
    assert.equal(again.version, first.version);
    assert.equal((await orderEvents(again.id)).length, events);
  });

  test("a late reply never overwrites what a newer customer message already set", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg?", "2026-10-27T14:03:00Z");
    // The customer's NEWER message is processed first (a delayed delivery of the earlier one).
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "dog food", quantity: "2", variant: null, size: null }], delivery_address: "Cap Estate" }), order_target: null, staff_action: null });
    await deliver(JOSH, "customer", "Actually make it 2 bags of dog food", "2026-10-27T14:09:00Z");
    monitorScript = quiet;
    await deliver(JOSH, "customer", "Yes, that one.", "2026-10-27T14:05:00Z");
    const [o] = await live(JOSH.chat);
    assert.deepEqual(lines(o), [["dog food", "2", null]]);
    assert.ok((await lastReasons(JOSH.chat)).includes("order_answer_superseded"));
  });

  // ── "Send me one bag" ──────────────────────────────────────────────────────

  const sendOneBag = async (c: Customer, at: string) => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "bag", quantity: "1", variant: null, size: null }], delivery_address: "Cap Estate" }), order_target: "new", staff_action: null });
    await deliver(c, "customer", "Send me one bag", at);
    monitorScript = quiet;
    return (await live(c.chat)).at(-1)!;
  };

  test("the product the customer confirmed in this conversation is used, with its source recorded", async () => {
    await seed(JOSH, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }], { at: "2026-09-01T14:00:00Z" });
    const first = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg?", "2026-10-27T14:03:00Z", { id: "Q1" });
    await deliver(JOSH, "customer", "Yes, that one.", "2026-10-27T14:05:00Z");
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: first.id, adminId: "u", action: "fulfil" });
    const o = await sendOneBag(JOSH, "2026-10-28T14:00:00Z");
    assert.deepEqual(lines(o), [["Bandit", "1", "25kg"]], "the latest explicitly confirmed product, not the older Monello");
    const ev = (await orderEvents(o.id)).find((e) => e.kind === "created" || e.changes.product_source)!;
    assert.equal(ev.changes.product_source.after[0].source, "conversation_confirmed");
    assert.equal(ev.changes.product_source.after[0].staffMessageId, "Q1");
    assert.equal(await customerBound(), 0);
  });

  test("with a single verified product it is used, and its order is the recorded source", async () => {
    await seed(ANNA, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], { at: "2026-09-12T14:00:00Z" });
    await seed(ANNA, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }], { at: "2026-09-20T14:00:00Z" });
    const o = await sendOneBag(ANNA, "2026-10-27T14:00:00Z");
    assert.deepEqual(lines(o), [["Monello Chicken", "1", "25kg"]]);
    const ev = (await orderEvents(o.id)).find((e) => e.changes.product_source)!;
    assert.equal(ev.changes.product_source.after[0].source, "order_history");
    assert.match(ev.changes.product_source.after[0].ref, /^O-SD/);
  });

  test("several previous products and no confirmation: no product is assumed, and a person is told why", async () => {
    await seed(ANNA, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }], { at: "2026-09-12T14:00:00Z" });
    await seed(ANNA, [{ product: "Bandit", quantity: "1", size: "25kg" }], { at: "2026-09-20T14:00:00Z" });
    const o = await sendOneBag(ANNA, "2026-10-27T14:00:00Z");
    assert.ok(o, "the request is kept");
    assert.deepEqual(o.items, [], "no product was invented");
    assert.equal(o.attention, "history_unresolved");
    assert.match(o.notes, /Send me one bag/);
    const ev = (await orderEvents(o.id))[0];
    assert.match(ev.changes.inferred.after.unresolved[0], /Bandit 25kg or Monello Chicken 25kg|Monello Chicken 25kg or Bandit 25kg/);
  });

  test("quotations, cancelled orders and unconfirmed drafts are not purchases", async () => {
    await seed(ANNA, [{ product: "Whiskas", quantity: "1" }], { status: "cancelled" });
    await seed(ANNA, [{ product: "Pedigree", quantity: "1" }], { status: "possible" });
    const o = await sendOneBag(ANNA, "2026-10-27T14:00:00Z");
    assert.deepEqual(o.items, []);
    assert.equal(o.attention, "history_unresolved");
  });

  test("one customer's history never reaches another's, or another business's", async () => {
    await seed(JOSH, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }]);
    const o = await sendOneBag(ANNA, "2026-10-27T14:00:00Z");
    assert.deepEqual(o.items, [], "Anna has no history of her own");
  });

  // ── What staff state ───────────────────────────────────────────────────────

  const staffSays = (text: string, stateScript: OrderOnly, at = "2026-10-27T14:10:00Z") => {
    monitorScript = () => stateScript;
    return deliver(JOSH, "staff", text, at);
  };
  const changing = (order: Partial<Draft>, unresolved: string | null = null): OrderOnly => ({
    intent: "other",
    order_request: null,
    staff_action: "changes",
    staff_changes: { order: { items: [], delivery_address: null, delivery_preference: null, notes: null, ...order }, unresolved },
  });

  test("a change staff state is applied to the order, with the staff message as its source, and no generic warning", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Rodney Bay" });
    await staffSays("We'll send 2 bags of Bandit 25kg to Cap Estate", changing({ items: [{ product: "Bandit", quantity: "2", size: "25kg" }], delivery_address: "Cap Estate" }));
    const [after] = await live(JOSH.chat);
    assert.equal(after.delivery_address, "Cap Estate");
    assert.equal(after.items.length, 2, "a stated product is added when staff do not say it replaces one");
    assert.ok(after.items.some((i: any) => i.product === "Bandit" && i.quantity === "2"));
    assert.notEqual(after.attention, "staff_changed_in_chat");
    assert.equal(after.attention, null);
    const ev = (await orderEvents(o.id)).find((e) => e.kind === "staff_change_applied")!;
    assert.equal(ev.actor_kind, "staff");
    assert.match(ev.changes.staff_message.after, /We'll send 2 bags/);
    assert.equal(ev.changes.change_source.after.source, "staff_message");
    assert.equal(after.manual_locked_fields.length, 0, "chat statements do not lock fields");
    assert.equal(after.last_message_at, o.last_message_at, "a staff message is not customer activity");
    assert.equal(await customerBound(), 0);
  });

  test("'instead' replaces the only product; a quantity-only statement updates it", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await staffSays("We'll send the Bandit 25kg instead", changing({ items: [{ product: "Bandit", quantity: null, size: "25kg" }] }));
    assert.deepEqual(lines((await live(JOSH.chat))[0]), [["Bandit", "1", "25kg"]]);
    await staffSays("That's 3 bags then", changing({ items: [{ product: "bags", quantity: "3" }] }), "2026-10-27T14:20:00Z");
    assert.deepEqual(lines((await live(JOSH.chat))[0]), [["Bandit", "3", "25kg"]]);
  });

  test("a question, an offer or a hedge changes nothing and raises nothing", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    const before = JSON.stringify(await live(JOSH.chat));
    for (const [i, text] of ["Would you like 2 bags of Bandit 25kg?", "We might be able to send Bandit 25kg instead", "Should we deliver to Gros Islet?"].entries()) {
      await staffSays(text, changing({ items: [{ product: "Bandit", quantity: "2", size: "25kg" }], delivery_address: "Gros Islet" }), `2026-10-27T14:${10 + i}:00Z`);
    }
    assert.equal(JSON.stringify(await live(JOSH.chat)), before);
  });

  test("a value the staff never wrote is not applied (grounded in the staff words)", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await staffSays("We'll send it tomorrow", changing({ items: [{ product: "Whiskas", quantity: "9" }], delivery_address: "Vieux Fort" }));
    const [o] = await live(JOSH.chat);
    assert.deepEqual(lines(o), [["dog food", "1", null]]);
    assert.equal(o.delivery_address, "Cap Estate");
  });

  test("a staff change that cannot be matched to a field is flagged specifically, with the staff words", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await staffSays("We'll send a different bag size for you", changing({}, "a different bag size, none named"));
    const [after] = await live(JOSH.chat);
    assert.equal(after.attention, "staff_change_unclear");
    const ev = (await orderEvents(o.id)).find((e) => e.kind === "staff_noted_in_chat")!;
    assert.match(ev.changes.staff_message.after, /different bag size/);
    assert.match(ev.changes.staff_change_unclear.after, /bag size/);
    const info = (await import("../lib/aiAgent/orderCommands.ts")).moreInfoReply({ order: after as never, name: undefined, events: (await orderEvents(o.id)).reverse() as never[], timezone: "America/St_Lucia" });
    assert.match(info, /Staff wrote: “We'll send a different bag size for you”/);
  });

  test("the retired generic warning on an old order is cleared once the change is understood", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    await pg.run(`update public.ai_agent_orders set attention = 'staff_changed_in_chat' where id = ${lit(o.id)};`);
    await staffSays("We'll send 3 bags of dog food", changing({ items: [{ product: "dog food", quantity: "3" }] }));
    const [after] = await live(JOSH.chat);
    assert.equal(after.attention, null);
    assert.deepEqual(lines(after), [["dog food", "3", null]]);
  });

  test("staff words that contradict an address staff edited in the dashboard become a conflict naming the staff message", async () => {
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Rodney Bay" });
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "edit", patch: { delivery_address: "Gros Islet" } });
    await staffSays("We'll deliver to Cap Estate", changing({ delivery_address: "Cap Estate" }));
    const [after] = await live(JOSH.chat);
    assert.equal(after.delivery_address, "Gros Islet");
    assert.equal(after.field_conflicts.delivery_address.source, "staff_chat");
    assert.match(after.field_conflicts.delivery_address.evidence, /deliver to Cap Estate/);
    const { orderWarning, conflictText } = await import("../lib/aiAgent/orders.ts");
    assert.match(orderWarning(after as never)!, /Staff wrote a different detail in chat/);
    assert.match(conflictText("delivery_address", after.field_conflicts.delivery_address), /Cap Estate \(the order has Gros Islet, edited by staff\)/);
    assert.deepEqual(after.manual_locked_fields, ["delivery_address"]);
  });

  test("with two open orders and no clear reference a staff statement is not guessed", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z");
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Whiskas", quantity: "1", variant: null, size: null }] }), order_target: "new", staff_action: null });
    await deliver(JOSH, "customer", "And a box of Whiskas", "2026-10-27T14:01:00Z");
    const before = JSON.stringify(await live(JOSH.chat));
    await staffSays("We'll deliver to Cap Estate", changing({ delivery_address: "Cap Estate" }));
    assert.equal(JSON.stringify(await live(JOSH.chat)), before);
    assert.ok((await lastReasons(JOSH.chat)).includes("orders_monitor_staff_ambiguous"));
  });

  test("a delivery day staff commit to is still applied by rules, with no model call", async () => {
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    const before = monitorCalls.length;
    await deliver(JOSH, "staff", "We will deliver tomorrow", "2026-10-27T15:00:00Z");
    assert.equal(monitorCalls.length, before);
    assert.equal((await live(JOSH.chat))[0].requested_for, "Wed 28 Oct");
  });

  // ── Approval Pilot and !update ─────────────────────────────────────────────

  test("in Approval Pilot none of this creates a customer-bound message or an approval", async () => {
    await configure({ mode: "approval_pilot", staff_notices_enabled: true });
    await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z");
    await deliver(JOSH, "staff", "Which bag did you want, Bandit 25kg? And where should we deliver?", "2026-10-27T14:03:00Z");
    await deliver(JOSH, "customer", "Yes, that one.", "2026-10-27T14:05:00Z");
    await staffSays("We'll send 2 bags", changing({ items: [{ product: "bags", quantity: "2" }] }), "2026-10-27T14:20:00Z");
    assert.deepEqual(lines((await live(JOSH.chat))[0]), [["Bandit", "2", "25kg"]]);
    assert.equal(await customerBound(), 0);
    assert.equal(await count(`select 1 from public.ai_agent_pilot_drafts`), 0);
    assert.equal(await count(`select 1 from public.ai_agent_escalations`), 0);
  });

  test("!update is no longer a command, and the 8 AM summary still runs", async () => {
    await configure({ staff_notices_enabled: true });
    const o = await dogFoodOrder(JOSH, "2026-10-27T14:00:00Z", { delivery_address: "Cap Estate" });
    const res = await decide.processBridgeMessage({ businessSlug: "dog_food", whatsappMessageId: "UPD-1", chatId: GROUP, contactNumber: null, fromMe: false, text: "!update", hasMedia: false, quotedMessageId: null, senderJid: "17585550001@s.whatsapp.net", timestamp: "2026-10-27T14:30:00Z" } as never);
    assert.deepEqual(res.outbox.filter((m: { body: string }) => /order/i.test(m.body)), []);
    assert.equal(await count(`select 1 from public.ai_agent_order_update_posts`), 0);
    const settings = (await dbmod.loadSettings("dog_food"))!;
    assert.equal(await orders.runScheduledSummary(settings, new Date("2026-10-28T12:05:00Z")), "sent");
    const [summary] = await rows<{ body: string }>(`select body from public.ai_agent_outbox where kind = 'staff_notice' order by created_at desc limit 1`);
    assert.match(summary.body, /ORDERS — Wed 28 Oct/);
    assert.match(summary.body, new RegExp(o.ref_code.slice(2)));
  });
});
