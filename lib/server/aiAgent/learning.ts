// Server-only: the admin side of the knowledge approval pipeline. Staff
// information reaches ai_agent_knowledge ONLY through approveCandidate(), and an
// approval that overlaps an approved entry needs an explicit choice — replace
// it (the old entry is archived, never edited) or keep both. The overlap is
// checked against the knowledge as it is at approval time, not as it was when
// the candidate was proposed.

import { KNOWLEDGE_KINDS } from "@/lib/aiAgent/engine";
import { assessKnowledgeCandidate, type KnowledgeConflict, type KnowledgeEntryLite, statesTemporaryCondition } from "@/lib/aiAgent/staffAnswers";
import { agentDb, audit, loadActiveKnowledge } from "@/lib/server/aiAgent/db";

export interface CandidateForAssessment {
  suggested_kind: string | null;
  suggested_title: string | null;
  staff_answer: string;
}

export async function approvedKnowledgeLite(businessSlug: string): Promise<KnowledgeEntryLite[]> {
  return (await loadActiveKnowledge(businessSlug)).map((k) => ({ id: k.id, kind: k.kind, title: k.title, content: k.content }));
}

export function assessCandidate(c: CandidateForAssessment, approved: KnowledgeEntryLite[], over: { kind?: string; title?: string; content?: string } = {}) {
  return assessKnowledgeCandidate(
    { kind: over.kind ?? c.suggested_kind ?? "faq", title: over.title ?? c.suggested_title ?? "", content: over.content ?? c.staff_answer },
    approved
  );
}

export type ApproveResult =
  | { ok: true; knowledgeId: string; archivedId: string | null }
  | { ok: false; status: number; error: string; conflicts?: KnowledgeConflict[] };

export async function approveCandidate(input: {
  businessSlug: string;
  candidateId: string;
  /** The admin's user id; null for an approval from WhatsApp (then `via` is "whatsapp" and `senderId` is the verified sender). */
  adminId: string | null;
  via?: "admin" | "whatsapp";
  senderId?: string | null;
  kind: unknown;
  title: unknown;
  content: unknown;
  resolution: unknown;
  replaceKnowledgeId: unknown;
}): Promise<ApproveResult> {
  const db = agentDb();
  const { data: candidate, error } = await db
    .from("ai_agent_learning_candidates")
    .select("id, escalation_id, staff_answer, status, suggested_kind, suggested_title, fact_expires_at, proposal_expires_at, proposed_by, source, sender_verified")
    .eq("id", input.candidateId)
    .eq("business_slug", input.businessSlug)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!candidate) return { ok: false, status: 404, error: "Candidate not found" };
  if (candidate.status !== "pending") return { ok: false, status: 409, error: "Candidate was already reviewed" };
  if (candidate.proposal_expires_at && Date.parse(candidate.proposal_expires_at) <= Date.now()) {
    return { ok: false, status: 409, error: "This suggestion expired before anyone confirmed it. Teach it again if it is still true." };
  }

  if (!(KNOWLEDGE_KINDS as readonly unknown[]).includes(input.kind)) return { ok: false, status: 400, error: "Invalid kind" };
  if (typeof input.title !== "string" || !input.title.trim()) return { ok: false, status: 400, error: "title is required" };
  const kind = input.kind as string;
  const title = input.title.trim().slice(0, 200);
  const content = (typeof input.content === "string" && input.content.trim() ? input.content.trim() : candidate.staff_answer).slice(0, 4000);

  // Stock, shortages and "today" facts are classified temporary and never become candidates; this
  // is the backstop for older candidates and for text an admin edited into one.
  // A candidate staff proposed WITH an expiry is a temporary fact on purpose: it becomes an expiring entry.
  const factExpiresAt: string | null = candidate.fact_expires_at ?? null;
  if (factExpiresAt && Date.parse(factExpiresAt) <= Date.now()) {
    return { ok: false, status: 409, error: "This temporary fact has already expired, so it was not added." };
  }
  if (!factExpiresAt && statesTemporaryCondition(`${title} ${content}`)) {
    return {
      ok: false,
      status: 409,
      error:
        "This describes a temporary condition (stock, availability, “today”…). It can't become permanent knowledge — add it on the Knowledge tab with an expiry date instead, or reject the suggestion.",
    };
  }

  const assessment = assessCandidate(candidate, await approvedKnowledgeLite(input.businessSlug), { kind, title, content });
  // A temporary fact (stock, "today") never replaces or conflicts with a permanent entry: it just expires.
  if (factExpiresAt) assessment.conflicts = [];
  if (assessment.duplicateOf) {
    return { ok: false, status: 409, error: `Already in the knowledge base as "${assessment.duplicateOf.title}"` };
  }

  const conflicts = assessment.conflicts;
  const resolution = input.resolution === "replace" || input.resolution === "keep_both" ? input.resolution : "none";
  let replaceId: string | null = null;
  if (conflicts.length > 0) {
    if (resolution === "none") {
      return {
        ok: false,
        status: 409,
        error: `This overlaps an approved entry ("${conflicts[0].title}"). Choose to replace it or keep both before approving.`,
        conflicts,
      };
    }
    if (resolution === "replace") {
      replaceId = typeof input.replaceKnowledgeId === "string" ? input.replaceKnowledgeId : null;
      // Only an entry the comparison actually found can be replaced.
      if (!replaceId || !conflicts.some((c) => c.id === replaceId)) {
        return { ok: false, status: 400, error: "Pick which overlapping entry to replace", conflicts };
      }
    }
  }

  const { data: result, error: rpcError } = await db.rpc("approve_ai_agent_learning_candidate", {
    p_business_slug: input.businessSlug,
    p_candidate_id: candidate.id,
    p_admin: input.adminId,
    p_kind: kind,
    p_title: title,
    p_content: content,
    p_resolution: conflicts.length > 0 ? resolution : "none",
    p_replace_knowledge_id: replaceId,
    p_require_resolution: conflicts.length > 0,
    p_via: input.via ?? "admin",
    p_sender: input.senderId ?? null,
    p_expires_at: factExpiresAt,
  });
  if (rpcError) {
    const known: Record<string, [string, number]> = {
      already_reviewed: ["Candidate was already reviewed", 409],
      candidate_not_found: ["Candidate not found", 404],
      resolution_required: ["Choose to replace the overlapping entry or keep both", 409],
      replace_target_not_found: ["The entry to replace is no longer approved", 409],
      candidate_expired: ["This suggestion expired before anyone confirmed it", 409],
    };
    const hit = Object.entries(known).find(([code]) => rpcError.message.includes(code));
    return hit ? { ok: false, status: hit[1][1], error: hit[1][0] } : { ok: false, status: 500, error: rpcError.message };
  }
  const { knowledge_id: knowledgeId, archived_id: archivedId } = result as { knowledge_id: string; archived_id: string | null };
  const viaWhatsApp = input.via === "whatsapp";
  await audit(input.businessSlug, viaWhatsApp ? "staff" : "admin", viaWhatsApp ? (input.senderId ?? null) : input.adminId, "learning.approve", { type: "learning", id: candidate.id }, {
    via: input.via ?? "admin",
    expires_at: factExpiresAt,
    knowledge_id: knowledgeId,
    source: candidate.source ?? null,
    sender_verified: candidate.sender_verified !== false,
    proposed_by: candidate.proposed_by ?? null,
    // The same authorized person may teach and then confirm; the audit trail records that they did.
    self_confirmed: viaWhatsApp && Boolean(input.senderId) && candidate.proposed_by === input.senderId,
    replaced_knowledge_id: archivedId,
    resolution: conflicts.length > 0 ? resolution : "none",
    conflicts: conflicts.map((c) => c.id),
  });
  return { ok: true, knowledgeId, archivedId };
}
