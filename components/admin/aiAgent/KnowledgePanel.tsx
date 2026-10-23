"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, KnowledgeEntry } from "@/lib/aiAgent/client";
import { KNOWLEDGE_KINDS, KnowledgeKind } from "@/lib/aiAgent/engine";
import { Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

interface Draft {
  id: string | null;
  kind: KnowledgeKind;
  title: string;
  content: string;
  expiresAt: string;
  approve: boolean;
}

const EMPTY: Draft = { id: null, kind: "faq", title: "", content: "", expiresAt: "", approve: true };

const STATUS_STYLES: Record<KnowledgeEntry["status"], string> = {
  approved: "bg-emerald-50 text-emerald-700",
  draft: "bg-amber-50 text-amber-800",
  archived: "bg-zinc-100 text-zinc-500",
};

function isExpired(entry: KnowledgeEntry): boolean {
  return Boolean(entry.expires_at && new Date(entry.expires_at).getTime() <= Date.now());
}

export function KnowledgePanel({ businessSlug }: { businessSlug: string }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await aiAgentApi.listKnowledge(businessSlug)).entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const expiresAt = draft.expiresAt ? new Date(`${draft.expiresAt}T23:59:59`).toISOString() : null;
    const ok = await run(async () => {
      if (draft.id) {
        await aiAgentApi.updateKnowledge(businessSlug, draft.id, "update", {
          kind: draft.kind,
          title: draft.title,
          content: draft.content,
          expiresAt,
        });
        if (draft.approve) await aiAgentApi.updateKnowledge(businessSlug, draft.id, "approve");
      } else {
        await aiAgentApi.createKnowledge(businessSlug, { kind: draft.kind, title: draft.title, content: draft.content, expiresAt, approve: draft.approve });
      }
    });
    if (ok) setDraft(EMPTY);
  }

  const visible = entries.filter((e) => showArchived || e.status !== "archived");

  return (
    <Card
      title="Business knowledge"
      subtitle="The only facts the agent may state. Only approved, unexpired entries are used; editing an entry sends it back to draft."
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-2 rounded-md border border-zinc-200 p-3 sm:grid-cols-3">
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as KnowledgeKind })} className={inputClass}>
            {KNOWLEDGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title (e.g. Royal Canin Adult 15kg)" className={`${inputClass} sm:col-span-2`} />
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={3}
            placeholder="Verified fact, exactly as the agent may say it (e.g. Price: EC$245. Delivery Mon–Sat in Castries, EC$15.)"
            className={`${inputClass} sm:col-span-3`}
          />
          <label className="text-xs text-zinc-500">
            Expires (optional)
            <input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} className={inputClass} />
          </label>
          <label className="flex items-center gap-2 self-end text-sm text-zinc-700">
            <input type="checkbox" checked={draft.approve} onChange={(e) => setDraft({ ...draft, approve: e.target.checked })} />
            Verified — approve now
          </label>
          <div className="flex items-end gap-2">
            <button type="button" disabled={busy || !draft.title.trim() || !draft.content.trim()} onClick={submit} className={primaryButton}>
              {draft.id ? "Save changes" : "Add entry"}
            </button>
            {draft.id && (
              <button type="button" onClick={() => setDraft(EMPTY)} className={secondaryButton}>
                Cancel
              </button>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>

        {visible.length === 0 ? (
          <Notice tone="info">No knowledge yet — without approved entries the agent can only ask questions or escalate.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {visible.map((e) => (
              <li key={e.id} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">{e.kind}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLES[e.status]}`}>{e.status}</span>
                  {isExpired(e) && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">expired</span>}
                  <span className="font-medium text-zinc-900">{e.title}</span>
                  <span className="text-xs text-zinc-400">
                    v{e.version} · {e.source === "staff_correction" ? "from staff correction" : e.source} · updated {formatWhen(e.updated_at)}
                    {e.expires_at && ` · expires ${formatWhen(e.expires_at)}`}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-zinc-700">{e.content}</p>
                <div className="mt-1.5 flex gap-3 text-xs">
                  <button
                    type="button"
                    className="cursor-pointer text-zinc-500 hover:text-zinc-900"
                    onClick={() =>
                      setDraft({ id: e.id, kind: e.kind, title: e.title, content: e.content, expiresAt: e.expires_at?.slice(0, 10) ?? "", approve: false })
                    }
                  >
                    Edit
                  </button>
                  {e.status === "draft" && (
                    <button type="button" disabled={busy} className="cursor-pointer text-emerald-700 hover:underline" onClick={() => run(() => aiAgentApi.updateKnowledge(businessSlug, e.id, "approve"))}>
                      Approve
                    </button>
                  )}
                  {e.status !== "archived" ? (
                    <button type="button" disabled={busy} className="cursor-pointer text-zinc-500 hover:text-red-600" onClick={() => run(() => aiAgentApi.updateKnowledge(businessSlug, e.id, "archive"))}>
                      Archive
                    </button>
                  ) : (
                    <button type="button" disabled={busy} className="cursor-pointer text-zinc-500 hover:text-zinc-900" onClick={() => run(() => aiAgentApi.updateKnowledge(businessSlug, e.id, "restore"))}>
                      Restore as draft
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
