// The staff-escalation workflow end to end: the app's REAL server code
// (processBridgeMessage → staff group → drafting → classification → outbox →
// ack → admin approval) running against the REAL migrations in a throwaway
// Postgres (tests/helpers/pgHarness.ts). Only the language model is replaced by
// a scripted stand-in, and the WhatsApp bridge by a loop that acks what it was
// handed. Skips itself when no Postgres binaries are installed.
//
// Fixtures are a small dog-food shop: three customers escalated at once, a
// standard price, a stock shortage, a regular's delivery habit and a one-off
// discount.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const STAFF = "17585550001@s.whatsapp.net";

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
const PRIYA = { chat: "17585550103@s.whatsapp.net", phone: "17585550103", name: "Priya" };
type Customer = typeof JANE;

// Loaded after the TS loader is registered.
let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let escalations: typeof import("../lib/server/aiAgent/escalations.ts");
let knowledge: typeof import("../lib/server/aiAgent/staffKnowledge.ts");
let learning: typeof import("../lib/server/aiAgent/learning.ts");
let adminSend: typeof import("../lib/server/aiAgent/adminSend.ts");
let staffGroup: typeof import("../lib/server/aiAgent/staffGroup.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");

type Analysis = { customer_reply: string | null; items: unknown[] } | null;
const analyzerCalls: { mode: string; staffText: string }[] = [];
let script: (staffText: string) => Analysis = () => null;

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true,
    mode: "assisted",
    contact_scope: "all",
    staff_group_jid: group,
    staff_notices_enabled: true,
    customer_memory_enabled: true,
    auto_takeover_minutes: 120,
    // Default-deny: the fixtures' staff member is explicitly authorized, as an admin would configure.
    staff_authorized_senders: ["17585550001"],
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) =>
      `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`
    )
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}

/** An escalation with its notice posted and acked, exactly as the live path leaves it. */
async function escalate(c: Customer, message: string, biz = "dog_food", group = GROUP) {
  const { escalation } = await escalations.createOrAppendEscalation({
    businessSlug: biz,
    chatId: c.chat,
    contactNumber: c.phone,
    customerName: c.name,
    reasons: ["model_uncertain"],
    priority: "normal",
    customerMessage: message,
    draftReply: null,
    summary: null,
    orderRequest: null,
    eventId: null,
  });
  const [notice] = await outbox.enqueue(
    [{ businessSlug: biz, chatId: c.chat, kind: "staff_notice", toJid: group, body: `🔔 AI escalation #${escalation.ref_code}`, dedupeKey: `notice:${escalation.id}`, escalationId: escalation.id }],
    true
  );
  const waId = `WA-NOTICE-${escalation.ref_code}`;
  await outbox.ackOutbox({ outboxId: notice.id, status: "sent", whatsappMessageId: waId, error: null });
  return { id: escalation.id, ref: escalation.ref_code, noticeWaId: waId, customer: c };
}

/** A message in the staff group, through the real bridge entry point; the "bridge" then acks what it was asked to send. */
async function staffSays(
  text: string,
  opts: { quoted?: string | null; id?: string; biz?: string; group?: string; fromMe?: boolean; sender?: string | null; senderPhone?: string | null; ack?: boolean } = {}
) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `STAFF-MSG-${++seq}`,
    chatId: opts.group ?? GROUP,
    contactNumber: null,
    fromMe: opts.fromMe ?? false,
    text,
    hasMedia: false,
    quotedMessageId: opts.quoted ?? null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender,
    senderPhone: opts.senderPhone ?? null,
    timestamp: new Date().toISOString(),
  });
  const waIds: Record<string, string> = {};
  for (const item of result.outbox) {
    if (!item.send || opts.ack === false) continue;
    waIds[item.id] = `WA-OUT-${++seq}`;
    await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: waIds[item.id], error: null });
  }
  return { ...result, waIds };
}

const CUSTOMER_KINDS = "('customer_reply','holding_reply','staff_relay')";
const customerMessages = (chat?: string) =>
  rows<{ kind: string; to_jid: string; body: string; status: string; error: string | null }>(
    `select kind, to_jid, body, status, error from public.ai_agent_outbox where kind in ${CUSTOMER_KINDS}${chat ? ` and to_jid = ${lit(chat)}` : ""} order by created_at`
  );
const drafts = (escalationId?: string) =>
  rows<{ id: string; body: string; status: string; whatsapp_message_id: string | null; reply_to_message_id: string | null; to_jid: string; escalation_id: string }>(
    `select id, body, status, whatsapp_message_id, reply_to_message_id, to_jid, escalation_id from public.ai_agent_outbox where kind = 'staff_draft'${escalationId ? ` and escalation_id = ${lit(escalationId)}` : ""} order by created_at`
  );
const answers = () =>
  rows<Record<string, any>>(`select * from public.ai_agent_staff_answers order by created_at`);

const MARCUS_ANSWER = "Yes we have the 20kg Pedigree, EC$180, and I can deliver it Friday";
const MARCUS_ITEMS = (): Analysis => ({
  customer_reply: "Hi Marcus, yes we have the 20kg Pedigree for EC$180 and can deliver it Friday.",
  items: [],
});

describe("staff escalation workflow (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
    escalations = await import("../lib/server/aiAgent/escalations.ts");
    knowledge = await import("../lib/server/aiAgent/staffKnowledge.ts");
    learning = await import("../lib/server/aiAgent/learning.ts");
    adminSend = await import("../lib/server/aiAgent/adminSend.ts");
    staffGroup = await import("../lib/server/aiAgent/staffGroup.ts");
    knowledge.setStaffAnalyzerForTests(async (input) => {
      analyzerCalls.push({ mode: input.mode, staffText: input.staffText });
      const analysis = script(input.staffText);
      return analysis
        ? { analysis: { customerReply: input.mode === "classify_only" ? null : analysis.customer_reply, items: analysis.items }, model: "scripted", error: null }
        : { analysis: null, model: "scripted", error: "model unavailable" };
    });
  });
  after(() => {
    dbmod?.setAgentDbForTests(null);
    knowledge?.setStaffAnalyzerForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events,
        public.ai_agent_learning_candidates, public.ai_agent_knowledge, public.ai_agent_customer_memory,
        public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules, public.whatsapp_messages;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none',
        staff_group_jid = null, staff_notices_enabled = false, customer_memory_enabled = false, staff_authorized_senders = '{}';`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    analyzerCalls.length = 0;
    script = (text) => (text === MARCUS_ANSWER ? MARCUS_ITEMS() : { customer_reply: null, items: [] });
  });

  // ── Routing ──────────────────────────────────────────────────────────────

  test("three simultaneous escalations stay isolated: each staff reply reaches only the customer it belongs to", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const priya = await escalate(PRIYA, "Can you deliver to Soufriere?");
    assert.equal(new Set([jane.ref, marcus.ref, priya.ref]).size, 3);

    // A reply QUOTING Marcus's notice.
    const r1 = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal(r1.status, "done");
    // A reply naming Priya's reference, no quote.
    script = () => ({ customer_reply: "Hi Priya, yes we deliver to Soufriere.", items: [] });
    await staffSays(`#${priya.ref.toLowerCase()} yes we deliver to Soufriere on Wednesdays`);

    const recorded = await answers();
    assert.equal(recorded.length, 2);
    const byEsc = Object.fromEntries(recorded.map((a) => [a.escalation_id, a]));
    assert.equal(byEsc[marcus.id].chat_id, MARCUS.chat);
    assert.equal(byEsc[marcus.id].matched_via, "quote");
    assert.equal(byEsc[marcus.id].ref_code, marcus.ref);
    assert.equal(byEsc[priya.id].chat_id, PRIYA.chat);
    assert.equal(byEsc[priya.id].matched_via, "ref");
    assert.equal(byEsc[jane.id], undefined);

    const status = Object.fromEntries((await rows<{ id: string; status: string }>("select id, status from public.ai_agent_escalations")).map((e) => [e.id, e.status]));
    assert.equal(status[marcus.id], "answered");
    assert.equal(status[priya.id], "answered");
    assert.equal(status[jane.id], "notified", "Jane was never answered");

    // Each draft is tied to its own escalation and customer.
    assert.equal((await drafts(marcus.id)).length, 1);
    assert.equal((await drafts(priya.id)).length, 1);
    assert.equal((await drafts(jane.id)).length, 0);
    assert.match((await drafts(marcus.id))[0].body, new RegExp(`#${marcus.ref}`));
    assert.doesNotMatch((await drafts(marcus.id))[0].body, new RegExp(priya.ref));
  });

  test("simultaneous staff replies for different customers (processed in parallel) stay isolated", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const priya = await escalate(PRIYA, "Can you deliver to Soufriere?");
    script = (text) => ({ customer_reply: `Reply for: ${text}`, items: [] });
    await Promise.all([
      staffSays("answer for jane", { quoted: jane.noticeWaId }),
      staffSays("answer for marcus", { quoted: marcus.noticeWaId }),
      staffSays(`#${priya.ref} answer for priya`),
    ]);
    const recorded = await answers();
    assert.equal(recorded.length, 3);
    for (const [esc, c, text] of [[jane, JANE, "answer for jane"], [marcus, MARCUS, "answer for marcus"], [priya, PRIYA, "answer for priya"]] as const) {
      const a = recorded.find((r) => r.escalation_id === esc.id)!;
      assert.equal(a.body, text);
      assert.equal(a.chat_id, c.chat);
      assert.equal(a.draft, `Reply for: ${text}`);
      const [d] = await drafts(esc.id);
      assert.match(d.body, new RegExp(`#${esc.ref}`));
      assert.match(d.body, new RegExp(`Reply for: ${text}`));
    }
    assert.equal((await customerMessages()).length, 0);
  });

  test("the same WhatsApp event arriving twice at the same instant is processed once", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const [a, b] = await Promise.all([
      staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, id: "STAFF-RACE-1" }),
      staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, id: "STAFF-RACE-1" }),
    ]);
    assert.ok([a.status, b.status].includes("done"));
    assert.ok([a.status, b.status].some((s) => s === "duplicate" || s === "in_progress"));
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 1);
    assert.equal((await drafts()).length, 1);
    assert.equal(analyzerCalls.length, 1);
  });

  test("ambiguous, unknown and unmatched staff messages are never routed to a customer", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");

    const results = [
      await staffSays(`#${jane.ref} #${marcus.ref} yes to both`),
      await staffSays(`#${jane.ref} yes`, { quoted: marcus.noticeWaId }),
      await staffSays("#E-ZZZZ9 yes we have it"),
      await staffSays("yes we have it, I'll sort it out"),
      await staffSays("Marcus asked about the 20kg, tell him yes", { quoted: "WA-SOMETHING-ELSE" }),
      await staffSays("Jane's order is ready"),
    ];
    for (const r of results) assert.equal(r.status, "done");
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 0);
    assert.equal((await customerMessages()).length, 0);
    assert.equal((await drafts()).length, 0);
    assert.equal(analyzerCalls.length, 0, "no model call for a message that matched nothing");
    assert.equal(await count("select 1 from public.ai_agent_escalations where status = 'answered'"), 0);
  });

  test("a reply in another business's staff group cannot reach this business's escalations", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    await staffSays("yes we do", { quoted: jane.noticeWaId, biz: "by_sea", group: SEA_GROUP });
    await staffSays(`#${jane.ref} yes we do`, { biz: "by_sea", group: SEA_GROUP });
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 0);
    assert.equal((await customerMessages()).length, 0);
  });

  // ── Informational answers are not authorization ──────────────────────────

  test("Assisted mode: a plain staff answer posts a labelled draft and sends NOTHING to the customer", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, id: "STAFF-MARCUS-1" });

    assert.equal((await customerMessages()).length, 0, "no customer-bound item exists");
    assert.deepEqual(r.outbox.map((o) => o.kind), ["staff_draft"]);
    assert.equal(r.outbox[0].to, GROUP);
    // Posted as a quote of the staff member's own message.
    assert.equal(r.outbox[0].replyToMessageId, "STAFF-MARCUS-1");

    const [draft] = await drafts(marcus.id);
    assert.match(draft.body, new RegExp(`Draft reply for #${marcus.ref} · Marcus`));
    assert.match(draft.body, /Hi Marcus, yes we have the 20kg Pedigree for EC\$180/);
    assert.match(draft.body, /Not sent: your reply was saved as information only/);
    assert.match(draft.body, /reply to this message with "send"/);
    assert.doesNotMatch(draft.body, /not_authorized|observe_mode|model_/);

    const [a] = await answers();
    assert.equal(a.body, MARCUS_ANSWER);
    assert.equal(a.command, "answer");
    assert.equal(a.customer_action, "withheld");
    assert.equal(a.withheld_reason, "not_authorized");
    assert.equal(a.business_slug, "dog_food");
    assert.equal(a.ref_code, marcus.ref);
    assert.ok(a.staff_message_at, "the staff message timestamp is kept");
    assert.equal(a.source_message_id, "STAFF-MARCUS-1");
    assert.equal(a.state, "done");
    assert.equal(a.draft, "Hi Marcus, yes we have the 20kg Pedigree for EC$180 and can deliver it Friday.");

    const [esc] = await rows<{ staff_answer: string; context: { answer_not_relayed?: string } }>("select staff_answer, context from public.ai_agent_escalations");
    assert.equal(esc.staff_answer, MARCUS_ANSWER);
    assert.equal(esc.context.answer_not_relayed, "not_authorized");
  });

  test("explicit authorization: quoting the draft and replying 'send' sends that draft to that customer only", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    assert.ok(draft.whatsapp_message_id, "the bridge acked the draft with its WhatsApp id");

    const r = await staffSays("send", { quoted: draft.whatsapp_message_id });
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "staff_relay");
    assert.equal(sent[0].to_jid, MARCUS.chat);
    assert.equal(sent[0].body, "Hi Marcus, yes we have the 20kg Pedigree for EC$180 and can deliver it Friday.");
    assert.equal((await customerMessages(JANE.chat)).length, 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), new RegExp(`Sending reply for #${marcus.ref}`));
    assert.ok(r.outbox.some((o) => o.kind === "staff_relay" && o.send));
    assert.equal(jane.ref === marcus.ref, false);

    const withSend = (await answers()).find((a) => a.command === "send");
    assert.equal(withSend?.customer_action, "sent");
    assert.equal((await answers()).find((a) => a.command === "answer")?.customer_action, "sent");
  });

  test("'!send' with a reference but no quote approves the newest draft of THAT escalation", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    script = () => ({ customer_reply: "Hi Jane, yes we have the 15kg bag.", items: [] });
    await staffSays("Yes we have the 15kg", { quoted: jane.noticeWaId });

    await staffSays(`#${jane.ref} !send`);
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to_jid, JANE.chat);
    assert.equal(sent[0].body, "Hi Jane, yes we have the 15kg bag.");
  });

  test("'!send' with nothing to send says so and sends nothing", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const r = await staffSays("!send", { quoted: jane.noticeWaId });
    assert.equal((await customerMessages()).length, 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), /no draft to send yet/);
  });

  test("'!send <text>' sends the staff's own wording, exactly, and still learns from it", async () => {
    script = () => ({
      customer_reply: "ignored in classify_only",
      items: [{ category: "durable", kind: "hours", title: "Opening hours", content: "Open Monday to Saturday, 8am to 5pm.", evidence: "We open Monday to Saturday 8am to 5pm" }],
    });
    const jane = await escalate(JANE, "When are you open?");
    const text = "Hi Jane! We open Monday to Saturday 8am to 5pm.";
    await staffSays(`!send ${text}`, { quoted: jane.noticeWaId });
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, text);
    assert.equal(analyzerCalls[0].mode, "classify_only");
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where category = 'durable'"), 1);
  });

  test("a stale draft (the customer wrote again) is not sent on 'send'", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    await new Promise((r) => setTimeout(r, 30));
    // The customer's next message opens a NEW escalation (this one is answered).
    const next = await escalate(MARCUS, "Actually make it two bags");
    assert.notEqual(next.id, marcus.id);
    const r = await staffSays("send", { quoted: marcus.noticeWaId });
    assert.equal((await customerMessages()).length, 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), /customer has written again/);
  });

  test("a stale draft is also caught from the stored conversation", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    await new Promise((r) => setTimeout(r, 30));
    await pg.run(
      `insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id)
       values ('dog_food', ${lit(MARCUS.chat)}, 'inbound', 'wait, make it Saturday', 'IN-1');`
    );
    const r = await staffSays("send", { quoted: marcus.noticeWaId });
    assert.equal((await customerMessages()).length, 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), /customer has written again/);
  });

  test("the same approval or the same text is never sent twice", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    await staffSays("send", { quoted: marcus.noticeWaId });
    const again = await staffSays("send", { quoted: marcus.noticeWaId });
    await staffSays("!send", { quoted: marcus.noticeWaId });
    assert.equal((await customerMessages()).length, 1);
    assert.match(again.outbox.map((o) => o.body).join("\n"), /already sent/);
    // A different approval message is a different WhatsApp event, not a repeat of one.
    assert.equal(await count("select 1 from public.ai_agent_staff_answers where command = 'send'"), 3);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  test("a repeated WhatsApp event records, drafts and posts exactly once", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const first = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, id: "STAFF-DUP-1" });
    const second = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, id: "STAFF-DUP-1" });
    assert.equal(first.status, "done");
    assert.equal(second.status, "duplicate");
    assert.ok(second.outbox.every((o) => o.send === false), "a replay never asks the bridge to send again");
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 1);
    assert.equal((await drafts()).length, 1);
    assert.equal(analyzerCalls.length, 1);
  });

  test("a second staff member sending the same answer does not repeat the draft in the group", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 2, "both answers are on the audit record");
    assert.equal((await drafts()).length, 1, "but the identical draft is posted once");
  });

  test("the agent's own staff-group messages coming back are never read as staff instructions", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    const echoById = await staffSays(draft.body, { id: draft.whatsapp_message_id!, fromMe: true });
    assert.equal(echoById.status, "ignored");
    // Before the ack landed: recognised by identical text.
    const echoByBody = await staffSays(draft.body, { id: "UNKNOWN-ID-1", fromMe: true });
    assert.equal(echoByBody.status, "ignored");
    // A forward/paste of it, even quoting the escalation, is not an answer either.
    const pasted = await staffSays(`${draft.body}\nthanks`, { quoted: marcus.noticeWaId });
    assert.equal(pasted.status, "done");
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 1);
    assert.equal((await customerMessages()).length, 0);
    assert.ok(r.waIds[Object.keys(r.waIds)[0]]);
  });

  // ── Customer messaging disabled ──────────────────────────────────────────

  test("Observe mode: the draft is posted for staff to copy, and 'send' still sends nothing", async () => {
    await configure({ mode: "observe", staff_notices_enabled: true });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.deepEqual(r.outbox.map((o) => o.kind), ["staff_draft"], "a draft is allowed in Observe when staff notices are on");
    const [draft] = await drafts(marcus.id);
    assert.match(draft.body, /Not sent: the AI agent is in Observe mode, so it never messages customers/);
    assert.match(draft.body, /copy this draft/);
    assert.doesNotMatch(draft.body, /reply to this message with "send"/);

    const sendAttempt = await staffSays("!send", { quoted: draft.whatsapp_message_id });
    const exact = await staffSays("!send Hi Marcus, yes we do", { quoted: marcus.noticeWaId });
    assert.ok(sendAttempt.outbox.every((o) => o.kind !== "staff_relay"));
    assert.ok(exact.outbox.every((o) => o.kind !== "staff_relay"));
    assert.equal((await customerMessages()).length, 0);
    assert.equal(await count("select 1 from public.ai_agent_outbox where kind in " + CUSTOMER_KINDS), 0);
    const [esc] = await rows<{ context: { answer_not_relayed?: string } }>("select context from public.ai_agent_escalations");
    assert.equal(esc.context.answer_not_relayed, "observe_mode");
  });

  test("Observe mode with staff notices off: staff hear nothing, the answer is still recorded", async () => {
    await configure({ mode: "observe", staff_notices_enabled: false });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.deepEqual(r.outbox, []);
    assert.equal((await drafts()).length, 0);
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 1);
    assert.equal((await customerMessages()).length, 0);
  });

  test("an authorized reply is withheld — with the reason stated — for takeover, exclusion, contact scope and recent human activity", async () => {
    const cases: { name: string; setup: () => Promise<void>; message: RegExp }[] = [
      {
        name: "human takeover",
        setup: () => pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, control) values ('dog_food', ${lit(MARCUS.chat)}, 'human');`).then(() => undefined),
        message: /this chat is on human takeover/,
      },
      {
        name: "excluded contact",
        setup: () => pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(MARCUS.chat)}, 'exclude');`).then(() => undefined),
        message: /excluded from AI messaging/,
      },
      {
        name: "contact not on the selected list",
        setup: () => configure({ contact_scope: "selected" }),
        message: /isn't on the list of contacts the AI may message/,
      },
      {
        name: "a person on the team messaged the customer recently",
        setup: () =>
          pg.run(
            `insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id, timestamp)
             values ('dog_food', ${lit(MARCUS.chat)}, 'outbound', 'Hi Marcus, one moment', 'HUMAN-1', now());`
          ).then(() => undefined),
        message: /someone on the team messaged this customer/,
      },
    ];
    for (const c of cases) {
      await beforeEachReset();
      const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
      await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
      await c.setup();
      const r = await staffSays("!send", { quoted: marcus.noticeWaId });
      assert.equal((await customerMessages()).length, 0, c.name);
      const text = r.outbox.map((o) => o.body).join("\n");
      assert.match(text, /Draft reply for/, c.name);
      assert.match(text, c.message, c.name);
      assert.doesNotMatch(text, /human_takeover|contact_excluded|contact_not_permitted|staff_recently_active/, c.name);
    }
  });

  test("a model failure still records the answer and tells staff plainly — no customer message", async () => {
    script = () => null;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    assert.match(draft.body, /Answer saved for #/);
    assert.match(draft.body, /I couldn't prepare a draft just now/);
    assert.match(draft.body, /!send <your wording>/);
    const [a] = await answers();
    assert.equal(a.state, "done");
    assert.equal(a.withheld_reason, "draft_unavailable");
    assert.ok(a.error);
    assert.equal((await customerMessages()).length, 0);
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 0, "nothing is learned from an unanalysed answer");
  });

  test("a draft that adds an unstated price is held back and cannot be approved with 'send'", async () => {
    script = () => ({ customer_reply: "Hi Marcus, it is EC$999 and we deliver Friday.", items: [] });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays("Yes we have it, delivery Friday", { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    assert.match(draft.body, /needs a quick check first/);
    const r = await staffSays("send", { quoted: marcus.noticeWaId });
    assert.equal((await customerMessages()).length, 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), /needs a quick check/);
    // Their own wording is theirs to send.
    await staffSays("!send Hi Marcus, yes we have it and can deliver Friday", { quoted: marcus.noticeWaId });
    assert.equal((await customerMessages()).length, 1);
  });

  test("the bridge not delivering an authorized reply is reported to the staff group, once", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    // Approve, but have the bridge refuse (global send switch off) instead of sending.
    const result = await decide.processBridgeMessage({
      businessSlug: "dog_food",
      whatsappMessageId: "STAFF-APPROVE-KILL",
      chatId: GROUP,
      contactNumber: null,
      fromMe: false,
      text: "send",
      hasMedia: false,
      quotedMessageId: marcus.noticeWaId,
      senderJid: STAFF,
      timestamp: new Date().toISOString(),
    });
    const relay = result.outbox.find((o) => o.kind === "staff_relay")!;
    assert.ok(relay);
    await outbox.ackOutbox({ outboxId: relay.id, status: "failed", whatsappMessageId: null, error: "bridge_send_disabled: AGENT_SEND_ENABLED=false" });
    await outbox.ackOutbox({ outboxId: relay.id, status: "failed", whatsappMessageId: null, error: "bridge_send_disabled: AGENT_SEND_ENABLED=false" });

    const feedback = await rows<{ body: string; status: string; to_jid: string }>("select body, status, to_jid from public.ai_agent_outbox where kind = 'staff_feedback'");
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].to_jid, GROUP);
    assert.match(feedback[0].body, new RegExp(`Reply not sent for #${marcus.ref}`));
    assert.match(feedback[0].body, /switched off for the whole system/);
    assert.doesNotMatch(feedback[0].body, /bridge_send_disabled|AGENT_SEND_ENABLED/);

    // The same text may be approved again once it provably did not go out; the earlier failure does not block it.
    await staffSays("send", { quoted: marcus.noticeWaId });
    const retried = await customerMessages();
    assert.equal(retried.filter((m) => m.status === "dispatched" || m.status === "sent").length, 1);
  });

  // ── Knowledge classification ─────────────────────────────────────────────

  const MIXED =
    "The 15kg bag of dog food is now EC$120, that's our standard price. We're out of the 20kg bags until Thursday. She always wants delivery in the morning. I'll give her 10% off this time.";
  const mixedScript = (): Analysis => ({
    customer_reply: "Hi Jane, the 15kg bag is EC$120. Sorry, the 20kg bags are out until Thursday. We'll deliver in the morning.",
    items: [
      { category: "durable", kind: "price", title: "Dog food 15kg bag", content: "A 15kg bag of dog food costs EC$120.", evidence: "The 15kg bag of dog food is now EC$120, that's our standard price" },
      { category: "temporary", title: "20kg stock", content: "The 20kg bags are out of stock until Thursday.", evidence: "We're out of the 20kg bags until Thursday", valid_hours: 72, scope: "business" },
      { category: "customer_specific", title: "Delivery time", content: "Prefers delivery in the morning.", evidence: "She always wants delivery in the morning" },
      { category: "one_off", title: "Discount", content: "Jane gets 10% off this time.", evidence: "I'll give her 10% off this time" },
    ],
  });

  test("a mixed staff answer is split: durable → candidate, temporary → bounded, customer-specific → that customer, one-off → audit only", async () => {
    script = () => mixedScript();
    const jane = await escalate(JANE, "Price of the 15kg? And the 20kg? Can it come mornings?");
    const marcus = await escalate(MARCUS, "Anything for me?");
    const r = await staffSays(MIXED, { quoted: jane.noticeWaId, id: "STAFF-MIXED" });

    // Durable: a candidate for admin approval — with its source — and NOT knowledge.
    const candidates = await rows<Record<string, any>>("select * from public.ai_agent_learning_candidates");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].category, "durable");
    assert.equal(candidates[0].status, "pending");
    assert.equal(candidates[0].staff_answer, "A 15kg bag of dog food costs EC$120.");
    assert.equal(candidates[0].suggested_kind, "price");
    assert.equal(candidates[0].source_message, MIXED);
    assert.equal(candidates[0].ref_code, jane.ref);
    assert.equal(candidates[0].escalation_id, jane.id);
    assert.equal(candidates[0].business_slug, "dog_food");
    assert.ok(candidates[0].source_message_at);
    assert.equal(candidates[0].source_message_id, "STAFF-MIXED");
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0, "nothing reaches knowledge without an admin");

    // Temporary: kept with an expiry (the model's 72h), never in knowledge or memory.
    const [a] = await answers();
    assert.equal(a.temporary_facts.length, 1);
    assert.equal(a.temporary_facts[0].content, "The 20kg bags are out of stock until Thursday.");
    assert.ok(Date.parse(a.valid_until) > Date.now() + 60 * 3_600_000 && Date.parse(a.valid_until) < Date.now() + 73 * 3_600_000);
    assert.equal(await count("select 1 from public.ai_agent_knowledge where content ilike '%20kg%'"), 0);
    assert.equal(await count("select 1 from public.ai_agent_customer_memory where content ilike '%20kg%'"), 0);

    // Customer-specific: Jane's record only.
    const memory = await rows<Record<string, any>>("select * from public.ai_agent_customer_memory");
    assert.equal(memory.length, 1);
    assert.equal(memory[0].customer_key, JANE.phone);
    assert.equal(memory[0].source, "staff_confirmed");
    assert.equal(memory[0].kind, "note");
    assert.equal(memory[0].content, "Prefers delivery in the morning.");
    assert.equal(memory[0].source_escalation_id, jane.id);
    assert.equal(await count(`select 1 from public.ai_agent_customer_memory where customer_key = ${lit(MARCUS.phone)} or customer_key = ${lit("chat:" + MARCUS.chat)}`), 0);

    // One-off: recorded on the audit row only.
    const dispositions = Object.fromEntries((a.items as { category: string; disposition: string }[]).map((i) => [i.category, i.disposition]));
    assert.deepEqual(dispositions, { durable: "candidate", temporary: "temporary", customer_specific: "customer_memory", one_off: "recorded_only" });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where staff_answer ilike '%10%'"), 0);
    assert.equal(await count("select 1 from public.ai_agent_customer_memory where content ilike '%10%'"), 0);
    assert.equal(a.body, MIXED, "the staff's words are kept verbatim for audit");
    assert.equal(marcus.ref === jane.ref, false);

    // What staff read: concise, no discount advertised as a rule, no codes.
    const [draft] = await drafts(jane.id);
    assert.match(draft.body, /Suggested for the knowledge base \(admin approves\)/);
    assert.match(draft.body, /Used for now only, not saved as a rule/);
    assert.match(draft.body, /Kept on this customer's record only/);
    assert.doesNotMatch(draft.body, /10%/);
    assert.ok(draft.body.split("\n").length <= 10, draft.body);
    assert.equal(r.status, "done");
    assert.equal((await customerMessages()).length, 0);
  });

  test("temporary facts are usable only in their conversation (or when business-wide) and only until they expire", async () => {
    script = () => ({
      customer_reply: null,
      items: [
        { category: "temporary", title: "20kg", content: "The 20kg bags are out of stock until Thursday.", evidence: "We're out of the 20kg bags until Thursday", scope: "conversation" },
        { category: "temporary", title: "Capacity", content: "No more deliveries today.", evidence: "no more deliveries today", scope: "business", valid_hours: 6 },
      ],
    });
    const jane = await escalate(JANE, "Do you have the 20kg?");
    await staffSays("We're out of the 20kg bags until Thursday, and no more deliveries today", { quoted: jane.noticeWaId });

    const forJane = await knowledge.loadLiveStaffFacts("dog_food", JANE.chat);
    assert.deepEqual(forJane.map((f) => f.content).sort(), ["No more deliveries today.", "The 20kg bags are out of stock until Thursday."]);
    const forMarcus = await knowledge.loadLiveStaffFacts("dog_food", MARCUS.chat);
    assert.deepEqual(forMarcus.map((f) => f.content), ["No more deliveries today."], "the stock fact stays in Jane's conversation");
    assert.deepEqual(await knowledge.loadLiveStaffFacts("by_sea", JANE.chat), [], "never across businesses");
    // Expiry.
    const later = new Date(Date.now() + 8 * 3_600_000);
    assert.deepEqual((await knowledge.loadLiveStaffFacts("dog_food", JANE.chat, later)).map((f) => f.content), ["The 20kg bags are out of stock until Thursday."]);
    assert.deepEqual(await knowledge.loadLiveStaffFacts("dog_food", JANE.chat, new Date(Date.now() + 100 * 3_600_000)), []);
    // And the agent's approved-knowledge loader never sees them.
    assert.equal((await dbmod.loadActiveKnowledge("dog_food")).length, 0);
  });

  test("customer memory capture off: customer-specific information is recorded on the answer only", async () => {
    await configure({ customer_memory_enabled: false });
    script = () => mixedScript();
    const jane = await escalate(JANE, "Mornings?");
    await staffSays(MIXED, { quoted: jane.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_customer_memory"), 0);
    const [a] = await answers();
    const item = (a.items as { category: string; disposition: string; note?: string }[]).find((i) => i.category === "customer_specific");
    assert.deepEqual([item?.disposition, item?.note], ["recorded_only", "customer_memory_off"]);
  });

  test("the model cannot launder a one-off deal or a shortage into durable knowledge", async () => {
    script = () => ({
      customer_reply: null,
      items: [
        { category: "durable", kind: "price", title: "Dog food", content: "A 15kg bag of dog food costs EC$100.", evidence: "I'll do the 15kg for EC$100 just this once" },
        { category: "durable", kind: "product", title: "20kg", content: "The 20kg bags are out of stock.", evidence: "we are out of the 20kg bags" },
      ],
    });
    const jane = await escalate(JANE, "Any deals?");
    await staffSays("I'll do the 15kg for EC$100 just this once, we are out of the 20kg bags", { quoted: jane.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 0);
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0);
    const [a] = await answers();
    assert.deepEqual((a.items as { category: string }[]).map((i) => i.category).sort(), ["one_off", "temporary"]);
  });

  test("candidates are isolated per business", async () => {
    script = () => ({
      customer_reply: null,
      items: [{ category: "durable", kind: "price", title: "15kg", content: "A 15kg bag costs EC$120.", evidence: "15kg bag costs EC$120" }],
    });
    const sea = await escalate(JANE, "Price?", "by_sea", SEA_GROUP);
    await staffSays("The 15kg bag costs EC$120", { quoted: sea.noticeWaId, biz: "by_sea", group: SEA_GROUP });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where business_slug = 'by_sea'"), 1);
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where business_slug = 'dog_food'"), 0);
    assert.equal(await count("select 1 from public.ai_agent_staff_answers where business_slug = 'dog_food'"), 0);
  });

  // ── Conflicts and admin approval ─────────────────────────────────────────

  const PRICE_ANSWER = "The standard price for the 15kg bag of dog food is now EC$120";
  const priceScript = (): Analysis => ({
    customer_reply: "Hi Jane, the 15kg bag is EC$120.",
    items: [
      { category: "durable", kind: "price", title: "Dog food 15kg bag", content: "A 15kg bag of dog food costs EC$120.", evidence: "standard price for the 15kg bag of dog food is now EC$120" },
    ],
  });
  const seedKnowledge = (id: string, kind: string, title: string, content: string) =>
    pg.run(
      `insert into public.ai_agent_knowledge (id, business_slug, kind, title, content, status, source, approved_at)
       values (${lit(id)}, 'dog_food', ${lit(kind)}, ${lit(title)}, ${lit(content)}, 'approved', 'admin', now());`
    );
  const OLD = "11111111-1111-1111-1111-111111111111";
  const ADMIN = "22222222-2222-2222-2222-222222222222";

  async function conflictingCandidate() {
    await seedKnowledge(OLD, "price", "Dog food 15kg bag", "A 15kg bag of dog food costs EC$110.");
    script = () => priceScript();
    const jane = await escalate(JANE, "How much is the 15kg?");
    const r = await staffSays(PRICE_ANSWER, { quoted: jane.noticeWaId });
    const [candidate] = await rows<Record<string, any>>("select * from public.ai_agent_learning_candidates");
    return { jane, candidate, draft: (await drafts(jane.id))[0], r };
  }

  test("a changed price is surfaced as a conflict, never applied, and flagged to staff and admin", async () => {
    const { candidate, draft } = await conflictingCandidate();
    assert.equal(candidate.conflicts.length, 1);
    assert.equal(candidate.conflicts[0].id, OLD);
    assert.equal(candidate.conflicts[0].severity, "conflict");
    assert.match(draft.body, /differs from what's on file — an admin will review it before anything changes/);
    // The approved entry is untouched.
    const [old] = await rows<{ content: string; status: string }>(`select content, status from public.ai_agent_knowledge where id = ${lit(OLD)}`);
    assert.deepEqual(old, { content: "A 15kg bag of dog food costs EC$110.", status: "approved" });
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 1);
  });

  test("approving a conflicting candidate needs an explicit choice; 'replace' archives the old entry atomically", async () => {
    const { candidate } = await conflictingCandidate();
    const base = { businessSlug: "dog_food", candidateId: candidate.id, adminId: ADMIN, kind: "price", title: "Dog food 15kg bag", content: candidate.staff_answer };

    const refused = await learning.approveCandidate({ ...base, resolution: undefined, replaceKnowledgeId: undefined });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.status, 409);
    assert.equal(!refused.ok && refused.conflicts?.[0].id, OLD);
    const badTarget = await learning.approveCandidate({ ...base, resolution: "replace", replaceKnowledgeId: "99999999-9999-9999-9999-999999999999" });
    assert.equal(!badTarget.ok && badTarget.status, 400);
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 1, "refused approvals change nothing");
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where status = 'pending'"), 1);

    const ok = await learning.approveCandidate({ ...base, resolution: "replace", replaceKnowledgeId: OLD });
    assert.equal(ok.ok, true);
    const entries = await rows<{ id: string; status: string; content: string; source: string; source_ref: string | null }>("select id, status, content, source, source_ref from public.ai_agent_knowledge order by created_at");
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.find((e) => e.id === OLD)?.status, "archived");
    const created = entries.find((e) => e.id !== OLD)!;
    assert.deepEqual([created.status, created.content, created.source], ["approved", "A 15kg bag of dog food costs EC$120.", "staff_correction"]);
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where status = 'approved'"), 1);
    // The agent now sees only the new price.
    assert.deepEqual((await dbmod.loadActiveKnowledge("dog_food")).map((k) => k.content), ["A 15kg bag of dog food costs EC$120."]);
    // Auditable.
    assert.equal(await count("select 1 from public.ai_agent_audit_log where action = 'learning.approve'"), 1);

    const again = await learning.approveCandidate({ ...base, resolution: "replace", replaceKnowledgeId: OLD });
    assert.equal(!again.ok && again.status, 409);
  });

  test("'keep both' adds the new entry beside the old one, only when chosen", async () => {
    const { candidate } = await conflictingCandidate();
    const ok = await learning.approveCandidate({
      businessSlug: "dog_food", candidateId: candidate.id, adminId: ADMIN, kind: "price", title: "Dog food 15kg bag (new)",
      content: candidate.staff_answer, resolution: "keep_both", replaceKnowledgeId: undefined,
    });
    assert.equal(ok.ok, true);
    assert.equal(await count("select 1 from public.ai_agent_knowledge where status = 'approved'"), 2);
  });

  test("two admins approving the same candidate at once create exactly one entry", async () => {
    script = () => priceScript();
    const jane = await escalate(JANE, "How much is the 15kg?");
    await staffSays(PRICE_ANSWER, { quoted: jane.noticeWaId });
    const [candidate] = await rows<Record<string, any>>("select * from public.ai_agent_learning_candidates");
    const approve = () =>
      learning.approveCandidate({ businessSlug: "dog_food", candidateId: candidate.id, adminId: ADMIN, kind: "price", title: "Dog food 15kg bag", content: candidate.staff_answer, resolution: undefined, replaceKnowledgeId: undefined });
    const results = await Promise.all([approve(), approve()]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 1);
  });

  test("a candidate from one business cannot be approved from another", async () => {
    script = () => priceScript();
    const jane = await escalate(JANE, "How much is the 15kg?");
    await staffSays(PRICE_ANSWER, { quoted: jane.noticeWaId });
    const [candidate] = await rows<Record<string, any>>("select * from public.ai_agent_learning_candidates");
    const r = await learning.approveCandidate({ businessSlug: "by_sea", candidateId: candidate.id, adminId: ADMIN, kind: "price", title: "x", content: "A 15kg bag costs EC$120.", resolution: undefined, replaceKnowledgeId: undefined });
    assert.equal(!r.ok && r.status, 404);
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0);
  });

  test("a fact that is already approved creates no candidate; the same fact is proposed once per escalation", async () => {
    await seedKnowledge(OLD, "price", "Dog food 15kg bag", "A 15kg bag of dog food costs EC$120.");
    script = () => priceScript();
    const jane = await escalate(JANE, "How much is the 15kg?");
    await staffSays(PRICE_ANSWER, { quoted: jane.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 0);
    const [a] = await answers();
    assert.equal(a.items[0].disposition, "already_known");

    await pg.run(`delete from public.ai_agent_knowledge;`);
    await staffSays(PRICE_ANSWER + " ok", { quoted: jane.noticeWaId });
    await staffSays(PRICE_ANSWER + " yes", { quoted: jane.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 1, "no re-nagging with the same fact");
  });

  // ── Admin dashboard path ─────────────────────────────────────────────────

  test("a dashboard answer goes through the same audit and classification pipeline", async () => {
    script = () => priceScript();
    const jane = await escalate(JANE, "How much is the 15kg?");
    const settings = (await dbmod.loadSettings("dog_food"))!;
    const [row] = await rows<Record<string, any>>("select * from public.ai_agent_escalations");
    const result = await adminSend.sendAdminAnswer({
      settings, escalation: row as never, text: "The standard price for the 15kg bag of dog food is now EC$120", adminId: ADMIN, basedOn: row.updated_at,
    });
    assert.ok(result.ok && result.sent && result.queued === 1);
    const [a] = await answers();
    assert.deepEqual([a.source, a.command, a.customer_action, a.ref_code], ["admin_ui", "send", "sent", jane.ref]);
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates where category = 'durable'"), 1);
    assert.equal((await customerMessages()).length, 1);
  });

  // ── SQL guarantees ───────────────────────────────────────────────────────

  test("SQL: the outbox accepts staff_draft and rejects unknown kinds; Observe claims a draft only with staff notices on", async () => {
    const insert = (kind: string, to: string, key: string) =>
      pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key) values ('dog_food', ${lit(JANE.chat)}, ${lit(kind)}, ${lit(to)}, 'x', ${lit(key)});`);
    await assert.rejects(insert("staff_telepathy", GROUP, "k0"));
    await insert("staff_draft", GROUP, "k1");
    await insert("staff_relay", JANE.chat, "k2");
    await insert("staff_feedback", GROUP, "k3");

    await configure({ mode: "observe", staff_notices_enabled: false });
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_outbox('dog_food', 10);"), "0");
    await configure({ mode: "observe", staff_notices_enabled: true });
    const claimed = await pg.run("select kind from public.claim_ai_agent_outbox('dog_food', 10) order by kind;");
    assert.equal(claimed, "staff_draft", "Observe hands out only the staff-group draft, never the relay or feedback");
    await configure({ mode: "assisted" });
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_outbox('dog_food', 10);"), "2");
  });

  test("SQL: one WhatsApp message is one staff answer per business; the audit row has no foreign keys to purgeable data", async () => {
    const ins = (biz: string) =>
      pg.run(
        `insert into public.ai_agent_staff_answers (business_slug, escalation_id, ref_code, chat_id, source_message_id, command, body)
         values (${lit(biz)}, gen_random_uuid(), 'E-AAAAA', 'c', 'MSG-1', 'answer', 'x');`
      );
    await ins("dog_food");
    await assert.rejects(ins("dog_food"));
    await ins("by_sea");
    assert.equal(await pg.run("select count(*) from pg_constraint where conrelid = 'public.ai_agent_staff_answers'::regclass and contype = 'f';"), "0");
  });

  test("SQL: deleting a customer's data removes their staff answers, only theirs, only in their business", async () => {
    const jane = await escalate(JANE, "Mornings?");
    const marcus = await escalate(MARCUS, "Anything?");
    script = () => mixedScript();
    await staffSays(MIXED, { quoted: jane.noticeWaId });
    await staffSays(MIXED + " again", { quoted: marcus.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 2);
    await pg.run(`select public.forget_ai_agent_customer('dog_food', array[${lit(JANE.chat)}], ${lit(JANE.phone)}, false, true);`);
    const left = await rows<{ chat_id: string }>("select chat_id from public.ai_agent_staff_answers");
    assert.deepEqual(left.map((l) => l.chat_id), [MARCUS.chat]);
    assert.equal(await count(`select 1 from public.ai_agent_customer_memory where customer_key = ${lit(JANE.phone)}`), 0);
    const candidates = await rows<{ question: string | null; source_message: string | null; escalation_id: string }>("select question, source_message, escalation_id from public.ai_agent_learning_candidates");
    for (const c of candidates) {
      if (c.escalation_id === jane.id) assert.deepEqual([c.question, c.source_message], [null, null]);
      else assert.ok(c.source_message);
    }
  });

  // ── Existing safeguards still hold ───────────────────────────────────────

  test("a disabled business ignores staff-group messages entirely", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await configure({ enabled: false });
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal(r.status, "ignored");
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 0);
  });

  test("a closed escalation is never answered, drafted or sent", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays("!close", { quoted: marcus.noticeWaId });
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.match(r.outbox.map((o) => o.body).join("\n"), /already closed/);
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 0);
    assert.equal((await customerMessages()).length, 0);
  });

  test("commands keep working: !note, !takeover and !resume are not answers", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays("!note called him, no answer", { quoted: marcus.noticeWaId });
    await staffSays("!takeover", { quoted: marcus.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_staff_answers"), 0);
    assert.equal(analyzerCalls.length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_conversations where chat_id = ${lit(MARCUS.chat)} and control = 'human'`), 1);
  });

  // ══ Production-safety audit ══════════════════════════════════════════════
  // Who may authorize a send, one policy for WhatsApp and the dashboard, visible
  // failures, safe retries, strict draft targeting, Observe, temporary facts.

  const OTHER = "17585550002@s.whatsapp.net";
  const SEND_TEXT = "Hi Marcus, yes we have the 20kg Pedigree and can deliver it Friday";
  const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;
  const escalationRow = async (id: string) => (await rows<Record<string, any>>(`select * from public.ai_agent_escalations where id = ${lit(id)}`))[0];
  const everyCustomerRow = () => count(`select 1 from public.ai_agent_outbox where kind in ${CUSTOMER_KINDS}`);

  // ── 1. Authorized senders ────────────────────────────────────────────────

  test("a sender who is not on the allow-list cannot make the agent message a customer — by approval or by typed text", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    // Anyone in the group can write an answer: it is information, and becomes a draft.
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId, sender: OTHER });
    const [draft] = await drafts(marcus.id);
    assert.ok(draft?.whatsapp_message_id);

    const callsBefore = analyzerCalls.length;
    const approve = await staffSays("send", { quoted: draft.whatsapp_message_id, sender: OTHER });
    const typed = await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId, sender: OTHER });
    assert.equal(await everyCustomerRow(), 0);
    assert.equal(analyzerCalls.length, callsBefore, "words from someone who may not authorize sends are not learned from");
    const shown = [...approve.outbox, ...typed.outbox].map((o) => o.body).join("\n");
    assert.match(shown, /you're not on this business's list of people who can send customer replies/);
    assert.doesNotMatch(shown, /sender_not_authorized/);

    const attempts = (await answers()).filter((a) => a.command === "send");
    assert.equal(attempts.length, 2);
    for (const a of attempts) {
      assert.equal(a.sender_authorized, false);
      assert.equal(a.sender_id, "17585550002");
      assert.equal(a.withheld_reason, "sender_not_authorized");
      assert.equal(a.customer_action, "withheld");
    }
    assert.equal((await answers()).find((a) => a.command === "answer")!.sender_authorized, false);

    // The authorized colleague can still approve the very same draft.
    await staffSays("send", { quoted: draft.whatsapp_message_id });
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to_jid, MARCUS.chat);
  });

  test("default: with nobody authorized, a reply still becomes a draft but no one can send it", async () => {
    await configure({ staff_authorized_senders: [] });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal((await drafts(marcus.id)).length, 1, "drafting needs no authorization");
    await staffSays("send", { quoted: marcus.noticeWaId });
    await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId });
    assert.equal(await everyCustomerRow(), 0);
  });

  test("identities are verified: @lid digits are not a phone number, an absent sender is nobody, an exact @lid entry works", async () => {
    await configure({ staff_authorized_senders: ["17585550001"] });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const attempt = (opts: { sender: string | null; senderPhone?: string | null }) =>
      staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId, ...opts });

    await attempt({ sender: "17585550001@lid" }); // the @lid's digits merely look like the authorized number
    await attempt({ sender: "17585550001@lid", senderPhone: "17585550001" }); // a "phone" that is just the @lid's own digits proves nothing
    await attempt({ sender: "99887766554433@lid", senderPhone: "17585550003" }); // a verified phone that is not on the list
    await attempt({ sender: null }); // no participant at all
    assert.equal(await everyCustomerRow(), 0);

    // A phone number WhatsApp reported for the @lid, on the list: authorized.
    await attempt({ sender: "99887766554433@lid", senderPhone: "17585550001" });
    assert.equal(await everyCustomerRow(), 1);

    // An exact @lid entry authorizes exactly that @lid, with no phone needed.
    await beforeEachReset();
    await configure({ staff_authorized_senders: ["55512345678901@lid"] });
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    await staffSays("!send Hi Jane, yes we do", { quoted: jane.noticeWaId, sender: "55512345678902@lid" });
    assert.equal(await everyCustomerRow(), 0);
    await staffSays("!send Hi Jane, yes we do", { quoted: jane.noticeWaId, sender: "55512345678901@lid" });
    assert.equal(await everyCustomerRow(), 1);
  });

  test("authorization is per business: being authorized in one business grants nothing in another", async () => {
    await configure({ staff_authorized_senders: ["17585550001"] }, "dog_food");
    await configure({ staff_authorized_senders: [] }, "by_sea", SEA_GROUP);
    const seaJane = await escalate(JANE, "Do you have the 15kg bag?", "by_sea", SEA_GROUP);
    await staffSays("!send Hi Jane, yes we do", { quoted: seaJane.noticeWaId, biz: "by_sea", group: SEA_GROUP });
    assert.equal(await everyCustomerRow(), 0, "the same person is not authorized for by_sea");

    const dogJane = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays("!send Hi Marcus, yes we do", { quoted: dogJane.noticeWaId });
    assert.equal((await customerMessages(MARCUS.chat)).length, 1);
    assert.equal((await customerMessages(JANE.chat)).length, 0);
  });

  // ── 2. Dashboard sends use the same policy ───────────────────────────────

  test("dashboard: every restriction that stops a WhatsApp send stops a dashboard send too", async () => {
    const cases: { name: string; setup: () => Promise<void>; reason: string }[] = [
      { name: "human takeover", reason: "human_takeover", setup: () => pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, control) values ('dog_food', ${lit(MARCUS.chat)}, 'human');`).then(() => undefined) },
      { name: "excluded contact", reason: "contact_excluded", setup: () => pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(MARCUS.chat)}, 'exclude');`).then(() => undefined) },
      { name: "contact scope", reason: "contact_not_permitted", setup: () => configure({ contact_scope: "selected" }) },
      {
        name: "recent human activity",
        reason: "staff_recently_active",
        setup: () => pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id, timestamp) values ('dog_food', ${lit(MARCUS.chat)}, 'outbound', 'one moment', 'HUMAN-DASH', now());`).then(() => undefined),
      },
      { name: "agent switched off", reason: "agent_disabled", setup: () => configure({ enabled: false }) },
    ];
    for (const c of cases) {
      await beforeEachReset();
      const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
      const row = await escalationRow(marcus.id);
      await c.setup();
      const r = await adminSend.sendAdminAnswer({ settings: await settingsOf(), escalation: row as never, text: SEND_TEXT, adminId: ADMIN, basedOn: row.updated_at });
      assert.ok(!r.ok, c.name);
      assert.equal(!r.ok && r.reason, c.reason, c.name);
      assert.equal(!r.ok && r.status, 409, c.name);
      assert.equal(await everyCustomerRow(), 0, `${c.name}: nothing queued, not even pending`);
    }
  });

  test("dashboard: a stale view, an oversized text, a foreign business and Observe mode cannot send either", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const viewed = await escalationRow(marcus.id);
    // The customer writes again after the admin loaded the page.
    await new Promise((r) => setTimeout(r, 20));
    await escalations.createOrAppendEscalation({
      businessSlug: "dog_food", chatId: MARCUS.chat, contactNumber: MARCUS.phone, customerName: "Marcus", reasons: ["model_uncertain"],
      priority: "normal", customerMessage: "Actually make it two bags", draftReply: null, summary: null, orderRequest: null, eventId: null,
    });
    const settings = await settingsOf();
    const stale = await adminSend.sendAdminAnswer({ settings, escalation: (await escalationRow(marcus.id)) as never, text: SEND_TEXT, adminId: ADMIN, basedOn: viewed.updated_at });
    assert.ok(!stale.ok && stale.reason === "draft_stale");
    const tooLong = await adminSend.sendAdminAnswer({ settings, escalation: (await escalationRow(marcus.id)) as never, text: "x".repeat(1500), adminId: ADMIN, basedOn: new Date().toISOString() });
    assert.ok(!tooLong.ok && tooLong.reason === "draft_needs_review");
    await assert.rejects(
      adminSend.sendAdminAnswer({ settings: await settingsOf("by_sea"), escalation: (await escalationRow(marcus.id)) as never, text: SEND_TEXT, adminId: ADMIN, basedOn: new Date().toISOString() }),
      /different business/
    );
    assert.equal(await everyCustomerRow(), 0);

    // Observe: recorded for review, never queued — by design.
    await configure({ mode: "observe" });
    const observed = await adminSend.sendAdminAnswer({ settings: await settingsOf(), escalation: (await escalationRow(marcus.id)) as never, text: SEND_TEXT, adminId: ADMIN, basedOn: new Date().toISOString() });
    assert.ok(observed.ok && !observed.sent && observed.queued === 0);
    assert.equal(await everyCustomerRow(), 0);
    assert.equal((await escalationRow(marcus.id)).context.answer_not_relayed, "observe_mode");
  });

  test("dashboard: duplicates and unknown delivery outcomes are held exactly like a WhatsApp send", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const send = async () => {
      const row = await escalationRow(marcus.id);
      return adminSend.sendAdminAnswer({ settings: await settingsOf(), escalation: row as never, text: SEND_TEXT, adminId: ADMIN, basedOn: new Date().toISOString() });
    };
    const first = await send();
    assert.ok(first.ok && first.sent && first.queued === 1);
    const [relay] = await rows<{ id: string; created_by: string }>("select id, created_by from public.ai_agent_outbox where kind = 'staff_relay'");
    assert.equal(relay.created_by, ADMIN);

    // A double click while it waits for the bridge.
    const again = await send();
    assert.ok(!again.ok && again.reason === "send_in_progress");
    // The same text from WhatsApp is held by the dashboard's row, too.
    const viaWhatsApp = await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId });
    assert.ok(viaWhatsApp.outbox.every((o) => o.kind !== "staff_relay"));
    assert.equal(await everyCustomerRow(), 1);

    // Dispatched, then failed with an error that does not prove nothing was sent: never resent.
    await pg.run(`update public.ai_agent_outbox set status = 'dispatched', dispatched_at = now() where id = ${lit(relay.id)};`);
    await outbox.ackOutbox({ outboxId: relay.id, status: "failed", whatsappMessageId: null, error: "timeout: no response from WhatsApp" });
    const unknown = await send();
    assert.ok(!unknown.ok && unknown.reason === "send_unconfirmed");
    assert.equal(await everyCustomerRow(), 1);

    // Only a failure that PROVES nothing went out allows another attempt.
    await pg.run(`update public.ai_agent_outbox set error = 'not_sent: socket closed before send' where id = ${lit(relay.id)};`);
    const retried = await send();
    assert.ok(retried.ok && retried.sent);
    assert.equal(await everyCustomerRow(), 2);
  });

  test("the generic escalation action refuses to send, and the dashboard route is guarded by admin auth and the shared policy", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await assert.rejects(
      escalations.applyStaffAction({
        escalation: (await escalationRow(marcus.id)) as never, command: "send", body: SEND_TEXT, settings: await settingsOf(),
        actorKind: "admin", actorId: ADMIN, via: "admin_ui", dedupeBase: "ui:bypass",
      }),
      /planCustomerSend/
    );
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/ai-agent/escalations/route.ts", "utf8");
    const patch = route.slice(route.indexOf("export async function PATCH"));
    assert.ok(patch.indexOf("requireAdmin()") !== -1 && patch.indexOf("requireAdmin()") < patch.indexOf("sendAdminAnswer("));
    assert.doesNotMatch(patch, /staff_relay/, "the route never builds a customer message itself");
    assert.doesNotMatch(patch, /canSend\(/, "mode alone is not the policy");
    const retryRoute = readFileSync("app/api/ai-agent/escalations/retry/route.ts", "utf8");
    assert.ok(retryRoute.indexOf("requireAdmin()") < retryRoute.indexOf("retryStaffAnswer("));
  });

  // ── 3. Failures are visible; retry is safe ───────────────────────────────

  const failingModel = (): Analysis => {
    throw new Error("model exploded");
  };

  test("a staff answer that fails is recorded as failed, shown to staff and in the audit trail — nothing reaches the customer", async () => {
    script = failingModel;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    const r = await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal(r.status, "error");
    const [a] = await answers();
    assert.equal(a.state, "failed");
    assert.match(a.error, /model exploded/);
    const feedback = await rows<{ body: string; status: string; to_jid: string }>("select body, status, to_jid from public.ai_agent_outbox where kind = 'staff_feedback'");
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].to_jid, GROUP);
    assert.match(feedback[0].body, new RegExp(`Something went wrong while handling your message for #${marcus.ref}`));
    assert.match(feedback[0].body, /Nothing was sent to the customer/);
    assert.doesNotMatch(feedback[0].body, /model exploded/, "internals stay out of WhatsApp");
    assert.equal(await count("select 1 from public.ai_agent_audit_log where action = 'staff_answer.failed'"), 1);
    assert.equal(await everyCustomerRow(), 0);
  });

  test("in Observe the failure is on the dashboard (failed answer + audit) and the staff group gets no feedback kind", async () => {
    await configure({ mode: "observe", staff_notices_enabled: true });
    script = failingModel;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    assert.equal((await answers())[0].state, "failed");
    assert.equal(await count("select 1 from public.ai_agent_outbox where kind = 'staff_feedback'"), 0);
    assert.equal(await count("select 1 from public.ai_agent_audit_log where action = 'staff_answer.failed'"), 1);
  });

  test("retry: a failed answer is re-run once, safely, and only an admin-claimed retry can win a race", async () => {
    script = failingModel;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [failed] = await answers();
    script = (text) => (text === MARCUS_ANSWER ? MARCUS_ITEMS() : null);

    const attempts = await Promise.all([
      staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN }),
      staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN }),
    ]);
    assert.equal(attempts.filter((a) => a.ok).length, 1, "exactly one retry runs");
    const [after] = await answers();
    assert.equal(after.state, "done");
    assert.equal(after.retry_count, 1);
    assert.equal(after.error, null);
    assert.equal((await drafts(marcus.id)).length, 1);
    assert.equal(await everyCustomerRow(), 0, "retrying an answer never messages the customer");
    const again = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(!again.ok && again.status === 409 && /not in a failed state/.test(again.error));
    assert.equal(await count("select 1 from public.ai_agent_audit_log where action = 'staff_answer.retry'"), 1);
  });

  test("retry: a failed '!send <text>' that never queued anything is retried once and sends exactly once", async () => {
    script = failingModel;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId });
    assert.equal(await everyCustomerRow(), 0);
    const [failed] = await answers();
    assert.equal(failed.state, "failed");
    assert.match((await rows<{ body: string }>("select body from public.ai_agent_outbox where kind = 'staff_feedback'"))[0].body, /Nothing was sent to the customer/);

    script = () => ({ customer_reply: null, items: [] });
    const retried = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(retried.ok, retried.ok ? "" : retried.error);
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, SEND_TEXT);
    assert.equal(sent[0].to_jid, MARCUS.chat);
    const second = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(!second.ok);
    assert.equal(await everyCustomerRow(), 1);
  });

  test("retry is refused whenever a customer message may already have been sent for the answer", async () => {
    const outcomes: { name: string; settle: (relayId: string) => Promise<void>; allowed: boolean }[] = [
      { name: "still waiting for the bridge", allowed: false, settle: async () => undefined },
      { name: "sent", allowed: false, settle: (id) => outbox.ackOutbox({ outboxId: id, status: "sent", whatsappMessageId: "WA-X", error: null }).then(() => undefined) },
      { name: "failed with an unknown error", allowed: false, settle: (id) => outbox.ackOutbox({ outboxId: id, status: "failed", whatsappMessageId: null, error: "timeout: no response" }).then(() => undefined) },
      { name: "failed after an unknown send (hold)", allowed: false, settle: (id) => outbox.ackOutbox({ outboxId: id, status: "failed", whatsappMessageId: null, error: "held_after_unknown_send" }).then(() => undefined) },
      { name: "failed and provably not sent", allowed: true, settle: (id) => outbox.ackOutbox({ outboxId: id, status: "failed", whatsappMessageId: null, error: "not_sent: socket closed" }).then(() => undefined) },
    ];
    for (const o of outcomes) {
      await beforeEachReset();
      const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
      await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId, ack: false });
      const [relay] = await rows<{ id: string }>("select id from public.ai_agent_outbox where kind = 'staff_relay'");
      await o.settle(relay.id);
      // The request "crashed" after the relay was queued: the answer is left failed.
      await pg.run("update public.ai_agent_staff_answers set state = 'failed', error = 'crashed after queueing';");
      const [failed] = await answers();
      const r = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
      assert.equal(r.ok, o.allowed, `${o.name}: ${r.ok ? "" : r.error}`);
      if (!o.allowed) {
        assert.equal(!r.ok && r.status, 409, o.name);
        assert.match(!r.ok ? r.error : "", /may already have been sent/, o.name);
        assert.equal(await everyCustomerRow(), 1, `${o.name}: no second message`);
        assert.equal((await answers())[0].state, "failed", `${o.name}: left failed for a human to look at`);
      } else {
        assert.equal(await everyCustomerRow(), 2, o.name);
      }
    }
  });

  test("retry re-applies the policy as of now: a sender removed from the list, a closed escalation or a takeover blocks it", async () => {
    script = failingModel;
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(`!send ${SEND_TEXT}`, { quoted: marcus.noticeWaId });
    const [failed] = await answers();
    script = () => ({ customer_reply: null, items: [] });

    await configure({ staff_authorized_senders: [] });
    const removed = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(!removed.ok && /no longer on the authorized list/.test(removed.error));
    await configure({});

    await pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id, control) values ('dog_food', ${lit(MARCUS.chat)}, 'human');`);
    const takeover = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(takeover.ok, "the retry ran, and the policy withheld the send");
    assert.equal(await everyCustomerRow(), 0);
    assert.equal((await answers())[0].withheld_reason, "human_takeover");

    // Another business's admin cannot retry this business's answer.
    await pg.run("update public.ai_agent_staff_answers set state = 'failed';");
    const foreign = await staffGroup.retryStaffAnswer({ businessSlug: "by_sea", answerId: failed.id, adminId: ADMIN });
    assert.ok(!foreign.ok);
    await pg.run("update public.ai_agent_escalations set status = 'resolved';");
    const closed = await staffGroup.retryStaffAnswer({ businessSlug: "dog_food", answerId: failed.id, adminId: ADMIN });
    assert.ok(!closed.ok && /closed/.test(closed.error));
  });

  // ── 4. A quoted reply and "send" resolve to exactly one draft ────────────

  test("quoting a draft and replying 'send' sends THAT draft to THAT customer, never another customer's", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    script = (text) => ({ customer_reply: `Reply for: ${text}`, items: [] });
    await staffSays("jane answer: yes we have it", { quoted: jane.noticeWaId });
    await staffSays("marcus answer: yes we have it too", { quoted: marcus.noticeWaId });
    const [janeDraft] = await drafts(jane.id);
    const [marcusDraft] = await drafts(marcus.id);

    // Quote Marcus's draft but name Jane's reference: contradictory, so nothing is sent.
    await staffSays(`#${jane.ref} send`, { quoted: marcusDraft.whatsapp_message_id });
    assert.equal(await everyCustomerRow(), 0);

    // Quote Jane's draft: only Jane's text goes, only to Jane.
    await staffSays("send", { quoted: janeDraft.whatsapp_message_id });
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to_jid, JANE.chat);
    assert.equal(sent[0].body, "Reply for: jane answer: yes we have it");
    assert.equal((await customerMessages(MARCUS.chat)).length, 0);

    // Another business's group can neither quote nor reference these drafts.
    await staffSays("send", { quoted: marcusDraft.whatsapp_message_id, biz: "by_sea", group: SEA_GROUP });
    await staffSays(`#${marcus.ref} send`, { biz: "by_sea", group: SEA_GROUP });
    assert.equal((await customerMessages(MARCUS.chat)).length, 0);
  });

  test("with several unsent drafts for one customer, 'send' needs the quote — it never guesses the newest", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    script = (text) => ({ customer_reply: `Reply for: ${text}`, items: [] });
    await staffSays("first answer: yes we have it", { quoted: marcus.noticeWaId });
    await staffSays("second answer: no, sorry, it is out of stock", { quoted: marcus.noticeWaId });
    const [newest, oldest] = await drafts(marcus.id).then((d) => [d[1], d[0]]);

    // No quote, only the reference: ambiguous, so refused.
    const bare = await staffSays(`#${marcus.ref} send`);
    assert.equal(await everyCustomerRow(), 0);
    assert.match(bare.outbox.map((o) => o.body).join("\n"), /more than one unsent draft/);

    // The quote decides, even for the OLDER draft.
    await staffSays("send", { quoted: oldest.whatsapp_message_id });
    const sent = await customerMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, "Reply for: first answer: yes we have it");
    assert.notEqual(newest.id, oldest.id);
  });

  test("a quoted draft that cannot be resolved is refused, not replaced by the newest draft", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    script = (text) => ({ customer_reply: `Reply for: ${text}`, items: [] });
    await staffSays("first answer: yes we have it", { quoted: marcus.noticeWaId });
    await staffSays("second answer: delivery on Friday", { quoted: marcus.noticeWaId });
    const [oldest] = await drafts(marcus.id);
    // The audit row behind the quoted draft is gone (purged / never recorded).
    await pg.run(`update public.ai_agent_staff_answers set draft_dedupe_key = null where draft = 'Reply for: first answer: yes we have it';`);
    const r = await staffSays("send", { quoted: oldest.whatsapp_message_id });
    assert.equal(await everyCustomerRow(), 0);
    assert.match(r.outbox.map((o) => o.body).join("\n"), /can't tell which draft you quoted/);
  });

  test("quoting the confirmation of an earlier send points at the draft it approved, which is held as already sent", async () => {
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    await staffSays("send", { quoted: draft.whatsapp_message_id });
    const confirmation = (await drafts(marcus.id)).find((d) => d.id !== draft.id)!;
    assert.ok(confirmation.whatsapp_message_id);
    const again = await staffSays("send", { quoted: confirmation.whatsapp_message_id });
    assert.equal(await everyCustomerRow(), 1, "not sent a second time");
    assert.match(again.outbox.map((o) => o.body).join("\n"), /already sent/);
    const approvals = (await answers()).filter((a) => a.command === "send");
    assert.ok(approvals.every((a) => a.approves_answer_id), "each approval records which draft it approved");
  });

  // ── 5. Observe never sends ───────────────────────────────────────────────

  test("Observe: drafts are always created, and no authorized '!send', typed send or dashboard send ever creates a customer message", async () => {
    await configure({ mode: "observe", staff_notices_enabled: true });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    assert.ok(draft, "a draft is created");
    assert.equal((await answers())[0].draft_source, "model");

    for (const text of ["send", "!send", `!send ${SEND_TEXT}`, "go ahead"]) await staffSays(text, { quoted: draft.whatsapp_message_id });
    await staffSays(`#${marcus.ref} !send`);
    const row = await escalationRow(marcus.id);
    const dash = await adminSend.sendAdminAnswer({ settings: await settingsOf(), escalation: row as never, text: SEND_TEXT, adminId: ADMIN, basedOn: new Date().toISOString() });
    assert.ok(dash.ok && !dash.sent);

    assert.equal(await everyCustomerRow(), 0);
    assert.equal(await count("select 1 from public.ai_agent_outbox where kind not in ('staff_notice','staff_draft')"), 0, "only notices and drafts exist at all");
    // And the SQL the bridge claims from would not hand out a customer message in Observe either.
    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key) values ('dog_food', ${lit(MARCUS.chat)}, 'staff_relay', ${lit(MARCUS.chat)}, 'x', 'forced');`);
    const claimed = await pg.run("select kind from public.claim_ai_agent_outbox('dog_food', 50) order by kind;");
    assert.doesNotMatch(claimed, /staff_relay|customer_reply|holding_reply/);
  });

  // ── 6. Temporary facts never become permanent or stale customer claims ───

  test("a stock statement the model calls durable is still only temporary: no candidate, expires, stays in its conversation", async () => {
    const STOCK = "Yes we have the 20kg Pedigree in stock";
    script = () => ({
      customer_reply: "Hi Marcus, yes the 20kg Pedigree is in stock.",
      items: [{ category: "durable", kind: "faq", title: "20kg Pedigree stock", content: "The 20kg Pedigree is in stock.", evidence: "we have the 20kg Pedigree in stock" }],
    });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays(STOCK, { quoted: marcus.noticeWaId });
    assert.equal(await count("select 1 from public.ai_agent_learning_candidates"), 0, "stock never becomes a knowledge candidate");
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0);
    const [a] = await answers();
    assert.equal(a.items[0].category, "temporary");
    assert.equal(a.temporary_facts.length, 1);
    const until = Date.parse(a.temporary_facts[0].valid_until);
    assert.ok(until > Date.now() && until <= Date.now() + 7 * 24 * 3_600_000 + 60_000, "bounded to at most 7 days");
    assert.equal(a.temporary_facts[0].scope, "conversation");

    // Only this conversation sees it, and only until it expires.
    assert.equal((await knowledge.loadLiveStaffFacts("dog_food", MARCUS.chat)).length, 1);
    assert.equal((await knowledge.loadLiveStaffFacts("dog_food", JANE.chat)).length, 0);
    assert.equal((await knowledge.loadLiveStaffFacts("by_sea", MARCUS.chat)).length, 0);
    assert.equal((await knowledge.loadLiveStaffFacts("dog_food", MARCUS.chat, new Date(Date.now() + 8 * 24 * 3_600_000))).length, 0);
  });

  test("an admin cannot approve a stock or 'today' suggestion into permanent knowledge, however it got there", async () => {
    const jane = await escalate(JANE, "Do you have the 15kg bag?");
    await pg.run(`insert into public.ai_agent_learning_candidates
      (business_slug, escalation_id, staff_answer, category, suggested_kind, suggested_title, fingerprint)
      values ('dog_food', ${lit(jane.id)}, 'The 15kg bag is out of stock until Thursday.', 'durable', 'faq', '15kg stock', 'fp-stock');`);
    const [c] = await rows<{ id: string }>("select id from public.ai_agent_learning_candidates");
    const refused = await learning.approveCandidate({
      businessSlug: "dog_food", candidateId: c.id, adminId: ADMIN, kind: "faq", title: "15kg stock", content: undefined, resolution: undefined, replaceKnowledgeId: undefined,
    });
    assert.ok(!refused.ok && refused.status === 409 && /temporary condition/.test(refused.error));
    // Editing the text into a stock claim is refused too; a plain price is fine.
    const edited = await learning.approveCandidate({
      businessSlug: "dog_food", candidateId: c.id, adminId: ADMIN, kind: "faq", title: "15kg", content: "We have plenty of 15kg bags in stock today.", resolution: undefined, replaceKnowledgeId: undefined,
    });
    assert.ok(!edited.ok && edited.status === 409);
    assert.equal(await count("select 1 from public.ai_agent_knowledge"), 0);
    const ok = await learning.approveCandidate({
      businessSlug: "dog_food", candidateId: c.id, adminId: ADMIN, kind: "price", title: "15kg bag", content: "A 15kg bag of dog food costs EC$120.", resolution: undefined, replaceKnowledgeId: undefined,
    });
    assert.ok(ok.ok);
  });

  test("a draft resting on a temporary fact cannot be approved after that fact expired — typed wording still can", async () => {
    script = () => ({
      customer_reply: "Hi Marcus, we have the 20kg Pedigree in stock today.",
      items: [{ category: "temporary", title: "20kg stock", content: "The 20kg Pedigree is in stock today.", evidence: "we have the 20kg Pedigree in stock today", valid_hours: 12 }],
    });
    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    await staffSays("Yes we have the 20kg Pedigree in stock today", { quoted: marcus.noticeWaId });
    const [draft] = await drafts(marcus.id);
    // A day later, the stock facts behind the draft have run out.
    await pg.run("update public.ai_agent_staff_answers set valid_until = now() - interval '1 minute';");
    const late = await staffSays("send", { quoted: draft.whatsapp_message_id });
    assert.equal(await everyCustomerRow(), 0);
    assert.match(late.outbox.map((o) => o.body).join("\n"), /stock or availability details this draft rests on have expired/);
    // Fresh wording typed by an authorized person is theirs to send.
    await staffSays("!send Hi Marcus, I'll confirm our stock with you tomorrow", { quoted: marcus.noticeWaId });
    assert.equal(await everyCustomerRow(), 1);
  });

  test("SQL: the allow-list defaults to nobody, accepts only phones and exact @lid ids, and a failed answer can be claimed once", async () => {
    await pg.run("insert into public.whatsapp_businesses (business_slug) values ('fresh_biz') on conflict do nothing;");
    await pg.run("insert into public.ai_agent_settings (business_slug) values ('fresh_biz') on conflict do nothing;");
    assert.equal(await pg.run("select staff_authorized_senders from public.ai_agent_settings where business_slug = 'fresh_biz';"), "{}");
    const set = (v: string) => pg.run(`update public.ai_agent_settings set staff_authorized_senders = ${v} where business_slug = 'fresh_biz';`);
    await set("array['17585550001','55512345678901@lid']");
    for (const bad of ["array['Jane']", "array['12345']", "array['17585550001@s.whatsapp.net']", "array['1758555000a']", "array['17585550001,17585550002']"]) {
      await assert.rejects(set(bad), bad);
    }
    await assert.rejects(set(`(select array_agg((17585550000 + g)::text) from generate_series(1, 51) g)`));
    await pg.run("delete from public.ai_agent_settings where business_slug = 'fresh_biz';");

    const marcus = await escalate(MARCUS, "Do you have the 20kg Pedigree?");
    script = failingModel;
    await staffSays(MARCUS_ANSWER, { quoted: marcus.noticeWaId });
    const [failed] = await answers();
    const claim = () => pg.run(`select count(*) from public.claim_ai_agent_staff_answer_retry('dog_food', ${lit(failed.id)});`);
    assert.equal(await claim(), "1");
    assert.equal(await claim(), "0", "already claimed");
    assert.equal(await pg.run(`select count(*) from public.claim_ai_agent_staff_answer_retry('by_sea', ${lit(failed.id)});`), "0");
  });

});

/** Same reset as beforeEach, callable inside a loop. */
async function beforeEachReset() {
  await pg.run(`
    truncate public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events,
      public.ai_agent_learning_candidates, public.ai_agent_knowledge, public.ai_agent_customer_memory,
      public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules, public.whatsapp_messages;
    update public.ai_agent_settings set enabled = true, mode = 'assisted', contact_scope = 'all' where business_slug = 'dog_food';`);
}
