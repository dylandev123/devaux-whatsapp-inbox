// Compact Approval Pilot notices, !moreinfo, one actionable approval per request, quiet non-actionable messages and the
// dashboard approval queue — the app's REAL server code against the REAL migrations in a throwaway Postgres
// (tests/helpers/pgHarness.ts). Only the language model is replaced by a scripted stand-in. Skips itself when no
// Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";
const ADMIN = "11111111-1111-1111-1111-111111111111";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let approvals: typeof import("../lib/server/aiAgent/approvals.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type ReplyInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE", intent: "other", reply: null, confidence: 0.2, knowledge_ids: [], escalation_reason: "needs staff", priority: null, summary: null, order_request: null, memory_facts: [], ...over,
});
const modelCalls: ReplyInput[] = [];
let script: (input: ReplyInput) => Proposal = () => proposal();

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true,
    mode: "approval_pilot",
    contact_scope: "all",
    staff_group_jid: group,
    staff_notices_enabled: false,
    customer_memory_enabled: false,
    batching_enabled: false,
    auto_takeover_minutes: 0,
    default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"],
    passive_learning_scope: "off",
    knowledge_confirm_via_whatsapp: false,
    orders_tracking_enabled: false,
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}
const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

async function addKnowledge(content = "The 15kg chicken dog food bag costs EC$90.") {
  return (await pg.run(`with i as (insert into public.ai_agent_knowledge (business_slug, kind, title, content, status) values ('dog_food', 'price', 'Price', ${lit(content)}, 'approved') returning id) select id from i;`)).trim();
}
async function ackAll(items: { id: string; send: boolean }[]) {
  for (const item of items) if (item.send) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
}
async function customerSays(c: Customer, text: string, opts: { biz?: string } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: `CUST-${++seq}`, chatId: c.chat, contactNumber: c.phone, fromMe: false, text, hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}
async function staffSays(text: string, opts: { quoted?: string | null; biz?: string; group?: string; sender?: string | null; ack?: boolean } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food", whatsappMessageId: `STAFF-${++seq}`, chatId: opts.group ?? GROUP, contactNumber: null, fromMe: false, text, hasMedia: false, quotedMessageId: opts.quoted ?? null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender, senderPhone: null, timestamp: new Date().toISOString(),
  });
  if (opts.ack !== false) await ackAll(result.outbox);
  return result;
}

const notices = (c?: Customer) =>
  rows<{ id: string; body: string; escalation_id: string; whatsapp_message_id: string | null }>(
    `select id, body, escalation_id, whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_notice' and business_slug = 'dog_food'${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at, id`
  );
const feedbacks = () => rows<{ body: string; escalation_id: string | null; whatsapp_message_id: string | null }>(`select body, escalation_id, whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at, id`);
const lastFeedback = async () => (await feedbacks()).at(-1)?.body ?? "";
const customerBound = () => rows<{ kind: string; body: string; status: string; to_jid: string }>(`select kind, body, status, to_jid from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay') order by created_at`);
const pilotDrafts = () => rows<Record<string, any>>(`select * from public.ai_agent_pilot_drafts order by escalation_id, version`);
const escalationRows = () => rows<Record<string, any>>(`select * from public.ai_agent_escalations order by created_at`);
const allOrders = () => rows<Record<string, any>>(`select * from public.ai_agent_orders order by created_at`);

/** The AI proposes `reply` for a question; the pilot notice is posted and acked. */
async function ask(c: Customer, question: string, opts: { ready?: boolean; reply?: string; order?: Draft | null; intent?: Proposal["intent"] } = {}) {
  const ready = opts.ready ?? true;
  const kid = ready ? await addKnowledge() : null;
  const reply = opts.reply ?? "The 15kg chicken dog food bag costs EC$90.";
  script = () => proposal({ decision: "REPLY", intent: opts.intent ?? "question", reply, confidence: 0.95, knowledge_ids: kid ? [kid] : [], escalation_reason: null, order_request: opts.order ?? null });
  const result = await customerSays(c, question);
  const [notice] = (await notices(c)).slice(-1);
  const escalation = (await escalationRows()).find((e) => e.id === notice.escalation_id)!;
  return { result, notice, noticeWaId: notice.whatsapp_message_id!, escalation, ref: escalation.ref_code as string };
}
const order = (items: [string, string][], extra: Partial<Draft> = {}): Draft => ({
  items: items.map(([product, quantity]) => ({ product, quantity })), delivery_address: null, delivery_preference: null, notes: null, ...extra,
});

describe("Compact approvals, !moreinfo and the dashboard queue (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    approvals = await import("../lib/server/aiAgent/approvals.ts");
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
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false, auto_takeover_minutes = 0,
        orders_tracking_enabled = false, orders_summary_enabled = false, passive_learning_scope = 'off', knowledge_confirm_via_whatsapp = false;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls.length = 0;
    script = () => proposal();
  });

  // ── !moreinfo ─────────────────────────────────────────────────────────────

  test("!moreinfo quoting the notice posts ONE separate detailed message from stored data, with no model call, no state change and nothing sent to the customer", async () => {
    await configure({ orders_tracking_enabled: true });
    await pg.run(`insert into public.customers (phone_number, first_name) values ('17585550101', 'Jane') on conflict do nothing;`).catch(() => undefined);
    const { noticeWaId, ref } = await ask(JANE, "I want 2 bags of Monello Chicken 15kg delivered Friday", {
      intent: "order", reply: "Sure! Which delivery address should we use?", order: order([["Monello Chicken 15kg", "2"]], { delivery_preference: "delivery Friday" }),
    });
    const before = { drafts: await pilotDrafts(), esc: await escalationRows(), orders: await allOrders(), calls: modelCalls.length, bound: await customerBound() };

    const res = await staffSays("!moreinfo", { quoted: noticeWaId, ack: false });
    const post = (await feedbacks()).at(-1)!;
    assert.equal(res.outbox.length, 1, "exactly one message, in the staff group");
    assert.equal(res.outbox[0].kind, "staff_feedback");
    assert.equal(res.outbox[0].to, GROUP);
    assert.match(post.body, new RegExp(`^ℹ️ #${ref} · `));
    assert.match(post.body, /\+17585550101/, "the verified phone");
    assert.match(post.body, /Customer said/);
    const [stored] = await pilotDrafts();
    assert.ok(post.body.includes(`AI draft v1 — customer-ready:\n“${stored.body}”`), "the exact draft, word for word");
    assert.match(post.body, /✅ Actionable: !approve would send the draft below/);
    assert.match(post.body, /Order details:/);
    assert.match(post.body, /2 × Monello Chicken 15kg/);
    assert.match(post.body, /Delivery/);
    assert.match(post.body, /Missing: delivery address/);
    assert.doesNotMatch(post.body, /The order is missing details/, "situation codes are not presented as risks");
    assert.match(post.body, /Read-only: nothing was changed or sent\./);
    assert.equal(post.escalation_id, before.esc[0].id, "linked to the request, so a later quote still resolves it");

    assert.equal(modelCalls.length, before.calls, "no model call");
    assert.deepEqual(await pilotDrafts(), before.drafts, "the draft is untouched");
    assert.deepEqual((await escalationRows()).map((e) => [e.status, e.updated_at, e.notified_seq]), before.esc.map((e) => [e.status, e.updated_at, e.notified_seq]), "the escalation is untouched");
    assert.deepEqual(await allOrders(), before.orders, "the order is untouched");
    assert.deepEqual(await customerBound(), before.bound, "nothing reached or was queued for the customer");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.moreinfo'`), 1);
  });

  test("!moreinfo #E-CODE works when quoting is unavailable, and a quote of the !moreinfo answer still resolves the request", async () => {
    const { ref, noticeWaId } = await ask(JANE, "How much is the 15kg bag?");
    const res = await staffSays(`!moreinfo #${ref}`, { ack: true });
    assert.equal(res.outbox.length, 1);
    assert.match(await lastFeedback(), new RegExp(`#${ref}`));
    // !approve quoting that answer approves the current draft (the answer is quotable, like any of our posts).
    const answer = (await rows<{ whatsapp_message_id: string }>(`select whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at desc limit 1`))[0];
    assert.ok(answer.whatsapp_message_id);
    const ok = await staffSays("!approve", { quoted: answer.whatsapp_message_id });
    assert.equal(ok.outbox.filter((o) => o.kind === "staff_relay" && o.send).length, 1);
    void noticeWaId;
  });

  test("!moreinfo needs an authorized sender: a stranger gets a refusal and sees nothing of the customer", async () => {
    const { noticeWaId } = await ask(JANE, "How much is the 15kg bag?");
    const res = await staffSays("!moreinfo", { quoted: noticeWaId, sender: STRANGER });
    const body = (await lastFeedback());
    assert.match(body, /!moreinfo shows customer details, so it is limited to the people who can approve replies/);
    assert.doesNotMatch(body, /17585550101|Customer said|AI draft/);
    assert.equal(res.outbox.length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.moreinfo_refused'`), 1);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.moreinfo'`), 0);
  });

  test("!moreinfo is limited to its own business: another business's group cannot read this request", async () => {
    const { noticeWaId, ref } = await ask(JANE, "How much is the 15kg bag?");
    const res = await staffSays("!moreinfo", { quoted: noticeWaId, biz: "by_sea", group: SEA_GROUP });
    for (const out of res.outbox) assert.match(out.body, /can't tell which request you mean/, "only the generic refusal: the request is not found in this business");
    const byCode = await staffSays(`!moreinfo #${ref}`, { biz: "by_sea", group: SEA_GROUP });
    assert.doesNotMatch(JSON.stringify(byCode.outbox), /17585550101|Customer said|AI draft/);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.moreinfo'`), 0, "nothing was read for the other business");
  });

  test("!moreinfo stays available for a stale draft and labels it clearly; the stale draft still cannot be approved", async () => {
    const { noticeWaId, ref } = await ask(JANE, "How much is the 15kg bag?");
    script = () => proposal();
    await customerSays(JANE, "Also, do you deliver to Gros Islet?");
    const res = await staffSays("!moreinfo", { quoted: noticeWaId });
    assert.equal(res.outbox.length, 1);
    const body = await lastFeedback();
    assert.match(body, /⚠️ STALE/);
    assert.match(body, /⛔ Not actionable/);
    assert.match(body, /AI draft v1/);
    assert.doesNotMatch(body, /✅ Actionable/);
    const refused = await staffSays("!approve", { quoted: noticeWaId });
    assert.equal(refused.outbox.filter((o) => o.kind === "staff_relay").length, 0);
    assert.equal((await customerBound()).length, 0);
    void ref;
  });

  test("!moreinfo spam is throttled: a repeat within the cooldown posts nothing, and it is audited", async () => {
    const { noticeWaId } = await ask(JANE, "How much is the 15kg bag?");
    const first = await staffSays("!moreinfo", { quoted: noticeWaId });
    const second = await staffSays("!moreinfo", { quoted: noticeWaId });
    const third = await staffSays("!moreinfo", { quoted: noticeWaId });
    assert.equal(first.outbox.length, 1);
    assert.deepEqual(second.outbox, []);
    assert.deepEqual(third.outbox, []);
    assert.equal((await feedbacks()).length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.moreinfo_throttled'`), 2);
    // After the cooldown it answers again.
    await pg.run(`update public.ai_agent_outbox set created_at = now() - interval '2 minutes' where dedupe_key like 'moreinfo:%';`);
    assert.equal((await staffSays("!moreinfo", { quoted: noticeWaId })).outbox.length, 1);
  });

  test("!moreinfo without a quote or code changes nothing and says so", async () => {
    await ask(JANE, "How much is the 15kg bag?");
    const res = await staffSays("!moreinfo");
    assert.match(await lastFeedback(), /can't tell which request you mean/);
    assert.equal(res.outbox.length, 1);
  });

  test("!moreinfo explains risk: unverified claims and knowledge gaps are listed in plain language", async () => {
    const { noticeWaId } = await ask(JANE, "How much is the bag?", { ready: false, reply: "It costs EC$99." });
    await staffSays("!moreinfo", { quoted: noticeWaId });
    const body = await lastFeedback();
    assert.match(body, /needs the facts confirmed/);
    assert.match(body, /Not in approved knowledge:\n• No approved knowledge backs this answer/);
    assert.match(body, /A price in the draft is not in approved knowledge/);
    assert.match(body, /!approve confirm would send/);
  });

  // ── Quiet, one approval per request, risky vs safe ────────────────────────

  test("acknowledgements create no approval request, but are still stored and counted", async () => {
    await customerSays(JANE, "thanks!");
    await customerSays(JANE, "ok great");
    assert.equal(modelCalls.length, 0, "no model call");
    assert.equal(await count(`select 1 from public.ai_agent_outbox`), 0, "no notice, no draft");
    assert.equal((await escalationRows()).length, 0);
    const ev = await rows<{ reason_codes: string[]; status: string }>(`select reason_codes, status from public.ai_agent_events order by created_at`);
    assert.equal(ev.length, 2);
    assert.ok(ev.every((e) => e.status === "done" && e.reason_codes.includes("trivial_acknowledgement")));
  });

  test("small talk with no question is quiet, but an order change, a cancellation, a complaint or a question is never silenced", async () => {
    script = () => proposal({ decision: "REPLY", intent: "smalltalk", reply: "You're welcome!", confidence: 0.9 });
    const quiet = await customerSays(JANE, "Perfect, you guys are the best, see you soon");
    assert.equal(quiet.decision, "NO_REPLY");
    assert.ok(quiet.reasons.includes("no_reply_needed"));
    assert.equal((await notices()).length, 0);

    for (const [who, text, intent, reply] of [
      [JANE, "Can you make it 3 bags instead?", "order", "Sure, 3 bags."],
      [MARCUS, "Please cancel my order", "order", "Sorry to hear that."],
    ] as const) {
      script = () => proposal({ decision: "REPLY", intent, reply, confidence: 0.9, order_request: intent === "order" ? order([["Monello", "3"]]) : null });
      await customerSays(who, text);
      assert.ok((await notices(who)).length >= 1, `${text} must reach staff`);
    }
    script = () => proposal({ decision: "REPLY", intent: "complaint", reply: "I'm sorry about that.", confidence: 0.9 });
    await customerSays({ chat: "17585550103@s.whatsapp.net", phone: "17585550103", name: "Rita" }, "The bag I got was damaged, I'm very unhappy");
    assert.equal((await notices({ chat: "17585550103@s.whatsapp.net", phone: "17585550103", name: "Rita" })).length, 1);
    script = () => proposal({ decision: "REPLY", intent: "smalltalk", reply: "Yes we do!", confidence: 0.9 });
    await customerSays({ chat: "17585550104@s.whatsapp.net", phone: "17585550104", name: "Tom" }, "Great thanks, do you deliver on Sundays?");
    assert.equal((await notices({ chat: "17585550104@s.whatsapp.net", phone: "17585550104", name: "Tom" })).length, 1, "an unanswered question is never silenced");
  });

  test("a quiet message in a chat with an order still updates the order", async () => {
    await configure({ orders_tracking_enabled: true });
    script = () => proposal({ decision: "ASK", intent: "order", reply: "Which address?", order_request: order([["Monello Chicken 15kg", "2"]], { delivery_preference: "delivery" }), summary: "order" });
    await customerSays(JANE, "2 Monello Chicken 15kg delivered please");
    assert.equal((await allOrders()).length, 1);
    assert.equal(modelCalls.length, 1);
  });

  test("rapid messages before staff act produce ONE notice for the batch; a later change produces ONE short replacement and only the newest draft can be approved", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 30, batch_max_wait_seconds: 120 });
    const kid = await addKnowledge();
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.95, knowledge_ids: [kid], escalation_reason: null });
    await customerSays(JANE, "hi");
    await customerSays(JANE, "how much is");
    await customerSays(JANE, "the 15kg chicken bag?");
    assert.equal((await notices()).length, 0, "nothing is posted per message");
    await pg.run(`update public.ai_agent_batches set due_at = now() - interval '1 second';`);
    await decide.processDueBatches();
    assert.equal(modelCalls.length, 1, "one model call for the whole turn");
    const first = await notices();
    assert.equal(first.length, 1, "one actionable notice for the request");
    assert.equal((await pilotDrafts()).length, 1);
    await pg.run(`update public.ai_agent_outbox set status = 'sent', whatsapp_message_id = 'WA-N1' where id = ${lit(first[0].id)};`);

    // The customer adds something that matters: one short replacement.
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "Yes, the 15kg chicken bag is EC$90, and delivery depends on your area.", confidence: 0.95, knowledge_ids: [kid], escalation_reason: null });
    await customerSays(JANE, "and do you deliver to Rodney Bay?");
    await pg.run(`update public.ai_agent_batches set due_at = now() - interval '1 second' where status = 'collecting';`);
    await decide.processDueBatches();
    const all = await notices();
    assert.equal(all.length, 2);
    assert.match(all[1].body, /^#E-\w+ · .* — updated/);
    assert.ok(all[1].body.split("\n").length <= 12, "short");
    assert.match(all[1].body, /AI suggests \(replaces the earlier one\)/);
    await pg.run(`update public.ai_agent_outbox set status = 'sent', whatsapp_message_id = 'WA-N2' where id = ${lit(all[1].id)};`);

    const d = await pilotDrafts();
    assert.deepEqual(d.map((x) => [x.version, x.status]), [[1, "superseded"], [2, "current"]]);
    // The outdated notice cannot be approved; the newest can.
    const stale = await staffSays("!approve", { quoted: "WA-N1", ack: false });
    assert.equal(stale.outbox.filter((o) => o.kind === "staff_relay").length, 0);
    assert.equal((await customerBound()).length, 0);
    const fresh = await staffSays("!approve", { quoted: "WA-N2", ack: false });
    const sent = fresh.outbox.filter((o) => o.kind === "staff_relay");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, "Yes, the 15kg chicken bag is EC$90, and delivery depends on your area.");
    assert.equal((await customerBound()).length, 1, "exactly one customer message, from the newest draft");
  });

  test("a safe reply needs just !approve; a risky one needs !approve confirm, and an unconfirmed approve sends nothing", async () => {
    const safe = await ask(JANE, "How much is the 15kg bag?");
    const ok = await staffSays("!approve", { quoted: safe.noticeWaId });
    assert.equal(ok.outbox.filter((o) => o.kind === "staff_relay" && o.send).length, 1);

    const risky = await ask(MARCUS, "How much is the bag?", { ready: false, reply: "It costs EC$99." });
    assert.match(risky.notice.body, /!approve confirm/);
    const plain = await staffSays("!approve", { quoted: risky.noticeWaId });
    assert.equal(plain.outbox.filter((o) => o.kind === "staff_relay").length, 0);
    assert.match(await lastFeedback(), /needs its facts confirmed/);
    const confirmed = await staffSays("!approve confirm", { quoted: risky.noticeWaId });
    assert.equal(confirmed.outbox.filter((o) => o.kind === "staff_relay" && o.send).length, 1);
    assert.equal((await customerBound()).length, 2);
  });

  test("advanced commands keep working although the notice no longer lists them", async () => {
    const { noticeWaId } = await ask(JANE, "How much is the 15kg bag?");
    const edit = await staffSays("!edit The 15kg bag is EC$90 today.", { quoted: noticeWaId });
    assert.ok(edit.outbox.some((o) => o.kind === "staff_draft"));
    const status = await staffSays("!status", { quoted: noticeWaId });
    assert.match(status.outbox[0].body, /draft v2/);
    const sent = await staffSays("!send We are open until 4pm.", { quoted: noticeWaId });
    assert.equal(sent.outbox.filter((o) => o.kind === "staff_relay" && o.send).length, 1);
  });

  // ── Dashboard approval queue ──────────────────────────────────────────────

  test("the dashboard queue lists one request with its exact draft; Approve uses the same policy and the one outbox (pending for the bridge)", async () => {
    const { escalation } = await ask(JANE, "How much is the 15kg bag?");
    const queue = await approvals.listPendingApprovals(await settingsOf());
    assert.equal(queue.length, 1);
    assert.equal(queue[0].draft?.body, "The 15kg chicken dog food bag costs EC$90.");
    assert.equal(queue[0].stale, false);
    assert.equal(queue[0].latestMessage, "How much is the 15kg bag?");

    const res = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "approve", draftId: queue[0].draft!.id });
    assert.equal(res.ok, true);
    const sent = await customerBound();
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].kind, sent[0].status, sent[0].to_jid, sent[0].body], ["staff_relay", "pending", JANE.chat, "The 15kg chicken dog food bag costs EC$90."]);
    const [d] = await pilotDrafts();
    assert.equal(d.status, "approved");
    assert.equal(d.decided_by, `admin:${ADMIN}`);
    assert.equal(d.outcome, "approved_as_is");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'pilot.approve' and actor_kind = 'admin'`), 1);
    // The bridge's poll hands out exactly one copy, through the one claim.
    const claimed = await outbox.claimOutbox("dog_food", 20);
    assert.equal(claimed.filter((c) => c.kind === "staff_relay").length, 1);
    // A second click, or the same draft approved again, sends nothing more.
    const again = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "approve", draftId: d.id });
    assert.equal(again.ok, false);
    assert.equal((await customerBound()).length, 1);
    assert.equal((await approvals.listPendingApprovals(await settingsOf())).length, 0, "an answered request leaves the queue");
  });

  test("the dashboard cannot approve a stale or replaced draft, a risky draft without confirmation, or in another business", async () => {
    const risky = await ask(JANE, "How much is the bag?", { ready: false, reply: "It costs EC$99." });
    const noConfirm = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: risky.escalation.id, adminId: ADMIN, action: "approve" });
    assert.equal(noConfirm.ok, false);
    assert.match(!noConfirm.ok ? noConfirm.error : "", /not backed by approved knowledge/);
    assert.equal((await customerBound()).length, 0);

    // The customer writes again: the draft is stale and the queue says so; approving it is refused by the central policy.
    script = () => proposal();
    await customerSays(JANE, "Actually how much is the 5kg bag?");
    const stale = await approvals.listPendingApprovals(await settingsOf());
    const [d] = (await pilotDrafts()).filter((x) => x.status === "current");
    const refused = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: risky.escalation.id, adminId: ADMIN, action: "approve", confirm: true, draftId: d?.id });
    assert.equal(refused.ok, false);
    assert.equal((await customerBound()).length, 0, "a stale draft is never sent");
    void stale;

    const foreign = await approvals.runApprovalAction({ settings: await settingsOf("by_sea"), escalationId: risky.escalation.id, adminId: ADMIN, action: "approve", confirm: true });
    assert.deepEqual(foreign, { ok: false, status: 404, error: "Request not found" });
  });

  test("the dashboard honours customer eligibility: an excluded customer's draft is withheld, not sent", async () => {
    const { escalation } = await ask(JANE, "How much is the 15kg bag?");
    await pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(JANE.chat)}, 'exclude');`);
    const res = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "approve" });
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error : "", /^Not sent: /);
    assert.equal((await customerBound()).length, 0);
  });

  test("Edit saves a new draft version without sending; Reject drops the draft and sends nothing; More info is read-only", async () => {
    const { escalation } = await ask(JANE, "How much is the 15kg bag?");
    const queue = await approvals.listPendingApprovals(await settingsOf());
    const info = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "moreinfo", draftId: queue[0].draft!.id });
    assert.equal(info.ok && /Read-only: nothing was changed or sent/.test(info.text ?? ""), true);
    assert.equal((await pilotDrafts()).length, 1);

    const edited = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "edit", text: "The 15kg bag is EC$90 today.", draftId: queue[0].draft!.id });
    assert.equal(edited.ok, true);
    assert.deepEqual((await pilotDrafts()).map((d) => [d.version, d.status, d.source]), [[1, "superseded", "ai"], [2, "current", "staff_edit"]]);
    assert.equal((await customerBound()).length, 0, "saving an edit never sends");
    // The old draft id can no longer be acted on.
    const old = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "approve", draftId: queue[0].draft!.id });
    assert.equal(old.ok, false);
    assert.equal((await customerBound()).length, 0);
    const unsafe = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "edit", text: "api_key=sk-abcdefghijklmnop" });
    assert.equal(unsafe.ok, false);

    const current = (await pilotDrafts()).find((d) => d.status === "current")!;
    const rejected = await approvals.runApprovalAction({ settings: await settingsOf(), escalationId: escalation.id, adminId: ADMIN, action: "reject", draftId: current.id, reason: "wrong price" });
    assert.equal(rejected.ok, true);
    assert.equal((await pilotDrafts()).find((d) => d.id === current.id)!.status, "rejected");
    assert.equal((await customerBound()).length, 0);
  });

  test("the queue is empty outside Approval Pilot and never offers a bulk action", async () => {
    await ask(JANE, "How much is the 15kg bag?");
    await configure({ mode: "observe" });
    assert.deepEqual(await approvals.listPendingApprovals(await settingsOf()), []);
    const src = (await import("node:fs")).readFileSync("app/api/ai-agent/approvals/route.ts", "utf8");
    assert.doesNotMatch(src, /escalationIds|approveAll|Array\.isArray\(body\.escalation/i);
  });
});
