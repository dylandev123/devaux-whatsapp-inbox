// Server-only: storage and read model for AI evaluation (shadow answers).
//
// This file deliberately imports nothing from outbox.ts / adminSend.ts /
// customerSend.ts: shadow data is write-once evidence for admins and has no
// path to WhatsApp. It only writes ai_agent_shadow_results (and the audit log).

import {
  type EvaluationItem,
  type EvaluationResponse,
  type KnowledgeGap,
  type PilotReview,
  type ShadowKind,
  type ShadowRating,
  type SimulationCandidate,
  SHADOW_RETENTION_DAYS,
  SIMULATIONS_PER_HOUR,
  summarizeGaps,
  summarizePilot,
  summarizeResults,
  type SummaryRow,
} from "@/lib/aiAgent/evaluation";
import { outboxState } from "@/lib/aiAgent/outboxStatus";
import { agentDb, audit } from "@/lib/server/aiAgent/db";

const SHADOW_COLUMNS =
  "id, business_slug, chat_id, kind, source_event_id, customer_question, turn_at, decision, reply, draft_reply, confidence, required_confidence, reason_codes, escalation_reason, intent, category, model, knowledge_ids, knowledge_version, knowledge_count, uses_current_knowledge, post_turn_knowledge_ids, memory_used, input_tokens, output_tokens, tokens_estimated, captured_at, rating, feedback, rated_at, created_at";

export interface ShadowRow {
  id: string;
  business_slug: string;
  chat_id: string;
  kind: ShadowKind;
  source_event_id: string | null;
  customer_question: string | null;
  turn_at: string | null;
  decision: string;
  reply: string | null;
  draft_reply: string | null;
  confidence: number | null;
  required_confidence: number | null;
  reason_codes: string[];
  escalation_reason: string | null;
  intent: string | null;
  category: string | null;
  model: string | null;
  knowledge_ids: string[];
  knowledge_version: string | null;
  knowledge_count: number | null;
  uses_current_knowledge: boolean;
  post_turn_knowledge_ids: string[];
  memory_used: boolean | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tokens_estimated: boolean;
  captured_at: string;
  rating: ShadowRating | null;
  feedback: string | null;
  rated_at: string | null;
  created_at: string;
}

/** Opt-in switch. A missing column (migration not applied) reads as off, never as an error. */
export async function shadowCaptureEnabled(businessSlug: string): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_settings")
    .select("shadow_capture_enabled")
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) return false;
  return Boolean((data as { shadow_capture_enabled?: boolean } | null)?.shadow_capture_enabled);
}

export async function setShadowCaptureEnabled(businessSlug: string, enabled: boolean, adminId: string): Promise<void> {
  const { data, error } = await agentDb()
    .from("ai_agent_settings")
    .update({ shadow_capture_enabled: enabled })
    .eq("business_slug", businessSlug)
    .select("business_slug");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("This business has no AI agent settings yet");
  await audit(businessSlug, "admin", adminId, "evaluation.capture_toggled", { type: "settings", id: businessSlug }, { enabled });
}

/** Stores one result. A repeated key (batch retry, re-clicked simulation) stores nothing and returns null. */
export async function saveShadowRecord(record: Record<string, unknown>): Promise<ShadowRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_shadow_results")
    .upsert(record, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select(SHADOW_COLUMNS);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as ShadowRow | undefined) ?? null;
}

export async function findShadowByKey(businessSlug: string, dedupeKey: string): Promise<ShadowRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_shadow_results")
    .select(SHADOW_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ShadowRow | null) ?? null;
}

/** The historical result of a turn, matched by any of the turn's events. */
export async function findHistoricalForEvents(businessSlug: string, eventIds: string[]): Promise<ShadowRow | null> {
  if (eventIds.length === 0) return null;
  const { data, error } = await agentDb()
    .from("ai_agent_shadow_results")
    .select(SHADOW_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("kind", "historical")
    .in("source_event_id", eventIds)
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as ShadowRow | undefined) ?? null;
}

export async function countRecentSimulations(businessSlug: string): Promise<number> {
  const { count, error } = await agentDb()
    .from("ai_agent_shadow_results")
    .select("id", { count: "exact", head: true })
    .eq("business_slug", businessSlug)
    .eq("kind", "simulation")
    .gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Admin rating. Business-scoped; `rating: null` clears it. */
export async function rateShadow(input: {
  businessSlug: string;
  id: string;
  rating: ShadowRating | null;
  feedback: string | null;
  adminId: string;
}): Promise<ShadowRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_shadow_results")
    .update({
      rating: input.rating,
      feedback: input.feedback,
      rated_by: input.rating ? input.adminId : null,
      rated_at: input.rating ? new Date().toISOString() : null,
    })
    .eq("id", input.id)
    .eq("business_slug", input.businessSlug)
    .select(SHADOW_COLUMNS);
  if (error) throw new Error(error.message);
  const row = ((data ?? [])[0] as ShadowRow | undefined) ?? null;
  if (row) {
    await audit(input.businessSlug, "admin", input.adminId, "evaluation.rated", { type: "shadow_result", id: row.id }, { rating: input.rating });
  }
  return row;
}

/** Retention: shadow rows older than SHADOW_RETENTION_DAYS are deleted. Best effort. */
export async function purgeShadowResults(): Promise<void> {
  const { error } = await agentDb().rpc("purge_ai_agent_shadow_results", { p_older_than: `${SHADOW_RETENTION_DAYS} days` });
  if (error) console.error("[aiAgent] purge shadow results", error.message);
}

// ── Read model ───────────────────────────────────────────────────────────────

const LIST_LIMIT = 150;

function isMissingTable(message: string): boolean {
  return /ai_agent_shadow_results|shadow_capture_enabled/.test(message) && /does not exist|schema cache|could not find/i.test(message);
}

export async function loadEvaluation(
  businessSlug: string,
  filters: { kind?: ShadowKind | null; rating?: ShadowRating | "unrated" | null } = {}
): Promise<EvaluationResponse> {
  const db = agentDb();
  const empty: EvaluationResponse = {
    captureEnabled: false,
    available: true,
    items: [],
    summary: summarizeResults([]),
    gaps: [],
    candidates: [],
    simulationsLastHour: 0,
    simulationLimitPerHour: SIMULATIONS_PER_HOUR,
    retentionDays: SHADOW_RETENTION_DAYS,
    pilotReviews: [],
    pilotSummary: summarizePilot([]),
  };

  const captureEnabled = await shadowCaptureEnabled(businessSlug);
  let query = db
    .from("ai_agent_shadow_results")
    .select(SHADOW_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.rating === "unrated") query = query.is("rating", null);
  else if (filters.rating) query = query.eq("rating", filters.rating);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error.message)) return { ...empty, available: false };
    throw new Error(error.message);
  }
  const rows = (data ?? []) as ShadowRow[];

  // Summary and gaps look at every recent row, not just the filtered page.
  const { data: allData } = await db
    .from("ai_agent_shadow_results")
    .select("id, kind, decision, category, reason_codes, rating, customer_question, input_tokens, output_tokens")
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(500);
  const all = (allData ?? []) as SummaryRow[];

  const [pilotReviews, candidates, simulationsLastHour] = await Promise.all([
    loadPilotReviews(businessSlug).catch((err) => {
      // The pilot migration not applied yet is not an error for the rest of the evaluation.
      if (/ai_agent_pilot_drafts/.test(String(err?.message)) && /does not exist|schema cache|could not find/i.test(String(err?.message))) return [] as PilotReview[];
      throw err;
    }),
    loadSimulationCandidates(businessSlug),
    countRecentSimulations(businessSlug).catch(() => 0),
  ]);
  const items = await joinOutcomes(businessSlug, rows, new Map(pilotReviews.map((r) => [r.escalationId, r])));
  const gaps: KnowledgeGap[] = summarizeGaps(all);
  return { ...empty, captureEnabled, items, summary: summarizeResults(all), gaps, candidates, simulationsLastHour, pilotReviews, pilotSummary: summarizePilot(pilotReviews) };
}

interface EventLite {
  id: string;
  decision: string | null;
  reason_codes: string[];
  mode: string | null;
  escalation_id: string | null;
}
interface EscalationLite {
  id: string;
  ref_code: string;
  status: string;
  reason: string;
  customer_name: string | null;
  staff_answer: string | null;
  answered_at: string | null;
  answered_via: string | null;
}
interface StaffAnswerLite {
  escalation_id: string;
  draft: string | null;
  draft_source: string | null;
  customer_action: string | null;
  withheld_reason: string | null;
  created_at: string;
}
interface OutboxLite {
  kind: string;
  status: string;
  error: string | null;
  dispatched_at: string | null;
  created_at: string;
  escalation_id: string | null;
  event_id: string | null;
}

/** Joins what actually happened to each turn, read-only and always business-scoped. */
async function joinOutcomes(businessSlug: string, rows: ShadowRow[], pilotByEscalation: Map<string, PilotReview> = new Map()): Promise<EvaluationItem[]> {
  if (rows.length === 0) return [];
  const db = agentDb();
  const eventIds = rows.map((r) => r.source_event_id).filter((id): id is string => Boolean(id));
  const knowledgeIds = Array.from(new Set(rows.flatMap((r) => r.knowledge_ids)));

  const [events, knowledge] = await Promise.all([
    eventIds.length > 0
      ? db.from("ai_agent_events").select("id, decision, reason_codes, mode, escalation_id").eq("business_slug", businessSlug).in("id", eventIds)
      : Promise.resolve({ data: [], error: null }),
    knowledgeIds.length > 0
      ? db.from("ai_agent_knowledge").select("id, title").eq("business_slug", businessSlug).in("id", knowledgeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const eventById = new Map(((events.data ?? []) as EventLite[]).map((e) => [e.id, e]));
  const titleById = new Map(((knowledge.data ?? []) as { id: string; title: string }[]).map((k) => [k.id, k.title]));

  const escalationIds = Array.from(new Set(Array.from(eventById.values()).map((e) => e.escalation_id).filter((id): id is string => Boolean(id))));
  const [escalations, answers, outboxByEscalation, outboxByEvent] = await Promise.all([
    escalationIds.length > 0
      ? db
          .from("ai_agent_escalations")
          .select("id, ref_code, status, reason, customer_name, staff_answer, answered_at, answered_via")
          .eq("business_slug", businessSlug)
          .in("id", escalationIds)
      : Promise.resolve({ data: [], error: null }),
    escalationIds.length > 0
      ? db
          .from("ai_agent_staff_answers")
          .select("escalation_id, draft, draft_source, customer_action, withheld_reason, created_at")
          .eq("business_slug", businessSlug)
          .in("escalation_id", escalationIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    escalationIds.length > 0
      ? db
          .from("ai_agent_outbox")
          .select("kind, status, error, dispatched_at, created_at, escalation_id, event_id")
          .eq("business_slug", businessSlug)
          .in("escalation_id", escalationIds)
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length > 0
      ? db
          .from("ai_agent_outbox")
          .select("kind, status, error, dispatched_at, created_at, escalation_id, event_id")
          .eq("business_slug", businessSlug)
          .in("event_id", eventIds)
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const escalationById = new Map(((escalations.data ?? []) as EscalationLite[]).map((e) => [e.id, e]));
  const latestAnswer = new Map<string, StaffAnswerLite>();
  for (const a of (answers.data ?? []) as StaffAnswerLite[]) if (!latestAnswer.has(a.escalation_id)) latestAnswer.set(a.escalation_id, a);
  const outboxRows = [...((outboxByEscalation.data ?? []) as OutboxLite[]), ...((outboxByEvent.data ?? []) as OutboxLite[])];
  const now = new Date();

  return rows.map((row) => {
    const event = row.source_event_id ? (eventById.get(row.source_event_id) ?? null) : null;
    const escalation = event?.escalation_id ? (escalationById.get(event.escalation_id) ?? null) : null;
    const answer = escalation ? (latestAnswer.get(escalation.id) ?? null) : null;
    const mine = outboxRows.filter(
      (o) => (escalation && o.escalation_id === escalation.id) || (event && o.event_id === event.id)
    );
    const stateOf = (kind: string): string | null => {
      const found = mine.find((o) => o.kind === kind);
      return found ? outboxState({ ...found }, now) : null;
    };
    const customerRow = mine.find((o) => ["staff_relay", "customer_reply", "holding_reply"].includes(o.kind));
    return {
      id: row.id,
      kind: row.kind,
      chatId: row.chat_id,
      customerLabel: escalation?.customer_name ?? null,
      customerQuestion: row.customer_question,
      turnAt: row.turn_at,
      capturedAt: row.captured_at,
      shadow: {
        decision: row.decision,
        reply: row.reply,
        draftReply: row.draft_reply,
        confidence: row.confidence === null ? null : Number(row.confidence),
        requiredConfidence: row.required_confidence === null ? null : Number(row.required_confidence),
        reasons: row.reason_codes,
        escalationReason: row.escalation_reason,
        intent: row.intent,
        category: row.category,
      },
      provenance: {
        model: row.model,
        knowledgeVersion: row.knowledge_version,
        knowledgeCount: row.knowledge_count,
        knowledgeUsed: row.knowledge_ids.map((id) => ({ id, title: titleById.get(id) ?? null })),
        usesCurrentKnowledge: row.uses_current_knowledge,
        knowledgeChangedSinceTurn: row.post_turn_knowledge_ids.length,
        memoryUsed: row.memory_used,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        tokensEstimated: row.tokens_estimated,
      },
      actual: event
        ? {
            decision: event.decision,
            reasons: event.reason_codes ?? [],
            mode: event.mode,
            escalation: escalation ? { refCode: escalation.ref_code, status: escalation.status, reason: escalation.reason } : null,
          }
        : null,
      staffAnswer: escalation?.staff_answer
        ? { text: escalation.staff_answer, answeredAt: escalation.answered_at, via: escalation.answered_via }
        : null,
      assistedDraft: answer
        ? { text: answer.draft, source: answer.draft_source, customerAction: answer.customer_action, withheldReason: answer.withheld_reason }
        : null,
      delivery: {
        staffNotice: stateOf("staff_notice"),
        staffDraft: stateOf("staff_draft"),
        customer: customerRow ? { kind: customerRow.kind, state: outboxState({ ...customerRow }, now) } : null,
      },
      rating: row.rating,
      feedback: row.feedback,
      ratedAt: row.rated_at,
      pilot: escalation ? (pilotByEscalation.get(escalation.id) ?? null) : null,
    };
  });
}

interface PilotDraftLite {
  escalation_id: string;
  version: number;
  source: string;
  body: string;
  ready: boolean;
  confirm_notes: string[];
  knowledge_version: string | null;
  status: string;
  final_text: string | null;
  outcome: string | null;
  verdict: PilotReview["verdict"];
  verdict_source: PilotReview["verdictSource"];
  verdict_note: string | null;
  decided_at: string | null;
  created_at: string;
  content_purged_at: string | null;
}

/**
 * Approval Pilot, read-only: for each request where the AI proposed a draft (version 1), the draft exactly as it
 * was shown, what staff finally approved or sent instead, the verdict, and the facts staff taught for it.
 * Rows are immutable snapshots; nothing here is rewritten after the fact.
 */
export async function loadPilotReviews(businessSlug: string): Promise<PilotReview[]> {
  const db = agentDb();
  const { data: firsts, error } = await db
    .from("ai_agent_pilot_drafts")
    .select("escalation_id")
    .eq("business_slug", businessSlug)
    .eq("source", "ai")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  const escalationIds = ((firsts ?? []) as { escalation_id: string }[]).map((r) => r.escalation_id);
  if (escalationIds.length === 0) return [];

  const [drafts, escalations, candidates, history, events] = await Promise.all([
    db
      .from("ai_agent_pilot_drafts")
      .select("escalation_id, version, source, body, ready, confirm_notes, knowledge_version, status, final_text, outcome, verdict, verdict_source, verdict_note, decided_at, created_at, content_purged_at")
      .eq("business_slug", businessSlug)
      .in("escalation_id", escalationIds)
      .order("version"),
    db.from("ai_agent_escalations").select("id, ref_code, customer_name, customer_message").eq("business_slug", businessSlug).in("id", escalationIds),
    db
      .from("ai_agent_learning_candidates")
      .select("escalation_id, short_code, staff_answer, status, source")
      .eq("business_slug", businessSlug)
      .in("escalation_id", escalationIds),
    db
      .from("ai_agent_pilot_verdict_history")
      .select("escalation_id, previous_verdict, new_verdict, reason, changed_by, changed_at")
      .eq("business_slug", businessSlug)
      .in("escalation_id", escalationIds)
      .order("changed_at", { ascending: false }),
    db
      .from("ai_agent_events")
      .select("id, escalation_id")
      .eq("business_slug", businessSlug)
      .eq("kind", "customer_inbound")
      .in("escalation_id", escalationIds),
  ]);
  const historyByEsc = new Map<string, PilotReview["verdictHistory"]>();
  for (const h of (history.data ?? []) as { escalation_id: string; previous_verdict: string | null; new_verdict: string; reason: string; changed_by: string | null; changed_at: string }[]) {
    historyByEsc.set(h.escalation_id, [...(historyByEsc.get(h.escalation_id) ?? []), { at: h.changed_at, from: h.previous_verdict, to: h.new_verdict, reason: h.reason, by: h.changed_by }]);
  }
  // The latest simulation of each request's turn (Test Again), found through the request's customer events.
  const eventEsc = new Map(((events.data ?? []) as { id: string; escalation_id: string }[]).map((e) => [e.id, e.escalation_id]));
  const simByEsc = new Map<string, NonNullable<PilotReview["simulation"]> & { _kv: string | null }>();
  if (eventEsc.size > 0) {
    const { data: sims } = await db
      .from("ai_agent_shadow_results")
      .select("id, source_event_id, decision, reply, draft_reply, knowledge_version, created_at")
      .eq("business_slug", businessSlug)
      .eq("kind", "simulation")
      .in("source_event_id", Array.from(eventEsc.keys()))
      .order("created_at", { ascending: false });
    for (const r of (sims ?? []) as { id: string; source_event_id: string; decision: string; reply: string | null; draft_reply: string | null; knowledge_version: string | null; created_at: string }[]) {
      const esc = eventEsc.get(r.source_event_id);
      if (esc && !simByEsc.has(esc)) {
        simByEsc.set(esc, { id: r.id, at: r.created_at, decision: r.decision, reply: r.reply?.trim() || r.draft_reply?.trim() || null, knowledgeVersion: r.knowledge_version, knowledgeChangedSinceDraft: false, _kv: r.knowledge_version });
      }
    }
  }
  const byEsc = new Map<string, PilotDraftLite[]>();
  for (const d of (drafts.data ?? []) as PilotDraftLite[]) byEsc.set(d.escalation_id, [...(byEsc.get(d.escalation_id) ?? []), d]);
  const escById = new Map(((escalations.data ?? []) as { id: string; ref_code: string; customer_name: string | null; customer_message: string | null }[]).map((e) => [e.id, e]));
  const gapsByEsc = new Map<string, PilotReview["gaps"]>();
  for (const c of (candidates.data ?? []) as { escalation_id: string; short_code: string | null; staff_answer: string; status: string; source: string | null }[]) {
    gapsByEsc.set(c.escalation_id, [...(gapsByEsc.get(c.escalation_id) ?? []), { code: c.short_code, fact: c.staff_answer, status: c.status, source: c.source }]);
  }

  const reviews: PilotReview[] = [];
  for (const id of escalationIds) {
    const versions = byEsc.get(id) ?? [];
    const ai = versions.find((v) => v.source === "ai" && v.version === 1);
    if (!ai) continue;
    const approved = versions.find((v) => v.status === "approved");
    const ownText = versions.find((v) => v.outcome === "replaced_by_staff_text" && (v.final_text || v.content_purged_at));
    const esc = escById.get(id);
    reviews.push({
      escalationId: id,
      refCode: esc?.ref_code ?? null,
      customerLabel: esc?.customer_name ?? null,
      customerQuestion: esc?.customer_message?.slice(0, 500) ?? null,
      aiDraft: { version: 1, text: ai.content_purged_at ? "" : ai.body, ready: ai.ready, notes: ai.confirm_notes, knowledgeVersion: ai.knowledge_version, at: ai.created_at },
      final: approved
        ? { text: approved.content_purged_at ? "" : approved.body, how: "approved", version: approved.version, source: approved.source, at: approved.decided_at }
        : ownText
          ? { text: ownText.final_text ?? "", how: "sent_own_text", version: null, source: "staff_text", at: ownText.decided_at }
          : null,
      outcome: approved ? approved.outcome : (ai.outcome ?? null),
      verdict: ai.verdict,
      verdictSource: ai.verdict_source,
      verdictNote: ai.verdict_note,
      gaps: gapsByEsc.get(id) ?? [],
      versions: versions.length,
      contentPurged: Boolean(ai.content_purged_at),
      verdictHistory: historyByEsc.get(id) ?? [],
      simulation: (() => {
        const sim = simByEsc.get(id);
        if (!sim) return null;
        const { _kv, ...rest } = sim;
        return { ...rest, knowledgeChangedSinceDraft: _kv !== ai.knowledge_version };
      })(),
    });
  }
  return reviews;
}

/** Recent customer turns with no evaluation row — what an admin can simulate. Excerpts only. */
async function loadSimulationCandidates(businessSlug: string): Promise<SimulationCandidate[]> {
  const db = agentDb();
  const { data, error } = await db
    .from("ai_agent_events")
    .select("id, chat_id, message_excerpt, decision, reason_codes, created_at")
    .eq("business_slug", businessSlug)
    .eq("kind", "customer_inbound")
    .eq("status", "done")
    .in("decision", ["ESCALATE", "REPLY", "ASK"])
    .gte("created_at", new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return [];
  const events = ((data ?? []) as { id: string; chat_id: string; message_excerpt: string | null; decision: string | null; reason_codes: string[]; created_at: string }[]).filter(
    (e) => e.message_excerpt?.trim() && !e.reason_codes.some((c) => c.startsWith("batched_with_") || c === "trivial_acknowledgement")
  );
  if (events.length === 0) return [];
  const { data: done } = await db
    .from("ai_agent_shadow_results")
    .select("source_event_id")
    .eq("business_slug", businessSlug)
    .in("source_event_id", events.map((e) => e.id));
  const have = new Set(((done ?? []) as { source_event_id: string }[]).map((d) => d.source_event_id));
  return events
    .filter((e) => !have.has(e.id))
    .slice(0, 25)
    .map((e) => ({
      eventId: e.id,
      chatId: e.chat_id,
      excerpt: e.message_excerpt,
      decision: e.decision,
      reasons: e.reason_codes,
      createdAt: e.created_at,
    }));
}
