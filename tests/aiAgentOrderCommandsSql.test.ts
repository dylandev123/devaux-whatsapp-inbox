// WhatsApp order commands and the cleaned-up daily report, end to end: the app's REAL server code (processBridgeMessage
// → staff-group commands → the same order mutation the dashboard uses → outbox) against the REAL migrations in a
// throwaway Postgres. Only the language model is replaced by a scripted stand-in. Skips itself when no Postgres
// binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import { resolveRelativeDay } from "../lib/aiAgent/orderText.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const ORDERS_GROUP = "120363000000000003@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";

const JANE = { chat: "17582867466@s.whatsapp.net", phone: "17582867466" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102" };
const PRIYA = { chat: "17585550103@s.whatsapp.net", phone: "17585550103" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE", intent: "other", reply: null, confidence: 0.2, knowledge_ids: [], escalation_reason: "needs staff",
  priority: null, summary: null, order_request: null, memory_facts: [], ...over,
});
let script: () => Proposal = () => proposal();
let modelCalls = 0;

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
  delivery_address: "Cap Estate", delivery_preference: "delivery", notes: null, requested_for: null, ...over,
});
const modelOrders = (d: Draft | null, extra: Partial<Proposal> = {}) => {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order", ...extra });
};

/** Epoch used for "when the customer wrote it": a Monday, 10:00 in St Lucia. */
const MONDAY = "2026-10-26T14:00:00.000Z";

async function customerSays(c: Customer, text: string, opts: { at?: string; id?: string } = {}) {
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: opts.id ?? `CUST-${++seq}`, chatId: c.chat, contactNumber: c.phone, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: opts.at ?? new Date().toISOString(),
  });
}

async function groupSays(text: string, opts: { group?: string; sender?: string | null; biz?: string; id?: string; at?: string | null; quoted?: string | null } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `GRP-${++seq}`, chatId: opts.group ?? GROUP, contactNumber: null,
    fromMe: false, text, hasMedia: false, quotedMessageId: opts.quoted ?? null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender, senderPhone: null,
    timestamp: opts.at === undefined ? new Date().toISOString() : opts.at,
  });
}

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderEvents = (orderId: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_events where order_id = ${lit(orderId)} order by created_at, id`);
const ref = (o: Record<string, any>) => `#${String(o.ref_code).slice(2)}`;
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const notToAGroup = () => count(`select 1 from public.ai_agent_outbox where to_jid not like '%@g.us'`);
const auditCount = (action: string) => count(`select 1 from public.ai_agent_audit_log where action = ${lit(action)}`);
const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

/** A customer order, as the AI path would record it. */
async function makeOrder(c: Customer, text: string, d: Draft = draft(), at: string = MONDAY, extra: Partial<Proposal> = {}) {
  modelOrders(d, extra);
  await customerSays(c, text, { at });
  const all = await allOrders();
  return all.filter((o) => o.chat_id === c.chat && o.status !== "cancelled").at(-1)!;
}
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const refOf = (prefix: string, i: number) => `O-${prefix.slice(0, 3)}${ALPHABET[Math.floor(i / 32)]}${ALPHABET[i % 32]}`.slice(0, 7);
const ORDER_TEXT = "a bag of Monello Chicken 25kg, bring it to Cap Estate";
/** Manual summaries have a cooldown; tests that post several clear it first. */
const freshReport = async () => {
  await pg.run("truncate public.ai_agent_order_summary_runs; truncate public.ai_agent_order_update_posts;");
  return reply(await groupSays("!orders all"));
};
const reply = (res: { outbox: { body: string; to: string }[] }) => res.outbox.map((o) => o.body).join("\n---\n");

describe("WhatsApp order commands (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async () => {
      modelCalls += 1;
      return { proposal: script(), model: "scripted", error: null };
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
        public.ai_agent_shadow_results, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls = 0;
    script = () => proposal();
  });

  // ── Staff updates an order ─────────────────────────────────────────────────

  test("!order #REF confirmed marks the order staff-confirmed, audited, with a short reply to the group only", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    assert.equal(o.status, "awaiting_confirmation");
    const calls = modelCalls;
    const res = await groupSays(`!order ${ref(o)} confirmed`);
    assert.equal(res.status, "done");
    assert.equal(res.outbox.length, 1);
    assert.equal(res.outbox[0].to, GROUP);
    assert.match(res.outbox[0].body, new RegExp(`✅ ${ref(o)} \\(.*\\): awaiting confirmation → confirmed \\(internal staff confirmation\\)\\. The customer was not messaged\\.`));
    const [after] = await allOrders();
    assert.equal(after.status, "confirmed");
    assert.equal(after.confirmed_by, "staff:17585550001");
    assert.equal(after.attention, null);
    assert.equal(after.version, o.version + 1);
    const events = await orderEvents(o.id);
    const last = events.at(-1)!;
    assert.deepEqual([last.kind, last.actor_kind, last.actor_id], ["staff_whatsapp_confirm", "staff", "17585550001"]);
    assert.deepEqual(last.changes.status, { before: "awaiting_confirmation", after: "confirmed" });
    assert.equal(await auditCount("order.confirm"), 1);
    assert.equal(modelCalls, calls, "no model call for a simple command");
    assert.equal(await customerBound(), 0);
    assert.equal(await notToAGroup(), 0);
  });

  test("confirming an incomplete order is refused with what is missing; an already confirmed one is a no-op", async () => {
    const o = await makeOrder(JANE, "a bag of Monello please", draft({ items: [{ product: "Monello", quantity: "1" }], delivery_address: null, delivery_preference: null }));
    const refused = await groupSays(`!order ${ref(o)} confirmed`);
    assert.match(reply(refused), /can't be confirmed yet — missing: delivery address\. Nothing changed\./);
    assert.equal((await allOrders())[0].status, "possible");

    const complete = await makeOrder(MARCUS, ORDER_TEXT);
    await groupSays(`!order ${ref(complete)} confirmed`);
    const again = await groupSays(`!order ${ref(complete)} confirmed`);
    assert.match(reply(again), /already confirmed — no change/);
    assert.equal((await orderEvents(complete.id)).filter((e) => e.kind === "staff_whatsapp_confirm").length, 1);
  });

  test("!order #REF cancelled cancels it; it leaves the report and a later command says it is closed", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const res = await groupSays(`!order ${ref(o)} cancelled`);
    assert.match(reply(res), /🚫 .* cancelled\. The customer was not messaged\./);
    const [after] = await allOrders();
    assert.equal(after.status, "cancelled");
    assert.ok(after.cancelled_at);
    assert.equal(after.cancel_reason, "cancelled by staff via WhatsApp");
    assert.match(reply(await groupSays(`!order ${ref(o)} confirmed`)), /is already cancelled — nothing changed/);
    assert.equal((await allOrders())[0].status, "cancelled");
    assert.equal(await customerBound(), 0);
  });

  test("!order #REF 3 bags changes the quantity, locks the field, and keeps the history", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const res = await groupSays(`!order ${ref(o)} 3 bags`);
    assert.match(reply(res), /quantity 1 → 3 \(Monello Chicken 25kg\)/);
    const [after] = await allOrders();
    assert.deepEqual(after.items, [{ product: "Monello Chicken", quantity: "3", variant: null, size: "25kg" }]);
    assert.ok(after.manual_locked_fields.includes("items"));
    const last = (await orderEvents(o.id)).at(-1)!;
    assert.equal(last.kind, "staff_whatsapp_edit");
    assert.equal(last.changes.items.before[0].quantity, "1");
    assert.equal(last.changes.items.after[0].quantity, "3");
    // Same quantity again: nothing changes.
    assert.match(reply(await groupSays(`!order ${ref(o)} 3 bags`)), /already has quantity 3 — no change/);
    assert.equal((await orderEvents(o.id)).length, 2);
  });

  test("a quantity needs one product; with several the command points to the dashboard", async () => {
    const o = await makeOrder(JANE, "a bag of Monello and a bag of Dog Treats, bring it to Cap Estate", draft({ items: [{ product: "Monello", quantity: "1" }, { product: "Dog Treats", quantity: "1" }] }));
    assert.match(reply(await groupSays(`!order ${ref(o)} 2 bags`)), /has 2 products — change quantities in the Orders dashboard\. Nothing changed\./);
    assert.deepEqual((await allOrders())[0].items.map((i: any) => i.quantity), ["1", "1"]);
  });

  test("!order #REF delivery tomorrow sets the date from when the staff member wrote it", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const at = new Date().toISOString();
    const tomorrow = `${resolveRelativeDay("tomorrow", new Date(at), "America/St_Lucia")!.label} (tomorrow)`;
    const res = await groupSays(`!order ${ref(o)} delivery tomorrow`, { at });
    assert.match(reply(res), new RegExp(`delivery date → ${tomorrow.replace(/[()]/g, "\\$&")}`));
    const [after] = await allOrders();
    assert.equal(after.requested_for, tomorrow);
    assert.ok(after.manual_locked_fields.includes("requested_for"));
    assert.equal(after.fulfilment_method, "delivery");
    // Processed days later, a repeat of the same wording from the same message time lands on the same day.
    assert.match(reply(await groupSays(`!order ${ref(o)} delivery tomorrow`, { at })), /already has that date — no change/);
  });

  // ── Selecting by name or phone ─────────────────────────────────────────────

  test("a unique name or phone finds its order with !order <name>; changing an order needs its reference", async () => {
    await configure();
    const jane = await makeOrder(JANE, ORDER_TEXT);
    const marcus = await makeOrder(MARCUS, ORDER_TEXT);
    await pg.run(`update public.ai_agent_orders set customer_name = 'Jane Doe' where id = ${lit(jane.id)}; update public.ai_agent_orders set customer_name = 'Marcus Lee' where id = ${lit(marcus.id)};`);

    assert.match(reply(await groupSays("!order marcus")), /Marcus Lee/);
    assert.match(reply(await groupSays("!order 286-7466")), /Jane Doe/);
    // A name or phone never changes an order: those words are a search, and !update is no longer a command.
    const before = JSON.stringify((await allOrders()).map((o) => [o.id, o.version, o.status]));
    assert.match(reply(await groupSays("!order marcus confirmed")), /No active order matches/);
    assert.match(reply(await groupSays("!order 286-7466 2 bags")), /No active order matches/);
    assert.equal((await groupSays("!update marcus confirmed")).outbox.length, 0, "!update is ordinary staff chatter");
    assert.equal(JSON.stringify((await allOrders()).map((o) => [o.id, o.version, o.status])), before);
    // The reference always works.
    assert.match(reply(await groupSays(`!order ${ref(marcus)} confirmed`)), /Marcus Lee\): .* → confirmed \(internal staff confirmation\)/);
    assert.match(reply(await groupSays("!order #ZZZZ9 confirmed")), /No order #ZZZZ9 found\. Nothing changed/);
  });

  // ── Who may do it, and where ───────────────────────────────────────────────

  test("an unauthorized sender changes nothing and is told so; it is audited", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    for (const sender of [STRANGER, null]) {
      const res = await groupSays(`!order ${ref(o)} confirmed`, { sender });
      assert.match(reply(res), /Only authorized staff can use order commands/);
    }
    assert.match(reply(await groupSays("!order jane", { sender: STRANGER })), /Only authorized staff/);
    assert.match(reply(await groupSays(`!moreinfo ${ref(o)}`, { sender: STRANGER })), /Only authorized staff/);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    assert.equal(await auditCount("orders.command_rejected"), 4);
  });

  test("commands in any other group are ignored silently and audited; nothing is posted there", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    for (const text of [`!order ${ref(o)} cancelled`, "!order jane", `!moreinfo ${ref(o)}`]) {
      const res = await groupSays(text, { group: OTHER_GROUP });
      assert.equal(res.status, "ignored");
      assert.deepEqual(res.outbox, []);
    }
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    assert.equal(await auditCount("orders.update_rejected"), 3);
  });

  test("businesses are isolated: another business's group cannot see or change this business's orders", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const sea = await groupSays(`!order ${ref(o)} cancelled`, { group: SEA_GROUP, biz: "by_sea" });
    assert.match(reply(sea), new RegExp(`No order ${ref(o)} found\\. Nothing changed\\.`));
    assert.match(reply(await groupSays("!order jane", { group: SEA_GROUP, biz: "by_sea" })), /No active order matches/);
    assert.match(reply(await groupSays(`!moreinfo ${ref(o)}`, { group: SEA_GROUP, biz: "by_sea" })), /No order .* found/);
    // The sea business's group posted under the wrong business is dropped before anything happens.
    const crossed = await groupSays(`!order ${ref(o)} cancelled`, { group: SEA_GROUP, biz: "dog_food" });
    assert.equal(crossed.status, "ignored");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
  });

  test("order commands work only while the feature is on and the agent may post in its mode", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await configure({ orders_summary_enabled: false });
    assert.match(reply(await groupSays(`!order ${ref(o)} confirmed`)), /not switched on/);
    await configure({ mode: "observe", staff_notices_enabled: false });
    const res = await groupSays(`!order ${ref(o)} confirmed`);
    assert.deepEqual(res.outbox, [], "Observe without notices cannot answer, so it does not act");
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    await configure({ mode: "observe", staff_notices_enabled: true });
    assert.match(reply(await groupSays(`!order ${ref(o)} confirmed`)), /→ confirmed \(internal staff confirmation\)/);
  });

  test("a separate Orders group takes the commands and the staff group is pointed to it", async () => {
    await configure({ orders_group_jid: ORDERS_GROUP });
    const o = await makeOrder(JANE, ORDER_TEXT);
    const inStaff = await groupSays(`!order ${ref(o)} confirmed`);
    assert.match(reply(inStaff), /Order commands are used in the Orders group/);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    const inOrders = await groupSays(`!order ${ref(o)} confirmed`, { group: ORDERS_GROUP });
    assert.equal(inOrders.outbox[0].to, ORDERS_GROUP);
    assert.match(reply(inOrders), /→ confirmed \(internal staff confirmation\)/);
    assert.match(reply(await groupSays("!order jane", { group: ORDERS_GROUP })), /No active order|active order/);
    assert.deepEqual((await groupSays("just chatting", { group: ORDERS_GROUP })).outbox, []);
  });

  // ── Duplicates, stale and conflicting updates ──────────────────────────────

  test("the same WhatsApp message delivered twice changes the order once", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const first = await groupSays(`!order ${ref(o)} 2 bags`, { id: "DUP-1" });
    const second = await groupSays(`!order ${ref(o)} 2 bags`, { id: "DUP-1" });
    assert.equal(first.outbox.length, 1);
    assert.equal(second.status, "duplicate");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_edit").length, 1);
    assert.equal((await allOrders())[0].version, o.version + 1);
  });

  test("a redelivery that gets past the message log (a worker died mid-way) still applies once and answers once", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const base = { settings: await settingsOf(), fromGroup: GROUP, command: { kind: "update" as const, selector: { type: "ref" as const, ref: o.ref_code }, action: { type: "quantity" as const, quantity: 4 } },
      senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF, whatsappMessageId: "WA-SAME", timestamp: new Date().toISOString(), now: new Date() };
    const a = await orders.handleOrderCommand({ ...base, eventId: "evt-a" });
    // The first attempt's order change is stored; the retry (a different internal event) sees the same WhatsApp message.
    await pg.run(`update public.ai_agent_orders set items = '[{"product":"Monello Chicken","quantity":"1","variant":null,"size":"25kg"}]'::jsonb where id = ${lit(o.id)};`);
    const b = await orders.handleOrderCommand({ ...base, eventId: "evt-b" });
    assert.match(a.outbox[0].body, /quantity 1 → 4/);
    assert.match(b.outbox[0].body, /quantity 1 → 4/, "answered, so staff are not left without a reply");
    assert.equal(a.outbox[0].dedupeKey, b.outbox[0].dedupeKey, "but both are the same notice, so the group sees it once");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_edit").length, 1, "but the change is recorded once");
  });

  test("a command is refused when the customer changed the order after it was written", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT, draft(), new Date(Date.now() - 3_600_000).toISOString());
    // The command was typed 10 minutes ago…
    const typed = new Date(Date.now() - 10 * 60_000).toISOString();
    // …and the customer changed the order 5 minutes ago (after it).
    await pg.run(`update public.ai_agent_orders set version = version + 1 where id = ${lit(o.id)};
                  insert into public.ai_agent_order_events (order_id, business_slug, kind, actor_kind, changes, created_at)
                  values (${lit(o.id)}, 'dog_food', 'ai_update', 'ai', '{}'::jsonb, now() - interval '5 minutes');`);
    const res = await groupSays(`!order ${ref(o)} 9 bags`, { at: typed });
    assert.match(reply(res), /changed after your message was sent — nothing applied/);
    assert.deepEqual((await allOrders())[0].items.map((i: any) => i.quantity), ["1"]);
    // Sent again now, it applies.
    assert.match(reply(await groupSays(`!order ${ref(o)} 9 bags`)), /quantity 1 → 9/);
  });

  test("two commands typed seconds apart both apply (a staff command never makes the next one stale)", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const t0 = Date.now();
    const a = await groupSays(`!order ${ref(o)} 2 bags`, { at: new Date(t0).toISOString() });
    const b = await groupSays(`!order ${ref(o)} delivery tomorrow`, { at: new Date(t0 + 1500).toISOString() });
    assert.match(reply(a), /quantity 1 → 2/);
    assert.match(reply(b), /delivery date →/);
    const [after] = await allOrders();
    assert.equal(after.items[0].quantity, "2");
    assert.match(after.requested_for, /\(tomorrow\)$/);
  });

  test("a command written hours ago (an offline catch-up) is not applied", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    assert.match(reply(await groupSays(`!order ${ref(o)} cancelled`, { at: old })), /more than 2 hours ago, so it was not applied/);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
  });

  test("an update that loses a race with another writer is rejected by the version check, not applied on top", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 2 bags`);
    const stale = await orders.updateOrderManually({
      businessSlug: "dog_food", orderId: o.id, adminId: "17585550001", actor: "staff", action: "edit", expectedVersion: o.version,
      patch: { items: [{ product: "Monello Chicken", quantity: "7" }] },
    });
    assert.deepEqual([stale.ok, stale.ok ? null : stale.code], [false, "conflict"]);
    assert.equal((await allOrders())[0].items[0].quantity, "2");
  });

  // ── Staff field locks ──────────────────────────────────────────────────────

  test("what staff set by command is locked against the AI; staff can still change it again", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 3 bags`);
    await groupSays(`!order ${ref(o)} delivery tomorrow`);
    const tomorrow = (await allOrders())[0].requested_for;
    assert.match(tomorrow, /\(tomorrow\)$/);
    // The customer later writes something that would change both; the AI may not overwrite staff's values.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "5", size: "25kg" }], requested_for: "Friday" }), { order_target: o.ref_code });
    await customerSays(JANE, "make it 5 bags of Monello Chicken 25kg, Friday please");
    const [after] = await allOrders();
    assert.equal(after.items[0].quantity, "3");
    assert.equal(after.requested_for, tomorrow);
    // Staff, though, can still correct their own value.
    assert.match(reply(await groupSays(`!order ${ref(o)} 5 bags`)), /quantity 3 → 5/);
  });

  test("a customer's recorded yes is voided by a staff quantity change, exactly as in the dashboard", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await pg.run(`update public.ai_agent_orders set customer_confirmed_at = now(), attention = 'customer_replied_yes' where id = ${lit(o.id)};`);
    await groupSays(`!order ${ref(o)} 2 bags`);
    const [after] = await allOrders();
    assert.equal(after.customer_confirmed_at, null);
    assert.equal(after.attention, null);
  });

  // ── Staff-locked fields the customer contradicts ───────────────────────────

  test("a customer contradicting a staff-locked field is recorded, not applied; it shows in the report, !moreinfo and the dashboard data", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 3 bags`);
    const calls = modelCalls;
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "5", size: "25kg" }] }), { order_target: o.ref_code });
    await customerSays(JANE, "actually make it 5 bags of Monello Chicken 25kg");
    const [after] = await allOrders();
    assert.equal(modelCalls, calls + 1, "no extra model call");
    assert.equal(after.items[0].quantity, "3", "the staff value is never overwritten");
    assert.equal(after.field_conflicts.items.proposed[0].quantity, "5");
    assert.equal(after.field_conflicts.items.current[0].quantity, "3");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "locked_field_conflict").length, 1);
    const report = reply(await groupSays("!orders all"));
    assert.match(report, /⚠️ Customer asked for a change — check before fulfilling/);
    assert.doesNotMatch(report, /staff set|5 × Monello/, "the report carries no technical conflict explanation");
    assert.match(reply(await groupSays(`!moreinfo ${ref(o)}`)), /⚠️ Customer now says products: 5 × Monello Chicken 25kg \(staff set 3 ×/);
    // The same stale cumulative draft on an unrelated later message adds nothing.
    await customerSays(JANE, "thanks");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "locked_field_conflict").length, 1);
    assert.equal(await customerBound(), 0);
  });

  test("a locked field the customer did not mention this turn raises no conflict (the draft repeats older words)", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 3 bags`);
    modelOrders(draft(), { order_target: o.ref_code });
    await customerSays(JANE, "what time do you open?");
    assert.deepEqual((await allOrders())[0].field_conflicts, {});
  });

  test("the conflict clears when staff edit the field, and when staff keep their value; confirmed orders still show it until then", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 3 bags`);
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "5", size: "25kg" }] }), { order_target: o.ref_code });
    await customerSays(JANE, "make it 5 bags of Monello Chicken 25kg");
    await groupSays(`!order ${ref(o)} confirmed`);
    assert.match(reply(await groupSays("!orders all")), /✅ confirmed[\s\S]*Customer asked for a change/, "a confirmed order with an open discrepancy still shows the warning");
    // Staff keep their value.
    let [cur] = await allOrders();
    const kept = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "keep", expectedVersion: cur.version });
    assert.ok(kept.ok);
    [cur] = await allOrders();
    assert.deepEqual(cur.field_conflicts, {});
    assert.equal(cur.items[0].quantity, "3");
    assert.doesNotMatch(reply(await groupSays("!orders all")), /Customer asked for a change/);
    // A second "keep" has nothing to settle.
    const again = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "keep", expectedVersion: cur.version });
    assert.equal(again.ok, false);
    // A new contradiction, resolved by staff applying the customer's value through an edit.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "6", size: "25kg" }] }), { order_target: o.ref_code });
    await customerSays(JANE, "sorry, 6 bags of Monello Chicken 25kg");
    [cur] = await allOrders();
    assert.equal(Object.keys(cur.field_conflicts).join(), "items");
    assert.match(reply(await groupSays(`!order ${ref(o)} 6 bags`)), /quantity 3 → 6/);
    [cur] = await allOrders();
    assert.deepEqual(cur.field_conflicts, {});
  });

  // ── Command acknowledgments ────────────────────────────────────────────────

  test("every successful command answers once with the reference and what changed; confirmation is internal, never customer messaging", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const qty = reply(await groupSays(`!order ${ref(o)} 2 bags`));
    assert.match(qty, new RegExp(`^✅ ${ref(o)} \\(.*\\): quantity 1 → 2`));
    const when = reply(await groupSays(`!order ${ref(o)} delivery Friday`));
    assert.match(when, new RegExp(`^✅ ${ref(o)} \\(.*\\): delivery date → Fri 30 Oct \\(Friday\\)`));
    const confirmed = reply(await groupSays(`!order ${ref(o)} confirmed`));
    assert.match(confirmed, /internal staff confirmation\)\. The customer was not messaged\./);
    const o2 = await makeOrder(MARCUS, ORDER_TEXT);
    assert.match(reply(await groupSays(`!order ${ref(o2)} cancelled`)), new RegExp(`^🚫 ${ref(o2)} \\(.*\\): awaiting confirmation → cancelled\\. The customer was not messaged\\.`));
    assert.equal(await customerBound(), 0);
  });

  test("a redelivered command is acknowledged once, not twice", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} 2 bags`, { id: "ACK-1" });
    await groupSays(`!order ${ref(o)} 2 bags`, { id: "ACK-1" });
    assert.equal(await count(`select 1 from public.ai_agent_outbox where kind = 'staff_notice' and body like '%quantity 1 → 2%'`), 1);
  });

  // ── Incomplete products ────────────────────────────────────────────────────

  test("an unknown quantity stays null in the database and reads as 'quantity needed', never '? ×'", async () => {
    const o = await makeOrder(MARCUS, "some Monello please, deliver", draft({ items: [{ product: "Monello", quantity: null }], delivery_address: "Rodney Bay" }));
    assert.equal(o.items[0].quantity, null);
    const text = reply(await groupSays("!orders all"));
    assert.match(text, /\nMonello\n/, "an unknown quantity is just the product name");
    assert.doesNotMatch(text, /\?|quantity needed|Needs quantity/);
    assert.match(reply(await groupSays(`!moreinfo ${ref(o)}`)), /• Monello — quantity needed/);
    assert.equal((await allOrders())[0].items[0].quantity, null);
  });

  // ── Completing and reopening ───────────────────────────────────────────────

  test("!order #REF completed marks it completed with time and staff identity, and it leaves !orders", async () => {
    const jane = await makeOrder(JANE, ORDER_TEXT);
    const marcus = await makeOrder(MARCUS, ORDER_TEXT);
    const calls = modelCalls;
    const res = await groupSays(`!order ${ref(jane)} completed`);
    assert.equal(res.outbox.length, 1);
    assert.equal(res.outbox[0].to, GROUP);
    assert.match(res.outbox[0].body, new RegExp(`✔️ ${ref(jane)} .*: completed\\. .*The customer was not messaged\\.`));
    const after = (await allOrders()).find((o) => o.id === jane.id)!;
    assert.equal(after.status, "fulfilled");
    assert.ok(after.fulfilled_at);
    const last = (await orderEvents(jane.id)).at(-1)!;
    assert.deepEqual([last.kind, last.actor_kind, last.actor_id], ["staff_whatsapp_fulfil", "staff", "17585550001"]);
    assert.deepEqual(last.changes.status, { before: "awaiting_confirmation", after: "fulfilled" });
    assert.equal(await auditCount("order.fulfil"), 1);
    // Gone from the report, the other order stays; history and the order itself are kept and still viewable.
    const report = await freshReport();
    assert.doesNotMatch(report, new RegExp(ref(jane)));
    assert.match(report, new RegExp(ref(marcus)));
    const info = reply(await groupSays(`!order ${ref(jane)}`));
    assert.match(info, /Status: Completed/);
    assert.match(info, /Completed .* by 17585550001/);
    assert.match(reply(await groupSays("!order jane")), /No active order matches/);
    // No model call, no customer message, no delivery side effect.
    assert.equal(modelCalls, calls);
    assert.equal(await customerBound(), 0);
    assert.equal(await notToAGroup(), 0);
  });

  test("completing twice (same message or a new one) adds no second event and no second notice", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    const first = await groupSays(`!order ${ref(o)} completed`, { id: "DONE-1" });
    const redelivered = await groupSays(`!order ${ref(o)} completed`, { id: "DONE-1" });
    assert.equal(first.outbox.length, 1);
    assert.equal(redelivered.status, "duplicate");
    // A worker retry that gets past the message log: same WhatsApp message, new internal event.
    const base = { settings: await settingsOf(), fromGroup: GROUP, command: { kind: "update" as const, selector: { type: "ref" as const, ref: o.ref_code }, action: { type: "complete" as const } },
      senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF, whatsappMessageId: "DONE-1", timestamp: new Date().toISOString(), now: new Date() };
    const retry = await orders.handleOrderCommand({ ...base, eventId: "evt-retry" });
    assert.equal(retry.outbox[0].dedupeKey, "ordercmd:dog_food:DONE-1:ack", "keyed by the WhatsApp message, so the group sees one notice");
    const again = await groupSays(`!order ${ref(o)} completed`);
    assert.match(reply(again), /already completed — no change/);
    const fulfilEvents = (await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_fulfil");
    assert.equal(fulfilEvents.length, 1);
    assert.equal((await allOrders())[0].version, o.version + 1);
  });

  test("!order #REF reopen restores a completed order to its working state; reopening twice or an open order changes nothing", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} confirmed`);
    await groupSays(`!order ${ref(o)} completed`);
    assert.doesNotMatch(await freshReport(), new RegExp(ref(o)));
    const res = await groupSays(`!order ${ref(o)} reopen`, { id: "REOPEN-1" });
    assert.match(reply(res), new RegExp(`↩️ ${ref(o)} .*: reopened \\(confirmed\\)\\. It shows in !orders again\\.`));
    const [after] = await allOrders();
    assert.equal(after.status, "confirmed");
    assert.equal(after.fulfilled_at, null);
    assert.match(await freshReport(), new RegExp(ref(o)));
    const events = await orderEvents(o.id);
    assert.deepEqual(events.at(-1)!.changes.status, { before: "fulfilled", after: "confirmed" });
    assert.equal(events.at(-1)!.actor_id, "17585550001");
    assert.equal(events.filter((e) => e.kind === "staff_whatsapp_fulfil").length, 1, "the completion stays in the history");
    assert.equal((await groupSays(`!order ${ref(o)} reopen`, { id: "REOPEN-1" })).status, "duplicate");
    assert.match(reply(await groupSays(`!order ${ref(o)} reopen`)), /is not completed \(confirmed\) — nothing to reopen/);
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_reopen").length, 1);
    // An order that was never confirmed returns to awaiting confirmation.
    const m = await makeOrder(MARCUS, ORDER_TEXT);
    await groupSays(`!order ${ref(m)} completed`);
    await groupSays(`!order ${ref(m)} reopen`);
    assert.equal((await allOrders()).find((x) => x.id === m.id)!.status, "awaiting_confirmation");
    assert.equal(await customerBound(), 0);
  });

  test("completing needs an authorized sender in the configured group; a stranger, another group or another business changes nothing", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    assert.match(reply(await groupSays(`!order ${ref(o)} completed`, { sender: STRANGER })), /Only authorized staff/);
    assert.match(reply(await groupSays(`!order ${ref(o)} completed`, { sender: null })), /Only authorized staff/);
    assert.equal((await groupSays(`!order ${ref(o)} completed`, { group: OTHER_GROUP })).status, "ignored");
    assert.match(reply(await groupSays(`!order ${ref(o)} completed`, { group: SEA_GROUP, biz: "by_sea" })), /No order .* found\. Nothing changed\./);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    // Reopening is guarded the same way.
    await groupSays(`!order ${ref(o)} completed`);
    assert.match(reply(await groupSays(`!order ${ref(o)} reopen`, { sender: STRANGER })), /Only authorized staff/);
    assert.equal((await groupSays(`!order ${ref(o)} reopen`, { group: SEA_GROUP, biz: "by_sea" })).outbox.length, 1);
    assert.equal((await allOrders())[0].status, "fulfilled");
    assert.equal((await orderEvents(o.id)).length, 2, "only the creation and the one authorized completion");
  });

  test("a missing order, a cancelled order or a non-reference selector is refused without a change", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    assert.match(reply(await groupSays("!order #ZZZZ9 completed")), /No order #ZZZZ9 found\. Nothing changed\./);
    assert.match(reply(await groupSays("!order #ZZZZ9 reopen")), /No order #ZZZZ9 found/);
    assert.match(reply(await groupSays("!order jane completed")), /Order commands/);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    await groupSays(`!order ${ref(o)} cancelled`);
    assert.match(reply(await groupSays(`!order ${ref(o)} completed`)), /is already cancelled — nothing changed/);
    assert.match(reply(await groupSays(`!order ${ref(o)} reopen`)), /is not completed \(cancelled\)/);
    assert.equal((await allOrders())[0].status, "cancelled");
  });

  test("a completed order cannot be edited by !order #REF until it is reopened", async () => {
    const o = await makeOrder(JANE, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} completed`);
    assert.match(reply(await groupSays(`!order ${ref(o)} 5 bags`)), /is already completed — nothing changed/);
    assert.equal((await allOrders())[0].items[0].quantity, "1");
  });

  // ── !orders: outstanding orders by the day they are for ─────────────────────

  /** An order for a given day, written just now (so "tomorrow" is the real tomorrow), as the AI path records it. */
  async function datedOrder(c: Customer, when: string, over: Partial<Draft> = {}) {
    return makeOrder(c, `a bag of Monello Chicken 25kg, bring it to Cap Estate ${when}`, draft({ requested_for: when, ...over }), new Date().toISOString());
  }
  const nextReport = async (text: string, opts: Parameters<typeof groupSays>[1] = {}) => {
    await pg.run("truncate public.ai_agent_order_update_posts;");
    return reply(await groupSays(text, opts));
  };

  test("!orders groups by the day each order is FOR (not the day it arrived), split into delivery and collection", async () => {
    // (The day has to be in the customer's own words: the tracker never invents one.)
    const a = await datedOrder(JANE, "today");
    const b = await datedOrder(MARCUS, "tomorrow");
    const c = await makeOrder(PRIYA, "2 Monello for collection tomorrow", draft({ items: [{ product: "Monello", quantity: "2" }], delivery_preference: "collection", delivery_address: null, requested_for: "tomorrow" }), new Date().toISOString());
    // Jane's order was first written a week ago.
    await pg.run(`update public.ai_agent_orders set first_message_at = now() - interval '7 days' where id = ${lit(a.id)};`);
    const calls = modelCalls;
    const res = await groupSays("!orders");
    const text = reply(res);
    assert.equal(res.outbox[0].to, GROUP);
    assert.match(text, /^📋 \*ORDERS — /);
    assert.match(text, /TODAY — [\s\S]*\*1\. 286-7466 · /, "Jane's order, written a week ago, is today's");
    assert.match(text, /TOMORROW — [\s\S]*🚚 \*Delivery\*[\s\S]*555-0102[\s\S]*🛍 \*Collection\*[\s\S]*555-0103/);
    assert.ok([a, b, c].every((o) => text.includes(ref(o))));
    assert.equal(modelCalls, calls, "no model call");
    assert.equal(await customerBound(), 0);
    assert.equal(await notToAGroup(), 0);
  });

  test("!orders today / tomorrow / <date> / overdue / missing / undated each answer, and an old order is overdue, not today", async () => {
    const old = await datedOrder(JANE, "Monday");
    await pg.run(`update public.ai_agent_orders set requested_for = 'Mon 26 Oct (Monday)', first_message_at = '2026-10-26T14:00:00Z' where id = ${lit(old.id)};`);
    const dateless = await makeOrder(MARCUS, ORDER_TEXT);
    await pg.run(`update public.ai_agent_orders set first_message_at = '2026-10-20T14:00:00Z', requested_for = 'Wed 21 Oct (default)' where id = ${lit(dateless.id)};`);
    const hollow = await makeOrder(PRIYA, "some Monello please", draft({ items: [{ product: "Monello", quantity: null }], delivery_address: null, delivery_preference: null }));
    const overdue = await nextReport("!orders overdue");
    assert.match(overdue, /OVERDUE ORDERS/);
    assert.match(overdue, new RegExp(`WAS DUE — Mon 26 Oct[\\s\\S]*${ref(old)}`));
    // Written on 20 Oct at 10:00 with no day: the business default (before 9 AM today, else tomorrow) made it due on the 21st.
    assert.match(overdue, new RegExp(`WAS DUE — Wed 21 Oct[\\s\\S]*${ref(dateless)}`));
    assert.match(await nextReport("!orders today"), /✅ Nothing outstanding for today\./, "old orders are not carried into today");
    const missing = await nextReport("!orders missing");
    assert.match(missing, new RegExp(`${ref(hollow)}[\\s\\S]*Missing: quantity, delivery address`));
    assert.doesNotMatch(missing, new RegExp(ref(old)), "a complete, dated order is not 'missing'");
    assert.match(await nextReport("!orders undated"), /✅ Every outstanding order has a clear day\./, "a defaulted day is a day");
    assert.match(await nextReport("!orders 30 Oct"), /✅ Nothing outstanding for Fri 30 Oct\./);
    // Nothing was completed, cancelled or deleted by any of that.
    assert.deepEqual((await allOrders()).map((o) => o.status).sort(), ["awaiting_confirmation", "awaiting_confirmation", "possible"]);
    assert.match(await nextReport("!orders banana"), /!orders shows what is outstanding/);
  });

  test("!orders is for authorized staff in the orders group only; strangers, other groups and switched-off businesses get nothing", async () => {
    await datedOrder(JANE, "tomorrow");
    const stranger = await groupSays("!orders", { sender: STRANGER });
    assert.match(reply(stranger), /Only authorized staff/);
    assert.doesNotMatch(reply(stranger), /Monello|286-7466/);
    assert.match(reply(await groupSays("!orders", { sender: null })), /Only authorized staff/);
    const elsewhere = await groupSays("!orders", { group: OTHER_GROUP });
    assert.equal(elsewhere.status, "ignored");
    assert.deepEqual(elsewhere.outbox, []);
    assert.equal(await count(`select 1 from public.ai_agent_outbox where to_jid = ${lit(OTHER_GROUP)}`), 0);
    await configure({ orders_summary_enabled: false });
    assert.match(reply(await groupSays("!orders")), /not switched on/);
    // With a separate Orders group configured, only that group answers.
    await configure({ orders_group_jid: ORDERS_GROUP });
    assert.match(reply(await groupSays("!orders")), /Order commands are used in the Orders group/);
    const inOrders = await groupSays("!orders tomorrow", { group: ORDERS_GROUP });
    assert.equal(inOrders.outbox[0].to, ORDERS_GROUP);
    assert.match(reply(inOrders), /Monello/);
  });

  test("a redelivered !orders message answers once; two businesses never see each other's orders", async () => {
    await datedOrder(JANE, "tomorrow");
    const first = await groupSays("!orders tomorrow", { id: "VIEW-1" });
    assert.equal(first.outbox.length, 1);
    const again = await groupSays("!orders tomorrow", { id: "VIEW-1" });
    assert.equal(again.status, "duplicate");
    assert.equal(await count(`select 1 from public.ai_agent_outbox where dedupe_key like 'ordersview:%'`), 1);
    const sea = await groupSays("!orders all", { group: SEA_GROUP, biz: "by_sea" });
    assert.match(reply(sea), /✅ No outstanding orders\./);
    assert.doesNotMatch(reply(sea), /Monello|286-7466/);
    const crossed = await groupSays("!orders", { group: SEA_GROUP, biz: "dog_food" });
    assert.equal(crossed.status, "ignored");
  });

  test("completing and reopening move an order out of and back into !orders, keep its history, and message nobody", async () => {
    const o = await datedOrder(JANE, "tomorrow");
    assert.match(await nextReport("!orders tomorrow"), new RegExp(ref(o)));
    const done = await groupSays(`!order ${ref(o)} completed`, { id: "DONE-1" });
    assert.match(reply(done), /completed\. It no longer shows in !orders\./);
    assert.doesNotMatch(await nextReport("!orders tomorrow"), new RegExp(ref(o)));
    assert.doesNotMatch(await nextReport("!orders overdue"), new RegExp(ref(o)));
    assert.equal((await allOrders())[0].status, "fulfilled");
    // A retry of the same message changes and sends nothing more.
    const retried = await groupSays(`!order ${ref(o)} completed`, { id: "DONE-1" });
    assert.equal(retried.status, "duplicate");
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_fulfil").length, 1);
    const reopened = await groupSays(`!order ${ref(o)} reopen`);
    assert.match(reply(reopened), /reopened \(.*\)\. It shows in !orders again\./);
    assert.match(await nextReport("!orders tomorrow"), new RegExp(ref(o)));
    assert.deepEqual((await orderEvents(o.id)).map((e) => e.kind).filter((k) => k.startsWith("staff_whatsapp")), ["staff_whatsapp_fulfil", "staff_whatsapp_reopen"]);
    assert.equal(await customerBound(), 0);
    assert.equal(await notToAGroup(), 0);
  });

  test("the website can complete and reopen too: same rules, same history, and a stranger's business is untouched", async () => {
    const o = await datedOrder(JANE, "tomorrow");
    const done = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "fulfil", expectedVersion: o.version });
    assert.ok(done.ok);
    const again = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "fulfil" });
    assert.equal(again.ok, false, "already completed");
    const wrongBusiness = await orders.updateOrderManually({ businessSlug: "by_sea", orderId: o.id, adminId: "admin-1", action: "reopen" });
    assert.equal(wrongBusiness.ok, false);
    assert.equal((await allOrders())[0].status, "fulfilled");
    const [cur] = await allOrders();
    const reopened = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "reopen", expectedVersion: cur.version - 1 });
    assert.equal(reopened.ok, false, "a stale page cannot reopen");
    const ok = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "admin-1", action: "reopen", expectedVersion: cur.version });
    assert.ok(ok.ok);
    assert.equal((await allOrders())[0].status, "awaiting_confirmation");
    assert.deepEqual((await orderEvents(o.id)).map((e) => e.kind).filter((k) => k.startsWith("manual")), ["manual_fulfil", "manual_reopen"]);
    assert.equal(await auditCount("order.reopen"), 1);
  });

  test("an order-date correction is recorded (who, when, before → after), moves the order between days, and the reply says if no day was read", async () => {
    const o = await datedOrder(JANE, "tomorrow");
    const before = (await allOrders())[0].requested_for;
    const moved = await groupSays(`!order ${ref(o)} delivery 30 Oct`);
    assert.match(reply(moved), /delivery date → Fri 30 Oct \(30 Oct\)\./);
    assert.doesNotMatch(reply(moved), /not a date I can read/);
    const [after] = await allOrders();
    assert.equal(after.requested_for, "Fri 30 Oct (30 Oct)");
    assert.ok(after.manual_locked_fields.includes("requested_for"), "the AI will not overwrite it");
    const last = (await orderEvents(o.id)).at(-1)!;
    assert.deepEqual([last.kind, last.actor_kind, last.actor_id], ["staff_whatsapp_edit", "staff", "17585550001"]);
    assert.deepEqual(last.changes.requested_for, { before, after: "Fri 30 Oct (30 Oct)" });
    assert.match(await nextReport("!orders 30 Oct"), new RegExp(ref(o)));
    assert.doesNotMatch(await nextReport("!orders tomorrow"), new RegExp(ref(o)));
    // "Whenever" names no day: recorded, and the reply names the day the order is now for (without "default" wording).
    const loose = await groupSays(`!order ${ref(o)} delivery whenever you can`);
    assert.match(reply(loose), /No specific day in that, so the order is for \w{3} \d{1,2} \w{3}/);
    assert.doesNotMatch(reply(loose), /default/);
    // Words that are not a day are recorded too, but the order is then honestly "day unclear".
    const vague = await groupSays(`!order ${ref(o)} delivery sometime next week`);
    assert.match(reply(vague), /not a date I can read, so the order's day is unclear/);
    assert.match(await nextReport("!orders undated"), new RegExp(ref(o)));
    assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_edit").length, 3, "every correction stays in the history");
  });

  test("a customer who later gives a different day does not overwrite the staff correction; the disagreement is flagged", async () => {
    const o = await datedOrder(JANE, "tomorrow");
    await groupSays(`!order ${ref(o)} delivery 30 Oct`);
    modelOrders(draft({ requested_for: "Saturday" }), { order_target: o.ref_code });
    await customerSays(JANE, "actually can you do Saturday instead", { at: MONDAY });
    const [after] = await allOrders();
    assert.equal(after.requested_for, "Fri 30 Oct (30 Oct)");
    assert.equal(after.field_conflicts.requested_for.proposed, "Sat 31 Oct (Saturday)");
    assert.match(await nextReport("!orders 30 Oct"), new RegExp(`${ref(o)}[\\s\\S]*Customer asked for a change`));
  });

  // ── The report ─────────────────────────────────────────────────────────────

  test("the report is compact: name, reference, phone, items, delivery, one warning", async () => {
    const jane = await makeOrder(JANE, ORDER_TEXT);
    await pg.run(`update public.ai_agent_orders set customer_name = 'Jane Doe' where id = ${lit(jane.id)};`);
    await makeOrder(MARCUS, "2 bags of Monello, deliver please", draft({ items: [{ product: "Monello", quantity: "2" }], delivery_address: null }));
    const res = await groupSays("!orders all");
    assert.equal(res.outbox.length, 1);
    const text = res.outbox[0].body;
    // No day was given in either: the business default applies and is marked; "Missing" lists only real gaps.
    assert.match(text, /^📋 \*ALL OUTSTANDING ORDERS\*\n\n📅 \*[A-Z ]*— ?\w{3} \d+ \w{3}\* \(2\)\n\n🚚 \*Delivery\*\n\n\*1\. Jane Doe · #[A-Z2-9]{5}\* 🕓 to confirm\n1 × Monello Chicken 25kg\n📍 Cap Estate · 📞 286-7466\n\n\*2\. 555-0102 · #[A-Z2-9]{5}\* ❔ incomplete\n2 × Monello\n📍 address needed\n⚠️ Missing: delivery address\n/);
    assert.doesNotMatch(text, /Missing: [^\n]*(day|delivery or collection)/);
    assert.equal(await customerBound(), 0);
  });

  test("a large report goes out as numbered messages in order, to the group, never to a customer", async () => {
    for (let i = 0; i < 45; i += 1) {
      await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_address, notes, missing_fields, first_message_at, last_message_at)
        values (${lit(refOf("ZZ2", i))}, 'dog_food', ${lit(`1758555${String(1000 + i)}@s.whatsapp.net`)}, ${lit(`1758555${String(1000 + i)}`)}, ${lit(`Customer ${i}`)}, 'awaiting_confirmation',
          '[{"product":"Monello","quantity":"2","variant":null,"size":"25kg"}]'::jsonb, 'delivery', '12 Main Street, Gros Islet, Saint Lucia', ${lit("n".repeat(100))}, '{}', now(), now());`);
    }
    const res = await groupSays("!orders all");
    assert.ok(res.outbox.length >= 2, `split into ${res.outbox.length}`);
    res.outbox.forEach((item, i) => {
      assert.equal(item.to, GROUP);
      assert.equal(item.send, true);
      assert.ok(item.body.length <= 3800);
      assert.match(item.body, new RegExp(`^📋 \\*ALL OUTSTANDING ORDERS\\* \\(${i + 1}/${res.outbox.length}\\)`));
    });
    const refs = res.outbox.flatMap((item) => item.body.match(/#ZZ2\w{2}/g) ?? []);
    assert.equal(new Set(refs).size, 45, "each order appears once, across the messages");
    // Stored in the outbox in sending order, each with its own key.
    const stored = await rows(`select dedupe_key, to_jid from public.ai_agent_outbox where dedupe_key like 'ordersview:%' order by created_at, id`);
    assert.equal(stored.length, res.outbox.length);
    assert.ok(stored.every((r) => r.to_jid === GROUP));
    assert.equal(new Set(stored.map((r) => r.dedupe_key)).size, stored.length);
    assert.equal(await customerBound(), 0);
  });

  test("the scheduled 8 AM report is split the same way and still posts once", async () => {
    for (let i = 0; i < 40; i += 1) {
      await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_address, requested_for, notes, missing_fields, first_message_at, last_message_at)
        values (${lit(refOf("YY2", i))}, 'dog_food', ${lit(`1758555${String(2000 + i)}@s.whatsapp.net`)}, ${lit(`1758555${String(2000 + i)}`)}, ${lit(`Customer ${i}`)}, 'awaiting_confirmation',
          '[{"product":"Monello","quantity":"2","variant":null,"size":"25kg"}]'::jsonb, 'delivery', '12 Main Street, Gros Islet, Saint Lucia', 'Tue 27 Oct (today)', ${lit("n".repeat(100))}, '{}', now(), now());`);
    }
    const settings = await settingsOf();
    const eight = new Date("2026-10-27T12:00:00Z");
    assert.equal(await orders.runScheduledSummary(settings, eight), "sent");
    assert.equal(await orders.runScheduledSummary(settings, eight), "already_done");
    const stored = await rows(`select dedupe_key, body, status from public.ai_agent_outbox where dedupe_key like 'ordersummary:dog_food:%' order by created_at, id`);
    assert.ok(stored.length >= 2);
    assert.equal(stored[0].dedupe_key, "ordersummary:dog_food:2026-10-27:1");
    assert.match(stored[1].dedupe_key, /:1:p2$/);
    assert.ok(stored.every((r) => r.status === "pending"));
    const [run] = await rows(`select outbox_id from public.ai_agent_order_summary_runs`);
    const [first] = await rows(`select id from public.ai_agent_outbox where dedupe_key = 'ordersummary:dog_food:2026-10-27:1'`);
    assert.equal(run.outbox_id, first.id, "the run tracks delivery through its first part");
  });

  // ── Names ──────────────────────────────────────────────────────────────────

  test("the report names customers: staff-entered, then saved contact, then WhatsApp profile name, then the phone", async () => {
    const jane = await makeOrder(JANE, ORDER_TEXT);
    const marcus = await makeOrder(MARCUS, ORDER_TEXT);
    const priya = await makeOrder(PRIYA, ORDER_TEXT);
    const insertMsg = (c: Customer, profile: string | null, saved: string | null) =>
      pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, contact_name, business_contact_name, direction, message_body, whatsapp_message_id, timestamp)
              values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${profile ? lit(profile) : "null"}, ${saved ? lit(saved) : "null"}, 'inbound', 'hi', ${lit(`M-${++seq}`)}, now());`);
    // Jane: the bridge saw a profile name and a saved contact name; staff also typed a name on her profile.
    await insertMsg(JANE, "jj 🐶", "Jane (saved contact)");
    await pg.run(`insert into public.customers (phone_number, first_name, last_name, whatsapp_name, business_contact_name) values (${lit(JANE.phone)}, 'Jane', 'Staffname', 'jj 🐶', 'Jane (saved contact)');`);
    // Marcus: a saved contact name and a profile name, no staff name.
    await insertMsg(MARCUS, "Marc the Dog Guy", "Marcus Saved");
    // Priya: only a profile name, and it is malformed (a phone number).
    await insertMsg(PRIYA, "+1 758 555 0103", null);

    const names = await orders.loadOrderNames("dog_food", (await allOrders()) as never);
    assert.deepEqual([names[jane.id]?.name, names[jane.id]?.source], ["Jane Staffname", "staff"]);
    assert.deepEqual([names[marcus.id]?.name, names[marcus.id]?.source], ["Marcus Saved", "saved"]);
    assert.deepEqual([names[priya.id]?.name, names[priya.id]?.source], [null, null], "a phone number posing as a name is not a name");

    const text = (await groupSays("!orders all")).outbox[0].body;
    assert.match(text, /\*\d\. Jane Staffname · #/);
    assert.match(text, /\*\d\. Marcus Saved · #/);
    assert.match(text, /\*\d\. 555-0103 · #/);
    assert.doesNotMatch(text, /jj|Marc the Dog Guy|\+1 758 555 0103/);

    // Remove the saved names: the profile name is what is left; staff's locked order name beats everything.
    await pg.run(`update public.whatsapp_messages set business_contact_name = null; delete from public.customers;`);
    await pg.run(`update public.ai_agent_orders set customer_name = 'Chosen By Staff', manual_locked_fields = array['customer_name'] where id = ${lit(jane.id)};`);
    const again = await orders.loadOrderNames("dog_food", (await allOrders()) as never);
    assert.deepEqual([again[jane.id]?.name, again[jane.id]?.source], ["Chosen By Staff", "staff"]);
    assert.deepEqual([again[marcus.id]?.name, again[marcus.id]?.source], ["Marc the Dog Guy", "profile"]);
  });

  test("a name from another business's messages is never used", async () => {
    const jane = await makeOrder(JANE, ORDER_TEXT);
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, contact_name, business_contact_name, direction, message_body, whatsapp_message_id)
                  values ('by_sea', ${lit(JANE.chat)}, ${lit(JANE.phone)}, 'Sea Moss Jane', 'Sea Contact', 'inbound', 'hi', 'SEA-1');`);
    const names = await orders.loadOrderNames("dog_food", (await allOrders()) as never);
    assert.equal(names[jane.id]?.name, null);
  });

  // ── Natural language, end to end ───────────────────────────────────────────

  test("'A bag of Monello, bring it to Cap' records quantity 1 and delivery even when the model left both out", async () => {
    modelOrders(draft({ items: [{ product: "Monello", quantity: null }], delivery_address: "Cap", delivery_preference: null }));
    await customerSays(JANE, "A bag of Monello, bring it to Cap", { at: MONDAY });
    const [o] = await allOrders();
    assert.equal(o.items[0].quantity, "1");
    assert.equal(o.fulfilment_method, "delivery");
    assert.equal(o.delivery_address, "Cap");
    assert.deepEqual(o.missing_fields, [], "delivery and the day are stored as defaults, so nothing is asked again");
    assert.equal(o.status, "awaiting_confirmation");
  });

  test("'Deliver tomorrow' counts from the message's own time, not from the time it is processed", async () => {
    modelOrders(draft({ items: [{ product: "Monello", quantity: "2" }], requested_for: "tomorrow" }));
    await customerSays(JANE, "2 bags of Monello, deliver tomorrow to Cap Estate", { at: MONDAY });
    const [o] = await allOrders();
    assert.equal(o.requested_for, "Tue 27 Oct (tomorrow)");
    // The model repeats "tomorrow" in a later turn's cumulative draft (days later): the date does not move.
    modelOrders(draft({ items: [{ product: "Monello", quantity: "2" }], requested_for: "tomorrow", notes: "gate code 12" }), { order_target: o.ref_code });
    await customerSays(JANE, "gate code is 12, tomorrow is fine", { at: "2026-10-28T14:00:00.000Z" });
    assert.equal((await allOrders())[0].requested_for, "Tue 27 Oct (tomorrow)");
    assert.equal((await allOrders())[0].notes, "gate code 12");
  });

  test("'I'll collect' is collection and replaces an earlier delivery", async () => {
    const o = await makeOrder(JANE, "2 bags of Monello Chicken, bring it to Cap Estate", draft({ items: [{ product: "Monello Chicken", quantity: "2" }] }));
    assert.equal(o.fulfilment_method, "delivery");
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2" }], delivery_preference: null, delivery_address: null }), { order_target: o.ref_code });
    await customerSays(JANE, "actually I'll collect");
    assert.equal((await allOrders())[0].fulfilment_method, "collection");
  });

  test("'Just the Monello bags' keeps Monello and records what was removed; an unexplained omission is restored", async () => {
    const o = await makeOrder(JANE, "2 bags of Monello Chicken and 1 Dog Treats, bring it to Cap Estate", draft({ items: [{ product: "Monello Chicken", quantity: "2" }, { product: "Dog Treats", quantity: "1" }] }));
    // The model drops the treats although the customer only changed the day: they come back.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2" }], requested_for: "Friday" }), { order_target: o.ref_code });
    const restored = await customerSays(JANE, "Friday works for the Monello Chicken");
    assert.deepEqual((await allOrders())[0].items.map((i: any) => i.product), ["Monello Chicken", "Dog Treats"]);
    assert.ok(restored.reasons.includes("order_item_removal_unconfirmed"));
    // Now the customer really withdraws them.
    modelOrders(draft({ items: [{ product: "Monello Chicken", quantity: "2" }] }), { order_target: o.ref_code });
    await customerSays(JANE, "Just the Monello bags please");
    const [after] = await allOrders();
    assert.deepEqual(after.items.map((i: any) => i.product), ["Monello Chicken"]);
    const last = (await orderEvents(o.id)).at(-1)!;
    assert.deepEqual(last.changes.removed_items, { before: ["Dog Treats"], after: null });
  });

  test("an enquiry is not an order, and a cancelled order is not reported", async () => {
    script = () => proposal({ decision: "ESCALATE", intent: "question", order_request: draft() });
    await customerSays(JANE, "How much for a bag of Monello Chicken?");
    assert.equal((await allOrders()).length, 0);
    const o = await makeOrder(MARCUS, ORDER_TEXT);
    await groupSays(`!order ${ref(o)} cancelled`);
    const text = (await groupSays("!orders all")).outbox[0].body;
    assert.match(text, /No outstanding orders\./);
    assert.doesNotMatch(text, /Monello/);
  });

  // ── Nothing reaches a customer ─────────────────────────────────────────────

  test("a full session of commands never produces a customer-bound message or any non-group recipient", async () => {
    const a = await makeOrder(JANE, ORDER_TEXT);
    const b = await makeOrder(MARCUS, ORDER_TEXT);
    for (const text of ["!update", `!order ${ref(a)} confirmed`, `!order ${ref(b)} 4 bags`, `!order ${ref(b)} delivery tomorrow`, `!order ${ref(b)} cancelled`, "!order 555", `!moreinfo ${ref(a)}`, "!order jane confirmed", "!order #NOPE2 cancelled"]) {
      await groupSays(text);
    }
    await groupSays(`!order ${ref(a)} cancelled`, { sender: STRANGER });
    assert.equal(await customerBound(), 0);
    assert.equal(await notToAGroup(), 0);
    assert.equal(await count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay','staff_draft')`), 0);
  });
});
