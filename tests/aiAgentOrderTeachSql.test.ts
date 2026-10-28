// "!order #REF teach …", "!orders complete all" and their !confirm / !discard, end to end: the app's REAL server code
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

describe("order corrections and bulk completion (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
      drop trigger if exists boom_t on public.ai_agent_orders;
      truncate public.ai_agent_orders, public.ai_agent_order_proposals, public.ai_agent_order_feedback, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts,
        public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
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
    correctionCalls = [];
    script = () => proposal();
    correct = () => ({});
  });

  // ── A natural-language correction, end to end ──────────────────────────────

  describe("!order #REF teach", () => {
    test("several fields in one instruction: previewed first, applied only after !confirm, authoritative, audited, nobody messaged", async () => {
      const o = await makeOrder(JANE, "Monello please", draft({ delivery_address: null }));
      const original = await orderById(o.id);
      correct = () => ({ delivery_address: "Cap Estate", items: [{ product: "Bandit", quantity: "1", size: "25kg" }] });
      const asked = await teach(o, "The address is Cap Estate and the food is 1 Bandit 25kg");
      const preview = reply(asked);
      assert.equal(asked.outbox.length, 1);
      assert.equal(asked.outbox[0].to, GROUP);
      assert.match(preview, /Proposed correction/);
      assert.match(preview, /Delivery address: not set → \*Cap Estate\*/);
      assert.match(preview, /Products: Monello Chicken — quantity needed → \*1 × Bandit 25kg\*/);
      assert.match(preview, /Nothing has changed yet/);
      const code = codeIn(preview, "C");
      assert.match(preview, new RegExp(`!confirm ${code}`));
      assert.match(preview, new RegExp(`!discard ${code}`));
      // Previewing changed nothing.
      const unchanged = await orderById(o.id);
      assert.deepEqual([unchanged.version, unchanged.items, unchanged.delivery_address, unchanged.manual_locked_fields], [original.version, original.items, original.delivery_address, []]);
      assert.equal((await proposals())[0].status, "pending");
      assert.equal(correctionCalls.length, 1);
      assert.match(JSON.stringify(correctionCalls[0].order), /Monello/, "the model sees the order as it is now");

      const done = await groupSays(`!confirm ${code}`);
      assert.match(reply(done), new RegExp(`✅ ${ref(o)} .* corrected: products, delivery address\\. The customer was not messaged\\.`));
      const after = await orderById(o.id);
      assert.equal(after.delivery_address, "Cap Estate");
      assert.equal(after.items[0].product, "Bandit");
      assert.deepEqual([...after.manual_locked_fields].sort(), ["delivery_address", "items"]);
      assert.equal(after.version, original.version + 1);
      const last = (await orderEvents(o.id)).at(-1)!;
      assert.deepEqual([last.kind, last.actor_kind, last.actor_id], ["staff_whatsapp_edit", "staff", "17585550001"]);
      assert.equal(last.changes.delivery_address.after, "Cap Estate");
      assert.equal(last.changes.correction.after.code, code);
      assert.match(last.changes.correction.after.instruction, /food is 1 Bandit 25kg/);
      const [p] = await proposals();
      assert.deepEqual([p.status, p.resolved_by], ["applied", "17585550001"]);
      assert.equal(await auditCount("orders.teach_proposed"), 1);
      assert.equal(await auditCount("orders.teach_applied"), 1);
      assert.equal(await auditCount("order.edit"), 1);
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
    });

    test("name, quantity, product and delivery place from one sentence", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ customer_name: "Jason", fulfilment_method: "delivery", delivery_address: "Gros Islet", items: [{ product: "Birbo Meat", quantity: "2", size: "25kg" }] });
      const code = codeIn(reply(await teach(o, "Jason wants 2 Birbo Meat 25kg delivered to Gros Islet")), "C");
      await groupSays(`!confirm ${code}`);
      const after = await orderById(o.id);
      assert.deepEqual([after.customer_name, after.delivery_address, after.items[0].product, after.items[0].quantity], ["Jason", "Gros Islet", "Birbo Meat", "2"]);
    });

    test("collection with a day: counted from when staff wrote it, in St Lucia time, either side of midnight", async () => {
      const o = await makeOrder(JANE);
      const settings = await settingsOf();
      correct = () => ({ customer_name: "Blondie", fulfilment_method: "collection", requested_for: "tomorrow morning" });
      const run = (id: string, iso: string) =>
        corrections.handleCorrectionCommand({
          settings, fromGroup: GROUP, command: { kind: "teach", selector: { type: "ref", ref: o.ref_code }, instruction: "Blondie is collecting tomorrow morning" },
          senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF, eventId: "00000000-0000-4000-8000-000000000001",
          whatsappMessageId: id, timestamp: iso, now: new Date(Date.parse(iso) + 60_000),
        });
      const late = reply(await run("T-LATE", "2026-10-28T03:30:00.000Z")); // 23:30 Tue 27 Oct locally
      assert.match(late, /Day \/ time: .* → \*Wed 28 Oct, morning\*/);
      assert.match(late, /Delivery \/ collection: delivery → \*collection\*/);
      const early = reply(await run("T-EARLY", "2026-10-28T04:30:00.000Z")); // 00:30 Wed 28 Oct locally
      assert.match(early, /→ \*Thu 29 Oct, morning\*/);
      // The newer proposal replaced the older one: only its code works.
      const [first, second] = await proposals();
      assert.deepEqual([first.status, second.status], ["superseded", "pending"]);
      const staleCode = codeIn(late, "C");
      assert.match(reply(await groupSays(`!confirm ${staleCode}`)), /replaced by a newer proposal/);
      // Confirmed on the same fixed clock the proposal was made on (a real-clock confirm would find it long expired).
      const confirmed = await corrections.handleCorrectionCommand({
        settings, fromGroup: GROUP, command: { kind: "proposal", action: "confirm", code: codeIn(early, "C"), proposalKind: "correction" },
        senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF, eventId: "00000000-0000-4000-8000-000000000004",
        whatsappMessageId: "T-CONFIRM", timestamp: null, now: new Date("2026-10-28T04:35:00.000Z"),
      });
      assert.match(reply(confirmed), /corrected: delivery \/ collection, customer name, day \/ time/);
      const after = await orderById(o.id);
      assert.equal(after.requested_for, "Thu 29 Oct (tomorrow morning)");
      assert.equal(after.fulfilment_method, "collection");
      assert.equal(after.customer_name, "Blondie");
    });

    test("an ambiguous or unsupported instruction changes nothing and creates no proposal", async () => {
      const o = await makeOrder(JANE);
      const before = await orderById(o.id);
      const attempts: [object, RegExp][] = [
        [{ items: [{ product: "Monello", quantity: "3", size: null }], ambiguities: ["Chicken or Beef?"] }, /Chicken or Beef\?/],
        [{ items: [{ product: "Bandit", quantity: "1", size: null }] }, /“Bandit” is not in what you wrote/],
        [{ requested_for: "next week" }, /could not read “next week” as one day/],
      ];
      for (const [answer, expected] of attempts) {
        correct = () => answer;
        const text = reply(await teach(o, "make it 3 Monello, deliver next week"));
        assert.match(text, /could not safely turn that into a change/);
        assert.match(text, expected);
        assert.match(text, /Nothing changed/);
      }
      correct = () => "I think they want more food";
      assert.match(reply(await teach(o, "more food")), /could not safely turn that into a change/);
      correct = () => ({});
      assert.match(reply(await teach(o, "something unrelated")), /already matches that — nothing to change/);
      assert.deepEqual(await proposals(), []);
      const after = await orderById(o.id);
      assert.deepEqual([after.version, after.items, after.requested_for], [before.version, before.items, before.requested_for]);
    });

    test("the model being unavailable changes nothing and says so", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ __error: "429 rate limited" });
      assert.match(reply(await teach(o, "address is Gros Islet")), /assistant is unavailable\)\. Nothing changed/);
      assert.deepEqual(await proposals(), []);
      assert.equal((await orderById(o.id)).version, o.version);
    });

    test("only an order reference, an open order and a real instruction are accepted", async () => {
      const o = await makeOrder(JANE);
      assert.match(reply(await groupSays("!order Jane teach address is Gros Islet")), /!order #REF teach <what is wrong/);
      assert.match(reply(await groupSays(`!order ${ref(o)} teach`)), /!order #REF teach <what is wrong/);
      assert.match(reply(await groupSays("!order #ZZZZ9 teach address is Gros Islet")), /No order #ZZZZ9 found/);
      await groupSays(`!order ${ref(o)} completed`);
      assert.match(reply(await teach(o, "address is Gros Islet")), /is completed — it cannot be corrected/);
      assert.equal(correctionCalls.length, 0, "the model is only asked about an order that can change");
    });

    test("a command that is more than two hours old does not start a proposal", async () => {
      const o = await makeOrder(JANE);
      const res = await teach(o, "address is Gros Islet", { at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
      assert.match(reply(res), /more than 2 hours ago/);
      assert.equal(correctionCalls.length, 0);
      assert.deepEqual(await proposals(), []);
    });

    test("the confirmed values beat a later AI extraction: the customer's contradiction is recorded, never applied", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      await groupSays(`!confirm ${codeIn(reply(await teach(o, "the address is Gros Islet")), "C")}`);
      script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: draft({ delivery_address: "Rodney Bay" }), order_target: o.ref_code, summary: "address" });
      await customerSays(JANE, "actually deliver to Rodney Bay");
      const after = await orderById(o.id);
      assert.equal(after.delivery_address, "Gros Islet", "the staff value is never overwritten");
      assert.equal(after.field_conflicts.delivery_address.proposed, "Rodney Bay");
      assert.equal(await customerBound(), 0);
    });
  });

  // ── Confirmation safety ────────────────────────────────────────────────────

  describe("confirmation safety", () => {
    const propose = async (o: Record<string, any>, answer: object = { delivery_address: "Gros Islet" }) => {
      correct = () => answer;
      return codeIn(reply(await teach(o, "the address is Gros Islet")), "C");
    };

    test("!discard drops it: nothing changes and the code can no longer be confirmed", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      assert.match(reply(await groupSays(`!discard ${code}`)), /discarded\. Nothing changed/);
      assert.match(reply(await groupSays(`!confirm ${code}`)), /was already discarded/);
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
      assert.equal((await proposals())[0].status, "discarded");
    });

    test("an unauthorized sender can neither propose nor confirm", async () => {
      const o = await makeOrder(JANE);
      const stranger = await teach(o, "the address is Gros Islet", { sender: STRANGER });
      assert.match(reply(stranger), /Only authorized staff/);
      assert.equal(correctionCalls.length, 0);
      const code = await propose(o);
      assert.match(reply(await groupSays(`!confirm ${code}`, { sender: STRANGER })), /Only authorized staff/);
      assert.match(reply(await groupSays(`!discard ${code}`, { sender: STRANGER })), /Only authorized staff/);
      assert.match(reply(await groupSays(`!confirm ${code}`, { sender: null })), /Only authorized staff/);
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
      assert.equal((await proposals())[0].status, "pending");
      assert.ok((await auditCount("orders.command_rejected")) >= 3);
    });

    test("business isolation: another business can neither see, confirm nor discard a code, nor correct this business's order", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      const seaConfirm = await groupSays(`!confirm ${code}`, { group: SEA_GROUP, biz: "by_sea" });
      assert.match(reply(seaConfirm), /No open proposal C-[A-Z0-9]{5} in this business/);
      assert.match(reply(await groupSays(`!discard ${code}`, { group: SEA_GROUP, biz: "by_sea" })), /No open proposal/);
      assert.match(reply(await groupSays(`!order ${ref(o)} teach the address is Gros Islet`, { group: SEA_GROUP, biz: "by_sea" })), /No order .* found/);
      assert.equal((await proposals())[0].status, "pending");
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
      // The same code in this business's own group still works.
      await groupSays(`!confirm ${code}`);
      assert.equal((await orderById(o.id)).delivery_address, "Gros Islet");
    });

    test("a proposal made in one group cannot be confirmed from another", async () => {
      await configure({ orders_group_jid: OTHER_GROUP });
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      const code = codeIn(reply(await teach(o, "the address is Gros Islet", { group: OTHER_GROUP })), "C");
      const wrong = await groupSays(`!confirm ${code}`, { group: GROUP });
      assert.doesNotMatch(reply(wrong), /corrected/);
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
      await groupSays(`!confirm ${code}`, { group: OTHER_GROUP });
      assert.equal((await orderById(o.id)).delivery_address, "Gros Islet");
    });

    test("stale: any change to the order after the preview voids the proposal", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      await groupSays(`!update ${ref(o)} 3 bags`); // a staff command bumps the order's version
      assert.match(reply(await groupSays(`!confirm ${code}`)), /changed since .* was proposed — nothing applied/);
      const after = await orderById(o.id);
      assert.deepEqual([after.delivery_address, after.items[0].quantity], ["Cap Estate", "3"]);
      assert.equal((await proposals())[0].status, "stale");
      assert.match(reply(await groupSays(`!confirm ${code}`)), /changed since/, "and it stays stale");
    });

    test("stale: the order being completed or cancelled meanwhile voids it too", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      await groupSays(`!order ${ref(o)} completed`);
      assert.match(reply(await groupSays(`!confirm ${code}`)), /changed since/);
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
    });

    test("expiry: a proposal can never be confirmed after its time", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      const [p] = await proposals();
      assert.ok(Date.parse(p.expires_at) - Date.parse(p.created_at) <= 30 * 60_000 + 1_000);
      await pg.run(`update public.ai_agent_order_proposals set expires_at = now() - interval '1 minute' where id = ${lit(p.id)};`);
      assert.match(reply(await groupSays(`!confirm ${code}`)), /expired, so nothing was applied/);
      assert.equal((await orderById(o.id)).delivery_address, "Cap Estate");
      assert.equal((await proposals())[0].status, "expired");
    });

    test("duplicate WhatsApp messages: one proposal, one model call, one application", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      const first = await teach(o, "the address is Gros Islet", { id: "DUP-TEACH" });
      const again = await teach(o, "the address is Gros Islet", { id: "DUP-TEACH" });
      assert.equal(await count("select 1 from public.ai_agent_order_proposals"), 1);
      assert.equal(correctionCalls.length, 1, "the model is not asked twice for the same message");
      assert.equal(await count(`select 1 from public.ai_agent_outbox where dedupe_key like 'ordercorr:%:DUP-TEACH:preview'`), 1, "and the group sees one preview");
      assert.ok(reply(again) === "" || reply(again).includes(codeIn(reply(first), "C")));
      const code = codeIn(reply(first), "C");
      await groupSays(`!confirm ${code}`, { id: "DUP-CONFIRM" });
      await groupSays(`!confirm ${code}`, { id: "DUP-CONFIRM" });
      const second = await groupSays(`!confirm ${code}`, { id: "OTHER-CONFIRM" });
      assert.match(reply(second), /already applied/);
      assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_edit").length, 1);
      assert.equal((await orderById(o.id)).version, o.version + 1);
      assert.equal(await auditCount("orders.teach_applied"), 1);
      assert.equal(await count("select 1 from public.ai_agent_order_feedback"), 1);
    });

    test("two racing confirmations apply it once", async () => {
      const o = await makeOrder(JANE);
      const code = await propose(o);
      await Promise.all([groupSays(`!confirm ${code}`, { id: "RACE-1" }), groupSays(`!confirm ${code}`, { id: "RACE-2" })]);
      assert.equal((await orderEvents(o.id)).filter((e) => e.kind === "staff_whatsapp_edit").length, 1);
      assert.equal((await orderById(o.id)).delivery_address, "Gros Islet");
      assert.equal((await proposals())[0].status, "applied");
    });

    test("codes of the knowledge flow are not ours: an unknown K- code never reaches an order", async () => {
      const o = await makeOrder(JANE);
      await propose(o);
      const res = await groupSays("!confirm K-7QX2");
      assert.doesNotMatch(reply(res), /proposal|corrected/);
      assert.equal((await proposals())[0].status, "pending");
    });

    test("Observe mode (cannot post in the group) refuses before anything is asked or stored", async () => {
      await configure({ mode: "observe", staff_notices_enabled: false });
      const o = await makeOrder(JANE);
      const res = await teach(o, "the address is Gros Islet");
      assert.equal(correctionCalls.length, 0);
      assert.deepEqual(await proposals(), []);
      assert.equal(res.outbox.length, 0, "Observe posts no group replies");
    });
  });

  // ── Reusable learning ──────────────────────────────────────────────────────

  describe("reusable learning", () => {
    test("an approved correction is recorded as feedback only: no customer memory, saved location or knowledge changes", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ customer_name: "Jason", fulfilment_method: "collection", requested_for: "morning", delivery_address: "Gros Islet" });
      const code = codeIn(reply(await teach(o, "Jason is collecting in the morning, address Gros Islet")), "C");
      await groupSays(`!confirm ${code}`);
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0, "no saved location or note");
      assert.equal(await count("select 1 from public.ai_agent_customer_memory"), 0, "no customer preference");
      assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0, "no business knowledge");
      assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 0, "no pending suggestion either");
      const [fb] = await rows<Record<string, any>>("select * from public.ai_agent_order_feedback");
      assert.deepEqual([fb.business_slug, fb.order_id, fb.created_by], ["dog_food", o.id, "17585550001"]);
      assert.deepEqual([...fb.fields].sort(), ["customer_name", "delivery_address", "fulfilment_method", "requested_for"]);
      assert.equal(fb.before.delivery_address, "Cap Estate");
      assert.equal(fb.after.delivery_address, "Gros Islet");
      assert.match(fb.instruction, /collecting in the morning/);
    });

    test("only when staff's words generalise is a reusable fact even offered, and then only as a command to run themselves", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ fulfilment_method: "collection", requested_for: "morning", reusable: [{ scope: "customer", text: "Jason always collects in the morning" }, { scope: "business", text: "Everything is collected in the morning" }] });
      const oneOff = reply(await groupSays(`!confirm ${codeIn(reply(await teach(o, "Jason collects in the morning")), "C")}`));
      assert.doesNotMatch(oneOff, /!remember|!teach|Reusable/, "one order's wording is not a rule");

      const o2 = await makeOrder(customer(2));
      correct = () => ({ fulfilment_method: "collection", requested_for: "morning", reusable: [{ scope: "customer", text: "Jason always collects in the morning" }] });
      const general = reply(await groupSays(`!confirm ${codeIn(reply(await teach(o2, "Jason always collects in the morning")), "C")}`));
      assert.match(general, /Nothing is saved from this/);
      assert.match(general, new RegExp(`!remember ${ref(o2)} Jason always collects in the morning`));
      assert.equal(await count("select 1 from public.ai_agent_customer_staff_memory"), 0, "offering is not saving");
      assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0);
    });

    test("an explicit !remember on the order's customer reuses the existing reviewed-memory flow (proposed, then confirmed by staff)", async () => {
      await configure({ customer_memory_enabled: true });
      const o = await makeOrder(JANE);
      const res = await groupSays(`!remember ${ref(o)} Jason always collects in the morning`);
      assert.match(reply(res), /M-[A-HJ-NP-Z2-9]{5}/);
      const [note] = await rows<Record<string, any>>("select * from public.ai_agent_customer_staff_memory");
      assert.deepEqual([note.kind, note.status], ["note", "proposed"]);
    });

    test("feedback accumulates only per approved correction, and earlier approved corrections steer later interpretations", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      const code = codeIn(reply(await teach(o, "the address is Gros Islet")), "C");
      assert.equal(await count("select 1 from public.ai_agent_order_feedback"), 0, "a proposal alone is not feedback");
      await groupSays(`!confirm ${code}`);
      correct = () => ({ delivery_address: "Rodney Bay" });
      await groupSays(`!discard ${codeIn(reply(await teach(o, "the address is Rodney Bay")), "C")}`);
      assert.equal(await count("select 1 from public.ai_agent_order_feedback"), 1, "a discarded proposal is not feedback either");
      assert.deepEqual(correctionCalls.at(-1)!.recentCorrections, [{ instruction: "the address is Gros Islet", fields: ["delivery_address"] }]);
    });

    test("forgetting a customer's orders erases the staff wording kept about them", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ delivery_address: "Gros Islet" });
      await groupSays(`!confirm ${codeIn(reply(await teach(o, "the address is Gros Islet")), "C")}`);
      await pg.run(`delete from public.ai_agent_orders where id = ${lit(o.id)};`);
      assert.equal(await count("select 1 from public.ai_agent_order_proposals"), 0);
      assert.equal(await count("select 1 from public.ai_agent_order_feedback"), 0);
    });
  });

  // ── Bulk completion ────────────────────────────────────────────────────────

  describe("!orders complete all", () => {
    /** Two orders for today, one each for tomorrow, an overdue day and no readable day, one already completed. */
    async function seed() {
      const make = (i: number) => makeOrder(customer(10 + i));
      const o = { a: await make(1), b: await make(2), tomorrow: await make(3), overdue: await make(4), undated: await make(5), done: await make(6) };
      await setDay(o.a, 0);
      await setDay(o.b, 0);
      await setDay(o.tomorrow, 1);
      await setDay(o.overdue, -2);
      await pg.run(`update public.ai_agent_orders set requested_for = 'sometime next week', first_message_at = now() where id = ${lit(o.undated.id)};`);
      await setDay(o.done, 0, ", status = 'fulfilled', fulfilled_at = now()");
      return o;
    }

    test("previews exactly today's outstanding orders, changes nothing, and explains what completed means", async () => {
      const o = await seed();
      const res = await groupSays("!orders complete all");
      const text = reply(res);
      assert.match(text, /Complete all of today's outstanding orders/);
      assert.match(text, /2 orders will be marked \*completed \(fulfilled\)\*/);
      assert.ok(text.includes(ref(o.a)) && text.includes(ref(o.b)));
      for (const other of [o.tomorrow, o.overdue, o.undated, o.done]) assert.ok(!text.includes(ref(other)), `${ref(other)} is not in today's list`);
      assert.match(text, /Left alone: 1 tomorrow, 1 overdue, 1 no clear day/);
      assert.match(text, /fulfilled — delivered or collected — not just hidden/);
      assert.match(text, /NOT messaged/);
      const code = codeIn(text, "B");
      assert.match(text, new RegExp(`!confirm ${code}`));
      const statuses = (await allOrders()).map((x) => x.status);
      assert.equal(statuses.filter((s) => s === "fulfilled").length, 1, "only the one that was already done");
      assert.equal((await proposals("bulk_complete"))[0].status, "pending");
      assert.equal(await customerBound(), 0);
    });

    test("!confirm completes exactly those orders, with an event and an audit entry per order, and tells nobody else", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      const done = reply(await groupSays(`!confirm ${code}`));
      assert.match(done, /Completed: 2/);
      assert.match(done, /Completed = fulfilled/);
      const by = Object.fromEntries(await Promise.all((Object.entries(o) as [string, Record<string, any>][]).map(async ([k, v]) => [k, await orderById(v.id)])));
      assert.equal(by.a.status, "fulfilled");
      assert.equal(by.b.status, "fulfilled");
      assert.ok(by.a.fulfilled_at);
      for (const k of ["tomorrow", "overdue", "undated"] as const) assert.notEqual(by[k].status, "fulfilled", `${k} is untouched`);
      for (const k of ["tomorrow", "overdue", "undated"] as const) assert.equal(by[k].version, o[k].version, `${k} was not even written`);
      for (const k of ["a", "b"] as const) {
        const e = (await orderEvents(o[k].id)).at(-1)!;
        assert.deepEqual([e.kind, e.actor_id, e.changes.status.after, e.changes.completion_batch.after.code], ["staff_whatsapp_fulfil", "17585550001", "fulfilled", code]);
      }
      assert.equal(await auditCount("order.fulfil"), 2, "one audit entry per order");
      assert.equal(await auditCount("orders.bulk_complete_applied"), 1);
      assert.equal((await proposals("bulk_complete"))[0].status, "applied");
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
      // Completed orders leave the report.
      assert.doesNotMatch(reply(await groupSays("!orders today")), new RegExp(`${ref(o.a)}|${ref(o.b)}`));
    });

    test("idempotent: confirming again completes nothing twice", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      await groupSays(`!confirm ${code}`, { id: "BULK-1" });
      await groupSays(`!confirm ${code}`, { id: "BULK-1" });
      assert.match(reply(await groupSays(`!confirm ${code}`, { id: "BULK-2" })), /already applied/);
      assert.equal((await orderEvents(o.a.id)).filter((e) => e.kind === "staff_whatsapp_fulfil").length, 1);
      assert.equal(await auditCount("order.fulfil"), 2);
    });

    test("a duplicate !orders complete all message is one proposal; a new message replaces the pending one", async () => {
      await seed();
      await groupSays("!orders complete all", { id: "BULK-ASK" });
      await groupSays("!orders complete all", { id: "BULK-ASK" });
      assert.equal((await proposals("bulk_complete")).length, 1);
      const newer = codeIn(reply(await groupSays("!orders complete all", { id: "BULK-ASK-2" })), "B");
      const [first, second] = await proposals("bulk_complete");
      assert.deepEqual([first.status, second.status], ["superseded", "pending"]);
      assert.match(reply(await groupSays(`!confirm ${first.code}`)), /replaced by a newer/);
      assert.match(reply(await groupSays(`!confirm ${newer}`)), /Completed: 2/);
    });

    test("an order that changes after the preview is skipped and reported, not completed; the rest are", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      await groupSays(`!update ${ref(o.b)} 4 bags`);
      const done = reply(await groupSays(`!confirm ${code}`));
      assert.match(done, /Completed: 1/);
      assert.match(done, new RegExp(`Skipped: 1\\n• ${ref(o.b)} — changed after the preview`));
      assert.equal((await orderById(o.a.id)).status, "fulfilled");
      assert.notEqual((await orderById(o.b.id)).status, "fulfilled");
    });

    test("a cancelled-meanwhile order is skipped", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      await groupSays(`!update ${ref(o.a)} cancelled`);
      const done = reply(await groupSays(`!confirm ${code}`));
      assert.match(done, new RegExp(`${ref(o.a)} — now cancelled`));
      assert.equal((await orderById(o.a.id)).status, "cancelled");
    });

    test("partial failure: the failing order is reported, the others are completed, and a retry finishes only the failed one", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      await pg.run(`
        create or replace function public.boom() returns trigger language plpgsql as $$
        begin if new.id = ${lit(o.b.id)}::uuid and new.status = 'fulfilled' then raise exception 'disk on fire'; end if; return new; end $$;
        create trigger boom_t before update on public.ai_agent_orders for each row execute function public.boom();`);
      const first = reply(await groupSays(`!confirm ${code}`));
      assert.match(first, /⚠️ \*Bulk completion/);
      assert.match(first, /Completed: 1/);
      assert.match(first, new RegExp(`Failed: 1\\n• ${ref(o.b)} — `));
      assert.match(first, new RegExp(`!confirm ${code} again retries only the failed ones`));
      assert.equal((await orderById(o.a.id)).status, "fulfilled");
      assert.notEqual((await orderById(o.b.id)).status, "fulfilled");
      assert.equal((await proposals("bulk_complete"))[0].status, "partial");

      await pg.run("drop trigger boom_t on public.ai_agent_orders;");
      const retry = reply(await groupSays(`!confirm ${code}`));
      assert.match(retry, /Completed: 2/, "the order done the first time stays counted; the failed one now succeeds");
      assert.equal((await orderById(o.b.id)).status, "fulfilled");
      assert.equal((await orderEvents(o.a.id)).filter((e) => e.kind === "staff_whatsapp_fulfil").length, 1, "the first order was not completed a second time");
      assert.equal((await proposals("bulk_complete"))[0].status, "applied");
    });

    test("!discard completes nothing; an expired token completes nothing; an unauthorized sender cannot confirm", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      assert.match(reply(await groupSays(`!confirm ${code}`, { sender: STRANGER })), /Only authorized staff/);
      assert.equal((await orderById(o.a.id)).status, awaiting(o.a));
      assert.match(reply(await groupSays(`!discard ${code}`)), /No order was completed/);
      assert.equal((await orderById(o.a.id)).status, awaiting(o.a));

      const code2 = codeIn(reply(await groupSays("!orders complete all")), "B");
      await pg.run("update public.ai_agent_order_proposals set expires_at = now() - interval '1 minute' where status = 'pending';");
      assert.match(reply(await groupSays(`!confirm ${code2}`)), /expired, so no order was completed/);
      assert.equal((await orderById(o.a.id)).status, awaiting(o.a));
    });

    test("business isolation: another business's orders are never in scope and its token is unknown here", async () => {
      const o = await seed();
      const code = codeIn(reply(await groupSays("!orders complete all")), "B");
      assert.match(reply(await groupSays("!orders complete all", { group: SEA_GROUP, biz: "by_sea" })), /Nothing outstanding for today/);
      assert.match(reply(await groupSays(`!confirm ${code}`, { group: SEA_GROUP, biz: "by_sea" })), /No open proposal/);
      assert.equal((await orderById(o.a.id)).status, awaiting(o.a));
    });

    test("nothing outstanding today: says so and stores no proposal", async () => {
      const o = await makeOrder(JANE);
      await setDay(o, 1);
      assert.match(reply(await groupSays("!orders complete all")), /Nothing outstanding for today[\s\S]*1 other open order left alone/);
      assert.deepEqual(await proposals(), []);
    });

    test("the St Lucia midnight decides today: the same order is in scope at 23:59 and out of scope (overdue) at 00:01", async () => {
      const o = await makeOrder(JANE);
      await pg.run(`update public.ai_agent_orders set requested_for = 'Wed 28 Oct (test)' where id = ${lit(o.id)};`);
      const settings = await settingsOf();
      const at = (iso: string, id: string) =>
        corrections.handleCorrectionCommand({
          settings, fromGroup: GROUP, command: { kind: "bulk_complete" }, senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF,
          eventId: "00000000-0000-4000-8000-000000000002", whatsappMessageId: id, timestamp: null, now: new Date(iso),
        });
      const evening = reply(await at("2026-10-29T03:59:00.000Z", "MID-1")); // 23:59 Wed 28 Oct
      assert.match(evening, /Complete all of today's outstanding orders — Wed 28 Oct/);
      assert.match(evening, /1 order will be marked/);
      const night = reply(await at("2026-10-29T04:01:00.000Z", "MID-2")); // 00:01 Thu 29 Oct
      assert.match(night, /Nothing outstanding for today \(Thu 29 Oct\)[\s\S]*1 other open order left alone/);
      // A preview confirmed after midnight still only touches what it listed (same day, same version), never "whatever is today now".
      const code = codeIn(evening, "B");
      const confirm = await corrections.handleCorrectionCommand({
        settings, fromGroup: GROUP, command: { kind: "proposal", action: "confirm", code, proposalKind: "bulk_complete" }, senderAuth: { authorized: true, senderId: "17585550001" }, senderJid: STAFF,
        eventId: "00000000-0000-4000-8000-000000000003", whatsappMessageId: "MID-3", timestamp: null, now: new Date("2026-10-29T04:02:00.000Z"),
      });
      assert.match(reply(confirm), /Completed: 1/);
    });
  });

  // ── Approval Pilot and the existing commands ───────────────────────────────

  describe("existing commands are unaffected", () => {
    test("in Approval Pilot, the established order commands behave exactly as before", async () => {
      const o = await makeOrder(JANE);
      assert.match(reply(await groupSays("!orders all")), /ALL OUTSTANDING ORDERS/);
      assert.match(reply(await groupSays(`!order ${ref(o)}`)), /Status:/);
      assert.match(reply(await groupSays("!order Jane")), /active order|No active order/);
      assert.match(reply(await groupSays(`!update ${ref(o)} 2 bags`)), /quantity 1 → 2/);
      assert.match(reply(await groupSays(`!update ${ref(o)} confirmed`)), /confirmed \(internal staff confirmation\)/);
      assert.match(reply(await groupSays(`!order ${ref(o)} completed`)), /completed\. It no longer shows in !orders/);
      assert.match(reply(await groupSays(`!order ${ref(o)} reopen`)), /reopened/);
      assert.match(reply(await groupSays("!orders sideways")), /!orders shows what is outstanding/);
      assert.equal(correctionCalls.length, 0);
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
    });

    test("!rules lists the new commands", async () => {
      const text = reply(await groupSays("!rules"));
      assert.match(text, /#REF teach <instruction>/);
      assert.match(text, /!orders complete all/);
    });

    test("the help for a half-typed command names the workflow", async () => {
      assert.match(reply(await groupSays("!orders complete")), /complete all — mark today's outstanding orders/);
      assert.match(reply(await groupSays("!order")), /!confirm C-CODE/);
    });

    test("nothing in any of these flows ever addresses a customer", async () => {
      const o = await makeOrder(JANE);
      correct = () => ({ customer_name: "Jason", delivery_address: "Gros Islet" });
      const code = codeIn(reply(await teach(o, "Jason, address Gros Islet")), "C");
      await groupSays(`!confirm ${code}`);
      await setDay(o, 0);
      await groupSays(`!confirm ${codeIn(reply(await groupSays("!orders complete all")), "B")}`);
      assert.equal(await customerBound(), 0);
      assert.equal(await notToAGroup(), 0);
      assert.equal(await count("select 1 from public.ai_agent_outbox where kind = 'customer_reply' or to_jid = " + lit(JANE.chat)), 0);
    });
  });
});

const awaiting = (o: Record<string, any>) => o.status;
