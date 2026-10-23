import { NextResponse } from "next/server";
import { KNOWLEDGE_KINDS } from "@/lib/aiAgent/engine";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only. Staff corrections become permanent knowledge ONLY through an
// explicit admin approval here (the admin can edit the wording first).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_learning_candidates")
    .select("id, escalation_id, question, staff_answer, status, knowledge_id, reviewed_at, created_at")
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  // Pending first, newest first within each group (sort is stable).
  const candidates = (data ?? []).sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
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
  }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.id !== "string") return jsonError("businessSlug and id are required", 400);
  if (body.action !== "approve" && body.action !== "reject") return jsonError('action must be "approve" or "reject"', 400);

  const db = agentDb();
  const { data: candidate, error } = await db
    .from("ai_agent_learning_candidates")
    .select("id, escalation_id, staff_answer, status")
    .eq("id", body.id)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!candidate) return jsonError("Candidate not found", 404);
  if (candidate.status !== "pending") return jsonError("Candidate was already reviewed", 409);

  const now = new Date().toISOString();
  let knowledgeId: string | null = null;
  if (body.action === "approve") {
    if (!(KNOWLEDGE_KINDS as readonly unknown[]).includes(body.kind)) return jsonError("Invalid kind", 400);
    if (typeof body.title !== "string" || !body.title.trim()) return jsonError("title is required", 400);
    const content = typeof body.content === "string" && body.content.trim() ? body.content.trim() : candidate.staff_answer;
    const { data: entry, error: insertError } = await db
      .from("ai_agent_knowledge")
      .insert({
        business_slug: businessSlug,
        kind: body.kind,
        title: body.title.trim().slice(0, 200),
        content: content.slice(0, 4000),
        status: "approved",
        source: "staff_correction",
        source_ref: candidate.escalation_id,
        approved_by: admin.userId,
        approved_at: now,
        created_by: admin.userId,
        updated_by: admin.userId,
      })
      .select("id")
      .single();
    if (insertError) return jsonError(insertError.message, 500);
    knowledgeId = entry.id;
  }

  const { error: updateError } = await db
    .from("ai_agent_learning_candidates")
    .update({
      status: body.action === "approve" ? "approved" : "rejected",
      knowledge_id: knowledgeId,
      reviewed_by: admin.userId,
      reviewed_at: now,
    })
    .eq("id", candidate.id)
    .eq("status", "pending");
  if (updateError) return jsonError(updateError.message, 500);
  await audit(businessSlug, "admin", admin.userId, `learning.${body.action}`, { type: "learning", id: candidate.id }, {
    knowledge_id: knowledgeId,
  });
  return NextResponse.json({ ok: true, knowledgeId });
}
