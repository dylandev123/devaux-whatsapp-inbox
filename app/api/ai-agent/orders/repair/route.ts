import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { applyOrderRepair, previewOrderRepair } from "@/lib/server/aiAgent/orderRepair";

// Admin-only. Re-evaluates the business's OPEN orders against the business rules (delivery by default, the 9 AM day
// default, phone numbers vs notes, verified locations) using each order's own stored conversation.
//
//   GET  ?businessSlug=…            PREVIEW: what would change, with the customer's words. Writes nothing.
//   POST { businessSlug, approved } APPLY exactly the previewed changes of the listed orders ({ orderId, fingerprint }).
//
// A fingerprint that no longer matches (the order or the rules moved on since the preview) applies nothing for that order.
// It adds no model call, creates no order and never messages a customer. See lib/server/aiAgent/orderRepair.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    return NextResponse.json(await previewOrderRepair(businessSlug));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to preview the repair", 500);
  }
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; approved?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("businessSlug is required", 400);
  const approved = Array.isArray(body.approved)
    ? body.approved
        .filter((a): a is { orderId: string; fingerprint: string } => typeof a?.orderId === "string" && typeof a?.fingerprint === "string")
        .slice(0, 100)
    : [];
  if (approved.length === 0) return jsonError("approved must list at least one { orderId, fingerprint } from a preview", 400);
  try {
    return NextResponse.json({ results: await applyOrderRepair({ businessSlug, adminId: admin.userId, approved }) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Repair failed", 500);
  }
}
