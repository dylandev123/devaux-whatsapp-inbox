// Conversational teaching, customer preferences and the numbered/variant commands, end to end: the app's REAL server code
// (processBridgeMessage → staff-group order commands → the same order mutation the dashboard uses → outbox) against the REAL
// migrations in a throwaway Postgres. Only the language models are scripted stand-ins. Skips itself when no Postgres
// binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import { addDays } from "../lib/aiAgent/orderText.ts";
import { dayContext } from "../lib/aiAgent/orderViews.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";
const TZ = "America/St_Lucia";

const customer = (i: number) => ({ chat: `175855520${String(i).padStart(2, "0")}@s.whatsapp.net`, phone: `175855520${String(i).padStart(2, "0")}` });
const JANE = customer(1);
type Customer = ReturnType<typeof customer>;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let corrections: typeof import("../lib/server/aiAgent/orderCorrections.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
type CorrectionInput = import("../lib/server/aiAgent/model.ts").OrderCorrectionInput;

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
/** What the correction model answers: an object (serialised), a raw string, or an error. */
let correct: (input: CorrectionInput) => object | string | { __error: string } = () => ({});
let correctionCalls: CorrectionInput[] = [];
let modelCalls = 0;

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true, mode: "approval_pilot", contact_scope: "all", staff_group_jid: group, staff_notices_enabled: true,
    customer_memory_enabled: false, batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"], orders_tracking_enabled: true, orders_summary_enabled: true, orders_group_jid: null,
    orders_timezone: TZ, orders_summary_hour: 8, orders_customer_confirms: false, orders_tracking_since: null, ...over,
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
const MONDAY = "2026-10-26T14:00:00.000Z";

async function customerSays(c: Customer, text: string, opts: { at?: string } = {}) {
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: `CUST-${++seq}`, chatId: c.chat, contactNumber: c.phone, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: opts.at ?? new Date().toISOString(),
  });
}

async function groupSays(text: string, opts: { group?: string; sender?: string | null; biz?: string; id?: string; at?: string | null } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `GRP-${++seq}`, chatId: opts.group ?? GROUP, contactNumber: null,
    fromMe: false, text, hasMedia: false, quotedMessageId: null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender, senderPhone: null,
    timestamp: opts.at === undefined ? new Date().toISOString() : opts.at,
  });
}

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderById = async (id: string) => (await rows<Record<string, any>>(`select * from public.ai_agent_orders where id = ${lit(id)}`))[0];
const orderEvents = (orderId: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_events where order_id = ${lit(orderId)} order by created_at, id`);
const proposals = (kind?: string) => rows<Record<string, any>>(`select * from public.ai_agent_order_proposals ${kind ? `where kind = ${lit(kind)}` : ""} order by created_at, id`);
const ref = (o: Record<string, any>) => `#${String(o.ref_code).slice(2)}`;
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const notToAGroup = () => count(`select 1 from public.ai_agent_outbox where to_jid not like '%@g.us'`);
const auditCount = (action: string) => count(`select 1 from public.ai_agent_audit_log where action = ${lit(action)}`);
const reply = (res: { outbox: { body: string }[] }) => res.outbox.map((o) => o.body).join("\n---\n");
const codeIn = (text: string, prefix: "C" | "B") => text.match(new RegExp(`${prefix}-[A-HJ-NP-Z2-9]{5}`))![0];
const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

async function makeOrder(c: Customer, text = "a bag of Monello Chicken 25kg, bring it to Cap Estate", d: Draft = draft(), at: string = MONDAY) {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order" });
  await customerSays(c, text, { at });
  return (await allOrders()).filter((o) => o.chat_id === c.chat && o.status !== "cancelled").at(-1)!;
}
/** Puts an order on the day `offset` days from today (the real clock, in St Lucia), as a stated day. */
async function setDay(o: Record<string, any>, offset: number, over = "") {
  const label = addDays(dayContext(new Date(), TZ).today, offset).label;
  await pg.run(`update public.ai_agent_orders set requested_for = ${lit(`${label} (test)`)}${over} where id = ${lit(o.id)};`);
}

const teach = (o: Record<string, any>, text: string, opts: Parameters<typeof groupSays>[1] = {}) => groupSays(`!order ${ref(o)} teach ${text}`, opts);

const STAFF2 = "17585550002@s.whatsapp.net";
const MARIA = customer(2);
const lastOutbox = () => rows<Record<string, any>>(`select * from public.ai_agent_outbox order by created_at desc, id desc limit 1`);
const sessions = (where = "true") => rows<Record<string, any>>(`select * from public.ai_agent_teach_sessions where ${where} order by created_at, id`);
const staffMemory = (kind?: string) => rows<Record<string, any>>(`select * from public.ai_agent_customer_staff_memory ${kind ? `where kind = ${lit(kind)}` : ""} order by created_at, id`);
const withName = async (o: Record<string, any>, name: string) => {
  await pg.run(`update public.ai_agent_orders set customer_name = ${lit(name)} where id = ${lit(o.id)};`);
  return orderById(o.id);
};
/** The bridge acknowledging our question: the WhatsApp id it was posted under, which a reply can then quote. */
async function ack(id: string) {
  await pg.run(`update public.ai_agent_outbox set whatsapp_message_id = ${lit(id)} where dedupe_key like 'teach:%' and whatsapp_message_id is null and created_at = (select max(created_at) from public.ai_agent_outbox where dedupe_key like 'teach:%' and whatsapp_message_id is null);`);
}
const quoting = (text: string, quoted: string, opts: Parameters<typeof groupSays>[1] = {}) =>
  decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `GRP-${++seq}`, chatId: opts.group ?? GROUP, contactNumber: null, fromMe: false, text,
    hasMedia: false, quotedMessageId: quoted, senderJid: opts.sender === undefined ? STAFF : opts.sender, senderPhone: null, timestamp: new Date().toISOString(),
  });
const codeOf = (text: string, prefix: "C" | "P") => text.match(new RegExp(`${prefix}-[A-HJ-NP-Z2-9]{5}`))![0];

describe("conversational teaching (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    corrections = await import("../lib/server/aiAgent/orderCorrections.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async () => {
      modelCalls += 1;
      return { proposal: script(), model: "scripted", error: null };
    });
    model.setOrderCorrectionProposerForTests(async (input) => {
      correctionCalls.push(input);
      const answer = correct(input);
      if (typeof answer === "object" && answer && "__error" in answer) return { text: null, model: "scripted", error: String((answer as { __error: string }).__error) };
      return { text: typeof answer === "string" ? answer : JSON.stringify(answer), model: "scripted", error: null };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    model?.setOrderCorrectionProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      alter table if exists public.ai_agent_teach_sessions_hidden rename to ai_agent_teach_sessions;
      alter table if exists public.ai_agent_order_lists_hidden rename to ai_agent_order_lists;
      drop trigger if exists boom_t on public.ai_agent_order_proposals;
      truncate public.ai_agent_orders, public.ai_agent_order_proposals, public.ai_agent_order_feedback, public.ai_agent_teach_sessions, public.ai_agent_order_lists,
        public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts,
        public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_customer_staff_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts,
        public.ai_agent_shadow_results, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null;`);
    await configure({ staff_authorized_senders: ["17585550001", "17585550002"] });
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls = 0;
    correctionCalls = [];
    script = () => proposal();
    correct = () => ({});
  });

  const BANDIT = { product: "Bandit", size: "25kg", variant: null };

  describe("a multi-turn conversation", () => {
    test("the example: usual product + current order, in two turns, ending in two SEPARATE confirmations", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      const original = await orderById(o.id);
      correct = () => ({ customer_name: "Jonathon", usual_product: { ...BANDIT, save: null, for_order: null } });
      const asked = await teach(o, "Jonathon usually orders Bandit 25kg.");
      const question = reply(asked);
      assert.match(question, /I need a little more before I change anything/);
      assert.match(question, /Should I save Bandit 25kg as Jonathan Calderon's usual product/);
      assert.match(question, /also the product for .* current order/);
      assert.match(question, /Reply to this message/);
      assert.equal(asked.outbox.length, 1);
      // Asking changed and saved nothing; the respelt name was no reason to refuse and no name change.
      assert.deepEqual(await proposals(), []);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0);
      assert.deepEqual([(await orderById(o.id)).version, (await orderById(o.id)).customer_name], [original.version, "Jonathan Calderon"]);
      const [s] = await sessions();
      assert.deepEqual([s.status, s.order_ref, s.started_by, s.turn], ["open", o.ref_code, "17585550001", 1]);
      await ack("WAQ-1");

      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }], requested_for: "today" });
      const answered = await quoting("Yes, save it. He wants 2 bags today.", "WAQ-1");
      assert.equal(answered.outbox.length, 2, "one order preview and one customer-memory preview");
      const [orderPreview, memoryPreview] = answered.outbox.map((x) => x.body);
      assert.match(orderPreview, /Proposed correction/);
      assert.match(orderPreview, /Products: .* → \*2 × Bandit 25kg\*/);
      assert.match(memoryPreview, /Proposed customer memory/);
      assert.match(memoryPreview, /separate from the order/);
      assert.match(memoryPreview, /Usual product: \*Bandit 25kg\*/);
      // The conversation was kept: the model saw the first message, our question and the answer.
      assert.deepEqual(correctionCalls[1].conversation!.map((t) => t.by), ["staff", "assistant", "staff"]);
      assert.match(correctionCalls[1].conversation![0].text, /Jonathon usually orders Bandit 25kg/);
      // Still nothing applied, nothing saved.
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0);
      assert.equal((await orderById(o.id)).version, original.version);
      assert.equal((await sessions())[0].status, "proposed");

      // The order change and the customer preference are confirmed separately.
      const c = codeOf(orderPreview, "C");
      const p = codeOf(memoryPreview, "P");
      assert.match(reply(await groupSays(`!confirm ${c}`)), /corrected: products, day \/ time/);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0, "confirming the order saves nothing about the customer");
      const saved = reply(await groupSays(`!confirm ${p}`));
      assert.match(saved, /Saved for [\s\S]*Usual product: Bandit 25kg/);
      const [memory] = await staffMemory("usual_product");
      assert.deepEqual([memory.status, memory.content, memory.set_by, memory.customer_key], ["active", "Bandit 25kg", "17585550001", JANE.phone]);
      assert.equal(await auditCount("orders.preference_proposed"), 1);
      assert.equal(await auditCount("orders.preference_applied"), 1);
      const [pp] = await proposals("customer_preference");
      assert.deepEqual([pp.status, pp.resolved_by], ["applied", "17585550001"]);
      assert.match(pp.instruction, /usually orders Bandit 25kg/, "the staff wording is kept as evidence");
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
    });

    test("a missing quantity is a question, whatever the model guesses; an unquoted reply from the same person answers it", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ items: [{ product: "Bandit", quantity: "1", size: "25kg" }] });
      const text = reply(await groupSays(`!Order ${ref(o)} teach Jonathon ordered bags. There is no specific bags set but the bags he takes are bandit 25kg`));
      assert.match(text, /How many bags of Bandit 25kg does Jonathan Calderon want\?/);
      assert.doesNotMatch(text, /could not safely/);
      assert.deepEqual(await proposals(), []);

      correct = () => ({ items: [{ product: "Bandit", quantity: "3", size: "25kg" }] });
      const done = reply(await groupSays("3 bags"));
      assert.match(done, /Proposed correction/);
      assert.match(done, /3 × Bandit 25kg/);
      assert.equal(correctionCalls.length, 2);
    });

    test("ordinary chatter while a question is open is left alone (the model says it is unrelated)", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      correct = () => ({ related: false });
      const chatter = await groupSays("anyone have the gate code for Rodney Bay?");
      assert.equal(chatter.outbox.length, 0);
      assert.equal((await sessions())[0].turn, 1);
      assert.equal((await sessions())[0].status, "open");
    });

    test("cancel stops it, changes nothing; teaching again starts fresh, and a restart replaces the open one", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-C");
      const calls = correctionCalls.length;
      assert.match(reply(await quoting("cancel", "WAQ-C")), /Stopped teaching .* Nothing was changed or saved/);
      assert.equal(correctionCalls.length, calls, "cancelling needs no model");
      assert.equal((await sessions())[0].status, "cancelled");
      assert.match(reply(await quoting("yes save it", "WAQ-C")), /closed \(cancelled\)/);

      await teach(o, "Jonathon usually orders Bandit 25kg");
      const restarted = reply(await teach(o, "Jonathon usually orders Bandit 25kg, again"));
      assert.match(restarted, /Started over on .*earlier conversation about it is closed/);
      assert.deepEqual((await sessions()).map((s) => s.status), ["cancelled", "superseded", "open"]);
    });

    test("an idle conversation expires: a late quoted reply is told so and changes nothing", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-E");
      await pg.run("update public.ai_agent_teach_sessions set expires_at = now() - interval '1 minute';");
      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }] });
      const late = reply(await quoting("yes save it, 2 bags", "WAQ-E"));
      assert.match(late, /timed out, so nothing was changed/);
      assert.deepEqual(await proposals(), []);
      assert.equal((await sessions())[0].status, "expired");
      // Without a quote, an expired conversation is not even a candidate: ordinary message, no reply.
      assert.equal((await groupSays("yes save it, 2 bags")).outbox.length, 0);
    });

    test("an order that changed during the conversation ends it: nothing is applied to a different order", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-V");
      await groupSays(`!order ${ref(o)} 5 bags`);
      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }] });
      assert.match(reply(await quoting("yes save it, 2 bags", "WAQ-V")), /changed while we were talking, so I stopped\. Nothing changed/);
      assert.deepEqual(await proposals(), []);
    });
  });

  describe("several conversations at once", () => {
    test("two orders, two questions: a quoted reply reaches only its own order; an unquoted short reply is not guessed", async () => {
      const a = await withName(await makeOrder(JANE), "Jonathan Calderon");
      const b = await withName(await makeOrder(MARIA, "a bag of Monello Chicken 25kg, bring it to Cap Estate"), "Maria Louis");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(a, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-A");
      correct = () => ({ usual_product: { product: "Birbo Meat", size: "25kg", variant: null, save: null, for_order: null } });
      await teach(b, "Maria always orders Birbo Meat 25kg");
      await ack("WAQ-B");
      assert.equal((await sessions("status = 'open'")).length, 2);

      const callsBefore = correctionCalls.length;
      const nudge = reply(await groupSays("yes"));
      assert.match(nudge, /waiting on answers about .* and .*Reply directly to the question/);
      assert.equal(correctionCalls.length, callsBefore, "no guess, no model call");

      correct = () => ({ usual_product: { product: "Birbo Meat", size: "25kg", variant: null, save: true, for_order: false } });
      const done = await quoting("Yes, save it for later, not this order", "WAQ-B");
      assert.equal(done.outbox.length, 1);
      assert.match(reply(done), /Maria Louis/);
      assert.match(reply(done), /Usual product: \*Birbo Meat 25kg\*/);
      assert.deepEqual((await sessions()).map((s) => [s.order_ref, s.status]), [[a.ref_code, "open"], [b.ref_code, "proposed"]]);
      // The model for B was shown B's order only.
      assert.equal(correctionCalls.at(-1)!.order && (correctionCalls.at(-1)!.order as { ref: string }).ref, b.ref_code);
      assert.doesNotMatch(JSON.stringify(correctionCalls.at(-1)!.conversation), /Jonathon/);
    });

    test("another staff member cannot answer someone else's question, and starting their own does not disturb it", async () => {
      const a = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(a, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-1");
      const calls = correctionCalls.length;
      assert.match(reply(await quoting("yes save it", "WAQ-1", { sender: STAFF2 })), /asked of another staff member/);
      assert.equal(correctionCalls.length, calls);
      await teach(a, "Jonathon usually orders Bandit 25kg", { sender: STAFF2 });
      assert.deepEqual((await sessions()).map((s) => [s.started_by, s.status]), [["17585550001", "open"], ["17585550002", "open"]]);
    });
  });

  describe("customer preferences are separate and only saved when confirmed", () => {
    test("a place for THIS order is only an order change; nothing about the customer is proposed", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet", saved_location: { value: "Gros Islet", save: null } });
      const text = reply(await teach(o, "location is gros islet"));
      assert.match(text, /Proposed correction/);
      assert.equal((await proposals("customer_preference")).length, 0);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0);
    });

    test("a usual location is asked about, proposed with its own code, and saved only after !confirm P-…; a newer one replaces it and keeps the history", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ saved_location: { value: "Cap Estate", save: null } });
      await teach(o, "he usually gets deliveries at Cap Estate");
      assert.match(reply(await lastOutboxAsResult()), /usual delivery location/);
      correct = () => ({ saved_location: { value: "Cap Estate", save: true } });
      const proposed = reply(await groupSays("save Cap Estate as his usual location"));
      assert.match(proposed, /Usual delivery location: \*Cap Estate\*/);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0, "a preview saves nothing");
      await groupSays(`!confirm ${codeOf(proposed, "P")}`);
      assert.deepEqual((await staffMemory("delivery_location")).map((m) => [m.content, m.status]), [["Cap Estate", "active"]]);

      correct = () => ({ saved_location: { value: "Gros Islet", save: true } });
      const second = reply(await teach(o, "remember Gros Islet is his usual location now"));
      await groupSays(`!confirm ${codeOf(second, "P")}`);
      assert.deepEqual((await staffMemory("delivery_location")).map((m) => [m.content, m.status]), [["Cap Estate", "superseded"], ["Gros Islet", "active"]]);
    });

    test("a discarded preference saves nothing; an expired one cannot be confirmed; a stale code from another business is unknown", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: false } });
      const p1 = codeOf(reply(await teach(o, "remember Jonathon usually orders Bandit 25kg, not for this order")), "P");
      assert.match(reply(await groupSays(`!discard ${p1}`)), /Nothing was saved about the customer/);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0);
      const p2 = codeOf(reply(await teach(o, "remember Jonathon usually orders Bandit 25kg, not for this order")), "P");
      await pg.run("update public.ai_agent_order_proposals set expires_at = now() - interval '1 minute' where status = 'pending';");
      assert.match(reply(await groupSays(`!confirm ${p2}`)), /expired/);
      const p3 = codeOf(reply(await teach(o, "remember Jonathon usually orders Bandit 25kg, not for this order, thanks")), "P");
      assert.match(reply(await groupSays(`!confirm ${p3}`, { group: SEA_GROUP, biz: "by_sea" })), /No open proposal/);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0);
    });

    test("a saved usual product answers a later 'send me a bag' for that customer — and only that customer", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: false } });
      await groupSays(`!confirm ${codeOf(reply(await teach(o, "remember Jonathon usually orders Bandit 25kg, not for this order")), "P")}`);
      await pg.run("update public.ai_agent_orders set status = 'cancelled' where true;");
      script = () => proposal({ decision: "ESCALATE", intent: "order", summary: "order", order_request: draft({ items: [{ product: "bag", quantity: "1", size: null }] }) });
      await customerSays(JANE, "send me a bag please", { at: new Date().toISOString() });
      const [mine] = (await allOrders()).filter((x) => x.chat_id === JANE.chat && x.status !== "cancelled");
      assert.equal(mine.items[0].product, "Bandit 25kg");
      const events = await orderEvents(mine.id);
      assert.ok(events.some((e) => JSON.stringify(e.changes.product_source ?? {}).includes("staff_saved")));
      await customerSays(MARIA, "send me a bag please", { at: new Date().toISOString() });
      const other = (await allOrders()).filter((x) => x.chat_id === MARIA.chat && x.status !== "cancelled");
      assert.ok(!other.some((x) => x.items.some((i: { product: string }) => /Bandit/.test(i.product))), "another customer never gets it");
    });

    test("a display name is staff-confirmed, beats the synced and profile names, and a later profile update never overwrites it", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      await pg.run(`insert into public.customers (phone_number, whatsapp_name, business_contact_name) values (${lit(JANE.phone)}, 'jj profile', 'Jonny Synced');`);
      const orders = await import("../lib/server/aiAgent/orders.ts");
      const fresh = async () => (await orders.loadOrderNames("dog_food", [(await orderById(o.id)) as never]))[o.id]!;
      await pg.run("update public.ai_agent_orders set customer_name = null where true;");
      assert.deepEqual([(await fresh()).name, (await fresh()).source], ["Jonny Synced", "saved"]);
      correct = () => ({ display_name: "Jon Calderon" });
      const p = codeOf(reply(await teach(o, "call him Jon Calderon")), "P");
      assert.equal((await fresh()).name, "Jonny Synced", "proposed is not saved");
      await groupSays(`!confirm ${p}`);
      assert.deepEqual([(await fresh()).name, (await fresh()).source], ["Jon Calderon", "staff"]);
      await pg.run(`update public.customers set whatsapp_name = 'New Profile Name', business_contact_name = 'Another Synced' where phone_number = ${lit(JANE.phone)};`);
      assert.equal((await fresh()).name, "Jon Calderon");
      const [c] = await rows<Record<string, any>>("select first_name, last_name from public.customers");
      assert.deepEqual([c.first_name, c.last_name], ["Jon", "Calderon"]);
    });
  });

  describe("numbered orders and command acknowledgement", () => {
    test("the real failure: with the report snapshots table missing, !order 1 says exactly that — never 'something went wrong' — and changes nothing", async () => {
      const o = await makeOrder(JANE);
      await pg.run("alter table public.ai_agent_order_lists rename to ai_agent_order_lists_hidden;");
      try {
        for (const cmd of ["!order 1", "!order 1 teach bags are bandit 25kg", "!order 1 completed"]) {
          const text = reply(await groupSays(cmd));
          assert.match(text, /Report numbers are not available yet.*20261110000000.*#REF/, cmd);
          assert.doesNotMatch(text, /Something went wrong/);
        }
        assert.equal((await orderById(o.id)).status, o.status);
        // #REF still works with no snapshots at all.
        assert.match(reply(await groupSays(`!order ${ref(o)}`)), new RegExp(ref(o)));
      } finally {
        await pg.run("alter table public.ai_agent_order_lists_hidden rename to ai_agent_order_lists;");
      }
    });

    test("with the table present, a numbered teach resolves against the latest posted report; a changed list is never guessed", async () => {
      const o = await makeOrder(JANE);
      await setDay(o, 0);
      await groupSays("!orders");
      correct = () => ({ delivery_address: "Gros Islet" });
      const first = reply(await groupSays("!order 1 teach location is gros islet"));
      assert.match(first, new RegExp(`Proposed correction — ${ref(o)}`));
      assert.equal(await count("select 1 from public.ai_agent_order_lists"), 1);
      await pg.run("update public.ai_agent_orders set version = version + 1 where true;");
      assert.match(reply(await groupSays("!order 1 teach location is gros islet")), /changed after that list was posted/);
      assert.match(reply(await groupSays("!order 9")), /There is no number 9/);
      await pg.run("update public.ai_agent_order_lists set created_at = now() - interval '2 days';");
      assert.match(reply(await groupSays("!order 1")), /expired|no order list/);
      await pg.run("truncate public.ai_agent_order_lists;");
      assert.match(reply(await groupSays("!order 1")), /no order list to read that number from/);
    });

    test("variations: a spaced bang and 'teach' first are the same command; the bang-less form and a mangled reference get a syntax answer, not silence", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      assert.match(reply(await groupSays(`! Order ${ref(o)} teach location is gros islet`)), /Proposed correction/);
      assert.match(reply(await groupSays(`!order teach ${ref(o)} location is gros islet`)), /Proposed correction/);
      const calls = correctionCalls.length;
      const hint = reply(await groupSays(`Order ${ref(o)} teach location is gros islet`));
      assert.match(hint, /Commands start with “!”[\s\S]*!Order #/);
      assert.equal(correctionCalls.length, calls, "never acted on");
      assert.match(reply(await groupSays("!order teach #CODE and location is cap estate for weixin Lin")), /!order #REF teach <what is wrong/);
      assert.equal((await orderById(o.id)).delivery_address, o.delivery_address, "only proposals so far");
    });

    test("every outcome is a reply in the group: unknown order, closed order, model down, and an internal failure (nothing changed, said so)", async () => {
      const o = await makeOrder(JANE);
      assert.match(reply(await groupSays("!order #ZZZZ9 teach address is Gros Islet")), /No order #ZZZZ9 found/);
      correct = () => ({ __error: "429 rate limited" });
      assert.match(reply(await teach(o, "address is Gros Islet")), /assistant is unavailable\)\. Nothing changed/);
      correct = () => ({ delivery_address: "Gros Islet" });
      await pg.run(`create or replace function public.boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
        create trigger boom_t before insert on public.ai_agent_order_proposals for each row execute function public.boom();`);
      const failed = await teach(o, "address is Gros Islet");
      assert.match(reply(failed), /could not be updated right now\. Nothing changed/);
      assert.equal(failed.outbox[0].to, GROUP);
      assert.equal((await orderById(o.id)).version, o.version);
      // The reply is a real outbox row: it was queued for the bridge, not just returned.
      assert.ok((await count(`select 1 from public.ai_agent_outbox where to_jid = ${lit(GROUP)} and body like '%could not be updated%'`)) >= 1);
    });

    test("the group's last word is stored and a redelivered command is answered once", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      await teach(o, "address is Gros Islet", { id: "DUP-1" });
      await teach(o, "address is Gros Islet", { id: "DUP-1" });
      assert.equal((await proposals()).length, 1);
      assert.equal(correctionCalls.length, 1);
      assert.equal(await count(`select 1 from public.ai_agent_outbox where body like '%Proposed correction%'`), 1);
    });
  });

  describe("authorization, isolation and safety", () => {
    test("an unauthorized sender cannot teach, answer or confirm; an unquoted message from them is ordinary chatter", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      assert.match(reply(await teach(o, "Jonathon usually orders Bandit 25kg", { sender: STRANGER })), /Only authorized staff/);
      assert.equal(correctionCalls.length, 0);
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-U");
      const calls = correctionCalls.length;
      assert.match(reply(await quoting("yes save it", "WAQ-U", { sender: STRANGER })), /Only authorized staff/);
      assert.equal((await groupSays("yes save it", { sender: STRANGER })).outbox.length, 0);
      assert.equal(correctionCalls.length, calls);
      assert.equal((await sessions())[0].turn, 1);
    });

    test("another business's group can neither see nor answer this business's conversation", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-X");
      const calls = correctionCalls.length;
      const res = await quoting("yes save it", "WAQ-X", { group: SEA_GROUP, biz: "by_sea" });
      assert.equal(res.outbox.length, 0);
      assert.equal(correctionCalls.length, calls);
      assert.equal((await sessions())[0].turn, 1);
      // A reply in the same business but another group does not bind either.
      await configure({ orders_group_jid: OTHER_GROUP });
      assert.equal((await quoting("yes save it", "WAQ-X", { group: OTHER_GROUP })).outbox.length, 0);
    });

    test("without the sessions migration the app degrades safely: complete instructions still work, incomplete ones say what is missing, preferences say setup is pending", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      await pg.run("alter table public.ai_agent_teach_sessions rename to ai_agent_teach_sessions_hidden;");
      try {
        correct = () => ({ items: [{ product: "Bandit", quantity: "2", size: "25kg" }] });
        assert.match(reply(await teach(o, "2 bags of Bandit 25kg")), /Proposed correction/);
        correct = () => ({ items: [{ product: "Bandit", quantity: null, size: "25kg" }] });
        const needs = reply(await teach(o, "bags of Bandit 25kg"));
        assert.match(needs, /cannot hold a back-and-forth conversation yet[\s\S]*20261111000000/);
        assert.match(needs, /How many bags of Bandit 25kg/);
        assert.equal((await orderById(o.id)).version, o.version);
        // The preference path needs the widened proposal kind: simulate the old constraint.
        await pg.run("alter table public.ai_agent_order_proposals drop constraint ai_agent_order_proposals_kind_check; alter table public.ai_agent_order_proposals add constraint ai_agent_order_proposals_kind_check check (kind in ('correction','bulk_complete'));");
        correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: false } });
        assert.match(reply(await teach(o, "remember Jonathon usually orders Bandit 25kg, not for this order")), /needs a one-time setup step[\s\S]*20261111000000[\s\S]*nothing was saved/);
      } finally {
        await pg.run("alter table public.ai_agent_order_proposals drop constraint ai_agent_order_proposals_kind_check; alter table public.ai_agent_order_proposals add constraint ai_agent_order_proposals_kind_check check (kind in ('correction','bulk_complete','customer_preference'));");
        await pg.run("alter table public.ai_agent_teach_sessions_hidden rename to ai_agent_teach_sessions;");
      }
    });

    test("Approval Pilot safety: nothing in a whole conversation ever addresses a customer, sends a draft, or posts outside the group", async () => {
      const o = await withName(await makeOrder(JANE), "Jonathan Calderon");
      const escalations = await count("select 1 from public.ai_agent_escalations");
      correct = () => ({ usual_product: { ...BANDIT, save: null, for_order: null } });
      await teach(o, "Jonathon usually orders Bandit 25kg");
      await ack("WAQ-S");
      correct = () => ({ usual_product: { ...BANDIT, save: true, for_order: true }, items: [{ product: "Bandit", quantity: "2", size: "25kg" }] });
      const done = await quoting("yes save it, 2 bags", "WAQ-S");
      for (const p of done.outbox.map((x) => x.body)) await groupSays(`!confirm ${p.match(/[CP]-[A-HJ-NP-Z2-9]{5}/)![0]}`);
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
      assert.equal(await count("select 1 from public.ai_agent_pilot_drafts"), 0);
      assert.equal(await count("select 1 from public.ai_agent_escalations"), escalations, "no escalation, relay or approval was created");
    });
  });
});

async function lastOutboxAsResult() {
  const [row] = await lastOutbox();
  return { outbox: [{ body: row.body as string }] };
}
