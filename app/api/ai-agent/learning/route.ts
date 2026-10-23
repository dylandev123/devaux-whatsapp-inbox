import { NextResponse } from "next/server";
import type { KnowledgeConflict } from "@/lib/aiAgent/staffAnswers";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { approvedKnowledgeLite, approveCandidate, assessCandidate } from "@/lib/server/aiAgent/learning";

// Admin-only. Staff information becomes permanent knowledge ONLY through an
// explicit admin approval here (the admin can edit the wording first). Only
// durable facts are ever proposed: temporary, customer-specific and one-off
// information never reaches this list. A candidate that overlaps an approved
// entry shows the overlap, and approving it needs an explicit choice — replace
// the old entry (it is archived, never edited in place) or keep both.
export const dynamic = "force-dynamic";

const CANDIDATE_COLUMNS =
  "id, escalation_id, question, staff_answer, status, knowledge_id, reviewed_at, created_at, category, suggested_kind, suggested_title, source_message, source_message_at, ref_code, conflicts";

interface CandidateRow {
  id: string;
  escalation_id: string | null;
  question: string | null;
  staff_answer: string;
  status: "pending" | "approved" | "rejected";
  category: string;
  suggested_kind: string | null;
  suggested_title: string | null;
  conflicts: KnowledgeConflict[];
}

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_learning_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  const rows = (data ?? []) as (CandidateRow & Record<string, unknown>)[];

  // Conflicts are recomputed against today's approved knowledge: the entry a
  // candidate was compared with when it was proposed may have changed since.
  const approved = rows.some((r) => r.status === "pending") ? await approvedKnowledgeLite(businessSlug) : [];
  const candidates = rows
    .map((r) => {
      if (r.status !== "pending" || r.category !== "durable") return { ...r, conflicts: r.status === "pending" ? [] : r.conflicts };
      const a = assessCandidate(r, approved);
      return { ...r, conflicts: a.conflicts, duplicate_of: a.duplicateOf ? { id: a.duplicateOf.id, title: a.duplicateOf.title } : null };
    })
    // Pending first, newest first within each group (sort is stable).
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return NextResponse.json({ candidates });
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{
    businessSlug?: unknown;
    id?: unknown;
    action?: unknown;
    kind?: unknown;
    title?: unknown;
    content?: unknown;
    resolution?: unknown;
    replaceKnowledgeId?: unknown;
  }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.id !== "string") return jsonError("businessSlug and id are required", 400);
  if (body.action !== "approve" && body.action !== "reject") return jsonError('action must be "approve" or "reject"', 400);

  const db = agentDb();
  const { data: candidate, error } = await db
    .from("ai_agent_learning_candidates")
    .select("id, escalation_id, staff_answer, status, suggested_kind, suggested_title, category, question, conflicts")
    .eq("id", body.id)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!candidate) return jsonError("Candidate not found", 404);
  if (candidate.status !== "pending") return jsonError("Candidate was already reviewed", 409);

  if (body.action === "reject") {
    const { data: rejected, error: rejectError } = await db
      .from("ai_agent_learning_candidates")
      .update({ status: "rejected", reviewed_by: admin.userId, reviewed_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("business_slug", businessSlug)
      .eq("status", "pending")
      .select("id");
    if (rejectError) return jsonError(rejectError.message, 500);
    if ((rejected ?? []).length === 0) return jsonError("Candidate was already reviewed", 409);
    await audit(businessSlug, "admin", admin.userId, "learning.reject", { type: "learning", id: candidate.id }, {});
    return NextResponse.json({ ok: true, knowledgeId: null });
  }

  const result = await approveCandidate({
    businessSlug,
    candidateId: candidate.id,
    adminId: admin.userId,
    kind: body.kind,
    title: body.title,
    content: body.content,
    resolution: body.resolution,
    replaceKnowledgeId: body.replaceKnowledgeId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, conflicts: result.conflicts ?? [] }, { status: result.status });
  return NextResponse.json({ ok: true, knowledgeId: result.knowledgeId });
}
