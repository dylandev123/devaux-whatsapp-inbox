"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, EscalationDelivery, EscalationView, StaffAnswerItemView, StaffAnswerView } from "@/lib/aiAgent/client";
import { formatOrderRequest } from "@/lib/aiAgent/engine";
import { failureReason } from "@/lib/aiAgent/outboxStatus";
import { WITHHOLD_TEXT, type WithholdReason } from "@/lib/aiAgent/staffAnswers";
import { Badge, Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

const NOTICE_SKIPPED: Record<string, string> = {
  no_staff_group: "not sent: no staff group is configured (recorded here only)",
  staff_notices_disabled: "not sent: staff notices are switched off for Observe mode",
};

function noticeStatus(e: EscalationView): { tone: string; text: string } {
  const notices = e.deliveries.filter((d) => d.kind === "staff_notice");
  const latest: EscalationDelivery | undefined = notices[0];
  if (!latest) {
    const reason = e.context?.notice_skipped;
    return { tone: "text-zinc-500", text: reason ? (NOTICE_SKIPPED[reason] ?? `not sent: ${reason}`) : "no notice queued" };
  }
  switch (latest.state) {
    case "sent":
      return { tone: "text-emerald-700", text: `delivered to staff group ${formatWhen(latest.sent_at)}` };
    case "blocked":
      return { tone: "text-zinc-500", text: `not sent on purpose: ${failureReason(latest.error)}` };
    case "failed":
      return { tone: "text-red-600", text: `failed: ${latest.error ?? "no reason given"}` };
    case "unresolved":
      return { tone: "text-amber-700", text: "outcome unknown: no ack from the bridge (check the staff group)" };
    default:
      return { tone: "text-zinc-500", text: latest.state };
  }
}

const DISPOSITION_LABEL: Record<StaffAnswerItemView["disposition"], string> = {
  candidate: "suggested for knowledge (awaiting approval)",
  candidate_conflict: "suggested for knowledge — overlaps an approved entry",
  already_known: "already in knowledge",
  temporary: "used for now only (expires)",
  customer_memory: "saved to this customer's record only",
  recorded_only: "recorded here only",
  skipped: "not used",
};

function StaffAnswerLine({ a, businessSlug, onChanged }: { a: StaffAnswerView; businessSlug: string; onChanged: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  async function retry() {
    if (!window.confirm("Run this staff answer again? It is only allowed when no customer message may already have been sent for it.")) return;
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await aiAgentApi.retryStaffAnswer(businessSlug, a.id);
      setRetryMessage({ tone: "ok", text: res.message });
      onChanged();
    } catch (err) {
      setRetryMessage({ tone: "error", text: err instanceof Error ? err.message : "Retry failed" });
    } finally {
      setRetrying(false);
    }
  }
  const withheld = a.customer_action === "withheld";
  const reason = a.withheld_reason ? (WITHHOLD_TEXT[a.withheld_reason as WithholdReason] ?? a.withheld_reason) : null;
  return (
    <div className="mt-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700">
      <p>
        <span className="font-medium">{a.command === "send" ? "Staff approved sending" : "Staff answered"}</span> ({a.source === "whatsapp" ? "WhatsApp" : "dashboard"},{" "}
        {formatWhen(a.staff_message_at ?? a.created_at)}): {a.body}
      </p>
      {a.draft && <p className="mt-0.5 text-zinc-600">Customer reply: “{a.draft}”</p>}
      <p className={withheld ? "text-amber-700" : "text-emerald-700"}>
        {a.customer_action === "sent" ? "Sent to the customer" : withheld ? `Not sent${reason ? `: ${reason}` : ""}` : "In progress"}
        {a.state === "failed" && " · processing failed"}
      </p>
      {a.state === "failed" && (
        <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700">
          <p>Processing failed{a.error ? `: ${a.error}` : ""}. Staff were told in the group (Assisted mode). Nothing is retried automatically.</p>
          {a.source === "whatsapp" && (
            <button type="button" disabled={retrying} className={`${secondaryButton} mt-1`} onClick={retry}>
              {retrying ? "Retrying…" : "Retry (only if no customer message was sent)"}
            </button>
          )}
          {retryMessage && <p className={retryMessage.tone === "ok" ? "text-emerald-700" : "text-red-700"}>{retryMessage.text}</p>}
        </div>
      )}
      {a.items.map((it, i) => (
        <p key={i} className="text-zinc-500">
          {it.category.replace("_", " ")}: {it.content} — {DISPOSITION_LABEL[it.disposition]}
        </p>
      ))}
    </div>
  );
}

function EscalationItem({
  businessSlug,
  e,
  observe,
  onChanged,
}: {
  businessSlug: string;
  e: EscalationView;
  observe: boolean;
  onChanged: () => void;
}) {
  const notice = noticeStatus(e);
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
      const res = await aiAgentApi.actOnEscalation(businessSlug, e.id, action, body, e.updated_at);
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
      {(e.context?.history ?? []).length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-zinc-600">
          {(e.context?.history ?? []).map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      {(e.context?.updates ?? []).length > 0 && (
        <div className="mt-1 text-xs text-blue-800">
          <p className="font-medium">Customer follow-ups since this opened:</p>
          {(e.context?.updates ?? []).map((u, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {formatWhen(u.at)}: {u.text}
            </p>
          ))}
        </div>
      )}
      <p className={`mt-1 text-xs ${notice.tone}`}>
        Staff notice: {notice.text}
        {e.deliveries.filter((d) => d.kind === "staff_notice").length > 1 &&
          ` · ${e.deliveries.filter((d) => d.kind === "staff_notice").length - 1} update${e.deliveries.filter((d) => d.kind === "staff_notice").length === 2 ? "" : "s"} posted`}
      </p>
      {e.context?.reopened_at && (
        <p className="mt-1 text-xs text-amber-700">Reopened {formatWhen(e.context.reopened_at)}: the customer changed the order after staff replied.</p>
      )}
      {e.context?.cancelled && <p className="mt-1 text-xs font-medium text-red-600">Customer asked to cancel.</p>}
      {e.staff_answer && (
        <p className="mt-1 text-xs text-emerald-700">
          Staff answer ({e.answered_via}, {formatWhen(e.answered_at)}): {e.staff_answer}
          {e.context?.answer_not_relayed && (
            <span className="ml-1 rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">recorded for review — not sent to the customer</span>
          )}
        </p>
      )}
      {(e.answers ?? []).map((a) => (
        <StaffAnswerLine key={a.id} a={a} businessSlug={businessSlug} onChanged={onChanged} />
      ))}
      {(e.context?.notes ?? []).map((n, i) => (
        <p key={i} className="mt-1 text-xs text-zinc-500">
          Note {formatWhen(n.at)}: {n.text}
        </p>
      ))}

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea value={answer} onChange={(ev) => setAnswer(ev.target.value)} rows={2} placeholder={observe ? "Staff answer to record (never sent to the customer)…" : "Exact text to send to the customer…"} className={inputClass} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !answer.trim()} className={primaryButton} onClick={() => act("send", answer, observe ? undefined : "Send this exact text to the customer?")}>
              {observe ? "Record answer (not sent)" : "Send to customer"}
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

export function EscalationsPanel({ businessSlug, observe = false }: { businessSlug: string; observe?: boolean }) {
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
      subtitle={
        observe
          ? "Observe mode: staff answers are recorded for review and never sent to customers."
          : "Staff answer in the WhatsApp group by replying to the notice or a draft, or by including its #E- code. A reply is information: a drafted customer message is posted back and sent only when staff reply \"send\" (or !send). \"Send to customer\" here sends the exact text."
      }
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
              <EscalationItem key={e.id} businessSlug={businessSlug} e={e} observe={observe} onChanged={load} />
            ))}
          </ul>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
