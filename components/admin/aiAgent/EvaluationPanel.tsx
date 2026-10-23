"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi } from "@/lib/aiAgent/client";
import {
  type EvaluationItem,
  type EvaluationResponse,
  KIND_LABEL,
  RATING_LABEL,
  SHADOW_RATINGS,
  type ShadowRating,
  skipReasonText,
} from "@/lib/aiAgent/evaluation";
import { Badge, Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

const GAP_SIGNAL: Record<string, string> = {
  missing_knowledge: "AI could not answer from approved knowledge",
  answer_quality: "Rated Needs improvement / Incorrect",
};
const CATEGORY_LABEL: Record<string, string> = {
  product_enquiry: "Product enquiries",
  unanswered_question: "Questions",
  new_order: "Orders",
  complaint: "Complaints",
  payment_issue: "Payments",
  other: "Other requests",
};
const PILOT_VERDICT: Record<string, string> = {
  correct: "AI was correct",
  missing_information: "AI was missing information",
  factually_wrong: "AI was factually wrong",
  none: "No verdict",
};
const PILOT_OUTCOME: Record<string, string> = {
  approved_as_is: "approved as written",
  approved_after_confirm: "approved after staff confirmed the facts",
  edited: "edited by staff",
  rejected: "rejected",
  replaced_by_staff_text: "staff sent their own wording",
  superseded: "replaced by a newer draft",
};
const VERDICT_CHOICES = ["correct", "missing_information", "factually_wrong"] as const;
const SOURCE_LABEL: Record<string, string> = { inferred: "inferred", staff: "set by staff", admin: "set by an admin" };
const RATING_STYLE: Record<ShadowRating, string> = {
  correct: "border-emerald-600 bg-emerald-50 text-emerald-800",
  needs_improvement: "border-amber-500 bg-amber-50 text-amber-800",
  incorrect: "border-red-500 bg-red-50 text-red-700",
};

export function EvaluationPanel({ businessSlug }: { businessSlug: string }) {
  const [data, setData] = useState<EvaluationResponse | null>(null);
  const [kind, setKind] = useState("");
  const [rating, setRating] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await aiAgentApi.getEvaluation(businessSlug, { kind: kind || undefined, rating: rating || undefined }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load evaluation");
    }
  }, [businessSlug, kind, rating]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleCapture(enabled: boolean) {
    setBusy("capture");
    try {
      await aiAgentApi.setEvaluationCapture(businessSlug, enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function simulate(eventId: string) {
    setBusy(eventId);
    setMessage(null);
    try {
      const res = await aiAgentApi.simulateTurn(businessSlug, eventId);
      setMessage(
        res.status === "skipped"
          ? skipReasonText(res.reason)
          : res.status === "historical_exists"
            ? "This turn already has a result captured at the time; no model call was made."
            : res.status === "cached"
              ? "Already simulated with the current knowledge; no model call was made."
              : "Simulation stored (labelled as a simulation). Nothing was sent."
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p className="text-sm text-zinc-500">Loading…</p>;
  if (!data.available) {
    return <Notice tone="warn">AI evaluation needs the 20261029000000_ai_agent_evaluation.sql migration. Run it in the Supabase SQL editor first.</Notice>;
  }
  const { summary } = data;
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="AI evaluation"
        subtitle="What the AI would have said on its own, next to what staff and the business actually did. Shadow answers are never sent to customers or to the staff group."
      >
        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-800">
          <input
            type="checkbox"
            checked={data.captureEnabled}
            disabled={busy === "capture"}
            onChange={(e) => toggleCapture(e.target.checked)}
          />
          Capture the AI&apos;s independent answer for customer turns staff handle (Observe, Staff First, Manual Only)
        </label>
        <p className="mt-1 text-xs text-zinc-500">
          Costs no extra model calls: it keeps the answer the AI already produced for the turn. Turns the AI answers itself, acknowledgements, duplicates,
          injection attempts and turns staff already own are not captured. Customer text is kept {data.retentionDays} days, and is deleted with
          &ldquo;Forget customer&rdquo; (with logs).
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <Stat label="Results" value={String(summary.total)} hint={`${summary.historical} at the time · ${summary.simulations} simulated`} />
          <Stat label="Rated" value={String(summary.rated)} hint={`${summary.correct} correct · ${summary.needsImprovement} needs improvement · ${summary.incorrect} incorrect`} />
          <Stat label="Rated correct" value={pct(summary.correctRate)} hint="of rated answers" />
          <Stat label="AI would answer" value={pct(summary.wouldAnswerRate)} hint="without staff, of all results" />
          <Stat
            label="Tokens"
            value={`${summary.tokens.input + summary.tokens.output}`}
            hint={`${summary.tokens.input} in · ${summary.tokens.output} out (${summary.tokens.withUsage} results)`}
          />
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="info">{message}</Notice>}

      {data.pilotReviews.length > 0 && (
        <Card
          title="Approval Pilot reviews"
          subtitle="The AI's draft exactly as staff saw it, next to what they approved or sent instead, and the facts they taught. Snapshots are never rewritten."
        >
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Stat label="Reviewed" value={String(data.pilotSummary.total)} hint={`${data.pilotSummary.undecided} waiting for staff`} />
            <Stat label="AI was correct" value={String(data.pilotSummary.correct)} hint="sent unchanged" />
            <Stat label="Missing information" value={String(data.pilotSummary.missingInformation)} hint="staff added facts" />
            <Stat label="Factually wrong" value={String(data.pilotSummary.factuallyWrong)} hint="staff changed facts" />
            <Stat label="Edited / rejected" value={`${data.pilotSummary.edited} / ${data.pilotSummary.rejected}`} hint={`${data.pilotSummary.unjudged} without a verdict`} />
          </div>
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
            {data.pilotReviews.slice(0, 30).map((r) => (
              <PilotReviewRow key={r.escalationId} r={r} businessSlug={businessSlug} onChanged={load} onMessage={setMessage} />
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Recurring gaps and opportunities"
        subtitle="Patterns in the results. Suggestions only: nothing is added, approved or changed automatically. Add or approve knowledge in the Knowledge and Review tabs."
      >
        {data.gaps.length === 0 ? (
          <Notice tone="info">No pattern has repeated yet (needs 2 or more similar results).</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
            {data.gaps.map((g) => (
              <li key={`${g.category}-${g.signal}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900">{CATEGORY_LABEL[g.category] ?? g.category}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700">×{g.count}</span>
                  <span className="text-xs text-zinc-500">{GAP_SIGNAL[g.signal]}</span>
                  {g.simulationCount > 0 && <span className="text-xs text-zinc-400">({g.simulationCount} simulated)</span>}
                </div>
                <ul className="mt-1 list-disc pl-5 text-xs text-zinc-600">
                  {g.examples.map((q) => (
                    <li key={q}>“{q}”</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Results"
        subtitle="Newest first. “Captured at the time” used the knowledge, memory and context of that moment. A simulation was re-run later with current knowledge."
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <select className={`${inputClass} !w-auto`} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All results</option>
            <option value="historical">Captured at the time</option>
            <option value="simulation">Simulations</option>
          </select>
          <select className={`${inputClass} !w-auto`} value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">Any rating</option>
            <option value="unrated">Not rated yet</option>
            {SHADOW_RATINGS.map((r) => (
              <option key={r} value={r}>
                {RATING_LABEL[r]}
              </option>
            ))}
          </select>
          <button type="button" onClick={load} className={secondaryButton}>
            Refresh
          </button>
        </div>
        {data.items.length === 0 ? (
          <Notice tone="info">
            {data.captureEnabled
              ? "No results yet. They appear as customers write and staff handle the turn."
              : "Capture is off, so nothing is being recorded. Switch it on above, or simulate a past turn below."}
          </Notice>
        ) : (
          <ul className="flex flex-col gap-4">
            {data.items.map((item) => (
              <ResultCard key={item.id} item={item} businessSlug={businessSlug} onSaved={load} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Simulate a past turn"
        subtitle={`Admin only. Re-runs the real decision engine on a past customer message with TODAY's approved knowledge and stores it as a simulation (one model call, ${data.simulationsLastHour}/${data.simulationLimitPerHour} used this hour). Nothing is sent.`}
      >
        {data.candidates.length === 0 ? (
          <Notice tone="info">No recent customer turns without a result.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
            {data.candidates.map((c) => (
              <li key={c.eventId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-zinc-800">“{c.excerpt}”</p>
                  <p className="text-xs text-zinc-400">
                    {formatWhen(c.createdAt)} · {c.chatId} · actual: {c.decision ?? "—"}
                  </p>
                </div>
                <button type="button" disabled={busy !== null} onClick={() => simulate(c.eventId)} className={secondaryButton}>
                  {busy === c.eventId ? "Simulating…" : "Simulate"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-900">{value}</p>
      {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
    </div>
  );
}

function Block({ title, tone = "plain", children }: { title: string; tone?: "plain" | "ai"; children: React.ReactNode }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${tone === "ai" ? "border-violet-200 bg-violet-50/50" : "border-zinc-200"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      <div className="mt-1 text-sm text-zinc-800">{children}</div>
    </div>
  );
}

const none = <span className="text-zinc-400">—</span>;

function ResultCard({ item, businessSlug, onSaved }: { item: EvaluationItem; businessSlug: string; onSaved: () => void }) {
  const [choice, setChoice] = useState<ShadowRating | null>(item.rating);
  const [feedback, setFeedback] = useState(item.feedback ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = choice !== item.rating || feedback.trim() !== (item.feedback ?? "");
  const simulation = item.kind === "simulation";
  const p = item.provenance;
  const text = item.shadow.reply?.trim() || item.shadow.draftReply?.trim() || null;

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await aiAgentApi.rateEvaluation(businessSlug, item.id, choice, choice ? feedback.trim() || null : null);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-zinc-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${simulation ? "bg-amber-100 text-amber-800" : "bg-violet-100 text-violet-800"}`}
        >
          {KIND_LABEL[item.kind]}
        </span>
        {item.actual?.escalation && <span className="text-xs text-zinc-500">{item.actual.escalation.refCode}</span>}
        <span className="text-xs text-zinc-400">
          {item.customerLabel ?? item.chatId} · turn {formatWhen(item.turnAt ?? item.capturedAt)}
        </span>
      </div>
      {simulation && (
        <p className="mt-1 text-xs text-amber-800">
          Simulation: re-run on {formatWhen(item.capturedAt)} with the knowledge approved then
          {p.knowledgeChangedSinceTurn > 0 ? ` (${p.knowledgeChangedSinceTurn} entr${p.knowledgeChangedSinceTurn === 1 ? "y" : "ies"} changed since the original turn, so this may differ from what the AI could have known)` : ""}. It is not what the AI
          said at the time.
        </p>
      )}

      <p className="mt-2 text-sm font-medium text-zinc-900">“{item.customerQuestion ?? "(text no longer stored)"}”</p>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Block title="Independent AI draft (not sent)" tone="ai">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge value={String(item.shadow.decision)} />
            {item.shadow.confidence !== null && (
              <span className="text-xs text-zinc-500">
                confidence {Math.round(item.shadow.confidence * 100)}%
                {item.shadow.requiredConfidence !== null && ` (needs ${Math.round(item.shadow.requiredConfidence * 100)}%)`}
              </span>
            )}
          </div>
          {text ? <p className="whitespace-pre-wrap">{text}</p> : none}
          {item.shadow.decision === "ESCALATE" && (
            <p className="mt-1 text-xs text-zinc-500">
              Escalated because: {item.shadow.escalationReason ?? item.shadow.reasons.join(", ") ?? "—"}
              {item.shadow.escalationReason && item.shadow.reasons.length > 0 && ` (${item.shadow.reasons.join(", ")})`}
            </p>
          )}
        </Block>
        <Block title="Staff answer">{item.staffAnswer?.text ? <p className="whitespace-pre-wrap">{item.staffAnswer.text}</p> : none}</Block>
        <Block title="Staff-assisted draft (what staff saw)">
          {item.assistedDraft?.text ? (
            <>
              <p className="whitespace-pre-wrap">{item.assistedDraft.text}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {item.assistedDraft.customerAction === "sent" ? "Queued for the customer" : item.assistedDraft.customerAction === "withheld" ? `Not sent: ${item.assistedDraft.withheldReason ?? "withheld"}` : ""}
              </p>
            </>
          ) : (
            none
          )}
        </Block>
        <Block title="What actually happened">
          <div className="flex flex-wrap items-center gap-2">
            {item.actual ? <Badge value={item.actual.decision} /> : none}
            {item.actual?.mode && <span className="text-xs text-zinc-500">{item.actual.mode}</span>}
            {item.actual?.escalation && <span className="text-xs text-zinc-500">escalation {item.actual.escalation.status}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
            <span>Staff notice: {item.delivery.staffNotice ? <Badge value={item.delivery.staffNotice} /> : none}</span>
            <span>Draft to staff: {item.delivery.staffDraft ? <Badge value={item.delivery.staffDraft} /> : none}</span>
            <span>
              Customer: {item.delivery.customer ? <><Badge value={item.delivery.customer.state} /> <span className="text-zinc-400">{item.delivery.customer.kind.replace("_", " ")}</span></> : none}
            </span>
          </div>
        </Block>
      </div>

      <p className="mt-2 text-[11px] text-zinc-400">
        {p.model ?? "model unknown"} · {formatWhen(item.capturedAt)} · knowledge {p.knowledgeVersion ?? "—"} ({p.knowledgeCount ?? 0} entries
        {p.knowledgeUsed.length > 0 && `; used: ${p.knowledgeUsed.map((k) => k.title ?? k.id.slice(0, 8)).join(", ")}`}) · memory{" "}
        {p.memoryUsed === null ? "—" : p.memoryUsed ? "included" : "none"} · tokens{" "}
        {p.inputTokens === null && p.outputTokens === null ? "—" : `${p.inputTokens ?? "?"} in / ${p.outputTokens ?? "?"} out${p.tokensEstimated ? " (estimated)" : ""}`}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {SHADOW_RATINGS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={choice === r}
            onClick={() => setChoice(choice === r ? null : r)}
            className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium ${choice === r ? RATING_STYLE[r] : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"}`}
          >
            {RATING_LABEL[r]}
          </button>
        ))}
      </div>
      {choice && (
        <textarea
          className={`${inputClass} mt-2`}
          rows={2}
          maxLength={1000}
          placeholder="Optional feedback: what was right or wrong, what the AI should have known"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
      {(dirty || err) && (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={saving || !dirty} onClick={save} className={primaryButton}>
            {saving ? "Saving…" : choice ? "Save rating" : "Clear rating"}
          </button>
          {err && <span className="text-xs text-red-600">{err}</span>}
        </div>
      )}
    </li>
  );
}

type PilotReviewT = EvaluationResponse["pilotReviews"][number];

function PilotReviewRow({ r, businessSlug, onChanged, onMessage }: { r: PilotReviewT; businessSlug: string; onChanged: () => void; onMessage: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<(typeof VERDICT_CHOICES)[number]>(r.verdict ?? "correct");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"verdict" | "again" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function saveVerdict() {
    setBusy("verdict");
    setErr(null);
    try {
      await aiAgentApi.overridePilotVerdict(businessSlug, r.escalationId, verdict, reason.trim());
      setOpen(false);
      setReason("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function testAgain() {
    setBusy("again");
    setErr(null);
    onMessage(null);
    try {
      const res = await aiAgentApi.testAgain(businessSlug, r.escalationId);
      onMessage(
        res.status === "skipped"
          ? skipReasonText(res.reason)
          : res.status === "cached"
            ? "Already tested with the current knowledge; no model call was made."
            : "Simulation stored with today's approved knowledge. Nothing was sent and the historical draft is unchanged."
      );
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900">#{r.refCode ?? "—"}</span>
        {r.customerLabel && <span className="text-xs text-zinc-500">{r.customerLabel}</span>}
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700">{PILOT_VERDICT[r.verdict ?? "none"]}</span>
        {r.outcome && <span className="text-xs text-zinc-500">{PILOT_OUTCOME[r.outcome] ?? r.outcome}</span>}
        {r.verdictSource && r.verdictSource !== "staff" && <span className="text-xs text-zinc-400">({SOURCE_LABEL[r.verdictSource]})</span>}
      </div>
      {r.customerQuestion && <p className="mt-1 text-xs text-zinc-500">Customer: “{r.customerQuestion.slice(0, 200)}”</p>}
      {r.contentPurged && <p className="mt-1 text-xs text-zinc-500">Draft wording was deleted after the 90-day retention period. Only the outcome and verdict are kept.</p>}
      <div className="mt-1 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <p className="rounded bg-zinc-50 p-2 text-zinc-700">
          <span className="font-medium">Historical — AI draft as staff saw it{r.aiDraft.ready ? "" : " (needed confirming)"}:</span> {r.contentPurged ? "(deleted)" : r.aiDraft.text}
        </p>
        <p className="rounded bg-emerald-50 p-2 text-zinc-700">
          <span className="font-medium">{r.final ? (r.final.how === "approved" ? "Approved reply:" : "Staff sent instead:") : "Final:"}</span>{" "}
          {r.final ? (r.contentPurged ? "(deleted)" : r.final.text) : "not decided yet"}
        </p>
      </div>
      {r.simulation && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <span className="font-medium">Simulation — not what staff saw or the customer got</span> (re-run {formatWhen(r.simulation.at)} with today&apos;s approved knowledge
          {r.simulation.knowledgeChangedSinceDraft ? "; the knowledge differs from when the historical draft was written" : "; same knowledge as the historical draft"}). AI would{" "}
          {r.simulation.decision === "REPLY" ? "reply" : r.simulation.decision === "ASK" ? "ask" : "escalate"}: {r.simulation.reply ?? "(no reply text)"}
        </p>
      )}
      {r.verdictNote && <p className="mt-1 text-xs text-zinc-500">Staff note: {r.verdictNote}</p>}
      {r.gaps.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-zinc-600">
          {r.gaps.map((g) => (
            <li key={`${g.code}-${g.fact}`}>
              Knowledge gap{g.code ? ` ${g.code}` : ""} ({g.status}): {g.fact}
            </li>
          ))}
        </ul>
      )}
      {r.verdictHistory.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-zinc-500">
          {r.verdictHistory.map((h) => (
            <li key={h.at}>
              {formatWhen(h.at)}: verdict {h.from ? PILOT_VERDICT[h.from] : "none"} → {PILOT_VERDICT[h.to]} — “{h.reason}”
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={testAgain} className={secondaryButton}>
          {busy === "again" ? "Testing…" : "Test again with current knowledge"}
        </button>
        {r.outcome && r.outcome !== "superseded" && (
          <button type="button" onClick={() => setOpen(!open)} className={secondaryButton}>
            Override verdict
          </button>
        )}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-zinc-200 p-3">
          <select className={`${inputClass} !w-auto`} value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
            {VERDICT_CHOICES.map((v) => (
              <option key={v} value={v}>
                {PILOT_VERDICT[v]}
              </option>
            ))}
          </select>
          <textarea className={inputClass} rows={2} maxLength={500} placeholder="Reason (required, kept in the history)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div>
            <button type="button" disabled={busy !== null || reason.trim().length < 3} onClick={saveVerdict} className={primaryButton}>
              {busy === "verdict" ? "Saving…" : "Save override"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
