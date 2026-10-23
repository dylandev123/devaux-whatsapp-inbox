"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, LearningCandidate, OrderRequestView } from "@/lib/aiAgent/client";
import { formatOrderRequest, KNOWLEDGE_KINDS, KnowledgeKind } from "@/lib/aiAgent/engine";
import { Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

function CandidateItem({ businessSlug, c, onDone }: { businessSlug: string; c: LearningCandidate; onDone: () => void }) {
  const durable = c.category === "durable";
  const [kind, setKind] = useState<KnowledgeKind>(c.suggested_kind ?? "faq");
  const [title, setTitle] = useState(c.suggested_title ?? (c.question ?? "").split("\n---\n").pop()?.slice(0, 80) ?? "");
  const [content, setContent] = useState(c.staff_answer);
  // With an overlapping approved entry the admin must choose; nothing is pre-selected.
  const [resolution, setResolution] = useState<"" | "replace" | "keep_both">("");
  const [replaceId, setReplaceId] = useState(c.conflicts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsChoice = c.conflicts.length > 0;

  async function review(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await aiAgentApi.reviewLearning(
        businessSlug,
        c.id,
        action,
        action === "approve"
          ? {
              kind,
              title,
              content,
              ...(needsChoice && resolution ? { resolution, ...(resolution === "replace" ? { replaceKnowledgeId: replaceId } : {}) } : {}),
            }
          : {}
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        {c.ref_code && <span className="font-mono font-semibold text-zinc-900">#{c.ref_code}</span>}
        <span>{durable ? "Suggested permanent knowledge" : "Staff answer"}</span>
        <span>{formatWhen(c.source_message_at ?? c.created_at)}</span>
      </div>
      {c.source_message && (
        <p className="mt-1 whitespace-pre-wrap rounded bg-zinc-50 px-2 py-1 text-zinc-800">
          <span className="text-xs text-zinc-500">Staff said: </span>
          {c.source_message}
        </p>
      )}
      {c.question && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">Customer asked: {c.question}</p>
      )}
      {c.duplicate_of && (
        <p className="mt-1 text-xs text-zinc-600">Already in the knowledge base as “{c.duplicate_of.title}” — reject this one.</p>
      )}
      {c.status !== "pending" ? (
        <p className="mt-1 text-xs text-zinc-500">
          {c.status}: {c.staff_answer}
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {needsChoice && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-3">
              <p className="font-medium">This overlaps what is already approved — it will not overwrite anything unless you choose to.</p>
              {c.conflicts.map((k) => (
                <p key={k.id} className="mt-1">
                  <span className="font-medium">{k.title}:</span> {k.content}
                  <span className="block text-amber-800">{k.reason}</span>
                </p>
              ))}
              <div className="mt-2 flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input type="radio" name={`res-${c.id}`} checked={resolution === "replace"} onChange={() => setResolution("replace")} />
                  Replace
                  <select value={replaceId} onChange={(e) => setReplaceId(e.target.value)} className="rounded border border-amber-300 bg-white px-1 py-0.5" disabled={resolution !== "replace"}>
                    {c.conflicts.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.title}
                      </option>
                    ))}
                  </select>
                  (the old entry is archived)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name={`res-${c.id}`} checked={resolution === "keep_both"} onChange={() => setResolution("keep_both")} />
                  Keep both entries
                </label>
              </div>
            </div>
          )}
          <select value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)} className={inputClass}>
            {KNOWLEDGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Knowledge title" className={`${inputClass} sm:col-span-2`} />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} className={`${inputClass} sm:col-span-3`} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !title.trim() || !content.trim() || (needsChoice && !resolution)}
              className={primaryButton}
              onClick={() => review("approve")}
            >
              Approve as knowledge
            </button>
            <button type="button" disabled={busy} className={secondaryButton} onClick={() => review("reject")}>
              Reject
            </button>
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

export function ReviewPanel({ businessSlug }: { businessSlug: string }) {
  const [candidates, setCandidates] = useState<LearningCandidate[]>([]);
  const [requests, setRequests] = useState<OrderRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, o] = await Promise.all([aiAgentApi.listLearning(businessSlug), aiAgentApi.listOrderRequests(businessSlug)]);
      setCandidates(l.candidates);
      setRequests(o.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  async function reviewOrder(id: string, action: "approve" | "reject" | "cancel") {
    try {
      await aiAgentApi.reviewOrderRequest(businessSlug, id, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Order requests" subtitle="Collected by the agent and never confirmed to the customer. Approving marks the request reviewed; it sends nothing.">
        {requests.length === 0 ? (
          <Notice tone="info">No order requests.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="text-zinc-900">{formatOrderRequest(r) ?? "(no items yet)"}</p>
                  <p className="text-xs text-zinc-500">
                    {r.contact_number ?? r.chat_id} · {r.status.replace("_", " ")} · {formatWhen(r.updated_at)}
                  </p>
                </div>
                {(r.status === "pending_approval" || r.status === "collecting") && (
                  <span className="flex gap-2">
                    <button type="button" className={primaryButton} onClick={() => reviewOrder(r.id, "approve")}>
                      Approve
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => reviewOrder(r.id, "reject")}>
                      Reject
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Learning from staff answers" subtitle="Only lasting facts (standard prices, hours, policies…) are suggested. Today's stock, one-off deals and customer-specific details are never added here. Nothing becomes knowledge until you approve it.">
        {candidates.length === 0 ? (
          <Notice tone="info">Nothing to review.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {candidates.map((c) => (
              <CandidateItem key={c.id} businessSlug={businessSlug} c={c} onDone={load} />
            ))}
          </ul>
        )}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
