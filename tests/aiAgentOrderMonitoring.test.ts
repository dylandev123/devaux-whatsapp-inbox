// Order monitoring of ALL customer conversations (independent of AI reply permission), outgoing staff messages, the
// bridge-gap coverage note, and the opt-in backfill. Pure rules first, then the app's REAL server code
// (processBridgeMessage → monitor → trackOrders → report) against the REAL migrations in a throwaway Postgres
// (tests/helpers/pgHarness.ts). Only the language models are replaced by scripted stand-ins. Skips itself when no
// Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import {
  chunkBy,
  gateAllowsMonitoring,
  historyLine,
  messageWasAnalysed,
  monitorBudgetExceeded,
  monitorEligibleChat,
  monitorPrefilter,
  staffFlagFor,
  validBackfillHours,
} from "../lib/aiAgent/orderMonitor.ts";
import { parseOrderOnlyProposal } from "../lib/aiAgent/engine.ts";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

// ── Pure rules ───────────────────────────────────────────────────────────────

describe("order monitoring: pure rules", () => {
  test("only genuine 1:1 customer chats are eligible: never a group, status broadcast, newsletter or system chat", () => {
    assert.equal(monitorEligibleChat("17585550101@s.whatsapp.net"), true);
    assert.equal(monitorEligibleChat("123456789012345@lid"), true);
    assert.equal(monitorEligibleChat("120363000000000001@g.us"), false);
    assert.equal(monitorEligibleChat("status@broadcast"), false);
    assert.equal(monitorEligibleChat("120363000000000001@newsletter"), false);
  });

  test("monitoring is independent of every reason the AI may not reply; any other refusal is not monitored", () => {
    for (const r of ["contact_not_permitted", "contact_excluded", "human_takeover", "staff_recently_active", "customer_mode_manual_only", "unresolved_lid_identity"]) {
      assert.equal(gateAllowsMonitoring([r]), true, r);
    }
    assert.equal(gateAllowsMonitoring(["contact_not_permitted", "unresolved_lid_identity"]), true);
    for (const r of ["agent_disabled", "group_chat", "system_chat", "outbound_message", "business_mismatch", "invalid_business", "empty_message"]) {
      assert.equal(gateAllowsMonitoring([r]), false, r);
    }
    assert.equal(gateAllowsMonitoring([]), false);
    assert.equal(gateAllowsMonitoring(["human_takeover", "group_chat"]), false);
  });

  test("the free pre-filter: pleasantries and no-signal chatter are skipped, and with an open order any real message is analysed", () => {
    const p = (segments: string[], openOrders = 0, extra: Partial<Parameters<typeof monitorPrefilter>[0]> = {}) => monitorPrefilter({ author: "customer", segments, hasMedia: false, openOrders, ...extra });
    assert.deepEqual(p(["thanks!"]), { action: "skip", reason: "orders_monitor_skipped_acknowledgement" });
    assert.deepEqual(p(["ok", "thank you"], 1), { action: "skip", reason: "orders_monitor_skipped_acknowledgement" });
    assert.equal(p([""], 0, { hasMedia: true }).reason, "orders_monitor_skipped_media_only");
    assert.equal(p(["(media message without text)"], 0, { hasMedia: true }).reason, "orders_monitor_skipped_media_only");
    assert.equal(p(["Are you guys open on Sundays"]).action, "skip");
    assert.equal(p(["I want 2 bags of Monello Chicken"]).action, "analyse");
    assert.equal(p(["Can I get delivery tomorrow"]).action, "analyse");
    // With an open order a follow-up may change it, even without any order wording.
    assert.equal(p(["Actually the blue one"], 1).action, "analyse");
    assert.equal(p(["Are you guys open on Sundays"], 1).action, "analyse");
    // A bare yes / a short cancellation are handled by the rules (no model call), but only with an open order.
    assert.deepEqual(p(["yes please"], 1), { action: "deterministic", reason: "orders_monitor_confirmation" });
    assert.deepEqual(p(["cancel my order"], 1), { action: "deterministic", reason: "orders_monitor_cancellation" });
    assert.equal(p(["yes please"], 0).action, "skip");
    // A longer message that mentions cancelling is read by the model: it may be a partial change.
    assert.equal(p(["please cancel the beef but keep the chicken and add one dog treat"], 1).action, "analyse");
  });

  test("staff messages are read only when an order is open and the wording could matter", () => {
    const s = (text: string, openOrders: number) => monitorPrefilter({ author: "staff", segments: [text], hasMedia: false, openOrders });
    assert.equal(s("Confirmed, we deliver Friday", 0).reason, "orders_monitor_skipped_no_open_order");
    assert.equal(s("Confirmed, we deliver Friday", 1).action, "analyse");
    assert.equal(s("lol see you", 1).reason, "orders_monitor_skipped_no_order_signal");
    assert.equal(s("thanks", 1).reason, "orders_monitor_skipped_acknowledgement");
  });

  test("a staff message can only raise a flag, never replace a flag that says the customer changed or withdrew something", () => {
    assert.equal(staffFlagFor("confirms", null), "staff_confirmed_in_chat");
    assert.equal(staffFlagFor("cancels", "customer_replied_yes"), "staff_cancelled_in_chat");
    assert.equal(staffFlagFor("changes", null), "staff_change_unclear", "the retired generic warning is never raised again");
    assert.equal(staffFlagFor("confirms", "changed_after_confirmation"), null);
    assert.equal(staffFlagFor("confirms", "cancellation_requested"), null);
    assert.equal(staffFlagFor("confirms", "staff_confirmed_in_chat"), null, "nothing new to record");
    assert.equal(staffFlagFor(null, null), null);
  });

  test("the hourly model budget is per chat and per business", () => {
    assert.equal(monitorBudgetExceeded({ chat: 19, business: 10 }), false);
    assert.equal(monitorBudgetExceeded({ chat: 20, business: 10 }), true);
    assert.equal(monitorBudgetExceeded({ chat: 1, business: 300 }), true);
  });

  test("a stored message counts as already analysed unless the agent never saw it, it failed, or the old rules stopped it", () => {
    assert.equal(messageWasAnalysed(undefined), false);
    assert.equal(messageWasAnalysed({ status: "error", reason_codes: [] }), false);
    assert.equal(messageWasAnalysed({ status: "done", reason_codes: ["contact_not_permitted"] }), false);
    assert.equal(messageWasAnalysed({ status: "done", reason_codes: ["contact_not_permitted", "orders_monitor_new_message"] }), true);
    assert.equal(messageWasAnalysed({ status: "done", reason_codes: ["human_takeover", "orders_monitor_skipped_acknowledgement"] }), true);
    assert.equal(messageWasAnalysed({ status: "done", reason_codes: ["verified_answer"] }), true);
  });

  test("backfill helpers: window validation, chunking, and every replayed line names its author", () => {
    assert.equal(validBackfillHours(24), true);
    assert.equal(validBackfillHours(72), true);
    for (const bad of [0, 73, 1.5, "24", null, undefined, -5]) assert.equal(validBackfillHours(bad), false, String(bad));
    assert.deepEqual(chunkBy([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.match(historyLine({ outbound: false, text: "2 bags  please", at: "2026-10-26T10:05:00Z" }), /^\[2026-10-26 10:05\] CUSTOMER: 2 bags please$/);
    assert.match(historyLine({ outbound: true, text: "Confirmed", at: "2026-10-26T10:06:00Z" }), /STAFF: Confirmed$/);
  });

  test("the monitoring model's JSON is parsed strictly and never carries a reply", () => {
    const ok = parseOrderOnlyProposal(
      JSON.stringify({
        intent: "order",
        order_request: { items: [{ product: "Chicken 15kg", quantity: "2", variant: "Large", size: "15kg" }], delivery_address: null, delivery_preference: "delivery", notes: null, requested_for: "Friday" },
        order_target: "new",
        other_orders: [{ target: "O-ABCDE", order_request: { items: [{ product: "Treats", quantity: "1" }] } }],
        staff_action: "confirms",
        reply: "hello customer",
      })
    );
    assert.equal(ok.intent, "order");
    assert.equal(ok.order_request?.items[0].variant, "Large");
    assert.equal(ok.order_target, "new");
    assert.equal(ok.other_orders?.[0].target, "O-ABCDE");
    assert.equal(ok.staff_action, "confirms");
    assert.equal("reply" in ok, false);
    assert.equal(parseOrderOnlyProposal(JSON.stringify({ intent: "weird", staff_action: "deletes" })).staff_action, null);
    assert.throws(() => parseOrderOnlyProposal("not json"));
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const STAFF = "17585550001@s.whatsapp.net";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
const SAM = { chat: "17585550301@s.whatsapp.net", phone: "17585550301", name: "Sam" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let backfill: typeof import("../lib/server/aiAgent/backfill.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type OrderOnly = import("../lib/aiAgent/engine.ts").OrderOnlyProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
type ReplyInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];
type MonitorInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setOrderUpdateProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const replyProposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE", intent: "other", reply: null, confidence: 0.2, knowledge_ids: [], escalation_reason: "needs staff", priority: null, summary: null, order_request: null, memory_facts: [], ...over,
});
const replyCalls: ReplyInput[] = [];
let replyScript: (input: ReplyInput) => Proposal = () => replyProposal();

const monitorCalls: MonitorInput[] = [];
let monitorScript: (input: MonitorInput) => OrderOnly | null = () => ({ intent: "other", order_request: null, staff_action: null });
const monitorModel = (proposal: Partial<OrderOnly> | null) => {
  monitorScript = () => (proposal ? { intent: "order", order_request: null, staff_action: null, ...proposal } : null);
};

const draft = (over: Partial<Draft> = {}): Draft => ({
  items: [{ product: "Monello Chicken", quantity: "2", variant: "Chicken", size: "15kg" }],
  delivery_address: "12 Main St Gros Islet",
  delivery_preference: "delivery",
  notes: null,
  requested_for: "Friday morning",
  ...over,
});

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

async function say(chat: string, text: string, opts: { phone?: string | null; biz?: string; id?: string; fromMe?: boolean; hasMedia?: boolean; senderJid?: string | null } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `MSG-${++seq}`,
    chatId: chat,
    contactNumber: opts.phone === undefined ? chat.replace(/@.*/, "") : opts.phone,
    fromMe: opts.fromMe ?? false,
    text,
    hasMedia: opts.hasMedia ?? false,
    quotedMessageId: null,
    senderJid: opts.senderJid ?? null,
    timestamp: new Date().toISOString(),
  });
}
const customerSays = (c: Customer, text: string, opts: Parameters<typeof say>[2] = {}) => say(c.chat, text, { phone: c.phone, ...opts });
const staffWrites = (c: Customer, text: string, opts: Parameters<typeof say>[2] = {}) => say(c.chat, text, { phone: c.phone, fromMe: true, ...opts });
const store = (c: Customer, direction: "inbound" | "outbound", text: string, id = `STORED-${++seq}`, minutesAgo = 0) =>
  pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
          values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${lit(direction)}, ${lit(text)}, ${lit(id)}, now() - interval '${minutesAgo} minutes');`);

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderEvents = () => rows<Record<string, any>>(`select * from public.ai_agent_order_events order by created_at, id`);
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const anyOutbox = () => count(`select 1 from public.ai_agent_outbox`);
const escalations = () => count(`select 1 from public.ai_agent_escalations`);
const events = (chat?: string) => rows<{ kind: string; status: string; reason_codes: string[] }>(`select kind, status, reason_codes from public.ai_agent_events${chat ? ` where chat_id = ${lit(chat)}` : ""} order by created_at, id`);
const lastReasons = async (chat: string) => (await events(chat)).at(-1)?.reason_codes ?? [];
const D = (iso: string) => new Date(iso);
const reportText = async (biz = "dog_food") => (await orders.buildSummaryNow(await settingsOf(biz), "scheduled", new Date(), { type: "all" })).text;

describe("Order monitoring of every conversation (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    backfill = await import("../lib/server/aiAgent/backfill.ts");
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async (input) => {
      replyCalls.push(input);
      return { proposal: replyScript(input), model: "scripted", error: null };
    });
    model.setOrderUpdateProposerForTests(async (input) => {
      monitorCalls.push(input);
      const proposal = monitorScript(input);
      return proposal ? { proposal, model: "scripted-small", error: null } : { proposal: null, model: "scripted-small", error: "model unavailable" };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    model?.setOrderUpdateProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_order_backfill_runs, public.ai_agent_escalations,
        public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates,
        public.ai_agent_knowledge, public.ai_agent_customer_memory, public.ai_agent_audit_log, public.ai_agent_conversations,
        public.ai_agent_contact_rules, public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages,
        public.ai_agent_pilot_drafts, public.ai_agent_shadow_results, public.whatsapp_messages cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false, auto_takeover_minutes = 0,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    replyCalls.length = 0;
    monitorCalls.length = 0;
    replyScript = () => replyProposal();
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
  });

  // ── Independent of reply permission ───────────────────────────────────────

  const NOT_ALLOWED: [string, () => Promise<void>][] = [
    ["not on the allow-list (Selected contacts, no rule)", () => configure({ contact_scope: "selected" })],
    ["no contacts at all (scope none)", () => configure({ contact_scope: "none" })],
    ["excluded from AI replies", () => pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(JANE.chat)}, 'exclude');`).then(() => undefined)],
    ["set to Manual Only", () => pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, customer_mode) values ('dog_food', ${lit(JANE.chat)}, 'manual_only');`).then(() => undefined)],
    ["staff takeover is active", () => pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, control, human_until) values ('dog_food', ${lit(JANE.chat)}, 'human', now() + interval '2 hours');`).then(() => undefined)],
    ["in Observe mode and not on the allow-list", () => configure({ mode: "observe", contact_scope: "none" })],
  ];
  for (const [label, arrange] of NOT_ALLOWED) {
    test(`an order from a customer who is ${label} is still recorded, and nothing is sent, drafted or posted`, async () => {
      await arrange();
      monitorModel({ order_request: draft(), order_target: "new" });
      const res = await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
      assert.equal(res.status, "done");
      assert.deepEqual(res.outbox, [], "monitoring never hands the bridge anything to send");
      const [o] = await allOrders();
      assert.ok(o, "the order was recorded");
      assert.equal(o.status, "awaiting_confirmation");
      assert.equal(o.items[0].variant, "Chicken");
      assert.equal(o.items[0].size, "15kg");
      assert.equal(replyCalls.length, 0, "the reply model was never called for a customer the AI may not answer");
      assert.equal(monitorCalls.length, 1, "one small monitoring call");
      assert.equal(await anyOutbox(), 0, "no customer reply, no draft, no staff notice");
      assert.equal(await escalations(), 0);
      assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_new_message"));
    });
  }

  test("order monitoring can NEVER grant permission to reply: even with Assisted mode and Auto-Reply nothing is created for a monitored-only chat", async () => {
    await configure({ mode: "assisted", contact_scope: "selected", default_customer_mode: "auto_reply" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal((await allOrders()).length, 1);
    assert.equal(await anyOutbox(), 0);
    assert.equal(replyCalls.length, 0);
    // The source says the same: monitoring has no way to enqueue anything.
    for (const f of ["lib/server/aiAgent/orderMonitor.ts", "lib/server/aiAgent/backfill.ts", "lib/aiAgent/orderMonitor.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      assert.doesNotMatch(src, /\benqueue\s*\(|customer_reply|holding_reply|staff_relay|kind:\s*"/, `${f} must not be able to create an outbox item`);
    }
  });

  test("with tracking OFF nothing is monitored; with the agent disabled the message is ignored", async () => {
    await configure({ contact_scope: "none", orders_tracking_enabled: false });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg please");
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 0);
    await configure({ contact_scope: "none", enabled: false });
    const res = await customerSays(JANE, "2 Monello Chicken 15kg please");
    assert.equal(res.status, "ignored");
    assert.equal(monitorCalls.length, 0);
  });

  test("groups, status broadcasts and newsletters are never read for orders", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    for (const chat of [OTHER_GROUP, "status@broadcast", "120363000000000007@newsletter"]) {
      await say(chat, "2 bags of Monello Chicken please delivered tomorrow", { phone: null });
    }
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 0);
    // The staff group is a staff channel: its messages are never customer orders either.
    await say(GROUP, "2 bags of Monello Chicken for Jane", { phone: null, senderJid: STAFF });
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 0);
  });

  // ── Merging, corrections, multiple orders ─────────────────────────────────

  test("follow-ups merge into the same order; a clearly different order is a second record; a retried message changes nothing", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [first] = await allOrders();
    // A correction names the open order and restates it with a new quantity.
    monitorModel({ order_request: draft({ items: [{ product: "Monello Chicken", quantity: "3", variant: "Chicken", size: "15kg" }] }), order_target: first.ref_code });
    await customerSays(JANE, "make it 3 bags");
    let list = await allOrders();
    assert.equal(list.length, 1, "a correction is never a new order");
    assert.equal(list[0].items[0].quantity, "3");
    // A clearly different order from the same customer.
    monitorModel({ order_request: draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: "5 Beach Rd Castries", requested_for: "Saturday" }), order_target: "new" });
    await customerSays(JANE, "also a separate order: 4 Dog Treats delivered to 5 Beach Rd Castries on Saturday");
    list = await allOrders();
    assert.equal(list.length, 2);
    // The same WhatsApp message delivered twice (bridge retry) is not analysed or applied again.
    const calls = monitorCalls.length;
    const dup = await say(JANE.chat, "also a separate order: 4 Dog Treats delivered to 5 Beach Rd Castries on Saturday", { phone: JANE.phone, id: "DUP-1" });
    const again = await say(JANE.chat, "also a separate order: 4 Dog Treats delivered to 5 Beach Rd Castries on Saturday", { phone: JANE.phone, id: "DUP-1" });
    assert.equal(dup.status, "done");
    assert.equal(again.status, "duplicate");
    assert.equal(monitorCalls.length, calls + 1, "the duplicate costs nothing");
    assert.equal((await allOrders()).length <= 3, true);
  });

  test("a model that invents a product, quantity or time the customer never wrote has it dropped (grounding)", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft({ items: [{ product: "Monello Chicken", quantity: "2" }, { product: "Premium Salmon Feast", quantity: "9" }], requested_for: "Sunday at noon", delivery_address: "99 Invented Ave" }), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken please");
    const [o] = await allOrders();
    assert.deepEqual(o.items.map((i: any) => i.product), ["Monello Chicken"]);
    assert.match(o.requested_for, /\(default\)$/, "the invented time is dropped; only the business default day is stored");
    assert.equal(o.delivery_address, null);
  });

  test("fields a person edited stay locked against later analysis of a monitored chat", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    const [o] = await allOrders();
    const res = await orders.updateOrderManually({ businessSlug: "dog_food", orderId: o.id, adminId: "11111111-1111-1111-1111-111111111111", action: "edit", patch: { delivery_address: "7 Staff Corrected Rd" } });
    assert.equal(res.ok, true);
    monitorModel({ order_request: draft({ delivery_address: "12 Main St Gros Islet (again)" }), order_target: o.ref_code });
    await customerSays(JANE, "deliver to 12 Main St Gros Islet again please");
    assert.equal((await allOrders())[0].delivery_address, "7 Staff Corrected Rd");
  });

  test("a bare yes in a monitored chat is handled by the rules with no model call, and never finalizes an order by itself", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    monitorCalls.length = 0;
    await customerSays(JANE, "yes please");
    assert.equal(monitorCalls.length, 0, "no model call for a plain yes");
    const [o] = await allOrders();
    assert.notEqual(o.status, "confirmed");
    assert.equal(o.confirmed_by, null);
    // A person writes to the customer; the next yes is only RECORDED for staff to verify (customer confirmation is off).
    await store(JANE, "outbound", "Hi Jane, shall I confirm the order for Friday?");
    await customerSays(JANE, "yes");
    const [after] = await allOrders();
    assert.equal(after.status, "awaiting_confirmation");
    assert.equal(after.attention, "customer_replied_yes");
    assert.ok(after.customer_confirmed_at);
    assert.equal(after.confirmed_by, null);
    assert.equal(await anyOutbox(), 0);
  });

  test("pleasantries and chatter cost nothing and are recorded as filtered, not silently lost", async () => {
    await configure({ contact_scope: "none" });
    await customerSays(JANE, "thanks!");
    await customerSays(JANE, "Are you guys open on Sundays");
    assert.equal(monitorCalls.length, 0);
    const ev = await events(JANE.chat);
    assert.deepEqual(ev.map((e) => e.status), ["done", "done"]);
    assert.ok(ev[0].reason_codes.includes("orders_monitor_skipped_acknowledgement"));
    assert.ok(ev[1].reason_codes.includes("orders_monitor_skipped_no_order_signal"));
  });

  // ── Outgoing staff messages ───────────────────────────────────────────────

  test("a staff confirmation written in the chat FLAGS the open order for verification; it never confirms it, and no reply is made", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    monitorModel({ order_request: null, staff_action: "confirms" });
    const res = await staffWrites(JANE, "Confirmed Jane, we will deliver Friday morning");
    assert.equal(res.decision, "HUMAN");
    assert.deepEqual(res.outbox, []);
    const [o] = await allOrders();
    assert.equal(o.status, "awaiting_confirmation", "staff verification stays a person's Confirm click");
    assert.equal(o.attention, "staff_confirmed_in_chat");
    assert.equal(o.confirmed_by, null);
    const ev = (await orderEvents()).find((e) => e.kind === "staff_noted_in_chat");
    assert.ok(ev);
    assert.equal(ev.actor_kind, "staff");
    assert.match(ev.changes.staff_message.after, /Confirmed Jane/);
    assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_staff_confirms"));
    assert.equal(await anyOutbox(), 0);
  });

  test("a staff message never creates an order, never edits one, and never cancels one", async () => {
    await configure({ contact_scope: "none" });
    // No order is open: not even read.
    monitorModel({ order_request: draft(), order_target: "new" });
    await staffWrites(JANE, "Order for 2 bags of Monello Chicken delivered Friday");
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 0);
    // An order is open: the model "returns" new content and a cancellation; only a flag may result.
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    monitorModel({ order_request: draft({ items: [{ product: "Monello Chicken", quantity: "9" }] }), staff_action: "cancels" });
    await staffWrites(JANE, "Sorry we only have 9, order cancelled");
    const list = await allOrders();
    assert.equal(list.length, 1);
    assert.equal(list[0].items[0].quantity, "2", "content untouched");
    assert.equal(list[0].status, "awaiting_confirmation", "not cancelled by a message");
    assert.equal(list[0].attention, "staff_cancelled_in_chat");
  });

  test("with several open orders and no named one, a staff message flags nothing (no guessing)", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    monitorModel({ order_request: draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: "5 Beach Rd Castries" }), order_target: "new" });
    await customerSays(JANE, "and separately 4 Dog Treats delivered to 5 Beach Rd Castries Friday morning");
    assert.equal((await allOrders()).length, 2);
    monitorModel({ order_request: null, staff_action: "confirms", order_target: null });
    await staffWrites(JANE, "All confirmed");
    assert.ok((await allOrders()).every((o) => o.attention === null));
    assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_staff_ambiguous"));
  });

  test("an agent echo (the agent's own approved send coming back) is never read as a staff message", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key, status, whatsapp_message_id)
                  values ('dog_food', ${lit(JANE.chat)}, 'staff_relay', ${lit(JANE.chat)}, 'Confirmed, see you Friday', 'k1', 'sent', 'ECHO-1');`);
    monitorCalls.length = 0;
    const res = await say(JANE.chat, "Confirmed, see you Friday", { phone: JANE.phone, fromMe: true, id: "ECHO-1" });
    assert.deepEqual(res.reasons, ["agent_echo"]);
    assert.equal(monitorCalls.length, 0);
  });

  // ── Failure, budget, isolation ────────────────────────────────────────────

  test("a model failure is recorded on the event and in the report, never blocks the message, and never produces a reply", async () => {
    await configure({ contact_scope: "none" });
    monitorModel(null);
    const res = await customerSays(JANE, "2 Monello Chicken 15kg please");
    assert.equal(res.status, "done");
    assert.deepEqual(res.outbox, []);
    assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_failed"));
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.monitor_failed'`), 1);
    assert.match(await reportText(), /May be incomplete: 1 chat could not be analysed/);
  });

  test("a database failure while tracking is recorded as a failed analysis; the message still completes", async () => {
    await configure({ contact_scope: "none" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await pg.run(`alter table public.ai_agent_orders rename to ai_agent_orders_x;`);
    let res;
    try {
      res = await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    } finally {
      await pg.run(`alter table public.ai_agent_orders_x rename to ai_agent_orders;`);
    }
    assert.equal(res.status, "done");
    assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_failed"));
    assert.equal((await allOrders()).length, 0);
    assert.match(await reportText(), /could not be analysed/);
  });

  test("the hourly model budget bounds cost: past it a message is recorded as not analysed (and reported), with no model call", async () => {
    await configure({ contact_scope: "none" });
    await pg.run(`insert into public.ai_agent_audit_log (business_slug, actor_kind, action, target_type, target_id)
                  select 'dog_food', 'system', 'orders.monitor_call', 'chat', ${lit(JANE.chat)} from generate_series(1, 20);`);
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal(monitorCalls.length, 0);
    assert.ok((await lastReasons(JANE.chat)).includes("orders_monitor_rate_limited"));
    assert.match(await reportText(), /May be incomplete: 1 chat hit the analysis limit/);
    // Another chat of the same business is unaffected by this chat's budget.
    await customerSays(MARCUS, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal(monitorCalls.length, 1);
  });

  test("businesses are isolated: the same customer number in two businesses keeps separate orders, and each report lists only its own", async () => {
    await configure({ contact_scope: "none" });
    await configure({ contact_scope: "none" }, "by_sea", SEA_GROUP);
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", { biz: "dog_food" });
    monitorModel({ order_request: draft({ items: [{ product: "Sea Moss", quantity: "3" }], delivery_address: "1 Pier Rd" }), order_target: "new" });
    await customerSays(JANE, "3 Sea Moss delivered to 1 Pier Rd Friday morning", { biz: "by_sea" });
    assert.equal((await allOrders("dog_food")).length, 1);
    assert.equal((await allOrders("by_sea")).length, 1);
    assert.match(await reportText("dog_food"), /Monello Chicken/);
    assert.doesNotMatch(await reportText("dog_food"), /Sea Moss/);
    assert.match(await reportText("by_sea"), /Sea Moss/);
    assert.doesNotMatch(await reportText("by_sea"), /Monello/);
    // by_sea's open orders are what by_sea's model sees: dog_food's order never leaks into its prompt.
    monitorModel({ order_request: null });
    await customerSays(JANE, "actually make that 4 please", { biz: "by_sea" });
    const seen = JSON.stringify(monitorCalls.at(-1)!.openOrders);
    assert.match(seen, /Sea Moss/);
    assert.doesNotMatch(seen, /Monello/);
  });

  // ── Reports and coverage ──────────────────────────────────────────────────

  test("the daily report lists outstanding orders from conversations the AI may not answer, and states what it covers", async () => {
    await configure({ contact_scope: "selected" });
    monitorModel({ order_request: draft(), order_target: "new" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    monitorModel({ order_request: draft({ items: [{ product: "Dog Treats", quantity: "4" }], delivery_address: "5 Beach Rd" }), order_target: "new" });
    await customerSays(SAM, "4 Dog Treats delivered to 5 Beach Rd Friday morning");
    const text = await reportText();
    assert.match(text, /Monello Chicken/);
    assert.match(text, /Dog Treats/);
    assert.match(text, /📅 \*Fri 30 Oct\* \(2\)/, "grouped under the day they are for, not the day they were written");
    assert.doesNotMatch(text, /⚠️ May be incomplete|OFF/, "nothing is missing, so nothing is flagged");
    assert.doesNotMatch(text, /selected for the AI/);
  });

  test("customer messages the bridge stored but never forwarded are reported as a gap; forwarded ones are not", async () => {
    await configure({ contact_scope: "none", orders_tracking_since: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    await store(JANE, "inbound", "2 bags of Monello please", "NEVER-FORWARDED", 60);
    await store(MARCUS, "inbound", "hello there", "FORWARDED", 60);
    await store(JANE, "outbound", "agent or staff reply", "OUT-1", 59);
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
                  values ('dog_food', ${lit(OTHER_GROUP)}, null, 'inbound', 'group chatter', 'GRP-1', now() - interval '60 minutes'),
                         ('dog_food', 'status@broadcast', null, 'inbound', 'a status', 'ST-1', now() - interval '60 minutes'),
                         ('dog_food', ${lit(SAM.chat)}, ${lit(SAM.phone)}, 'inbound', 'just a message 1 minute ago', 'FRESH-1', now() - interval '1 minutes');`);
    await pg.run(`insert into public.ai_agent_events (business_slug, chat_id, whatsapp_message_id, kind, status, reason_codes)
                  values ('dog_food', ${lit(MARCUS.chat)}, 'FORWARDED', 'customer_inbound', 'done', array['orders_monitor_skipped_no_order_signal']);`);
    const text = await reportText();
    assert.match(text, /May be incomplete: 1 message never reached the agent/);
    assert.match(text, /⚠️/, "a report with a known gap says so");
  });

  test("rapid messages from a customer the AI may not answer are analysed together, in order, by ONE call (batching)", async () => {
    await configure({ contact_scope: "none", batching_enabled: true, batch_quiet_seconds: 30, batch_max_wait_seconds: 120 });
    monitorModel({ order_request: draft(), order_target: "new" });
    const first = await customerSays(JANE, "2 bags of Monello Chicken");
    assert.deepEqual(first.reasons.slice(0, 2), ["batched", "orders_monitor_queued"]);
    await customerSays(JANE, "15kg please, delivered to 12 Main St Gros Islet");
    await customerSays(JANE, "Friday morning");
    assert.equal(monitorCalls.length, 0, "nothing is decided until the quiet period ends");
    await pg.run(`update public.ai_agent_batches set due_at = now() - interval '1 second';`);
    const summary = await decide.processDueBatches();
    assert.equal(summary.done, 1);
    assert.equal(monitorCalls.length, 1, "one call for the whole turn");
    assert.match(monitorCalls[0].newMessages, /2 bags of Monello Chicken[\s\S]*15kg please[\s\S]*Friday morning/);
    assert.equal((await allOrders()).length, 1);
    assert.equal(await anyOutbox(), 0);
    assert.equal(replyCalls.length, 0);
    // Every message of the batch carries the monitoring reason, so coverage can see it.
    assert.ok((await events(JANE.chat)).every((e) => e.status === "done" && e.reason_codes.some((c) => c.startsWith("orders_monitor"))));
  });

  test("an AI-eligible customer in Observe is tracked through the existing model call, and nothing customer-bound exists", async () => {
    await configure({ mode: "observe", contact_scope: "all" });
    replyScript = () => replyProposal({ decision: "ESCALATE", intent: "order", order_request: draft(), summary: "order" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal(replyCalls.length, 1);
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 1);
    assert.equal(await customerBound(), 0);
  });

  test("AI-eligible conversations still reuse the existing single model call (no monitoring call, no extra cost)", async () => {
    await configure({ contact_scope: "all" });
    replyScript = () => replyProposal({ decision: "ESCALATE", intent: "order", order_request: draft(), summary: "order" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning");
    assert.equal(replyCalls.length, 1);
    assert.equal(monitorCalls.length, 0);
    assert.equal((await allOrders()).length, 1);
  });

  // ── Backfill ──────────────────────────────────────────────────────────────

  const ADMIN = "11111111-1111-1111-1111-111111111111";

  test("backfill is opt-in, validated, and refused unless tracking is on", async () => {
    await configure({ orders_tracking_enabled: false });
    assert.deepEqual(await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 48 }), { ok: false, status: 409, error: "Switch the AI agent and order tracking on for this business first." });
    await configure({});
    for (const hours of [0, 73, 24.5, "48"]) assert.equal((await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours })).ok, false);
    assert.equal(await count(`select 1 from public.ai_agent_order_backfill_runs`), 0, "nothing runs by itself");
  });

  test("backfill recovers orders from stored messages the old rules never analysed, bounded, idempotent, audited and silent", async () => {
    await configure({ contact_scope: "selected" });
    // Jane (not allowed) ordered yesterday; the old rules stopped it. Marcus's message was analysed by the monitor.
    await store(JANE, "inbound", "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", "OLD-1", 600);
    await store(JANE, "outbound", "Great, shall I confirm that for Friday?", "OLD-2", 590);
    await store(JANE, "inbound", "yes", "OLD-3", 580);
    await store(MARCUS, "inbound", "3 bags of Monello Beef please", "OLD-4", 600);
    await pg.run(`insert into public.ai_agent_events (business_slug, chat_id, whatsapp_message_id, kind, status, reason_codes)
                  values ('dog_food', ${lit(JANE.chat)}, 'OLD-1', 'customer_inbound', 'done', array['contact_not_permitted']),
                         ('dog_food', ${lit(JANE.chat)}, 'OLD-3', 'customer_inbound', 'done', array['contact_not_permitted']),
                         ('dog_food', ${lit(MARCUS.chat)}, 'OLD-4', 'customer_inbound', 'done', array['contact_not_permitted','orders_monitor_new_message']);`);
    monitorModel({ order_request: draft(), order_target: "new" });

    const started = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 48 });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.run.chats_total, 1, "only the conversation that was missed is planned");
    assert.equal(started.run.status, "running");
    assert.equal((await allOrders()).length, 0, "planning changes no orders");

    const stepped = await backfill.stepBackfill({ settings: await settingsOf(), runId: started.run.id });
    assert.equal(stepped.ok, true);
    if (!stepped.ok) return;
    assert.equal(stepped.run.status, "done");
    assert.equal(stepped.run.chats_done, 1);
    assert.equal(stepped.run.orders_touched, 1);
    const list = await allOrders();
    assert.equal(list.length, 1);
    assert.equal(list[0].chat_id, JANE.chat);
    assert.equal(list[0].customer_confirmed_at, null, "a yes in the past answers nothing: never recorded by a backfill");
    assert.notEqual(list[0].status, "confirmed");
    assert.match(monitorCalls[0].newMessages, /CUSTOMER: 2 Monello Chicken[\s\S]*STAFF: Great, shall I confirm/, "staff lines give context and are labelled");
    assert.equal(monitorCalls[0].author, "history");
    assert.equal(await anyOutbox(), 0, "a backfill never sends anything");
    assert.equal(replyCalls.length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.backfill_started'`), 1);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.backfill_finished'`), 1);
    assert.ok((await orderEvents()).every((e) => e.idempotency_key === null || String(e.idempotency_key).startsWith("backfill:")));

    // Stepping the finished run again, or starting another over the same window, repeats nothing.
    const calls = monitorCalls.length;
    const again = await backfill.stepBackfill({ settings: await settingsOf(), runId: started.run.id });
    assert.equal(again.ok && again.run.status, "done");
    const second = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 48 });
    assert.equal(second.ok && second.run.chats_total, 0, "already covered");
    assert.equal(second.ok && second.run.status, "done");
    assert.equal(monitorCalls.length, calls);
    assert.equal((await allOrders()).length, 1);
  });

  test("a repeated step of the same run is idempotent and a running run is resumed, not duplicated", async () => {
    await configure({ contact_scope: "selected" });
    await store(JANE, "inbound", "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", "OLD-1", 300);
    monitorModel({ order_request: draft(), order_target: "new" });
    const a = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 24 });
    const b = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 24 });
    assert.equal(a.ok && b.ok && a.run.id === b.run.id, true, "one running run per business");
    // Two steps racing: the order records are keyed per run + chat + chunk.
    await Promise.all([backfill.stepBackfill({ settings: await settingsOf(), runId: a.ok ? a.run.id : "" }), backfill.stepBackfill({ settings: await settingsOf(), runId: a.ok ? a.run.id : "" })]);
    assert.equal((await allOrders()).length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_order_events where idempotency_key like 'backfill:%'`), 1);
  });

  test("a backfill can be stopped, and a run is invisible to another business", async () => {
    await configure({ contact_scope: "selected" });
    await store(JANE, "inbound", "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet Friday morning", "OLD-1", 300);
    const run = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 24 });
    assert.equal(run.ok, true);
    if (!run.ok) return;
    const foreign = await backfill.stepBackfill({ settings: await settingsOf("by_sea"), runId: run.run.id });
    assert.deepEqual(foreign, { ok: false, status: 404, error: "Backfill not found" });
    const stopped = await backfill.cancelBackfill({ settings: await settingsOf(), runId: run.run.id, adminId: ADMIN });
    assert.equal(stopped.ok && stopped.run.status, "cancelled");
    assert.equal((await allOrders()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.backfill_cancelled'`), 1);
  });

  test("the public view of a run carries counts only, never conversation ids", async () => {
    await configure({ contact_scope: "selected" });
    await store(JANE, "inbound", "2 Monello Chicken 15kg please", "OLD-1", 300);
    const run = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 24 });
    assert.equal(run.ok, true);
    if (!run.ok) return;
    assert.doesNotMatch(JSON.stringify(backfill.publicRun(run.run)), /17585550101/);
  });

  test("the planned time window is not affected by messages outside it", async () => {
    await configure({ contact_scope: "selected" });
    await store(JANE, "inbound", "2 Monello Chicken 15kg delivered to 12 Main St Gros Islet", "TOO-OLD", 60 * 30);
    const run = await backfill.startBackfill({ settings: await settingsOf(), adminId: ADMIN, hours: 24, now: D(new Date().toISOString()) });
    assert.equal(run.ok && run.run.chats_total, 0);
    assert.equal(run.ok && run.run.note, "Nothing was missed in this window.");
  });

  void outbox;
});
