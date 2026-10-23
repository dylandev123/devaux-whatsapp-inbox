import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only. Order requests the agent collected. Approving records that staff
// reviewed the request — it sends nothing; confirming with the customer stays
// a human action (escalation answer or the inbox).
export const dynamic = "force-dynamic";

const COLUMNS =
  "id, chat_id, contact_number, items, delivery_address, delivery_preference, notes, status, escalation_id, reviewed_at, created_at, updated_at";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_order_requests")
    .select(COLUMNS)
    .eq("business_slug", businessSlug)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ requests: data ?? [] });
}

const TRANSITIONS: Record<string, string> = { approve: "approved", reject: "rejected", cancel: "cancelled" };

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; id?: unknown; action?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.id !== "string") return jsonError("businessSlug and id are required", 400);
  const status = typeof body.action === "string" ? TRANSITIONS[body.action] : undefined;
  if (!status) return jsonError('action must be "approve", "reject" or "cancel"', 400);

  const { data, error } = await agentDb()
    .from("ai_agent_order_requests")
    .update({ status, reviewed_by: admin.userId, reviewed_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("business_slug", businessSlug)
    .in("status", ["collecting", "pending_approval"])
    .select(COLUMNS)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Request not found or already reviewed", 409);
  await audit(businessSlug, "admin", admin.userId, `order_request.${body.action}`, { type: "order_request", id: data.id });
  return NextResponse.json({ request: data });
}
