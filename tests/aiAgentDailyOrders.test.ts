// Daily order tracking and the morning summary, end to end: the app's REAL server code (processBridgeMessage →
// order tracking → scheduler → outbox → ack) against the REAL migrations in a throwaway Postgres
// (tests/helpers/pgHarness.ts). Only the language model is replaced by a scripted stand-in. Skips itself when no
// Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import { defaultOrderDay } from "./helpers/dates.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const ORDERS_GROUP = "120363000000000003@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
const SAM = { chat: "17585550301@s.whatsapp.net", phone: "17585550301", name: "Sam" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type ProposeInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE",
  intent: "other",
  reply: null,
  confidence: 0.2,
  knowledge_ids: [],
  escalation_reason: "needs staff",
  priority: null,
  summary: null,
  order_request: null,
  memory_facts: [],
  ...over,
});
let script: (input: ProposeInput) => Proposal = () => proposal();
const modelCalls: ProposeInput[] = [];

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true,
    mode: "approval_pilot",
    contact_scope: "all",
    staff_group_jid: group,
    staff_notices_enabled: true,
    customer_memory_enabled: false,
    batching_enabled: false,
    auto_takeover_minutes: 0,
    default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"],
    orders_tracking_enabled: true,
    orders_summary_enabled: true,
    orders_group_jid: null,
    orders_timezone: "America/St_Lucia",
    orders_summary_hour: 8,
    orders_customer_confirms: false,
    orders_tracking_since: null,
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}
const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

async function ackAll(items: { id: string; send: boolean }[]) {
  for (const item of items) if (item.send) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
}

async function customerSays(c: Customer, text: string, opts: { biz?: string; id?: string } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `CUST-${++seq}`,
    chatId: c.chat,
    contactNumber: c.phone,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

async function groupSays(text: string, opts: { group?: string; sender?: string | null; biz?: string; id?: string } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `GRP-${++seq}`,
    chatId: opts.group ?? GROUP,
    contactNumber: null,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender,
    senderPhone: null,
    timestamp: new Date().toISOString(),
  });
  return result;
}

type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
const draft = (over: Partial<Draft> = {}): Draft => ({
  items: [{ product: "Monello Chicken", quantity: "2", size: "15kg" }],
  delivery_address: "12 Main St Gros Islet",
  delivery_preference: "delivery",
  notes: null,
  requested_for: "Friday morning",
  ...over,
});
/** The model proposes this order draft (and names the open order it belongs to, if any). */
const modelOrders = (d: Draft | null, extra: Partial<Proposal> = {}) => {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order", ...extra });
};

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderEvents = (orderId?: string) =>
  rows<Record<string, any>>(`select * from public.ai_agent_order_events${orderId ? ` where order_id = ${lit(orderId)}` : ""} order by created_at, id`);
const summaryOutbox = (biz = "dog_food") =>
  rows<Record<string, any>>(`select * from public.ai_agent_outbox where business_slug = ${lit(biz)} and dedupe_key like 'ordersummary:%' order by created_at, id`);
const runs = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_order_summary_runs where business_slug = ${lit(biz)} order by created_at, id`);
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
/** A person (staff phone) writes to the customer: the proof that there was something to confirm. */
const staffWritesTo = (c: Customer, text: string) =>
  pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
          values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, 'outbound', ${lit(text)}, ${lit(`STAFFMSG-${++seq}`)}, now() + interval '1 second');`);

const D = (iso: string) => new Date(iso);
const EIGHT_AM = "2026-10-27T12:00:00Z"; // 08:00 in St Lucia
const lastModelInput = () => modelCalls[modelCalls.length - 1];

describe("Daily orders (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text,
        message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    orders = await import("../lib/server/aiAgent/orders.ts");
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async (input) => {
      modelCalls.push(input);
      return { proposal: script(input), model: "scripted", error: null };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts,
        public.ai_agent_shadow_results, public.whatsapp_messages cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls.length = 0;
    script = () => proposal();
  });

  // ── Migration safety ───────────────────────────────────────────────────────

  test("a fresh business has every order feature OFF with the St Lucia 8 AM defaults", async () => {
    await pg.run(`insert into public.whatsapp_businesses (business_slug) values ('fresh_biz');
                  insert into public.ai_agent_settings (business_slug) values ('fresh_biz');`);
    const [s] = await rows(`select orders_tracking_enabled, orders_summary_enabled, orders_group_jid, orders_timezone, orders_summary_hour from public.ai_agent_settings where business_slug = 'fresh_biz'`);
    assert.deepEqual(s, { orders_tracking_enabled: false, orders_summary_enabled: false, orders_group_jid: null, orders_timezone: "America/St_Lucia", orders_summary_hour: 8 });
  });

  // ── Extraction ─────────────────────────────────────────────────────────────

  test("an order in a conversation becomes ONE structured record, from the existing model call, with no customer message", async () => {
    modelOrders(draft());
    await customerSays(JANE, "Hi I want 2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [o] = await allOrders();
    assert.equal(modelCalls.length, 1, "no extra model call for order tracking");
    assert.ok(lastModelInput().openOrders, "the same call is told the customer's open orders");
    assert.match(o.ref_code, /^O-[A-Z2-9]{5}$/);
    assert.equal(o.status, "awaiting_confirmation", "complete, but nobody has confirmed it");
    assert.equal(o.contact_number, JANE.phone);
    assert.equal(o.chat_id, JANE.chat);
    assert.deepEqual(o.items, [{ product: "Monello Chicken", quantity: "2", variant: null, size: "15kg" }]);
    assert.equal(o.fulfilment_method, "delivery");
    assert.equal(o.delivery_address, "12 Main St Gros Islet");
    assert.match(o.requested_for, /^\w{3} \d{1,2} \w{3} \(Friday morning\)$/, "resolved to a calendar day, keeping the customer's words");
    assert.deepEqual(o.missing_fields, []);
    assert.equal(o.source_message_ids.length, 1);
    assert.match(o.source_message_ids[0], /^CUST-/);
    assert.equal(await customerBound(), 0, "extraction never messages the customer");
    assert.equal((await orderEvents(o.id)).length, 1);
  });

  test("with tracking off nothing is recorded and the model is not asked about orders", async () => {
    await configure({ orders_tracking_enabled: false });
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal((await allOrders()).length, 0);
    assert.equal(lastModelInput().openOrders, undefined);
  });

  test("a question about products is not an order", async () => {
    script = () => proposal({ decision: "ESCALATE", intent: "question", order_request: draft({ items: [{ product: "Monello Chicken", quantity: "2" }] }) });
    await customerSays(JANE, "How much for 2 Monello Chicken?");
    assert.equal((await allOrders()).length, 0);
  });

  test("an unverified @lid customer gets no phone number on the record", async () => {
    const lid = { chat: "99887766554433@lid", phone: "99887766554433", name: "Lid" };
    modelOrders(draft());
    await customerSays(lid, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [o] = await allOrders();
    assert.equal(o.contact_number, null);
  });

  test("the AI cannot invent a variant, size or time the customer never wrote", async () => {
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2", variant: "Salmon", size: "20kg" }], requested_for: "Tuesday at 3pm", delivery_address: null }));
    await customerSays(JANE, "I want 2 Monello Chicken please, delivery");
    const [o] = await allOrders();
    assert.deepEqual(o.items, [{ product: "Monello Chicken", quantity: "2", variant: null, size: null }]);
    assert.equal(o.requested_for, `${defaultOrderDay().label} (default)`, "the time the model invented is dropped; the business default day is stored, marked as a default");
    assert.equal(o.status, "possible");
    assert.deepEqual(o.missing_fields, ["delivery_address"], "the day is stored (as a default), so it is no longer missing");
  });

  // ── Merging, corrections, duplicates ───────────────────────────────────────

  test("follow-ups, corrections and extra products merge into the same order", async () => {
    modelOrders(draft({ delivery_address: null, requested_for: null }));
    await customerSays(JANE, "2 Monello Chicken 15kg please, delivery");
    let [o] = await allOrders();
    assert.equal(o.status, "possible");

    modelOrders(draft({ requested_for: null }), { order_target: o.ref_code });
    await customerSays(JANE, "deliver to 12 Main St Gros Islet");
    [o] = (await allOrders());
    assert.equal((await allOrders()).length, 1);
    assert.equal(o.status, "awaiting_confirmation");
    assert.equal(o.delivery_address, "12 Main St Gros Islet");

    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "15kg" }], requested_for: null }), { order_target: o.ref_code });
    await customerSays(JANE, "actually make it 3 bags");
    modelOrders(
      draft({ items: [{ product: "Monello Chicken", quantity: "3", size: "15kg" }, { product: "Dog Treats", quantity: "1" }], requested_for: null }),
      { order_target: o.ref_code }
    );
    await customerSays(JANE, "and add 1 Dog Treats");

    const final = await allOrders();
    assert.equal(final.length, 1, "still one order");
    assert.deepEqual(final[0].items.map((i: any) => [i.product, i.quantity]), [["Monello Chicken", "3"], ["Dog Treats", "1"]]);
    assert.equal(final[0].source_message_ids.length, 4, "every message that shaped it is referenced");
    const events = await orderEvents(final[0].id);
    assert.deepEqual(events.map((e) => e.kind), ["created", "ai_update", "ai_update", "ai_update"]);
    assert.deepEqual(events[2].changes.items.before[0].quantity, "2");
    assert.equal(events[2].changes.items.after[0].quantity, "3");
  });

  test("the same turn processed twice (a batch retry) changes nothing the second time", async () => {
    const args = {
      settings: await settingsOf(),
      businessSlug: "dog_food",
      chatId: JANE.chat,
      phone: JANE.phone,
      customerName: "Jane",
      intent: "order",
      proposal: { order_request: draft(), order_target: null, other_orders: [] },
      segments: ["2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning"],
      customerWords: ["2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning"],
      messageIds: ["M1"],
      firstAt: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      dedupeBase: "batch:abc",
    };
    const first = await orders.trackOrders(args);
    const second = await orders.trackOrders(args);
    assert.equal(first.applied, 1);
    assert.equal(second.applied, 0);
    assert.equal((await allOrders()).length, 1);
    assert.equal((await orderEvents()).length, 1);
  });

  test("a retried bridge message is not processed twice", async () => {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", { id: "SAME-1" });
    const again = await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", { id: "SAME-1" });
    assert.equal(again.status, "duplicate");
    assert.equal((await allOrders()).length, 1);
    assert.equal(modelCalls.length, 1);
  });

  test("restating the same order as 'new' in a later message is merged, not duplicated", async () => {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    modelOrders(draft(), { order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning (sent again)");
    assert.equal((await allOrders()).length, 1);
  });

  test("a customer can have several distinct orders; a correction goes to the one it names", async () => {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [first] = await allOrders();

    modelOrders(
      draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: "7 Beach Rd Rodney Bay", delivery_preference: "delivery", requested_for: "Saturday" }),
      { order_target: "new" }
    );
    await customerSays(JANE, "Also a separate order: 4 Dog Treats to 7 Beach Rd Rodney Bay on Saturday, for my sister");
    let all = await allOrders();
    assert.equal(all.length, 2);
    const second = all.find((o) => o.id !== first.id)!;
    assert.equal(second.items[0].product, "Dog Treats");
    assert.equal(first.items[0].product, "Monello Chicken", "the first order is untouched");

    const seen = (lastModelInput().openOrders as { ref: string }[]).map((o) => o.ref).sort();
    assert.deepEqual(seen, [first.ref_code].sort(), "the model saw the orders that were open when it was asked");

    modelOrders(draft({ items: [{ product: "Dog Treats", quantity: "6" }], delivery_address: "7 Beach Rd Rodney Bay", requested_for: "Saturday" }), { order_target: second.ref_code });
    await customerSays(JANE, "make the treats order 6");
    all = await allOrders();
    assert.equal(all.length, 2);
    assert.equal(all.find((o) => o.id === second.id)!.items[0].quantity, "6");
    assert.equal(all.find((o) => o.id === first.id)!.items[0].quantity, "2");
  });

  test("two distinct orders in one message are both recorded", async () => {
    script = () =>
      proposal({
        decision: "ESCALATE",
        intent: "order",
        order_request: draft(),
        other_orders: [{ target: "new", order: draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: "7 Beach Rd Rodney Bay", requested_for: "Saturday" }) }],
      });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning. Second order: 4 Dog Treats to 7 Beach Rd Rodney Bay Saturday");
    assert.equal((await allOrders()).length, 2);
  });

  // ── Confirmation ───────────────────────────────────────────────────────────

  async function awaitingOrder(c: Customer = JANE) {
    modelOrders(draft());
    await customerSays(c, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    return (await allOrders()).find((o) => o.chat_id === c.chat)!;
  }

  test("a customer 'yes' is not enough on its own: nobody put the order in front of them", async () => {
    const o = await awaitingOrder();
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
  });

  test("an unambiguous 'yes' after a person wrote to the customer confirms the order", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Hi Jane, that's 2 x Monello Chicken 15kg delivered Friday morning. Can you confirm?");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "Yes please");
    const [after] = await allOrders();
    assert.equal(after.status, "confirmed");
    assert.equal(after.confirmed_by, "customer");
    assert.ok(after.confirmed_at);
    const events = await orderEvents(o.id);
    assert.equal(events.at(-1)!.kind, "customer_confirmed");
    assert.equal(events.at(-1)!.actor_kind, "customer");
    assert.equal(await customerBound(), 0);
  });

  test("the AI's own reply never counts as the thing the customer confirmed", async () => {
    const o = await awaitingOrder();
    // Only an automatic AI reply went out after the order was complete.
    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key, status, whatsapp_message_id)
                  values ('dog_food', ${lit(JANE.chat)}, 'customer_reply', ${lit(JANE.chat)}, 'Your order is confirmed!', 'ai-1', 'sent', 'AIMSG-1');
                  insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id, timestamp)
                  values ('dog_food', ${lit(JANE.chat)}, 'outbound', 'Your order is confirmed!', 'AIMSG-1', now() + interval '1 second');`);
    modelOrders(draft(), { order_target: o.ref_code, reply: "Your order is confirmed!", decision: "REPLY" as never });
    await customerSays(JANE, "yes");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
  });

  test("a model that says 'confirmed' changes nothing", async () => {
    modelOrders(draft(), { reply: "Great, your order is confirmed!", summary: "Customer confirmed the order" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
  });

  test("hedges and changes do not confirm", async () => {
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Can you confirm your order?");
    for (const text of ["maybe", "let me check", "yes but make it 3 bags", "not yet", "Yes?"]) {
      modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: text.includes("3") ? "3" : "2", size: "15kg" }] }), { order_target: o.ref_code });
      await customerSays(JANE, text);
      assert.notEqual((await allOrders())[0].status, "confirmed", text);
    }
  });

  test("changing a confirmed order sends it back for confirmation and flags it", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Please confirm");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    assert.equal((await allOrders())[0].status, "confirmed");
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "5", size: "15kg" }] }), { order_target: o.ref_code });
    await customerSays(JANE, "sorry, make it 5 bags");
    const [after] = await allOrders();
    assert.equal(after.status, "awaiting_confirmation");
    assert.equal(after.attention, "changed_after_confirmation");
    assert.equal(after.confirmed_by, null);
  });

  test("several awaiting orders and a bare 'yes' that names none: nothing is confirmed", async () => {
    await awaitingOrder();
    modelOrders(draft({ items: [{ product: "Dog Treats", quantity: "4" }] }), { order_target: "new" });
    await customerSays(JANE, "and 4 Dog Treats delivered to 12 Main St Gros Islet Friday morning");
    assert.equal((await allOrders()).length, 2);
    await staffWritesTo(JANE, "Please confirm both");
    modelOrders(null);
    await customerSays(JANE, "yes");
    assert.equal(await count(`select 1 from public.ai_agent_orders where status = 'confirmed'`), 0);
  });

  // ── Rollout safety: customer reply vs staff verification ────────────────────

  test("by default a customer's yes is only RECORDED; staff verification is what confirms", async () => {
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Hi Jane, 2 x Monello Chicken delivered Friday. Can you confirm?");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "Yes please");
    let [row] = await allOrders();
    assert.equal(row.status, "awaiting_confirmation");
    assert.ok(row.customer_confirmed_at);
    assert.equal(row.confirmed_by, null);
    assert.equal(row.attention, "customer_replied_yes");
    assert.equal((await orderEvents(o.id)).at(-1)!.kind, "customer_replied_yes");

    const report = (await orders.buildSummaryNow(await settingsOf(), "manual", new Date(), { type: "all" })).text;
    assert.match(report, /🕓 to confirm/);
    assert.doesNotMatch(report, /✅ confirmed/);
    assert.doesNotMatch(report, /Customer said yes|Needs confirmation/, "the recorded yes lives in the dashboard and !moreinfo, not the report");

    // Saying yes again does not pile up events.
    await customerSays(JANE, "yes");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "customer_replied_yes").length, 1);

    const verified = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "u1", action: "confirm" });
    assert.ok(verified.ok);
    [row] = await allOrders();
    assert.equal(row.status, "confirmed");
    assert.equal(row.confirmed_by, "admin:u1");
    assert.equal(row.attention, null);
    const after = (await orders.buildSummaryNow(await settingsOf(), "manual", new Date(), { type: "all" })).text;
    assert.match(after, /✅ confirmed/);
    assert.doesNotMatch(after, /⚠️/, "a confirmed order carries no warning");
  });

  test("with customer confirmation enabled the report says the customer's reply confirmed it", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Can you confirm?");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "confirmed");
    const report = (await orders.buildSummaryNow(await settingsOf(), "manual", new Date(), { type: "all" })).text;
    assert.match(report, /✅ confirmed/);
    assert.equal((await allOrders())[0].confirmed_by, "customer");
  });

  test("a yes is never attributed when anything else is open in the chat, whatever the model says", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    modelOrders(draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: null, requested_for: null }), { order_target: "new" });
    await customerSays(JANE, "also 4 Dog Treats");
    assert.equal((await allOrders()).length, 2);
    await staffWritesTo(JANE, "Please confirm the chicken order");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    assert.equal(await count(`select 1 from public.ai_agent_orders where status = 'confirmed' or customer_confirmed_at is not null`), 0);
  });

  test("a person's message from days ago is not something the customer can be answering", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    await pg.run(`update public.ai_agent_orders set awaiting_since = now() - interval '5 days' where id = ${lit(o.id)};
                  insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id, timestamp)
                  values ('dog_food', ${lit(JANE.chat)}, 'outbound', 'Please confirm', 'OLD-1', now() - interval '4 days');`);
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    assert.equal((await allOrders())[0].customer_confirmed_at, null);
  });

  test("a staff edit to the content voids a recorded customer yes", async () => {
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Confirm?");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    assert.ok((await allOrders())[0].customer_confirmed_at);
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "u", action: "edit", patch: { notes: "gate code 1234" } });
    const [row] = await allOrders();
    assert.equal(row.customer_confirmed_at, null);
    assert.equal(row.attention, null);
  });

  // ── Cancellation ───────────────────────────────────────────────────────────

  test("'cancel my order' cancels an unconfirmed order and nothing else", async () => {
    await awaitingOrder();
    modelOrders(null);
    await customerSays(JANE, "please cancel my order");
    const [o] = await allOrders();
    assert.equal(o.status, "cancelled");
    assert.equal(o.cancel_reason, "customer_request");
    assert.equal(await customerBound(), 0);
  });

  test("a cancellation request on a confirmed order is flagged for staff, not applied", async () => {
    await configure({ orders_customer_confirms: true });
    const o = await awaitingOrder();
    await staffWritesTo(JANE, "Please confirm");
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "yes");
    modelOrders(null);
    await customerSays(JANE, "please cancel my order");
    const [after] = await allOrders();
    assert.equal(after.status, "confirmed");
    assert.equal(after.attention, "cancellation_requested");
  });

  // ── Manual corrections ─────────────────────────────────────────────────────

  test("staff corrections are audited, locked against the AI, and version-checked", async () => {
    const o = await awaitingOrder();
    const edit = await orders.updateOrderManually({
      businessSlug: "dog_food", orderId: o.id, adminId: "11111111-1111-1111-1111-111111111111", action: "edit", expectedVersion: o.version,
      patch: { delivery_address: "99 Corrected Lane", customer_name: "Jane Doe" },
    });
    assert.ok(edit.ok);
    const row = (await allOrders())[0];
    assert.equal(row.delivery_address, "99 Corrected Lane");
    assert.deepEqual([...row.manual_locked_fields].sort(), ["customer_name", "delivery_address"]);
    const ev = (await orderEvents(o.id)).at(-1)!;
    assert.equal(ev.kind, "manual_edit");
    assert.equal(ev.actor_kind, "admin");
    assert.equal(ev.changes.delivery_address.before, "12 Main St Gros Islet");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'order.edit'`), 1);

    // The AI states the old address again: the staff correction stands.
    modelOrders(draft({ delivery_address: "12 Main St Gros Islet" }), { order_target: o.ref_code });
    await customerSays(JANE, "deliver to 12 Main St Gros Islet");
    assert.equal((await allOrders())[0].delivery_address, "99 Corrected Lane");

    // A stale screen cannot overwrite a newer version.
    const stale = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "u", action: "cancel", expectedVersion: o.version });
    assert.deepEqual(stale, { ok: false, status: 409, error: "This order changed since you opened it — reload and try again", code: "conflict" });
  });

  test("staff confirm, fulfil and cancel; an incomplete order cannot be confirmed; closed orders are final", async () => {
    modelOrders(draft({ delivery_address: null }));
    await customerSays(JANE, "2 Monello Chicken 15kg delivered Friday morning");
    const incomplete = (await allOrders())[0];
    const refused = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: incomplete.id, adminId: "u", action: "confirm" });
    assert.equal(refused.ok, false);
    assert.equal((await allOrders())[0].status, "possible");

    const fixed = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: incomplete.id, adminId: "u", action: "edit", patch: { fulfilment_method: "collection" } });
    assert.ok(fixed.ok && fixed.order.status === "awaiting_confirmation");
    const confirmed = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: incomplete.id, adminId: "u", action: "confirm" });
    assert.ok(confirmed.ok && confirmed.order.status === "confirmed" && confirmed.order.confirmed_by === "admin:u");
    const done = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: incomplete.id, adminId: "u", action: "fulfil" });
    assert.ok(done.ok && done.order.status === "fulfilled");
    const again = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: incomplete.id, adminId: "u", action: "cancel" });
    assert.equal(again.ok, false);
    assert.equal(await customerBound(), 0);
  });

  test("invalid edits are rejected", () => {
    assert.equal(orders.validatePatch({ status: "confirmed" } as never).ok, false);
    assert.equal(orders.validatePatch({ items: [{ product: "" }] }).ok, false);
    assert.equal(orders.validatePatch({ fulfilment_method: "teleport" }).ok, false);
    assert.equal(orders.validatePatch({ notes: 5 }).ok, false);
  });

  // ── Business isolation ─────────────────────────────────────────────────────

  test("businesses never see or change each other's orders", async () => {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    modelOrders(draft({ items: [{ product: "Sea Moss", quantity: "3" }], delivery_address: "5 Pier Rd Castries" }));
    await customerSays(SAM, "3 Sea Moss delivered to 5 Pier Rd Castries Friday morning", { biz: "by_sea" });

    const dog = await orders.listOrders("dog_food");
    const sea = await orders.listOrders("by_sea");
    assert.deepEqual(dog.map((o) => o.customer_name ?? o.chat_id).length, 1);
    assert.equal(dog[0].items[0].product, "Monello Chicken");
    assert.equal(sea[0].items[0].product, "Sea Moss");

    const seaOrder = sea[0];
    const cross = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: seaOrder.id, adminId: "u", action: "cancel" });
    assert.deepEqual(cross, { ok: false, status: 404, error: "Order not found", code: "not_found" });

    const dogSummary = await orders.buildSummaryNow(await settingsOf("dog_food"), "manual", D(EIGHT_AM), { type: "all" });
    assert.match(dogSummary.text, /Monello Chicken/);
    assert.doesNotMatch(dogSummary.text, /Sea Moss/);
    const seaSummary = await orders.buildSummaryNow(await settingsOf("by_sea"), "manual", D(EIGHT_AM), { type: "all" });
    assert.match(seaSummary.text, /Sea Moss/);
    assert.doesNotMatch(seaSummary.text, /Monello/);
  });

  test("the same customer number in two businesses keeps two separate orders", async () => {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    modelOrders(draft({ items: [{ product: "Sea Moss", quantity: "1" }] }));
    await customerSays(JANE, "1 Sea Moss to 12 Main St Gros Islet Friday morning", { biz: "by_sea" });
    assert.equal((await allOrders("dog_food")).length, 1);
    assert.equal((await allOrders("by_sea")).length, 1);
  });

  // ── The 8 AM summary ───────────────────────────────────────────────────────

  async function seedMixedOrders() {
    modelOrders(draft());
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [jane] = await allOrders();
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: jane.id, adminId: "u", action: "confirm" });
    modelOrders(draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: null, requested_for: null }));
    await customerSays(MARCUS, "4 Dog Treats please, delivery");
    // The names a saved contact would give them.
    await pg.run(`update public.ai_agent_orders set customer_name = 'Jane' where chat_id = ${lit(JANE.chat)}; update public.ai_agent_orders set customer_name = 'Marcus' where chat_id = ${lit(MARCUS.chat)};`);
    // Yesterday's order, still outstanding.
    await pg.run(`update public.ai_agent_orders set first_message_at = '2026-10-25T15:00:00Z', last_message_at = '2026-10-26T15:00:00Z' where chat_id = ${lit(JANE.chat)};
                  update public.ai_agent_orders set first_message_at = '2026-10-27T10:30:00Z', last_message_at = '2026-10-27T10:30:00Z', requested_for = 'Tue 27 Oct (default)' where chat_id = ${lit(MARCUS.chat)};`);
  }

  test("nothing is posted before 8:00 St Lucia time; at 8:00 exactly one report is queued for the staff group", async () => {
    await seedMixedOrders();
    const settings = await settingsOf();
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T11:59:00Z")), "not_yet");
    assert.equal((await summaryOutbox()).length, 0);

    assert.equal(await orders.runScheduledSummary(settings, D(EIGHT_AM)), "sent");
    const [item] = await summaryOutbox();
    assert.equal(item.kind, "staff_notice");
    assert.equal(item.to_jid, GROUP);
    assert.equal(item.status, "pending");
    assert.equal(item.dedupe_key, "ordersummary:dog_food:2026-10-27:1");
    // The morning post is the by-day view: Jane's order is for Friday, so it is counted, not listed. Marcus named no day and wrote
    // at 06:30 (before 9 AM), so the business default puts him on today, marked as a default.
    assert.match(item.body, /^📋 \*ORDERS — Tue 27 Oct\*/);
    assert.match(item.body, /📅 \*TODAY — Tue 27 Oct\* \(1\)[\s\S]*Marcus · #[A-Z2-9]{5}\*/);
    assert.doesNotMatch(item.body, /default day/, "the report never prints the default-day wording; the heading carries the date");
    assert.doesNotMatch(item.body, /Jane/, "an order for Friday is not carried into Tuesday's list");
    assert.match(item.body, /🗓 1 later order — !orders <date>/);
    assert.doesNotMatch(item.body, /Needs delivery address|Needs confirmation/);
    const [run] = await runs();
    assert.deepEqual([run.status, run.local_date.slice(0, 10), run.confirmed_count, run.attention_count, run.carried_count], ["queued", "2026-10-27", 1, 1, 0]);
    assert.equal(run.outbox_id, item.id);
  });

  test("repeated, restarted and overlapping scheduler runs post the day's summary once", async () => {
    await seedMixedOrders();
    const settings = await settingsOf();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => orders.runScheduledSummary(settings, D(EIGHT_AM))));
    assert.equal(outcomes.filter((o) => o === "sent").length, 1);
    for (let i = 0; i < 3; i += 1) await orders.runScheduledSummary(settings, D("2026-10-27T12:07:00Z"));
    assert.equal((await summaryOutbox()).length, 1);
    assert.equal((await runs()).length, 1);
    // Next local day: due again.
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-28T12:01:00Z")), "sent");
    assert.equal((await summaryOutbox()).length, 2);
  });

  test("the whole job, across every enabled business, is idempotent too", async () => {
    await seedMixedOrders();
    const first = await orders.runDueOrderSummaries(D(EIGHT_AM));
    const second = await orders.runDueOrderSummaries(D(EIGHT_AM));
    assert.deepEqual(first.outcomes, { sent: 2 });
    assert.equal(second.outcomes.sent, undefined);
    assert.equal((await summaryOutbox("dog_food")).length, 1);
    assert.equal((await summaryOutbox("by_sea")).length, 1);
    assert.equal((await summaryOutbox("by_sea"))[0].to_jid, SEA_GROUP);
  });

  test("a restart later the same morning still posts (catch-up); a day missed entirely is recorded, not sent late", async () => {
    const settings = await settingsOf();
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T15:30:00Z")), "sent", "11:30 local, 3.5 h late");
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-28T20:00:00Z")), "missed", "16:00 local: too late to be a morning report");
    const log = await runs();
    assert.deepEqual(log.map((r) => r.status), ["queued", "missed"]);
    assert.equal((await summaryOutbox()).length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.summary_missed'`), 1);
    // The next morning is unaffected.
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-29T12:00:00Z")), "sent");
  });

  test("a worker that died after claiming the day is resumed without a second send", async () => {
    const settings = await settingsOf();
    await pg.run(`insert into public.ai_agent_order_summary_runs (business_slug, trigger, local_date, scheduled_key, status, updated_at)
                  values ('dog_food', 'scheduled', '2026-10-27', 'dog_food:2026-10-27', 'claimed', now() - interval '10 minutes');`);
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:30:00Z")), "resumed");
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:31:00Z")), "already_done");
    assert.equal((await summaryOutbox()).length, 1);
  });

  test("uncertain sends are never repeated; provable non-sends get at most two more tries", async () => {
    const settings = await settingsOf();
    await orders.runScheduledSummary(settings, D(EIGHT_AM));
    const outboxId = () => pg.run(`select id from public.ai_agent_outbox where dedupe_key like 'ordersummary:%' order by created_at desc limit 1;`);

    // Handed to the bridge, never acknowledged: it may have gone out. Not resent.
    await pg.run(`update public.ai_agent_outbox set status = 'dispatched', dispatched_at = '2026-10-27T12:00:00Z' where id = ${lit(await outboxId())};`); // 40 minutes before the clock below, however far real time has moved
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:40:00Z")), "uncertain_not_resent");

    // Acked failed with an ambiguous error: not resent either.
    await pg.run(`update public.ai_agent_outbox set status = 'failed', error = 'timeout waiting for ack' where id = ${lit(await outboxId())};`);
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:41:00Z")), "already_done");
    assert.equal((await summaryOutbox()).length, 1);

    // The bridge says it provably did not send: try again, with the data as it is now.
    await pg.run(`update public.ai_agent_outbox set status = 'failed', error = 'not_sent: socket closed' where id = ${lit(await outboxId())};`);
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:42:00Z")), "retried");
    let all = await summaryOutbox();
    assert.deepEqual(all.map((o) => o.dedupe_key), ["ordersummary:dog_food:2026-10-27:1", "ordersummary:dog_food:2026-10-27:2"]);
    await pg.run(`update public.ai_agent_outbox set status = 'failed', error = 'bridge_send_disabled' where id = ${lit(await outboxId())};`);
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:50:00Z")), "retried");
    await pg.run(`update public.ai_agent_outbox set status = 'failed', error = 'not_sent: again' where id = ${lit(await outboxId())};`);
    assert.equal(await orders.runScheduledSummary(settings, D("2026-10-27T12:55:00Z")), "already_done", "three attempts, then stop");
    all = await summaryOutbox();
    assert.equal(all.length, 3);
    assert.equal((await runs())[0].attempts, 3);
  });

  test("the summary is posted only where the mode allows it, and never to a customer", async () => {
    await configure({ mode: "observe", staff_notices_enabled: false });
    assert.equal(await orders.runScheduledSummary(await settingsOf(), D(EIGHT_AM)), "skipped");
    assert.equal((await summaryOutbox()).length, 0);
    assert.equal((await runs())[0].status, "skipped");

    await configure({ mode: "observe", staff_notices_enabled: true }, "by_sea", SEA_GROUP);
    assert.equal(await orders.runScheduledSummary(await settingsOf("by_sea"), D(EIGHT_AM)), "sent");
    assert.equal(await customerBound(), 0);
    assert.equal(await orders.runScheduledSummary({ ...(await settingsOf()), orders_summary_enabled: false }, D(EIGHT_AM)), "skipped");
  });

  test("the list is rebuilt from the database each time: a cancellation shows up in the next !orders", async () => {
    await seedMixedOrders();
    const first = await groupSays("!orders all");
    assert.match(first.outbox[0].body, /Marcus/);
    const [marcus] = await orders.listOrders("dog_food", { q: "Treats" });
    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: marcus.id, adminId: "u", action: "cancel", reason: "changed mind" });
    const second = await groupSays("!orders all");
    assert.doesNotMatch(second.outbox[0].body, /Marcus/);
    assert.match(second.outbox[0].body, /Jane/);
  });

  // ── What the report claims to cover ────────────────────────────────────────

  const reportText = async (biz = "dog_food") => (await orders.buildSummaryNow(await settingsOf(biz), "scheduled", D(EIGHT_AM), { type: "all" })).text;

  test("with tracking switched off the report says it is incomplete", async () => {
    await configure({ orders_tracking_enabled: false });
    const text = await reportText();
    assert.match(text, /⚠️ Order tracking is OFF — this list may be incomplete\./);
  });

  test("with tracking on it says what it covers, and when tracking started", async () => {
    await configure({ orders_tracking_since: "2026-10-20T15:00:00Z" });
    const text = await reportText();
    assert.doesNotMatch(text, /⚠️|incomplete|Tracking has been on since|Covers every/i, "a healthy report has no coverage chatter");
  });

  test("conversations whose processing failed, or that were deliberately not read, are counted", async () => {
    const ev = (chat: string, status: string, codes: string[]) =>
      pg.run(`insert into public.ai_agent_events (business_slug, chat_id, whatsapp_message_id, kind, status, reason_codes)
              values ('dog_food', ${lit(chat)}, ${lit(`EV-${++seq}`)}, 'customer_inbound', ${lit(status)}, array[${codes.map(lit).join(",") || ""}]::text[]);`);
    await ev(JANE.chat, "error", []);
    await ev(MARCUS.chat, "done", ["contact_excluded"]);
    await ev(SAM.chat, "done", ["human_takeover"]);
    await ev(SAM.chat, "done", ["orders_tracking_failed"]);
    const text = await reportText();
    assert.match(text, /⚠️ May be incomplete: 2 chats could not be analysed\. Check the inbox\./);
  });

  test("a failed or stuck batch counts as not analysed", async () => {
    await pg.run(`insert into public.ai_agent_batches (business_slug, chat_id, status, first_message_at, last_message_at, due_at, max_due_at, message_count)
                  values ('dog_food', ${lit(JANE.chat)}, 'failed', now(), now(), now(), now(), 1);`);
    assert.match(await reportText(), /May be incomplete: 1 chat could not be analysed/);
  });

  test("a tracking failure inside a live turn is recorded and shows up in the next report", async () => {
    modelOrders(draft());
    // The orders table is unavailable: the customer turn still completes and the gap is recorded.
    await pg.run(`alter table public.ai_agent_orders rename to ai_agent_orders_x;`);
    try {
      await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    } finally {
      await pg.run(`alter table public.ai_agent_orders_x rename to ai_agent_orders;`);
    }
    assert.equal((await allOrders()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.track_failed'`), 1);
    assert.match(await reportText(), /May be incomplete: 1 chat could not be analysed/);
  });

  test("order tracking no longer depends on the AI contact scope, and the report says so", async () => {
    for (const scope of ["selected", "none"]) {
      await configure({ contact_scope: scope });
      const text = await reportText();
      assert.doesNotMatch(text, /selected for the AI|no customers are selected/, `scope ${scope}: no stale limitation`);
      assert.doesNotMatch(text, /⚠️/, `scope ${scope}: a healthy report`);
    }
  });

  test("the report carries every field staff need", async () => {
    modelOrders(draft({ notes: "Gate code 1234, ring twice" }));
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning, gate code 1234 ring twice");
    await pg.run(`update public.ai_agent_orders set customer_name = 'Jane Doe' where chat_id = ${lit(JANE.chat)};`);
    modelOrders(draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: null, requested_for: null }), { order_target: "new" });
    await customerSays(MARCUS, "4 Dog Treats please, delivery");
    await pg.run(`update public.ai_agent_orders set first_message_at = '2026-10-25T15:00:00Z', last_message_at = '2026-10-26T15:00:00Z' where chat_id = ${lit(MARCUS.chat)};`);
    const text = await reportText();
    for (const part of [
      "Jane Doe · #", "📞 555-0101", "2 × Monello Chicken 15kg", "📍 12 Main St Gros Islet", "🕐 morning",
      "Note: Gate code 1234, ring twice",
      "555-0102 · #", "4 × Dog Treats",
    ]) assert.ok(text.includes(part), part);
    assert.doesNotMatch(text, /Needs |Phone:/, "known facts only: no placeholders, no 'needs' lines, no labels");
  });

  test("a delivery update from the customer changes the same order; cancelled and fulfilled orders drop out of the report", async () => {
    const o = await awaitingOrder();
    modelOrders(draft({ delivery_preference: "collection", delivery_address: null, requested_for: "Saturday 10am" }), { order_target: o.ref_code });
    await customerSays(JANE, "actually I will collect on Saturday 10am instead");
    const all = await allOrders();
    assert.equal(all.length, 1);
    assert.equal(all[0].fulfilment_method, "collection");
    assert.match(all[0].requested_for, /^\w{3} \d{1,2} \w{3} \(Saturday 10am\)$/);
    assert.deepEqual(all[0].missing_fields, []);
    assert.match(await reportText(), /📅 \*\w{3} \d{1,2} \w{3}\* \(1\)\n\n🛍 \*Collection\*[\s\S]*🛍 collection · 🕐 10am/);

    await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "u", action: "cancel", reason: "customer called" });
    const text = await reportText();
    assert.doesNotMatch(text, /Monello/);
    assert.match(text, /No outstanding orders\./);
    assert.equal((await allOrders())[0].status, "cancelled");
  });

  // ── !update is retired; !orders is the operational report ────────────────────

  test("!update is retired: in every group and for every sender it is ordinary staff chatter that posts and records nothing", async () => {
    await seedMixedOrders();
    await configure({ orders_group_jid: ORDERS_GROUP });
    const calls = modelCalls.length;
    for (const [text, opts] of [["!update", {}], ["!update", { group: ORDERS_GROUP }], ["!UPDATE", {}], ["!update the price list please", {}], ["!update", { group: OTHER_GROUP }], ["!update", { sender: STRANGER }]] as const) {
      const res = await groupSays(text, { ...opts });
      assert.deepEqual(res.outbox.filter((o) => /order|update|Only authorized/i.test(o.body)), [], `${text} ${JSON.stringify(opts)}`);
    }
    assert.equal(await count(`select 1 from public.ai_agent_order_update_posts`), 0, "no update post is ever written any more");
    assert.equal(modelCalls.length, calls);
    assert.equal(await customerBound(), 0);
  });

  test("an unauthorized sender is refused !orders and nothing is shown", async () => {
    await seedMixedOrders();
    const res = await groupSays("!orders", { sender: STRANGER });
    assert.equal(res.outbox.length, 1);
    assert.match(res.outbox[0].body, /Only authorized staff/);
    assert.doesNotMatch(res.outbox[0].body, /Jane|Marcus/);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.command_rejected' and details->>'reason' = 'unauthorized'`), 1);
    const none = await groupSays("!orders", { sender: null });
    assert.match(none.outbox[0].body, /Only authorized staff/);
  });

  test("!orders from any other group is ignored and audited, and nothing is posted there", async () => {
    await seedMixedOrders();
    const res = await groupSays("!orders", { group: OTHER_GROUP });
    assert.equal(res.status, "ignored");
    assert.deepEqual(res.outbox, []);
    assert.equal(await count(`select 1 from public.ai_agent_outbox where to_jid = ${lit(OTHER_GROUP)}`), 0);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.update_rejected' and details->>'reason' = 'wrong_group'`), 1);
    // The other business's group cannot pull this business's orders either.
    const sea = await groupSays("!orders", { group: SEA_GROUP, biz: "by_sea" });
    assert.doesNotMatch(sea.outbox[0]?.body ?? "", /Jane|Marcus|Monello/);
    const crossed = await groupSays("!orders", { group: SEA_GROUP, biz: "dog_food" });
    assert.equal(crossed.status, "ignored");
  });

  test("!orders with the summary switched off says so and posts nothing", async () => {
    await configure({ orders_summary_enabled: false });
    const res = await groupSays("!orders");
    assert.match(res.outbox[0]?.body ?? "", /not switched on/);
  });

  test("!orders in Observe mode without notices enabled posts nothing", async () => {
    await configure({ mode: "observe", staff_notices_enabled: false });
    const res = await groupSays("!orders");
    assert.deepEqual(res.outbox, []);
  });

  test("the views only read: no orders or events change, no model call, no customer message", async () => {
    await seedMixedOrders();
    const snapshot = async () => JSON.stringify([await allOrders(), await orderEvents()]);
    const before = await snapshot();
    const escalations = await count(`select 1 from public.ai_agent_escalations`);
    const calls = modelCalls.length;
    for (const text of ["!orders", "!orders overdue", "!orders missing", "!orders today", "!orders tomorrow", "!orders all"]) {
      const res = await groupSays(text);
      assert.ok(res.outbox.length >= 1, text);
    }
    assert.equal(await snapshot(), before);
    assert.equal(modelCalls.length, calls);
    assert.equal(await customerBound(), 0);
    assert.equal(await count(`select 1 from public.ai_agent_escalations`), escalations);
  });

  // ── The schedule and the commands are independent ───────────────────────────

  test("!orders works although the scheduled summary has never run, and the 8 AM schedule works although nobody types any command (and !update is gone)", async () => {
    await seedMixedOrders();
    assert.equal((await groupSays("!orders all")).outbox.length, 1);
    assert.equal((await runs()).length, 0, "!orders leaves no scheduled-run record");
    assert.equal(await orders.runScheduledSummary(await settingsOf(), D(EIGHT_AM)), "sent");
    assert.equal((await summaryOutbox()).length, 1);
    assert.deepEqual((await runs()).map((r) => r.trigger), ["scheduled"]);
  });

  test("a scheduled run that was missed or blocked leaves !orders working", async () => {
    await seedMixedOrders();
    assert.equal(await orders.runScheduledSummary(await settingsOf(), D("2026-10-27T21:00:00Z")), "missed");
    const res = await groupSays("!orders all");
    assert.equal(res.outbox[0].send, true);
    assert.match(res.outbox[0].body, /Jane/);
  });

  // ── A separate Orders group ────────────────────────────────────────────────

  test("a separate Orders group receives the summary and is the only place the order commands work", async () => {
    await seedMixedOrders();
    await configure({ orders_group_jid: ORDERS_GROUP });
    const inOrders = await groupSays("!orders all", { group: ORDERS_GROUP });
    assert.equal(inOrders.outbox.length, 1);
    assert.equal(inOrders.outbox[0].to, ORDERS_GROUP);
    assert.match(inOrders.outbox[0].body, /Jane/);
    const viewed = await groupSays("!orders all", { group: ORDERS_GROUP });
    assert.equal(viewed.outbox[0].to, ORDERS_GROUP);
    const inStaff = await groupSays("!orders all");
    assert.match(inStaff.outbox[0].body, /used in the Orders group/);
    assert.equal(inStaff.outbox[0].to, GROUP);

    assert.equal(await orders.runScheduledSummary(await settingsOf(), D(EIGHT_AM)), "sent");
    assert.equal((await summaryOutbox()).at(-1)!.to_jid, ORDERS_GROUP);
  });

  test("the Orders group never feeds the escalation logic", async () => {
    await configure({ orders_group_jid: ORDERS_GROUP });
    const chatter = await groupSays("2 Monello Chicken for Jane, send it", { group: ORDERS_GROUP });
    assert.equal(chatter.status, "done");
    assert.deepEqual(chatter.outbox, []);
    assert.equal(await count(`select 1 from public.ai_agent_escalations`), 0);
    assert.equal(await count(`select 1 from public.ai_agent_staff_answers`), 0);
    const unauthorized = await groupSays("!orders", { group: ORDERS_GROUP, sender: STRANGER });
    assert.match(unauthorized.outbox[0].body, /Only authorized staff/);
    assert.equal(unauthorized.outbox[0].to, ORDERS_GROUP);
  });

  test("the bridge claim hands out a summary for the Orders group only while the summary is on", async () => {
    await configure({ orders_group_jid: ORDERS_GROUP });
    await orders.runScheduledSummary(await settingsOf(), D(EIGHT_AM));
    assert.equal(await count(`select * from public.claim_ai_agent_outbox('dog_food', 10)`), 1);

    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key)
                  values ('dog_food', ${lit(ORDERS_GROUP)}, 'staff_notice', ${lit(ORDERS_GROUP)}, 'x', 'ordersummary:test:off');`);
    await configure({ orders_summary_enabled: false, orders_group_jid: ORDERS_GROUP });
    assert.equal(await count(`select * from public.claim_ai_agent_outbox('dog_food', 10)`), 0);
    // And a random group that is neither the staff group nor the orders group is never served.
    await configure({ orders_group_jid: ORDERS_GROUP });
    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key)
                  values ('dog_food', ${lit(OTHER_GROUP)}, 'staff_notice', ${lit(OTHER_GROUP)}, 'x', 'ordersummary:test:other');`);
    const claimed = await rows(`select to_jid from public.claim_ai_agent_outbox('dog_food', 10)`);
    assert.deepEqual(claimed.map((c) => c.to_jid), [ORDERS_GROUP]);
  });

  // ── Approval Pilot unchanged ───────────────────────────────────────────────

  test("a whole day of orders, confirmations, the report and !orders creates no customer-bound message", async () => {
    for (const mode of ["approval_pilot", "observe"]) {
      await pg.run(`truncate public.ai_agent_orders, public.ai_agent_outbox, public.ai_agent_events, public.ai_agent_escalations, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_pilot_drafts, public.ai_agent_order_requests cascade;`);
      await configure({ mode, staff_notices_enabled: true });
      const o = await awaitingOrder();
      await staffWritesTo(JANE, "Please confirm");
      modelOrders(draft(), { order_target: o.ref_code });
      await customerSays(JANE, "yes");
      await orders.runScheduledSummary(await settingsOf(), D(EIGHT_AM));
      await groupSays("!orders");
      assert.equal(await customerBound(), 0, mode);
      assert.equal(await count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`), 0, mode);
    }
  });

  // ── Customer deletion ──────────────────────────────────────────────────────

  test("forgetting a customer removes their orders and history", async () => {
    await awaitingOrder();
    await awaitingOrder(MARCUS);
    await pg.run(`select public.forget_ai_agent_customer('dog_food', array[${lit(JANE.chat)}], ${lit(JANE.phone)}, true, true);`);
    const left = await allOrders();
    assert.equal(left.length, 1);
    assert.equal(left[0].chat_id, MARCUS.chat);
    assert.equal(await count(`select 1 from public.ai_agent_order_events e where not exists (select 1 from public.ai_agent_orders o where o.id = e.order_id)`), 0);
  });
});
