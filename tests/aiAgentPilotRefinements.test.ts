// Approval Pilot pre-deployment refinements: quoted !approve routing, concurrent approval, teach/confirm by the same
// authorized person, unverified passive learning, verdict override, 90-day retention, Test Again, and unsupported
// business-fact claims. Same approach as aiAgentApprovalPilot.test.ts: real server code, real SQL, scripted model.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { assessDraftReadiness, unsupportedClaimCodes } from "../lib/aiAgent/pilot.ts";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

describe("unsupported business-fact claims in drafts", () => {
  const knowledge = [{ id: "k1", content: "The 15kg chicken dog food bag costs EC$90. We deliver to Gros Islet on Tuesdays." }];
  const ready = (reply: string) =>
    assessDraftReadiness({ reply, proposal: { decision: "REPLY", knowledge_ids: ["k1"], confidence: 0.95 }, activeKnowledge: knowledge, safeguardCodes: [], reasonCodes: [], requiredConfidence: 0.5 });

  test("a draft backed by the cited knowledge is customer-ready", () => {
    assert.equal(ready("The 15kg bag costs EC$90.").ready, true);
    assert.equal(ready("We deliver to Gros Islet on Tuesdays.").ready, true);
  });

  test("an unbacked price, stock claim, day/time or offer is not customer-ready", () => {
    assert.equal(ready("The 15kg bag costs EC$80.").ready, false);
    assert.equal(ready("Yes, we have it in stock.").ready, false);
    assert.equal(ready("Yes, we still have plenty available.").ready, false);
    assert.equal(ready("We can deliver tomorrow at 9am.").ready, false);
    assert.equal(ready("It costs EC$90 and delivery is free delivery this week.").ready, false);
  });

  test("a claim is supported only by text that states it", () => {
    assert.deepEqual(unsupportedClaimCodes("We have it in stock.", ["Chicken bags are in stock today."]), []);
    assert.deepEqual(unsupportedClaimCodes("We open at 9am.", ["We open 9am to 5pm."]), []);
    assert.deepEqual(unsupportedClaimCodes("We open at 10am.", ["We open 9am to 5pm."]), ["unverified_schedule"]);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

// ── Part 2: end to end ───────────────────────────────────────────────────────

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const OTHER_STAFF = "17585550002@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let knowledge: typeof import("../lib/server/aiAgent/staffKnowledge.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let evaluation: typeof import("../lib/server/aiAgent/evaluation.ts");
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
type Analysis = { customer_reply: string | null; items: unknown[] } | null;
const analyzerCalls: { mode: string; staffText: string }[] = [];
let analyzerScript: (staffText: string) => Analysis = () => null;

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
    auto_takeover_minutes: 120,
    default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"],
    passive_learning_scope: "off",
    knowledge_confirm_via_whatsapp: false,
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) =>
      `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`
    )
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}

async function addKnowledge(content = "The 15kg chicken dog food bag costs EC$90.", kind = "price", biz = "dog_food") {
  return (
    await pg.run(
      `with i as (insert into public.ai_agent_knowledge (business_slug, kind, title, content, status) values (${lit(biz)}, ${lit(kind)}, 'Price', ${lit(content)}, 'approved') returning id) select id from i;`
    )
  ).trim();
}

async function ackAll(items: { id: string; send: boolean }[]) {
  for (const item of items) {
    if (item.send) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
  }
}

async function customerSays(c: Customer, text: string, opts: { biz?: string; fromMe?: boolean } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: `CUST-${++seq}`,
    chatId: c.chat,
    contactNumber: c.phone,
    fromMe: opts.fromMe ?? false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

async function staffSays(
  text: string,
  opts: { quoted?: string | null; biz?: string; group?: string; sender?: string | null; id?: string; ack?: boolean } = {}
) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `STAFF-${++seq}`,
    chatId: opts.group ?? GROUP,
    contactNumber: null,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: opts.quoted ?? null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender,
    senderPhone: null,
    timestamp: new Date().toISOString(),
  });
  if (opts.ack !== false) await ackAll(result.outbox);
  return result;
}

const notices = (c?: Customer, biz = "dog_food") =>
  rows<{ id: string; body: string; status: string; escalation_id: string; whatsapp_message_id: string | null }>(
    `select id, body, status, escalation_id, whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_notice' and business_slug = ${lit(biz)}${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at, id`
  );
const postedDrafts = () =>
  rows<{ id: string; body: string; whatsapp_message_id: string | null; dedupe_key: string }>(
    `select id, body, whatsapp_message_id, dedupe_key from public.ai_agent_outbox where kind = 'staff_draft' order by created_at, id`
  );
const feedbacks = () => rows<{ body: string }>(`select body from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at, id`);
const lastFeedback = async () => (await feedbacks()).at(-1)?.body ?? "";
const customerBound = (c?: Customer) =>
  rows<{ id: string; kind: string; body: string; status: string; to_jid: string; error: string | null }>(
    `select id, kind, body, status, to_jid, error from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at`
  );
const pilotDrafts = (biz = "dog_food") =>
  rows<Record<string, any>>(`select * from public.ai_agent_pilot_drafts where business_slug = ${lit(biz)} order by escalation_id, version`);
const candidates = () => rows<Record<string, any>>(`select * from public.ai_agent_learning_candidates order by created_at`);
const knowledgeRows = () => rows<Record<string, any>>(`select * from public.ai_agent_knowledge order by created_at`);

/** A customer asks, the AI proposes `reply` (backed by knowledge when `ready`), the pilot notice is posted and acked. */
async function askWithDraft(c: Customer, question: string, opts: { ready?: boolean; reply?: string } = {}) {
  const ready = opts.ready ?? true;
  const kid = ready ? await addKnowledge() : null;
  const reply = opts.reply ?? "The 15kg chicken dog food bag costs EC$90.";
  script = () => proposal({ decision: "REPLY", intent: "question", reply, confidence: 0.95, knowledge_ids: kid ? [kid] : [], escalation_reason: null });
  const result = await customerSays(c, question);
  const [notice] = (await notices(c)).slice(-1);
  const [draft] = (await pilotDrafts()).filter((d) => d.chat_id === c.chat).slice(-1);
  return { result, notice, noticeWaId: notice.whatsapp_message_id!, escalationId: notice.escalation_id, draft, ref: (await rows<{ ref_code: string }>(`select ref_code from public.ai_agent_escalations where id = ${lit(notice.escalation_id)}`))[0].ref_code };
}

describe("Approval Pilot refinements (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    knowledge = await import("../lib/server/aiAgent/staffKnowledge.ts");
    evaluation = await import("../lib/server/aiAgent/evaluation.ts");
    model.setReplyProposerForTests(async (input) => {
      modelCalls.push(input);
      return { proposal: script(input), model: "scripted", error: null };
    });
    knowledge.setStaffAnalyzerForTests(async (input) => {
      analyzerCalls.push({ mode: input.mode, staffText: input.staffText });
      const analysis = analyzerScript(input.staffText);
      return analysis
        ? { analysis: { customerReply: input.mode === "classify_only" ? null : analysis.customer_reply, items: analysis.items as never }, model: "scripted", error: null }
        : { analysis: null, model: "scripted", error: "model unavailable" };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    knowledge?.setStaffAnalyzerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events,
        public.ai_agent_learning_candidates, public.ai_agent_knowledge, public.ai_agent_customer_memory,
        public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules, public.ai_agent_order_requests,
        public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts, public.ai_agent_shadow_results,
        public.whatsapp_messages;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none',
        staff_group_jid = null, staff_notices_enabled = false, customer_memory_enabled = false, staff_authorized_senders = '{}',
        batching_enabled = false, default_customer_mode = 'staff_first', passive_learning_scope = 'off', knowledge_confirm_via_whatsapp = false;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls.length = 0;
    analyzerCalls.length = 0;
    script = () => proposal();
    analyzerScript = () => null;
  });

  // ── helpers for this file ────────────────────────────────────────────────

  async function staffFrom(text: string, opts: { quoted?: string | null; sender?: string | null; fromMe?: boolean; id?: string; ack?: boolean } = {}) {
    const result = await decide.processBridgeMessage({
      businessSlug: "dog_food",
      whatsappMessageId: opts.id ?? `STAFF-${++seq}`,
      chatId: GROUP,
      contactNumber: null,
      fromMe: opts.fromMe ?? false,
      text,
      hasMedia: false,
      quotedMessageId: opts.quoted ?? null,
      senderJid: opts.sender === undefined ? STAFF : opts.sender,
      senderPhone: null,
      timestamp: new Date().toISOString(),
    });
    if (opts.ack !== false) await ackAll(result.outbox);
    return result;
  }
  const relays = (r: { outbox: { kind: string; send: boolean }[] }) => r.outbox.filter((o) => o.kind === "staff_relay" && o.send);

  // ── Quoted !approve routing and concurrency ──────────────────────────────

  test("quoted !approve needs no version or code: quoting a draft post approves exactly that draft", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    await staffFrom("!edit The 15kg chicken dog food bag costs EC$90, delivered on Tuesdays.", { quoted: noticeWaId });
    const [post] = await postedDrafts();
    const r = await staffFrom("!approve", { quoted: post.whatsapp_message_id, ack: false });
    assert.equal(relays(r).length, 1);
    const [v1, v2] = await pilotDrafts();
    assert.equal(v1.status, "superseded");
    assert.equal(v2.status, "approved");
    assert.equal((await customerBound(JANE))[0].body, "The 15kg chicken dog food bag costs EC$90, delivered on Tuesdays.");
  });

  test("quoting the old notice after an edit never approves the newer draft staff haven't seen", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    await staffFrom("!edit The bag costs EC$90.", { quoted: noticeWaId });
    const r = await staffFrom("!approve", { quoted: noticeWaId });
    assert.equal(relays(r).length, 0);
    assert.equal((await customerBound()).length, 0);
    assert.match(await lastFeedback(), /replaced/);
  });

  test("quoting one of our confirmation messages resolves the escalation and its current draft", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    await staffFrom("!status", { quoted: noticeWaId });
    const fb = await rows<{ whatsapp_message_id: string }>(`select whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at desc limit 1`);
    const r = await staffFrom("!approve", { quoted: fb[0].whatsapp_message_id, ack: false });
    assert.equal(relays(r).length, 1);
  });

  test("strict invalidation: ANY customer message after the draft (even 'thanks') makes it unapprovable", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    script = () => proposal();
    await customerSays(JANE, "thanks");
    const r = await staffFrom("!approve", { quoted: noticeWaId });
    assert.equal(relays(r).length, 0);
    assert.equal((await customerBound()).length, 0);
    assert.match(await lastFeedback(), /customer has written again/);
  });

  test("concurrent approvals of the quoted draft (several senders, several commands) send exactly once", async () => {
    await configure({ staff_authorized_senders: ["17585550001", "17585550002"] });
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    const results = await Promise.all([
      staffFrom("!approve", { quoted: noticeWaId, ack: false }),
      staffFrom("!approve", { quoted: noticeWaId, sender: OTHER_STAFF, ack: false }),
      staffFrom("!approve v1", { quoted: noticeWaId, ack: false }),
      staffFrom("!approve v1", { quoted: noticeWaId, sender: OTHER_STAFF, ack: false }),
      staffFrom("!approve", { quoted: noticeWaId, id: "SAME-ID", ack: false }),
      staffFrom("!approve", { quoted: noticeWaId, id: "SAME-ID", ack: false }),
    ]);
    assert.equal(results.flatMap(relays).length, 1);
    assert.equal((await customerBound()).length, 1);
    assert.equal((await pilotDrafts()).filter((d) => d.status === "approved").length, 1);
  });

  test("approval racing an edit never sends text the approver did not see", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    const [a, b] = await Promise.all([
      staffFrom("!approve", { quoted: noticeWaId, ack: false }),
      staffFrom("!edit The bag costs EC$999.", { quoted: noticeWaId, ack: false }),
    ]);
    void b;
    for (const row of await customerBound()) assert.doesNotMatch(row.body, /999/);
    assert.ok(relays(a).length <= 1);
  });

  test("a draft whose cited knowledge changed since it was written needs !approve confirm", async () => {
    const { noticeWaId } = await askWithDraft(JANE, "How much is the bag?");
    await pg.run(`update public.ai_agent_knowledge set status = 'archived' where business_slug = 'dog_food';`);
    const r = await staffFrom("!approve", { quoted: noticeWaId });
    assert.equal(relays(r).length, 0);
    assert.match(await lastFeedback(), /needs its facts confirmed/);
    const ok = await staffFrom("!approve confirm", { quoted: noticeWaId, ack: false });
    assert.equal(relays(ok).length, 1);
    assert.equal((await pilotDrafts())[0].outcome, "approved_after_confirm");
  });

  test("a customer-ready draft never carries an unbacked stock claim: staff must confirm it", async () => {
    const { draft } = await askWithDraft(JANE, "Do you have the 15kg bag?", { reply: "Yes, we have the 15kg bag in stock and it costs EC$90." });
    assert.equal(draft.ready, false);
    assert.ok(draft.confirm_notes.some((n: string) => /in stock|available/.test(n)));
  });

  // ── !teach / !confirm by the same authorized person ──────────────────────

  test("the same authorized person can !teach and then !confirm, and the audit trail records both", async () => {
    await configure({ knowledge_confirm_via_whatsapp: true });
    await staffFrom("!teach We deliver to Gros Islet on Tuesdays");
    const code = (await candidates())[0].short_code;
    await staffFrom(`!confirm ${code}`);
    assert.equal((await knowledgeRows()).length, 1);
    const audit = await rows<{ action: string; actor_id: string; details: Record<string, any> }>(`select action, actor_id, details from public.ai_agent_audit_log where action in ('teach.propose','learning.approve') order by created_at`);
    assert.deepEqual(audit.map((a) => a.action), ["teach.propose", "learning.approve"]);
    assert.equal(audit[1].actor_id, "17585550001");
    assert.equal(audit[1].details.proposed_by, "17585550001");
    assert.equal(audit[1].details.self_confirmed, true);
    assert.equal(audit[1].details.sender_verified, true);
  });

  test("!confirm and !discard work when quoting a proposal whose escalation has since closed", async () => {
    await configure({ knowledge_confirm_via_whatsapp: true });
    const { noticeWaId, ref, escalationId } = await askWithDraft(JANE, "How much is the bag?");
    await staffFrom(`!teach #${ref} We deliver to Gros Islet on Tuesdays`);
    const [fb] = await rows<{ whatsapp_message_id: string }>(`select whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_feedback' and escalation_id = ${lit(escalationId)} order by created_at desc limit 1`);
    await pg.run(`update public.ai_agent_escalations set status = 'resolved' where id = ${lit(escalationId)};`);
    const code = (await candidates())[0].short_code;
    await staffFrom(`!confirm ${code}`, { quoted: fb.whatsapp_message_id });
    assert.equal((await knowledgeRows()).filter((k) => k.source === "whatsapp").length, 1);
    void noticeWaId;
  });

  test("an unverified sender (none reported) can neither teach nor confirm", async () => {
    await configure({ knowledge_confirm_via_whatsapp: true });
    await staffFrom("!teach We deliver to Gros Islet on Tuesdays", { sender: null });
    assert.equal((await candidates()).length, 0);
    await staffFrom("!teach We deliver to Gros Islet on Tuesdays");
    const code = (await candidates())[0].short_code;
    await staffFrom(`!confirm ${code}`, { sender: null });
    assert.equal((await knowledgeRows()).length, 0);
  });

  // ── Passive learning: the business account is never a verified author ────

  const fact = "We have changed our weekend hours, now open Saturday 8am to 2pm.";
  const factItem = () => ({
    customer_reply: null,
    items: [{ category: "durable", kind: "hours", title: "Saturday hours", content: "We are open Saturday 8am to 2pm.", evidence: "open Saturday 8am to 2pm" }],
  });

  test("the business account's own customer-chat messages become UNVERIFIED pending candidates, only with the widest opt-in, never approved", async () => {
    analyzerScript = factItem;
    await configure({ passive_learning_scope: "staff_group", knowledge_confirm_via_whatsapp: true });
    await customerSays(JANE, fact, { fromMe: true });
    assert.equal(analyzerCalls.length, 0, "staff-group scope does not read customer chats");
    await configure({ passive_learning_scope: "staff_group_and_chats", knowledge_confirm_via_whatsapp: true });
    await customerSays(JANE, fact, { fromMe: true });
    const [c] = await candidates();
    assert.equal(c.sender_verified, false);
    assert.equal(c.status, "pending");
    assert.equal(c.proposed_by, null);
    assert.ok(Number(c.confidence) < 0.5);
    assert.equal((await knowledgeRows()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'learning.approve'`), 0);
  });

  test("a staff-group message from the business account itself is unverified: ignored at the staff-group scope, an unverified candidate at the widest", async () => {
    analyzerScript = factItem;
    await configure({ passive_learning_scope: "staff_group" });
    await staffFrom(fact, { fromMe: true });
    assert.equal(analyzerCalls.length, 0);
    await configure({ passive_learning_scope: "staff_group_and_chats" });
    await staffFrom(fact, { fromMe: true });
    const [c] = await candidates();
    assert.equal(c.sender_verified, false);
    assert.equal(c.status, "pending");
    assert.match(await lastFeedback(), /UNVERIFIED/);
    // A verified authorized person's message is still a verified candidate.
    await pg.run(`delete from public.ai_agent_learning_candidates;`);
    await staffFrom(fact);
    assert.equal((await candidates())[0].sender_verified, true);
  });

  // ── Verdict override ─────────────────────────────────────────────────────

  test("an admin overrides the verdict with a reason; history keeps every change; later events never overwrite it", async () => {
    const { noticeWaId, escalationId } = await askWithDraft(JANE, "How much is the bag?");
    const pilot = await import("../lib/server/aiAgent/pilot.ts");
    const ADMIN = "11111111-1111-1111-1111-111111111111";
    const undecided = await pilot.overridePilotVerdict({ businessSlug: "dog_food", escalationId, verdict: "factually_wrong", reason: "too early", adminId: ADMIN });
    assert.equal(undecided.ok, false, "an undecided draft cannot be judged");
    await staffFrom("!approve", { quoted: noticeWaId, ack: false });
    assert.equal((await pilotDrafts())[0].verdict, "correct");
    const noReason = await pilot.overridePilotVerdict({ businessSlug: "dog_food", escalationId, verdict: "factually_wrong", reason: " ", adminId: ADMIN });
    assert.equal(noReason.ok, false);
    const ok = await pilot.overridePilotVerdict({ businessSlug: "dog_food", escalationId, verdict: "missing_information", reason: "Price was right but it omitted delivery", adminId: ADMIN });
    assert.equal(ok.ok, true);
    await pilot.overridePilotVerdict({ businessSlug: "dog_food", escalationId, verdict: "factually_wrong", reason: "Second look: price outdated", adminId: ADMIN });
    const [d] = await pilotDrafts();
    assert.equal(d.verdict, "factually_wrong");
    assert.equal(d.verdict_source, "admin");
    const history = await rows<{ previous_verdict: string | null; new_verdict: string; reason: string }>(`select previous_verdict, new_verdict, reason from public.ai_agent_pilot_verdict_history order by changed_at`);
    assert.deepEqual(history.map((h) => [h.previous_verdict, h.new_verdict]), [["correct", "missing_information"], ["missing_information", "factually_wrong"]]);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'evaluation.verdict_override'`), 2);
    // Another business cannot override this one's.
    const other = await pilot.overridePilotVerdict({ businessSlug: "by_sea", escalationId, verdict: "correct", reason: "not mine", adminId: ADMIN });
    assert.equal(other.ok, false);
    const review = (await evaluation.loadEvaluation("dog_food")).pilotReviews[0];
    assert.equal(review.verdict, "factually_wrong");
    assert.equal(review.verdictSource, "admin");
    assert.equal(review.verdictHistory.length, 2);
    assert.equal(review.verdictHistory[0].to, "factually_wrong");
  });

  // ── 90-day retention ─────────────────────────────────────────────────────

  test("retention: draft wording older than 90 days is blanked, minimal audit metadata stays, a purged draft can never be approved", async () => {
    const { noticeWaId, escalationId } = await askWithDraft(JANE, "How much is the bag?");
    const fresh = await askWithDraft(MARCUS, "And for me?");
    await pg.run(`update public.ai_agent_pilot_drafts set created_at = now() - interval '91 days' where escalation_id = ${lit(escalationId)};`);
    const pilot = await import("../lib/server/aiAgent/pilot.ts");
    assert.equal(await pilot.purgePilotDrafts(), 1);
    assert.equal(await pilot.purgePilotDrafts(), 0, "idempotent");
    const [old] = await rows<Record<string, any>>(`select * from public.ai_agent_pilot_drafts where escalation_id = ${lit(escalationId)}`);
    assert.equal(old.body, "");
    assert.equal(old.final_text, null);
    assert.deepEqual(old.confirm_notes, []);
    assert.ok(old.content_purged_at);
    assert.ok(old.body_hash && old.business_slug && old.chat_id && old.knowledge_version, "minimal audit metadata is kept");
    assert.equal(old.status, "superseded", "an open draft is closed, not left approvable");
    const r = await staffFrom("!approve", { quoted: noticeWaId });
    assert.equal(relays(r).length, 0);
    assert.equal((await customerBound()).length, 0);
    // Recent drafts are untouched and still approvable.
    const [kept] = await rows<Record<string, any>>(`select body, content_purged_at from public.ai_agent_pilot_drafts where escalation_id = ${lit(fresh.escalationId)}`);
    assert.ok(kept.body.length > 0 && kept.content_purged_at === null);
    assert.equal(relays(await staffFrom("!approve", { quoted: fresh.noticeWaId, ack: false })).length, 1);
    const review = (await evaluation.loadEvaluation("dog_food")).pilotReviews.find((x) => x.escalationId === escalationId)!;
    assert.equal(review.contentPurged, true);
    assert.equal(review.aiDraft.text, "");
  });

  test("Forget Customer still deletes drafts and verdict history (purged or not)", async () => {
    const { noticeWaId, escalationId } = await askWithDraft(JANE, "How much is the bag?");
    await staffFrom("!approve", { quoted: noticeWaId, ack: false });
    const pilot = await import("../lib/server/aiAgent/pilot.ts");
    await pilot.overridePilotVerdict({ businessSlug: "dog_food", escalationId, verdict: "missing_information", reason: "omitted delivery", adminId: "11111111-1111-1111-1111-111111111111" });
    await pg.run(`update public.ai_agent_pilot_drafts set created_at = now() - interval '120 days';`);
    await pilot.purgePilotDrafts();
    await pg.run(`select public.forget_ai_agent_customer('dog_food', array[${lit(JANE.chat)}], ${lit(JANE.phone)}, false, true);`);
    assert.equal((await pilotDrafts()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_pilot_verdict_history`), 0);
  });

  // ── Test Again ───────────────────────────────────────────────────────────

  test("Test Again re-runs the request with current knowledge as a labelled SIMULATION, sends nothing, leaves the historical draft alone", async () => {
    const { escalationId, draft } = await askWithDraft(JANE, "How much is the 15kg chicken bag?");
    await pg.run(`update public.ai_agent_knowledge set content = 'The 15kg chicken dog food bag costs EC$95.' where business_slug = 'dog_food';`);
    const kid = (await knowledgeRows())[0].id;
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$95.", confidence: 0.95, knowledge_ids: [kid], escalation_reason: null });
    const decideMod = await import("../lib/server/aiAgent/decide.ts");
    const calls = modelCalls.length;
    const res = await decideMod.simulatePilotRequest({ businessSlug: "dog_food", escalationId, adminId: "11111111-1111-1111-1111-111111111111" });
    assert.equal(res.status, "simulated");
    assert.equal(modelCalls.length, calls + 1);
    const again = await decideMod.simulatePilotRequest({ businessSlug: "dog_food", escalationId, adminId: "11111111-1111-1111-1111-111111111111" });
    assert.equal(again.status, "cached", "same knowledge version: no second model call");
    assert.equal(modelCalls.length, calls + 1);
    assert.equal((await customerBound()).length, 0, "nothing is sent");
    const [still] = await pilotDrafts();
    assert.equal(still.body, draft.body, "the historical draft is untouched");
    assert.equal(still.status, "current");
    const [sim] = await rows<{ kind: string; reply: string }>(`select kind, reply from public.ai_agent_shadow_results`);
    assert.equal(sim.kind, "simulation");
    const review = (await evaluation.loadEvaluation("dog_food")).pilotReviews[0];
    assert.match(review.simulation!.reply!, /EC\$95/);
    assert.equal(review.simulation!.knowledgeChangedSinceDraft, true);
    assert.match(review.aiDraft.text, /EC\$90/, "historical text is still what staff saw");
  });

  test("Test Again shares the simulation hourly limit and refuses another business's request", async () => {
    const { escalationId } = await askWithDraft(JANE, "How much is the 15kg chicken bag?");
    const decideMod = await import("../lib/server/aiAgent/decide.ts");
    const foreign = await decideMod.simulatePilotRequest({ businessSlug: "by_sea", escalationId, adminId: "11111111-1111-1111-1111-111111111111" });
    assert.deepEqual(foreign, { status: "skipped", reason: "not_found" });
    const { SIMULATIONS_PER_HOUR } = await import("../lib/aiAgent/evaluation.ts");
    await pg.run(`insert into public.ai_agent_shadow_results (business_slug, chat_id, kind, decision, dedupe_key, customer_question, uses_current_knowledge)
      select 'dog_food', 'x@s.whatsapp.net', 'simulation', 'REPLY', 'fill-' || g, 'q', true from generate_series(1, ${SIMULATIONS_PER_HOUR}) g;`);
    const limited = await decideMod.simulatePilotRequest({ businessSlug: "dog_food", escalationId, adminId: "11111111-1111-1111-1111-111111111111" });
    assert.deepEqual(limited, { status: "skipped", reason: "simulation_limit" });
  });
});
