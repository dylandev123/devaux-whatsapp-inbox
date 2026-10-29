// Rules & Routing and the missed-call rule, end to end: the app's REAL server code against the REAL migrations in a throwaway
// Postgres. Only the language model is replaced by a scripted stand-in. Skips itself when no Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const STAFF_GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const ORDERS_GROUP = "120363000000000003@g.us";
const COMPLAINTS = "120363000000000011@g.us";
const URGENT = "120363000000000012@g.us";
const APPROVALS = "120363000000000013@g.us";
const ELSEWHERE = "120363000000000099@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";
const JANE = { chat: "17582867466@s.whatsapp.net", phone: "17582867466" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102" };

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let calls: typeof import("../lib/server/aiAgent/missedCalls.ts");
let outboxMod: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;

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

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = STAFF_GROUP) {
  const settings = {
    enabled: true, mode: "approval_pilot", contact_scope: "all", staff_group_jid: group, staff_notices_enabled: true,
    customer_memory_enabled: false, batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"], orders_tracking_enabled: false, orders_summary_enabled: false, orders_group_jid: null,
    missed_call_enabled: false, ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}
const route = (rules: Record<string, { enabled: boolean; group_jid: string }>, biz = "dog_food") =>
  pg.run(`update public.ai_agent_settings set routing_rules = ${lit(JSON.stringify(rules))}::jsonb where business_slug = ${lit(biz)};`);
const ALL_ROUTES = {
  complaints: { enabled: true, group_jid: COMPLAINTS },
  urgent: { enabled: true, group_jid: URGENT },
  approvals: { enabled: true, group_jid: APPROVALS },
};

async function customerSays(c: typeof JANE, text: string, opts: { biz?: string; id?: string } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: opts.id ?? `CUST-${++seq}`, chatId: c.chat, contactNumber: c.phone, fromMe: false,
    text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: new Date().toISOString(),
  });
}
async function groupSays(text: string, opts: { group?: string; sender?: string | null; biz?: string; quoted?: string | null } = {}) {
  return decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: `GRP-${++seq}`, chatId: opts.group ?? STAFF_GROUP, contactNumber: null, fromMe: false,
    text, hasMedia: false, quotedMessageId: opts.quoted ?? null, senderJid: opts.sender === undefined ? STAFF : opts.sender, senderPhone: null,
    timestamp: new Date().toISOString(),
  });
}
const notices = (biz = "dog_food") =>
  rows<{ id: string; to_jid: string; escalation_id: string; status: string }>(`select id, to_jid, escalation_id, status from public.ai_agent_outbox where kind = 'staff_notice' and business_slug = ${lit(biz)} order by created_at, id`);
const customerBound = () => rows<{ kind: string; to_jid: string; body: string }>(`select kind, to_jid, body from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay') order by created_at`);

const REFUND = "I want a refund, the bag I bought was damaged and the food is bad";
const HEALTH = "My dog has been vomiting since eating your food and the vet says it was the food";
const PLAIN = "Do you have the 15kg bag in stock this week?";

describe("Rules & Routing and the missed-call rule (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    calls = await import("../lib/server/aiAgent/missedCalls.ts");
    outboxMod = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async () => ({ proposal: script(), model: "scripted", error: null }));
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_lists, public.ai_agent_call_events, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_customer_staff_memory, public.ai_agent_audit_log, public.ai_agent_conversations,
        public.ai_agent_contact_rules, public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages,
        public.ai_agent_pilot_drafts, public.ai_agent_shadow_results, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false, orders_tracking_enabled = false,
        orders_summary_enabled = false, orders_group_jid = null, routing_rules = '{}'::jsonb, missed_call_enabled = false,
        missed_call_cooldown_minutes = 60, missed_call_message = default;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    script = () => proposal();
  });

  // ── Routing ────────────────────────────────────────────────────────────────

  describe("routing notices to groups", () => {
    test("with no rules every notice goes to the staff group, exactly as before", async () => {
      await customerSays(JANE, REFUND);
      await customerSays(MARCUS, PLAIN);
      const n = await notices();
      assert.equal(n.length, 2);
      assert.ok(n.every((x) => x.to_jid === STAFF_GROUP));
    });

    test("complaints, urgent and approval notices each go to their own group, once, and not also to the staff group", async () => {
      await route(ALL_ROUTES);
      await customerSays(JANE, REFUND);
      await customerSays(MARCUS, HEALTH);
      await customerSays({ chat: "17585550103@s.whatsapp.net", phone: "17585550103" }, PLAIN);
      const n = await notices();
      assert.deepEqual(n.map((x) => x.to_jid).sort(), [APPROVALS, COMPLAINTS, URGENT].sort());
      assert.equal(new Set(n.map((x) => x.escalation_id)).size, 3, "one notice per escalation");
      assert.equal(n.filter((x) => x.to_jid === STAFF_GROUP).length, 0, "nothing is duplicated into the fallback");
      const byEscalation = await rows<{ priority: string; to_jid: string }>(`select e.priority, o.to_jid from public.ai_agent_outbox o join public.ai_agent_escalations e on e.id = o.escalation_id`);
      assert.equal(byEscalation.find((r) => r.to_jid === URGENT)!.priority, "urgent");
    });

    test("a redelivered customer message posts no second notice", async () => {
      await route(ALL_ROUTES);
      await customerSays(JANE, REFUND, { id: "SAME-1" });
      await customerSays(JANE, REFUND, { id: "SAME-1" });
      assert.equal((await notices()).length, 1);
    });

    test("a disabled rule, or a category with no rule, falls back to the staff group", async () => {
      await route({ complaints: { enabled: false, group_jid: COMPLAINTS }, urgent: { enabled: true, group_jid: URGENT } });
      await customerSays(JANE, REFUND);
      await customerSays(MARCUS, PLAIN);
      const n = await notices();
      assert.deepEqual(n.map((x) => x.to_jid), [STAFF_GROUP, STAFF_GROUP]);
    });

    test("in Assisted mode an unclassified escalation is the fallback's; approvals only claim Approval Pilot notices", async () => {
      await configure({ mode: "assisted" });
      await route(ALL_ROUTES);
      await customerSays(MARCUS, PLAIN);
      assert.deepEqual((await notices()).map((x) => x.to_jid), [STAFF_GROUP]);
    });

    test("with no staff group rules wait: nothing is routed anywhere", async () => {
      await configure({}, "dog_food", null);
      await route(ALL_ROUTES);
      await customerSays(JANE, REFUND);
      assert.equal((await notices()).length, 0);
    });

    test("Observe mode routes notices to a routed group only when notices are on, and never anything to a customer", async () => {
      await configure({ mode: "observe", staff_notices_enabled: true });
      await route(ALL_ROUTES);
      await customerSays(JANE, REFUND);
      assert.deepEqual((await notices()).map((x) => x.to_jid), [COMPLAINTS]);
      await configure({ mode: "observe", staff_notices_enabled: false });
      await customerSays(MARCUS, REFUND);
      assert.equal((await notices()).length, 1, "notices off: no new notice");
      assert.equal((await customerBound()).length, 0);
    });

    test("business isolation: one business's rules never route another business's notices", async () => {
      await route(ALL_ROUTES, "dog_food");
      await customerSays(JANE, REFUND, { biz: "by_sea" });
      const sea = await notices("by_sea");
      assert.deepEqual(sea.map((x) => x.to_jid), [SEA_GROUP]);
      assert.equal((await notices("dog_food")).length, 0);
    });
  });

  describe("who may act in a routed group", () => {
    async function escalated() {
      await route(ALL_ROUTES);
      await customerSays(JANE, REFUND);
      const [e] = await rows<{ ref_code: string }>("select ref_code from public.ai_agent_escalations");
      return e.ref_code;
    }

    test("an authorized sender's explicit answer in a routed group is honoured; the reply stays in that group", async () => {
      const refCode = await escalated();
      const res = await groupSays(`!send #${refCode} We are sorry, we will refund you.`, { group: COMPLAINTS });
      const bound = await customerBound();
      assert.equal(bound.filter((b) => b.kind === "staff_relay" && b.to_jid === JANE.chat).length, 1, "the approved answer reaches the customer");
      assert.ok(res.outbox.every((o) => o.to === COMPLAINTS || o.to === JANE.chat), "feedback goes back to the group written in, not to the staff group");
      assert.equal(await count(`select 1 from public.ai_agent_outbox where to_jid = ${lit(STAFF_GROUP)}`), 0);
    });

    test("an unauthorized sender in a routed group can send nothing to a customer", async () => {
      const refCode = await escalated();
      await groupSays(`!send #${refCode} Free dog food for life!`, { group: COMPLAINTS, sender: STRANGER });
      await groupSays(`!send #${refCode} Free dog food for life!`, { group: COMPLAINTS, sender: null });
      assert.equal((await customerBound()).length, 0);
    });

    test("a group no rule names is not a staff group: nothing is sent, nothing is posted", async () => {
      const refCode = await escalated();
      const res = await groupSays(`!send #${refCode} Hello`, { group: ELSEWHERE });
      assert.equal((await customerBound()).length, 0);
      assert.equal(res.outbox.length, 0);
    });

    test("a disabled rule's group stops being a staff group", async () => {
      const refCode = await escalated();
      await route({ ...ALL_ROUTES, complaints: { enabled: false, group_jid: COMPLAINTS } });
      await groupSays(`!send #${refCode} Hello`, { group: COMPLAINTS });
      assert.equal((await customerBound()).length, 0);
    });

    test("another business cannot use this business's routed group", async () => {
      const refCode = await escalated();
      await groupSays(`!send #${refCode} Hello`, { group: COMPLAINTS, biz: "by_sea" });
      assert.equal((await customerBound()).length, 0);
    });

    test("order commands are refused in a routed group and change nothing", async () => {
      await configure({ orders_summary_enabled: true });
      await route(ALL_ROUTES);
      const res = await groupSays("!orders all", { group: URGENT });
      assert.match(res.outbox.map((o) => o.body).join("\n"), /Order commands are used in the Orders group/);
      const done = await groupSays("!order 1 completed", { group: URGENT });
      assert.doesNotMatch(done.outbox.map((o) => o.body).join("\n"), /completed\./);
    });

    test("the orders group still takes order commands only, and a routed group cannot be the orders group", async () => {
      await configure({ orders_group_jid: ORDERS_GROUP, orders_summary_enabled: true });
      await route(ALL_ROUTES);
      const refCode = await (async () => {
        await customerSays(JANE, REFUND);
        return (await rows<{ ref_code: string }>("select ref_code from public.ai_agent_escalations"))[0].ref_code;
      })();
      await groupSays(`!send #${refCode} Hello`, { group: ORDERS_GROUP });
      assert.equal((await customerBound()).length, 0, "the orders group never answers customers");
    });
  });

  describe("the bridge", () => {
    test("the config tells the bridge which routed groups to forward, only for enabled rules, and never the staff group", async () => {
      process.env.AI_AGENT_BRIDGE_SECRET = "test-secret";
      const configRoute = await import("../app/api/bridge/ai-agent/config/route.ts");
      await route({ ...ALL_ROUTES, approvals: { enabled: false, group_jid: APPROVALS }, urgent: { enabled: true, group_jid: STAFF_GROUP } });
      const res = await configRoute.GET(new Request("http://x/api/bridge/ai-agent/config", { headers: { "x-ai-agent-secret": "test-secret" } }));
      const body = (await res.json()) as { businesses: { businessSlug: string; routedGroupJids: string[]; missedCallsEnabled: boolean }[] };
      const dog = body.businesses.find((b) => b.businessSlug === "dog_food")!;
      assert.deepEqual(dog.routedGroupJids, [COMPLAINTS]);
      assert.equal(dog.missedCallsEnabled, false);
      assert.deepEqual(body.businesses.find((b) => b.businessSlug === "by_sea")!.routedGroupJids, []);
    });

    test("the outbox claim hands out a notice for a routed group only while its rule is on", async () => {
      await route({ complaints: { enabled: true, group_jid: COMPLAINTS } });
      const mk = async (key: string, to: string) =>
        pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key, status) values ('dog_food', ${lit(to)}, 'staff_notice', ${lit(to)}, 'x', ${lit(key)}, 'pending');`);
      await mk("t1", COMPLAINTS);
      await mk("t2", URGENT);
      const claimed = await outboxMod.claimOutbox("dog_food", 20);
      assert.deepEqual(claimed.map((c) => c.to), [COMPLAINTS]);
      await route({ complaints: { enabled: false, group_jid: COMPLAINTS } });
      await mk("t3", COMPLAINTS);
      assert.equal((await outboxMod.claimOutbox("dog_food", 20)).length, 0);
    });
  });

  // ── Missed calls ───────────────────────────────────────────────────────────

  describe("missed-call replies", () => {
    const CALLER = "17585550102@s.whatsapp.net";
    const report = (over: Record<string, unknown> = {}) => {
      const now = Date.now();
      return {
        callId: `CALL-${++seq}`, callerJid: CALLER, outgoing: false, isGroup: false, isVideo: false, offline: false, sawOffer: true,
        sawAccept: false, sawReject: false, finalStatus: "timeout" as const, offerAt: new Date(now - 20_000).toISOString(), endedAt: new Date(now - 1000).toISOString(), ...over,
      };
    };
    const call = (over: Record<string, unknown> = {}, biz = "dog_food") => calls.processCallReport(biz, report(over) as never);
    const replies = (biz = "dog_food") => rows<{ body: string; to_jid: string; status: string; kind: string }>(`select body, to_jid, status, kind from public.ai_agent_outbox where kind = 'missed_call_reply' and business_slug = ${lit(biz)}`);
    const events = (biz = "dog_food") => rows<{ decision: string; reason: string }>(`select decision, reason from public.ai_agent_call_events where business_slug = ${lit(biz)} order by created_at, id`);
    const on = (over: Record<string, SettingValue> = {}) => configure({ missed_call_enabled: true, mode: "assisted", ...over });

    test("off by default: a missed call is ignored and nothing at all is recorded or sent", async () => {
      await configure({ mode: "assisted" });
      const res = await call();
      assert.deepEqual([res.decision, res.reason, res.outbox.length], ["skipped", "disabled", 0]);
      assert.equal(await count("select 1 from public.ai_agent_call_events"), 0);
      assert.equal((await replies()).length, 0);
    });

    test("when the AI agent itself is off nothing is recorded or sent either", async () => {
      await on({ enabled: false });
      const res = await call();
      assert.equal(res.reason, "agent_off");
      assert.equal(await count("select 1 from public.ai_agent_call_events"), 0);
    });

    test("a reliably missed call gets the configured message once, as a dispatched missed_call_reply to the caller", async () => {
      await on();
      const res = await call();
      assert.deepEqual([res.status, res.decision], ["done", "replied"]);
      assert.equal(res.outbox.length, 1);
      assert.deepEqual([res.outbox[0].kind, res.outbox[0].to, res.outbox[0].send], ["missed_call_reply", CALLER, true]);
      assert.equal(res.outbox[0].body, "Thanks for reaching out! Sorry we missed your call. We're unable to answer at the moment, but how can we help you?");
      const [row] = await replies();
      assert.deepEqual([row.status, row.to_jid], ["dispatched", CALLER]);
      assert.deepEqual(await events(), [{ decision: "replied", reason: "replied" }]);
      assert.equal(await count("select 1 from public.ai_agent_audit_log where action = 'calls.missed_reply'"), 1);
    });

    test("a custom message is what is sent", async () => {
      await on();
      await pg.run(`update public.ai_agent_settings set missed_call_message = 'Sorry we missed you, text us here!' where business_slug = 'dog_food';`);
      assert.equal((await call()).outbox[0].body, "Sorry we missed you, text us here!");
    });

    test("the same call reported twice replies once", async () => {
      await on();
      const r = report();
      await calls.processCallReport("dog_food", r as never);
      const again = await calls.processCallReport("dog_food", r as never);
      assert.deepEqual([again.decision, again.reason], ["skipped", "duplicate"]);
      assert.equal((await replies()).length, 1);
    });

    test("a second missed call from the same caller inside the cooldown is not answered; after it, it is", async () => {
      await on();
      assert.equal((await call()).decision, "replied");
      const second = await call();
      assert.deepEqual([second.decision, second.reason], ["skipped", "cooldown"]);
      assert.equal((await replies()).length, 1);
      await pg.run(`update public.ai_agent_call_events set created_at = now() - interval '61 minutes';`);
      assert.equal((await call()).decision, "replied");
      assert.equal((await replies()).length, 2);
      // A longer cooldown is honoured.
      await pg.run(`update public.ai_agent_settings set missed_call_cooldown_minutes = 1440 where business_slug = 'dog_food';`);
      await pg.run(`update public.ai_agent_call_events set created_at = now() - interval '5 hours';`);
      assert.equal((await call()).reason, "cooldown");
    });

    test("simultaneous reports for one caller reply exactly once; different callers each get a reply", async () => {
      await on();
      const results = await Promise.all(Array.from({ length: 6 }, () => call()));
      assert.equal(results.filter((r) => r.decision === "replied").length, 1);
      assert.equal((await replies()).length, 1);
      const other = await call({ callerJid: "17585550333@s.whatsapp.net" });
      assert.equal(other.decision, "replied");
    });

    test("outgoing, group, answered, declined, hung-up and uncertain calls are never answered, and each is logged with its reason", async () => {
      await on();
      const cases: [Record<string, unknown>, string][] = [
        [{ outgoing: true }, "outgoing"],
        [{ isGroup: true }, "group_call"],
        [{ sawAccept: true }, "answered"],
        [{ finalStatus: "reject" }, "declined"],
        [{ finalStatus: "terminate" }, "uncertain_ended"],
        [{ offline: true }, "uncertain_offline"],
        [{ sawOffer: false }, "uncertain_no_offer"],
        [{ callerJid: "120363000000000001@g.us" }, "invalid_caller"],
        [{ endedAt: new Date(Date.now() - 3_600_000).toISOString(), offerAt: new Date(Date.now() - 3_700_000).toISOString() }, "stale"],
      ];
      for (const [over, reason] of cases) {
        const res = await call(over);
        assert.deepEqual([res.decision, res.reason, res.outbox.length], ["skipped", reason, 0], reason);
      }
      assert.equal((await replies()).length, 0);
      assert.deepEqual((await events()).map((e) => e.reason), cases.map(([, r]) => r));
      // None of them used up the caller's cooldown.
      assert.equal((await call()).decision, "replied");
    });

    test("Observe mode never writes to a customer; Approval Pilot and Assisted may (the rule is its own explicit opt-in)", async () => {
      await on({ mode: "observe" });
      assert.equal((await call()).reason, "mode_not_allowed");
      assert.equal((await replies()).length, 0);
      await on({ mode: "approval_pilot" });
      assert.equal((await call({ callerJid: "17585550444@s.whatsapp.net" })).decision, "replied");
    });

    test("an excluded contact, a contact outside the scope and a chat staff are handling get no reply", async () => {
      await on();
      await pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(CALLER)}, 'exclude');`);
      assert.equal((await call()).reason, "contact_excluded");
      await pg.run("truncate public.ai_agent_contact_rules;");
      await on({ contact_scope: "none" });
      assert.equal((await call()).reason, "contact_not_permitted");
      await on({ contact_scope: "selected" });
      assert.equal((await call()).reason, "contact_not_permitted");
      await pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(CALLER)}, 'allow');`);
      await pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, control, human_until) values ('dog_food', ${lit(CALLER)}, 'human', now() + interval '2 hours');`);
      assert.equal((await call()).reason, "human_active");
      await pg.run("truncate public.ai_agent_conversations;");
      assert.equal((await call()).decision, "replied");
    });

    test("an admin switching the rule off stops replies immediately", async () => {
      await on();
      assert.equal((await call()).decision, "replied");
      await pg.run(`update public.ai_agent_settings set missed_call_enabled = false where business_slug = 'dog_food';`);
      const res = await call({ callerJid: "17585550555@s.whatsapp.net" });
      assert.deepEqual([res.decision, res.reason], ["skipped", "disabled"]);
      assert.equal((await replies()).length, 1);
    });

    test("the hourly cap stops a flood", async () => {
      await on();
      for (let i = 0; i < 20; i += 1) {
        await pg.run(`insert into public.ai_agent_call_events (business_slug, call_id, caller_jid, decision, reason) values ('dog_food', ${lit(`OLD-${i}`)}, ${lit(`1758555${String(1000 + i)}@s.whatsapp.net`)}, 'replied', 'replied');`);
      }
      assert.equal((await call()).reason, "rate_limited");
    });

    test("business isolation: the rule, the cooldown and the log are per business", async () => {
      await on();
      await configure({ missed_call_enabled: false, mode: "assisted" }, "by_sea", SEA_GROUP);
      assert.equal((await call({}, "by_sea")).reason, "disabled", "by_sea has not turned it on");
      assert.equal((await call()).decision, "replied");
      await configure({ missed_call_enabled: true, mode: "assisted" }, "by_sea", SEA_GROUP);
      const sea = await call({}, "by_sea");
      assert.equal(sea.decision, "replied", "dog_food's cooldown for this caller does not apply to by_sea");
      assert.equal((await replies("by_sea")).length, 1);
      assert.equal((await replies("dog_food")).length, 1);
      assert.equal((await events("by_sea")).length, 1);
    });

    test("the claim hands out a pending missed-call reply only while the rule is on and the mode may write to customers", async () => {
      const mk = (key: string) =>
        pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key, status) values ('dog_food', ${lit(CALLER)}, 'missed_call_reply', ${lit(CALLER)}, 'x', ${lit(key)}, 'pending');`);
      await mk("m1");
      await configure({ mode: "approval_pilot", missed_call_enabled: false });
      assert.equal((await outboxMod.claimOutbox("dog_food", 10)).length, 0, "rule off");
      await configure({ mode: "observe", missed_call_enabled: true });
      assert.equal((await outboxMod.claimOutbox("dog_food", 10)).length, 0, "Observe");
      await configure({ mode: "approval_pilot", missed_call_enabled: true });
      assert.equal((await outboxMod.claimOutbox("dog_food", 10)).length, 1);
    });

    test("the call endpoint needs the bridge secret and rejects malformed reports", async () => {
      process.env.AI_AGENT_BRIDGE_SECRET = "test-secret";
      const callRoute = await import("../app/api/bridge/ai-agent/call/route.ts");
      const post = (body: unknown, secret: string | null) =>
        callRoute.POST(new Request("http://x/api/bridge/ai-agent/call", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-ai-agent-secret": secret } : {}) }, body: JSON.stringify(body) }));
      assert.equal((await post({ businessSlug: "dog_food", ...report() }, null)).status, 401);
      assert.equal((await post({ businessSlug: "dog_food", ...report() }, "wrong")).status, 401);
      assert.equal((await post({ businessSlug: "dog_food", callId: "" }, "test-secret")).status, 400);
      await on();
      const ok = await post({ businessSlug: "dog_food", ...report() }, "test-secret");
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { decision: string }).decision, "replied");
    });
  });
});
