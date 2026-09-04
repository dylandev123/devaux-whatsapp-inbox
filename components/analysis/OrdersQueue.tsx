"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ConversationAnalysis,
  fetchOrderPlacedAnalyses,
  markOrderDelivered,
  ORDER_STATUSES,
  OrderStatus,
  resurfaceDoneWithNewActivity,
  updateOrderStatus,
  updateWorkflowStatus,
  WORKFLOW_STATUSES,
  WorkflowStatus,
} from "@/lib/analysis";
import { businessColor, businessLabel } from "@/lib/whatsapp";
import { logAndDescribeError } from "@/lib/errors";

type StatusFilter = "All" | OrderStatus;

interface OrdersQueueProps {
  onOpenDetail: (analysis: ConversationAnalysis) => void;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadgeClass(status: OrderStatus) {
  switch (status) {
    case "Added":
      return "border-blue-200 bg-blue-50 text-blue-700";
    case "Completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    default:
      return "border-amber-200 bg-amber-50 text-amber-700";
  }
}

// Cross-business queue of every conversation currently classified "Order
// placed" (see lib/analysis.ts's fetchOrderPlacedAnalyses), so staff don't
// have to check every business tab individually to avoid missing one. This
// is purely a tracking view — no order is ever created here; the status
// dropdown only records staff's own manual progress against the real order
// system.
export function OrdersQueue({ onOpenDetail }: OrdersQueueProps) {
  const [orders, setOrders] = useState<ConversationAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowStatus>("Active");
  const [newActivityIds, setNewActivityIds] = useState<Set<string>>(new Set());
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchOrderPlacedAnalyses();
      // Same auto-resurface as the Overview tab (see
      // resurfaceDoneWithNewActivity) — a delivered order that gets a new
      // message moves back to Active here too.
      let effectiveRows = rows;
      try {
        const { updated, newActivityIds: resurfaced } = await resurfaceDoneWithNewActivity(rows);
        if (updated.length > 0) {
          const updatedById = new Map(updated.map((r) => [r.id, r]));
          effectiveRows = rows.map((r) => updatedById.get(r.id) ?? r);
        }
        setNewActivityIds(resurfaced);
      } catch (err) {
        logAndDescribeError("resurfaceDoneWithNewActivity", err);
      }
      setOrders(effectiveRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const workflowCounts = useMemo(() => {
    const counts = new Map<WorkflowStatus, number>();
    for (const order of orders) {
      counts.set(order.workflow_status, (counts.get(order.workflow_status) ?? 0) + 1);
    }
    return counts;
  }, [orders]);

  // Scoped to the current Active/Done bucket, so these counts always add up
  // to whatever "All" shows in that bucket.
  const statusCounts = useMemo(() => {
    const counts = new Map<OrderStatus, number>();
    for (const order of orders) {
      if (order.workflow_status !== workflowFilter) continue;
      const status = order.order_status ?? "Needs adding";
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [orders, workflowFilter]);

  const ordersInWorkflow = useMemo(
    () => orders.filter((o) => o.workflow_status === workflowFilter),
    [orders, workflowFilter]
  );

  const filtered = useMemo(() => {
    return ordersInWorkflow.filter(
      (o) => statusFilter === "All" || (o.order_status ?? "Needs adding") === statusFilter
    );
  }, [ordersInWorkflow, statusFilter]);

  function clearNewActivity(id: string) {
    setNewActivityIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleStatusChange(order: ConversationAnalysis, status: OrderStatus) {
    setUpdatingId(order.id);
    setError(null);
    // Optimistic — this is a lightweight staff-tracking field, worth
    // updating instantly rather than waiting on a round-trip.
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, order_status: status } : o)));
    try {
      await updateOrderStatus(order.id, status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update order status");
      await load();
    } finally {
      setUpdatingId(null);
    }
  }

  // Quick tick-off: "delivery added/noted" for an order sets order_status
  // to Completed and workflow_status to Done in one write (see
  // markOrderDelivered) — leaves the active Orders queue immediately.
  async function handleMarkDelivered(order: ConversationAnalysis) {
    setUpdatingId(order.id);
    setError(null);
    setOrders((prev) =>
      prev.map((o) => (o.id === order.id ? { ...o, order_status: "Completed", workflow_status: "Done" } : o))
    );
    clearNewActivity(order.id);
    try {
      await markOrderDelivered(order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark order delivered");
      await load();
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleReopen(order: ConversationAnalysis) {
    setUpdatingId(order.id);
    setError(null);
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, workflow_status: "Active" } : o)));
    clearNewActivity(order.id);
    try {
      await updateWorkflowStatus(order.id, "Active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reopen order");
      await load();
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {WORKFLOW_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setWorkflowFilter(value);
              setStatusFilter("All");
            }}
            aria-pressed={workflowFilter === value}
            className={`cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium ${
              workflowFilter === value ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {value} ({workflowCounts.get(value) ?? 0})
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter("All")}
            className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
              statusFilter === "All" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
            }`}
          >
            All ({ordersInWorkflow.length})
          </button>
          {ORDER_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                statusFilter === status ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
              }`}
            >
              {status} ({statusCounts.get(status) ?? 0})
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          className="cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
        >
          Refresh
        </button>
      </div>

      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex flex-col gap-3">
        {loading && <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500">
            {orders.length === 0
              ? "No AI-detected orders yet. Run analysis from the Overview tab to populate this queue."
              : "No orders match this filter."}
          </p>
        )}
        {!loading &&
          filtered.map((order) => {
            const color = businessColor(order.business_slug);
            const status = order.order_status ?? "Needs adding";
            const extracted = order.extracted;
            return (
              <div key={order.id} className="rounded-lg border border-zinc-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color.dot}`} aria-hidden />
                      <span className={`text-[11px] font-medium uppercase tracking-wide ${color.text}`}>
                        {businessLabel(order.business_slug)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenDetail(order)}
                        className="cursor-pointer text-left text-base font-semibold text-zinc-900 hover:text-emerald-600 hover:underline"
                      >
                        {order.customer_name ?? "Unknown"}
                      </button>
                      {newActivityIds.has(order.id) && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                          New activity
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-zinc-500">{order.phone_display ?? "No phone number on file"}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusBadgeClass(status)}`}>
                      {status}
                    </span>
                    <select
                      value={status}
                      onChange={(e) => handleStatusChange(order, e.target.value as OrderStatus)}
                      disabled={updatingId === order.id}
                      aria-label="Order status"
                      className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 outline-none focus:border-emerald-500 disabled:opacity-50"
                    >
                      {ORDER_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    {order.workflow_status === "Done" ? (
                      <button
                        type="button"
                        onClick={() => handleReopen(order)}
                        disabled={updatingId === order.id}
                        className="cursor-pointer rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    ) : (
                      <label
                        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 has-[:disabled]:cursor-default has-[:disabled]:opacity-50"
                        title="Delivery added/noted — marks this order Completed and Done"
                      >
                        <input
                          type="checkbox"
                          checked={false}
                          disabled={updatingId === order.id}
                          onChange={() => handleMarkDelivered(order)}
                        />
                        Delivered
                      </label>
                    )}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm text-zinc-700 sm:grid-cols-2">
                  {extracted.products_services?.length ? (
                    <p>
                      <span className="text-zinc-400">Products/services: </span>
                      {extracted.products_services.join(", ")}
                      {extracted.quantity ? ` (qty: ${extracted.quantity})` : ""}
                    </p>
                  ) : (
                    <p className="text-zinc-400">No products/services extracted</p>
                  )}
                  {extracted.dates?.length ? (
                    <p>
                      <span className="text-zinc-400">Delivery/booking date: </span>
                      {extracted.dates.join(", ")}
                    </p>
                  ) : null}
                  {extracted.address && (
                    <p>
                      <span className="text-zinc-400">Address: </span>
                      {extracted.address}
                    </p>
                  )}
                  {(extracted.payment_info || extracted.booking_info) && (
                    <p>
                      <span className="text-zinc-400">Payment: </span>
                      {extracted.payment_info ?? extracted.booking_info}
                    </p>
                  )}
                </dl>

                <p className="mt-2 line-clamp-2 text-sm text-zinc-500">{order.summary}</p>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-zinc-400">
                    {order.confidence !== null ? `${Math.round(order.confidence * 100)}% confidence` : "Confidence unknown"}{" "}
                    · Analyzed {formatDateTime(order.analyzed_at)}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(order)}
                      className="cursor-pointer text-xs font-medium text-zinc-600 hover:text-emerald-600 hover:underline"
                    >
                      View customer/profile
                    </button>
                    <Link
                      href={`/?business=${encodeURIComponent(order.business_slug)}&chat=${encodeURIComponent(order.chat_id)}`}
                      className="text-xs font-medium text-emerald-600 hover:underline"
                    >
                      Open conversation ↗
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
