// Smart escalation updates + per-customer modes, end to end: the app's REAL server code
// (processBridgeMessage → batching → escalation → staff notices → outbox → ack → staff group) running
// against the REAL migrations in a throwaway Postgres (tests/helpers/pgHarness.ts). Only the language
// model is a scripted stand-in and the WhatsApp bridge a loop that acks what it was handed. Skips itself
// when no Postgres binaries are installed.

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

const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const MARCUS = { chat: "17585550102@s.whatsapp.net", phone: "17585550102", name: "Marcus" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let escalations: typeof import("../lib/server/aiAgent/escalations.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type ProposeInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}

// ── The scripted model ───────────────────────────────────────────────────────

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
const order = (items: [string, string | null][], address: string | null = null, pref: string | null = null) => ({
  items: items.map(([product, quantity]) => ({ product, quantity })),
  delivery_address: address,
  delivery_preference: pref,
  notes: null,
});

let script: (input: ProposeInput) => Proposal = () => proposal();
const modelCalls: ProposeInput[] = [];

// ── Fixtures ─────────────────────────────────────────────────────────────────

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true,
    mode: "assisted",
    contact_scope: "all",
    staff_group_jid: group,
    staff_notices_enabled: true,
    customer_memory_enabled: false,
    batching_enabled: false,
    auto_takeover_minutes: 120,
    default_customer_mode: "staff_first",
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
const setCustomerMode = (c: Customer, mode: string | null, biz = "dog_food") =>
  pg.run(
    `insert into public.ai_agent_conversations (business_slug, chat_id, customer_mode) values (${lit(biz)}, ${lit(c.chat)}, ${mode ? lit(mode) : "null"})
     on conflict (business_slug, chat_id) do update set customer_mode = excluded.customer_mode;`
  );

async function addKnowledge(content = "The 15kg chicken dog food bag costs EC$90.") {
  return (
    await pg.run(
      `with i as (insert into public.ai_agent_knowledge (business_slug, kind, title, content, status) values ('dog_food', 'price', 'Price', ${lit(content)}, 'approved') returning id) select id from i;`
    )
  ).trim();
}

/** The bridge: acks everything it was handed in a response (the live path hands items back as `dispatched`). */
async function ackAll(items: { id: string; send: boolean }[]) {
  for (const item of items) {
    if (item.send) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
  }
}
/** The bridge's outbox poll: claim what is pending (mode-checked in SQL) and ack it. */
async function drain(biz = "dog_food") {
  const claimed = await outbox.claimOutbox(biz, 50);
  await ackAll(claimed);
  return claimed;
}

async function customerSays(c: Customer, text: string, opts: { id?: string; biz?: string; ack?: boolean } = {}) {
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
  if (opts.ack !== false) await ackAll(result.outbox);
  return result;
}

async function staffSays(text: string, opts: { quoted?: string | null; biz?: string; group?: string; sender?: string | null } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: `STAFF-${++seq}`,
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
  await ackAll(result.outbox);
  return result;
}

const notices = (c?: Customer, biz = "dog_food") =>
  rows<{ id: string; body: string; status: string; escalation_id: string; whatsapp_message_id: string | null; dedupe_key: string; to_jid: string }>(
    `select id, body, status, escalation_id, whatsapp_message_id, dedupe_key, to_jid from public.ai_agent_outbox where kind = 'staff_notice' and business_slug = ${lit(biz)}${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at, id`
  );
const customerBound = (c?: Customer) =>
  rows<{ kind: string; body: string; status: string }>(
    `select kind, body, status from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at`
  );
const escs = (c?: Customer, biz = "dog_food") =>
  rows<Record<string, any>>(`select * from public.ai_agent_escalations where business_slug = ${lit(biz)}${c ? ` and chat_id = ${lit(c.chat)}` : ""} order by created_at`);

describe("smart escalation updates and customer modes (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
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
      truncate public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events,
        public.ai_agent_learning_candidates, public.ai_agent_knowledge, public.ai_agent_customer_memory,
        public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules, public.ai_agent_order_requests,
        public.ai_agent_batches, public.ai_agent_batch_messages, public.whatsapp_messages;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none',
        staff_group_jid = null, staff_notices_enabled = false, customer_memory_enabled = false, staff_authorized_senders = '{}',
        batching_enabled = false, default_customer_mode = 'staff_first';`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    modelCalls.length = 0;
    script = () => proposal();
  });

  // ── Priority 1: the reported bug ──────────────────────────────────────────

  test('"Test" then "What products do you have?" — staff get an update (Observe mode, where the bug was)', async () => {
    await configure({ mode: "observe" });
    const first = await customerSays(JANE, "Test");
    assert.equal(first.decision, "ESCALATE");
    const [initial] = await notices(JANE);
    assert.match(initial.body, /AI escalation #E-/);
    assert.equal(initial.status, "sent");

    const second = await customerSays(JANE, "What products do you have?");
    assert.ok(!second.reasons.includes("staff_notice_skipped_notice_already_sent"), second.reasons.join());
    assert.ok(second.reasons.includes("staff_update_queued"), second.reasons.join());

    const all = await notices(JANE);
    assert.equal(all.length, 2);
    const update = all[1].body;
    assert.match(update, /Update on #E-[A-Z0-9]{5}/);
    assert.match(update, /New question: “What products do you have\?”/);
    assert.match(update, /Said: “Test”/); // the complete current request, not just the delta
    assert.match(update, /Asks: “What products do you have\?”/);
    assert.match(update, /Action needed/);
    assert.equal((await escs(JANE)).length, 1); // one escalation, one reference
    assert.equal(all[1].escalation_id, all[0].escalation_id);
    assert.equal(all[1].to_jid, GROUP);
    assert.equal((await customerBound()).length, 0); // Observe: nothing for the customer
  });

  test("Assisted mode no longer posts a notice for every message either", async () => {
    await customerSays(JANE, "Test");
    await customerSays(JANE, "What products do you have?");
    await customerSays(JANE, "thanks");
    await customerSays(JANE, "ok");
    await customerSays(JANE, "What products do you have?"); // repeated
    assert.equal((await notices(JANE)).length, 2);
  });

  // ── Priority 2: material changes ──────────────────────────────────────────

  test("customer adds a product, then changes a quantity: each is one update showing the complete order", async () => {
    script = (i) =>
      /beef/i.test(i.messageText)
        ? proposal({ intent: "order", order_request: order([["Chicken dog food", "2"], ["Beef", "1"]], "12 Main Street", "Friday") })
        : /make the chicken 3|three/i.test(i.messageText)
          ? proposal({ intent: "order", order_request: order([["Chicken dog food", "3"], ["Beef", "1"]], "12 Main Street", "Friday") })
          : proposal({ intent: "order", order_request: order([["Chicken dog food", "2"]], "12 Main Street", "Friday") });
    await customerSays(JANE, "2 bags of chicken dog food to 12 Main Street on Friday");
    await customerSays(JANE, "also 1 beef please");
    await customerSays(JANE, "actually make the chicken 3");
    const all = await notices(JANE);
    assert.equal(all.length, 3);
    assert.match(all[0].body, /AI escalation #E-/);
    assert.match(all[1].body, /Added: 1 × Beef/);
    assert.match(all[1].body, /Chicken dog food — qty 2/); // complete current request
    assert.match(all[2].body, /Quantity changed: Chicken dog food 2 → 3/);
    assert.match(all[2].body, /Beef — qty 1/);
    assert.match(all[2].body, /Address: 12 Main Street/);
    assert.doesNotMatch(all[2].body, /model_uncertain|open_escalation|order_approval/);
  });

  test("the model cannot add a product the customer never mentioned", async () => {
    script = (i) =>
      /^2 chicken/i.test(i.messageText)
        ? proposal({ intent: "order", order_request: order([["Chicken", "2"]]) })
        : proposal({ intent: "order", order_request: order([["Chicken", "2"], ["Salmon treats", "6"]], "99 Invented Rd", "Tomorrow 9am") });
    await customerSays(JANE, "2 chicken");
    const r = await customerSays(JANE, "and what are your opening hours?");
    const text = (await notices(JANE)).map((n) => n.body).join("\n");
    assert.doesNotMatch(text, /Salmon|Invented|9am/);
    assert.ok(r.reasons.includes("staff_update_queued")); // the question is still news
    const [e] = await escs(JANE);
    assert.deepEqual(e.context.order_request.items, [{ product: "Chicken", quantity: "2" }]);
  });

  test('"Thank you" produces no update, no new escalation, no model call and no customer message', async () => {
    await customerSays(JANE, "Do you deliver on Sunday?");
    const before = { notices: (await notices(JANE)).length, calls: modelCalls.length };
    for (const t of ["Thank you", "ok", "Hello", "👍"]) {
      const r = await customerSays(JANE, t);
      assert.equal(r.decision, "NO_REPLY", t);
      assert.deepEqual(r.reasons, ["trivial_acknowledgement"], t);
    }
    assert.equal((await notices(JANE)).length, before.notices);
    assert.equal(modelCalls.length, before.calls);
    assert.equal((await escs(JANE)).length, 1);
    assert.equal((await customerBound()).length, 0);
  });

  test("a duplicate WhatsApp delivery of the same message posts nothing twice", async () => {
    await customerSays(JANE, "Test");
    await customerSays(JANE, "What products do you have?", { id: "DUP-1" });
    const again = await customerSays(JANE, "What products do you have?", { id: "DUP-1" });
    assert.equal(again.status, "duplicate");
    assert.equal((await notices(JANE)).length, 2);
    // A different delivery of identical words adds nothing new either.
    await customerSays(JANE, "What products do you have?", { id: "DUP-2" });
    assert.equal((await notices(JANE)).length, 2);
  });

  // ── Cancellation after staff responded ────────────────────────────────────

  test("cancellation after staff answered reopens the SAME escalation and flags it", async () => {
    script = () => proposal({ intent: "order", order_request: order([["Chicken", "2"]], "12 Main Street", "Friday") });
    await customerSays(JANE, "2 chicken to 12 Main Street on Friday");
    const [e] = await escs(JANE);
    const row = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    await escalations.markEscalationAnswered(row, { body: "Yes, Friday works", actorId: STAFF, via: "whatsapp", notRelayed: null });
    assert.equal((await escs(JANE))[0].status, "answered");

    const r = await customerSays(JANE, "Sorry, please cancel my order");
    assert.ok(r.reasons.includes("escalation_reopened"), r.reasons.join());
    const all = await escs(JANE);
    assert.equal(all.length, 1);
    assert.equal(all[0].ref_code, e.ref_code);
    assert.equal(all[0].status, "notified");
    assert.equal(all[0].context.cancelled, true);
    assert.equal(all[0].priority, "high");

    const update = (await notices(JANE)).at(-1)!.body;
    assert.match(update, new RegExp(`Update on #${e.ref_code}`));
    assert.match(update, /Customer changed this AFTER staff replied/);
    assert.match(update, /Customer wants to CANCEL/);
    assert.match(update, /stop any preparation or delivery/);
    assert.match(update, /Chicken — qty 2/);
  });

  test("a genuinely new question after staff answered opens a NEW escalation, not a reopen", async () => {
    await customerSays(JANE, "Do you have 15kg bags?");
    const row = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    await escalations.markEscalationAnswered(row, { body: "Yes", actorId: STAFF, via: "whatsapp", notRelayed: null });
    await customerSays(JANE, "What are your opening hours on Sunday?");
    const all = await escs(JANE);
    assert.equal(all.length, 2);
    assert.notEqual(all[0].ref_code, all[1].ref_code);
  });

  test("a closed escalation is never reopened: the next issue gets a new reference", async () => {
    await customerSays(JANE, "Do you have 15kg bags?");
    const row = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    await escalations.applyStaffAction({ escalation: row, command: "close", body: "", settings: null, actorKind: "staff", actorId: STAFF, via: "whatsapp", dedupeBase: "t" });
    const r = await customerSays(JANE, "Please cancel my order");
    assert.ok(!r.reasons.includes("escalation_reopened"));
    const all = await escs(JANE);
    assert.equal(all.length, 2);
    assert.equal(all[0].status, "resolved");
    assert.equal(all[1].status, "notified");
    assert.match((await notices(JANE)).at(-1)!.body, /AI escalation #E-/); // a fresh first notice
  });

  // ── Batching ──────────────────────────────────────────────────────────────

  const makeDue = () => pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second' where status = 'collecting';");

  test("several messages inside one batching window become ONE update", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 30, batch_max_wait_seconds: 120 });
    script = (i) =>
      /beef/i.test(i.messageText)
        ? proposal({ intent: "order", order_request: order([["Chicken", "3"], ["Beef", "1"]], "12 Main Street", null) })
        : proposal({ intent: "order", order_request: order([["Chicken", "2"]], "12 Main Street", null) });
    await customerSays(JANE, "2 chicken to 12 Main Street");
    await makeDue();
    await decide.processDueBatches({ budgetMs: 5000 });
    await drain();
    assert.equal((await notices(JANE)).length, 1);

    await customerSays(JANE, "also a beef");
    await customerSays(JANE, "make the chicken 3 beef");
    await customerSays(JANE, "thanks!");
    assert.equal((await notices(JANE)).length, 1); // nothing is decided inside the window
    await makeDue();
    const summary = await decide.processDueBatches({ budgetMs: 5000 });
    assert.equal(summary.claimed, 1);
    await drain();
    const all = await notices(JANE);
    assert.equal(all.length, 2);
    assert.match(all[1].body, /Added: 1 × Beef/);
    assert.match(all[1].body, /Quantity changed: Chicken 2 → 3/);
    assert.equal(all[1].status, "sent");
  });

  test("a cancellation does not wait out the quiet period when staff are already on it", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 60, batch_max_wait_seconds: 300 });
    script = () => proposal({ intent: "order", order_request: order([["Chicken", "2"]], "12 Main Street", "Friday") });
    await customerSays(JANE, "2 chicken to 12 Main Street Friday");
    await makeDue();
    await decide.processDueBatches({ budgetMs: 5000 });
    await drain();

    // An ordinary message waits...
    await customerSays(JANE, "what colour is the bag?");
    const [ordinary] = await rows<{ secs: number }>("select extract(epoch from (due_at - now())) as secs from public.ai_agent_batches where status = 'collecting'");
    assert.ok(Number(ordinary.secs) > 30);
    await pg.run("update public.ai_agent_batches set status = 'cancelled' where status = 'collecting';");
    // ...a cancellation is due immediately.
    const r = await customerSays(JANE, "please cancel my order");
    assert.ok(r.reasons.includes("batch_expedited_cancellation"), r.reasons.join());
    const [urgent] = await rows<{ secs: number }>("select extract(epoch from (due_at - now())) as secs from public.ai_agent_batches where status = 'collecting'");
    assert.ok(Number(urgent.secs) <= 0.5);
    await decide.processDueBatches({ budgetMs: 5000 });
    await drain();
    assert.match((await notices(JANE)).at(-1)!.body, /Customer wants to CANCEL/);
  });

  test("a cancellation from a customer staff are not working with is batched normally", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 60, batch_max_wait_seconds: 300 });
    const r = await customerSays(JANE, "please cancel my order");
    assert.ok(!r.reasons.includes("batch_expedited_cancellation"));
  });

  // ── Initial notice failed or never sent ───────────────────────────────────

  test("notices were off when the escalation opened: the next message sends the FIRST notice, complete", async () => {
    await configure({ staff_notices_enabled: false, mode: "observe" });
    const r1 = await customerSays(JANE, "Do you have 15kg bags?");
    assert.ok(r1.reasons.includes("staff_notice_skipped_staff_notices_disabled"));
    assert.equal((await notices(JANE)).length, 0);
    assert.equal((await escs(JANE))[0].context.notice_skipped, "staff_notices_disabled");

    await configure({ staff_notices_enabled: true, mode: "observe" });
    const r2 = await customerSays(JANE, "And do you deliver on Sunday?");
    assert.ok(r2.reasons.includes("staff_notice_queued"), r2.reasons.join());
    const all = await notices(JANE);
    assert.equal(all.length, 1);
    assert.match(all[0].body, /AI escalation #E-/); // the original format, not a "follow-up"
    assert.match(all[0].body, /Do you have 15kg bags\?/);
    assert.match(all[0].body, /And do you deliver on Sunday\?/);
  });

  test("the first notice provably never reached WhatsApp: the next message re-sends it in full", async () => {
    await customerSays(JANE, "Do you have 15kg bags?", { ack: false });
    const [first] = await notices(JANE);
    await outbox.ackOutbox({ outboxId: first.id, status: "failed", whatsappMessageId: null, error: "not_sent: socket closed" });
    const r = await customerSays(JANE, "Hello? Anyone there?");
    assert.ok(r.reasons.includes("staff_notice_queued"), r.reasons.join());
    const all = await notices(JANE);
    assert.equal(all.length, 2);
    assert.match(all[1].body, /AI escalation #E-/);
    assert.match(all[1].body, /Do you have 15kg bags\?/);
  });

  test("an ambiguous earlier failure is never retried as a first notice — the change goes out as an update", async () => {
    await customerSays(JANE, "Do you have 15kg bags?", { ack: false });
    const [first] = await notices(JANE);
    await outbox.ackOutbox({ outboxId: first.id, status: "failed", whatsappMessageId: null, error: "session_disconnected" });
    await customerSays(JANE, "Also, do you deliver on Sunday?");
    const all = await notices(JANE);
    assert.equal(all.length, 2);
    assert.match(all[1].body, /Update on #E-/);
    assert.match(all[1].body, /Asks: “Do you have 15kg bags\?”/); // complete even if staff never saw the first
  });

  test("a notice still in flight does not suppress a real change, and thanks adds nothing", async () => {
    await customerSays(JANE, "Do you have 15kg bags?", { ack: false }); // dispatched, no ack yet
    await customerSays(JANE, "thanks");
    assert.equal((await notices(JANE)).length, 1);
    await customerSays(JANE, "Also, do you deliver on Sunday?");
    assert.equal((await notices(JANE)).length, 2);
  });

  // ── Restart safety, duplicates, concurrency ───────────────────────────────

  test("restart safety: a change recorded by a worker that died before posting is announced by the next one", async () => {
    await customerSays(JANE, "Do you have 15kg bags?");
    const row = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    // The crashed worker: wrote the customer's new question to the escalation, never posted the update.
    await escalations.createOrAppendEscalation({
      businessSlug: "dog_food", chatId: JANE.chat, contactNumber: JANE.phone, customerName: "Jane", reasons: ["open_escalation"],
      priority: "normal", customerMessage: "Do you deliver on Sunday?", segments: ["Do you deliver on Sunday?"],
      draftReply: null, summary: null, orderRequest: null, eventId: null,
    });
    assert.equal((await notices(JANE)).length, 1);
    assert.equal(row.notified_seq, 1);
    // The next message (a thank-you changes nothing, a real message carries both forward).
    await customerSays(JANE, "And is there a discount for 2 bags?");
    const all = await notices(JANE);
    assert.equal(all.length, 2);
    assert.match(all[1].body, /Do you deliver on Sunday\?/);
    assert.match(all[1].body, /discount for 2 bags/);
  });

  test("a redelivered batch (worker died after posting) does not post again", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 30, batch_max_wait_seconds: 120 });
    await customerSays(JANE, "Do you have 15kg bags?");
    await makeDue();
    await decide.processDueBatches({ budgetMs: 5000 });
    await drain();
    assert.equal((await notices(JANE)).length, 1);
    // Put the finished batch back as if the lease expired before completion was recorded.
    await pg.run("update public.ai_agent_batches set status = 'processing', lease_until = now() - interval '1 second', worker_id = 'dead' where status = 'done';");
    await decide.processDueBatches({ budgetMs: 5000 });
    await drain();
    assert.equal((await notices(JANE)).length, 1);
    assert.equal((await escs(JANE)).length, 1);
  });

  test("concurrent customer turns never double-post and never lose a change", async () => {
    await customerSays(JANE, "Test");
    const questions = ["Do you deliver on Sunday?", "How much is the 15kg bag?", "Do you take cards?", "Where are you located?"];
    const results = await Promise.all(questions.map((q) => customerSays(JANE, q, { ack: false })));
    for (const r of results) assert.equal(r.status, "done");
    await ackAll(results.flatMap((r) => r.outbox));
    const all = await notices(JANE);
    // Every notice has a unique sequence-derived key; posting is serialized by the escalation row lock.
    assert.equal(new Set(all.map((n) => n.dedupe_key)).size, all.length);
    const [e] = await escs(JANE);
    assert.equal(e.notified_seq, all.length);
    // Whatever was posted, the LAST update shows every question (nothing lost) — sequence = what staff saw.
    const seen = all.map((n) => n.body).join("\n");
    for (const q of questions) assert.ok(seen.includes(q), q);
    assert.equal((await escs(JANE)).length, 1);
  });

  // ── Routing from updated notices ──────────────────────────────────────────

  test("a staff reply quoting the initial notice OR an update lands on the same escalation", async () => {
    await customerSays(JANE, "Test");
    await customerSays(JANE, "What products do you have?");
    await customerSays(MARCUS, "Do you have the 20kg Pedigree?");
    const jane = await notices(JANE);
    assert.equal(jane.length, 2);
    const [e] = await escs(JANE);

    const viaUpdate = await staffSays("!note quoted the update", { quoted: jane[1].whatsapp_message_id });
    const viaInitial = await staffSays("!note quoted the first notice", { quoted: jane[0].whatsapp_message_id });
    for (const r of [viaUpdate, viaInitial]) assert.equal(r.status, "done");
    const [after] = await escs(JANE);
    assert.equal(after.context.notes.length, 2);
    assert.equal(after.id, e.id);
    // Marcus's escalation is untouched.
    const [marcus] = await escs(MARCUS);
    assert.equal(marcus.context.notes ?? undefined, undefined);
  });

  // ── Priority 3 & 4: customer modes ────────────────────────────────────────

  test("Auto-Reply answers a routine question from approved knowledge; Staff First drafts it for staff; Manual Only does nothing", async () => {
    const kid = await addKnowledge();
    script = () =>
      proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });

    await setCustomerMode(JANE, "auto_reply");
    const auto = await customerSays(JANE, "How much is the 15kg chicken bag?");
    assert.equal(auto.decision, "REPLY");
    assert.deepEqual((await customerBound(JANE)).map((m) => m.kind), ["customer_reply"]);
    assert.equal((await escs(JANE)).length, 0);

    await setCustomerMode(MARCUS, "staff_first");
    const sf = await customerSays(MARCUS, "How much is the 15kg chicken bag?");
    assert.equal(sf.decision, "ESCALATE");
    assert.ok(sf.reasons.includes("staff_first"));
    assert.equal((await customerBound(MARCUS)).length, 0); // no customer reply, no holding reply
    const [n] = await notices(MARCUS);
    assert.match(n.body, /Suggested reply: "The 15kg chicken dog food bag costs EC\$90\./); // the draft staff may approve

    const manual = { chat: "17585550103@s.whatsapp.net", phone: "17585550103", name: "Priya" };
    await setCustomerMode(manual, "manual_only");
    const calls = modelCalls.length;
    const mo = await customerSays(manual, "How much is the 15kg chicken bag?");
    assert.equal(mo.decision, "NO_REPLY");
    assert.deepEqual(mo.reasons, ["customer_mode_manual_only"]);
    assert.equal(modelCalls.length, calls); // not even a model call
    assert.equal((await customerBound(manual)).length, 0);
    assert.equal((await escs(manual)).length, 0);
    assert.equal((await notices(manual)).length, 0);
  });

  test("a customer with no mode of their own is Staff First; the business default is honoured only when an admin set it", async () => {
    const kid = await addKnowledge();
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });
    const r = await customerSays(JANE, "How much is the 15kg chicken bag?"); // existing settings, no conversation row
    assert.equal(r.decision, "ESCALATE");
    assert.equal((await customerBound(JANE)).length, 0);
    await configure({ default_customer_mode: "auto_reply" });
    const r2 = await customerSays(MARCUS, "How much is the 15kg chicken bag?");
    assert.equal(r2.decision, "REPLY");
    assert.equal((await customerBound(MARCUS)).length, 1);
  });

  test("Auto-Reply stops by itself while staff own an unresolved issue, and resumes after it is resolved", async () => {
    const kid = await addKnowledge();
    await setCustomerMode(JANE, "auto_reply");
    script = (i) =>
      /discount/i.test(i.messageText)
        ? proposal()
        : proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });
    await customerSays(JANE, "Can I get a discount on 10 bags?"); // safeguard → staff
    const open = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    const during = await customerSays(JANE, "How much is the 15kg chicken bag?");
    assert.equal(during.decision, "ESCALATE");
    // Only the one holding message sent when the issue was escalated; nothing autonomous afterwards.
    assert.deepEqual((await customerBound(JANE)).map((m) => m.kind), ["holding_reply"]);
    await escalations.applyStaffAction({ escalation: open, command: "close", body: "", settings: null, actorKind: "staff", actorId: STAFF, via: "whatsapp", dedupeBase: "t" });
    const after = await customerSays(JANE, "How much is the 15kg chicken bag?");
    assert.equal(after.decision, "REPLY");
    assert.deepEqual((await customerBound(JANE)).map((m) => m.kind), ["holding_reply", "customer_reply"]);
  });

  test("Observe mode never produces a customer-bound message, in any customer mode", async () => {
    await configure({ mode: "observe" });
    const kid = await addKnowledge();
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });
    for (const [c, mode] of [[JANE, "auto_reply"], [MARCUS, "staff_first"]] as const) {
      await setCustomerMode(c, mode);
      await customerSays(c, "How much is the 15kg chicken bag?");
      await customerSays(c, "Do you take cards?");
    }
    assert.equal((await customerBound()).length, 0);
    assert.deepEqual(await rows(`select 1 from public.ai_agent_outbox where kind <> 'staff_notice'`), []);
    // The staff group still hears about the Staff First customer.
    assert.equal((await notices(MARCUS)).length >= 1, true);
  });

  test("Observe mode: pending customer-bound rows are never claimed by the bridge", async () => {
    await configure({ mode: "observe" });
    await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key) values ('dog_food', ${lit(JANE.chat)}, 'customer_reply', ${lit(JANE.chat)}, 'hi', 'x:1')`);
    assert.equal((await outbox.claimOutbox("dog_food", 10)).length, 0);
  });

  test("contact permissions, human takeover and the OFF switch beat Auto-Reply", async () => {
    const kid = await addKnowledge();
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });
    await setCustomerMode(JANE, "auto_reply");
    await setCustomerMode(MARCUS, "auto_reply");

    await configure({ contact_scope: "selected" });
    assert.deepEqual((await customerSays(JANE, "How much is the 15kg chicken bag?")).reasons, ["contact_not_permitted"]);
    await pg.run(`insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('dog_food', ${lit(MARCUS.chat)}, 'exclude')`);
    await configure({ contact_scope: "all" });
    assert.deepEqual((await customerSays(MARCUS, "How much is the 15kg chicken bag?")).reasons, ["contact_excluded"]);

    await pg.run(`update public.ai_agent_conversations set control = 'human' where chat_id = ${lit(JANE.chat)}`);
    assert.deepEqual((await customerSays(JANE, "How much is the 15kg chicken bag?")).reasons, ["human_takeover"]);

    await pg.run(`update public.ai_agent_conversations set control = 'ai' where chat_id = ${lit(JANE.chat)}`);
    await configure({ enabled: false });
    assert.equal((await customerSays(JANE, "How much is the 15kg chicken bag?")).status, "ignored");
    assert.equal((await customerBound()).length, 0);
    assert.equal((await escs()).length, 0);
  });

  test("a human taking over pauses updates too, and resuming restores Auto-Reply only when allowed", async () => {
    const kid = await addKnowledge();
    await setCustomerMode(JANE, "auto_reply");
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The 15kg chicken dog food bag costs EC$90.", confidence: 0.99, knowledge_ids: [kid] });
    await escalations.setConversationControl({ businessSlug: "dog_food", chatId: JANE.chat, control: "human", minutes: null, reason: "test", actorKind: "admin", actorId: null });
    assert.equal((await customerSays(JANE, "How much is the 15kg chicken bag?")).decision, "HUMAN");
    await escalations.setConversationControl({ businessSlug: "dog_food", chatId: JANE.chat, control: "ai", minutes: null, reason: "test", actorKind: "admin", actorId: null });
    assert.equal((await customerSays(JANE, "How much is the 15kg chicken bag?")).decision, "REPLY");
    // The mode survived the takeover round trip.
    const [c] = await rows(`select customer_mode from public.ai_agent_conversations where chat_id = ${lit(JANE.chat)}`);
    assert.equal(c.customer_mode, "auto_reply");
  });

  // ── Staff authorization still decides explicit sends ──────────────────────

  test("!send still needs an authorized sender and the central send policy — in Staff First", async () => {
    await setCustomerMode(JANE, "staff_first");
    await customerSays(JANE, "Do you have 15kg bags?");
    const [n] = await notices(JANE);

    const stranger = await staffSays("!send Yes we do!", { quoted: n.whatsapp_message_id, sender: STRANGER });
    assert.equal(stranger.status, "done");
    assert.equal((await customerBound(JANE)).filter((m) => m.kind === "staff_relay").length, 0);

    await staffSays("!send Yes we do!", { quoted: n.whatsapp_message_id, sender: STAFF });
    const relays = (await customerBound(JANE)).filter((m) => m.kind === "staff_relay");
    assert.equal(relays.length, 1);
    assert.equal(relays[0].body, "Yes we do!");
  });

  test("Observe mode refuses even an authorized !send", async () => {
    await configure({ mode: "observe" });
    await customerSays(JANE, "Do you have 15kg bags?");
    const [n] = await notices(JANE);
    await staffSays("!send Yes we do!", { quoted: n.whatsapp_message_id, sender: STAFF });
    assert.equal((await customerBound(JANE)).length, 0);
  });

  // ── Business isolation ────────────────────────────────────────────────────

  test("two businesses with the same customer number keep separate escalations, notices and modes", async () => {
    await configure({ mode: "assisted" }, "by_sea", SEA_GROUP);
    await setCustomerMode(JANE, "manual_only", "dog_food");
    const dog = await customerSays(JANE, "Do you have 15kg bags?", { biz: "dog_food" });
    assert.deepEqual(dog.reasons, ["customer_mode_manual_only"]);
    await customerSays(JANE, "Do you have fresh fish?", { biz: "by_sea" });
    await customerSays(JANE, "What time do you open?", { biz: "by_sea" });
    assert.equal((await escs(JANE, "dog_food")).length, 0);
    const sea = await notices(JANE, "by_sea");
    assert.equal(sea.length, 2);
    assert.ok(sea.every((n) => n.to_jid === SEA_GROUP));
    assert.equal((await notices(JANE, "dog_food")).length, 0);
    // by_sea's update cannot be posted against a dog_food escalation id.
    const [seaEsc] = await escs(JANE, "by_sea");
    const posted = await escalations.postEscalationNotice({
      escalation: { ...seaEsc, business_slug: "dog_food" } as never, snapshot: { items: [], delivery_address: null, delivery_preference: null, notes: null, questions: [], other: [], cancelled: false },
      toJid: GROUP, body: "x", eventId: null, dispatchNow: false,
    });
    assert.equal(posted.outcome, "closed");
  });

  // ── The SQL function itself ───────────────────────────────────────────────

  test("post_ai_agent_escalation_notice is compare-and-swap: a stale writer changes nothing", async () => {
    await customerSays(JANE, "Test");
    const e = (await escalations.findOpenEscalation("dog_food", JANE.chat))!;
    assert.equal(e.notified_seq, 1);
    const snap = { items: [], delivery_address: null, delivery_preference: null, notes: null, questions: [], other: [], cancelled: false };
    const stale = await escalations.postEscalationNotice({ escalation: { ...e, notified_seq: 0 }, snapshot: snap, toJid: GROUP, body: "stale", eventId: null, dispatchNow: false });
    assert.equal(stale.outcome, "stale");
    assert.equal((await notices(JANE)).length, 1);
    const ok = await escalations.postEscalationNotice({ escalation: e, snapshot: snap, toJid: GROUP, body: "fresh", eventId: null, dispatchNow: false });
    assert.equal(ok.outcome, "queued");
    const again = await escalations.postEscalationNotice({ escalation: e, snapshot: snap, toJid: GROUP, body: "fresh", eventId: null, dispatchNow: false });
    assert.equal(again.outcome, "stale"); // the same read cannot post twice
  });

  test("migration safety: existing rows default to Staff First and carry no customer mode", async () => {
    const [s] = await rows(`select count(*)::int as n from public.ai_agent_settings where default_customer_mode <> 'staff_first'`);
    assert.equal(s.n, 0);
    await pg.run(`insert into public.ai_agent_conversations (business_slug, chat_id) values ('dog_food', 'legacy@s.whatsapp.net')`);
    const [c] = await rows(`select customer_mode from public.ai_agent_conversations where chat_id = 'legacy@s.whatsapp.net'`);
    assert.equal(c.customer_mode, null);
    await assert.rejects(pg.run(`update public.ai_agent_conversations set customer_mode = 'turbo' where chat_id = 'legacy@s.whatsapp.net'`));
    await assert.rejects(pg.run(`update public.ai_agent_settings set default_customer_mode = 'turbo' where business_slug = 'dog_food'`));
    // Re-running the migration is a no-op.
    const sql = (await import("node:fs")).readFileSync("supabase/migrations/20261028000000_ai_agent_customer_modes_escalation_updates.sql", "utf8");
    await pg.run(sql);
  });
});
