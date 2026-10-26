import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { ensureSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { cancelBackfill, listBackfillRuns, publicRun, startBackfill, stepBackfill } from "@/lib/server/aiAgent/backfill";

// Admin-only. The opt-in recovery of orders from stored messages (see lib/server/aiAgent/backfill.ts). Nothing here
// runs on its own: "start" plans a run, "continue" does a bounded slice of work and returns progress, "cancel" stops it.
// It reads stored messages and writes order records only; it can never message a customer.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    return NextResponse.json({ runs: (await listBackfillRuns(businessSlug)).map(publicRun) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load backfills", 500);
  }
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; action?: unknown; hours?: unknown; runId?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("businessSlug is required", 400);
  try {
    const settings = await ensureSettings(businessSlug);
    let result;
    if (body.action === "start") result = await startBackfill({ settings, adminId: admin.userId, hours: body.hours });
    else if (body.action === "continue" && typeof body.runId === "string") result = await stepBackfill({ settings, runId: body.runId });
    else if (body.action === "cancel" && typeof body.runId === "string") result = await cancelBackfill({ settings, runId: body.runId, adminId: admin.userId });
    else return jsonError("action must be start, continue or cancel", 400);
    return result.ok ? NextResponse.json({ run: publicRun(result.run) }) : jsonError(result.error, result.status);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Backfill failed", 500);
  }
}
