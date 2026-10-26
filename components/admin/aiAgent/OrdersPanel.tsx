"use client";

import { useCallback, useEffect, useState } from "react";
import type { Coverage } from "@/lib/aiAgent/orders";
import { aiAgentApi, BackfillRunView, OrderEventView, OrderRunView, OrderView } from "@/lib/aiAgent/client";
import type { AgentSettings } from "@/lib/aiAgent/engine";
import { ATTENTION_TEXT, confirmationLabel, coverageLines, formatLine, MISSING_TEXT, ORDER_STATUSES, type OrderLine, type OrderStatus } from "@/lib/aiAgent/orders";
import { useDebounced } from "@/components/admin/aiAgent/useDebounced";
import { Badge, Card, dangerButton, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

const STATUS_LABEL: Record<OrderStatus, string> = {
  possible: "Possible",
  awaiting_confirmation: "Awaiting confirmation",
  confirmed: "Confirmed",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};
const STATUS_STYLE: Record<OrderStatus, string> = {
  possible: "bg-zinc-100 text-zinc-700",
  awaiting_confirmation: "bg-amber-100 text-amber-800",
  confirmed: "bg-emerald-50 text-emerald-700",
  fulfilled: "bg-blue-50 text-blue-700",
  cancelled: "bg-red-50 text-red-700",
};

function EditForm({ order, onSave, onCancel, busy }: { order: OrderView; busy: boolean; onCancel: () => void; onSave: (patch: Record<string, unknown>) => void }) {
  const [name, setName] = useState(order.customer_name ?? "");
  const [items, setItems] = useState<OrderLine[]>(order.items.length ? order.items : [{ product: "", quantity: null, variant: null, size: null }]);
  const [method, setMethod] = useState(order.fulfilment_method ?? "");
  const [address, setAddress] = useState(order.delivery_address ?? "");
  const [when, setWhen] = useState(order.requested_for ?? "");
  const [notes, setNotes] = useState(order.notes ?? "");

  const setItem = (i: number, patch: Partial<OrderLine>) => setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  function submit() {
    // Only what actually changed is sent, so only that is locked against later AI updates.
    const patch: Record<string, unknown> = {};
    const same = (a: string | null, b: string) => (a ?? "") === b.trim();
    if (!same(order.customer_name, name)) patch.customer_name = name.trim() || null;
    if (!same(order.delivery_address, address)) patch.delivery_address = address.trim() || null;
    if (!same(order.requested_for, when)) patch.requested_for = when.trim() || null;
    if (!same(order.notes, notes)) patch.notes = notes.trim() || null;
    if ((order.fulfilment_method ?? "") !== method) patch.fulfilment_method = method || null;
    const cleaned = items.filter((i) => i.product.trim()).map((i) => ({ product: i.product.trim(), quantity: i.quantity?.trim() || null, variant: i.variant?.trim() || null, size: i.size?.trim() || null }));
    if (JSON.stringify(cleaned) !== JSON.stringify(order.items)) patch.items = cleaned;
    onSave(patch);
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">Customer name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>
      <div className="flex flex-col gap-2">
        <label className="block text-xs font-medium text-zinc-500">Products</label>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <input placeholder="Product" value={it.product} onChange={(e) => setItem(i, { product: e.target.value })} className={`${inputClass} col-span-2 sm:col-span-1`} />
            <input placeholder="Qty" value={it.quantity ?? ""} onChange={(e) => setItem(i, { quantity: e.target.value })} className={inputClass} />
            <input placeholder="Variant" value={it.variant ?? ""} onChange={(e) => setItem(i, { variant: e.target.value })} className={inputClass} />
            <input placeholder="Size" value={it.size ?? ""} onChange={(e) => setItem(i, { size: e.target.value })} className={inputClass} />
            <button type="button" className={secondaryButton} onClick={() => setItems((cur) => cur.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button type="button" className={secondaryButton} onClick={() => setItems((cur) => [...cur, { product: "", quantity: null, variant: null, size: null }])}>
            Add product
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Delivery or collection</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
            <option value="">Not stated</option>
            <option value="delivery">Delivery</option>
            <option value="collection">Collection</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-zinc-500">Delivery address</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Day / time wanted</label>
          <input value={when} onChange={(e) => setWhen(e.target.value)} className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-zinc-500">Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </div>
      </div>
      <p className="text-xs text-zinc-500">Fields you change are locked: later AI updates will not overwrite them.</p>
      <div className="flex gap-2">
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          Save changes
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  );
}

function History({ businessSlug, orderId }: { businessSlug: string; orderId: string }) {
  const [events, setEvents] = useState<OrderEventView[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    aiAgentApi.orderEvents(businessSlug, orderId).then((r) => !cancelled && setEvents(r.events)).catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [businessSlug, orderId]);
  if (!events) return <p className="mt-2 text-xs text-zinc-500">Loading history…</p>;
  if (events.length === 0) return <p className="mt-2 text-xs text-zinc-500">No history yet.</p>;
  return (
    <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white text-xs">
      {events.map((e) => (
        <li key={e.id} className="px-3 py-2">
          <span className="font-medium text-zinc-800">{e.kind.replace(/_/g, " ")}</span>
          <span className="text-zinc-500">
            {" "}
            · {e.actor_kind}
            {e.actor_kind === "admin" && e.actor_id ? ` (${e.actor_id.slice(0, 8)})` : ""} · {formatWhen(e.created_at)}
            {e.whatsapp_message_ids.length > 0 ? ` · ${e.whatsapp_message_ids.length} message${e.whatsapp_message_ids.length === 1 ? "" : "s"}` : ""}
          </span>
          {Object.entries(e.changes).map(([field, c]) => (
            <p key={field} className="mt-0.5 text-zinc-600">
              {field.replace(/_/g, " ")}: {typeof c?.before === "object" ? "…" : String(c?.before ?? "—")} → {typeof c?.after === "object" ? "updated" : String(c?.after ?? "—")}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function OrderCard({ businessSlug, order, onChanged }: { businessSlug: string; order: OrderView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = order.status === "possible" || order.status === "awaiting_confirmation" || order.status === "confirmed";
  const missing = order.missing_fields.filter((m) => m in MISSING_TEXT);

  async function act(action: "edit" | "confirm" | "cancel" | "fulfil", extra: { patch?: Record<string, unknown>; reason?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      await aiAgentApi.updateOrder(businessSlug, order.id, action, { version: order.version, ...extra });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-zinc-900">{order.ref_code}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
        <span className="font-medium text-zinc-900">{order.customer_name ?? "Unnamed customer"}</span>
        <span className="text-xs text-zinc-500">{order.contact_number ? `+${order.contact_number}` : "phone not verified"}</span>
        <span className="ml-auto text-xs text-zinc-400">
          {formatWhen(order.first_message_at)} · updated {formatWhen(order.updated_at)}
        </span>
      </div>
      <p className="mt-1 text-zinc-800">{order.items.length ? order.items.map(formatLine).join("; ") : "No products yet"}</p>
      <p className="text-xs text-zinc-600">
        {order.fulfilment_method === "delivery" ? "Delivery" : order.fulfilment_method === "collection" ? "Collection" : "Delivery/collection not stated"}
        {order.delivery_address ? ` — ${order.delivery_address}` : ""}
        {order.requested_for ? ` — ${order.requested_for}` : ""}
      </p>
      {order.notes && <p className="text-xs text-zinc-600">Note: {order.notes}</p>}
      {missing.length > 0 && <p className="mt-1 text-xs text-amber-700">Missing: {missing.map((m) => MISSING_TEXT[m]).join(", ")}</p>}
      {order.attention && <p className="mt-1 text-xs font-medium text-amber-800">⚠ {ATTENTION_TEXT[order.attention] ?? order.attention}</p>}
      {order.status === "confirmed" && <p className="mt-1 text-xs text-zinc-500">Confirmed — {confirmationLabel(order)} · {formatWhen(order.confirmed_at)}</p>}
      {order.status !== "confirmed" && order.customer_confirmed_at && <p className="mt-1 text-xs text-zinc-500">Customer replied yes {formatWhen(order.customer_confirmed_at)} — not yet verified by staff</p>}
      {order.cancel_reason && order.status === "cancelled" && <p className="mt-1 text-xs text-zinc-500">Cancelled: {order.cancel_reason}</p>}
      <p className="mt-1 text-xs text-zinc-400">
        Built from {order.source_message_ids.length} customer message{order.source_message_ids.length === 1 ? "" : "s"}
        {order.manual_locked_fields.length > 0 ? ` · edited by staff: ${order.manual_locked_fields.join(", ").replace(/_/g, " ")}` : ""}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {open && (
          <>
            {order.status !== "confirmed" && (
              <button
                type="button"
                className={primaryButton}
                disabled={busy}
                onClick={() => window.confirm("Mark this order as confirmed? This only records it; nothing is sent to the customer.") && void act("confirm")}
              >
                Confirm
              </button>
            )}
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => setEditing((v) => !v)}>
              {editing ? "Close editor" : "Correct"}
            </button>
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => window.confirm("Mark this order as fulfilled?") && void act("fulfil")}>
              Fulfilled
            </button>
            <button
              type="button"
              className={dangerButton}
              disabled={busy}
              onClick={() => {
                const reason = window.prompt("Cancel this order? Optional reason (nothing is sent to the customer):");
                if (reason !== null) void act("cancel", { reason });
              }}
            >
              Cancel order
            </button>
          </>
        )}
        <button type="button" className={secondaryButton} onClick={() => setHistory((v) => !v)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {editing && <EditForm order={order} busy={busy} onCancel={() => setEditing(false)} onSave={(patch) => (Object.keys(patch).length ? void act("edit", { patch }) : setEditing(false))} />}
      {history && <History businessSlug={businessSlug} orderId={order.id} />}
    </li>
  );
}

const DELIVERY_TEXT: Record<string, string> = {
  sent: "delivered to WhatsApp",
  pending: "waiting for the bridge",
  dispatched: "handed to the bridge",
  unresolved: "no confirmation from the bridge — check the group; not resent automatically",
  blocked: "held back by a send rule",
  failed: "failed",
};

function RunsCard({ businessSlug, runs, settings, onSent }: { businessSlug: string; runs: OrderRunView[]; settings: AgentSettings; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function sendNow() {
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await aiAgentApi.sendOrderSummary(businessSlug);
      setOk(true);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const on = settings.orders_summary_enabled === true;
  return (
    <Card
      title="Daily summary"
      subtitle={
        on
          ? `Posted every day at ${String(settings.orders_summary_hour ?? 8).padStart(2, "0")}:00 (${settings.orders_timezone ?? "America/St_Lucia"}) to ${settings.orders_group_name ?? settings.orders_group_jid ?? settings.staff_group_name ?? "the staff group"}.`
          : "Switched off. Turn it on in Setup → Daily orders."
      }
    >
      <div className="flex items-center gap-2">
        <button type="button" className={secondaryButton} disabled={busy || !on} onClick={() => window.confirm("Post the order summary to the group now?") && void sendNow()}>
          Send summary now
        </button>
        {ok && <span className="text-sm text-emerald-700">Queued.</span>}
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {runs.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200 text-xs">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-medium text-zinc-800">{r.local_date}</span>
              <span className="text-zinc-500">{r.trigger === "scheduled" ? "scheduled" : "requested"}</span>
              <Badge value={r.status === "queued" ? (r.delivery ?? "pending") : r.status} />
              <span className="text-zinc-500">
                {r.status === "queued" && r.delivery ? DELIVERY_TEXT[r.delivery] : r.status === "missed" ? "not posted: outside the catch-up window" : r.status === "skipped" ? `not posted: ${r.skip_reason?.replace(/_/g, " ") ?? ""}` : ""}
                {r.confirmed_count != null ? ` · ${r.confirmed_count} confirmed, ${r.attention_count ?? 0} need attention${r.carried_count ? `, ${r.carried_count} carried forward` : ""}` : ""}
                {r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}
              </span>
              <span className="ml-auto text-zinc-400">{formatWhen(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const BACKFILL_STATUS: Record<BackfillRunView["status"], string> = { running: "in progress", done: "finished", failed: "failed", cancelled: "stopped" };

/**
 * Opt-in recovery of orders from the last 24-72 hours of stored messages that were never read for orders (customers the
 * AI is not allowed to reply to). Nothing starts by itself; it reads stored messages only and never messages a customer.
 */
function BackfillCard({ businessSlug, enabled, onDone }: { businessSlug: string; enabled: boolean; onDone: () => void }) {
  const [runs, setRuns] = useState<BackfillRunView[]>([]);
  const [hours, setHours] = useState(48);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns((await aiAgentApi.listBackfills(businessSlug)).runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [businessSlug]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Starts (or resumes) a run and keeps stepping it until it finishes, so the admin sees live progress. */
  async function run(existing?: BackfillRunView) {
    setWorking(true);
    setError(null);
    try {
      let current = existing ?? (await aiAgentApi.startBackfill(businessSlug, hours)).run;
      setRuns((cur) => [current, ...cur.filter((r) => r.id !== current.id)]);
      while (current.status === "running") {
        current = (await aiAgentApi.stepBackfill(businessSlug, current.id)).run;
        setRuns((cur) => [current, ...cur.filter((r) => r.id !== current.id)]);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setWorking(false);
      void load();
    }
  }

  async function cancel(r: BackfillRunView) {
    try {
      await aiAgentApi.cancelBackfill(businessSlug, r.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
    void load();
  }

  const active = runs.find((r) => r.status === "running");
  return (
    <Card title="Recover missed orders" subtitle="Reads stored messages from customers the AI could not analyse before, and adds any orders found. Opt-in; nothing is sent to customers.">
      <div className="flex flex-wrap items-center gap-2">
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={working || Boolean(active)} className={`${inputClass} sm:max-w-[12rem]`}>
          <option value={24}>Last 24 hours</option>
          <option value={48}>Last 48 hours</option>
          <option value={72}>Last 72 hours</option>
        </select>
        <button
          type="button"
          className={secondaryButton}
          disabled={working || !enabled}
          onClick={() => {
            if (active) void run(active);
            else if (window.confirm(`Look back ${hours} hours for orders that were never analysed?\n\nThis uses AI calls (one small call per batch of messages) and changes order records only. It can be run safely more than once.`)) void run();
          }}
        >
          {working ? "Working…" : active ? "Resume" : "Start"}
        </button>
        {active && !working && (
          <button type="button" className={dangerButton} onClick={() => void cancel(active)}>
            Stop
          </button>
        )}
        {!enabled && <span className="text-xs text-zinc-500">Turn on order tracking first.</span>}
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {runs.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200 text-xs">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-medium text-zinc-800">Last {r.hours} h</span>
              <span className="text-zinc-500">{BACKFILL_STATUS[r.status]}</span>
              <span className="text-zinc-500">
                {r.chats_done}/{r.chats_total} conversations · {r.messages_analysed} messages · {r.orders_touched} order change{r.orders_touched === 1 ? "" : "s"}
                {r.failures > 0 ? ` · ${r.failures} could not be analysed` : ""}
              </span>
              {r.note && <span className="text-amber-700">{r.note}</span>}
              <span className="ml-auto text-zinc-400">{formatWhen(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function OrdersPanel({ businessSlug, settings }: { businessSlug: string; settings: AgentSettings }) {
  const [status, setStatus] = useState<"open" | "all" | OrderStatus>("open");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 300);
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [runs, setRuns] = useState<OrderRunView[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await aiAgentApi.listOrders(businessSlug, status, debounced);
      setOrders(res.orders);
      setRuns(res.runs);
      setCoverage(res.coverage);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    }
  }, [businessSlug, status, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      {settings.orders_tracking_enabled !== true && (
        <Notice tone="warn">Order tracking is off for this business, so no new orders are being recorded. Turn it on in Setup → Daily orders.</Notice>
      )}
      {coverage && coverageLines(coverage, settings.orders_timezone ?? "America/St_Lucia").filter((l) => l.startsWith("⚠️") || l.startsWith("ℹ️")).map((l) => (
        <Notice key={l} tone={l.startsWith("⚠️") ? "warn" : "info"}>{l.replace(/\*/g, "")}</Notice>
      ))}
      {coverage && (coverage.filteredMessages ?? 0) > 0 && (
        <p className="text-xs text-zinc-500">
          {coverage.filteredMessages} message{coverage.filteredMessages === 1 ? "" : "s"} in the last {coverage.windowHours} h had no order wording (thanks, greetings, questions) and were only checked by the free filter.
        </p>
      )}
      <RunsCard businessSlug={businessSlug} runs={runs} settings={settings} onSent={load} />
      <BackfillCard businessSlug={businessSlug} enabled={settings.orders_tracking_enabled === true} onDone={load} />
      <Card title="Orders" subtitle="Orders found in customer conversations. Changes you make here are recorded with your name and never message the customer.">
        <div className="mb-3 flex flex-wrap gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone, product, address, reference…" className={`${inputClass} sm:max-w-sm`} />
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={`${inputClass} sm:max-w-[14rem]`}>
            <option value="open">Outstanding</option>
            <option value="all">All</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!orders && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {orders && orders.length === 0 && <p className="text-sm text-zinc-500">No orders match.</p>}
        {orders && orders.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {orders.map((o) => (
              <OrderCard key={`${o.id}:${o.version}`} businessSlug={businessSlug} order={o} onChanged={load} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
