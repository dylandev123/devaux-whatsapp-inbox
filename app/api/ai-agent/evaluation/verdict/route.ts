import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { overridePilotVerdict } from "@/lib/server/aiAgent/pilot";

// Admin-only. Manually overrides the evaluation verdict on the AI's draft for one Approval Pilot request.
// A reason is required; every change is kept in ai_agent_pilot_verdict_history and the audit log.
// Nothing here sends anything or changes a draft.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERDICTS = ["correct", "missing_information", "factually_wrong"] as const;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; escalationId?: unknown; verdict?: unknown; reason?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  if (typeof body.escalationId !== "string" || !UUID.test(body.escalationId)) return jsonError("escalationId must be a uuid", 400);
  if (typeof body.verdict !== "string" || !(VERDICTS as readonly string[]).includes(body.verdict)) return jsonError("verdict must be correct, missing_information or factually_wrong", 400);
  if (typeof body.reason !== "string") return jsonError("A reason is required", 400);
  try {
    const result = await overridePilotVerdict({
      businessSlug,
      escalationId: body.escalationId,
      verdict: body.verdict as (typeof VERDICTS)[number],
      reason: body.reason,
      adminId: admin.userId,
    });
    if (!result.ok) return jsonError(result.error, result.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to save verdict", 500);
  }
}
