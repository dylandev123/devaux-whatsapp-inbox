"use client";

import { useCallback, useEffect, useState } from "react";
import { ActivityDiagnostics, aiAgentApi, AuditView, EventView, OutboxView } from "@/lib/aiAgent/client";
import { failureReason, OutboxState, outboxState, UNRESOLVED_AFTER_MS } from "@/lib/aiAgent/outboxStatus";
import { Badge, Card, formatWhen, Notice } from "@/components/admin/aiAgent/ui";

// Plain-language meaning of the gate/diagnostic reason codes shown under each decision.
const REASON_HELP: Record<string, string> = {
  contact_not_permitted: "Contact not allowed (not on the allowed list)",
  contact_excluded: "Contact is excluded",
  unresolved_lid_identity: "Unresolved @lid identity: WhatsApp gave no phone number, so only a rule on this exact @lid ID can match",
  contact_matched_via_linked_identity: "Allowed via the contact's other verified ID (phone ↔ @lid)",
  agent_echo: "Skipped: the agent's own message echoed back",
  business_mismatch: "Business mismatch",
  agent_disabled: "Agent is switched off for this business",
  human_takeover: "A human has taken over this chat",
  staff_recently_active: "Skipped: staff replied recently",
  group_chat: "Skipped: group chat",
  outbound_message: "Skipped: message sent by the business",
  internal_error: "Processing failed",
};

const STATE_ORDER: OutboxState[] = ["unresolved", "failed", "pending", "dispatched", "blocked", "sent"];

export function ActivityPanel({ businessSlug }: { businessSlug: string }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [outbox, setOutbox] = useState<OutboxView[]>([]);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [auditRows, setAuditRows] = useState<AuditView[]>([]);
  const [diag, setDiag] = useState<ActivityDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await aiAgentApi.listActivity(businessSlug);
      setEvents(data.events);
      setOutbox(data.outbox);
      setLoadedAt(new Date());
      setAuditRows(data.audit);
      setDiag(data.diagnostics ?? null);
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
      {diag && <DiagnosticsCard diag={diag} />}
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
                <p className="mt-0.5 text-xs text-zinc-400">
                  {e.reason_codes.map((c) => (REASON_HELP[c] ? `${REASON_HELP[c]} (${c})` : c)).join(" · ")}
                </p>
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
                {a.action === "bridge.message_failed" && typeof a.details?.error === "string" && (
                  <span className="text-xs text-red-600">{a.details.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

// Where a test message would stop. Flags and counts only; no secrets or message bodies.
function DiagnosticsCard({ diag }: { diag: ActivityDiagnostics }) {
  const lines: { tone: "ok" | "warn" | "error"; text: string }[] = [
    diag.bridgeSecretConfigured
      ? { tone: "ok", text: "App: bridge secret is configured" }
      : { tone: "error", text: "App: AI_AGENT_BRIDGE_SECRET is not set, so every bridge call is rejected (503)" },
    diag.enabled
      ? { tone: "ok", text: `Agent ON · ${diag.mode} mode · contacts: ${diag.contactScope}` }
      : { tone: "warn", text: "Agent is OFF for this business: messages are ignored and nothing is recorded" },
    diag.eventsLast24h > 0
      ? { tone: "ok", text: `${diag.eventsLast24h} message(s) reached the agent in the last 24h (latest ${formatWhen(diag.lastEventAt)})` }
      : { tone: "warn", text: "No message has reached the agent in the last 24h. If you sent a test, the bridge did not forward it: check AGENT_ENABLED, AI_AGENT_URL and AI_AGENT_BRIDGE_SECRET on the bridge, and its '[agent]' log lines." },
  ];
  if (diag.bridgeFailuresLast24h > 0) {
    lines.push({ tone: "error", text: `${diag.bridgeFailuresLast24h} message(s) failed inside the app in the last 24h; see the audit trail below for the error.` });
  }
  if (diag.enabled && diag.contactScope === "selected" && !diag.contacts.some((c) => c.rule === "allow")) {
    lines.push({ tone: "warn", text: "Contacts is 'selected' but nobody is allowed yet." });
  }
  return (
    <Card title="Diagnostics" subtitle="Where a message would stop. Contains no credentials.">
      <div className="flex flex-col gap-1.5">
        {lines.map((l) => (
          <Notice key={l.text} tone={l.tone}>
            {l.text}
          </Notice>
        ))}
        {diag.contacts.length > 0 && (
          <ul className="mt-1 divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
            {diag.contacts.map((c) => (
              <li key={c.chatId} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <Badge value={c.rule === "allow" ? "allowed" : "excluded"} />
                <span className="text-zinc-800">{c.name || (c.phone && !c.isLid ? `+${c.phone}` : c.chatId)}</span>
                <span className="text-xs text-zinc-400">
                  {c.isLid
                    ? c.phone
                      ? `@lid ID · verified phone +${c.phone}`
                      : "@lid ID · phone number unresolved (matches only this exact @lid)"
                    : "phone ID"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
