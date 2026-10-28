// Approval Pilot, multi-message conversations: the real server code against the real migrations in a throwaway
// Postgres (tests/helpers/pgHarness.ts). Only the language model is a scripted stand-in and the bridge a loop that
// acks what it was handed. Covers the order conversation step by step (nothing re-asked, corrections, collection),
// a follow-up while a draft is waiting, non-order questions with a knowledge gap, staff corrections feeding
// Evaluation, and the eligibility / authorization / staleness guards around them.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { isCollection, missingOrderFields, type ModelProposal, type OrderRequestDraft } from "../lib/aiAgent/engine.ts";
import { assessDraftReadiness, buildPilotNotice } from "../lib/aiAgent/pilot.ts";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const order = (items: [string, string | null][], over: Partial<OrderRequestDraft> = {}): OrderRequestDraft => ({
  items: items.map(([product, quantity]) => ({ product, quantity })),
  delivery_address: null,
  delivery_preference: null,
  notes: null,
  ...over,
});

describe("order slots (pure rules)", () => {
  test("collection needs no delivery address; delivery still does", () => {
    assert.equal(isCollection("Collection on Friday morning"), true);
    assert.equal(isCollection("I'll pick it up"), true);
    assert.equal(isCollection("Pickup tomorrow"), true);
    assert.equal(isCollection("Delivery on Friday"), false);
    assert.equal(isCollection(null), false);
    assert.deepEqual(missingOrderFields(order([["Monello Chicken 15kg", "2"]], { delivery_preference: "Collection Friday" })), []);
    assert.deepEqual(missingOrderFields(order([["Monello Chicken 15kg", "2"]], { delivery_preference: "Delivery Friday" })), ["delivery_address"]);
    assert.deepEqual(missingOrderFields(order([["Monello", null]])), ["quantity", "delivery_address"]);
  });

  test("a draft that only asks for the next order detail is customer-ready; the missing details are listed for staff instead", () => {
    const ask = assessDraftReadiness({
      reply: "Sure! Which Monello product and bag size would you like?",
      proposal: { decision: "ASK", knowledge_ids: [], confidence: 0.9 },
      activeKnowledge: [],
      safeguardCodes: [],
      reasonCodes: ["collecting_order_details", "open_escalation", "staff_first"],
      requiredConfidence: 0.5,
    });
    assert.equal(ask.ready, true);
    // ...but a draft that asserts a price, stock or a schedule without approved knowledge is not.
    for (const reply of ["The Monello 15kg bag is EC$120.", "Yes, we have it in stock and can deliver tomorrow."]) {
      assert.equal(
        assessDraftReadiness({ reply, proposal: { decision: "ASK", knowledge_ids: [], confidence: 0.9 }, activeKnowledge: [], safeguardCodes: [], reasonCodes: ["collecting_order_details"], requiredConfidence: 0.5 }).ready,
        false,
        reply
      );
    }
    // A complete order still needs a person to confirm stock, total and delivery.
    assert.equal(
      assessDraftReadiness({ reply: "Thanks, I've noted your order.", proposal: { decision: "ASK", knowledge_ids: [], confidence: 0.9 }, activeKnowledge: [], safeguardCodes: [], reasonCodes: ["order_approval"], requiredConfidence: 0.5 }).ready,
      false
    );
  });

  test("the pilot notice stays compact: the order and what is missing are in !moreinfo, not in the notice", () => {
    const text = buildPilotNotice({
      refCode: "E-ABCDE",
      customerLabel: "Jane",
      messages: ["Collection Friday morning"],
      draft: { version: 1, body: "Thanks Jane, I've noted that.", ready: false, notes: ["Stock, total and delivery for this order still need confirming"] },
      warnings: [],
    });
    assert.match(text, /#E-ABCDE · Jane/);
    assert.match(text, /⚠️ Stock, total and delivery for this order still need confirming/);
    assert.doesNotMatch(text, /Order so far|Missing \/ uncertain/);
    assert.doesNotMatch(text, /order is confirmed/i);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

const GROUP = "120363000000000001@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";
const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101", name: "Jane" };
const STRANGE_CUSTOMER = { chat: "17585550777@s.whatsapp.net", phone: "17585550777", name: "Not on the list" };
type Customer = typeof JANE;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let evaluation: typeof import("../lib/server/aiAgent/evaluation.ts");
type ProposeInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}

const proposal = (over: Partial<ModelProposal> = {}): ModelProposal => ({
  decision: "ASK",
  intent: "order",
  reply: null,
  confidence: 0.9,
  knowledge_ids: [],
  escalation_reason: null,
  priority: null,
  summary: null,
  order_request: null,
  memory_facts: [],
  ...over,
});
let script: (input: ProposeInput) => ModelProposal = () => proposal({ decision: "ESCALATE", confidence: 0.2 });
const modelCalls: ProposeInput[] = [];

async function ackAll(items: { id: string; send: boolean; kind?: string }[], opts: { notAcked?: string[] } = {}) {
  for (const item of items) {
    if (item.send && !(opts.notAcked ?? []).includes(item.id)) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
  }
}

async function customerSays(c: Customer, text: string) {
  const result = await decide.processBridgeMessage({
    businessSlug: "cool_pool",
    whatsappMessageId: `CUST-${++seq}`,
    chatId: c.chat,
    contactNumber: c.phone,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

async function staffSays(text: string, opts: { quoted?: string | null; sender?: string | null; ack?: boolean } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: "cool_pool",
    whatsappMessageId: `STAFF-${++seq}`,
    chatId: GROUP,
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

type Notice = { id: string; body: string; status: string; escalation_id: string; whatsapp_message_id: string | null };
const notices = (c: Customer = JANE) =>
  rows<Notice>(`select id, body, status, escalation_id, whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_notice' and chat_id = ${lit(c.chat)} order by created_at, id`);
const lastNotice = async (c: Customer = JANE) => (await notices(c)).at(-1)!;
const feedbacks = () => rows<{ body: string }>(`select body from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at, id`);
const lastFeedback = async () => (await feedbacks()).at(-1)?.body ?? "";
const customerBound = (c: Customer = JANE) =>
  rows<{ kind: string; body: string; status: string }>(`select kind, body, status from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay') and chat_id = ${lit(c.chat)} order by created_at`);
const drafts = () => rows<Record<string, any>>(`select * from public.ai_agent_pilot_drafts order by created_at, version`);
const escalations = () => rows<Record<string, any>>(`select * from public.ai_agent_escalations order by created_at`);

describe("Approval Pilot conversations (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      insert into public.whatsapp_businesses (business_slug) values ('cool_pool') on conflict do nothing;
      insert into public.ai_agent_settings (business_slug) values ('cool_pool') on conflict do nothing;
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text,
        message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    evaluation = await import("../lib/server/aiAgent/evaluation.ts");
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

  async function configure(over: Record<string, string | number | boolean | string[]> = {}) {
    const settings = {
      enabled: true,
      mode: "approval_pilot",
      contact_scope: "selected",
      staff_group_jid: GROUP,
      staff_notices_enabled: true,
      batching_enabled: false,
      customer_memory_enabled: false,
      default_customer_mode: "staff_first",
      staff_authorized_senders: ["17585550001"],
      knowledge_confirm_via_whatsapp: true,
      ...over,
    };
    const set = Object.entries(settings)
      .map(([k, v]) => `${k} = ${Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
      .join(", ");
    await pg.run(`update public.ai_agent_settings set ${set} where business_slug = 'cool_pool';`);
  }

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_escalations, public.ai_agent_outbox, public.ai_agent_staff_answers, public.ai_agent_events,
        public.ai_agent_learning_candidates, public.ai_agent_knowledge, public.ai_agent_customer_memory,
        public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules, public.ai_agent_order_requests,
        public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts, public.ai_agent_shadow_results,
        public.whatsapp_messages;
      insert into public.ai_agent_contact_rules (business_slug, chat_id, rule) values ('cool_pool', ${lit(JANE.chat)}, 'allow');`);
    await configure();
    modelCalls.length = 0;
    script = () => proposal({ decision: "ESCALATE", confidence: 0.2 });
  });

  const approveQuoting = (waId: string | null, args = "") => staffSays(`!approve${args}`, { quoted: waId, ack: false });

  test("a multi-turn order: ask, approve, continue without re-asking, then a staff-ready summary — nothing is ever sent unapproved", async () => {
    // 1. "I want two bags of Monello" → the AI suggests the clarifying question.
    script = () =>
      proposal({
        reply: "Sure! Which Monello product and bag size would you like?",
        order_request: order([["Monello", "2 bags"]]),
        summary: "Wants two bags of Monello",
      });
    const first = await customerSays(JANE, "I want two bags of Monello");
    assert.equal(first.decision, "ESCALATE");
    assert.equal((await customerBound()).length, 0, "the AI sent nothing by itself");
    let notice = await lastNotice();
    assert.match(notice.body, /#E-/);
    assert.match(notice.body, /Customer: “I want two bags of Monello”/);
    assert.match(notice.body, /AI suggests:\n“[^”]*Which Monello product and bag size/);
    assert.doesNotMatch(notice.body, /⚠️/, "a draft that only asks for the next detail needs no confirmation");
    assert.doesNotMatch(notice.body, /Order so far|Missing \/ uncertain/, "the order and what is missing are in !moreinfo");
    assert.match(notice.body, /!approve · !edit <text> · !reject · !moreinfo/);
    assert.ok(notice.body.split("\n").length <= 9, "the group message stays compact");

    // An ordinary !approve (no "confirm") is enough for a pure clarifying question.
    const ok1 = await approveQuoting(notice.whatsapp_message_id);
    const relay1 = ok1.outbox.filter((o) => o.kind === "staff_relay" && o.send);
    assert.equal(relay1.length, 1);
    assert.equal(relay1[0].to, JANE.chat);
    assert.equal(relay1[0].body, "Sure! Which Monello product and bag size would you like?", "the exact approved text");
    await ackAll(relay1);

    // 2. The customer answers → a NEW request (the old one is closed), with the earlier order carried over.
    script = (input) => {
      assert.ok(input.pendingOrder?.items.some((i) => /monello/i.test(i.product)), "the model is shown the order collected so far");
      assert.equal(input.openEscalation, false);
      assert.equal(input.reviewMode, true);
      return proposal({
        reply: "Got it, two 15kg bags of Monello Chicken. Would you like delivery or collection?",
        order_request: order([["Monello Chicken 15kg", "2"]]),
        summary: "Two 15kg Monello chicken",
      });
    };
    await customerSays(JANE, "Two 15kg chicken.");
    const escs = await escalations();
    assert.equal(escs.length, 2, "a reply to an approved message is a new request, not an edit of the old one");
    assert.equal(escs[0].status, "answered");
    assert.equal(escs[1].status, "notified");
    notice = await lastNotice();
    assert.notEqual(notice.escalation_id, escs[0].id);
    assert.match(notice.body, /AI suggests:/);
    assert.doesNotMatch(notice.body, /⚠️/);
    assert.match(notice.body, /delivery or collection/);
    const ok2 = await approveQuoting(notice.whatsapp_message_id);
    const relay2 = ok2.outbox.filter((o) => o.kind === "staff_relay" && o.send);
    assert.equal(relay2[0].body, "Got it, two 15kg bags of Monello Chicken. Would you like delivery or collection?");
    await ackAll(relay2);

    // 3. "Collection, Friday morning" → nothing left to ask (no address for collection): a summary for staff, which needs confirming.
    script = () =>
      proposal({
        reply: "Thanks! I've noted two 15kg bags of Monello Chicken for collection on Friday morning. Our team will confirm availability and the price with you.",
        order_request: order([["Monello Chicken 15kg", "2"]], { delivery_preference: "Collection Friday morning" }),
        summary: "Two 15kg Monello chicken, collecting Friday morning",
      });
    await customerSays(JANE, "Collection please, Friday morning");
    notice = await lastNotice();
    assert.match(notice.body, /!approve confirm/, "a complete order is for staff to confirm");
    assert.match(notice.body, /⚠️/);
    assert.ok((notice.body.match(/⚠️/g) ?? []).length <= 2, "only the essential warnings");
    assert.doesNotMatch(notice.body, /Address: /, "no address is demanded for a collection");
    const plain = await approveQuoting(notice.whatsapp_message_id);
    assert.equal(plain.outbox.filter((o) => o.kind === "staff_relay").length, 0, "an unconfirmed draft needs !approve confirm");
    assert.match(await lastFeedback(), /confirm/i);
    const [orderRow] = await rows<Record<string, any>>("select * from public.ai_agent_order_requests");
    assert.equal(orderRow.delivery_preference, "Collection Friday morning");
    assert.notEqual(orderRow.status, "confirmed", "the AI never confirms an order");
    assert.equal((await customerBound()).filter((m) => m.kind !== "staff_relay").length, 0);
    assert.equal((await customerBound()).length, 2, "only the two approved messages reached the customer");
  });

  test("a correction and a second product keep what was already collected", async () => {
    script = () => proposal({ reply: "Which size?", order_request: order([["Monello Chicken 15kg", "2"]]) });
    await customerSays(JANE, "2 x Monello Chicken 15kg please");
    const n1 = await lastNotice();
    // The customer corrects the quantity and adds another product before staff act.
    script = (input) => {
      assert.equal(input.pendingOrder?.items[0].quantity, "2");
      return proposal({
        reply: "No problem, I've changed that to 3 bags and added a 5kg Monello Beef. Delivery or collection?",
        order_request: order([
          ["Monello Chicken 15kg", "3"],
          ["Monello Beef 5kg", "1"],
        ]),
      });
    };
    await customerSays(JANE, "Actually make it 3, and add one Monello Beef 5kg");
    const all = await notices();
    assert.equal(all.length, 2);
    assert.match(all[1].body, /^#E-\w+ · .* — updated/);
    assert.match(all[1].body, /AI suggests \(replaces the earlier one\)/);
    assert.match(all[1].body, /Quote this message: !approve · !edit <text> · !reject · !moreinfo/);
    assert.match(all[1].body, /Monello Beef 5kg/);
    assert.match(all[1].body, /Monello Chicken 15kg/);
    const d = await drafts();
    assert.deepEqual(d.map((x) => [x.version, x.status, x.source]), [[1, "superseded", "ai"], [2, "current", "ai"]]);
    assert.equal(d[0].outcome, "superseded");
    assert.equal(d[0].final_text, null, "a newer AI suggestion is not a staff final text");

    // The first notice shows the superseded draft: refused. The update notice shows v2: approved, exactly.
    await approveQuoting(n1.whatsapp_message_id);
    assert.equal((await customerBound()).length, 0);
    assert.match(await lastFeedback(), /replaced|v2/);
    const ok = await approveQuoting(all[1].whatsapp_message_id);
    const relay = ok.outbox.filter((o) => o.kind === "staff_relay" && o.send);
    assert.equal(relay.length, 1);
    assert.match(relay[0].body, /changed that to 3 bags/);
    // Approving the same update again changes nothing.
    await approveQuoting(all[1].whatsapp_message_id);
    assert.equal((await customerBound()).length, 1);
  });

  test("a stale suggestion cannot be approved after the customer writes again", async () => {
    script = () => proposal({ reply: "Which size would you like?", order_request: order([["Monello", "2"]]) });
    await customerSays(JANE, "two bags of Monello");
    const n = await lastNotice();
    script = () => proposal({ decision: "ESCALATE", confidence: 0.2 }); // no new suggestion this time
    await customerSays(JANE, "the chicken one");
    await approveQuoting(n.whatsapp_message_id);
    assert.equal((await customerBound()).length, 0, "the earlier suggestion no longer answers the conversation");
    assert.match(await lastFeedback(), /customer has written again/i);
  });

  test("strict staleness: even 'thanks' after the latest suggestion makes it unapprovable; !send still sends exact staff wording", async () => {
    script = () => proposal({ reply: "Which size would you like?", order_request: order([["Monello", "2"]]) });
    await customerSays(JANE, "two bags of Monello");
    script = () => proposal({ reply: "Is that the chicken or the beef?", order_request: order([["Monello", "2"]]) });
    await customerSays(JANE, "and a 15kg one");
    const update = await lastNotice();
    assert.match(update.body, /AI suggests \(replaces the earlier one\)/);
    await customerSays(JANE, "thanks");
    await approveQuoting(update.whatsapp_message_id);
    assert.equal((await customerBound()).length, 0);
    assert.match(await lastFeedback(), /customer has written again/i);

    // Staff can still answer in their own exact words (authorized sender only).
    const refused = await staffSays("!send Hi Jane, it's the chicken, right?", { quoted: update.whatsapp_message_id, sender: STRANGER });
    assert.equal(refused.outbox.filter((o) => o.kind === "staff_relay").length, 0);
    const sent = await staffSays("!send Hi Jane, it's the chicken, right?", { quoted: update.whatsapp_message_id, ack: false });
    const relay = sent.outbox.filter((o) => o.kind === "staff_relay" && o.send);
    assert.equal(relay.length, 1);
    assert.equal(relay[0].body, "Hi Jane, it's the chicken, right?");
    assert.equal((await drafts()).at(-1)?.outcome, "replaced_by_staff_text");
  });

  test("a general question is not forced into an order; a missing price is flagged and staff correct it with !edit, then teach it", async () => {
    // The AI guesses a price it was never taught.
    script = () => proposal({ decision: "REPLY", intent: "question", reply: "The Monello 15kg bag is EC$99.", confidence: 0.95, escalation_reason: "price not in knowledge", order_request: null });
    await customerSays(JANE, "How much is a 15kg bag of Monello?");
    const n = await lastNotice();
    assert.doesNotMatch(n.body, /Order so far/, "a price question is not an order");
    assert.match(n.body, /!approve confirm/);
    assert.match(n.body, /price in the draft is not in approved knowledge|No approved knowledge/);
    assert.equal((await rows("select * from public.ai_agent_order_requests")).length, 0);
    const refused = await approveQuoting(n.whatsapp_message_id);
    assert.equal(refused.outbox.filter((o) => o.kind === "staff_relay").length, 0);

    // Staff correct it. The original suggestion is kept for Evaluation.
    await staffSays("!edit The 15kg Monello bag is EC$120.", { quoted: n.whatsapp_message_id });
    const [post] = await rows<{ whatsapp_message_id: string }>("select whatsapp_message_id from public.ai_agent_outbox where kind = 'staff_draft' order by created_at");
    const sent = await approveQuoting(post.whatsapp_message_id);
    const relay = sent.outbox.filter((o) => o.kind === "staff_relay" && o.send);
    assert.equal(relay[0].body, "The 15kg Monello bag is EC$120.");

    // The fact becomes a pending suggestion — never knowledge by itself — until confirmed.
    await staffSays("!teach The 15kg Monello bag costs EC$120");
    const [cand] = await rows<Record<string, any>>("select * from public.ai_agent_learning_candidates");
    assert.equal(cand.status, "pending");
    assert.equal((await rows("select * from public.ai_agent_knowledge where status = 'approved'")).length, 0);
    await staffSays(`!confirm ${cand.short_code}`);
    assert.equal((await rows("select * from public.ai_agent_knowledge where status = 'approved'")).length, 1);

    const review = (await evaluation.loadEvaluation("cool_pool")).pilotReviews[0];
    assert.equal(review.aiDraft.text, "The Monello 15kg bag is EC$99.");
    assert.equal(review.final?.text, "The 15kg Monello bag is EC$120.");
    assert.equal(review.verdict, "factually_wrong");

    // Asked again, the AI now has the verified fact to cite.
    const [k] = await rows<{ id: string }>("select id from public.ai_agent_knowledge where status = 'approved'");
    script = (input) => {
      assert.ok(input.knowledge.some((x) => /EC\$120/.test(x.content)), "the confirmed fact reaches the next turn");
      return proposal({ decision: "REPLY", intent: "question", reply: "The 15kg Monello bag costs EC$120.", confidence: 0.95, knowledge_ids: [k.id], order_request: null });
    };
    await pg.run("update public.ai_agent_escalations set status = 'resolved';");
    await customerSays(JANE, "And the price of the 15kg Monello again?");
    assert.doesNotMatch((await lastNotice()).body, /⚠️/, "customer-ready: no warning");
  });

  test("an unauthorized approver and an ineligible customer: nothing is sent, nothing is posted", async () => {
    script = () => proposal({ reply: "Which size?", order_request: order([["Monello", "2"]]) });
    await customerSays(JANE, "two bags of Monello");
    const n = await lastNotice();
    const denied = await staffSays("!approve", { quoted: n.whatsapp_message_id, sender: STRANGER });
    assert.equal(denied.outbox.filter((o) => o.kind === "staff_relay").length, 0);
    assert.match(await lastFeedback(), /not on this business's list/);
    assert.equal((await customerBound()).length, 0);
    assert.equal((await drafts())[0].status, "current");

    // A customer who is not on the allow-list never reaches the AI or the staff group.
    const before = modelCalls.length;
    const ignored = await customerSays(STRANGE_CUSTOMER, "I want a bag of dog food");
    assert.equal(ignored.decision, "NO_REPLY");
    assert.ok(ignored.reasons.includes("contact_not_permitted"));
    assert.equal(modelCalls.length, before, "no model call for an ineligible customer");
    assert.equal((await notices(STRANGE_CUSTOMER)).length, 0);
  });

  test("batched replies are queued 'pending' for the bridge's poll — and the claim hands them out in Approval Pilot", async () => {
    await configure({ batching_enabled: true, batch_quiet_seconds: 1, batch_max_wait_seconds: 10 });
    script = () => proposal({ reply: "Sure! Which Monello product and bag size would you like?", order_request: order([["Monello", "2 bags"]]) });
    const first = await customerSays(JANE, "I want two bags of Monello");
    assert.deepEqual(first.reasons, ["batched"]);
    assert.equal(first.outbox.length, 0, "the bridge sees items=0 for a batched message");
    await new Promise((r) => setTimeout(r, 1400));
    const summary = await decide.processDueBatches();
    assert.ok(summary.done >= 1, JSON.stringify(summary));
    const pending = await rows<{ kind: string; status: string; to_jid: string }>("select kind, status, to_jid from public.ai_agent_outbox where kind = 'staff_notice'");
    assert.deepEqual(pending.map((p) => [p.kind, p.status, p.to_jid]), [["staff_notice", "pending", GROUP]]);
    // A bridge that does not poll leaves it pending forever; one that does gets exactly one copy.
    const claimed = await outbox.claimOutbox("cool_pool", 20);
    assert.deepEqual(claimed.map((c) => [c.kind, c.to]), [["staff_notice", GROUP]]);
    assert.deepEqual(await outbox.claimOutbox("cool_pool", 20), []);
  });

  test("Observe never reaches the pilot path: the same conversation posts no suggestion and sends nothing", async () => {
    await configure({ mode: "observe" });
    script = () => proposal({ reply: "Which size?", order_request: order([["Monello", "2"]]) });
    await customerSays(JANE, "two bags of Monello");
    assert.equal((await drafts()).length, 0);
    assert.equal((await customerBound()).length, 0);
  });
});
