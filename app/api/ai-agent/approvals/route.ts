import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { ensureSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { listPendingApprovals, runApprovalAction } from "@/lib/server/aiAgent/approvals";

// Admin-only (middleware.ts + requireAdmin(), like every /api/ai-agent route). The dashboard's pending-approvals queue
// is another view of the Approval Pilot: Approve goes through the same approveDraftCore() and central customer-send
// policy as the WhatsApp !approve, and the reply is queued in the one outbox for the bridge. One request at a time;
// there is deliberately no bulk action.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    const settings = await ensureSettings(businessSlug);
    return NextResponse.json({ mode: settings.mode, items: await listPendingApprovals(settings) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load approvals", 500);
  }
}

const ACTIONS = ["approve", "edit", "reject", "moreinfo"] as const;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; escalationId?: unknown; action?: unknown; draftId?: unknown; confirm?: unknown; text?: unknown; reason?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.escalationId !== "string") return jsonError("businessSlug and escalationId are required", 400);
  if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) return jsonError(`action must be one of ${ACTIONS.join(", ")}`, 400);
  try {
    const result = await runApprovalAction({
      settings: await ensureSettings(businessSlug),
      escalationId: body.escalationId,
      adminId: admin.userId,
      action: body.action as (typeof ACTIONS)[number],
      draftId: typeof body.draftId === "string" ? body.draftId : null,
      confirm: body.confirm === true,
      text: typeof body.text === "string" ? body.text.slice(0, 2000) : null,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
    });
    return result.ok ? NextResponse.json(result) : jsonError(result.error, result.status);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to act on the request", 500);
  }
}
