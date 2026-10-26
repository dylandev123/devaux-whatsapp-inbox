"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, ApprovalItemView } from "@/lib/aiAgent/client";
import { startVisiblePolling } from "@/lib/visiblePolling";
import { Badge, dangerButton, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

type Busy = { id: string; action: string } | null;

function Row({ item, businessSlug, onChanged }: { item: ApprovalItemView; businessSlug: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.draft?.body ?? "");
  const [info, setInfo] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  // A "customer-ready" draft whose approved knowledge changed afterwards is refused until the facts are checked too.
  const [needsCheck, setNeedsCheck] = useState(false);
  const draft = item.draft;
  const mustCheck = Boolean(draft && (!draft.ready || needsCheck));

  async function act(action: "approve" | "edit" | "reject" | "moreinfo", extra: { confirm?: boolean; text?: string; reason?: string } = {}) {
    setBusy({ id: item.escalationId, action });
    setMessage(null);
    try {
      const res = await aiAgentApi.actOnApproval(businessSlug, item.escalationId, action, { draftId: draft?.id, ...extra });
      if (action === "moreinfo") setInfo(res.text ?? "");
      else {
        setMessage({ tone: "ok", text: res.message });
        setEditing(false);
        onChanged();
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Something went wrong";
      if (/not backed by approved knowledge/.test(text)) setNeedsCheck(true);
      setMessage({ tone: "error", text });
      // The draft may have been replaced while this row was open: reload so the admin sees the current one.
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  const who = item.customerName || item.contactNumber || "Unnamed customer";
  const working = busy !== null;
  return (
    <li className="rounded-md border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-zinc-900">#{item.refCode}</span>
        <span className="text-zinc-700">{who}</span>
        <Badge value={item.priority} />
        <span className="text-xs text-zinc-400">{formatWhen(item.updatedAt)}</span>
        {item.stale && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Customer wrote again — this draft is out of date</span>}
      </div>
      <p className="mt-1 text-sm text-zinc-700">
        <span className="text-zinc-500">Customer:</span> “{item.latestMessage || "(no text)"}”
        {item.messageCount > 1 && <span className="text-xs text-zinc-400"> (+{item.messageCount - 1} earlier)</span>}
      </p>

      {!draft && <p className="mt-2 text-sm text-zinc-500">The AI has no suggestion for this one. Use Edit to write the reply.</p>}
      {draft && !editing && (
        <div className="mt-2 rounded bg-zinc-50 p-2 text-sm text-zinc-800">
          <p className="text-xs text-zinc-500">
            AI suggests (v{draft.version}
            {draft.source === "staff_edit" ? ", edited" : ""}) — exactly what will be sent:
          </p>
          <p className="mt-0.5 whitespace-pre-wrap">“{draft.body}”</p>
          {!draft.ready && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
              {draft.notes.slice(0, 3).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={inputClass} />
          <div className="flex gap-2">
            <button type="button" className={primaryButton} disabled={working || !text.trim()} onClick={() => act("edit", { text })}>
              Save as new draft
            </button>
            <button type="button" className={secondaryButton} disabled={working} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="text-xs text-zinc-500">Saving does not send. Approve the new draft afterwards.</p>
        </div>
      )}

      {mustCheck && !editing && (
        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I have checked these facts are true
        </label>
      )}

      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {draft && (
            <button
              type="button"
              className={primaryButton}
              disabled={working || item.stale || (mustCheck && !checked)}
              title={item.stale ? "The customer wrote after this draft. Edit it first." : undefined}
              onClick={() => {
                if (window.confirm(`Send this reply to ${who}?\n\n“${draft.body}”`)) void act("approve", { confirm: mustCheck });
              }}
            >
              {busy?.action === "approve" ? "Approving…" : "Approve"}
            </button>
          )}
          <button type="button" className={secondaryButton} disabled={working} onClick={() => setEditing(true)}>
            Edit
          </button>
          {draft && (
            <button
              type="button"
              className={dangerButton}
              disabled={working}
              onClick={() => {
                if (window.confirm("Reject this draft? Nothing will be sent.")) void act("reject");
              }}
            >
              Reject
            </button>
          )}
          <button type="button" className={secondaryButton} disabled={working} onClick={() => (info === null ? void act("moreinfo") : setInfo(null))}>
            {info === null ? "More info" : "Hide info"}
          </button>
        </div>
      )}
      {info !== null && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs text-zinc-700">{info}</pre>}
      {message && <div className="mt-2"><Notice tone={message.tone}>{message.text}</Notice></div>}
    </li>
  );
}

/**
 * The compact pending-approvals queue, shown above the tabs in Approval Pilot. One request at a time (no bulk actions).
 * Approve / Edit / Reject / More info all go through the same server-side Approval Pilot policy as the WhatsApp commands.
 */
export function ApprovalsPanel({ businessSlug, mode }: { businessSlug: string; mode: string }) {
  const [items, setItems] = useState<ApprovalItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await aiAgentApi.listApprovals(businessSlug);
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    }
  }, [businessSlug]);

  useEffect(() => {
    if (mode !== "approval_pilot") return;
    void load();
    return startVisiblePolling(() => void load(), 15_000);
  }, [load, mode]);

  if (mode !== "approval_pilot") return null;
  return (
    <section className="rounded-lg border border-emerald-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Pending approvals{items ? ` (${items.length})` : ""}</h2>
        <span className="text-xs text-zinc-500">Nothing is sent until you approve each one.</span>
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {items && items.length === 0 && !error && <p className="mt-2 text-sm text-zinc-500">Nothing waiting for you.</p>}
      {items && items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {items.map((item) => (
            <Row key={`${item.escalationId}:${item.draft?.id ?? "none"}`} item={item} businessSlug={businessSlug} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </section>
  );
}
