"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  googleDocsApi,
  type GoogleDocsAccess,
  type GoogleDocsDashboard,
  type GoogleDocsImportPreview,
  type GoogleDocsProblem,
  type GoogleDocsSyncResult,
} from "@/lib/aiAgent/client";
import { FIELD_LABELS, formatOrderLine, normalizeFormat, SEPARATOR_PRESETS, withTag, type FormatConfig } from "@/lib/aiAgent/gdocFormat";
import { Badge, Card, dangerButton, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

type Ready = Extract<GoogleDocsDashboard, { setupPending: false }>;
type Settings = Ready["settings"];

const HEALTH_TEXT: Record<Settings["health"], string> = {
  ok: "Working",
  needs_reconnect: "Google needs to be reconnected",
  no_access: "No edit access to the document",
  doc_not_found: "Document not found",
  insufficient_scope: "Google permission missing — reconnect",
  section_problem: "AI section needs attention",
  error: "Last sync failed",
};

const FINISHED_OPTIONS = [
  { value: "mark", label: "Keep the line, label it and cross it out" },
  { value: "leave", label: "Leave the line exactly as it is" },
  { value: "remove", label: "Remove the line" },
] as const;

const describeSync = (r: GoogleDocsSyncResult): string => {
  if (r.status === "busy") return "Another sync is already running — try again in a moment.";
  if (r.status === "blocked" || r.status === "error" || r.status === "not_ready") return r.message ?? "Sync could not run.";
  const parts = [r.inserted && `${r.inserted} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`, r.held && `${r.held} held for you`, r.failed && `${r.failed} failed`].filter(Boolean);
  return parts.length ? `Synced: ${parts.join(", ")}.` : "Everything is already up to date.";
};

export function GoogleDocsPanel({ businessSlug }: { businessSlug: string }) {
  const [data, setData] = useState<GoogleDocsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await googleDocsApi.get(businessSlug));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Google Docs sync");
    }
  }, [businessSlug]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // Coming back from Google's consent screen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gdocs");
    if (!result) return;
    if (result === "connected") setMessage("Google account connected. Now paste your document link.");
    else setError(params.get("detail") ?? "Could not connect Google.");
    for (const k of ["gdocs", "business", "detail"]) params.delete(k);
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);

  async function run<T>(key: string, fn: () => Promise<T>, done?: (r: T) => string | null) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      const text = done?.(r);
      if (text) setMessage(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p className="text-sm text-zinc-500">Loading…</p>;
  if (data.setupPending) {
    return (
      <Notice tone="warn">
        Setup pending: run the SQL migration <b>20261112000000_ai_agent_google_docs_sync.sql</b> in the Supabase SQL editor, then reload this page. Nothing else changes until you do.
      </Notice>
    );
  }
  const d = data;
  return (
    <div className="flex flex-col gap-6">
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}
      <ConnectionCard d={d} businessSlug={businessSlug} busy={busy} run={run} />
      <DocumentCard key={`${d.settings.documentId}:${d.settings.accessVerifiedAt}`} d={d} businessSlug={businessSlug} busy={busy} run={run} />
      {d.settings.documentId && (
        <>
          <FormatCard key={`fmt:${JSON.stringify(d.settings.format)}:${d.settings.onCompleted}${d.settings.onCancelled}${d.settings.onCorrected}`} d={d} businessSlug={businessSlug} busy={busy} run={run} />
          <SyncCard d={d} businessSlug={businessSlug} busy={busy} run={run} />
          <PendingCard d={d} businessSlug={businessSlug} busy={busy} run={run} />
          {d.settings.enabled && <ImportCard businessSlug={businessSlug} busy={busy} run={run} onDone={load} />}
        </>
      )}
    </div>
  );
}

type RunFn = <T>(key: string, fn: () => Promise<T>, done?: (r: T) => string | null) => Promise<void>;
interface CardProps {
  d: Ready;
  businessSlug: string;
  busy: string | null;
  run: RunFn;
}

function ConnectionCard({ d, businessSlug, busy, run }: CardProps) {
  const c = d.connection;
  const configured = d.configured.oauth && d.configured.encryptionKey;
  return (
    <Card title="1 · Google account" subtitle="Staff never paste secrets or codes: you sign in with Google and approve access once. The app asks only to read and edit Google Docs, and to check the document's title and your edit permission.">
      {!configured && (
        <div className="mb-3">
          <Notice tone="warn">
            Google sign-in is not configured on the server yet. An administrator must add GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_TOKEN_ENCRYPTION_KEY to the hosting environment (see docs/ai-agent-google-docs-sync.md).
            Missing: {[!d.configured.oauth && "Google client id / secret", !d.configured.encryptionKey && "encryption key"].filter(Boolean).join(", ")}.
          </Notice>
        </div>
      )}
      {c ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.status === "connected" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>
            {c.status === "connected" ? "Connected" : c.status === "revoked" ? "Access revoked" : "Needs attention"}
          </span>
          <span className="font-medium text-zinc-800">{c.email}</span>
          <span className="text-xs text-zinc-500">since {formatWhen(c.connectedAt)}</span>
          {c.error && <span className="text-xs text-red-600">{c.error}</span>}
          {!c.scopesOk && <span className="text-xs text-red-600">Some requested permissions were not granted — reconnect and allow them all.</span>}
          <span className="ml-auto flex gap-2">
            {configured && (
              <a href={googleDocsApi.connectUrl(businessSlug)} className={secondaryButton}>
                {c.status === "connected" ? "Switch account" : "Reconnect"}
              </a>
            )}
            <button
              type="button"
              className={dangerButton}
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm("Disconnect Google? Sync will stop. Lines already in the document stay where they are.")) run("disconnect", () => googleDocsApi.disconnect(businessSlug), () => "Google disconnected.");
              }}
            >
              Disconnect
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {configured ? (
            <a href={googleDocsApi.connectUrl(businessSlug)} className={primaryButton}>
              Connect Google Account
            </a>
          ) : (
            <button type="button" className={primaryButton} disabled>
              Connect Google Account
            </button>
          )}
          <span className="text-xs text-zinc-500">Sign in with the Google account that can edit your orders document.</span>
        </div>
      )}
    </Card>
  );
}

function AccessSummary({ a }: { a: GoogleDocsAccess }) {
  return (
    <div className="mt-3 flex flex-col gap-1 text-sm">
      <Notice tone={a.canEdit ? "ok" : "error"}>
        “{a.title}” — {a.canEdit ? `${a.account} can edit this document.` : `${a.account} can only view this document. Share it with edit access, then test again.`}
      </Notice>
      {a.section === "broken" && <Notice tone="error">{a.sectionMessage}</Notice>}
      {a.section === "found" && <Notice tone="info">The AI section already exists ({a.lineCount} lines). New orders go under its first line.</Notice>}
      {a.section === "none" && a.position && (a.position.ok ? <Notice tone="info">No AI section yet. It will be created {positionText(a.position.where)} when the first order syncs — nothing else in the document is changed.</Notice> : <Notice tone="error">{a.position.reason}</Notice>)}
    </div>
  );
}

const positionText = (where: string) => (where === "top" ? "at the top of the document" : where === "end" ? "at the end of the document" : "under the heading you chose");

function DocumentCard({ d, businessSlug, busy, run }: CardProps) {
  const s = d.settings;
  const [input, setInput] = useState(s.documentId ? `https://docs.google.com/document/d/${s.documentId}/edit` : "");
  const [access, setAccess] = useState<GoogleDocsAccess | null>(null);
  const connected = d.connection?.status === "connected";
  return (
    <Card title="2 · Your existing Google Doc" subtitle="Paste the link (or document id). The app never replaces the document: it adds its own clearly marked section and leaves everything else as it is.">
      <div className="flex flex-wrap gap-2">
        <input className={`${inputClass} min-w-72 flex-1`} placeholder="https://docs.google.com/document/d/…/edit" value={input} onChange={(e) => setInput(e.target.value)} disabled={!connected} />
        <button
          type="button"
          className={primaryButton}
          disabled={!connected || busy !== null || !input.trim()}
          onClick={() => run("setdoc", async () => setAccess((await googleDocsApi.setDocument(businessSlug, input)).access), () => "Link saved. Access was checked without changing the document.")}
        >
          {s.documentId ? "Change document & test" : "Save & test access"}
        </button>
        {s.documentId && (
          <button type="button" className={secondaryButton} disabled={!connected || busy !== null} onClick={() => run("test", async () => setAccess((await googleDocsApi.testAccess(businessSlug)).access), () => "Access checked — nothing was written.")}>
            Test access (no writing)
          </button>
        )}
      </div>
      {!connected && <p className="mt-2 text-xs text-zinc-500">Connect a Google account first.</p>}
      {s.documentId && (
        <p className="mt-3 text-sm text-zinc-700">
          <b>{s.documentTitle ?? "Document"}</b> · {s.canEdit ? "edit access verified" : "NO edit access"} · checked {formatWhen(s.accessVerifiedAt)} ·{" "}
          <a className="text-emerald-700 underline" href={`https://docs.google.com/document/d/${s.documentId}/edit`} target="_blank" rel="noreferrer">
            open
          </a>
        </p>
      )}
      {access && <AccessSummary a={access} />}
    </Card>
  );
}

function FormatCard({ d, businessSlug, busy, run }: CardProps) {
  const s = d.settings;
  const [format, setFormat] = useState<FormatConfig>(() => normalizeFormat(s.format));
  const [insertion, setInsertion] = useState(s.insertion);
  const [onCompleted, setOnCompleted] = useState(s.onCompleted);
  const [onCancelled, setOnCancelled] = useState(s.onCancelled);
  const [onCorrected, setOnCorrected] = useState(s.onCorrected);
  const [includeIncomplete, setIncomplete] = useState(s.includeIncomplete);
  const [custom, setCustom] = useState(!(SEPARATOR_PRESETS as readonly string[]).includes(format.separator));

  const move = (i: number, by: -1 | 1) =>
    setFormat((f) => {
      const fields = [...f.fields];
      const j = i + by;
      if (j < 0 || j >= fields.length) return f;
      [fields[i], fields[j]] = [fields[j], fields[i]];
      return { ...f, fields };
    });
  const previews = useMemo(
    () =>
      d.previewOrders.map((o) => {
        const r = formatOrderLine(o, normalizeFormat(format));
        return { id: o.id, source: o.source, ref: o.ref_code, line: withTag(r.text, o.ref_code), missing: r.missing };
      }),
    [d.previewOrders, format]
  );

  return (
    <Card title="3 · What each order line looks like" subtitle="One paragraph per order, newest first, ending with a small grey order id the app uses to find its own line.">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          {format.fields.map((f, i) => (
            <div key={f.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.enabled} onChange={(e) => setFormat((cur) => ({ ...cur, fields: cur.fields.map((x) => (x.key === f.key ? { ...x, enabled: e.target.checked } : x)) }))} />
              <span className={`flex-1 ${f.enabled ? "text-zinc-800" : "text-zinc-400"}`}>
                {FIELD_LABELS[f.key]}
                {["date", "ref", "status"].includes(f.key) && <span className="ml-1 text-xs text-zinc-400">(optional)</span>}
              </span>
              <button type="button" className={secondaryButton} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${FIELD_LABELS[f.key]} up`}>
                ↑
              </button>
              <button type="button" className={secondaryButton} disabled={i === format.fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${FIELD_LABELS[f.key]} down`}>
                ↓
              </button>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-zinc-600">Separator</span>
            <select
              className={`${inputClass} w-auto`}
              value={custom ? "__custom" : format.separator}
              onChange={(e) => {
                if (e.target.value === "__custom") setCustom(true);
                else {
                  setCustom(false);
                  setFormat((f) => ({ ...f, separator: e.target.value }));
                }
              }}
            >
              {SEPARATOR_PRESETS.map((p) => (
                <option key={p} value={p}>{`"${p}"`}</option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            {custom && <input className={`${inputClass} w-24`} maxLength={8} value={format.separator} onChange={(e) => setFormat((f) => ({ ...f, separator: e.target.value }))} />}
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={format.placeholders} onChange={(e) => setFormat((f) => ({ ...f, placeholders: e.target.checked }))} />
            Show “(no phone)” etc. when a detail is missing
          </label>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Live preview</p>
          <div className="flex flex-col gap-2">
            {previews.map((p) => (
              <div key={p.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-sm text-zinc-800">
                <p className="break-words">{p.line}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {p.source === "sample" ? "Example order" : `Next order to sync (${p.ref})`}
                  {p.missing.length > 0 && <span className="ml-2 text-amber-700">missing: {p.missing.join(", ")}</span>}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Format changes apply to new lines. Existing lines are only rewritten when their order changes.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          Where the AI section goes (first time only)
          <select
            className={inputClass}
            value={insertion.kind}
            onChange={(e) => setInsertion(e.target.value === "after_text" ? { kind: "after_text", text: insertion.kind === "after_text" ? insertion.text : "" } : { kind: e.target.value as "top" | "end" })}
            disabled={s.sectionCreatedAt !== null}
          >
            <option value="top">At the top of the document</option>
            <option value="end">At the end of the document</option>
            <option value="after_text">Directly after a heading / line I name</option>
          </select>
          {insertion.kind === "after_text" && (
            <input className={inputClass} placeholder="Text of the heading, e.g. Daily deliveries" value={insertion.text} onChange={(e) => setInsertion({ kind: "after_text", text: e.target.value })} disabled={s.sectionCreatedAt !== null} />
          )}
          {s.sectionCreatedAt && <span className="text-xs text-zinc-500">The section already exists; new orders go directly under its first line.</span>}
        </label>
        <div className="flex flex-col gap-2 text-sm text-zinc-700">
          <FinishedSelect label="Completed orders" value={onCompleted} onChange={setOnCompleted} />
          <FinishedSelect label="Cancelled orders" value={onCancelled} onChange={setOnCancelled} />
          <label className="flex flex-col gap-1">
            Corrected orders
            <select className={inputClass} value={onCorrected} onChange={(e) => setOnCorrected(e.target.value as "update" | "review")}>
              <option value="update">Update the line automatically (unless a person edited it)</option>
              <option value="review">Hold the change for my approval</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={includeIncomplete} onChange={(e) => setIncomplete(e.target.checked)} />
            Also list orders that still miss details (gaps are shown, never guessed)
          </label>
        </div>
      </div>
      <div className="mt-4">
        <button
          type="button"
          className={primaryButton}
          disabled={busy !== null}
          onClick={() => run("save", () => googleDocsApi.saveConfig(businessSlug, { format, insertion, onCompleted, onCancelled, onCorrected, includeIncomplete }), () => "Saved.")}
        >
          Save format & rules
        </button>
      </div>
    </Card>
  );
}

function FinishedSelect({ label, value, onChange }: { label: string; value: "leave" | "mark" | "remove"; onChange: (v: "leave" | "mark" | "remove") => void }) {
  return (
    <label className="flex flex-col gap-1">
      {label}
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as "leave" | "mark" | "remove")}>
        {FINISHED_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SyncCard({ d, businessSlug, busy, run }: CardProps) {
  const s = d.settings;
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  return (
    <Card title="4 · Synchronization" subtitle="Off by default. When on, new actionable WhatsApp orders are added automatically; orders from before it was turned on are not touched unless you import them below.">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.enabled ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-600"}`}>{s.enabled ? "ON" : "OFF"}</span>
        <span className={s.health === "ok" ? "text-zinc-600" : "font-medium text-red-600"}>{HEALTH_TEXT[s.health]}</span>
        <span className="text-xs text-zinc-500">Last sync: {formatWhen(s.lastSyncAt)}</span>
        {s.syncSince && <span className="text-xs text-zinc-500">Listing orders created since {formatWhen(s.syncSince)}</span>}
        <span className="text-xs text-zinc-500">{total} order lines tracked</span>
      </div>
      {s.lastError && (
        <div className="mt-2">
          <Notice tone="error">{s.lastError}</Notice>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {s.enabled ? (
          <>
            <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => run("disable", () => googleDocsApi.setEnabled(businessSlug, false), () => "Sync turned off. Nothing will be written.")}>
              Turn sync off
            </button>
            <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => run("sync", () => googleDocsApi.syncNow(businessSlug), (r) => describeSync(r.result))}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={primaryButton}
            disabled={busy !== null || !s.canEdit || d.connection?.status !== "connected"}
            onClick={() => {
              if (window.confirm("Turn on sync? From now on new orders are added to your Google Doc automatically. Existing orders are not imported.")) run("enable", () => googleDocsApi.setEnabled(businessSlug, true), () => "Sync is on. New orders will appear in the document.");
            }}
          >
            Turn sync on
          </button>
        )}
      </div>
      {!s.enabled && (!s.canEdit || d.connection?.status !== "connected") && <p className="mt-2 text-xs text-zinc-500">Connect Google and test a document you can edit first.</p>}
    </Card>
  );
}

function PendingCard({ d, businessSlug, busy, run }: CardProps) {
  const problems = d.problems;
  const failed = problems.filter((p) => p.state === "failed").length;
  if (problems.length === 0) {
    return (
      <Card title="5 · Needs your attention">
        <p className="text-sm text-zinc-500">Nothing is waiting. Conflicts with manual edits, held corrections and failed writes show up here.</p>
      </Card>
    );
  }
  return (
    <Card title={`5 · Needs your attention (${problems.length})`} subtitle="The app never overwrites a line a person edited. Each item shows both versions so you decide.">
      {failed > 0 && (
        <div className="mb-3">
          <button type="button" className={secondaryButton} disabled={busy !== null || !d.settings.enabled} onClick={() => run("retryall", () => googleDocsApi.retryAll(businessSlug), (r) => describeSync(r.result))}>
            Retry all failed ({failed})
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {problems.map((p) => (
          <ProblemRow key={p.id} p={p} enabled={d.settings.enabled} businessSlug={businessSlug} busy={busy} run={run} />
        ))}
      </ul>
    </Card>
  );
}

const STATE_LABEL: Record<GoogleDocsProblem["state"], string> = {
  conflict: "Edited in the document",
  pending_review: "Correction waiting for approval",
  missing: "Removed from the document",
  failed: "Failed to write",
  synced: "Synced",
};

function ProblemRow({ p, enabled, businessSlug, busy, run }: { p: GoogleDocsProblem; enabled: boolean; businessSlug: string; busy: string | null; run: RunFn }) {
  const act = (resolution: "overwrite" | "keep" | "readd" | "ignore" | "retry", done: string) => run(`${p.id}:${resolution}`, () => googleDocsApi.resolve(businessSlug, p.id, resolution), () => done);
  return (
    <li className="rounded-md border border-zinc-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge value={p.state === "failed" ? "failed" : "unresolved"} />
        <span className="font-medium text-zinc-800">{STATE_LABEL[p.state]}</span>
        <span className="text-zinc-500">
          {p.ref}
          {p.customer ? ` · ${p.customer}` : ""}
          {p.orderStatus ? ` · ${p.orderStatus}` : ""}
        </span>
        <span className="ml-auto text-xs text-zinc-400">{formatWhen(p.updatedAt)}</span>
      </div>
      {p.reason && <p className="mt-1 text-zinc-600">{p.reason}</p>}
      {p.error && <p className="mt-1 text-red-600">{p.error} (attempt {p.attempts})</p>}
      {p.foundText && (
        <p className="mt-2 rounded bg-zinc-50 p-2">
          <span className="text-xs font-medium uppercase text-zinc-500">In the document now</span>
          <br />
          {p.foundText}
        </p>
      )}
      {p.pendingText && (
        <p className="mt-2 rounded bg-emerald-50 p-2">
          <span className="text-xs font-medium uppercase text-emerald-700">What the app would write</span>
          <br />
          {p.pendingText}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {(p.state === "conflict" || p.state === "pending_review") && (
          <>
            <button type="button" className={primaryButton} disabled={busy !== null || !enabled} onClick={() => act("overwrite", "Line updated in the document.")}>
              {p.state === "pending_review" ? "Approve & update line" : "Use the app's version"}
            </button>
            <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => act("keep", "Kept the document's version.")}>
              {p.state === "pending_review" ? "Reject (leave the line)" : "Keep the document's version"}
            </button>
          </>
        )}
        {p.state === "missing" && (
          <>
            <button type="button" className={primaryButton} disabled={busy !== null || !enabled} onClick={() => act("readd", "Line added again at the top.")}>
              Add it again
            </button>
            <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => act("ignore", "Ignored.")}>
              Leave it out
            </button>
          </>
        )}
        {p.state === "failed" && (
          <button type="button" className={primaryButton} disabled={busy !== null || !enabled} onClick={() => act("retry", "Retried.")}>
            Retry
          </button>
        )}
      </div>
    </li>
  );
}

function ImportCard({ businessSlug, busy, run, onDone }: { businessSlug: string; busy: string | null; run: RunFn; onDone: () => void }) {
  const [preview, setPreview] = useState<GoogleDocsImportPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Card title="6 · Import existing outstanding orders (one time)" subtitle="Optional. Preview first — nothing is written to the document until you confirm. Oldest are added first, so the newest ends up on top.">
      <button
        type="button"
        className={secondaryButton}
        disabled={busy !== null}
        onClick={() =>
          run("preview", async () => {
            const r = await googleDocsApi.importPreview(businessSlug);
            setPreview(r.preview);
            setPicked(new Set(r.preview.items.map((i) => i.orderId)));
          })
        }
      >
        Preview outstanding orders
      </button>
      {preview && (
        <div className="mt-3">
          {preview.items.length === 0 ? (
            <p className="text-sm text-zinc-500">No outstanding orders are waiting to be imported.</p>
          ) : (
            <>
              <ul className="flex max-h-96 flex-col gap-1 overflow-auto">
                {preview.items.map((i) => (
                  <li key={i.orderId} className="flex gap-2 rounded border border-zinc-200 p-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.has(i.orderId)}
                      onChange={(e) =>
                        setPicked((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(i.orderId);
                          else next.delete(i.orderId);
                          return next;
                        })
                      }
                    />
                    <span className="break-words">
                      {i.line}
                      {i.missing.length > 0 && <span className="ml-2 text-xs text-amber-700">missing: {i.missing.join(", ")}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy !== null || picked.size === 0}
                  onClick={() => {
                    if (!window.confirm(`Add ${picked.size} existing order${picked.size === 1 ? "" : "s"} to your Google Doc now?`)) return;
                    run(
                      "import",
                      async () => {
                        const r = await googleDocsApi.importCommit(businessSlug, [...picked]);
                        setPreview(null);
                        onDone();
                        return r;
                      },
                      (r) => describeSync(r.result)
                    );
                  }}
                >
                  Add {picked.size} selected to the document
                </button>
              </div>
            </>
          )}
          {preview.skipped.length > 0 && <p className="mt-2 text-xs text-zinc-500">Not importable: {preview.skipped.map((s) => `${s.ref} (${s.reason})`).join("; ")}</p>}
        </div>
      )}
    </Card>
  );
}
