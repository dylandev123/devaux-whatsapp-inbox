import { NextResponse } from "next/server";
import { ORDER_STATUSES, type EditableOrderField, type OrderStatus } from "@/lib/aiAgent/orders";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { ensureSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import {
  listOrderEvents,
  listOrders,
  listSummaryRuns,
  loadCoverage,
  loadOrderNames,
  type ManualAction,
  sendSummaryNow,
  updateOrderManually,
} from "@/lib/server/aiAgent/orders";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()), like every /api/ai-agent route. Every query and
// write is scoped to the business slug; a staff change is applied through apply_ai_agent_order (version-checked)
// and written to the order's history and the audit log. Nothing here can message a customer.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const url = new URL(request.url);
  const businessSlug = await resolveBusinessSlug(url.searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  try {
    const orderId = url.searchParams.get("orderId");
    if (orderId) return NextResponse.json({ events: await listOrderEvents(businessSlug, orderId) });

    const status = url.searchParams.get("status") ?? "open";
    if (status !== "open" && status !== "all" && !(ORDER_STATUSES as readonly string[]).includes(status)) return jsonError("Invalid status", 400);
    const [orders, runs, coverage] = await Promise.all([
      listOrders(businessSlug, { status: status as "open" | "all" | OrderStatus, q: url.searchParams.get("q") ?? "" }),
      listSummaryRuns(businessSlug),
      ensureSettings(businessSlug).then((s) => loadCoverage(s, new Date())),
    ]);
    const names = await loadOrderNames(businessSlug, orders);
    return NextResponse.json({ orders: orders.map((o) => ({ ...o, display_name: names[o.id]?.name ?? null, name_source: names[o.id]?.source ?? null })), runs, coverage });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load orders", 500);
  }
}

const ACTIONS: readonly ManualAction[] = ["edit", "confirm", "cancel", "fulfil", "keep"];

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; orderId?: unknown; action?: unknown; version?: unknown; patch?: unknown; conflictFields?: unknown; reason?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.orderId !== "string") return jsonError("businessSlug and orderId are required", 400);
  if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) return jsonError("action must be edit, confirm, cancel, fulfil or keep", 400);
  if (body.patch !== undefined && (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch))) return jsonError("patch must be an object", 400);

  try {
    const result = await updateOrderManually({
      businessSlug,
      orderId: body.orderId,
      adminId: admin.userId,
      action: body.action as ManualAction,
      expectedVersion: typeof body.version === "number" ? body.version : null,
      patch: body.patch as Partial<Record<EditableOrderField, unknown>> | undefined,
      conflictFields: Array.isArray(body.conflictFields) ? body.conflictFields.filter((f): f is string => typeof f === "string") : undefined,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    if (!result.ok) return jsonError(result.error, result.status);
    return NextResponse.json({ order: result.order });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to update the order", 500);
  }
}

// "Send summary now": the dashboard equivalent of "!update". Posts to the orders group only.
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    const result = await sendSummaryNow(await ensureSettings(businessSlug), admin.userId, "admin");
    return result.ok ? NextResponse.json({ ok: true }) : jsonError(result.error, 409);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to queue the summary", 500);
  }
}
