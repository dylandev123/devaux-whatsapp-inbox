import { NextResponse } from "next/server";
import { DEFAULT_ORDERS_TIMEZONE } from "@/lib/aiAgent/orders";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { ensureSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { loadOrderReviews } from "@/lib/server/aiAgent/orderReview";

// READ-ONLY and admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()). Shows where the conversation behind an
// existing order points somewhere other than what the order says (not an order after all, a delivery day staff stated, a
// photo nobody resolved). It changes nothing: no order, customer memory, staff lock or approved correction is touched, no
// model is called and nothing is sent. A person applies any change with the normal Orders actions.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    const settings = await ensureSettings(businessSlug);
    return NextResponse.json(await loadOrderReviews(businessSlug, settings.orders_timezone || DEFAULT_ORDERS_TIMEZONE));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to review orders", 500);
  }
}
