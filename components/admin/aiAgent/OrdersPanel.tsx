"use client";

import { useCallback, useEffect, useState } from "react";
import type { Coverage } from "@/lib/aiAgent/orders";
import { aiAgentApi, BackfillRunView, OrderCountsView, OrderEventView, OrderRunView, OrderView, OrderViewName, RepairOutcomeView, RepairPreviewView } from "@/lib/aiAgent/client";
import type { AgentSettings } from "@/lib/aiAgent/engine";
import { ATTENTION_TEXT, CONFLICT_LABEL, conflictFields, conflictValueText, confirmationLabel, coverageLines, displayRef, formatLine, MISSING_TEXT, ORDER_STATUSES, type OrderLine, type OrderStatus } from "@/lib/aiAgent/orders";
import { ADDRESS_ORIGIN_LABEL } from "@/lib/aiAgent/orderAddress";
import { timeOfDay } from "@/lib/aiAgent/orderViews";
import { useDebounced } from "@/components/admin/aiAgent/useDebounced";
import { Badge, Card, dangerButton, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

const STATUS_LABEL: Record<OrderStatus, string> = {
  possible: "Possible",
  awaiting_confirmation: "Awaiting confirmation",
  confirmed: "Confirmed",
  fulfilled: "Completed",
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

/** "products from #K3PD7; address from #K3PD7; not resolved: items: no verified earlier order". */
function inferredText(value: unknown): string {
  const v = (value ?? {}) as { items?: string[]; delivery_address?: string; unresolved?: string[] };
  const parts = [
    ...(v.items?.length ? [`products from ${v.items.map(displayRef).join(", ")}`] : []),
    ...(v.delivery_address ? [v.delivery_address === "saved location" ? "Saved address" : `Previous address from ${displayRef(v.delivery_address)}`] : []),
    ...(v.unresolved?.length ? [`not resolved: ${v.unresolved.join("; ")}`] : []),
  ];
  return parts.join("; ") || "—";
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
            {(e.actor_kind === "admin" || e.actor_kind === "staff") && e.actor_id ? ` (${e.actor_id.slice(0, 8)})` : ""} · {formatWhen(e.created_at)}
            {e.whatsapp_message_ids.length > 0 ? ` · ${e.whatsapp_message_ids.length} message${e.whatsapp_message_ids.length === 1 ? "" : "s"}` : ""}
          </span>
          {Object.entries(e.changes).map(([field, c]) =>
            field === "inferred" ? (
              <p key={field} className="mt-0.5 text-zinc-600">
                From earlier orders (not said in this chat): {inferredText(c?.after)}
              </p>
            ) : (
              <p key={field} className="mt-0.5 text-zinc-600">
                {field.replace(/_/g, " ")}: {typeof c?.before === "object" ? "…" : String(c?.before ?? "—")} → {typeof c?.after === "object" ? "updated" : String(c?.after ?? "—")}
              </p>
            )
          )}
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

  async function act(action: "edit" | "confirm" | "cancel" | "fulfil" | "keep" | "reopen", extra: { patch?: Record<string, unknown>; conflictFields?: string[]; reason?: string } = {}) {
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
        <span className="font-mono text-xs font-semibold text-zinc-900">{displayRef(order.ref_code)}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
        <span className="font-medium text-zinc-900">{order.display_name ?? order.customer_name ?? "Unnamed customer"}</span>
        <span className="text-xs text-zinc-500">{order.contact_number ? `+${order.contact_number}` : "phone not verified"}</span>
        <span className="ml-auto text-xs text-zinc-400">
          {formatWhen(order.first_message_at)} · updated {formatWhen(order.updated_at)}
        </span>
      </div>
      <p className="mt-1 text-zinc-800">{order.items.length ? order.items.map(formatLine).join("; ") : "No products yet"}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-600">
        <span className={`rounded px-1.5 py-0.5 font-medium ${order.fulfilment_method === "collection" ? "bg-violet-50 text-violet-700" : "bg-sky-50 text-sky-700"}`}>
          {order.fulfilment_method === "collection" ? "Collection" : order.fulfilment_method === "delivery" ? "Delivery" : "Delivery (default)"}
        </span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${order.bucket === "overdue" ? "bg-red-50 text-red-700" : order.fulfilment_date ? "bg-zinc-100 text-zinc-700" : "bg-amber-50 text-amber-800"}`}>
          {order.bucket === "review" ? "Possible order — on no delivery list yet" : order.fulfilment_date_label ? `For ${order.fulfilment_date_label}${order.bucket === "overdue" ? " — overdue" : order.bucket === "today" ? " (today)" : order.bucket === "tomorrow" ? " (tomorrow)" : ""}${timeOfDay(order.requested_for) ? ` · ${timeOfDay(order.requested_for)}` : ""}` : order.bucket === "overdue" ? "Day unclear — overdue" : "Day unclear"}
        </span>
        {order.date_source === "unreadable" && order.requested_for && <span className="text-zinc-500">“{order.requested_for}”</span>}
        {order.delivery_address && <span>— {order.delivery_address}</span>}
        {order.delivery_address && order.address_origin && (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${order.address_origin === "saved" || order.address_origin === "previous" ? "bg-amber-50 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}
            title={order.address_origin === "saved" || order.address_origin === "previous" ? "Not stated in this chat — filled in from the customer's records. Check it, or edit it to confirm." : undefined}
          >
            {ADDRESS_ORIGIN_LABEL[order.address_origin]}
            {order.address_origin === "previous" && order.address_from_ref ? ` · ${displayRef(order.address_from_ref)}` : ""}
          </span>
        )}
      </p>
      {order.saved_location && order.fulfilment_method !== "collection" && (
        <p className="text-xs text-zinc-600">
          📍 Saved delivery location (set by staff {formatWhen(order.saved_location.set_at)}): <span className="font-medium">{order.saved_location.content}</span>
          {order.delivery_address && order.delivery_address.trim().toLowerCase() !== order.saved_location.content.trim().toLowerCase() ? <span className="text-amber-700"> — differs from this order's address</span> : null}
          {!order.delivery_address ? <span className="text-amber-700"> — not used on this order; check with the customer</span> : null}
        </p>
      )}
      {order.notes && <p className="text-xs text-zinc-600">Note: {order.notes}</p>}
      {open && (order.gaps ?? []).length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-amber-800">
          <span className="font-medium">Missing:</span>
          {(order.gaps ?? []).map((g) => (
            <span key={g} className="rounded bg-amber-50 px-1.5 py-0.5">{g === "requested_for" ? "day" : (MISSING_TEXT[g] ?? g)}</span>
          ))}
        </p>
      )}
      {conflictFields(order).map((field) => {
        const c = order.field_conflicts[field]!;
        return (
          <div key={field} className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            <p className="font-medium">⚠ Customer now says {CONFLICT_LABEL[field]}: {conflictValueText(field, c.proposed, 200)}</p>
            <p>Staff set: {conflictValueText(field, c.current, 200)} (kept — not changed automatically) · {formatWhen(c.at)}</p>
            {open && (
              <div className="mt-1 flex gap-2">
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act("edit", { patch: { [field]: c.proposed } })}>
                  Use customer's
                </button>
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act("keep", { conflictFields: [field] })}>
                  Keep staff's
                </button>
              </div>
            )}
          </div>
        );
      })}
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
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => window.confirm("Mark this order as completed? It leaves the outstanding lists; its history is kept and you can reopen it.") && void act("fulfil")}>
              Complete
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
        {order.status === "fulfilled" && (
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => window.confirm("Reopen this order? It returns to the outstanding lists.") && void act("reopen")}>
            Reopen
          </button>
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
      title="Morning list"
      subtitle={
        on
          ? `Posted every day at ${String(settings.orders_summary_hour ?? 8).padStart(2, "0")}:00 (${settings.orders_timezone ?? "America/St_Lucia"}) to ${settings.orders_group_name ?? settings.orders_group_jid ?? settings.staff_group_name ?? "the staff group"}.`
          : "Switched off. Turn it on in Setup → Daily orders."
      }
    >
      <div className="flex items-center gap-2">
        <button type="button" className={secondaryButton} disabled={busy || !on} onClick={() => window.confirm("Post today's and tomorrow's orders to the group now? (The same as typing !orders.)") && void sendNow()}>
          Post orders list now
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
                {r.confirmed_count != null ? ` · ${r.confirmed_count} listed, ${r.attention_count ?? 0} need attention${r.carried_count ? `, ${r.carried_count} overdue` : ""}` : ""}
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

const REPAIR_FIELD: Record<string, string> = {
  customer_name: "Customer name",
  fulfilment_method: "Delivery or collection",
  delivery_address: "Delivery address",
  requested_for: "Day",
  notes: "Notes",
  status: "Status",
};
const REPAIR_OUTCOME: Record<RepairOutcomeView, string> = {
  applied: "Updated",
  already_applied: "Already updated",
  changed_since_preview: "Skipped — the order changed since the preview, review it again",
  nothing_to_apply: "Nothing to change",
  not_found: "Skipped — no longer an open order",
  conflict: "Skipped — someone edited the order at the same moment, review it again",
};
const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/_/g, " "));

/**
 * Admin-only review of OPEN orders against the business rules and their own conversation. Two explicit steps: Review
 * (read-only preview with the customer's words) and Apply to the orders ticked here. Nothing is ticked by default, there is
 * no "apply all", and nothing is sent to customers. Orders staff edited, confirmed orders and closed orders are protected
 * by the server (see lib/aiAgent/orderRepair.ts).
 */
function RepairCard({ businessSlug, onApplied }: { businessSlug: string; onApplied: () => void }) {
  const [preview, setPreview] = useState<RepairPreviewView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RepairOutcomeView> | null>(null);

  async function review() {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      setPreview(await aiAgentApi.previewOrderRepair(businessSlug));
      setPicked(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not review the orders");
    } finally {
      setLoading(false);
    }
  }

  const items = preview?.items ?? [];
  const fixable = items.filter((i) => i.changes.length > 0);
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function apply() {
    const chosen = fixable.filter((i) => picked.has(i.orderId));
    if (chosen.length === 0) return;
    const lines = chosen.map((i) => `${displayRef(i.ref)} — ${i.changes.map((c) => REPAIR_FIELD[c.field] ?? c.field).join(", ")}`).join("\n");
    if (!window.confirm(`Update ${chosen.length} order${chosen.length === 1 ? "" : "s"} with the changes shown?\n\n${lines}\n\nThis edits order records only. Nothing is sent to customers.`)) return;
    setApplying(true);
    setError(null);
    try {
      const res = await aiAgentApi.applyOrderRepair(businessSlug, chosen.map((i) => ({ orderId: i.orderId, fingerprint: i.fingerprint })));
      setResults(Object.fromEntries(res.results.map((r) => [r.orderId, r.outcome])));
      setPicked(new Set());
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the orders");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card title="Review existing orders" subtitle="Checks outstanding orders against the delivery and day rules and what each customer actually wrote. You choose which orders to update; nothing changes until you confirm, and nothing is sent to customers.">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButton} disabled={loading || applying} onClick={() => void review()}>
          {loading ? "Reviewing…" : preview ? "Review again" : "Review existing orders"}
        </button>
        {preview && fixable.length > 0 && (
          <button type="button" className={primaryButton} disabled={applying || picked.size === 0} onClick={() => void apply()}>
            {applying ? "Updating…" : `Update ${picked.size} selected order${picked.size === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {preview && (
        <p className="mt-3 text-xs text-zinc-500">
          {preview.summary.open} outstanding order{preview.summary.open === 1 ? "" : "s"} checked · {preview.summary.withChanges} with proposed changes · {preview.summary.needReview} for a person to look at · {preview.summary.unchanged} fine
          {preview.truncated > 0 ? ` · ${preview.truncated} more not checked (limit reached)` : ""}
        </p>
      )}
      {preview && items.length === 0 && <p className="mt-2 text-sm text-zinc-600">Nothing to repair — every outstanding order already follows the rules.</p>}
      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {items.map((i) => (
            <li key={i.orderId} className="rounded-md border border-zinc-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {i.changes.length > 0 && (
                  <input type="checkbox" aria-label={`Update ${displayRef(i.ref)}`} checked={picked.has(i.orderId)} disabled={applying || Boolean(results?.[i.orderId])} onChange={() => toggle(i.orderId)} />
                )}
                <span className="font-semibold text-zinc-900">{displayRef(i.ref)}</span>
                <span className="text-zinc-700">{i.customer ?? i.phone ?? "Unknown customer"}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                {results?.[i.orderId] && <span className="text-xs font-medium text-emerald-700">{REPAIR_OUTCOME[results[i.orderId]]}</span>}
              </div>
              {i.changes.length > 0 && (
                <table className="mt-2 w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-zinc-500">
                      <th className="py-1 pr-3 font-medium">Field</th>
                      <th className="py-1 pr-3 font-medium">Now</th>
                      <th className="py-1 pr-3 font-medium">Proposed</th>
                      <th className="py-1 font-medium">Why, and what the customer wrote</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.changes.map((c) => (
                      <tr key={c.field} className="border-t border-zinc-100 align-top">
                        <td className="py-1 pr-3 font-medium text-zinc-700">{REPAIR_FIELD[c.field] ?? c.field}</td>
                        <td className="py-1 pr-3 text-zinc-500 line-through decoration-zinc-300">{shown(c.before)}</td>
                        <td className="py-1 pr-3 font-medium text-emerald-800">{shown(c.after)}</td>
                        <td className="py-1 text-zinc-600">
                          {c.reason}
                          {c.evidence && <span className="block italic text-zinc-500">“{c.evidence}”</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {i.skipped.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500">Left as it is: {i.skipped.map((s) => `${REPAIR_FIELD[s.field] ?? s.field} (${s.reason})`).join("; ")}</p>
              )}
              {i.review.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">
                  {i.review.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type TabId = "today" | "tomorrow" | "overdue" | "missing" | "undated" | "review" | "open" | "fulfilled" | "cancelled";
const TABS: { id: TabId; label: string; status: "open" | OrderStatus; view: OrderViewName; count?: keyof OrderCountsView }[] = [
  { id: "today", label: "Today", status: "open", view: "today", count: "today" },
  { id: "tomorrow", label: "Tomorrow", status: "open", view: "tomorrow", count: "tomorrow" },
  { id: "overdue", label: "Overdue", status: "open", view: "overdue", count: "overdue" },
  { id: "missing", label: "Missing information", status: "open", view: "missing", count: "missing" },
  { id: "undated", label: "Day unclear", status: "open", view: "undated", count: "undated" },
  { id: "review", label: "Review", status: "open", view: "review", count: "review" },
  { id: "open", label: "All outstanding", status: "open", view: "all", count: "open" },
  { id: "fulfilled", label: "Completed", status: "fulfilled", view: "all" },
  { id: "cancelled", label: "Cancelled", status: "cancelled", view: "all" },
];
const EMPTY_TEXT: Record<TabId, string> = {
  today: "Nothing outstanding for today.",
  tomorrow: "Nothing outstanding for tomorrow.",
  overdue: "No overdue orders.",
  missing: "Every outstanding order has the essentials.",
  undated: "Every outstanding order has a clear day.",
  review: "Nothing is waiting to be confirmed as an order.",
  open: "No outstanding orders.",
  fulfilled: "No completed orders match.",
  cancelled: "No cancelled orders match.",
};

/** Orders grouped by the day they are for, then Delivery (with South Deliveries) / Collection (outstanding views only). */
function GroupedOrders({ orders, businessSlug, onChanged }: { orders: OrderView[]; businessSlug: string; onChanged: () => void }) {
  // An order that might not be an order is in no day: it has its own group at the end until staff confirm or cancel it.
  const review = orders.filter((o) => o.bucket === "review");
  const days: { key: string; label: string; orders: OrderView[] }[] = [];
  for (const o of orders.filter((x) => x.bucket !== "review")) {
    const key = o.fulfilment_date ?? "none";
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: o.fulfilment_date_label ?? (o.bucket === "overdue" ? "Day unclear — first mentioned before today" : "Day unclear"), orders: [] };
      days.push(day);
    }
    day.orders.push(o);
  }
  const list = (items: OrderView[]) => (
    <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
      {items.map((o) => (
        <OrderCard key={`${o.id}:${o.version}`} businessSlug={businessSlug} order={o} onChanged={onChanged} />
      ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => {
        const deliveries = day.orders.filter((o) => (o.fulfilment_method ?? "delivery") === "delivery");
        const south = deliveries.filter((o) => o.south_group);
        const rest = deliveries.filter((o) => !o.south_group);
        const groups = [...new Set(south.map((o) => o.south_group as string))];
        const collections = day.orders.filter((o) => o.fulfilment_method === "collection");
        return (
          <section key={day.key}>
            <h3 className="mb-1 text-sm font-semibold text-zinc-800">
              {day.label} <span className="font-normal text-zinc-500">({day.orders.length})</span>
            </h3>
            {rest.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Delivery</p>
                {list(rest)}
              </div>
            )}
            {south.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">South deliveries <span className="font-normal normal-case text-zinc-400">({south.length})</span></p>
                {groups.map((group) => (
                  <div key={group} className="mb-1.5">
                    <p className="mb-0.5 text-xs font-medium text-zinc-700">📍 {group}</p>
                    {list(south.filter((o) => o.south_group === group))}
                  </div>
                ))}
              </div>
            )}
            {collections.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Collection</p>
                {list(collections)}
              </div>
            )}
          </section>
        );
      })}
      {review.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-amber-800">
            Might not be an order <span className="font-normal text-zinc-500">({review.length})</span>
          </h3>
          <p className="mb-1 text-xs text-zinc-500">On no delivery list. Confirm it if it is an order; cancel it if it is not.</p>
          {list(review)}
        </section>
      )}
    </div>
  );
}

const FINDING_LABEL: Record<string, string> = {
  might_not_be_order: "Might not be an order",
  delivery_day: "Delivery day",
  picture_unresolved: "Photo",
  address_answered: "Address answered in chat",
  product_confirmed: "Product confirmed in chat",
  quantity_answered: "Quantity answered in chat",
  quantity_corrected: "Quantity corrected",
  staff_warning_resolvable: "Staff warning can be cleared",
};

/** READ-ONLY: where an existing order's own conversation points somewhere other than what the order says. Applies nothing. */
function ConversationReviewCard({ businessSlug }: { businessSlug: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof aiAgentApi.orderReview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await aiAgentApi.orderReview(businessSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check the orders");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Check orders against their conversations" subtitle="Read-only. Looks for orders that may not be orders, delivery days staff agreed with the customer, photos nobody resolved, addresses, products and quantities the chat answered or corrected, and old staff warnings that can now be understood. Each suggestion shows the messages behind it and before → after. Nothing is changed here: you decide, using the usual actions on each order.">
      <button type="button" className={secondaryButton} disabled={busy} onClick={() => void run()}>
        {busy ? "Checking…" : result ? "Check again" : "Check outstanding orders"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            Checked {result.checked} outstanding order{result.checked === 1 ? "" : "s"}{result.skipped > 0 ? ` (${result.skipped} older ones not checked)` : ""}. {result.reviews.length === 0 ? "Nothing to suggest." : `${result.reviews.length} with suggestions.`}
          </p>
          {result.reviews.map((r) => (
            <div key={r.orderId} className="rounded-md border border-zinc-200 p-3 text-sm">
              <p className="font-mono text-xs font-semibold text-zinc-900">{displayRef(r.ref)}</p>
              {r.findings.map((f, i) => (
                <div key={i} className="mt-2">
                  <p className="text-zinc-800"><span className="font-medium">{FINDING_LABEL[f.kind] ?? f.kind}:</span> {f.summary}</p>
                  {(f.current || f.suggested) && (
                    <p className="text-xs text-zinc-600">{f.current ?? "—"} → <span className="font-medium">{f.suggested ?? "—"}</span></p>
                  )}
                  <ul className="mt-1 text-xs text-zinc-500">
                    {f.evidence.map((e, j) => (
                      <li key={j}>{formatWhen(e.at)} · {e.who}: “{e.text}”</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function OrdersPanel({ businessSlug, settings }: { businessSlug: string; settings: AgentSettings }) {
  const [tab, setTab] = useState<TabId>("today");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 300);
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [runs, setRuns] = useState<OrderRunView[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [counts, setCounts] = useState<OrderCountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = TABS.find((t) => t.id === tab)!;

  const load = useCallback(async () => {
    try {
      const res = await aiAgentApi.listOrders(businessSlug, current.status, debounced, current.view);
      setOrders(res.orders);
      setRuns(res.runs);
      setCoverage(res.coverage);
      setCounts(res.counts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    }
  }, [businessSlug, current.status, current.view, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = current.status === "open";
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
      {counts && (
        <div className={`rounded-md border px-4 py-3 text-sm ${counts.attention > 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {counts.attention > 0 ? (
            <>
              <span className="font-semibold">{counts.attention} order{counts.attention === 1 ? "" : "s"} need{counts.attention === 1 ? "s" : ""} attention</span>
              <span> — {[counts.overdue ? `${counts.overdue} overdue` : "", counts.missing ? `${counts.missing} missing information` : ""].filter(Boolean).join(", ") || "flagged for a look"}. </span>
            </>
          ) : (
            <span className="font-semibold">Nothing needs attention.</span>
          )}
          <span className="text-xs"> {counts.open} outstanding · {counts.today} today · {counts.tomorrow} tomorrow{counts.later ? ` · ${counts.later} later` : ""}</span>
        </div>
      )}
      <RunsCard businessSlug={businessSlug} runs={runs} settings={settings} onSent={load} />
      <BackfillCard businessSlug={businessSlug} enabled={settings.orders_tracking_enabled === true} onDone={load} />
      <RepairCard businessSlug={businessSlug} onApplied={load} />
      <ConversationReviewCard businessSlug={businessSlug} />
      <Card title="Orders" subtitle="Grouped by the day each order is for, not the day the message arrived. Changes you make here are recorded with your name and never message the customer.">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Order views">
          {TABS.map((t) => {
            const n = t.count && counts ? counts[t.count] : null;
            const hot = (t.id === "overdue" || t.id === "missing" || t.id === "review") && (n ?? 0) > 0;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md border px-3 py-1.5 text-sm ${tab === t.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"}`}
              >
                {t.label}
                {n !== null && <span className={`ml-1.5 rounded px-1.5 text-xs font-medium ${tab === t.id ? "bg-white/20" : hot ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-600"}`}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="mb-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone, product, address, reference…" className={`${inputClass} sm:max-w-sm`} />
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!orders && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {orders && orders.length === 0 && <p className="text-sm text-zinc-500">{debounced ? "No orders match your search." : EMPTY_TEXT[tab]}</p>}
        {orders && orders.length > 0 && grouped && <GroupedOrders orders={orders} businessSlug={businessSlug} onChanged={load} />}
        {orders && orders.length > 0 && !grouped && (
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
