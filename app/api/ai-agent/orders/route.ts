import { NextResponse } from "next/server";
import { DEFAULT_ORDERS_TIMEZONE, isOpenStatus, ORDER_STATUSES, type EditableOrderField, type OrderStatus } from "@/lib/aiAgent/orders";
import { bucketOf, countOrders, dayContext, dayLabel, orderDate, orderGaps, selectOrders, type OrdersView } from "@/lib/aiAgent/orderViews";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { ensureSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import {
  listOrderEvents,
  listOrders,
  listSummaryRuns,
  loadCoverage,
  loadOrderNames,
  loadOutstandingOrders,
  loadSavedLocations,
  type ManualAction,
  sendSummaryNow,
  updateOrderManually,
} from "@/lib/server/aiAgent/orders";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()), like every /api/ai-agent route. Every query and
// write is scoped to the business slug; a staff change is applied through apply_ai_agent_order (version-checked)
// and written to the order's history and the audit log. Nothing here can message a customer.
export const dynamic = "force-dynamic";

const VIEWS = ["all", "today", "tomorrow", "overdue", "missing", "undated"] as const;

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
    const view = url.searchParams.get("view") ?? "all";
    if (!(VIEWS as readonly string[]).includes(view)) return jsonError("Invalid view", 400);
    const settings = await ensureSettings(businessSlug);
    const timezone = settings.orders_timezone || DEFAULT_ORDERS_TIMEZONE;
    const now = new Date();
    const ctx = dayContext(now, timezone);
    const [found, runs, coverage, outstanding] = await Promise.all([
      listOrders(businessSlug, { status: status as "open" | "all" | OrderStatus, q: url.searchParams.get("q") ?? "" }),
      listSummaryRuns(businessSlug),
      loadCoverage(settings, now),
      loadOutstandingOrders(businessSlug),
    ]);
    // A day view applies to outstanding orders. Without a search it reads every outstanding order (not just the 200 most
    // recently touched), so an old overdue order can never fall out of its view.
    const searching = (url.searchParams.get("q") ?? "").trim() !== "";
    const orders =
      status === "open" && view !== "all"
        ? selectOrders({ type: view as Exclude<OrdersView["type"], "day" | "default"> }, searching ? found : outstanding, ctx)
        : status === "open" && !searching
          ? outstanding
          : found;
    const [names, saved] = await Promise.all([loadOrderNames(businessSlug, orders), loadSavedLocations(businessSlug, orders.filter((o) => isOpenStatus(o.status) && o.fulfilment_method !== "collection"))]);
    return NextResponse.json({
      orders: orders.map((o) => {
        const date = orderDate(o, timezone);
        return {
          ...o,
          display_name: names[o.id]?.name ?? null,
          name_source: names[o.id]?.source ?? null,
          fulfilment_date: date,
          fulfilment_date_label: date ? dayLabel(date) : null,
          bucket: isOpenStatus(o.status) ? bucketOf(o, ctx) : null,
          gaps: isOpenStatus(o.status) ? orderGaps(o, timezone) : [],
          saved_location: saved[o.id] ?? null,
        };
      }),
      runs,
      coverage,
      counts: countOrders(outstanding, ctx),
      timezone,
      today: ctx.today,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load orders", 500);
  }
}

const ACTIONS: readonly ManualAction[] = ["edit", "confirm", "cancel", "fulfil", "keep", "reopen"];

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; orderId?: unknown; action?: unknown; version?: unknown; patch?: unknown; conflictFields?: unknown; reason?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.orderId !== "string") return jsonError("businessSlug and orderId are required", 400);
  if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) return jsonError("action must be edit, confirm, cancel, fulfil, reopen or keep", 400);
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
