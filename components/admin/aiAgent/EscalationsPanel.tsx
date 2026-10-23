"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, EscalationView } from "@/lib/aiAgent/client";
import { formatOrderRequest } from "@/lib/aiAgent/engine";
import { Badge, Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

function EscalationItem({ businessSlug, e, onChanged }: { businessSlug: string; e: EscalationView; onChanged: () => void }) {
  const [answer, setAnswer] = useState(e.proposed_reply ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const open = e.status === "open" || e.status === "notified" || e.status === "answered";
  const order = formatOrderRequest(e.context?.order_request ?? null);

  async function act(action: string, body?: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await aiAgentApi.actOnEscalation(businessSlug, e.id, action, body);
      setMessage({ tone: "ok", text: res.message });
      onChanged();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-zinc-900">#{e.ref_code}</span>
        <Badge value={e.priority} />
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">{e.status}</span>
        <span className="font-medium text-zinc-900">{e.customer_name ?? e.chat_id}</span>
        <span className="text-xs text-zinc-400">{formatWhen(e.created_at)}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">Reasons: {e.reason_codes.join(", ") || e.reason}</p>
      {e.ai_summary && <p className="mt-1 text-xs text-zinc-500">Summary: {e.ai_summary}</p>}
      <p className="mt-1 whitespace-pre-wrap rounded bg-zinc-50 px-2 py-1 text-zinc-800">{e.customer_message}</p>
      {order && <p className="mt-1 text-xs text-amber-800">Order request (not confirmed): {order}</p>}
      {e.staff_answer && (
        <p className="mt-1 text-xs text-emerald-700">
          Staff answer ({e.answered_via}, {formatWhen(e.answered_at)}): {e.staff_answer}
        </p>
      )}
      {(e.context?.notes ?? []).map((n, i) => (
        <p key={i} className="mt-1 text-xs text-zinc-500">
          Note {formatWhen(n.at)}: {n.text}
        </p>
      ))}

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea value={answer} onChange={(ev) => setAnswer(ev.target.value)} rows={2} placeholder="Exact text to send to the customer…" className={inputClass} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !answer.trim()} className={primaryButton} onClick={() => act("send", answer, "Send this exact text to the customer?")}>
              Send to customer
            </button>
            <button type="button" disabled={busy || !answer.trim()} className={secondaryButton} onClick={() => act("note", answer)}>
              Save as note
            </button>
            <button type="button" disabled={busy} className={secondaryButton} onClick={() => act("close")}>
              Close
            </button>
            <button type="button" disabled={busy} className={secondaryButton} onClick={() => act("takeover")}>
              Take over chat
            </button>
            <button type="button" disabled={busy} className={secondaryButton} onClick={() => act("resume")}>
              Resume AI
            </button>
          </div>
        </div>
      )}
      {message && (
        <div className="mt-2">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
    </li>
  );
}

export function EscalationsPanel({ businessSlug }: { businessSlug: string }) {
  const [items, setItems] = useState<EscalationView[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await aiAgentApi.listEscalations(businessSlug, openOnly)).escalations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load escalations");
    }
  }, [businessSlug, openOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card
      title="Escalations"
      subtitle="Staff can also answer in the WhatsApp group by replying to the notice or including its #E- code. Answers are sent verbatim."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Unanswered only
          </label>
          <button type="button" onClick={load} className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-900">
            Refresh
          </button>
        </div>
        {items.length === 0 ? (
          <Notice tone="info">No escalations.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {items.map((e) => (
              <EscalationItem key={e.id} businessSlug={businessSlug} e={e} onChanged={load} />
            ))}
          </ul>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
