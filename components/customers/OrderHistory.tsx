"use client";

import { useEffect, useState } from "react";
import { CustomerOrder, fetchOrdersForCustomer } from "@/lib/customerOrders";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function statusClass(status: CustomerOrder["order_status"]) {
  switch (status) {
    case "Completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "Added":
      return "border-blue-200 bg-blue-50 text-blue-700";
    default:
      return "border-amber-200 bg-amber-50 text-amber-700";
  }
}

// Permanent order history from customer_orders — still available months
// later, after the original WhatsApp messages have been purged.
export function OrderHistory({ businessSlug, contactNumber }: { businessSlug: string; contactNumber: string }) {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchOrdersForCustomer(businessSlug, contactNumber)
      .then((rows) => {
        if (active) setOrders(rows);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load order history");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessSlug, contactNumber]);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Order history</h3>
      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && orders.length === 0 && (
        <p className="text-sm text-zinc-500">No orders recorded yet.</p>
      )}
      {orders.map((order) => {
        const products = order.details?.products_services ?? [];
        const dates = order.details?.dates ?? [];
        return (
          <div key={order.id} className="rounded-lg border border-zinc-200 p-3 text-sm text-zinc-700">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-zinc-900">
                {formatDate(order.source_message_at ?? order.detected_at)}
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClass(order.order_status)}`}>
                {order.order_status === "Completed" ? "Delivered" : order.order_status ?? "Needs adding"}
              </span>
            </div>
            <p className="mt-1">
              {products.length ? products.join(", ") : order.summary}
              {products.length && order.details?.quantity ? ` (qty: ${order.details.quantity})` : ""}
            </p>
            {dates.length > 0 && <p className="text-xs text-zinc-500">Date: {dates.join(", ")}</p>}
            {order.delivery_address && <p className="text-xs text-zinc-500">Address: {order.delivery_address}</p>}
            {order.payment_info && <p className="text-xs text-zinc-500">Payment: {order.payment_info}</p>}
          </div>
        );
      })}
    </section>
  );
}
