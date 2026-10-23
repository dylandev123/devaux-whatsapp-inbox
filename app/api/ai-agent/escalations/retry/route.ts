import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { retryStaffAnswer } from "@/lib/server/aiAgent/staffGroup";

// Admin-only. Re-runs ONE staff answer that failed part-way. Refused when a
// customer message may already have been sent for it (see decideRetry in
// lib/aiAgent/staffAnswers.ts); every customer-send policy applies again.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; answerId?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.answerId !== "string") return jsonError("businessSlug and answerId are required", 400);
  try {
    const result = await retryStaffAnswer({ businessSlug, answerId: body.answerId, adminId: admin.userId });
    if (!result.ok) return jsonError(result.error, result.status);
    return NextResponse.json({ ok: true, message: result.message, queued: result.queued });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Retry failed", 500);
  }
}
