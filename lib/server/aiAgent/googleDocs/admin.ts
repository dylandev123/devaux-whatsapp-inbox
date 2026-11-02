// Server-only: what the AI Agent dashboard does with the Google Docs sync — connect status, document link and access test
// (read-only), settings, live-preview data, the one-time import, and resolving held lines. Every function is scoped to one
// business slug; the document id used for any Google call comes from that business's stored settings, never from a request.
// Nothing here sends a WhatsApp message, and nothing writes to a document unless sync is enabled and a person asked.

import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { decryptSecret } from "@/lib/server/aiAgent/googleDocs/crypto";
import { encryptionKey } from "@/lib/server/aiAgent/googleDocs/crypto";
import { GoogleApiError, isGoogleDocFile, oauthConfig, REQUIRED_SCOPES, revokeToken } from "@/lib/server/aiAgent/googleDocs/google";
import {
  deleteConnection,
  loadConnection,
  loadGdocSettings,
  loadLine,
  loadLines,
  loadLinesByState,
  saveGdocSettings,
  upsertLine,
  type GdocSettings,
  type LineRow,
} from "@/lib/server/aiAgent/googleDocs/store";
import { describeError, openClient, policyOf, runSync, SYNC_ORDER_COLUMNS, type SyncSummary } from "@/lib/server/aiAgent/googleDocs/sync";
import { parseDocumentRef } from "@/lib/aiAgent/gdocLink";
import { findSection, paragraphsWithTag, resolvePosition, type Insertion } from "@/lib/aiAgent/gdocDocument";
import { formatOrderLine, normalizeFormat, SAMPLE_ORDER, splitTag, withTag, type FormatConfig, type LineOrder } from "@/lib/aiAgent/gdocFormat";
import { planSync, type OnCorrected, type OnFinished, type SyncOrder } from "@/lib/aiAgent/gdocPlan";
import { OPEN_ORDER_STATUSES } from "@/lib/aiAgent/orders";
import { normalizeInsertion } from "@/lib/aiAgent/gdocDocument";

export class AdminError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ORDER_LIMIT = 300;

// ── Dashboard payload ────────────────────────────────────────────────────────
export interface ProblemLine {
  id: string;
  orderId: string;
  ref: string;
  state: LineRow["state"];
  customer: string | null;
  orderStatus: string | null;
  reason: string | null;
  pendingText: string | null;
  foundText: string | null;
  lastText: string | null;
  attempts: number;
  error: string | null;
  updatedAt: string;
}

export interface PreviewOrder extends LineOrder {
  id: string;
}

async function ordersByIds(businessSlug: string, ids: string[]): Promise<SyncOrder[]> {
  const out: SyncOrder[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SyncOrder[]));
  }
  return out;
}

async function outstandingOrders(businessSlug: string): Promise<SyncOrder[]> {
  const { data, error } = await agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("status", [...OPEN_ORDER_STATUSES]).order("created_at").limit(ORDER_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? []) as SyncOrder[];
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
  if (settings.document_id) {
    const lines = await loadLines(businessSlug, settings.document_id);
    for (const l of lines) counts[l.state] = (counts[l.state] ?? 0) + 1;
    const bad = lines.filter((l) => l.state !== "synced").sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 100);
    const orders = new Map((await ordersByIds(businessSlug, bad.map((l) => l.order_id))).map((o) => [o.id, o]));
    problems = bad.map((l) => ({
      id: l.id,
      orderId: l.order_id,
      ref: l.tag,
      state: l.state,
      customer: orders.get(l.order_id)?.customer_name ?? null,
      orderStatus: orders.get(l.order_id)?.status ?? null,
      reason: l.pending_reason,
      pendingText: l.pending_text,
      foundText: l.found_text,
      lastText: l.last_text,
      attempts: l.attempts,
      error: l.last_error,
      updatedAt: l.updated_at,
    }));
    const have = new Set(lines.map((l) => l.order_id));
    nextOrders = (await outstandingOrders(businessSlug)).filter((o) => !have.has(o.id) && o.items.length > 0).slice(-3).reverse();
  } else {
    nextOrders = (await outstandingOrders(businessSlug)).filter((o) => o.items.length > 0).slice(-3).reverse();
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
      insertion: settings.insertion,
      onCompleted: settings.on_completed,
      onCancelled: settings.on_cancelled,
      onCorrected: settings.on_corrected,
      includeIncomplete: settings.include_incomplete,
      syncSince: settings.sync_since,
      sectionCreatedAt: settings.section_created_at,
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
  section: "none" | "found" | "broken";
  sectionMessage: string | null;
  /** Where a new section would go, or why that position cannot be used. */
  position: { ok: true; where: string } | { ok: false; reason: string } | null;
  lineCount: number;
}

/** Reads the document with the connected account. Never writes. */
export async function checkAccess(businessSlug: string, documentId: string, insertion: Insertion): Promise<AccessReport> {
  const { client, email } = await openClient(businessSlug);
  const file = await client.getFile(documentId);
  if (!isGoogleDocFile(file)) throw new AdminError("That link is not a Google Docs document (it is another kind of Drive file).");
  if (file.trashed) throw new AdminError("That document is in the trash.");
  const doc = await client.getDocument(documentId);
  const section = findSection(doc, businessSlug);
  const position = section.kind === "none" ? resolvePosition(doc, insertion) : null;
  return {
    documentId,
    title: file.name || doc.title || "Untitled document",
    canEdit: file.canEdit,
    account: email,
    section: section.kind,
    sectionMessage: section.kind === "broken" ? section.reason : null,
    position: position ? (position.ok ? { ok: true, where: position.where } : { ok: false, reason: position.reason }) : null,
    lineCount: section.kind === "found" ? section.lines.length : 0,
  };
}

function accessError(err: unknown): AdminError {
  if (err instanceof AdminError) return err;
  const { message } = describeError(err);
  return new AdminError(message, err instanceof GoogleApiError && err.kind === "not_found" ? 404 : 400);
}

export async function setDocument(businessSlug: string, input: string, userId: string): Promise<AccessReport> {
  const parsed = parseDocumentRef(input);
  if (!parsed.ok) throw new AdminError(parsed.reason);
  const settings = (await loadGdocSettings(businessSlug)) ?? null;
  if (!settings) throw new AdminError("Google Docs sync is not set up in the database yet. Run the migration first.", 409);
  let report: AccessReport;
  try {
    report = await checkAccess(businessSlug, parsed.documentId, settings.insertion);
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
      // A different document must be re-enabled on purpose, and gets its own section.
      // Its sync start is reset too: the new document begins empty and only gets orders from the moment it is turned on
      // (older outstanding orders come in through the explicit import).
      ...(changed ? { enabled: false, section_created_at: null, sync_since: null, health: "ok" as const, last_error: null } : {}),
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
    const report = await checkAccess(businessSlug, settings.document_id, settings.insertion);
    await saveGdocSettings(businessSlug, { document_title: report.title, can_edit: report.canEdit, access_verified_at: new Date().toISOString() });
    return report;
  } catch (err) {
    throw accessError(err);
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────
const FINISHED: OnFinished[] = ["leave", "mark", "remove"];
const CORRECTED: OnCorrected[] = ["update", "review"];

export interface ConfigPatch {
  format?: unknown;
  insertion?: unknown;
  onCompleted?: unknown;
  onCancelled?: unknown;
  onCorrected?: unknown;
  includeIncomplete?: unknown;
}

export async function saveConfig(businessSlug: string, patch: ConfigPatch, userId: string): Promise<GdocSettings> {
  const current = await loadGdocSettings(businessSlug);
  if (!current) throw new AdminError("Google Docs sync is not set up in the database yet. Run the migration first.", 409);
  const next: Partial<GdocSettings> = {};
  if (patch.format !== undefined) next.format = normalizeFormat(patch.format) as FormatConfig;
  if (patch.insertion !== undefined) {
    next.insertion = normalizeInsertion(patch.insertion);
    // The position only matters until the section exists; after that new lines always go under its start marker.
  }
  if (patch.onCompleted !== undefined) {
    if (!FINISHED.includes(patch.onCompleted as OnFinished)) throw new AdminError("Invalid setting for completed orders");
    next.on_completed = patch.onCompleted as OnFinished;
  }
  if (patch.onCancelled !== undefined) {
    if (!FINISHED.includes(patch.onCancelled as OnFinished)) throw new AdminError("Invalid setting for cancelled orders");
    next.on_cancelled = patch.onCancelled as OnFinished;
  }
  if (patch.onCorrected !== undefined) {
    if (!CORRECTED.includes(patch.onCorrected as OnCorrected)) throw new AdminError("Invalid setting for corrected orders");
    next.on_corrected = patch.onCorrected as OnCorrected;
  }
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
    report = await checkAccess(businessSlug, current.document_id, current.insertion);
  } catch (err) {
    throw accessError(err);
  }
  if (!report.canEdit) throw new AdminError(`${report.account} can only view “${report.title}”. Share the document with edit access, then test again.`);
  if (report.section === "broken") throw new AdminError(report.sectionMessage ?? "The AI section in the document is damaged.");
  if (report.position && !report.position.ok) throw new AdminError(report.position.reason);
  const saved = await saveGdocSettings(
    businessSlug,
    {
      enabled: true,
      document_title: report.title,
      can_edit: true,
      access_verified_at: new Date().toISOString(),
      // Orders created before this moment are NOT synced automatically; they need the explicit one-time import.
      sync_since: current.sync_since ?? new Date().toISOString(),
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
  const { client } = await openClient(businessSlug).catch((err) => {
    throw accessError(err);
  });
  const doc = await client.getDocument(settings.document_id).catch((err) => {
    throw accessError(err);
  });
  const records = new Map((await loadLines(businessSlug, settings.document_id)).map((l) => [l.order_id, l]));
  const orders = (await outstandingOrders(businessSlug)).filter((o) => !records.has(o.id));
  const plan = planSync({ orders, records, doc, policy: policyOf(settings), mode: "import" });
  return {
    items: plan.actions
      .filter((a) => a.write?.type === "insert")
      .map((a) => ({ orderId: a.order.id, ref: a.order.ref_code, line: withTag((a.write as { text: string }).text, a.order.ref_code), missing: formatOrderLine(a.order, settings.format).missing, createdAt: a.order.created_at }))
      .reverse(),
    skipped: [...plan.skipped.map((s) => ({ ref: s.order.ref_code, reason: s.reason })), ...plan.actions.filter((a) => !a.write).map((a) => ({ ref: a.order.ref_code, reason: a.note }))],
  };
}

export async function importCommit(businessSlug: string, orderIds: string[], userId: string): Promise<SyncSummary> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.enabled) throw new AdminError("Turn sync on before importing existing orders.");
  const preview = await importPreview(businessSlug);
  const allowed = new Set(preview.items.map((i) => i.orderId));
  const ids = [...new Set(orderIds)].filter((id) => allowed.has(id));
  if (ids.length === 0) throw new AdminError("None of the selected orders can be imported (they may already be in the document).");
  const summary = await runSync(businessSlug, { mode: "import", orderIds: ids });
  await audit(businessSlug, "admin", userId, "gdocs.import", { type: "google_doc", id: settings.document_id }, { requested: ids.length, inserted: summary.inserted });
  return summary;
}

// ── Held lines ───────────────────────────────────────────────────────────────
export type Resolution = "overwrite" | "keep" | "readd" | "ignore" | "retry";

export async function resolveLine(businessSlug: string, lineId: string, resolution: Resolution, userId: string): Promise<SyncSummary | { status: "ok" }> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.document_id) throw new AdminError("Paste your Google Docs link first.");
  const line = await loadLine(businessSlug, settings.document_id, lineId);
  if (!line) throw new AdminError("That line was not found.", 404);
  const [order] = await ordersByIds(businessSlug, [line.order_id]);
  if (!order) throw new AdminError("The order no longer exists.", 404);
  await audit(businessSlug, "admin", userId, `gdocs.resolve.${resolution}`, { type: "google_doc_line", id: line.id }, { ref: line.tag, state: line.state });

  if (resolution === "ignore" || (resolution === "keep" && line.state === "missing")) {
    await upsertLine(businessSlug, settings.document_id, order, { state: "synced", last_text: null, synced_version: order.version, synced_status: order.status, pending_text: null, pending_action: null, pending_reason: null, found_text: null });
    return { status: "ok" };
  }
  if (resolution === "keep") {
    // Keep the person's version. The baseline is left empty ("not something the app wrote"), so the line is never treated as
    // unedited: a later change to the order is held as a conflict again instead of silently replacing what they chose to keep.
    const { client } = await openClient(businessSlug).catch((err) => {
      throw accessError(err);
    });
    const found = paragraphsWithTag(await client.getDocument(settings.document_id).catch((err) => { throw accessError(err); }), line.tag);
    if (found.length !== 1) throw new AdminError(found.length === 0 ? "The line is no longer in the document." : `The tag ${line.tag} appears ${found.length} times in the document. Remove the extra copies first.`);
    await upsertLine(businessSlug, settings.document_id, order, { state: "synced", last_text: null, synced_version: order.version, synced_status: order.status, pending_text: null, pending_action: null, pending_reason: null, found_text: null });
    return { status: "ok" };
  }
  if (!settings.enabled) throw new AdminError("Turn sync on to let the app write to the document.");

  if (resolution === "overwrite") {
    const { client } = await openClient(businessSlug).catch((err) => {
      throw accessError(err);
    });
    const found = paragraphsWithTag(await client.getDocument(settings.document_id).catch((err) => { throw accessError(err); }), line.tag);
    if (found.length !== 1) throw new AdminError(found.length === 0 ? "The line is no longer in the document. Use “Add again” instead." : `The tag ${line.tag} appears ${found.length} times in the document. Remove the extra copies first.`);
    // Make the document's current text the baseline (so it is "unedited" to the planner) and the order look changed.
    await upsertLine(businessSlug, settings.document_id, order, { state: "synced", last_text: splitTag(found[0].text).text, synced_version: -1, synced_status: "overwrite", pending_text: null, pending_action: null, pending_reason: null, found_text: null });
    return runSync(businessSlug, { mode: "import", orderIds: [order.id], force: true, approve: true });
  }
  // readd / retry: forget the old line and list the order again at the top.
  if (resolution === "readd") {
    await upsertLine(businessSlug, settings.document_id, order, { state: "failed", last_text: null, pending_text: null, pending_action: null, pending_reason: null, found_text: null });
  } else {
    await upsertLine(businessSlug, settings.document_id, order, { state: line.state === "failed" ? "failed" : line.state, last_text: line.last_text }, { attempts: 0 });
  }
  return runSync(businessSlug, { mode: "import", orderIds: [order.id], force: true, approve: true });
}

export async function retryAllFailed(businessSlug: string, userId: string): Promise<SyncSummary> {
  const settings = await loadGdocSettings(businessSlug);
  if (!settings?.document_id) throw new AdminError("Paste your Google Docs link first.");
  const failed = await loadLinesByState(businessSlug, settings.document_id, ["failed"]);
  for (const l of failed) {
    const [order] = await ordersByIds(businessSlug, [l.order_id]);
    if (order) await upsertLine(businessSlug, settings.document_id, order, { state: "failed", last_text: l.last_text }, { attempts: 0 });
  }
  await audit(businessSlug, "admin", userId, "gdocs.retry_failed", { type: "google_doc" }, { count: failed.length });
  return runSync(businessSlug, { mode: "import", orderIds: failed.map((l) => l.order_id), force: true });
}
