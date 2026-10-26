// Automatic business learning: pure rules first, then the app's REAL server code (processBridgeMessage → maybeAutoLearn →
// learn_ai_agent_fact → digest → outbox) against the REAL migrations in a throwaway Postgres (tests/helpers/pgHarness.ts).
// Only the language model is a scripted stand-in. Skips itself when no Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  type ActiveFact,
  autoLearnWorthLooking,
  buildLearningDigest,
  buildMemoryDetail,
  buildMemoryList,
  checkRemoved,
  decideAutoLearn,
  DIGEST_THRESHOLD,
  factFingerprint,
  isGenuineHumanOutgoing,
  measurementsOf,
  moneyAmounts,
  type RemovedFact,
  subjectKey,
  summaryLine,
  WEEKLY_DIGEST_DAYS,
} from "../lib/aiAgent/autoLearn.ts";
import { parsePilotCommand } from "../lib/aiAgent/pilot.ts";
import type { ClassifiedItem } from "../lib/aiAgent/staffAnswers.ts";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

// ── Pure rules ───────────────────────────────────────────────────────────────

const item = (over: Partial<ClassifiedItem> = {}): ClassifiedItem => ({
  category: "durable",
  kind: "price",
  title: "25ft hose price",
  content: "The 25ft hose costs $128.",
  evidence: "25ft hose is $128",
  validUntil: null,
  scope: null,
  ...over,
});
const meta = (over: Partial<Parameters<typeof decideAutoLearn>[0]["meta"]> = {}) => ({ subject: "25ft hose", priceScope: "standard" as const, correction: false, confidence: 0.95, ...over });
const decide = (over: { item?: ClassifiedItem; meta?: ReturnType<typeof meta>; staffText?: string; contextText?: string; active?: ActiveFact[]; removed?: RemovedFact[] } = {}) =>
  decideAutoLearn({ item: item(), meta: meta(), staffText: "The 25ft hose is $128.", contextText: "", active: [], ...over });
const active = (over: Partial<ActiveFact> = {}): ActiveFact => ({
  id: "k1",
  kind: "price",
  title: "25ft hose price",
  content: "The 25ft hose costs $128.",
  source: "auto",
  subject_key: subjectKey("25ft hose"),
  price_amount: 128,
  fingerprint: null,
  ...over,
});

describe("automatic learning: which messages are even read", () => {
  test("only a genuine human message of the business account in a 1:1 customer chat", () => {
    const base = { fromMe: true, chatId: "17585550101@s.whatsapp.net", text: "The 25ft hose is $128 and we deliver on Tuesdays." };
    assert.equal(isGenuineHumanOutgoing(base), true);
    assert.equal(isGenuineHumanOutgoing({ ...base, chatId: "123456789012345@lid" }), true);
    assert.equal(isGenuineHumanOutgoing({ ...base, fromMe: false }), false, "a customer's message is never a source");
    assert.equal(isGenuineHumanOutgoing({ ...base, chatId: "120363000000000001@g.us" }), false, "groups are not customer chats");
    assert.equal(isGenuineHumanOutgoing({ ...base, chatId: "status@broadcast" }), false);
    assert.equal(isGenuineHumanOutgoing({ ...base, text: "!forget K-ABCD" }), false, "commands");
    assert.equal(isGenuineHumanOutgoing({ ...base, text: "AI escalation #E-ABCD: the 25ft hose is $128" }), false, "the agent's own posts, copied");
    assert.equal(isGenuineHumanOutgoing({ ...base, text: "Draft v2 for #E-ABCD · The 25ft hose is $128" }), false, "a pasted draft");
    assert.equal(isGenuineHumanOutgoing({ ...base, text: "(media message without text)" }), false);
    assert.equal(isGenuineHumanOutgoing({ ...base, text: "ok thanks" }), false);
  });

  test("the free pre-filter reads prices, measurements and business wording; chatter and questions cost nothing", () => {
    assert.equal(autoLearnWorthLooking("The 25ft hose is $128 for everyone."), true);
    assert.equal(autoLearnWorthLooking("It is 7¼ inches across, easy to fit."), true);
    assert.equal(autoLearnWorthLooking("We are open Saturday 8am to 2pm every week."), true);
    assert.equal(autoLearnWorthLooking("Sure thing, see you later this afternoon then!"), false);
    assert.equal(autoLearnWorthLooking("How much is the 25ft hose again?"), false);
  });

  test("prices and measurements are read exactly", () => {
    assert.deepEqual(moneyAmounts("EC$1,200.50 or $128 or 90 dollars"), [1200.5, 128, 90]);
    assert.deepEqual(measurementsOf("It is 7¼ inches and 25 ft long, 3.5kg"), ["7¼inches", "25ft", "3.5kg"]);
    assert.equal(subjectKey("The 25ft Hoses"), subjectKey("hose 25ft"), "the same product however it is worded");
  });
});

describe("automatic learning: what happens to each fact", () => {
  test("a clear standard fact is saved, with the product identity and price", () => {
    const d = decide();
    assert.equal(d.action, "save");
    if (d.action !== "save") return;
    assert.equal(d.fact.priceAmount, 128);
    assert.equal(d.fact.subjectKey, subjectKey("25ft hose"));
    assert.equal(d.fact.summary, "25ft hose — $128");
  });

  test("a product named only by the conversation is learned when it is reliable, and sent to review when it is not", () => {
    const contextual = {
      item: item({ kind: "product", title: "25ft hose width", content: "The 25ft hose is 7¼ inches wide.", evidence: "7¼ inches wide" }),
      staffText: "It is 7¼ inches wide.",
      contextText: "Customer: how wide is the 25ft hose?",
    };
    assert.equal(decide({ ...contextual, meta: meta({ confidence: 0.92 }) }).action, "save");
    const unsure = decide({ ...contextual, meta: meta({ confidence: 0.8 }) });
    assert.equal(unsure.action, "review");
    if (unsure.action === "review") assert.equal(unsure.reason, "ambiguous_subject");
  });

  test("an isolated dimension is never saved: no subject, a generic one, or one the conversation never mentions", () => {
    const isolated = item({ kind: "product", title: "Item width", content: "The item is 7¼ inches.", evidence: "item is 7¼ inches" });
    for (const subject of [null, "the item", "it", "50ft hose"]) {
      const d = decide({ item: isolated, meta: meta({ subject }), staffText: "The item is 7¼ inches.", contextText: "Customer: how wide is the 25ft hose?" });
      assert.equal(d.action, "review", String(subject));
      if (d.action === "review") assert.equal(d.reason, "ambiguous_subject", String(subject));
    }
  });

  test("a figure the business did not say is never learned, however the model phrased it", () => {
    const d = decide({ item: item({ content: "The 25ft hose costs $140." }), staffText: "The 25ft hose is $128." });
    assert.deepEqual(d, { action: "skip", reason: "unsupported_figure" });
    const fromCustomer = decide({
      item: item({ kind: "product", content: "The 25ft hose is 9 inches wide.", evidence: "it fits" }),
      staffText: "Yes it fits fine.",
      contextText: "Customer: my 25ft hose is 9 inches wide",
    });
    assert.equal(fromCustomer.action, "skip", "a customer's figure is not the business's");
  });

  test("standard versus special prices", () => {
    assert.deepEqual(decide({ meta: meta({ priceScope: "special" }) }), { action: "skip", reason: "special_price" });
    const unclear = decide({ meta: meta({ priceScope: "unclear" }) });
    assert.equal(unclear.action === "review" && unclear.reason, "price_scope_unclear");
    for (const text of ["For you the 25ft hose is $128.", "I can do the 25ft hose for $128 if you take both.", "The 25ft hose is $128, you can pay later on account."]) {
      const d = decide({ staffText: text });
      assert.equal(d.action === "review" && d.reason, "customer_terms", text);
    }
    // The model called a discount reusable, but the words say otherwise: a person decides whether it was meant as a rule.
    const moved = decide({ item: item({ category: "one_off", moved_from: "durable", content: "The 25ft hose is $100 with a discount.", evidence: "discount" }), staffText: "Discount: the 25ft hose is $100." });
    assert.equal(moved.action === "review" && moved.reason, "customer_terms");
    assert.equal(decide({ item: item({ category: "one_off" }) }).action, "skip", "what the model itself called one-off is dropped");
  });

  test("a different price for a product already on file is flagged for review, never overwritten; the same price is a duplicate", () => {
    const changed = decide({ item: item({ content: "The 25ft hose costs $140." }), staffText: "The 25ft hose is now $140.", meta: meta({ correction: true }), active: [active()] });
    assert.equal(changed.action, "review");
    if (changed.action === "review") {
      assert.equal(changed.reason, "price_conflict");
      assert.equal(changed.conflicts[0].id, "k1");
    }
    const same = decide({ item: item({ content: "A 25ft hose is priced at $128." }), active: [active()] });
    assert.deepEqual(same, { action: "duplicate", ofId: "k1" });
  });

  test("different products never conflict", () => {
    const d = decide({
      item: item({ content: "The 35ft hose costs $164." }),
      staffText: "The 35ft hose is $164.",
      meta: meta({ subject: "35ft hose" }),
      active: [active()],
      contextText: "",
    });
    assert.equal(d.action, "save");
  });

  test("equivalent facts share one fingerprint however they are worded", () => {
    const key = subjectKey("25ft hose");
    assert.equal(factFingerprint("The 25ft hose costs $128.", key, [128], []), factFingerprint("A 25ft hose is priced at 128 dollars.", key, [128], []));
    assert.notEqual(factFingerprint("The 25ft hose costs $128.", key, [128], []), factFingerprint("The 25ft hose costs $140.", key, [140], []));
  });

  test("an explicit correction of a learned fact replaces it; a staff-written entry, or no explicit correction, goes to review", () => {
    const hours = item({ kind: "hours", title: "Saturday hours", content: "We are open Saturday 9am to 3pm.", evidence: "open Saturday 9am to 3pm" });
    const saturday = (over: Partial<ActiveFact> = {}) =>
      active({ id: "h1", kind: "hours", title: "Saturday hours", content: "We are open Saturday 8am to 2pm.", subject_key: null, price_amount: null, ...over });
    const base = { item: hours, staffText: "Actually we are now open Saturday 9am to 3pm.", meta: meta({ subject: null, correction: true }) };

    const replaced = decide({ ...base, active: [saturday()] });
    assert.equal(replaced.action, "update");
    if (replaced.action === "update") assert.equal(replaced.replaceId, "h1");

    const staffWritten = decide({ ...base, active: [saturday({ source: "admin" })] });
    assert.equal(staffWritten.action === "review" && staffWritten.reason, "changes_staff_entry");

    const notACorrection = decide({ ...base, meta: meta({ subject: null, correction: false }), active: [saturday()] });
    assert.equal(notACorrection.action === "review" && notACorrection.reason, "conflicts_existing");
  });

  test("risky policies, weak evidence, temporary and private information", () => {
    const refund = item({ kind: "policy", title: "Refunds", content: "Refunds are given within 7 days.", evidence: "Refunds are given within 7 days" });
    assert.equal(decide({ item: refund, meta: meta({ subject: null }), staffText: "Refunds are given within 7 days." }).action, "review");
    assert.equal(decide({ item: item({ kind: "faq", content: "We never refund opened bags.", evidence: "never refund" }), meta: meta({ subject: null }), staffText: "We never refund opened bags." }).action, "review");
    const hours = item({ kind: "hours", title: "Hours", content: "We open at 8am on weekdays.", evidence: "open at 8am" });
    assert.equal(decide({ item: hours, meta: meta({ subject: null, confidence: 0.6 }), staffText: "We open at 8am on weekdays." }).action, "review");
    assert.deepEqual(decide({ item: hours, meta: meta({ subject: null, confidence: 0.3 }), staffText: "We open at 8am on weekdays." }), { action: "skip", reason: "low_confidence" });
    assert.deepEqual(decide({ item: item({ category: "temporary" }) }), { action: "skip", reason: "temporary" });
    assert.deepEqual(decide({ item: item({ content: "The 25ft hose costs $128 today, only 3 left." }) }), { action: "skip", reason: "temporary" });
    assert.deepEqual(decide({ item: item({ kind: "faq", content: "Call 17585550123 about the 25ft hose.", evidence: "Call" }) }), { action: "skip", reason: "private" });
  });
});


describe("automatic learning: forgotten and rejected facts", () => {
  const removedHose = (over: Partial<RemovedFact> = {}): RemovedFact => ({
    kind: "price",
    title: "25ft hose price",
    content: "The 25ft hose costs $128.",
    subject_key: subjectKey("25ft hose"),
    price_amount: 128,
    fingerprint: null,
    ...over,
  });
  const fact = (price: number, correction = false) => {
    const d = decide({ item: item({ content: `The 25ft hose costs $${price}.`, evidence: `25ft hose is $${price}` }), meta: meta({ correction }), staffText: `The 25ft hose is $${price}.`, removed: [removedHose()] });
    return d;
  };

  test("the same rejected claim is suppressed, even reworded, and stores nothing", () => {
    assert.deepEqual(fact(128), { action: "skip", reason: "blocked" });
    const reworded = decide({ item: item({ content: "A 25 ft hose is $128.", evidence: "25ft hose $128" }), staffText: "A 25ft hose is $128.", removed: [removedHose()] });
    assert.deepEqual(reworded, { action: "skip", reason: "blocked" });
    assert.deepEqual(fact(128, true), { action: "skip", reason: "blocked" }, "calling the same claim a correction does not bring it back");
  });

  test("a different value without an explicit correction is suppressed; with one it goes to a person, never straight to knowledge", () => {
    assert.deepEqual(fact(140), { action: "skip", reason: "blocked" });
    const corrected = fact(140, true);
    assert.equal(corrected.action, "review");
    assert.equal(corrected.action === "review" && corrected.reason, "corrects_removed");
  });

  test("an unrelated product or a different kind of claim is not suppressed", () => {
    const other = decide({ item: item({ title: "35ft hose price", content: "The 35ft hose costs $164.", evidence: "35ft hose is $164" }), meta: meta({ subject: "35ft hose" }), staffText: "The 35ft hose is $164.", removed: [removedHose()] });
    assert.equal(other.action, "save");
    if (other.action === "save") assert.equal(checkRemoved(other.fact, meta({ subject: "35ft hose" }), [removedHose()]), "none");
    const measure = decide({ item: item({ kind: "faq", title: "25ft hose length", content: "The 25ft hose is 25ft long.", evidence: "25ft long" }), staffText: "The 25ft hose is 25ft long.", removed: [removedHose()] });
    assert.notDeepEqual(measure, { action: "skip", reason: "blocked" }, "a plain fact is a different kind of claim than a removed price");
  });
});

describe("automatic learning: wording", () => {
  test("the digest is short, deterministic and counts only what it was given", () => {
    const text = buildLearningDigest({ factCount: 10, lines: ["25ft hose — $128", "35ft hose — $164", "50ft hose — $230", "75ft hose — $300"], pendingCount: 0 });
    assert.equal(
      text,
      ["📚 *AI MEMORY UPDATED*", "10 facts learned", "", "• 25ft hose — $128", "• 35ft hose — $164", "• 50ft hose — $230", "+7 more", "", "!memory — View details", "!forget K-XXXXX — Remove a fact"].join("\n")
    );
    assert.match(buildLearningDigest({ factCount: 10, lines: ["a"], pendingCount: 3 }), /3 suggestions need review/);
    assert.match(buildLearningDigest({ factCount: 1, lines: ["a"], pendingCount: 1 }), /1 fact learned[\s\S]*1 suggestion needs review/);
    assert.ok(buildLearningDigest({ factCount: 12, lines: Array(12).fill("x".repeat(300)), pendingCount: 0 }).length < 400);
  });

  test("!memory lists recent facts and pending reviews with their codes", () => {
    const text = buildMemoryList({
      recent: [{ code: "K-AB3D", summary: "25ft hose — $128", learnedAt: null, updated: false }, { code: null, summary: "Saturday hours", learnedAt: null, updated: true }],
      pending: [{ code: "K-ZZ22", text: "The 35ft hose costs $170.", reason: "The price differs from what is on file" }],
      pendingTotal: 4,
      confirmViaWhatsapp: true,
    });
    assert.match(text, /K-AB3D 25ft hose — \$128/);
    assert.match(text, /Saturday hours \(updated\)/);
    assert.match(text, /Needs review \(4\)[\s\S]*K-ZZ22/);
    assert.match(text, /\+3 more in the dashboard/);
    assert.match(text, /!confirm K-XXXXX/);
    assert.match(buildMemoryList({ recent: [], pending: [], pendingTotal: 0, confirmViaWhatsapp: false }), /Nothing learned automatically yet/);
  });


  test("a weekly digest says so, and is otherwise the same short message", () => {
    const text = buildLearningDigest({ factCount: 3, lines: ["a", "b", "c"], pendingCount: 0, weekly: true });
    assert.match(text, /3 facts learned this week/);
    assert.doesNotMatch(buildLearningDigest({ factCount: 10, lines: ["a"], pendingCount: 0 }), /this week/);
    assert.equal(WEEKLY_DIGEST_DAYS, 7);
  });

  test("!memory shows each fact's source time and chat, and the detail view shows the original only to those allowed", () => {
    const list = buildMemoryList({ recent: [{ code: "K-AB3D", summary: "25ft hose — $128", learnedAt: null, updated: false, source: "3 Nov, 14:05 · chat …0101" }], pending: [], pendingTotal: 0, confirmViaWhatsapp: false });
    assert.match(list, /K-AB3D 25ft hose — \$128\n {3}↳ 3 Nov, 14:05 · chat …0101/);
    const base = { code: "K-AB3D", summary: "25ft hose — $128", state: "active", learnedAt: "2026-11-03T18:05:00Z", chatId: "17585550101@s.whatsapp.net", messageAt: "2026-11-03T18:05:00Z", timeZone: "America/St_Lucia" };
    const allowed = buildMemoryDetail({ ...base, original: "The 25ft hose is $128 for everyone.", mayShowOriginal: true });
    assert.match(allowed, /Source: chat …0101 · sent 3 Nov, 14:05/);
    assert.match(allowed, /Original message: “The 25ft hose is \$128 for everyone\.”/);
    assert.doesNotMatch(allowed, /17585550101/, "the customer's number is never printed in the group");
    const denied = buildMemoryDetail({ ...base, original: "SECRET", mayShowOriginal: false });
    assert.doesNotMatch(denied, /SECRET/);
    assert.match(buildMemoryDetail({ ...base, original: null, mayShowOriginal: true }), /no longer available/);
    assert.match(buildMemoryDetail({ ...base, chatId: null, messageAt: null, original: null, mayShowOriginal: true }), /Source: not recorded/);
  });

  test("summary lines come from stored fields", () => {
    assert.equal(summaryLine({ subject: "25ft hose", priceAmount: 128, title: "t", content: "c" }), "25ft hose — $128");
    assert.equal(summaryLine({ subject: "x", priceAmount: 12.5, title: "t", content: "c" }), "x — $12.50");
    assert.equal(summaryLine({ subject: null, priceAmount: null, title: "Saturday hours", content: "c" }), "Saturday hours");
  });

  test("!memory and !forget are recognised as business commands", () => {
    assert.deepEqual(parsePilotCommand("!memory"), { command: "memory", body: "" });
    assert.deepEqual(parsePilotCommand("!forget K-AB3D"), { command: "forget", body: "K-AB3D" });
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";
const JANE = { chat: "17585550101@s.whatsapp.net", phone: "17585550101" };

let pg: TestPg;
let decideMod: typeof import("../lib/server/aiAgent/decide.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let knowledge: typeof import("../lib/server/aiAgent/staffKnowledge.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let digest: typeof import("../lib/server/aiAgent/learningDigest.ts");

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

type Item = Record<string, unknown>;
const analyzerCalls: { staffText: string; learning: boolean | undefined; transcript: string; knowledge: string[] }[] = [];
let analyzerScript: (staffText: string) => Item[] | null = () => null;

const priceItem = (subject: string, price: number, over: Item = {}): Item => ({
  category: "durable",
  kind: "price",
  title: `${subject} price`,
  content: `The ${subject} costs $${price}.`,
  evidence: `${subject} is $${price}`,
  subject,
  price_scope: "standard",
  is_correction: false,
  confidence: 0.95,
  ...over,
});
const priceText = (subject: string, price: number) => `The ${subject} is $${price} for everyone.`;

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}, biz = "dog_food", group: string | null = GROUP) {
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
    auto_learning_enabled: true,
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}

async function ackAll(items: { id: string; send: boolean }[]) {
  for (const i of items) if (i.send) await outbox.ackOutbox({ outboxId: i.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
}

/** The business's own human message in a customer chat. */
async function businessSays(text: string, opts: { id?: string; biz?: string; chat?: string; fromMe?: boolean } = {}) {
  const result = await decideMod.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `OWN-${++seq}`,
    chatId: opts.chat ?? JANE.chat,
    contactNumber: JANE.phone,
    fromMe: opts.fromMe ?? true,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

async function staffSays(text: string, opts: { sender?: string | null; biz?: string; group?: string } = {}) {
  const result = await decideMod.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: `STAFF-${++seq}`,
    chatId: opts.group ?? GROUP,
    contactNumber: null,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender,
    senderPhone: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

const SIZES = [25, 35, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500];
/** Teaches the model script to extract one hose price from "The <n>ft hose is $<p> for everyone." */
function hoseScript(staffText: string): Item[] | null {
  const m = staffText.match(/The (\d+)ft hose is \$(\d+)/);
  return m ? [priceItem(`${m[1]}ft hose`, Number(m[2]))] : null;
}
async function learnHoses(n: number, from = 0) {
  for (let i = from; i < from + n; i += 1) await businessSays(priceText(`${SIZES[i]}ft hose`, 100 + i * 10));
}

const knowledgeRows = () => rows<Record<string, any>>(`select * from public.ai_agent_knowledge order by created_at, id`);
const candidates = () => rows<Record<string, any>>(`select * from public.ai_agent_learning_candidates order by created_at, id`);
const events = () => rows<Record<string, any>>(`select * from public.ai_agent_learning_events order by created_at, id`);
const digests = () => rows<Record<string, any>>(`select * from public.ai_agent_learning_digests order by created_at, id`);
const feedbacks = () => rows<{ body: string; dedupe_key: string; status: string; to_jid: string; kind: string }>(`select body, dedupe_key, status, to_jid, kind from public.ai_agent_outbox where kind = 'staff_feedback' order by created_at, id`);
const customerBound = () => rows(`select kind from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
const settingsFor = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

describe("automatic learning (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text,
        message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decideMod = await import("../lib/server/aiAgent/decide.ts");
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    knowledge = await import("../lib/server/aiAgent/staffKnowledge.ts");
    digest = await import("../lib/server/aiAgent/learningDigest.ts");
    knowledge.setStaffAnalyzerForTests(async (input) => {
      analyzerCalls.push({ staffText: input.staffText, learning: input.learning, transcript: input.transcript.map((t) => `${t.who}: ${t.text}`).join("\n"), knowledge: input.knowledge.map((k) => k.title) });
      const items = analyzerScript(input.staffText);
      return items ? { analysis: { customerReply: null, items: items as never }, model: "scripted", error: null } : { analysis: null, model: "scripted", error: "model unavailable" };
    });
  });
  after(() => {
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
        public.ai_agent_learning_events, public.ai_agent_learning_digests, public.whatsapp_messages;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none',
        staff_group_jid = null, staff_notices_enabled = false, customer_memory_enabled = false, staff_authorized_senders = '{}',
        batching_enabled = false, default_customer_mode = 'staff_first', passive_learning_scope = 'off', knowledge_confirm_via_whatsapp = false,
        auto_learning_enabled = false;`);
    await configure();
    await configure({}, "by_sea", SEA_GROUP);
    analyzerCalls.length = 0;
    analyzerScript = hoseScript;
  });

  test("a clear standard fact from the business's own message becomes active knowledge at once — no !confirm, no notice, nothing to a customer", async () => {
    await businessSays(priceText("25ft hose", 128));
    const [k] = await knowledgeRows();
    assert.equal(k.status, "approved");
    assert.equal(k.source, "auto");
    assert.equal(k.kind, "price");
    assert.equal(Number(k.price_amount), 128);
    assert.match(k.short_code, /^K-[A-Z0-9]{4}$/);
    assert.ok(k.subject_key && k.learned_message_id && k.learned_message_at, "source message, timestamp and product identity are stored");
    assert.equal(k.business_slug, "dog_food");
    assert.equal(analyzerCalls.length, 1);
    assert.equal(analyzerCalls[0].learning, true);
    assert.equal((await events()).length, 1);
    assert.equal((await feedbacks()).length, 0, "routine learning never posts one by one");
    assert.equal((await candidates()).length, 0);
    assert.equal((await customerBound()).length, 0, "learning can never message a customer");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'knowledge.auto_learn'`), 1);
  });

  test("it is off by default and for customers, groups, commands, agent text and other people's messages", async () => {
    await configure({ auto_learning_enabled: false });
    await businessSays(priceText("25ft hose", 128));
    assert.equal(analyzerCalls.length, 0, "opt-in per business");
    await configure();
    await businessSays(priceText("25ft hose", 128), { fromMe: false });
    await businessSays(priceText("25ft hose", 128), { chat: GROUP });
    await businessSays(`AI escalation #E-ABCD ${priceText("25ft hose", 128)}`);
    await businessSays(`!teach ${priceText("25ft hose", 128)}`);
    await businessSays("Thanks, see you tomorrow afternoon then!");
    assert.equal(analyzerCalls.length, 0);
    assert.equal((await knowledgeRows()).length, 0);
  });

  test("the AI's own sends echoed back are not a human message", async () => {
    const text = priceText("25ft hose", 128);
    const [row] = await outbox.enqueue([{ businessSlug: "dog_food", chatId: JANE.chat, kind: "customer_reply", toJid: JANE.chat, body: text, dedupeKey: "ai-reply-1" }], true);
    await outbox.ackOutbox({ outboxId: row.id, status: "sent", whatsappMessageId: "WA-AI-1", error: null });
    const result = await businessSays(text, { id: "WA-AI-1" });
    assert.ok(result.reasons.includes("agent_echo"));
    assert.equal(analyzerCalls.length, 0);
    assert.equal((await knowledgeRows()).length, 0);
  });

  test("the same message is learned and counted once, however often the bridge delivers it", async () => {
    const settings = await settingsFor();
    const { maybeAutoLearn } = await import("../lib/server/aiAgent/autoLearn.ts");
    const args = { settings, chatId: JANE.chat, contactNumber: JANE.phone, text: priceText("25ft hose", 128), hasMedia: false, whatsappMessageId: "ONCE-1", timestamp: new Date().toISOString() };
    assert.equal((await maybeAutoLearn(args)).learned, 1);
    assert.equal((await maybeAutoLearn(args)).learned, 0);
    // Even if the scan record were lost, the database refuses the duplicate.
    await pg.run(`delete from public.ai_agent_audit_log where action = 'learning.auto_scan';`);
    assert.equal((await maybeAutoLearn(args)).learned, 0);
    assert.equal((await knowledgeRows()).length, 1);
    assert.equal((await events()).length, 1);
    assert.equal(analyzerCalls.length, 2);
  });

  test("the conversation names the product; the message alone does not", async () => {
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body) values ('dog_food', ${lit(JANE.chat)}, 'inbound', 'How wide is the 25ft hose?');`);
    analyzerScript = (t) =>
      /7¼ inches/.test(t)
        ? [{ category: "durable", kind: "product", title: "25ft hose width", content: "The 25ft hose is 7¼ inches wide.", evidence: "7¼ inches wide", subject: "25ft hose", price_scope: null, is_correction: false, confidence: 0.92 }]
        : null;
    await businessSays("It is 7¼ inches wide, fits most reels.");
    assert.match(analyzerCalls[0].transcript, /Customer: How wide is the 25ft hose\?/, "the model is shown the conversation");
    const [k] = await knowledgeRows();
    assert.equal(k.content, "The 25ft hose is 7¼ inches wide.");

    // Ambiguous: nothing in the conversation says which product → a pending review, no knowledge.
    await pg.run(`truncate public.whatsapp_messages, public.ai_agent_knowledge, public.ai_agent_learning_events;`);
    analyzerScript = (t) =>
      /7¼ inches/.test(t)
        ? [{ category: "durable", kind: "product", title: "Item width", content: "The item is 7¼ inches wide.", evidence: "7¼ inches wide", subject: null, price_scope: null, is_correction: false, confidence: 0.9 }]
        : null;
    await businessSays("It is 7¼ inches wide, fits most reels.");
    assert.equal((await knowledgeRows()).length, 0);
    const [c] = await candidates();
    assert.equal(c.status, "pending");
    assert.equal(c.review_reason, "ambiguous_subject");
    assert.equal(c.source, "auto_staff_chat");
    assert.equal(c.sender_verified, false);
  });

  test("a customer-specific price is never general knowledge; a standard price still is", async () => {
    analyzerScript = (t) => [priceItem("25ft hose", 110, { price_scope: /for you/i.test(t) ? "special" : "standard" })];
    await businessSays("For you the 25ft hose is $110 today only, my friend.");
    assert.equal((await knowledgeRows()).length, 0);
    assert.equal((await candidates()).length, 0, "a special price is dropped, not even suggested");
    analyzerScript = () => [priceItem("25ft hose", 110)];
    await businessSays("I can do the 25ft hose is $110 if you take two, on account.");
    assert.equal((await knowledgeRows()).length, 0);
    assert.equal((await candidates())[0].review_reason, "customer_terms");
  });

  test("a conflicting standard price is flagged for review and the approved price stays; history is preserved on correction of other facts", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 140));
    const all = await knowledgeRows();
    assert.equal(all.length, 1);
    assert.equal(Number(all[0].price_amount), 128, "the approved price is untouched");
    const [c] = await candidates();
    assert.equal(c.review_reason, "price_conflict");
    assert.equal(c.status, "pending");
    assert.equal((await events()).length, 1, "a review item is not a learned fact");
    assert.equal((await feedbacks()).length, 0);
  });

  test("equivalent facts and repeats are one fact: nothing duplicated, nothing counted twice", async () => {
    await businessSays(priceText("25ft hose", 128));
    analyzerScript = () => [priceItem("25ft hose", 128, { content: "A 25ft hose is priced at $128.", title: "Hose cost" })];
    await businessSays("Just so you know, the 25ft hose is $128 for everyone.");
    assert.equal((await knowledgeRows()).length, 1);
    assert.equal((await events()).length, 1);
    assert.equal((await candidates()).length, 0);
  });

  test("an explicit correction replaces a learned fact: the old one is archived and linked, never edited or deleted", async () => {
    analyzerScript = (t) =>
      /9am/.test(t)
        ? [{ category: "durable", kind: "hours", title: "Saturday hours", content: "We are open Saturday 9am to 3pm.", evidence: "open Saturday 9am to 3pm", subject: null, price_scope: null, is_correction: true, confidence: 0.95 }]
        : [{ category: "durable", kind: "hours", title: "Saturday hours", content: "We are open Saturday 8am to 2pm.", evidence: "open Saturday 8am to 2pm", subject: null, price_scope: null, is_correction: false, confidence: 0.95 }];
    await businessSays("We are open Saturday 8am to 2pm.");
    await businessSays("Actually we changed our hours, we are open Saturday 9am to 3pm.");
    const [oldRow, newRow] = await knowledgeRows();
    assert.equal(oldRow.status, "archived");
    assert.equal(oldRow.archived_reason, "superseded");
    assert.equal(oldRow.content, "We are open Saturday 8am to 2pm.", "history is intact");
    assert.equal(oldRow.superseded_by, newRow.id);
    assert.equal(newRow.status, "approved");
    assert.equal(newRow.supersedes_id, oldRow.id);
    assert.deepEqual((await events()).map((e) => e.kind), ["learned", "updated"]);
  });

  test("a staff-written entry is never changed automatically", async () => {
    await pg.run(`insert into public.ai_agent_knowledge (business_slug, kind, title, content, status, source) values ('dog_food', 'hours', 'Saturday hours', 'We are open Saturday 8am to 2pm.', 'approved', 'admin');`);
    analyzerScript = () => [{ category: "durable", kind: "hours", title: "Saturday hours", content: "We are open Saturday 9am to 3pm.", evidence: "open Saturday 9am to 3pm", subject: null, price_scope: null, is_correction: true, confidence: 0.95 }];
    await businessSays("Actually we changed our hours, we are open Saturday 9am to 3pm.");
    const all = await knowledgeRows();
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "approved");
    assert.equal((await candidates())[0].review_reason, "changes_staff_entry");
  });

  test("ten meaningful facts produce exactly one compact digest; nine produce none; the next ten produce the next", async () => {
    await learnHoses(9);
    assert.equal((await feedbacks()).length, 0);
    assert.equal((await digests()).length, 0);
    await learnHoses(1, 9);
    const [d] = await feedbacks();
    assert.equal((await feedbacks()).length, 1);
    assert.equal(d.kind, "staff_feedback");
    assert.equal(d.to_jid, GROUP, "only ever the staff group");
    assert.match(d.dedupe_key, /^learning_digest:/);
    assert.match(d.body, /AI MEMORY UPDATED/);
    assert.match(d.body, /10 facts learned/);
    assert.match(d.body, /• 25ft hose — \$100/);
    assert.match(d.body, /\+7 more/);
    assert.match(d.body, /!memory — View details/);
    assert.match(d.body, /!forget K-XXXXX — Remove a fact/);
    assert.ok(d.body.length < 400);
    assert.equal(analyzerCalls.length, 10, "one model call per message, none to format the digest");
    assert.equal((await digests()).length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_learning_events where digest_id is not null`), 10);
    await learnHoses(2, 10);
    assert.equal((await feedbacks()).length, 1, "two more are not enough");
    assert.equal((await customerBound()).length, 0);
  });

  test("duplicates, rejected candidates and unchanged facts are not counted toward a digest", async () => {
    await learnHoses(9);
    await businessSays(priceText("25ft hose", 100)); // already known
    await businessSays(priceText("25ft hose", 999)); // conflicting: review
    await businessSays("We are open Saturday 8am to 2pm.", { id: "NOTHING-1" }); // the script finds nothing
    assert.equal((await feedbacks()).length, 0);
    assert.equal((await events()).length, 9);
    await learnHoses(1, 9);
    assert.equal((await feedbacks()).length, 1);
    assert.match((await feedbacks())[0].body, /1 suggestion needs review/, "pending reviews are only a count in the next digest");
  });

  test("a digest is durable and idempotent: concurrent or repeated flushes send it once, and a lost enqueue is repaired", async () => {
    await learnHoses(10);
    const settings = await settingsFor();
    await Promise.all([digest.flushLearningDigests(settings), digest.flushLearningDigests(settings), digest.flushLearningDigests(settings)]);
    assert.equal((await feedbacks()).length, 1);
    assert.equal((await digests()).length, 1);

    // A crash between the claim and the enqueue: the digest exists, its message does not.
    await pg.run(`truncate public.ai_agent_outbox;`);
    await pg.run(`update public.ai_agent_learning_digests set enqueued_at = null;`);
    await digest.flushLearningDigests(settings);
    await digest.flushLearningDigests(settings);
    const sent = await feedbacks();
    assert.equal(sent.length, 1, "re-enqueued once under the same key");
    assert.equal(sent[0].dedupe_key, `learning_digest:${(await digests())[0].id}`);
    assert.ok((await digests())[0].enqueued_at);
  });

  test("the digest follows the staff-group rules: Observe stays silent and keeps the facts waiting", async () => {
    await configure({ mode: "observe" });
    await learnHoses(10);
    assert.equal((await knowledgeRows()).length, 10, "facts are learned regardless of mode");
    assert.equal((await feedbacks()).length, 0);
    assert.equal((await digests()).length, 0, "nothing is claimed while it cannot be sent");
    await configure({ mode: "approval_pilot" });
    await learnHoses(1, 10);
    assert.match((await feedbacks())[0].body, /11 facts learned/);
  });

  test("knowledge is isolated by business", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 150), { biz: "by_sea" });
    const all = await knowledgeRows();
    assert.deepEqual(all.map((k) => [k.business_slug, Number(k.price_amount)]).sort(), [["by_sea", 150], ["dog_food", 128]]);
    assert.equal((await candidates()).length, 0, "the other business's price is not a conflict");
  });

  test("!memory shows recent facts and pending reviews to the staff group", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 140));
    await staffSays("!memory");
    const text = (await feedbacks()).at(-1)!.body;
    assert.match(text, /AI MEMORY/);
    assert.match(text, /K-[A-Z0-9]{4} 25ft hose — \$128/);
    assert.match(text, /Needs review \(1\)/);
    assert.match(text, /price differs/i);
  });

  test("!forget deactivates a learned fact for authorized staff only, keeps the history, and the same source cannot relearn it", async () => {
    await businessSays(priceText("25ft hose", 128));
    const [k] = await knowledgeRows();
    await staffSays(`!forget ${k.short_code}`, { sender: STRANGER });
    assert.equal((await knowledgeRows())[0].status, "approved", "an unauthorized sender changes nothing");
    assert.match((await feedbacks()).at(-1)!.body, /not on this business's list/);

    await staffSays(`!forget ${k.short_code}`);
    const [after] = await knowledgeRows();
    assert.equal(after.status, "archived");
    assert.equal(after.archived_reason, "forgotten");
    assert.equal(after.content, k.content, "never deleted");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'knowledge.forget'`), 1);
    assert.match((await feedbacks()).at(-1)!.body, /removed/);

    await businessSays(priceText("25ft hose", 128));
    assert.equal((await knowledgeRows()).length, 1, "not relearned from a repeat of the same fact");
    assert.equal((await events()).length, 1);
    assert.equal((await candidates()).length, 0, "nor re-suggested");

    await staffSays(`!forget ${k.short_code}`);
    assert.match((await feedbacks()).at(-1)!.body, /already off/);
    await staffSays("!forget K-ZZZZ");
    assert.match((await feedbacks()).at(-1)!.body, /don't have a learned fact/);
    await staffSays("!forget");
    assert.match((await feedbacks()).at(-1)!.body, /Use “!forget K-XXXXX”/);
  });

  test("a fact forgotten before the digest is not counted or announced", async () => {
    await learnHoses(9);
    const [first] = await knowledgeRows();
    await staffSays(`!forget ${first.short_code}`);
    await learnHoses(1, 9);
    assert.equal((await digests()).length, 0, "only nine active facts");
    await learnHoses(1, 10);
    const sent = (await feedbacks()).filter((f) => f.dedupe_key.startsWith("learning_digest:"));
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /10 facts learned/);
    assert.doesNotMatch(sent[0].body, /25ft hose/, "the forgotten fact is not in the digest");
  });

  test("a code from another business is unknown here: !forget never reaches across businesses", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 150), { biz: "by_sea" });
    const theirs = (await knowledgeRows()).find((k) => k.business_slug === "by_sea")!;
    await staffSays(`!forget ${theirs.short_code}`, { biz: "dog_food" });
    assert.equal((await knowledgeRows()).filter((k) => k.status === "approved").length, 2);
    assert.match((await feedbacks()).at(-1)!.body, /don't have a learned fact/);
  });

  test("a discarded suggestion is not immediately re-suggested from the same fact", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 140));
    const [c] = await candidates();
    await staffSays(`!discard ${c.short_code}`);
    assert.equal((await candidates())[0].status, "rejected");
    await businessSays(priceText("25ft hose", 140));
    assert.equal((await candidates()).length, 1, "no second suggestion");
  });

  test("a failing model never breaks the message; learning is independent of order monitoring", async () => {
    analyzerScript = () => null;
    const result = await businessSays(priceText("25ft hose", 128));
    assert.equal(result.status, "done");
    assert.equal((await knowledgeRows()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_events where status = 'error'`), 0);
  });

  test("auto-learned facts are ordinary active knowledge: archived ones are never given to the model", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("35ft hose", 164));
    const [k] = await knowledgeRows();
    await staffSays(`!forget ${k.short_code}`);
    const active = await dbmod.loadActiveKnowledge("dog_food");
    assert.deepEqual(active.map((a) => a.title), ["35ft hose price"]);
  });


  // ── Refinements: weekly digest, suppression, sources ──────────────────────

  const ageEvents = (days: number) => pg.run(`update public.ai_agent_learning_events set created_at = now() - interval '${days} days';`);
  const digestFeedbacks = async () => (await feedbacks()).filter((f) => f.dedupe_key.startsWith("learning_digest:"));

  test("leftover facts get one weekly digest after seven days; younger ones, and an empty week, send nothing", async () => {
    await learnHoses(3);
    const settings = await settingsFor();
    await digest.flushLearningDigests(settings);
    assert.equal((await digestFeedbacks()).length, 0, "three fresh facts are not announced yet");
    await ageEvents(6);
    await digest.runDueLearningDigests();
    assert.equal((await digestFeedbacks()).length, 0, "six days is not a week");

    await ageEvents(8);
    await digest.runDueLearningDigests();
    const [d] = await digestFeedbacks();
    assert.equal((await digestFeedbacks()).length, 1);
    assert.match(d.body, /3 facts learned this week/);
    assert.equal(d.to_jid, GROUP);
    assert.equal(d.kind, "staff_feedback");
    assert.equal((await digests())[0].trigger_kind, "weekly");

    // Nothing new: the next sweeps (and a restart of the scheduler) send nothing, and never an empty digest.
    await Promise.all([digest.runDueLearningDigests(), digest.runDueLearningDigests(), digest.flushLearningDigests(settings)]);
    await digest.runDueLearningDigests();
    assert.equal((await digestFeedbacks()).length, 1, "no duplicate and no empty digest");
    assert.equal((await digests()).length, 1);
    assert.equal(await count(`select 1 from public.ai_agent_learning_events where digest_id is null`), 0);
    assert.equal(analyzerCalls.length, 3, "the digest never calls the model");
    assert.equal((await customerBound()).length, 0);
  });

  test("a threshold digest and the weekly sweep never announce the same fact twice", async () => {
    await learnHoses(10);
    assert.equal((await digestFeedbacks()).length, 1);
    await ageEvents(30);
    await digest.runDueLearningDigests();
    assert.equal((await digestFeedbacks()).length, 1, "all ten were already announced");
    await learnHoses(2, 10);
    await ageEvents(8);
    await digest.runDueLearningDigests();
    const sent = await digestFeedbacks();
    assert.equal(sent.length, 2);
    assert.match(sent[1].body, /2 facts learned this week/);
    assert.equal(await count(`select 1 from public.ai_agent_learning_events e join public.ai_agent_learning_digests d on d.id = e.digest_id group by e.id having count(*) > 1`), 0);
  });

  test("the weekly digest skips forgotten facts, is not claimed when none remain, and waits in Observe", async () => {
    await learnHoses(2);
    const [a, b] = await knowledgeRows();
    await staffSays(`!forget ${a.short_code}`);
    await ageEvents(8);
    await configure({ mode: "observe" });
    await digest.runDueLearningDigests();
    assert.equal((await digests()).length, 0, "Observe claims nothing");
    await configure({ mode: "approval_pilot" });
    await digest.runDueLearningDigests();
    const [d] = await digestFeedbacks();
    assert.match(d.body, /1 fact learned this week/);
    assert.doesNotMatch(d.body, /25ft hose/, "the forgotten fact is not announced");

    await staffSays(`!forget ${b.short_code}`);
    await ageEvents(20);
    await digest.runDueLearningDigests();
    assert.equal((await digestFeedbacks()).length, 1, "nothing active is waiting, so nothing is sent");
  });

  test("a forget between the claim and the send leaves nothing to announce: the digest closes without a message", async () => {
    await learnHoses(2);
    await ageEvents(8);
    const settings = await settingsFor();
    const claimed = await dbmod.agentDb().rpc("claim_ai_agent_learning_digest", { p_business_slug: "dog_food", p_threshold: 10, p_weekly_days: 7 });
    assert.equal((claimed.data as unknown[]).length, 1);
    const empty = await dbmod.agentDb().rpc("claim_ai_agent_learning_digest", { p_business_slug: "dog_food", p_threshold: 10, p_weekly_days: 7 });
    assert.equal(((empty.data as unknown[]) ?? []).length, 0, "a second claim finds nothing");
    for (const k of await knowledgeRows()) await staffSays(`!forget ${k.short_code}`);
    await digest.flushLearningDigests(settings);
    assert.equal((await digestFeedbacks()).length, 0);
    assert.ok((await digests())[0].enqueued_at, "closed, not retried forever");
  });

  test("a forgotten claim cannot come straight back; a different value needs an explicit correction and still goes to a person", async () => {
    await businessSays(priceText("25ft hose", 128));
    const [k] = await knowledgeRows();
    await staffSays(`!forget ${k.short_code}`);

    await businessSays(priceText("25ft hose", 128));
    assert.equal((await knowledgeRows()).length, 1, "the same claim is not relearned");
    assert.equal((await candidates()).length, 0, "nor re-suggested");

    await businessSays(priceText("25ft hose", 140));
    assert.equal((await knowledgeRows()).length, 1, "a new price said in passing is not learned either");
    assert.equal((await candidates()).length, 0);

    analyzerScript = (t) => {
      const m = t.match(/\$(\d+)/);
      return m ? [priceItem("25ft hose", Number(m[1]), { is_correction: true })] : null;
    };
    await businessSays("Correction: the 25ft hose is $150 for everyone.");
    const rows_ = await knowledgeRows();
    assert.equal(rows_.length, 1, "an explicit correction is never learned automatically");
    assert.equal(rows_[0].status, "archived", "the forgotten fact is NOT reactivated");
    assert.equal(rows_[0].archived_reason, "forgotten");
    const [c] = await candidates();
    assert.equal(c.status, "pending");
    assert.equal(c.review_reason, "corrects_removed");
    assert.match(c.staff_answer, /\$150/);
    assert.equal((await dbmod.loadActiveKnowledge("dog_food")).length, 0, "still nothing active until a person approves");
    assert.equal((await customerBound()).length, 0);
  });

  test("a forgotten fact can be relearned once the suppression window has passed", async () => {
    await businessSays(priceText("25ft hose", 128));
    const [k] = await knowledgeRows();
    await staffSays(`!forget ${k.short_code}`);
    await pg.run(`update public.ai_agent_knowledge set archived_at = now() - interval '31 days';`);
    await businessSays(priceText("25ft hose", 128));
    assert.equal((await dbmod.loadActiveKnowledge("dog_food")).length, 1);
  });

  test("a rejected suggestion is not re-suggested, even reworded; a forgotten fact in one business does not affect another", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("25ft hose", 140));
    const [c] = await candidates();
    await staffSays(`!discard ${c.short_code}`);
    analyzerScript = (t) => (/\$140/.test(t) ? [priceItem("25ft hose", 140, { content: "A 25ft hose costs $140.", title: "Hose 25ft cost" })] : null);
    await businessSays("A 25ft hose is $140 for everyone.");
    assert.equal((await candidates()).length, 1, "the reworded claim is not suggested again");

    analyzerScript = hoseScript;
    await businessSays(priceText("25ft hose", 128), { biz: "by_sea" });
    const [k] = (await knowledgeRows()).filter((r) => r.business_slug === "by_sea");
    await configure({}, "by_sea", SEA_GROUP);
    await staffSays(`!forget ${k.short_code}`, { biz: "by_sea", group: SEA_GROUP });
    await businessSays(priceText("25ft hose", 128));
    assert.equal((await knowledgeRows()).filter((r) => r.business_slug === "dog_food" && r.status === "approved").length, 1, "the other business's removal does not block this one");
  });

  test("every automatic fact is traceable to its business, chat, message and time — without storing any chat text", async () => {
    analyzerScript = hoseScript;
    await businessSays(priceText("25ft hose", 128), { id: "OWN-TRACE-1" });
    await businessSays(priceText("25ft hose", 128), { id: "OWN-TRACE-2", biz: "by_sea" });
    for (const k of await knowledgeRows()) {
      assert.equal(k.source, "auto");
      assert.match(k.learned_message_id, /^OWN-TRACE-/);
      assert.equal(k.learned_chat_id, JANE.chat);
      assert.ok(k.learned_message_at, "message time recorded");
      assert.match(k.short_code, /^K-/);
      assert.ok(k.business_slug === "dog_food" || k.business_slug === "by_sea");
      assert.doesNotMatch(JSON.stringify(k), /for everyone/, "the message wording is not copied into the knowledge row");
    }
    assert.equal(await count(`select 1 from public.ai_agent_learning_events where source_message_id like 'OWN-TRACE-%'`), 2);
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'knowledge.auto_learn' and details->>'source_chat_id' is not null`), 2);
  });

  test("!memory shows when and where each fact came from; the original message only to authorized senders, only from this business", async () => {
    await businessSays(priceText("25ft hose", 128), { id: "OWN-SRC-1" });
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id)
      values ('dog_food', ${lit(JANE.chat)}, ${lit(JANE.phone)}, 'outbound', 'The 25ft hose is $128 for everyone.', 'OWN-SRC-1');`);
    const [k] = await knowledgeRows();

    await staffSays("!memory");
    const list = (await feedbacks()).at(-1)!.body;
    assert.match(list, new RegExp(`${k.short_code} 25ft hose — \\$128\n {3}↳ \\d{1,2} \\w{3}, \\d\\d:\\d\\d · chat …0101`));
    assert.doesNotMatch(list, /for everyone/, "the list never quotes a chat");
    assert.doesNotMatch(list, /17585550101/);

    await staffSays(`!memory ${k.short_code}`);
    const detail = (await feedbacks()).at(-1)!.body;
    assert.match(detail, /Status: active/);
    assert.match(detail, /Source: chat …0101 · sent/);
    assert.match(detail, /Original message: “The 25ft hose is \$128 for everyone\.”/);

    await staffSays(`!memory ${k.short_code}`, { sender: STRANGER });
    const hidden = (await feedbacks()).at(-1)!.body;
    assert.match(hidden, /only shown to people who can manage knowledge/);
    assert.doesNotMatch(hidden, /for everyone/);

    await staffSays(`!forget ${k.short_code}`);
    await staffSays(`!memory ${k.short_code}`);
    assert.match((await feedbacks()).at(-1)!.body, /Status: removed/, "the source of a forgotten fact stays inspectable");

    await pg.run(`delete from public.whatsapp_messages;`);
    await staffSays(`!memory ${k.short_code}`);
    assert.match((await feedbacks()).at(-1)!.body, /no longer available in the inbox/);

    await staffSays("!memory K-ZZZZ");
    assert.match((await feedbacks()).at(-1)!.body, /don't have a learned fact/);
    await staffSays("!memory nonsense words");
    assert.match((await feedbacks()).at(-1)!.body, /Use “!memory”/);
    assert.equal((await customerBound()).length, 0);
    assert.ok((await feedbacks()).every((f) => f.to_jid === GROUP), "answers go to the staff group only");
  });

  test("source lookup is scoped to one business and to the recorded chat", async () => {
    const sources = await import("../lib/server/aiAgent/learningSources.ts");
    await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, direction, message_body, whatsapp_message_id)
      values ('dog_food', ${lit(JANE.chat)}, 'outbound', 'dog food message', 'M-1'), ('by_sea', ${lit(JANE.chat)}, 'outbound', 'sea message', 'M-1');`);
    const ref = { id: "k1", learned_message_id: "M-1", learned_message_at: "2026-11-03T18:05:00Z", learned_chat_id: JANE.chat };
    const dog = (await sources.loadSources("dog_food", [ref], { withText: true })).get("k1")!;
    assert.equal(dog.original, "dog food message");
    const sea = (await sources.loadSources("by_sea", [ref], { withText: true })).get("k1")!;
    assert.equal(sea.original, "sea message", "each business reads only its own inbox");
    assert.equal((await sources.loadSources("dog_food", [ref], { withText: false })).get("k1")!.original, null, "text is read only when asked for");
    const wrongChat = (await sources.loadSources("dog_food", [{ ...ref, learned_chat_id: "17585550777@s.whatsapp.net" }], { withText: true })).get("k1")!;
    assert.equal(wrongChat.original, null, "a message from another chat is not this fact's source");
    assert.equal(wrongChat.originalAvailable, false);
    assert.equal((await sources.loadSources("dog_food", [{ ...ref, learned_message_id: null }], { withText: true })).size, 0);
  });

  test("a forgotten fact is out of the very next model call, and unauthorized or customer-bound paths stay closed", async () => {
    await businessSays(priceText("25ft hose", 128));
    await businessSays(priceText("35ft hose", 164));
    await businessSays(priceText("50ft hose", 230));
    assert.deepEqual(analyzerCalls.at(-1)!.knowledge.sort(), ["25ft hose price", "35ft hose price"]);
    const [k] = await knowledgeRows();
    await staffSays(`!forget ${k.short_code}`, { sender: STRANGER });
    await businessSays("The 75ft hose is $300 for everyone.");
    assert.ok(analyzerCalls.at(-1)!.knowledge.includes("25ft hose price"), "an unauthorized !forget changed nothing");
    await staffSays(`!forget ${k.short_code}`);
    await businessSays("The 100ft hose is $390 for everyone.");
    assert.ok(!analyzerCalls.at(-1)!.knowledge.includes("25ft hose price"), "excluded immediately after !forget");
    assert.equal((await customerBound()).length, 0);
    assert.equal(await count(`select 1 from public.ai_agent_outbox where to_jid like '%@s.whatsapp.net'`), 0, "nothing was ever addressed to a customer");
  });

  test("DIGEST_THRESHOLD is ten", () => {
    assert.equal(DIGEST_THRESHOLD, 10);
  });
});
