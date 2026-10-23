// Server-only: what the agent does with the INFORMATION in a staff answer. One
// model call (the same model and key as the Inbox decision engine) proposes a
// customer draft and a classification; lib/aiAgent/staffAnswers.ts validates
// it; this file stores each class of fact where — and only where — it belongs:
//
//   durable            → a learning CANDIDATE for admin approval (the existing
//                        knowledge pipeline); never written to knowledge directly
//   temporary          → the staff-answer row, with an expiry and a scope
//   customer-specific  → ai_agent_customer_memory under THIS customer's key
//   one-off            → the audit row only; never reused for anyone
//
// Every answer leaves an audit row: the staff's words, when, which business,
// which escalation reference (ai_agent_staff_answers).

import type { AgentSettings } from "@/lib/aiAgent/engine";
import {
  assessKnowledgeCandidate,
  candidateFingerprint,
  customerFactStorable,
  type ClassifiedItem,
  type ItemOutcome,
  type KnowledgeEntryLite,
  validateStaffItems,
} from "@/lib/aiAgent/staffAnswers";
import { isOutbound } from "@/lib/whatsapp";
import { agentDb, audit, KnowledgeRow, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import { recordStaffCustomerFact } from "@/lib/server/aiAgent/memory";
import type { StaffAnalysisInput, StaffAnalysisResult } from "@/lib/server/aiAgent/model";
import type { EscalationRow } from "@/lib/server/aiAgent/escalations";

// ── The model seam ───────────────────────────────────────────────────────────

export type StaffAnalyzer = (input: StaffAnalysisInput) => Promise<StaffAnalysisResult>;
let analyzerOverride: StaffAnalyzer | null = null;

/** Tests only: replace the model call. Pass null to restore. */
export function setStaffAnalyzerForTests(fn: StaffAnalyzer | null): void {
  analyzerOverride = fn;
}

async function analyze(input: StaffAnalysisInput): Promise<StaffAnalysisResult> {
  if (analyzerOverride) return analyzerOverride(input);
  const { analyzeStaffAnswer } = await import("@/lib/server/aiAgent/model");
  return analyzeStaffAnswer(input);
}

// ── Audit rows ───────────────────────────────────────────────────────────────

export interface StaffAnswerRow {
  id: string;
  business_slug: string;
  escalation_id: string;
  ref_code: string;
  chat_id: string;
  source: "whatsapp" | "admin_ui";
  source_message_id: string;
  matched_via: "quote" | "ref" | "admin_ui" | null;
  command: "answer" | "send";
  body: string;
  staff_message_at: string | null;
  state: "processing" | "done" | "failed";
  draft: string | null;
  draft_source: "model" | "staff_text" | "stored_draft" | null;
  customer_action: "sent" | "withheld" | null;
  withheld_reason: string | null;
  draft_dedupe_key: string | null;
  customer_dedupe_key: string | null;
  items: ItemOutcome[];
  temporary_facts: StoredTemporaryFact[];
  valid_until: string | null;
  source_event_id: string | null;
  sender_jid: string | null;
  sender_id: string | null;
  sender_authorized: boolean;
  approves_answer_id: string | null;
  retry_count: number;
  error: string | null;
  created_at: string;
}

export const STAFF_ANSWER_COLUMNS =
  "id, business_slug, escalation_id, ref_code, chat_id, source, source_message_id, matched_via, command, body, staff_message_at, state, draft, draft_source, customer_action, withheld_reason, draft_dedupe_key, customer_dedupe_key, items, temporary_facts, valid_until, source_event_id, sender_jid, sender_id, sender_authorized, approves_answer_id, retry_count, error, created_at";

export interface StoredTemporaryFact {
  title: string;
  content: string;
  evidence: string;
  scope: "conversation" | "business";
  valid_until: string;
}

/**
 * Records a staff message that answers an escalation. Returns null when this
 * very message was already recorded — a repeated WhatsApp event (or a retried
 * request) is a no-op: no second draft, no second customer message.
 */
export async function startStaffAnswer(input: {
  escalation: EscalationRow;
  source: "whatsapp" | "admin_ui";
  sourceMessageId: string;
  sourceEventId: string | null;
  senderJid: string | null;
  matchedVia: "quote" | "ref" | "admin_ui";
  command: "answer" | "send";
  body: string;
  staffMessageAt: string | null;
  /** The verified identifier of the sender (never a display name) and whether the allow-list accepted it. */
  senderId?: string | null;
  senderAuthorized?: boolean;
  /** A "send" that approves a stored draft: the answer that produced that draft. */
  approvesAnswerId?: string | null;
}): Promise<StaffAnswerRow | null> {
  const e = input.escalation;
  const at = input.staffMessageAt && !Number.isNaN(Date.parse(input.staffMessageAt)) ? new Date(input.staffMessageAt).toISOString() : new Date().toISOString();
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .upsert(
      {
        business_slug: e.business_slug,
        escalation_id: e.id,
        ref_code: e.ref_code,
        chat_id: e.chat_id,
        source: input.source,
        source_message_id: input.sourceMessageId,
        source_event_id: input.sourceEventId,
        sender_jid: input.senderJid,
        sender_id: input.senderId ?? null,
        sender_authorized: input.senderAuthorized ?? false,
        approves_answer_id: input.approvesAnswerId ?? null,
        matched_via: input.matchedVia,
        command: input.command,
        body: input.body.slice(0, 4000) || "(approval)",
        staff_message_at: at,
      },
      { onConflict: "business_slug,source_message_id", ignoreDuplicates: true }
    )
    .select(STAFF_ANSWER_COLUMNS);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as StaffAnswerRow | undefined;
  return row ?? null;
}

export async function finishStaffAnswer(
  row: Pick<StaffAnswerRow, "id" | "business_slug">,
  patch: Partial<{
    state: "done" | "failed";
    draft: string | null;
    draft_source: StaffAnswerRow["draft_source"];
    customer_action: "sent" | "withheld" | null;
    withheld_reason: string | null;
    draft_dedupe_key: string | null;
    customer_dedupe_key: string | null;
    items: ItemOutcome[];
    temporary_facts: StoredTemporaryFact[];
    valid_until: string | null;
    model: string | null;
    error: string | null;
  }>
): Promise<void> {
  const { error } = await agentDb().from("ai_agent_staff_answers").update(patch).eq("id", row.id).eq("business_slug", row.business_slug);
  if (error) throw new Error(error.message);
}

// Only an answer that PRODUCED a draft (from the model, or the staff's own exact
// wording) can be approved. A later "send" row merely points at one of these (via
// approves_answer_id); its body is the word "send", never the text a draft must
// be checked against.
const DRAFT_ORIGINS = ["model", "staff_text"];

export async function answerById(businessSlug: string, escalationId: string, id: string): Promise<StaffAnswerRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select(STAFF_ANSWER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as StaffAnswerRow | undefined) ?? null;
}

/**
 * The staff_draft message a quoted reply points at, resolved to the answer that
 * produced the draft — within this business AND this escalation. The posted
 * confirmation of an earlier "send" resolves to the draft that send approved.
 */
export async function answerByDraftKey(businessSlug: string, escalationId: string, draftKey: string): Promise<StaffAnswerRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select(STAFF_ANSWER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("draft_dedupe_key", draftKey)
    .not("draft", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = ((data ?? [])[0] as StaffAnswerRow | undefined) ?? null;
  if (!row) return null;
  if (row.draft_source && DRAFT_ORIGINS.includes(row.draft_source)) return row;
  // A confirmation posted for a "send" of a stored draft: the draft it approved.
  return row.approves_answer_id ? answerById(businessSlug, escalationId, row.approves_answer_id) : null;
}

/** Every draft prepared for this escalation, newest first. */
export async function draftAnswers(businessSlug: string, escalationId: string): Promise<StaffAnswerRow[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select(STAFF_ANSWER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .in("draft_source", DRAFT_ORIGINS)
    .not("draft", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffAnswerRow[];
}

/** The newest draft prepared for this escalation (used by "!send" with an explicit #E- reference). */
export async function latestDraftAnswer(businessSlug: string, escalationId: string): Promise<StaffAnswerRow | null> {
  return (await draftAnswers(businessSlug, escalationId))[0] ?? null;
}

// ── Failures and retries ─────────────────────────────────────────────────────

/** Marks a staff answer that did not finish; never throws (it runs inside error handlers). */
export async function failStaffAnswer(row: Pick<StaffAnswerRow, "id" | "business_slug">, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err ?? "failed")).slice(0, 500);
  await finishStaffAnswer(row, { state: "failed", error: message }).catch((e) => console.error("[aiAgent] failStaffAnswer", e instanceof Error ? e.message : e));
}

/** WhatsApp answers of an event that did not finish (processing, or already marked failed). */
export async function openAnswersForEvent(businessSlug: string, eventId: string): Promise<StaffAnswerRow[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select(STAFF_ANSWER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("source_event_id", eventId)
    .in("state", ["processing", "failed"]);
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffAnswerRow[];
}

/** Atomically moves ONE failed answer back to processing; null when it is not (or no longer) failed. */
export async function claimAnswerRetry(businessSlug: string, answerId: string): Promise<StaffAnswerRow | null> {
  const { data, error } = await agentDb().rpc("claim_ai_agent_staff_answer_retry", { p_business_slug: businessSlug, p_answer_id: answerId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as StaffAnswerRow | undefined;
  return row ?? null;
}

// ── Temporary facts ──────────────────────────────────────────────────────────

/**
 * Staff-reported conditions still in force: this conversation's own, plus any
 * the staff explicitly marked business-wide — never past their expiry.
 */
export async function loadLiveStaffFacts(
  businessSlug: string,
  chatId: string,
  now: Date = new Date()
): Promise<{ content: string; validUntil: string }[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select("chat_id, temporary_facts, valid_until")
    .eq("business_slug", businessSlug)
    .gt("valid_until", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  const out: { content: string; validUntil: string }[] = [];
  for (const row of (data ?? []) as { chat_id: string; temporary_facts: StoredTemporaryFact[] }[]) {
    for (const f of row.temporary_facts ?? []) {
      if (Date.parse(f.valid_until) <= now.getTime()) continue;
      if (f.scope === "business" || row.chat_id === chatId) out.push({ content: f.content, validUntil: f.valid_until });
    }
  }
  return out.slice(0, 8);
}

// ── Analysis + storage ───────────────────────────────────────────────────────

export interface StaffAnalysisOutcome {
  /** The model's customer draft (draft_and_classify only). */
  draft: string | null;
  outcomes: ItemOutcome[];
  temporaryFacts: StoredTemporaryFact[];
  validUntil: string | null;
  model: string | null;
  /** Set when the model call failed: nothing was drafted or learned. */
  error: string | null;
}

async function recentTranscript(businessSlug: string, chatId: string): Promise<{ who: "Customer" | "Staff"; text: string }[]> {
  const { data } = await agentDb()
    .from("whatsapp_messages")
    .select("direction, message_body, timestamp")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .order("timestamp", { ascending: false })
    .limit(10);
  return ((data ?? []) as { direction: string; message_body: string | null }[])
    .filter((m) => m.message_body?.trim())
    .reverse()
    .map((m) => ({ who: isOutbound(m.direction) ? ("Staff" as const) : ("Customer" as const), text: m.message_body!.trim().slice(0, 500) }));
}

/**
 * Runs the single model call for one staff answer, validates the proposed
 * items, and stores each class of fact where it belongs. Never throws for a
 * model failure: the caller gets `error` and the answer stays recorded.
 */
export async function analyzeAndStore(args: {
  settings: AgentSettings;
  escalation: EscalationRow;
  answer: Pick<StaffAnswerRow, "id" | "business_slug" | "source_message_id" | "staff_message_at">;
  mode: "draft_and_classify" | "classify_only";
  staffText: string;
  knowledge?: KnowledgeRow[];
  now?: Date;
}): Promise<StaffAnalysisOutcome> {
  const { settings, escalation: e } = args;
  const now = args.now ?? new Date();
  const knowledge = args.knowledge ?? (await loadActiveKnowledge(e.business_slug));
  const [transcript, liveFacts] = await Promise.all([
    args.mode === "draft_and_classify" ? recentTranscript(e.business_slug, e.chat_id) : Promise.resolve([]),
    loadLiveStaffFacts(e.business_slug, e.chat_id, now),
  ]);

  const result = await analyze({
    businessSlug: e.business_slug,
    mode: args.mode,
    staffText: args.staffText,
    customerName: e.customer_name ?? "the customer",
    customerMessages: e.customer_message ?? "",
    transcript,
    knowledge,
    liveFacts,
  });
  if (!result.analysis) {
    return { draft: null, outcomes: [], temporaryFacts: [], validUntil: null, model: result.model, error: result.error ?? "analysis unavailable" };
  }

  const { accepted, rejected } = validateStaffItems(result.analysis.items, args.staffText, now, e.customer_name);
  const outcomes: ItemOutcome[] = rejected.map((r) => ({
    category: "one_off",
    disposition: "skipped",
    title: "",
    content: r.content,
    note: `rejected:${r.reason}`,
  }));
  const temporaryFacts: StoredTemporaryFact[] = [];

  const approved: KnowledgeEntryLite[] = knowledge.map((k) => ({ id: k.id, kind: k.kind, title: k.title, content: k.content }));
  for (const item of accepted) {
    try {
      outcomes.push(await storeItem({ settings, e, answer: args.answer, item, approved, temporaryFacts, staffText: args.staffText }));
    } catch (err) {
      console.error("[aiAgent] store staff item", err instanceof Error ? err.message : err);
      outcomes.push({ category: item.category, disposition: "skipped", title: item.title, content: item.content, note: "store_failed" });
    }
  }

  const validUntil = temporaryFacts.map((f) => f.valid_until).sort().pop() ?? null;
  await audit(e.business_slug, "staff", null, "staff_answer.classified", { type: "escalation", id: e.id }, {
    ref_code: e.ref_code,
    answer_id: args.answer.id,
    categories: accepted.map((i) => i.category),
    dispositions: outcomes.map((o) => o.disposition),
  });
  return {
    draft: args.mode === "draft_and_classify" ? result.analysis.customerReply : null,
    outcomes,
    temporaryFacts,
    validUntil,
    model: result.model,
    error: null,
  };
}

async function storeItem(args: {
  settings: AgentSettings;
  e: EscalationRow;
  answer: Pick<StaffAnswerRow, "id" | "source_message_id" | "staff_message_at">;
  item: ClassifiedItem;
  approved: KnowledgeEntryLite[];
  temporaryFacts: StoredTemporaryFact[];
  staffText: string;
}): Promise<ItemOutcome> {
  const { item, e } = args;
  const base = { category: item.category, title: item.title, content: item.content };

  switch (item.category) {
    case "durable": {
      const assessment = assessKnowledgeCandidate({ kind: item.kind ?? "faq", title: item.title, content: item.content }, args.approved);
      if (assessment.duplicateOf) {
        return { ...base, disposition: "already_known", note: `matches:${assessment.duplicateOf.id}` };
      }
      const { data, error } = await agentDb()
        .from("ai_agent_learning_candidates")
        .upsert(
          {
            business_slug: e.business_slug,
            escalation_id: e.id,
            question: (e.customer_message ?? "").slice(0, 1000) || null,
            staff_answer: item.content,
            category: "durable",
            suggested_kind: item.kind ?? "faq",
            suggested_title: item.title,
            source_message: args.staffText.slice(0, 2000),
            source_message_at: args.answer.staff_message_at,
            source_message_id: args.answer.source_message_id,
            ref_code: e.ref_code,
            answer_id: args.answer.id,
            fingerprint: candidateFingerprint(item.content),
            conflicts: assessment.conflicts,
          },
          { onConflict: "business_slug,escalation_id,fingerprint", ignoreDuplicates: true }
        )
        .select("id");
      if (error) throw new Error(error.message);
      if ((data ?? []).length === 0) return { ...base, disposition: "skipped", note: "already_proposed" };
      return { ...base, disposition: assessment.conflicts.length > 0 ? "candidate_conflict" : "candidate", note: (data as { id: string }[])[0].id };
    }
    case "temporary": {
      args.temporaryFacts.push({
        title: item.title,
        content: item.content,
        evidence: item.evidence,
        scope: item.scope ?? "conversation",
        valid_until: item.validUntil!,
      });
      return { ...base, disposition: "temporary", validUntil: item.validUntil };
    }
    case "customer_specific": {
      if (!args.settings.customer_memory_enabled) return { ...base, disposition: "recorded_only", note: "customer_memory_off" };
      const storable = customerFactStorable(item.content);
      if (!storable.ok) return { ...base, disposition: "recorded_only", note: storable.reason };
      const identity = await loadIdentity(e.business_slug, e.chat_id, e.contact_number);
      const saved = await recordStaffCustomerFact({
        businessSlug: e.business_slug,
        chatId: e.chat_id,
        identity,
        escalationId: e.id,
        refCode: e.ref_code,
        content: item.content,
        evidence: item.evidence,
      });
      return { ...base, disposition: saved ? "customer_memory" : "recorded_only", note: saved ? undefined : "already_on_record" };
    }
    case "one_off":
      return { ...base, disposition: "recorded_only", note: "one_off_not_reusable" };
  }
}

// ── Admin dashboard answers ──────────────────────────────────────────────────

/**
 * An admin answered from the dashboard with exact text (applyStaffAction already
 * queued or withheld the customer message). The same audit row and the same
 * classification as a WhatsApp answer, so the learning loop has one pipeline.
 * Best effort: a failure here never undoes the answer.
 */
export async function recordAdminAnswer(args: {
  settings: AgentSettings | null;
  escalation: EscalationRow;
  text: string;
  adminId: string | null;
  digest: string;
  relayed: boolean;
  /** Why the customer was not messaged (WithholdReason), when relayed is false. */
  withheldReason?: string | null;
}): Promise<void> {
  if (!args.settings) return;
  const answer = await startStaffAnswer({
    escalation: args.escalation,
    source: "admin_ui",
    sourceMessageId: `ui:${args.escalation.id}:${args.digest}`,
    sourceEventId: null,
    senderJid: args.adminId,
    matchedVia: "admin_ui",
    command: "send",
    body: args.text,
    staffMessageAt: null,
  });
  if (!answer) return;
  try {
    const analysis = await analyzeAndStore({
      settings: args.settings,
      escalation: args.escalation,
      answer,
      mode: "classify_only",
      staffText: args.text,
    });
    await finishStaffAnswer(answer, {
      state: "done",
      draft: args.text,
      draft_source: "staff_text",
      customer_action: args.relayed ? "sent" : "withheld",
      withheld_reason: args.relayed ? null : args.withheldReason ?? (args.settings.mode === "observe" ? "observe_mode" : "agent_disabled"),
      items: analysis.outcomes,
      temporary_facts: analysis.temporaryFacts,
      valid_until: analysis.validUntil,
      model: analysis.model,
      error: analysis.error,
    });
  } catch (err) {
    await finishStaffAnswer(answer, { state: "failed", error: (err instanceof Error ? err.message : "failed").slice(0, 500) }).catch(() => {});
    throw err;
  }
}
