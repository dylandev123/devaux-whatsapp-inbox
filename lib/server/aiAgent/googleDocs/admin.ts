// Server-only: what the AI Agent dashboard does with the Google Docs sync — connect status, document link and access test
// (metadata only: the document body is never downloaded), settings, live-preview data, the one-time import, and settling
// lines whose result is unknown. Every function is scoped to one business slug; the document id used for any Google call comes
// from that business's stored settings, never from a request. Nothing here sends a WhatsApp message, and nothing writes to a
// document unless sync is enabled and a person asked.

import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { decryptSecret, encryptionKey } from "@/lib/server/aiAgent/googleDocs/crypto";
import { GoogleApiError, isGoogleDocFile, oauthConfig, REQUIRED_SCOPES, revokeToken } from "@/lib/server/aiAgent/googleDocs/google";
import {
  deleteConnection,
  loadConnection,
  loadGdocSettings,
  loadLine,
  loadLines,
  loadLinesForOrders,
  saveGdocSettings,
  setLineState,
  type GdocSettings,
  type LineRow,
} from "@/lib/server/aiAgent/googleDocs/store";
import { describeError, MAX_VERIFY_ATTEMPTS, openClient, openOrders, ordersByIds, policyOf, runSync, SETTLE_MS, type SyncSummary } from "@/lib/server/aiAgent/googleDocs/sync";
import { parseDocumentRef } from "@/lib/aiAgent/gdocLink";
import { formatOrderLine, normalizeFormat, SAMPLE_ORDER, withTag, type FormatConfig, type LineOrder } from "@/lib/aiAgent/gdocFormat";
import { planInsertions } from "@/lib/aiAgent/gdocInsert";

export class AdminError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ProblemLine {
  id: string;
  orderId: string;
  ref: string;
  /** failed = the document is known to be unchanged; unconfirmed = Google may or may not have applied the write. */
  state: "failed" | "unconfirmed";
  customer: string | null;
  orderStatus: string | null;
  /** Why a person is needed, in plain words. */
  reason: string;
  attempts: number;
  error: string | null;
  updatedAt: string;
}

export interface PreviewOrder extends LineOrder {
  id: string;
}

const PROBLEM_STATES = new Set<LineRow["state"]>(["failed", "unconfirmed", "inserting"]);

function problemReason(l: LineRow, now: number): string {
  if (l.state === "failed") return "Google refused or could not complete the write, so nothing was added. It is retried automatically.";
  if (l.state === "inserting" && now - Date.parse(l.attempt_started_at ?? l.updated_at) < SETTLE_MS) return "Being written right now.";
  if (l.verify_attempts >= MAX_VERIFY_ATTEMPTS) return "Google may or may not have added this line, and the document could not be checked. Look for its order id in the document, then choose below.";
  return "Google may or may not have added this line. The app will check the document for its order id before ever adding it again.";
}

export async function getDashboard(businessSlug: string) {
  const cfg = oauthConfig();
  const configured = { oauth: cfg !== null, encryptionKey: encryptionKey() !== null };
  const settings = await loadGdocSettings(businessSlug);
  if (!settings) return { setupPending: true as const, configured };
  const conn = await loadConnection(businessSlug);
  const scopesOk = conn ? REQUIRED_SCOPES.every((s) => conn.scopes.includes(s)) : false;

  let problems: ProblemLine[] = [];
  const counts: Record<string, number> = {};
  let nextOrders: PreviewOrder[] = [];
  const open = await openOrders(businessSlug, null);
  if (settings.document_id) {
    const lines = await loadLines(businessSlug, settings.document_id);
    for (const l of lines) counts[l.state] = (counts[l.state] ?? 0) + 1;
    const now = Date.now();
    const bad = lines.filter((l) => PROBLEM_STATES.has(l.state)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 100);
    const orders = new Map((await ordersByIds(businessSlug, bad.map((l) => l.order_id))).map((o) => [o.id, o]));
    problems = bad.map((l) => ({
      id: l.id,
      orderId: l.order_id,
      ref: l.tag,
      state: l.state === "failed" ? ("failed" as const) : ("unconfirmed" as const),
      customer: orders.get(l.order_id)?.customer_name ?? null,
      orderStatus: orders.get(l.order_id)?.status ?? null,
      reason: problemReason(l, now),
      attempts: l.attempts,
      error: l.last_error,
      updatedAt: l.updated_at,
    }));
    const have = new Set(lines.map((l) => l.order_id));
    nextOrders = open.filter((o) => !have.has(o.id) && o.items.length > 0).slice(-3).reverse();
  } else {
    nextOrders = open.filter((o) => o.items.length > 0).slice(-3).reverse();
  }

  return {
    setupPending: false as const,
    configured,
    redirectUriHint: "/api/ai-agent/google-docs/callback",
    connection: conn ? { email: conn.account_email, status: conn.status, error: conn.last_error, scopesOk, connectedAt: conn.connected_at } : null,
    settings: {
      enabled: settings.enabled,
      documentId: settings.document_id,
      documentTitle: settings.document_title,
      canEdit: settings.can_edit,
      accessVerifiedAt: settings.access_verified_at,
      format: settings.format,
      includeIncomplete: settings.include_incomplete,
      syncSince: settings.sync_since,
      lastSyncAt: settings.last_sync_at,
      health: settings.health,
      lastError: settings.last_error,
    },
    counts,
    problems,
    // Raw order fields so the browser formats the live preview itself (no request per keystroke).
    previewOrders: [...nextOrders.map((o) => ({ ...o, source: "next" as const })), { ...SAMPLE_ORDER, id: "sample", source: "sample" as const }],
  };
}

// ── Connection ───────────────────────────────────────────────────────────────
export async function disconnectGoogle(businessSlug: string, userId: string): Promise<void> {
  const conn = await loadConnection(businessSlug);
  // Stop syncing first, so nothing runs against a half-removed connection.
  const settings = await loadGdocSettings(businessSlug);
  if (settings) await saveGdocSettings(businessSlug, { enabled: false, health: "needs_reconnect", last_error: "Google was disconnected." }, userId);
  if (conn) {
    try {
      await revokeToken(decryptSecret(conn.refresh_token_enc, businessSlug));
    } catch {
      // Revoking at Google is best effort; the stored credential is deleted either way.
    }
    await deleteConnection(businessSlug);
  }
  await audit(businessSlug, "admin", userId, "gdocs.disconnect", { type: "google_connection" });
}

// ── Document link and read-only access test ──────────────────────────────────
export interface AccessReport {
  documentId: string;
  title: string;
  canEdit: boolean;
  account: string;
  /** The Docs API answered for this account (checked without opening any document). */
  docsApi: true;
}

/**
 * Drive metadata (title, type, trashed, capabilities.canEdit) plus a Docs API availability probe, in parallel. The document
 * body is never downloaded and nothing is written, so a document of any size is tested in about a second.
 */
export async function checkAccess(businessSlug: string, documentId: string): Promise<AccessReport> {
  const { client, email } = await openClient(businessSlug);
  const [file, probe] = await Promise.allSettled([client.getFile(documentId), client.probeDocsApi()]);
  if (file.status === "rejected") throw file.reason;
  if (!isGoogleDocFile(file.value)) throw new AdminError("That link is not a Google Docs document (it is another kind of Drive file).");
  if (file.value.trashed) throw new AdminError("That document is in the trash.");
  if (probe.status === "rejected") throw probe.reason;
  return { documentId, title: file.value.name || "Untitled document", canEdit: file.value.canEdit, account: email, docsApi: true };
}

function accessError(err: unknown): AdminError {
  if (err instanceof AdminError) return err;
  const { message } = describeError(err);
  if (err instanceof GoogleApiError) console.error("[google-docs access]", `kind=${err.kind} status=${err.status} reasons=${err.reasons.join(",")} message=${err.message.slice(0, 300)}`);
  return new AdminError(message, err instanceof GoogleApiError && err.kind === "not_found" ? 404 : err instanceof GoogleApiError && err.kind === "timeout" ? 504 : 400);
}

export async function setDocument(businessSlug: string, input: string, userId: string): Promise<AccessReport> {
  const parsed = parseDocumentRef(input);
  if (!parsed.ok) throw new AdminError(parsed.reason);
  const settings = (await loadGdocSettings(businessSlug)) ?? null;
  if (!settings) throw new AdminError("Google Docs sync is not set up in the database yet. Run the migration first.", 409);
  let report: AccessReport;
  try {
    report = await checkAccess(businessSlug, parsed.documentId);
  } catch (err) {
    throw accessError(err);
  }
  const changed = settings.document_id !== parsed.documentId;
  await saveGdocSettings(
    businessSlug,
    {
      document_id: parsed.documentId,
      document_title: report.title,
      can_edit: report.canEdit,
      access_verified_at: new Date().toISOString(),
      // A different document must be re-enabled on purpose. Its sync start is reset too: it only gets orders from the moment
      // it is turned on (older outstanding orders come in through the explicit import).
      ...(changed ? { enabled: false, sync_since: null, health: "ok" as const, last_error: null } : {}),
    },
    userId
  );
  await audit(businessSlug, "admin", userId, "gdocs.set_document", { type: "google_doc", id: parsed.documentId }, { title: report.title, canEdit: report.canEdit, changed });
  return report;
}

export async function testStoredDocument(businessSlug: string): Promise<AccessReport> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.document_id) throw new AdminError("Paste a Google Docs link first.");
  try {
    const report = await checkAccess(businessSlug, settings.document_id);
    await saveGdocSettings(businessSlug, { document_title: report.title, can_edit: report.canEdit, access_verified_at: new Date().toISOString() });
    return report;
  } catch (err) {
    throw accessError(err);
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────
export interface ConfigPatch {
  format?: unknown;
  includeIncomplete?: unknown;
}

export async function saveConfig(businessSlug: string, patch: ConfigPatch, userId: string): Promise<GdocSettings> {
  const current = await loadGdocSettings(businessSlug);
  if (!current) throw new AdminError("Google Docs sync is not set up in the database yet. Run the migration first.", 409);
  const next: Partial<GdocSettings> = {};
  if (patch.format !== undefined) next.format = normalizeFormat(patch.format) as FormatConfig;
  if (patch.includeIncomplete !== undefined) next.include_incomplete = patch.includeIncomplete === true;
  const saved = await saveGdocSettings(businessSlug, next, userId);
  await audit(businessSlug, "admin", userId, "gdocs.save_config", { type: "google_doc" }, { fields: Object.keys(next) });
  return saved;
}

export async function setEnabled(businessSlug: string, enabled: boolean, userId: string): Promise<GdocSettings> {
  const current = await loadGdocSettings(businessSlug);
  if (!current) throw new AdminError("Google Docs sync is not set up in the database yet. Run the migration first.", 409);
  if (!enabled) {
    const saved = await saveGdocSettings(businessSlug, { enabled: false }, userId);
    await audit(businessSlug, "admin", userId, "gdocs.disable", { type: "google_doc" });
    return saved;
  }
  if (!current.document_id) throw new AdminError("Paste your Google Docs link before turning sync on.");
  let report: AccessReport;
  try {
    report = await checkAccess(businessSlug, current.document_id);
  } catch (err) {
    throw accessError(err);
  }
  if (!report.canEdit) throw new AdminError(`${report.account} can only view “${report.title}”. Share the document with edit access, then test again.`);
  const saved = await saveGdocSettings(
    businessSlug,
    {
      enabled: true,
      document_title: report.title,
      can_edit: true,
      access_verified_at: new Date().toISOString(),
      // Only orders created from this moment on sync automatically — including after switching sync off and on again.
      // Earlier ones need the explicit one-time import.
      sync_since: new Date().toISOString(),
      health: "ok",
      last_error: null,
    },
    userId
  );
  await audit(businessSlug, "admin", userId, "gdocs.enable", { type: "google_doc", id: current.document_id });
  return saved;
}

// ── One-time import of outstanding orders ────────────────────────────────────
export interface ImportPreview {
  items: { orderId: string; ref: string; line: string; missing: string[]; createdAt: string }[];
  skipped: { ref: string; reason: string }[];
}

export async function importPreview(businessSlug: string): Promise<ImportPreview> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.document_id) throw new AdminError("Paste your Google Docs link first.");
  const orders = await openOrders(businessSlug, null);
  const rows = await loadLinesForOrders(businessSlug, settings.document_id, orders.map((o) => o.id));
  const plan = planInsertions(orders, new Map(rows.map((r) => [r.order_id, r.state as string])), policyOf(settings), "import");
  return {
    // Newest first, as they will read in the document (they are written oldest first).
    items: plan.insert
      .map((o) => ({ orderId: o.id, ref: o.ref_code, line: withTag(formatOrderLine(o, settings.format).text, o.ref_code), missing: formatOrderLine(o, settings.format).missing, createdAt: o.created_at }))
      .reverse(),
    skipped: plan.skipped.map((s) => ({ ref: s.order.ref_code, reason: s.reason })),
  };
}

export async function importCommit(businessSlug: string, orderIds: string[], userId: string): Promise<SyncSummary> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.enabled) throw new AdminError("Turn sync on before importing existing orders.");
  const preview = await importPreview(businessSlug);
  const allowed = new Set(preview.items.map((i) => i.orderId));
  const ids = [...new Set(orderIds)].filter((id) => allowed.has(id));
  if (ids.length === 0) throw new AdminError("None of the selected orders can be imported (they may already be in the document).");
  const summary = await runSync(businessSlug, { mode: "import", orderIds: ids, manual: true });
  await audit(businessSlug, "admin", userId, "gdocs.import", { type: "google_doc", id: settings.document_id }, { requested: ids.length, inserted: summary.inserted });
  return summary;
}

// ── Lines whose result a person settles ──────────────────────────────────────
/** present = "I can see it in the document"; again = "it is not there, add it"; skip = "leave this order out". */
export type Resolution = "present" | "again" | "skip";

export async function resolveLine(businessSlug: string, lineId: string, resolution: Resolution, userId: string): Promise<SyncSummary | { status: "ok" }> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.document_id) throw new AdminError("Paste your Google Docs link first.");
  const line = await loadLine(businessSlug, settings.document_id, lineId);
  if (!line) throw new AdminError("That line was not found.", 404);
  if (!["failed", "unconfirmed", "inserting"].includes(line.state)) throw new AdminError("That line is already settled.", 409);
  await audit(businessSlug, "admin", userId, `gdocs.resolve.${resolution}`, { type: "google_doc_line", id: line.id }, { ref: line.tag, state: line.state });
  const key = { businessSlug, documentId: settings.document_id, orderId: line.order_id };
  if (resolution === "present") {
    await setLineState(key, "synced");
    return { status: "ok" };
  }
  if (resolution === "skip") {
    await setLineState(key, "skipped");
    return { status: "ok" };
  }
  // "again": the person has checked the document and the line is not there (or accepts a possible duplicate).
  if (!settings.enabled) throw new AdminError("Turn sync on to let the app write to the document.");
  await setLineState(key, "failed");
  return runSync(businessSlug, { mode: "import", orderIds: [line.order_id], manual: true });
}

/** Retry now: every failed line is tried again, and unknown ones are checked against the document. */
export async function retryNow(businessSlug: string): Promise<SyncSummary> {
  return runSync(businessSlug, { manual: true });
}
