"use client";

import { useState } from "react";
import { aiAgentApi, SimulationView } from "@/lib/aiAgent/client";
import { formatOrderRequest } from "@/lib/aiAgent/engine";
import { KnownChat } from "@/lib/knownChats";
import { Badge, Card, inputClass, Notice, primaryButton } from "@/components/admin/aiAgent/ui";

export function TestConsole({ businessSlug, chats }: { businessSlug: string; chats: KnownChat[] }) {
  const [text, setText] = useState("");
  const [chatId, setChatId] = useState("");
  const [result, setResult] = useState<SimulationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await aiAgentApi.simulate(businessSlug, text, chatId || null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  const r = result;
  return (
    <Card title="Test console" subtitle="Runs the real decision engine as a dry run. Nothing is saved or sent, whatever the settings.">
      <div className="flex flex-col gap-3">
        <select value={chatId} onChange={(e) => setChatId(e.target.value)} className={inputClass}>
          <option value="">No customer context (generic test)</option>
          {chats
            .filter((c) => !c.isGroup)
            .map((c) => (
              <option key={c.chatId} value={c.chatId}>
                As {c.contactName || c.contactNumber || c.chatId}
              </option>
            ))}
        </select>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Type a customer message…" className={inputClass} />
        <div>
          <button type="button" disabled={busy || !text.trim()} onClick={run} className={primaryButton}>
            {busy ? "Thinking…" : "Show proposed reply"}
          </button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}

        {r && (
          <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              Decision: <Badge value={r.decision} />
              <span className="text-xs text-zinc-500">{r.reasons.join(", ")}</span>
            </p>
            {!r.gate.pass && (
              <Notice tone="warn">
                Live, this message would stop at the gate: {r.gate.decision} ({r.gate.reasons.join(", ")}). The decision above shows what the agent would do
                if it got through.
              </Notice>
            )}
            {r.reply && (
              <p className="whitespace-pre-wrap rounded bg-emerald-50 px-2 py-1 text-emerald-900">
                <span className="block text-xs text-emerald-700">Would send to customer:</span>
                {r.reply}
              </p>
            )}
            {!r.reply && r.draftReply && (
              <p className="whitespace-pre-wrap rounded bg-amber-50 px-2 py-1 text-amber-900">
                <span className="block text-xs text-amber-700">Suggested reply for staff (not auto-sent):</span>
                {r.draftReply}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              Confidence {r.confidence === null ? "—" : `${Math.round(r.confidence * 100)}%`} · required{" "}
              {/* Infinity (autonomy 0) serializes to null over JSON. */}
              {r.requiredConfidence === null ? "never auto-send (autonomy 0)" : `${Math.round(r.requiredConfidence * 100)}%`}
              {r.safeguards.length > 0 && ` · safeguards: ${r.safeguards.join(", ")}`}
            </p>
            {r.knowledgeUsed.length > 0 && <p className="text-xs text-zinc-500">Knowledge cited: {r.knowledgeUsed.map((k) => k.title).join(", ")}</p>}
            {r.orderRequest && (
              <p className="text-xs text-zinc-500">
                Order request{r.orderComplete ? " (complete → staff approval)" : ""}: {formatOrderRequest(r.orderRequest) ?? "(collecting)"}
              </p>
            )}
            {r.modelError && <p className="text-xs text-red-600">Model: {r.modelError}</p>}
            <p className="text-xs text-zinc-400">
              With current settings ({r.mode ?? "no settings"}): {r.wouldSendToCustomer ? "would message the customer" : "would not message the customer"};{" "}
              {r.wouldNotifyStaff ? "would notify the staff group" : "would not notify the staff group"}.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
