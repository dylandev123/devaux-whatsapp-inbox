// Customer order memory and incremental order maintenance, end to end: the app's REAL server code (processBridgeMessage →
// order tracking → order records) against the REAL migrations in a throwaway Postgres. Only the language model is replaced
// by a scripted stand-in. Skips itself when no Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const STAFF = "17585550001@s.whatsapp.net";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let monitor: typeof import("../lib/server/aiAgent/orderMonitor.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
type ProposeInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE", intent: "other", reply: null, confidence: 0.2, knowledge_ids: [], escalation_reason: "needs staff",
  priority: null, summary: null, order_request: null, memory_facts: [], ...over,
});
let script: () => Proposal = () => proposal();
const modelCalls: ProposeInput[] = [];
type UpdateInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setOrderUpdateProposerForTests>[0] & {}>[0];
/** Calls of the small order-only model (monitoring, and the reply path when the legacy "same as last time" check skips the reply model). */
const updateCalls: UpdateInput[] = [];
/** The order-only model reads the turn like the scripted reply model would. */
const orderOnlyFromScript = async (input: UpdateInput) => {
  updateCalls.push(input);
  const p = script();
  return { proposal: { intent: p.intent, order_request: p.order_request, order_target: p.order_target, other_orders: p.other_orders, staff_action: null }, model: "scripted", error: null };
};
const historyShown = () => (modelCalls.at(-1) ?? updateCalls.at(-1))?.orderHistory;

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true, mode: "approval_pilot", contact_scope: "all", staff_group_jid: group, staff_notices_enabled: true,
    customer_memory_enabled: false, batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"], orders_tracking_enabled: true, orders_summary_enabled: true, orders_group_jid: null,
    orders_timezone: "America/St_Lucia", orders_summary_hour: 8, orders_customer_confirms: false, orders_tracking_since: null, ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}

const draft = (over: Partial<Draft> = {}): Draft => ({
  items: [{ product: "Monello Chicken", quantity: "1", size: "25kg" }],
  delivery_address: null, delivery_preference: null, notes: null, requested_for: null, ...over,
});
/** The model reads the turn as an order and drafts this (or nothing). */
const modelOrders = (d: Draft | null, extra: Partial<Proposal> = {}) => {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order", ...extra });
};

const MONDAY = "2026-10-26T14:00:00.000Z";

async function say(chat: string, phone: string | null, text: string, opts: { biz?: string; id?: string; at?: string } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `CUST-${++seq}`, chatId: chat, contactNumber: phone, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: opts.at ?? MONDAY,
  });
}
const customerSays = (c: Customer, text: string, opts: { biz?: string; id?: string; at?: string } = {}) => say(c.chat, c.phone, text, opts);

async function groupSays(text: string, opts: { id?: string; biz?: string; group?: string } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `GRP-${++seq}`, chatId: opts.group ?? GROUP, contactNumber: null,
    fromMe: false, text, hasMedia: false, quotedMessageId: null, senderJid: STAFF, senderPhone: null, timestamp: new Date().toISOString(),
  });
}

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderEvents = (orderId: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_events where order_id = ${lit(orderId)} order by created_at, id`);
const ref = (o: Record<string, any>) => `#${String(o.ref_code).slice(2)}`;
const reply = (res: { outbox: { body: string }[] }) => res.outbox.map((o) => o.body).join("\n---\n");

let seeded = 0;
/** An earlier order of this customer, as it sits in the order book (default: fulfilled, so a reliable source). */
async function seed(
  c: { chat: string; phone: string | null },
  items: { product: string; quantity: string | null; size?: string | null; variant?: string | null }[],
  over: { status?: string; address?: string | null; method?: string | null; at?: string; locked?: string[]; biz?: string; ref?: string } = {}
) {
  seeded += 1;
  const at = over.at ?? `2026-10-${String(10 + seeded).padStart(2, "0")}T14:00:00Z`;
  const full = items.map((i) => ({ product: i.product, quantity: i.quantity, variant: i.variant ?? null, size: i.size ?? null }));
  const address = over.address === undefined ? null : over.address;
  await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, status, items, fulfilment_method, delivery_address, missing_fields, manual_locked_fields, first_message_at, last_message_at)
    values (${lit(over.ref ?? `O-SD${String(seeded).padStart(3, "0")}`)}, ${lit(over.biz ?? "dog_food")}, ${lit(c.chat)}, ${c.phone ? lit(c.phone) : "null"}, ${lit(over.status ?? "fulfilled")},
      ${lit(JSON.stringify(full))}::jsonb, ${over.method === undefined ? (address ? "'delivery'" : "null") : over.method ? lit(over.method) : "null"}, ${address ? lit(address) : "null"}, '{}',
      array[${(over.locked ?? []).map(lit).join(",")}]::text[], ${lit(at)}, ${lit(at)});`);
  return (await rows<Record<string, any>>(`select * from public.ai_agent_orders where ref_code = ${lit(over.ref ?? `O-SD${String(seeded).padStart(3, "0")}`)}`))[0];
}
/** The orders the live conversation created (not the seeded history). */
const live = async (biz = "dog_food") => (await allOrders(biz)).filter((o) => !String(o.ref_code).startsWith("O-SD"));
const lines = (o: Record<string, any>) => o.items.map((i: any) => [i.product, i.quantity, i.size ?? null]);

describe("Customer order memory (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, contact_name text, business_contact_name text,
        direction text, message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );
      create table if not exists public.customers (
        phone_number text primary key, first_name text, last_name text, whatsapp_name text, business_contact_name text
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    orders = await import("../lib/server/aiAgent/orders.ts");
    monitor = await import("../lib/server/aiAgent/orderMonitor.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async (input) => {
      modelCalls.push(input);
      return { proposal: script(), model: "scripted", error: null };
    });
    model.setOrderUpdateProposerForTests(orderOnlyFromScript);
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    model?.setOrderUpdateProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts,
        public.ai_agent_shadow_results, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls.length = 0;
    updateCalls.length = 0;
    seeded = 0;
    script = () => proposal();
  });

  // ── "Same as last time" and friends ────────────────────────────────────────

  test("'same as last time' brings in the most recent verified order, with its quantities, and says where it came from", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], { address: "Gros Islet" });
    const last = await seed(JANE, [{ product: "Bandit", quantity: "1", size: "15kg" }, { product: "Monello Chicken", quantity: "3", size: "25kg" }], { address: "Cap Estate" });
    modelOrders(null);
    await customerSays(JANE, "Same as last time please");
    const [o] = await live();
    assert.deepEqual(lines(o), [["Bandit", "1", "15kg"], ["Monello Chicken", "3", "25kg"]]);
    assert.equal(o.delivery_address, null, "an address is only reused when the customer says so");
    assert.equal(o.status, "possible", "nothing is confirmed by history");
    const events = await orderEvents(o.id);
    assert.deepEqual(events[0].changes.inferred.after.items, [last.ref_code]);
    assert.equal(await customerBound(), 0);
    const info = (await groupSays(`!moreinfo ${ref(o)}`)).outbox.map((x) => x.body).join("\n");
    assert.match(info, new RegExp(`From earlier orders: products from #${last.ref_code.slice(2)}`));
  });

  test("a retry changes nothing: the same message twice, and the same turn twice, never duplicate the lines", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    modelOrders(null);
    await customerSays(JANE, "same as last time", { id: "RETRY-1" });
    await customerSays(JANE, "same as last time", { id: "RETRY-1" });
    const [o] = await live();
    assert.equal((await live()).length, 1);
    assert.deepEqual(lines(o), [["Monello Chicken", "2", "25kg"]]);
    // A genuinely new "same as last time" on the same order adds nothing either: the product is already there.
    await customerSays(JANE, "same as last time", { id: "RETRY-2" });
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "2", "25kg"]]);
    assert.equal((await orderEvents(o.id)).length, 1);
  });

  test("an unconfirmed enquiry is not history: the request is flagged for a person, nothing is copied from it", async () => {
    const enquiry = await seed(JANE, [{ product: "Bandit", quantity: "9" }], { status: "awaiting_confirmation" });
    modelOrders(null);
    await customerSays(JANE, "Same as last time");
    const [after] = await allOrders();
    assert.equal(after.id, enquiry.id, "it joins the one open order rather than starting another");
    assert.deepEqual(lines(after), [["Bandit", "9", null]], "the open order's own lines are not 'history' and nothing was added");
    assert.equal(after.attention, "history_unresolved");
    const report = (await groupSays("!orders all")).outbox.map((x) => x.body).join("\n");
    assert.match(report, /⚠️ Refers to an earlier order — check/);
    assert.equal(await customerBound(), 0);
  });

  test("with no open order and only an enquiry elsewhere, a note-only order carries the customer's words", async () => {
    await seed({ chat: "17585550101@c.us", phone: JANE.phone }, [{ product: "Bandit", quantity: "9" }], { status: "cancelled" });
    modelOrders(null);
    await customerSays(JANE, "Same as last time");
    const [o] = await live();
    assert.deepEqual([o.items, o.attention, o.notes], [[], "history_unresolved", "Same as last time"]);
    assert.match((await groupSays("!orders all")).outbox.map((x) => x.body).join("\n"), /Note: Same as last time/);
  });

  test("a customer with no history at all gets a flagged note, never an invented order", async () => {
    modelOrders(null);
    await customerSays(JANE, "the usual please");
    const [o] = await live();
    assert.deepEqual([o.items.length, o.attention], [0, "history_unresolved"]);
  });

  test("a question that mentions the usual is not an order", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    script = () => proposal({ intent: "question", order_request: null });
    await customerSays(JANE, "Is it the usual price?");
    assert.equal((await live()).length, 0);
  });

  test("'two bags this time' reuses the last order's product with the new quantity", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }]);
    modelOrders(null);
    await customerSays(JANE, "Two bags this time");
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "2", "25kg"]]);
  });

  test("'same as usual, plus 4 pool salt' keeps the usual order and appends the new line", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    await seed(JANE, [{ product: "Bandit", quantity: "1", size: "15kg" }]);
    modelOrders(draft({ items: [{ product: "Pool Salt", quantity: "4" }] }));
    await customerSays(JANE, "Same as usual, plus 4 pool salt");
    const [o] = await live();
    assert.deepEqual(lines(o), [["Pool Salt", "4", null], ["Monello Chicken", "2", "25kg"]]);
  });

  test("the most recent order and the usual one are different things", async () => {
    const usual = () => seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    await usual();
    await usual();
    await seed(JANE, [{ product: "Bandit", quantity: "1", size: "15kg" }]);
    modelOrders(null);
    await customerSays(JANE, "same as last time");
    assert.deepEqual(lines((await live())[0]), [["Bandit", "1", "15kg"]]);
    await customerSays(MARCUS, "hi");
    await seed(MARCUS, [{ product: "Monello Chicken", quantity: "2" }]);
    await seed(MARCUS, [{ product: "Bandit", quantity: "1" }]);
    await customerSays(MARCUS, "the usual");
    const marcus = (await live()).find((o) => o.chat_id === MARCUS.chat)!;
    assert.deepEqual(marcus.items, [], "two different orders and no repeat: the usual is unclear, so it is left for a person");
    assert.equal(marcus.attention, "history_unresolved");
  });

  test("'same location' reuses the most recent verified address; multiple addresses, collection orders and enquiries are respected", async () => {
    await seed(JANE, [{ product: "Bandit", quantity: "1" }], { address: "Gros Islet" });
    await seed(JANE, [{ product: "Bandit", quantity: "1" }], { address: "Cap Estate" });
    await seed(JANE, [{ product: "Bandit", quantity: "1" }], { method: "collection", address: "The shop" });
    await seed({ chat: "17585550101@c.us", phone: JANE.phone }, [{ product: "Bandit", quantity: "1" }], { status: "awaiting_confirmation", address: "Rodney Bay" });
    modelOrders(draft());
    await customerSays(JANE, "A bag of Monello Chicken 25kg");
    modelOrders(draft());
    await customerSays(JANE, "Deliver to the same location");
    const [o] = await live();
    assert.equal(o.delivery_address, "Cap Estate");
    assert.equal(o.fulfilment_method, "delivery");
    const inferred = (await orderEvents(o.id)).at(-1)!.changes.inferred.after;
    assert.ok(inferred.delivery_address.startsWith("O-SD"));
    assert.deepEqual(lines(o), [["Monello Chicken", "1", "25kg"]], "the products are untouched");
  });

  test("'deliver somewhere else' reuses no address and drops one the order holds, waiting for the new one", async () => {
    await seed(JANE, [{ product: "Bandit", quantity: "1" }], { address: "Cap Estate" });
    modelOrders(draft({ delivery_address: "Gros Islet", delivery_preference: "delivery" }));
    await customerSays(JANE, "A bag of Monello Chicken 25kg delivered to Gros Islet");
    assert.equal((await live())[0].delivery_address, "Gros Islet");
    modelOrders(draft({ delivery_address: "Gros Islet", delivery_preference: "delivery" }));
    await customerSays(JANE, "Deliver somewhere else");
    const [o] = await live();
    assert.equal(o.delivery_address, null);
    assert.notEqual(o.delivery_address, "Cap Estate");
    assert.equal(o.fulfilment_method, "delivery");
  });

  test("an explicit address in the same message wins over history", async () => {
    await seed(JANE, [{ product: "Bandit", quantity: "1" }], { address: "Cap Estate" });
    modelOrders(draft({ delivery_address: "Rodney Bay", delivery_preference: "delivery" }));
    await customerSays(JANE, "A bag of Monello Chicken 25kg, same location as before but actually Rodney Bay");
    assert.equal((await live())[0].delivery_address, "Rodney Bay");
  });

  test("a generic product name maps to the history product only when the model nominates a real, dominant one", async () => {
    const monello = [{ product: "Monello Chicken", quantity: "1", size: "25kg" }];
    const first = await seed(JANE, monello);
    await seed(JANE, monello);
    await seed(JANE, monello);
    await seed(JANE, [{ product: "Pool Salt", quantity: "4" }]);
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "1", size: "25kg", from_history: first.ref_code }] }));
    await customerSays(JANE, "A bag of dog food please");
    const sent = modelCalls.at(-1)!;
    assert.ok(sent.orderHistory, "the model is shown a compact history");
    assert.ok(JSON.stringify(sent.orderHistory).length < 1500);
    const [o] = await live();
    assert.deepEqual(lines(o), [["Monello Chicken", "1", "25kg"]]);
    assert.equal((await orderEvents(o.id))[0].changes.inferred.after.items[0], first.ref_code);
  });

  test("a nominated history product that is made up, or is not the clear favourite, is rejected and the customer's words stand", async () => {
    const a = await seed(JANE, [{ product: "Monello Chicken", quantity: "1", size: "25kg" }]);
    const b = await seed(JANE, [{ product: "Bandit", quantity: "1", size: "15kg" }]);
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "1", size: "25kg", from_history: a.ref_code }] }));
    await customerSays(JANE, "A bag of dog food please");
    assert.deepEqual((await live()).length, 0, "two equally likely products: nothing is picked");
    modelOrders(draft({ items: [{ product: "Crunchies", quantity: "1", from_history: "O-FAKE1" }] }));
    await customerSays(JANE, "A bag of Crunchies please", { id: "CRUNCH-1" });
    const [o] = await live();
    assert.deepEqual(lines(o), [["Crunchies", "1", null]], "an invented reference is ignored; the customer named it themselves, so it is recorded as they wrote it");
    assert.equal((await orderEvents(o.id))[0].changes.inferred, undefined, "nothing was taken from history");
    assert.ok(b.ref_code);
  });

  test("history uses the customer's own records only: another business, another customer and an unverified @lid are never mixed in", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "5" }], { biz: "by_sea" });
    await seed(MARCUS, [{ product: "Bandit", quantity: "7" }]);
    modelOrders(null);
    await customerSays(JANE, "same as last time");
    const [o] = await live();
    assert.deepEqual(o.items, [], "Jane's history exists only in the other business");
    assert.equal(o.attention, "history_unresolved");
    assert.equal(historyShown(), undefined, "nothing is shown to the model either");

    // An @lid chat whose phone WhatsApp reported is the same customer as the phone chat; an unverified one is nobody's.
    await seed(MARCUS, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], { at: "2026-10-25T14:00:00Z" });
    await say("2345678901234@lid", MARCUS.phone, "same as last time", { id: "LID-1" });
    const lid = (await live()).find((x) => x.chat_id === "2345678901234@lid")!;
    assert.deepEqual(lines(lid), [["Monello Chicken", "2", "25kg"]], "a verified @lid reaches the same customer's history, not another customer's");
    await say("9988776655443@lid", "9988776655443", "same as last time", { id: "LID-2" });
    const stranger = (await live()).find((x) => x.chat_id === "9988776655443@lid")!;
    assert.deepEqual(stranger.items, [], "an @lid with no verified phone never matches anyone's history");
  });

  // ── Incremental maintenance ────────────────────────────────────────────────

  test("add, another, make-that, remove and just-the: one order is maintained and nothing is duplicated", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }, { product: "Bandit", quantity: "1" }] }));
    await customerSays(JANE, "2 bags Monello Chicken 25kg and 1 Bandit");
    const base = { delivery_address: null, delivery_preference: null, notes: null };
    modelOrders({ ...base, items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }, { product: "Bandit", quantity: "1" }, { product: "Pool Salt", quantity: "4" }] });
    await customerSays(JANE, "Add 4 pool salt");
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "2", "25kg"], ["Bandit", "1", null], ["Pool Salt", "4", null]]);

    // "Another bag of Monello": the model's cumulative list has no digit to ground on; the server adds one.
    modelOrders({ ...base, items: [{ product: "Monello Chicken", quantity: "9", size: "25kg" }, { product: "Bandit", quantity: "1" }, { product: "Pool Salt", quantity: "4" }] });
    await customerSays(JANE, "Another bag of Monello");
    assert.deepEqual(lines((await live())[0]).map((l: any[]) => l[1]), ["3", "1", "4"]);

    modelOrders({ ...base, items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }, { product: "Bandit", quantity: "1" }, { product: "Pool Salt", quantity: "2" }] });
    await customerSays(JANE, "Make the pool salt 2");
    assert.deepEqual(lines((await live())[0]).map((l: any[]) => l[1]), ["3", "1", "2"]);

    modelOrders({ ...base, items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }, { product: "Pool Salt", quantity: "2" }] });
    await customerSays(JANE, "Remove the Bandit");
    assert.deepEqual(lines((await live())[0]).map((l: any[]) => l[0]), ["Monello Chicken", "Pool Salt"]);

    modelOrders({ ...base, items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }] });
    await customerSays(JANE, "Just the Monello");
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "3", "25kg"]]);
    assert.equal((await live()).length, 1);
  });

  test("'another bag' works even when the model returns no order at all", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", size: "25kg" }] }));
    await customerSays(JANE, "2 bags Monello Chicken 25kg");
    modelOrders(null);
    await customerSays(JANE, "Another bag");
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "3", "25kg"]]);
    await customerSays(JANE, "Another bag", { id: "ANOTHER-RETRY" });
    await customerSays(JANE, "Another bag", { id: "ANOTHER-RETRY" });
    assert.deepEqual(lines((await live())[0]), [["Monello Chicken", "4", "25kg"]], "a redelivered message adds one bag once");
  });

  test("delivery and collection updates keep every item and detail", async () => {
    modelOrders(draft());
    await customerSays(JANE, "A bag of Monello Chicken 25kg");
    modelOrders(draft({ delivery_preference: "delivery", delivery_address: "Cap" }));
    await customerSays(JANE, "Bring it to Cap");
    let [o] = await live();
    assert.deepEqual([o.fulfilment_method, o.delivery_address], ["delivery", "Cap"]);
    modelOrders(draft({ delivery_preference: "collection", delivery_address: "Cap" }));
    await customerSays(JANE, "Actually I'll collect");
    [o] = await live();
    assert.equal(o.fulfilment_method, "collection");
    assert.deepEqual(lines(o), [["Monello Chicken", "1", "25kg"]]);
  });

  // ── Staff locks and confirmed orders ───────────────────────────────────────

  test("with the products locked by staff, a new product is added without any conflict; a contradiction is recorded", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "1", size: "25kg" }] }));
    await customerSays(JANE, "A bag of Monello Chicken 25kg, bring it to Cap");
    const [created] = await live();
    await groupSays(`!order ${ref(created)} 3 bags`);
    assert.deepEqual((await live())[0].manual_locked_fields.includes("items"), true);

    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "25kg" }, { product: "Pool Salt", quantity: "4" }] }), { order_target: created.ref_code });
    await customerSays(JANE, "Add 4 pool salt");
    let [o] = await live();
    assert.deepEqual(lines(o), [["Monello Chicken", "3", "25kg"], ["Pool Salt", "4", null]]);
    assert.deepEqual(o.field_conflicts, {}, "an ordinary addition is not a conflict");

    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "5", size: "25kg" }, { product: "Pool Salt", quantity: "4" }] }), { order_target: created.ref_code });
    await customerSays(JANE, "Make the Monello 5 bags");
    [o] = await live();
    assert.deepEqual(lines(o)[0], ["Monello Chicken", "3", "25kg"], "the staff value is never overwritten");
    assert.deepEqual(Object.keys(o.field_conflicts), ["items"]);
    assert.match((await groupSays("!orders all")).outbox.map((x) => x.body).join("\n"), /⚠️ Customer asked for a change — check before fulfilling/);
    assert.equal(await customerBound(), 0);
  });

  test("a material change to a staff-confirmed order is never left silently confirmed", async () => {
    modelOrders(draft({ delivery_preference: "delivery", delivery_address: "Cap" }));
    await customerSays(JANE, "A bag of Monello Chicken 25kg delivered to Cap");
    const [created] = await live();
    await groupSays(`!order ${ref(created)} confirmed`);
    assert.equal((await live())[0].status, "confirmed");

    modelOrders(draft({ delivery_preference: "delivery", delivery_address: "Cap", items: [{ product: "Monello Chicken", quantity: "1", size: "25kg" }, { product: "Pool Salt", quantity: "4" }] }), { order_target: created.ref_code });
    await customerSays(JANE, "Add 4 pool salt");
    const [o] = await live();
    assert.equal(o.status, "awaiting_confirmation");
    assert.equal(o.attention, "changed_after_confirmation");
    assert.equal(o.confirmed_by, null, "the staff confirmation no longer stands");
    const report = (await groupSays("!orders all")).outbox.map((x) => x.body).join("\n");
    assert.match(report, /⚠️ Changed after confirmation — re-confirm/);
    assert.doesNotMatch(report, /CONFIRMED/);
  });

  // ── Other conversations and safety ─────────────────────────────────────────

  test("monitoring-only conversations use the same memory, with one small call and no reply", async () => {
    await configure({ contact_scope: "none" });
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], { address: "Cap Estate" });
    const seen: unknown[] = [];
    model.setOrderUpdateProposerForTests(async (input) => {
      seen.push(input.orderHistory);
      return { proposal: { intent: "order", order_request: null, staff_action: null }, model: "scripted", error: null };
    });
    try {
      const res = await monitor.monitorCustomerTurn({
        settings: (await dbmod.loadSettings("dog_food"))!, businessSlug: "dog_food", chatId: JANE.chat, contactNumber: JANE.phone,
        segments: ["Same as last time, same location"], transcript: "Same as last time, same location", hasMedia: false,
        messageIds: ["MON-1"], firstAt: MONDAY, lastAt: MONDAY, dedupeBase: "mon-1",
      } as never);
      assert.ok(res.reasons.includes("order_history_used"), res.reasons.join());
    } finally {
      model.setOrderUpdateProposerForTests(orderOnlyFromScript);
    }
    assert.equal(seen.length, 1, "one small call");
    assert.ok(seen[0], "compact history is part of it");
    const [o] = await live();
    assert.deepEqual(lines(o), [["Monello Chicken", "2", "25kg"]]);
    assert.equal(o.delivery_address, "Cap Estate");
    assert.equal(await customerBound(), 0);
  });

  test("a backfill replay never lets today's records answer a past message", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }]);
    const res = await orders.trackOrders({
      settings: (await dbmod.loadSettings("dog_food"))!, businessSlug: "dog_food", chatId: JANE.chat, phone: JANE.phone, customerName: null,
      intent: "order", proposal: null, segments: ["same as last time"], customerWords: ["same as last time"], messageIds: ["B-1"],
      firstAt: MONDAY, lastAt: MONDAY, dedupeBase: "backfill:test:1", allowConfirmation: false, useHistory: false,
    });
    assert.equal(res.applied, 0);
    assert.equal((await live()).length, 0);
  });

  test("the memory adds no outbox row of any kind and no model call beyond the existing one", async () => {
    await seed(JANE, [{ product: "Monello Chicken", quantity: "2", size: "25kg" }], { address: "Cap Estate" });
    modelOrders(null);
    await customerSays(JANE, "Same as last time, same location");
    assert.ok(modelCalls.length + updateCalls.length <= 1, "at most one model call for the turn");
    assert.equal(await count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`), 0);
  });
});
