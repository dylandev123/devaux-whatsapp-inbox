"use client";

import { useEffect, useState } from "react";
import { describeError } from "@/lib/errors";
import {
  DELIVERY_STATUS_STYLES,
  DeliveryRow,
  fetchDeliveries,
  formatStLucia,
  ScheduleRun,
  runStatusBadge,
} from "@/lib/scheduledMessages";

function RunDeliveries({ runId }: { runId: string }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchDeliveries(runId)
      .then((data) => active && setRows(data))
      .catch((err) => active && setError(describeError(err)));
    return () => {
      active = false;
    };
  }, [runId]);

  if (error) return <p className="px-3 py-2 text-xs text-red-600">{error}</p>;
  if (!rows) return <p className="px-3 py-2 text-xs text-zinc-500">Loading…</p>;
  if (rows.length === 0) return <p className="px-3 py-2 text-xs text-zinc-500">No deliveries recorded.</p>;

  return (
    <ul className="divide-y divide-zinc-100">
      {rows.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs">
          <span className="min-w-0 truncate text-zinc-700">
            {d.recipient_kind === "group" ? "👥 " : ""}
            {d.recipient_name || d.recipient_jid.replace(/@.*$/, "")}
          </span>
          <span className="flex items-center gap-2">
            {d.error && <span className="max-w-xs truncate text-red-600" title={d.error}>{d.error}</span>}
            {d.sent_at && <span className="text-zinc-400">{formatStLucia(d.sent_at)}</span>}
            <span className={`rounded-full px-2 py-0.5 font-medium ${DELIVERY_STATUS_STYLES[d.status]}`}>{d.status}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RunHistory({ runs }: { runs: ScheduleRun[] }) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  if (runs.length === 0) {
    return <p className="px-3 py-3 text-xs text-zinc-500">No runs yet. History appears once the bridge has processed an occurrence.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {runs.map((run) => {
        const badge = runStatusBadge(run.status);
        const c = run.deliveryCounts;
        const total = c.pending + c.sending + c.sent + c.failed + c.unknown;
        const open = openRunId === run.id;
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => setOpenRunId(open ? null : run.id)}
              className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-50"
            >
              <span className="text-zinc-700">
                {formatStLucia(run.scheduled_for)}
                {run.trigger_type === "test" ? " · test" : ""}
              </span>
              <span className="flex items-center gap-2">
                {total > 0 && (
                  <span className="text-zinc-500">
                    {c.sent}/{total} sent{c.failed ? ` · ${c.failed} failed` : ""}{c.unknown ? ` · ${c.unknown} unknown` : ""}
                  </span>
                )}
                <span className={`rounded-full px-2 py-0.5 font-medium ${badge.className}`}>{badge.label}</span>
              </span>
            </button>
            {open && (
              <div className="bg-zinc-50">
                {run.error && <p className="px-3 pt-2 text-xs text-red-600">{run.error}</p>}
                <RunDeliveries runId={run.id} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
