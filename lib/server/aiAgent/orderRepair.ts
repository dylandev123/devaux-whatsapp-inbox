// Server-only: preview and apply the repair of existing OPEN orders (planner: lib/aiAgent/orderRepair.ts).
//
// Two steps, both admin-only and both explicit; nothing here runs on its own:
//   preview  reads the open orders and the conversations they were built from and returns what WOULD change. Writes nothing.
//   apply    re-plans from the CURRENT data and applies an order's changes only if they are exactly the previewed ones
//            (the fingerprint covers the order's version and every proposed value), so a stale preview applies nothing.
//
// Safety: version-checked writes through apply_ai_agent_order (the same function every order change uses), one idempotency
// key per previewed change set (a second click is a "duplicate", not a second edit), staff-locked fields untouched, the
// business filter on every read, an audit entry per order, and no outbox access at all: a repair can never message anyone.
// It adds no model call and creates no order.

import { computeMissing, DEFAULT_ORDERS_TIMEZONE, isComplete, type OrderFields, type TrackedOrder } from "@/lib/aiAgent/orders";
import { hasVerifiedAddress, reliableHistory } from "@/lib/aiAgent/orderHistory";
import { planRepair, summarizeRepair, type RepairItem, type RepairMessage } from "@/lib/aiAgent/orderRepair";
import { agentDb, audit, loadSettings } from "@/lib/server/aiAgent/db";
import { applyOrder, fieldsOf, loadCustomerHistory, loadOrderNames, loadOutstandingOrders, loadSavedLocations, rowFrom } from "@/lib/server/aiAgent/orders";
import { isOutbound } from "@/lib/whatsapp";



const MAX_ORDERS = 300;
const MESSAGES_PER_ORDER = 80;
const PARALLEL = 8;
const DAY_MS = 86_400_000;

async function timezoneOf(businessSlug: string): Promise<string> {
  const settings = await loadSettings(businessSlug).catch(() => null);
  return settings?.orders_timezone || DEFAULT_ORDERS_TIMEZONE;
}

/** The stored conversation around one order (business- and chat-scoped), oldest first. */
async function loadOrderMessages(businessSlug: string, order: TrackedOrder): Promise<RepairMessage[]> {
  const from = new Date(Date.parse(order.first_message_at) - DAY_MS).toISOString();
  const to = new Date(Date.parse(order.last_message_at) + 60_000).toISOString();
  const { data, error } = await agentDb()
    .from("whatsapp_messages")
    .select("whatsapp_message_id, direction, message_body, timestamp")
    .eq("business_slug", businessSlug)
    .eq("chat_id", order.chat_id)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true })
    .limit(MESSAGES_PER_ORDER);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((m) => (m.message_body as string | null)?.trim())
    .map((m) => ({
      id: m.whatsapp_message_id as string,
      who: isOutbound(m.direction as string) ? ("Staff" as const) : ("Customer" as const),
      text: (m.message_body as string).trim().slice(0, 600),
      at: m.timestamp as string,
    }));
}

export interface RepairPreview {
  businessSlug: string;
  generatedAt: string;
  timezone: string;
  summary: ReturnType<typeof summarizeRepair>;
  /** Orders with something to apply or to review; untouched orders are only counted. */
  items: (RepairItem & { customer: string | null; phone: string | null })[];
  /** Orders left out because the cap was reached. */
  truncated: number;
}

async function planAll(businessSlug: string, only?: Set<string>): Promise<{ plans: Map<string, RepairItem>; orders: TrackedOrder[]; names: Awaited<ReturnType<typeof loadOrderNames>>; truncated: number; timezone: string }> {
  const timezone = await timezoneOf(businessSlug);
  const all = await loadOutstandingOrders(businessSlug);
  const orders = (only ? all.filter((o) => only.has(o.id)) : all).slice(0, MAX_ORDERS);
  const [names, saved] = await Promise.all([loadOrderNames(businessSlug, orders), loadSavedLocations(businessSlug, orders)]);
  const plans = new Map<string, RepairItem>();
  const planOne = async (order: TrackedOrder) => {
    const [messages, history] = await Promise.all([
      loadOrderMessages(businessSlug, order),
      loadCustomerHistory(businessSlug, [order.chat_id], order.contact_number).catch(() => []),
    ]);
    const verified = reliableHistory(history, [order.id]).find(hasVerifiedAddress) ?? history.find((h) => h.id !== order.id && hasVerifiedAddress(h));
    return planRepair(order, {
      messages,
      senderPhone: order.contact_number,
      profileName: names[order.id]?.name ?? null,
      savedLocation: saved[order.id]?.content ?? null,
      verifiedAddress: verified?.delivery_address ? { ref: verified.ref_code, address: verified.delivery_address } : null,
      timezone,
    });
  };
  // A few orders at a time: each needs two reads, and a long serial run could outlast the request.
  for (let i = 0; i < orders.length; i += PARALLEL) {
    const batch = orders.slice(i, i + PARALLEL);
    const planned = await Promise.all(batch.map(planOne));
    planned.forEach((plan, k) => plan && plans.set(batch[k].id, plan));
  }
  return { plans, orders, names, truncated: Math.max(0, (only ? all.filter((o) => only.has(o.id)) : all).length - orders.length), timezone };
}

/** What a repair would change, with the customer's words for each change. Writes nothing. */
export async function previewOrderRepair(businessSlug: string): Promise<RepairPreview> {
  const { plans, orders, names, truncated, timezone } = await planAll(businessSlug);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const all = [...plans.values()];
  const items = all
    .filter((p) => p.changes.length > 0 || p.review.length > 0 || p.skipped.length > 0)
    .map((p) => ({ ...p, customer: names[p.orderId]?.name ?? null, phone: byId.get(p.orderId)?.contact_number ?? null }));
  return { businessSlug, generatedAt: new Date().toISOString(), timezone, summary: summarizeRepair(all), items, truncated };
}

export type RepairOutcome = "applied" | "already_applied" | "changed_since_preview" | "nothing_to_apply" | "not_found" | "conflict";

export interface RepairResult {
  orderId: string;
  ref: string | null;
  outcome: RepairOutcome;
}

/**
 * Applies the previewed changes of the listed orders. `approved` pairs an order with the fingerprint the admin saw; an
 * order whose current plan differs from it is NOT touched ("changed_since_preview"). Idempotent: applying the same preview
 * twice changes nothing the second time.
 */
export async function applyOrderRepair(args: { businessSlug: string; adminId: string; approved: { orderId: string; fingerprint: string }[] }): Promise<RepairResult[]> {
  const { businessSlug, adminId } = args;
  const wanted = new Map(args.approved.map((a) => [a.orderId, a.fingerprint]));
  const { plans, orders } = await planAll(businessSlug, new Set(wanted.keys()));
  const results: RepairResult[] = [];
  for (const [orderId, fingerprint] of wanted) {
    const order = orders.find((o) => o.id === orderId);
    const plan = plans.get(orderId);
    if (!order || !plan) {
      results.push({ orderId, ref: null, outcome: "not_found" });
      continue;
    }
    if (plan.changes.length === 0) {
      // Either nothing to do, or the preview was already applied (the plan is empty afterwards): both are a no-op.
      results.push({ orderId, ref: plan.ref, outcome: "nothing_to_apply" });
      continue;
    }
    if (plan.fingerprint !== fingerprint) {
      results.push({ orderId, ref: plan.ref, outcome: "changed_since_preview" });
      continue;
    }
    const fields: OrderFields = { ...fieldsOf(order) };
    for (const c of plan.changes) if (c.field !== "status") (fields as unknown as Record<string, unknown>)[c.field] = c.after;
    // The status follows the repaired essentials; a confirmed order is never moved.
    const status = order.status === "confirmed" ? order.status : isComplete(computeMissing(fields)) ? "awaiting_confirmation" : "possible";
    const becameAwaiting = order.status === "possible" && status === "awaiting_confirmation";
    const row = rowFrom(
      order,
      { ...fields, delivery_preference: fields.fulfilment_method ?? fields.delivery_preference },
      {
        status,
        attention: order.attention,
        awaitingSince: status === "awaiting_confirmation" ? (order.awaiting_since ?? (becameAwaiting ? order.last_message_at : null)) : null,
        missing: computeMissing(fields),
        event: "ai_update",
        confirmedByCustomer: false,
        customerConfirmedAt: order.customer_confirmed_at,
      },
      // The customer did not write anything: the order's own message times and ids stay as they were.
      { chatId: order.chat_id, phone: order.contact_number, messageIds: [], firstAt: order.first_message_at, lastAt: order.last_message_at }
    );
    const res = await applyOrder({
      businessSlug,
      key: `repair:${plan.fingerprint}`,
      existing: order,
      row,
      event: "order_repair",
      actorKind: "admin",
      actorId: adminId,
      changes: {
        ...Object.fromEntries(plan.changes.map((c) => [c.field, { before: c.before, after: c.after }])),
        repair: { before: null, after: { reasons: plan.changes.map((c) => `${c.field}: ${c.reason}`), evidence: plan.changes.map((c) => c.evidence).filter(Boolean) } },
      },
      messageIds: [],
    });
    const outcome: RepairOutcome = res.result === "applied" ? "applied" : res.result === "duplicate" ? "already_applied" : res.result === "conflict" ? "conflict" : "not_found";
    results.push({ orderId, ref: plan.ref, outcome });
    if (outcome === "applied") {
      await audit(businessSlug, "admin", adminId, "order.repair", { type: "order", id: orderId }, { fields: plan.changes.map((c) => c.field), fingerprint: plan.fingerprint });
    }
  }
  return results;
}
