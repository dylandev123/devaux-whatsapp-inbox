"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, AuditView, EventView, OutboxView } from "@/lib/aiAgent/client";
import { failureReason, OutboxState, outboxState, UNRESOLVED_AFTER_MS } from "@/lib/aiAgent/outboxStatus";
import { Badge, Card, formatWhen, Notice } from "@/components/admin/aiAgent/ui";

const STATE_ORDER: OutboxState[] = ["unresolved", "failed", "pending", "dispatched", "blocked", "sent"];

export function ActivityPanel({ businessSlug }: { businessSlug: string }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [outbox, setOutbox] = useState<OutboxView[]>([]);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [auditRows, setAuditRows] = useState<AuditView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await aiAgentApi.listActivity(businessSlug);
      setEvents(data.events);
      setOutbox(data.outbox);
      setLoadedAt(new Date());
      setAuditRows(data.audit);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = outbox.map((o) => ({ ...o, state: outboxState(o, loadedAt) }));
  const counts = new Map<OutboxState, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <Card title="Outbox" subtitle="Every message the agent asked the bridge to send (newest first). Nothing here is ever retried automatically.">
        <button type="button" onClick={load} className="mb-2 cursor-pointer text-xs text-zinc-500 hover:text-zinc-900">
          Refresh
        </button>
        {(counts.get("unresolved") ?? 0) > 0 && (
          <div className="mb-2">
            <Notice tone="warn">
              {counts.get("unresolved")} send(s) have had no outcome from the bridge for over {UNRESOLVED_AFTER_MS / 60_000} minutes. They
              may or may not have reached WhatsApp. Check the chat before sending anything by hand. They are never retried.
            </Notice>
          </div>
        )}
        {rows.length === 0 ? (
          <Notice tone="info">Nothing has been queued for sending.</Notice>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-2 text-xs text-zinc-500">
              {STATE_ORDER.filter((s) => counts.has(s)).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <Badge value={s} /> {counts.get(s)}
                </span>
              ))}
            </div>
            <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
              {rows.map((o) => (
                <li key={o.id} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge value={o.state} />
                    <span className="text-xs text-zinc-500">{o.kind.replace("_", " ")}</span>
                    <span className="truncate text-xs text-zinc-400">→ {o.to_jid}</span>
                    <span className="text-xs text-zinc-400">{o.business_slug}</span>
                  </div>
                  <p className="mt-1 truncate text-zinc-700">{o.body}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    queued {formatWhen(o.created_at)}
                    {o.dispatched_at && ` · dispatched ${formatWhen(o.dispatched_at)}`}
                    {o.sent_at && ` · sent ${formatWhen(o.sent_at)}`}
                    {o.whatsapp_message_id && ` · WhatsApp id ${o.whatsapp_message_id}`}
                  </p>
                  {o.state === "blocked" && (
                    <p className="mt-0.5 text-xs text-zinc-500">Not sent on purpose: {failureReason(o.error)}</p>
                  )}
                  {o.state === "failed" && <p className="mt-0.5 text-xs text-red-600">Not sent: {o.error ?? "no reason given"}</p>}
                  {o.state === "unresolved" && (
                    <p className="mt-0.5 text-xs text-amber-700">Outcome unknown: no ack from the bridge. It may or may not have been delivered.</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card title="Decisions" subtitle="Every message the agent processed (newest first).">
        <button type="button" onClick={load} className="mb-2 cursor-pointer text-xs text-zinc-500 hover:text-zinc-900">
          Refresh
        </button>
        {events.length === 0 ? (
          <Notice tone="info">No activity yet.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {events.map((e) => (
              <li key={e.id} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge value={e.decision} />
                  {e.mode === "observe" && e.proposed_reply && (
                    <span className="text-[11px] text-zinc-500">Observe · shadow only, not sent</span>
                  )}
                  <span className="text-xs text-zinc-500">{e.kind.replace("_", " ")}</span>
                  <span className="truncate text-xs text-zinc-400">{e.chat_id}</span>
                  <span className="text-xs text-zinc-400">
                    {formatWhen(e.created_at)} · {e.mode}
                    {e.confidence !== null && ` · conf ${Math.round(Number(e.confidence) * 100)}%`}
                    {e.latency_ms !== null && ` · ${e.latency_ms}ms`}
                  </span>
                </div>
                {e.message_excerpt && <p className="mt-1 truncate text-zinc-700">“{e.message_excerpt}”</p>}
                {e.proposed_reply && <p className="mt-0.5 truncate text-xs text-zinc-500">↳ {e.proposed_reply}</p>}
                <p className="mt-0.5 text-xs text-zinc-400">{e.reason_codes.join(", ")}</p>
                {e.error && <p className="mt-0.5 text-xs text-red-600">{e.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Audit trail" subtitle="Settings changes, approvals, takeovers and staff actions.">
        {auditRows.length === 0 ? (
          <Notice tone="info">No audit entries yet.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
            {auditRows.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2 px-3 py-1.5">
                <span className="text-xs text-zinc-400">{formatWhen(a.created_at)}</span>
                <span className="font-medium text-zinc-800">{a.action}</span>
                <span className="text-xs text-zinc-500">
                  by {a.actor_kind}
                  {a.target_id && ` · ${a.target_type} ${a.target_id}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
