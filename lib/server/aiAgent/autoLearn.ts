// Server-only: automatic business learning. A genuine outgoing human message of the business account in a customer
// chat may state a reusable fact. ONE model call (the existing staff-text analysis, in learning mode) proposes
// items; validateStaffItems() and decideAutoLearn() (lib/aiAgent/*) decide each one:
//
//   save / update  learn_ai_agent_fact(): approved knowledge in one transaction, a durable event for the digest
//   review         a PENDING suggestion (dashboard only — no staff-group notice; the digest carries the count)
//   duplicate/skip nothing is stored and nothing is counted
//
// This is independent of order monitoring: it has its own gate, its own model budget and its own failure handling,
// and it only ever produces knowledge. It never creates a customer-bound message: the only thing it can enqueue is
// the staff digest (learningDigest.ts), which passes the same outbox gate as every staff-group item.

import type { AgentSettings } from "@/lib/aiAgent/engine";
import {
  type ActiveFact,
  AUTO_CALLS_PER_HOUR,
  autoLearnWorthLooking,
  type AutoDecision,
  decideAutoLearn,
  isGenuineHumanOutgoing,
  subjectInConversation,
  readLearningMeta,
  RELEARN_BLOCK_DAYS,
  type RemovedFact,
  REVIEW_REASON_TEXT,
} from "@/lib/aiAgent/autoLearn";
import { validateStaffItems } from "@/lib/aiAgent/staffAnswers";
import { agentDb, audit, type KnowledgeRow, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import { flushLearningDigests } from "@/lib/server/aiAgent/learningDigest";
import { analyze, recentTranscript } from "@/lib/server/aiAgent/staffKnowledge";
import { storeCandidate } from "@/lib/server/aiAgent/teach";

export interface AutoLearnResult {
  /** Short, stable code for the event's reason list ("auto:learned", "auto:off"…). */
  outcome: string;
  learned: number;
  updated: number;
  reviews: number;
}

const idle = (outcome: string): AutoLearnResult => ({ outcome, learned: 0, updated: 0, reviews: 0 });

const normalise = (value: string) => value.replace(/\s+/g, " ").trim();

function toActive(rows: KnowledgeRow[]): ActiveFact[] {
  return rows.map((k) => ({
    id: k.id,
    kind: k.kind,
    title: k.title,
    content: k.content,
    source: k.source,
    subject_key: k.subject_key ?? null,
    price_amount: k.price_amount === null || k.price_amount === undefined ? null : Number(k.price_amount),
    fingerprint: k.fingerprint ?? null,
  }));
}

/** Recently forgotten or rejected: the same fact is not relearned (nor re-suggested) from a repeat of the same source. */
async function recentlyRemoved(businessSlug: string, fingerprint: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - RELEARN_BLOCK_DAYS * 86_400_000).toISOString();
  const db = agentDb();
  const [forgotten, rejected] = await Promise.all([
    db.from("ai_agent_knowledge").select("id").eq("business_slug", businessSlug).eq("fingerprint", fingerprint).eq("archived_reason", "forgotten").gt("archived_at", since).limit(1),
    db.from("ai_agent_learning_candidates").select("id").eq("business_slug", businessSlug).eq("fingerprint", fingerprint).eq("status", "rejected").gt("reviewed_at", since).limit(1),
  ]);
  if (forgotten.error) throw new Error(forgotten.error.message);
  if (rejected.error) throw new Error(rejected.error.message);
  return (forgotten.data ?? []).length > 0 || (rejected.data ?? []).length > 0;
}

/** What a person removed or rejected lately: the memory that keeps the same claim from coming straight back. */
async function loadRemoved(businessSlug: string, now: Date): Promise<RemovedFact[]> {
  const since = new Date(now.getTime() - RELEARN_BLOCK_DAYS * 86_400_000).toISOString();
  const db = agentDb();
  const [forgotten, rejected] = await Promise.all([
    db.from("ai_agent_knowledge").select("kind, title, content, subject_key, price_amount, fingerprint").eq("business_slug", businessSlug).eq("archived_reason", "forgotten").gt("archived_at", since).limit(100),
    db.from("ai_agent_learning_candidates").select("suggested_kind, suggested_title, staff_answer, fingerprint").eq("business_slug", businessSlug).eq("status", "rejected").gt("reviewed_at", since).limit(100),
  ]);
  if (forgotten.error) throw new Error(forgotten.error.message);
  if (rejected.error) throw new Error(rejected.error.message);
  const out: RemovedFact[] = [];
  for (const k of (forgotten.data ?? []) as { kind: string; title: string; content: string; subject_key: string | null; price_amount: number | string | null; fingerprint: string | null }[]) {
    out.push({ kind: k.kind, title: k.title, content: k.content, subject_key: k.subject_key, price_amount: k.price_amount === null ? null : Number(k.price_amount), fingerprint: k.fingerprint });
  }
  // A rejected suggestion records no product identity: only the same claim (or the same figures reworded) is suppressed.
  for (const c of (rejected.data ?? []) as { suggested_kind: string | null; suggested_title: string | null; staff_answer: string; fingerprint: string | null }[]) {
    out.push({ kind: c.suggested_kind, title: c.suggested_title, content: c.staff_answer, subject_key: null, price_amount: null, fingerprint: c.fingerprint });
  }
  return out;
}

async function scansLastHour(businessSlug: string, now: Date): Promise<string[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_audit_log")
    .select("target_id")
    .eq("business_slug", businessSlug)
    .eq("action", "learning.auto_scan")
    .gte("created_at", new Date(now.getTime() - 3_600_000).toISOString())
    .limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { target_id: string | null }[]).map((r) => r.target_id ?? "");
}

/**
 * Looks at ONE outgoing human message. Best effort: it never throws and never affects the message, the order
 * monitor or the conversation control around it.
 */
export async function maybeAutoLearn(args: {
  settings: AgentSettings;
  chatId: string;
  contactNumber: string | null;
  text: string;
  hasMedia: boolean;
  whatsappMessageId: string;
  timestamp: string | null;
  now?: Date;
}): Promise<AutoLearnResult> {
  const { settings } = args;
  try {
    if (!settings.enabled || settings.auto_learning_enabled !== true) return idle("auto:off");
    if (!isGenuineHumanOutgoing({ fromMe: true, chatId: args.chatId, text: args.text, hasMedia: args.hasMedia })) return idle("auto:not_human");
    if (!autoLearnWorthLooking(args.text)) return idle("auto:no_signal");
    const gate = await loadGateData(settings.business_slug, args.chatId, args.contactNumber, settings);
    if (gate.contactRule === "exclude") return idle("auto:excluded");

    const now = args.now ?? new Date();
    const scans = await scansLastHour(settings.business_slug, now);
    if (scans.includes(args.whatsappMessageId)) return idle("auto:already_scanned");
    if (scans.length >= AUTO_CALLS_PER_HOUR) return idle("auto:budget");
    // Counted before the call, so a failing model cannot be hammered and a bridge retry never pays twice.
    await audit(settings.business_slug, "system", null, "learning.auto_scan", { type: "message", id: args.whatsappMessageId }, {});

    const [knowledge, transcript] = await Promise.all([loadActiveKnowledge(settings.business_slug), recentTranscript(settings.business_slug, args.chatId)]);
    const result = await analyze({
      businessSlug: settings.business_slug,
      mode: "classify_only",
      learning: true,
      staffText: args.text,
      customerName: "the customer",
      customerMessages: "",
      transcript,
      knowledge,
      liveFacts: [],
    });
    if (!result.analysis) return idle("auto:no_analysis");

    const raw = result.analysis.items.map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>) : {}));
    const contextText = transcript.map((t) => t.text).join("\n");
    // A fact may repeat the digits of a product's NAME ("25ft hose") when the conversation names it; its prices and
    // measurements are still checked against the business's own words in decideAutoLearn().
    const names = raw.map((r) => readLearningMeta(r).subject).filter((s): s is string => subjectInConversation(s, args.text, contextText));
    const { accepted } = validateStaffItems(result.analysis.items, [args.text, ...names].join("\n"), now, null);
    const messageAt = args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? new Date(args.timestamp).toISOString() : null;
    const active = toActive(knowledge);
    const removed = await loadRemoved(settings.business_slug, now);
    const tally = idle("auto:nothing");
    const skipped: string[] = [];

    for (const item of accepted) {
      const meta = readLearningMeta(raw.find((r) => typeof r.content === "string" && normalise(r.content) === item.content));
      const decision = decideAutoLearn({ item, meta, staffText: args.text, contextText, active, removed });
      const outcome = await apply(settings, decision, { whatsappMessageId: args.whatsappMessageId, chatId: args.chatId }, messageAt, now, active);
      if (outcome === "learned") tally.learned += 1;
      else if (outcome === "updated") tally.updated += 1;
      else if (outcome === "review") tally.reviews += 1;
      else skipped.push(outcome);
    }

    const changed = tally.learned + tally.updated;
    if (changed > 0 || tally.reviews > 0) {
      await audit(settings.business_slug, "system", null, "learning.auto", { type: "message", id: args.whatsappMessageId }, {
        learned: tally.learned,
        updated: tally.updated,
        reviews: tally.reviews,
        skipped,
      });
    }
    if (changed > 0) await flushLearningDigests(settings);
    tally.outcome = changed > 0 ? "auto:learned" : tally.reviews > 0 ? "auto:review" : "auto:nothing";
    return tally;
  } catch (err) {
    console.error("[aiAgent] maybeAutoLearn", err instanceof Error ? err.message : err);
    return idle("auto:error");
  }
}

/** Carries out one decision. Returns "learned" | "updated" | "review", or the reason nothing was stored. */
async function apply(
  settings: AgentSettings,
  decision: AutoDecision,
  args: { whatsappMessageId: string; chatId: string },
  messageAt: string | null,
  now: Date,
  active: ActiveFact[]
): Promise<string> {
  const businessSlug = settings.business_slug;
  switch (decision.action) {
    case "skip":
      return `skip:${decision.reason}`;
    case "duplicate":
      return "duplicate";
    case "review":
      return (await propose(settings, decision, args, messageAt, now)) ? "review" : "skip:blocked";
    case "save":
    case "update": {
      const fact = decision.fact;
      const replaceId = decision.action === "update" ? decision.replaceId : null;
      const { data, error } = await agentDb().rpc("learn_ai_agent_fact", {
        p_business_slug: businessSlug,
        p_kind: fact.kind,
        p_title: fact.title,
        p_content: fact.content,
        p_subject_key: fact.subjectKey,
        p_price_amount: fact.priceAmount,
        p_fingerprint: fact.fingerprint,
        p_message_id: args.whatsappMessageId,
        p_message_at: messageAt,
        p_replace_id: replaceId,
        p_summary: fact.summary,
        p_block_days: RELEARN_BLOCK_DAYS,
        p_chat_id: args.chatId,
      });
      if (error) throw new Error(error.message);
      const out = data as { result: string; knowledge_id?: string; code?: string };
      if (out.result === "duplicate") return "duplicate";
      if (out.result === "blocked") return "skip:blocked";
      if (out.result === "stale") {
        // The entry to replace changed since we looked: a person decides instead.
        return (await propose(settings, { action: "review", reason: "conflicts_existing", fact, conflicts: [] }, args, messageAt, now)) ? "review" : "skip:blocked";
      }
      await audit(businessSlug, "system", null, replaceId ? "knowledge.auto_update" : "knowledge.auto_learn", { type: "knowledge", id: out.knowledge_id ?? null }, {
        code: out.code,
        kind: fact.kind,
        subject_key: fact.subjectKey,
        price_amount: fact.priceAmount,
        replaced_id: replaceId,
        source_message_id: args.whatsappMessageId,
        source_chat_id: args.chatId,
        source_message_at: messageAt,
        confidence: fact.confidence,
      });
      if (replaceId) {
        const at = active.findIndex((e) => e.id === replaceId);
        if (at >= 0) active.splice(at, 1);
      }
      active.push({ id: out.knowledge_id!, kind: fact.kind, title: fact.title, content: fact.content, source: "auto", subject_key: fact.subjectKey, price_amount: fact.priceAmount, fingerprint: fact.fingerprint });
      return replaceId ? "updated" : "learned";
    }
  }
}

/** A pending suggestion for the dashboard. False when it was recently removed, or is already known / already proposed. */
async function propose(
  settings: AgentSettings,
  decision: Extract<AutoDecision, { action: "review" }>,
  args: { whatsappMessageId: string },
  messageAt: string | null,
  now: Date
): Promise<boolean> {
  const fact = decision.fact;
  if (await recentlyRemoved(settings.business_slug, fact.fingerprint, now)) return false;
  const stored = await storeCandidate({
    settings,
    source: "auto_staff_chat",
    fact: fact.content,
    kind: fact.kind,
    title: fact.title,
    expiresAt: null,
    confidence: fact.confidence,
    proposedBy: null,
    senderVerified: false,
    escalation: null,
    sourceMessageId: args.whatsappMessageId,
    sourceMessageAt: messageAt,
    sourceText: null,
    reviewReason: decision.reason,
    fingerprint: fact.fingerprint,
    now,
  });
  if (!("row" in stored)) return false;
  await audit(settings.business_slug, "system", null, "learning.auto_review", { type: "learning", id: stored.row.id }, {
    code: stored.row.short_code,
    reason: decision.reason,
    reason_text: REVIEW_REASON_TEXT[decision.reason],
    conflicts: stored.conflicts.map((c) => c.id),
  });
  return true;
}
