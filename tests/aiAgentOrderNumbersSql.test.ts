// Simple order numbers ("!order 2 completed") end to end: the app's REAL server code against the REAL migrations in a
// throwaway Postgres. A number means the order the posted report showed at that position (a stored snapshot), never a fresh,
// re-sorted list. Only the language model is replaced by a scripted stand-in. Skips itself when no Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

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
let corrections: unknown;
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

describe("order numbers (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
      truncate public.ai_agent_orders, public.ai_agent_order_lists, public.ai_agent_order_proposals, public.ai_agent_order_feedback, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_customer_staff_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
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

  /** A customer order for the real day `day` ("today" / "tomorrow"), recorded now as the AI path would. */
  async function dayOrder(c: Customer, day: "today" | "tomorrow", over: Partial<Draft> = {}) {
    return makeOrder(c, `a bag of Monello Chicken 25kg, bring it to Cap Estate ${day}`, draft({ requested_for: day, ...over }), new Date().toISOString());
  }
  const statusOf = async (o: Record<string, any>) => (await rows<{ status: string }>(`select status from public.ai_agent_orders where id = ${lit(o.id)}`))[0].status;
  const versionOf = async (o: Record<string, any>) => (await rows<{ version: number }>(`select version from public.ai_agent_orders where id = ${lit(o.id)}`))[0].version;
  /** The order reference shown as number `n` in a report text. */
  const shownAs = (text: string, n: number) => text.match(new RegExp(`\\*${n}\\. .*? · (#[A-Z0-9]{5})\\*`))?.[1] ?? null;
  const report = async (cmd = "!orders all", opts: Parameters<typeof groupSays>[1] = {}) => {
    await pg.run("truncate public.ai_agent_order_summary_runs; truncate public.ai_agent_order_update_posts;");
    return groupSays(cmd, opts);
  };
  /** The report's WhatsApp message id, as the bridge's ack would record it, so a reply can quote it. */
  const sentAs = async (res: { outbox: { id: string }[] }, waId: string) => {
    await pg.run(`update public.ai_agent_outbox set whatsapp_message_id = ${lit(waId)}, status = 'sent' where id = ${lit(res.outbox[0].id)};`);
    return waId;
  };

  test("a number completes the order the report showed, even after the list would be re-sorted", async () => {
    const a = await dayOrder(JANE, "today");
    const b = await dayOrder(MARCUS, "tomorrow");
    const first = await report();
    const text = reply(first);
    assert.equal(shownAs(text, 1), ref(a));
    assert.equal(shownAs(text, 2), ref(b));
    // An overdue order appears AFTER the report: a fresh "!orders all" would list it first and renumber everything.
    const late = await dayOrder(PRIYA, "today");
    await pg.run(`update public.ai_agent_orders set requested_for = 'Mon 26 Oct (test)', first_message_at = now() - interval '3 days' where id = ${lit(late.id)};`);
    assert.equal(shownAs(reply(await report("!orders all", { id: "PEEK-1" })), 1), ref(late), "a fresh list would put the overdue order first");
    // ...but "!order 2" still means what the FIRST report showed as 2 only if that is the newest list. The fresh list is newer, so
    // the first report is quoted to keep its numbering.
    const firstId = await sentAs(first, "WA-REPORT-1");
    const done = await groupSays("!order 2 completed", { quoted: firstId });
    assert.match(reply(done), new RegExp(`${ref(b)}.*completed`));
    assert.equal(await statusOf(b), "fulfilled");
    assert.equal(await statusOf(a), "awaiting_confirmation");
    assert.equal(await statusOf(late), "awaiting_confirmation");
    assert.equal(await auditCount("orders.number_resolved"), 1);
    assert.equal(await customerBound(), 0);
  });

  test("the newest report is what a bare number reads; completing by number is the same change as by reference", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    const res = await groupSays("!order 1 completed");
    assert.match(reply(res), new RegExp(`✔️ ${ref(a)} .*: completed\\. It no longer shows in !orders\\.`));
    assert.equal(await statusOf(a), "fulfilled");
    const last = (await orderEvents(a.id)).at(-1)!;
    assert.deepEqual([last.kind, last.actor_kind, last.actor_id], ["staff_whatsapp_fulfil", "staff", "17585550001"]);
    // The completion changed the order, so the old list no longer describes it: the number is refused, the reference still works.
    assert.match(reply(await groupSays("!order 1 reopen")), /changed after that list was posted/);
    assert.equal(await statusOf(a), "fulfilled");
    assert.match(reply(await groupSays(`!order ${ref(a)} reopen`)), /reopened/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
  });

  test("cancel, confirm, quantity and delivery all work by number", async () => {
    const a = await dayOrder(JANE, "today");
    const b = await dayOrder(MARCUS, "tomorrow");
    await report("!orders all");
    assert.equal(shownAs(reply(await groupSays("!order 2", { id: "INFO-2" })), 1) ?? "ok", "ok");
    assert.match(reply(await groupSays("!order 1 confirmed")), new RegExp(`${ref(a)}.*confirmed`));
    assert.match(reply(await groupSays("!order 2 cancelled")), new RegExp(`${ref(b)}.*cancelled`));
    assert.equal(await statusOf(a), "confirmed");
    assert.equal(await statusOf(b), "cancelled");
  });

  test("a changed order is refused: the list is stale for it, and nothing is changed", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    // Staff (or the customer) change the order after the report.
    await groupSays(`!order ${ref(a)} 3 bags`);
    const refused = await groupSays("!order 1 completed");
    assert.match(reply(refused), new RegExp(`${ref(a)} changed after that list was posted`));
    assert.equal(await statusOf(a), "awaiting_confirmation");
    assert.equal(await auditCount("orders.command_rejected") >= 1, true);
    // The reference form still works, and a new report gives fresh numbers.
    await report("!orders today");
    assert.match(reply(await groupSays("!order 1 completed")), /completed/);
    assert.equal(await statusOf(a), "fulfilled");
  });

  test("a change made between the check and the write cannot apply to a changed order (version-checked)", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    const v = await versionOf(a);
    await pg.run(`update public.ai_agent_orders set version = version + 1 where id = ${lit(a.id)};`);
    const refused = await groupSays("!order 1 cancelled");
    assert.match(reply(refused), /changed after that list was posted/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
    assert.equal(await versionOf(a), v + 1);
  });

  test("an expired report is refused and says so; a fresh one works again", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    await pg.run(`update public.ai_agent_order_lists set created_at = now() - interval '7 hours';`);
    const refused = await groupSays("!order 1 completed");
    assert.match(reply(refused), /expired.*Send !orders again/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
    await report("!orders today");
    assert.match(reply(await groupSays("!order 1 completed")), /completed/);
  });

  test("no report yet, or a number the report does not have, changes nothing", async () => {
    const a = await dayOrder(JANE, "today");
    assert.match(reply(await groupSays("!order 1 completed")), /no order list to read that number from/);
    await report("!orders today");
    assert.match(reply(await groupSays("!order 5 completed")), /There is no number 5 in that list \(it has 1–1\)/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
  });

  test("two report types that disagree: refused with the choices; quoting the report decides", async () => {
    const a = await dayOrder(JANE, "today");
    const b = await dayOrder(MARCUS, "tomorrow");
    const all = await report("!orders all");
    const tomorrow = await report("!orders tomorrow");
    assert.equal(shownAs(reply(tomorrow), 1), ref(b));
    assert.equal(shownAs(reply(all), 1), ref(a));
    const ambiguous = await groupSays("!order 1 completed");
    assert.match(reply(ambiguous), /Number 1 means different orders in your recent lists — nothing changed/);
    assert.match(reply(ambiguous), new RegExp(`!orders all: ${ref(a)}`));
    assert.match(reply(ambiguous), new RegExp(`!orders tomorrow: ${ref(b)}`));
    assert.equal(await statusOf(a), "awaiting_confirmation");
    assert.equal(await statusOf(b), "awaiting_confirmation");
    // Replying to a report names it.
    const quotedId = await sentAs(all, "WA-ALL-1");
    assert.match(reply(await groupSays("!order 1 completed", { quoted: quotedId })), new RegExp(`${ref(a)}.*completed`));
    assert.equal(await statusOf(a), "fulfilled");
    assert.equal(await statusOf(b), "awaiting_confirmation");
  });

  test("a report split into several messages is one list: quoting any part names it", async () => {
    const orders: Record<string, any>[] = [];
    for (let i = 0; i < 30; i += 1) {
      const c = { chat: `1758555${String(2000 + i)}@s.whatsapp.net`, phone: `1758555${String(2000 + i)}` };
      orders.push(await makeOrder(c, `${i + 1} bags of Monello Chicken to Cap Estate today`, draft({ requested_for: "today", delivery_address: "Plot 12, Bois d'Orange Road, Gros Islet, near the old jetty by the blue church" }), new Date().toISOString()));
    }
    const res = await report("!orders today");
    assert.ok(res.outbox.length >= 2, `expected a multi-part report, got ${res.outbox.length}: ${reply(res).length} chars, ${reply(res).slice(0, 300)}`);
    const lastPart = res.outbox.at(-1)!;
    await pg.run(`update public.ai_agent_outbox set whatsapp_message_id = 'WA-PART-LAST' where id = ${lit(lastPart.id)};`);
    const text = reply(res);
    const shown = shownAs(text, 30);
    assert.ok(shown, "number 30 is in the report");
    const done = await groupSays("!order 30 completed", { quoted: "WA-PART-LAST" });
    assert.match(reply(done), new RegExp(`${shown}.*completed`));
  });

  test("a quote that is not a report cannot name a list", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    const refused = await groupSays("!order 1 completed", { quoted: "SOME-CUSTOMER-MESSAGE" });
    assert.match(reply(refused), /not an order list/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
  });

  test("the morning summary is numbered too", async () => {
    const a = await dayOrder(JANE, "today");
    const settings = await settingsOf();
    const sent = await orders.sendSummaryNow(settings, "admin-1", "admin");
    assert.equal(sent.ok, true);
    const [row] = await rows<{ body: string }>(`select body from public.ai_agent_outbox where dedupe_key like 'ordersummary:manual:%' order by created_at limit 1`);
    assert.equal(shownAs(row.body, 1), ref(a));
    assert.match(reply(await groupSays("!order 1 completed")), /completed/);
    assert.equal(await statusOf(a), "fulfilled");
  });

  test("an unauthorized sender cannot use numbers, and learns nothing about the list", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    const res = await groupSays("!order 1 completed", { sender: STRANGER });
    assert.match(reply(res), /Only authorized staff can use order commands/);
    assert.doesNotMatch(reply(res), new RegExp(ref(a)));
    assert.equal(await statusOf(a), "awaiting_confirmation");
    const noSender = await groupSays("!order 1 completed", { sender: null });
    assert.match(reply(noSender), /Only authorized staff/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
  });

  test("numbers belong to one group and one business", async () => {
    await configure({ orders_group_jid: ORDERS_GROUP });
    const a = await dayOrder(JANE, "today");
    await report("!orders today", { group: ORDERS_GROUP });
    // The staff group is not where order commands are honoured now, and never saw that report.
    assert.match(reply(await groupSays("!order 1 completed")), /Order commands are used in the Orders group/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
    // The other business has its own groups and lists.
    const sea = await groupSays("!order 1 completed", { biz: "by_sea", group: SEA_GROUP });
    assert.match(reply(sea), /no order list to read that number from/);
    // A group nobody configured gets nothing at all.
    const stranger = await groupSays("!order 1 completed", { group: OTHER_GROUP });
    assert.equal(stranger.outbox.length, 0);
    assert.equal(await statusOf(a), "awaiting_confirmation");
    // The group that has the list can use it.
    assert.match(reply(await groupSays("!order 1 completed", { group: ORDERS_GROUP })), /completed/);
    assert.equal(await statusOf(a), "fulfilled");
  });

  test("one business's list can never resolve to another business's order", async () => {
    const a = await dayOrder(JANE, "today");
    await report("!orders today");
    // Same group id configured for the other business (a mistake or an attack): its commands read ITS lists only.
    await configure({}, "by_sea", GROUP);
    const res = await groupSays("!order 1 completed", { biz: "by_sea", group: GROUP });
    assert.match(reply(res), /no order list to read that number from/);
    assert.equal(await statusOf(a), "awaiting_confirmation");
  });

  test("!order N shows the details of that order; !order N teach previews a correction for that order only", async () => {
    const a = await dayOrder(JANE, "today");
    const b = await dayOrder(MARCUS, "tomorrow");
    await report("!orders all");
    const info = reply(await groupSays("!order 2"));
    assert.match(info, new RegExp(ref(b)));
    assert.doesNotMatch(info, new RegExp(ref(a)));
    model.setOrderCorrectionProposerForTests(async () => ({ text: JSON.stringify({ delivery_address: "Cap Estate North" }), model: "scripted", error: null }));
    try {
      const preview = reply(await groupSays("!order 2 teach Change the address to Cap Estate North"));
      assert.match(preview, new RegExp(ref(b)));
      assert.match(preview, /Cap Estate North/);
      assert.match(preview, /Nothing has changed yet/);
      const [proposal] = await rows<{ order_id: string; status: string }>("select order_id, status from public.ai_agent_order_proposals");
      assert.equal(proposal.order_id, b.id);
      assert.equal(proposal.status, "pending");
      assert.equal((await allOrders()).find((o) => o.id === b.id)!.delivery_address, "Cap Estate");
    } finally {
      model.setOrderCorrectionProposerForTests(null);
    }
  });

  test("#REF commands work exactly as before, with or without a list", async () => {
    const a = await dayOrder(JANE, "today");
    assert.match(reply(await groupSays(`!order ${ref(a)} completed`)), /completed/);
    assert.equal(await statusOf(a), "fulfilled");
    assert.equal(await auditCount("orders.number_resolved"), 0);
  });
});
