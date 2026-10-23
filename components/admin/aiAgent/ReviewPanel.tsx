"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, LearningCandidate, OrderRequestView } from "@/lib/aiAgent/client";
import { formatOrderRequest, KNOWLEDGE_KINDS, KnowledgeKind } from "@/lib/aiAgent/engine";
import { Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

function CandidateItem({ businessSlug, c, onDone }: { businessSlug: string; c: LearningCandidate; onDone: () => void }) {
  const [kind, setKind] = useState<KnowledgeKind>("faq");
  const [title, setTitle] = useState((c.question ?? "").split("\n---\n").pop()?.slice(0, 80) ?? "");
  const [content, setContent] = useState(c.staff_answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await aiAgentApi.reviewLearning(businessSlug, c.id, action, action === "approve" ? { kind, title, content } : {});
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-3 py-3 text-sm">
      <p className="text-xs text-zinc-500">Customer asked ({formatWhen(c.created_at)}):</p>
      <p className="whitespace-pre-wrap text-zinc-800">{c.question}</p>
      {c.status !== "pending" ? (
        <p className="mt-1 text-xs text-zinc-500">
          {c.status}: {c.staff_answer}
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
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
            <button type="button" disabled={busy || !title.trim() || !content.trim()} className={primaryButton} onClick={() => review("approve")}>
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

      <Card title="Learning from staff corrections" subtitle="Staff answers become permanent knowledge only when an admin approves them here.">
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
