// Client-safe: AI evaluation ("shadow") rules. Pure, no I/O.
//
// A shadow result is what the AI proposed ON ITS OWN for a customer turn that
// staff actually handled (Observe mode, Staff First, Manual Only). It is data
// for the admin to rate. It is never a message: nothing in this module (or the
// table it describes) can reach the outbox.
//
//   historical  captured at the time of the turn from the ONE model call the
//               live pipeline already made. No extra call, and the knowledge,
//               memory and context are exactly those of that moment. Later
//               staff answers, knowledge or stock facts cannot enter it.
//   simulation  an admin re-ran a past turn later, with TODAY's knowledge.
//               Always labelled as such; never mixed into historical results.

import type { AgentDecision, ModelProposal, RequestCategory, Resolution } from "@/lib/aiAgent/engine";

export type ShadowKind = "historical" | "simulation";

export const SHADOW_RATINGS = ["correct", "needs_improvement", "incorrect"] as const;
export type ShadowRating = (typeof SHADOW_RATINGS)[number];

export const RATING_LABEL: Record<ShadowRating, string> = {
  correct: "Correct",
  needs_improvement: "Needs improvement",
  incorrect: "Incorrect",
};

export const KIND_LABEL: Record<ShadowKind, string> = {
  historical: "Captured at the time",
  simulation: "Simulation (current knowledge)",
};

export const MAX_QUESTION_CHARS = 1000;
export const MAX_FEEDBACK_CHARS = 1000;
export const SHADOW_RETENTION_DAYS = 90;
/** Cost guard: admin-triggered simulations per business per hour. */
export const SIMULATIONS_PER_HOUR = 30;

// ── Eligibility ──────────────────────────────────────────────────────────────

export interface CaptureCheck {
  /** The business opted in (ai_agent_settings.shadow_capture_enabled). */
  enabled: boolean;
  gatePass: boolean;
  /** The AI really answers this customer by itself (Assisted + Auto-Reply): actual == independent, nothing to compare. */
  aiRepliesDirectly: boolean;
  /** "thanks", "ok", "hello": nothing to evaluate. */
  trivialTurn: boolean;
  /** Staff already own the conversation: the model is told not to answer, so its output is not an independent answer. */
  openEscalation: boolean;
  safeguards: string[];
  /** The pipeline produced a model proposal (a skipped or failed call has none). */
  hasProposal: boolean;
}

/** Why this turn is not captured, or null when it is. Capturing is free: it reuses the live model call. */
export function shadowCaptureSkip(c: CaptureCheck): string | null {
  if (!c.enabled) return "capture_disabled";
  if (!c.gatePass) return "gate_blocked";
  if (c.aiRepliesDirectly) return "ai_replies_directly";
  if (c.trivialTurn) return "acknowledgement";
  if (c.openEscalation) return "staff_own_conversation";
  if (c.safeguards.includes("prompt_injection")) return "prompt_injection";
  if (!c.hasProposal) return "no_model_proposal";
  return null;
}

// ── Keys and fingerprints ────────────────────────────────────────────────────

/** One historical result per turn, however many times the turn is processed (batch retries). */
export function historicalKey(eventId: string): string {
  return `hist:${eventId}`;
}

/** One simulation per turn per knowledge state: re-clicking costs nothing, and only a knowledge change allows a new run. */
export function simulationKey(eventId: string, knowledgeVer: string): string {
  return `sim:${eventId}:${knowledgeVer}`;
}

/** FNV-1a, enough to tell two knowledge states apart (not a security hash). */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Identifies the exact set (and edit versions) of approved knowledge the model was given. */
export function knowledgeVersion(rows: { id: string; version: number; updated_at: string }[]): string {
  const key = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}:${r.version}:${r.updated_at}`)
    .join("|");
  return `k${rows.length}-${fnv(key)}`;
}

/** Rough token count (≈4 characters per token) for when the API reports no usage. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

// ── The stored record ────────────────────────────────────────────────────────

export interface ShadowUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** true = estimated from text length, false = reported by the model API. */
  estimated: boolean;
}

export interface ShadowRecordInput {
  kind: ShadowKind;
  businessSlug: string;
  chatId: string;
  sourceEventId: string | null;
  customerQuestion: string;
  turnAt: string | null;
  resolution: Resolution;
  proposal: ModelProposal | null;
  category: RequestCategory | null;
  model: string | null;
  /** Ids the model cited that exist in the knowledge it was given. */
  knowledgeIds: string[];
  knowledgeVersion: string;
  knowledgeCount: number;
  postTurnKnowledgeIds?: string[];
  memoryUsed: boolean;
  usage: ShadowUsage | null;
  simulatedBy?: string | null;
}

/** The ai_agent_shadow_results insert shape. Pure: what is stored is decided here, and tests pin it. */
export function buildShadowRecord(input: ShadowRecordInput): Record<string, unknown> {
  const { resolution: r, proposal } = input;
  const historical = input.kind === "historical";
  const dedupe = historical
    ? historicalKey(input.sourceEventId ?? `${input.chatId}:${input.turnAt ?? ""}`)
    : simulationKey(input.sourceEventId ?? input.chatId, input.knowledgeVersion);
  return {
    business_slug: input.businessSlug,
    chat_id: input.chatId,
    kind: input.kind,
    source_event_id: input.sourceEventId,
    dedupe_key: dedupe,
    customer_question: input.customerQuestion.slice(0, MAX_QUESTION_CHARS) || null,
    turn_at: input.turnAt,
    decision: r.decision,
    reply: r.reply,
    draft_reply: r.draftReply,
    confidence: r.confidence,
    // autonomy 0 means "never auto-send": an infinite threshold is stored as unknown.
    required_confidence: Number.isFinite(r.requiredConfidence) ? r.requiredConfidence : null,
    reason_codes: r.reasons,
    escalation_reason: proposal?.escalation_reason ?? null,
    intent: proposal?.intent ?? null,
    category: input.category,
    model: input.model,
    knowledge_ids: input.knowledgeIds,
    knowledge_version: input.knowledgeVersion,
    knowledge_count: input.knowledgeCount,
    uses_current_knowledge: !historical,
    post_turn_knowledge_ids: historical ? [] : (input.postTurnKnowledgeIds ?? []),
    memory_used: input.memoryUsed,
    input_tokens: input.usage?.inputTokens ?? null,
    output_tokens: input.usage?.outputTokens ?? null,
    tokens_estimated: input.usage?.estimated ?? true,
    simulated_by: historical ? null : (input.simulatedBy ?? null),
  };
}

/** What the shadow answer says, for display: the sendable reply, else the model's suggestion. */
export function shadowText(row: { reply: string | null; draft_reply: string | null }): string | null {
  return row.reply?.trim() || row.draft_reply?.trim() || null;
}

// ── Ratings ──────────────────────────────────────────────────────────────────

export type RatingInput = { ok: true; rating: ShadowRating | null; feedback: string | null } | { ok: false; error: string };

/** `rating: null` clears a rating (and its feedback). Feedback is optional free text, trimmed and capped. */
export function parseRatingInput(body: { rating?: unknown; feedback?: unknown } | null): RatingInput {
  if (!body) return { ok: false, error: "Invalid body" };
  if (body.rating === null) return { ok: true, rating: null, feedback: null };
  if (typeof body.rating !== "string" || !(SHADOW_RATINGS as readonly string[]).includes(body.rating)) {
    return { ok: false, error: `rating must be one of: ${SHADOW_RATINGS.join(", ")}` };
  }
  if (body.feedback !== undefined && body.feedback !== null && typeof body.feedback !== "string") {
    return { ok: false, error: "feedback must be text" };
  }
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (feedback.length > MAX_FEEDBACK_CHARS) return { ok: false, error: `feedback is limited to ${MAX_FEEDBACK_CHARS} characters` };
  return { ok: true, rating: body.rating as ShadowRating, feedback: feedback || null };
}

// ── Summaries ────────────────────────────────────────────────────────────────

export interface SummaryRow {
  id: string;
  kind: ShadowKind;
  decision: AgentDecision | string;
  category: string | null;
  reason_codes: string[];
  rating: ShadowRating | null;
  customer_question: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface EvaluationSummary {
  total: number;
  historical: number;
  simulations: number;
  rated: number;
  correct: number;
  needsImprovement: number;
  incorrect: number;
  /** Share of rated answers marked Correct, 0..1; null until something is rated. */
  correctRate: number | null;
  /** What the AI would have sent on its own (REPLY/ASK), as a share of all results. */
  wouldAnswerRate: number | null;
  tokens: { input: number; output: number; withUsage: number };
}

export function summarizeResults(rows: SummaryRow[]): EvaluationSummary {
  const rated = rows.filter((r) => r.rating);
  const count = (rating: ShadowRating) => rows.filter((r) => r.rating === rating).length;
  const withUsage = rows.filter((r) => r.input_tokens !== null || r.output_tokens !== null);
  return {
    total: rows.length,
    historical: rows.filter((r) => r.kind === "historical").length,
    simulations: rows.filter((r) => r.kind === "simulation").length,
    rated: rated.length,
    correct: count("correct"),
    needsImprovement: count("needs_improvement"),
    incorrect: count("incorrect"),
    correctRate: rated.length > 0 ? count("correct") / rated.length : null,
    wouldAnswerRate: rows.length > 0 ? rows.filter((r) => r.decision === "REPLY" || r.decision === "ASK").length / rows.length : null,
    tokens: {
      input: withUsage.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
      output: withUsage.reduce((n, r) => n + (r.output_tokens ?? 0), 0),
      withUsage: withUsage.length,
    },
  };
}

/** Escalations the engine made because the approved knowledge could not support an answer. */
const KNOWLEDGE_GAP_CODES = new Set(["unverified_answer", "model_uncertain", "model_escalated", "low_confidence"]);
/** Categories where "not enough knowledge" is the usual cause (a complaint or an order is staff work, not a gap). */
const GAP_CATEGORIES = new Set(["product_enquiry", "unanswered_question", "other"]);

export type GapSignal = "missing_knowledge" | "answer_quality";

export interface KnowledgeGap {
  category: string;
  signal: GapSignal;
  count: number;
  simulationCount: number;
  incorrect: number;
  needsImprovement: number;
  /** A few customer questions, verbatim and clipped, so an admin can see what is being asked. */
  examples: string[];
  shadowIds: string[];
}

/**
 * Recurring patterns an admin may want to act on. Read-only: it never creates,
 * approves or edits knowledge — the admin does that in the Knowledge tab.
 */
export function summarizeGaps(rows: SummaryRow[], options: { minCount?: number; maxGaps?: number } = {}): KnowledgeGap[] {
  const minCount = options.minCount ?? 2;
  const groups = new Map<string, KnowledgeGap>();
  const add = (row: SummaryRow, signal: GapSignal) => {
    const category = row.category ?? "other";
    const key = `${category}|${signal}`;
    let g = groups.get(key);
    if (!g) {
      g = { category, signal, count: 0, simulationCount: 0, incorrect: 0, needsImprovement: 0, examples: [], shadowIds: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (row.kind === "simulation") g.simulationCount += 1;
    if (row.rating === "incorrect") g.incorrect += 1;
    if (row.rating === "needs_improvement") g.needsImprovement += 1;
    g.shadowIds.push(row.id);
    const q = row.customer_question?.replace(/\s+/g, " ").trim();
    if (q && g.examples.length < 3 && !g.examples.includes(q.slice(0, 160))) g.examples.push(q.slice(0, 160));
  };
  for (const row of rows) {
    if (row.rating === "incorrect" || row.rating === "needs_improvement") add(row, "answer_quality");
    else if (
      row.decision === "ESCALATE" &&
      GAP_CATEGORIES.has(row.category ?? "other") &&
      row.reason_codes.some((c) => KNOWLEDGE_GAP_CODES.has(c))
    ) {
      add(row, "missing_knowledge");
    }
  }
  return Array.from(groups.values())
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, options.maxGaps ?? 10);
}

// ── What the admin sees ──────────────────────────────────────────────────────

/** One evaluation row with the real-world outcome joined alongside (never merged into it). */
export interface EvaluationItem {
  id: string;
  kind: ShadowKind;
  chatId: string;
  customerLabel: string | null;
  customerQuestion: string | null;
  turnAt: string | null;
  capturedAt: string;
  /** The AI's independent proposal. */
  shadow: {
    decision: AgentDecision | string;
    reply: string | null;
    draftReply: string | null;
    confidence: number | null;
    requiredConfidence: number | null;
    reasons: string[];
    escalationReason: string | null;
    intent: string | null;
    category: string | null;
  };
  /** How it was produced. */
  provenance: {
    model: string | null;
    knowledgeVersion: string | null;
    knowledgeCount: number | null;
    knowledgeUsed: { id: string; title: string | null }[];
    usesCurrentKnowledge: boolean;
    knowledgeChangedSinceTurn: number;
    memoryUsed: boolean | null;
    inputTokens: number | null;
    outputTokens: number | null;
    tokensEstimated: boolean;
  };
  /** What really happened to this turn. */
  actual: {
    decision: string | null;
    reasons: string[];
    mode: string | null;
    escalation: { refCode: string; status: string; reason: string } | null;
  } | null;
  staffAnswer: { text: string | null; answeredAt: string | null; via: string | null } | null;
  /** The staff-assisted draft (a separate model call made after staff answered). */
  assistedDraft: { text: string | null; source: string | null; customerAction: string | null; withheldReason: string | null } | null;
  delivery: {
    staffNotice: string | null;
    staffDraft: string | null;
    customer: { kind: string; state: string } | null;
  };
  rating: ShadowRating | null;
  feedback: string | null;
  ratedAt: string | null;
  /** Approval Pilot: the AI draft versus what staff finally approved, for the same request (null outside the pilot). */
  pilot: PilotReview | null;
}

/** What staff did with the AI's own draft in Approval Pilot, and what the AI was missing (immutable snapshots, joined at read time). */
export interface PilotReview {
  escalationId: string;
  refCode: string | null;
  customerLabel: string | null;
  customerQuestion: string | null;
  /** The AI's suggestion exactly as it was shown (version 1), with what it knew then. */
  aiDraft: { version: number; text: string; ready: boolean; notes: string[]; knowledgeVersion: string | null; at: string };
  /** What finally reached (or is waiting to reach) the customer; null while undecided. */
  final: { text: string; how: "approved" | "sent_own_text"; version: number | null; source: string | null; at: string | null } | null;
  /** approved_as_is | approved_after_confirm | edited | rejected | replaced_by_staff_text | superseded | null (undecided). */
  outcome: string | null;
  verdict: "correct" | "missing_information" | "factually_wrong" | null;
  verdictSource: "staff" | "inferred" | "admin" | null;
  verdictNote: string | null;
  /** Facts staff taught for this request: the knowledge the AI was missing. */
  gaps: { code: string | null; fact: string; status: string; source: string | null }[];
  versions: number;
  /** The 90-day retention policy blanked the draft wording; only metadata remains. */
  contentPurged: boolean;
  /** Newest first. Every manual verdict change, with who/why. */
  verdictHistory: { at: string; from: string | null; to: string; reason: string; by: string | null }[];
  /** The latest "Test Again": a SIMULATION with today's knowledge, never what the AI said or staff saw. */
  simulation: {
    id: string;
    at: string;
    decision: string;
    reply: string | null;
    knowledgeVersion: string | null;
    /** Today's knowledge differs from what the historical draft was written from. */
    knowledgeChangedSinceDraft: boolean;
  } | null;
}

export interface PilotSummary {
  total: number;
  correct: number;
  missingInformation: number;
  factuallyWrong: number;
  /** No verdict yet: wording-only edits, or still undecided. */
  unjudged: number;
  edited: number;
  rejected: number;
  undecided: number;
}

export function summarizePilot(reviews: Pick<PilotReview, "verdict" | "outcome">[]): PilotSummary {
  const count = (f: (r: Pick<PilotReview, "verdict" | "outcome">) => boolean) => reviews.filter(f).length;
  return {
    total: reviews.length,
    correct: count((r) => r.verdict === "correct"),
    missingInformation: count((r) => r.verdict === "missing_information"),
    factuallyWrong: count((r) => r.verdict === "factually_wrong"),
    unjudged: count((r) => r.verdict === null),
    edited: count((r) => r.outcome === "edited" || r.outcome === "replaced_by_staff_text"),
    rejected: count((r) => r.outcome === "rejected"),
    undecided: count((r) => r.outcome === null),
  };
}

export interface SimulationCandidate {
  eventId: string;
  chatId: string;
  excerpt: string | null;
  decision: string | null;
  reasons: string[];
  createdAt: string;
}

export interface EvaluationResponse {
  captureEnabled: boolean;
  /** false when the evaluation migration has not been applied yet. */
  available: boolean;
  items: EvaluationItem[];
  summary: EvaluationSummary;
  gaps: KnowledgeGap[];
  candidates: SimulationCandidate[];
  simulationsLastHour: number;
  simulationLimitPerHour: number;
  retentionDays: number;
  /** Approval Pilot reviews (independent of shadow capture): one per request where the AI proposed a draft. */
  pilotReviews: PilotReview[];
  pilotSummary: PilotSummary;
}

export type SimulationOutcome =
  | { status: "simulated" | "cached" | "historical_exists"; id: string }
  | { status: "skipped"; reason: string };

const SKIP_TEXT: Record<string, string> = {
  not_found: "That message was not found for this business.",
  not_a_customer_message: "Only customer messages can be simulated.",
  agent_not_configured: "This business has no AI agent settings yet.",
  no_text: "The message has no text to evaluate (media only, or the text has been purged).",
  acknowledgement: "Skipped: a thank-you / hello / ok. No model call was made.",
  prompt_injection: "Skipped: the message looks like an instruction to the AI. No model call was made.",
  contact_not_permitted: "Skipped: this contact is not permitted for the AI agent. Customer text was not sent to the model.",
  simulation_limit: "Simulation limit reached for this hour. Try again later.",
  no_model_call: "Nothing to evaluate: the engine decided without asking the model.",
  model_error: "The model call failed. Nothing was stored.",
  staff_own_conversation: "Staff already own this conversation.",
};

export function skipReasonText(reason: string): string {
  return SKIP_TEXT[reason] ?? `Skipped (${reason}).`;
}
