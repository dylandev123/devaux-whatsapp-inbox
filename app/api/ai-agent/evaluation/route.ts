import { NextResponse } from "next/server";
import { parseRatingInput, SHADOW_RATINGS, type ShadowKind, type ShadowRating } from "@/lib/aiAgent/evaluation";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { loadEvaluation, rateShadow, setShadowCaptureEnabled } from "@/lib/server/aiAgent/evaluation";

// Admin-only. AI evaluation: what the AI proposed on its own for customer turns
// staff handled, next to what actually happened. Nothing here sends anything:
// ratings and the capture switch are the only writes.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const kind = params.get("kind");
  const rating = params.get("rating");
  try {
    return NextResponse.json(
      await loadEvaluation(businessSlug, {
        kind: kind === "historical" || kind === "simulation" ? (kind as ShadowKind) : null,
        rating: rating === "unrated" ? "unrated" : (SHADOW_RATINGS as readonly string[]).includes(rating ?? "") ? (rating as ShadowRating) : null,
      })
    );
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load evaluation", 500);
  }
}

// Rate one result: Correct | Needs improvement | Incorrect, with optional feedback.
export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; id?: unknown; rating?: unknown; feedback?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  if (typeof body.id !== "string" || !UUID.test(body.id)) return jsonError("id must be a uuid", 400);
  const parsed = parseRatingInput(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  try {
    const row = await rateShadow({ businessSlug, id: body.id, rating: parsed.rating, feedback: parsed.feedback, adminId: admin.userId });
    if (!row) return jsonError("Result not found", 404);
    return NextResponse.json({ ok: true, rating: row.rating, feedback: row.feedback });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to save rating", 500);
  }
}

// Switch historical capture on/off for this business (default off).
export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; enabled?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  if (typeof body.enabled !== "boolean") return jsonError("enabled must be true or false", 400);
  try {
    await setShadowCaptureEnabled(businessSlug, body.enabled, admin.userId);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to save", 500);
  }
}
