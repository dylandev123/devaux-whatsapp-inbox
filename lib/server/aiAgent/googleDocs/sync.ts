// Server-only: the Google Docs order sync engine. Supabase stays the authoritative order record; this reads orders, plans
// with the pure planner (lib/aiAgent/gdocPlan.ts) against the CURRENT document, writes only the planned lines in one atomic
// batchUpdate guarded by the document's revision id, and records the result per order. It never sends a WhatsApp message
// (it does not import the outbox) and never runs while sync is disabled.
//
// Concurrency: a database lease (claim_gdoc_sync) allows one run per business at a time; the revision guard rejects a write
// if a person edited the document between our read and our write, and the run simply re-reads and re-plans. A crash
// between the document write and the database write is repaired by the planner, which finds the line by its tag.
// No timers are used here (see tests/aiAgentSchedulerSafety): retries happen on the next cron tick or dashboard action.

import { agentDb } from "@/lib/server/aiAgent/db";
import { decryptSecret } from "@/lib/server/aiAgent/googleDocs/crypto";
import { docsClient, GoogleApiError, oauthConfig, refreshAccessToken, type DocsClient } from "@/lib/server/aiAgent/googleDocs/google";
import {
  claimSync,
  isSchemaPending,
  loadConnection,
  loadGdocSettings,
  loadLines,
  markConnection,
  releaseSync,
  saveGdocSettings,
  upsertLine,
  type GdocSettings,
  type Health,
  type LineRow,
} from "@/lib/server/aiAgent/googleDocs/store";
import {
  findSection,
  planCreateSection,
  planInsertLine,
  planRemoveLine,
  planRewriteLine,
  resolvePosition,
  type DocRequest,
  type GoogleDocument,
} from "@/lib/aiAgent/gdocDocument";
import { planSync, type LinePatch, type LineRecord, type Mode, type SyncAction, type SyncOrder, type SyncPolicy } from "@/lib/aiAgent/gdocPlan";
import { OPEN_ORDER_STATUSES } from "@/lib/aiAgent/orders";

export const SYNC_ORDER_COLUMNS =
  "id, ref_code, customer_name, contact_number, items, fulfilment_method, delivery_address, requested_for, notes, status, version, attention, created_at";

const BATCH_SIZE = 40;
const MAX_ITERATIONS = 6;
const MAX_PRECONDITION_RETRIES = 3;
const ORDER_LIMIT = 300;
const WINDOW_MARGIN_MS = 10 * 60_000;

// ── Client ───────────────────────────────────────────────────────────────────
export interface ClientHandle {
  client: DocsClient;
  email: string;
}

let clientFactory: ((businessSlug: string) => Promise<ClientHandle>) | null = null;
/** Tests only: serve every Google call from an in-memory document. Pass null to restore. */
export function setDocsClientFactoryForTests(factory: ((businessSlug: string) => Promise<ClientHandle>) | null): void {
  clientFactory = factory;
}

export class SyncBlocked extends Error {
  health: Health;
  constructor(health: Health, message: string) {
    super(message);
    this.health = health;
  }
}

export async function openClient(businessSlug: string): Promise<ClientHandle> {
  if (clientFactory) return clientFactory(businessSlug);
  const conn = await loadConnection(businessSlug);
  if (!conn) throw new SyncBlocked("needs_reconnect", "Google is not connected. Connect a Google account first.");
  if (conn.status !== "connected") throw new SyncBlocked("needs_reconnect", "Google access was revoked or expired. Reconnect the Google account.");
  const cfg = oauthConfig();
  if (!cfg) throw new SyncBlocked("error", "Google OAuth is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).");
  let refresh: string;
  try {
    refresh = decryptSecret(conn.refresh_token_enc, businessSlug);
  } catch {
    await markConnection(businessSlug, "error", "The stored credential could not be decrypted.");
    throw new SyncBlocked("needs_reconnect", "The stored Google credential could not be read. Reconnect the Google account.");
  }
  try {
    return { client: docsClient(await refreshAccessToken(cfg, refresh)), email: conn.account_email };
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "invalid_grant") {
      await markConnection(businessSlug, "revoked", "Google access was revoked or expired.");
      throw new SyncBlocked("needs_reconnect", "Google access was revoked or expired. Reconnect the Google account.");
    }
    throw err;
  }
}

/** What a Google / blocking error means for the dashboard. Messages never contain credentials. */
export function describeError(err: unknown): { health: Health; message: string } {
  if (err instanceof SyncBlocked) return { health: err.health, message: err.message };
  if (err instanceof GoogleApiError) {
    switch (err.kind) {
      case "invalid_grant":
        return { health: "needs_reconnect", message: "Google access was revoked or expired. Reconnect the Google account." };
      case "forbidden":
        return { health: "no_access", message: "The connected Google account cannot edit this document (or its permission was removed)." };
      case "not_found":
        return { health: "doc_not_found", message: "Google cannot find this document. It may have been deleted, or the connected account cannot see it." };
      case "rate_limited":
        return { health: "error", message: "Google is rate-limiting requests. It will retry on the next run." };
      case "precondition":
        return { health: "error", message: "The document kept changing while syncing. It will retry on the next run." };
      default:
        return { health: "error", message: `Google error: ${err.message.slice(0, 200)}` };
    }
  }
  return { health: "error", message: `Sync failed: ${(err instanceof Error ? err.message : "unknown error").slice(0, 200)}` };
}

// ── Orders ───────────────────────────────────────────────────────────────────
export const policyOf = (s: GdocSettings): SyncPolicy => ({
  format: s.format,
  onCompleted: s.on_completed,
  onCancelled: s.on_cancelled,
  onCorrected: s.on_corrected,
  includeIncomplete: s.include_incomplete,
  syncSince: s.sync_since,
});

async function ordersByIds(businessSlug: string, ids: string[]): Promise<SyncOrder[]> {
  const out: SyncOrder[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SyncOrder[]));
  }
  return out;
}

async function openOrdersSince(businessSlug: string, since: string | null): Promise<SyncOrder[]> {
  let query = agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("status", [...OPEN_ORDER_STATUSES]);
  if (since) query = query.gte("created_at", since);
  const { data, error } = await query.order("created_at").limit(ORDER_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? []) as SyncOrder[];
}

/** Orders the automatic sync must consider: new open ones, ones changed since the last good run, and ones with unresolved lines. */
async function autoCandidates(businessSlug: string, settings: GdocSettings, records: Map<string, LineRow>): Promise<SyncOrder[]> {
  const since = settings.sync_since;
  if (!since) return [];
  const windowStart = new Date(Math.max(Date.parse(since) - 1, Date.parse(settings.last_sync_at ?? since) - WINDOW_MARGIN_MS)).toISOString();
  const [fresh, changed] = await Promise.all([
    openOrdersSince(businessSlug, since),
    agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).gte("updated_at", windowStart).order("created_at").limit(ORDER_LIMIT),
  ]);
  if (changed.error) throw new Error(changed.error.message);
  const byId = new Map<string, SyncOrder>();
  for (const o of fresh) byId.set(o.id, o);
  for (const o of (changed.data ?? []) as SyncOrder[]) byId.set(o.id, o);
  const unresolved = [...records.values()].filter((r) => r.state !== "synced" && !byId.has(r.order_id)).map((r) => r.order_id);
  for (const o of await ordersByIds(businessSlug, unresolved)) byId.set(o.id, o);
  return [...byId.values()];
}

// ── Requests ─────────────────────────────────────────────────────────────────
function editRequests(edits: SyncAction[]): DocRequest[] {
  // Bottom-up, so changing a lower paragraph never moves the indices of one above it.
  const sorted = [...edits].sort((a, b) => (b.write as { paragraph: { start: number } }).paragraph.start - (a.write as { paragraph: { start: number } }).paragraph.start);
  return sorted.flatMap((a) => {
    const w = a.write!;
    if (w.type === "rewrite") return planRewriteLine(w.paragraph, w.text, a.order.ref_code, { done: w.done });
    if (w.type === "remove") return planRemoveLine(w.paragraph);
    return [];
  });
}

const toRecord = (order: SyncOrder, patch: LinePatch, prev: LineRecord | undefined): LineRecord => ({
  order_id: order.id,
  tag: order.ref_code,
  state: patch.state,
  last_text: patch.last_text !== undefined ? patch.last_text : (prev?.last_text ?? null),
  synced_version: patch.synced_version ?? prev?.synced_version ?? null,
  synced_status: patch.synced_status ?? prev?.synced_status ?? null,
  attempts: 0,
});

export interface SyncSummary {
  status: "ok" | "disabled" | "busy" | "blocked" | "error" | "not_ready";
  inserted: number;
  updated: number;
  removed: number;
  held: number;
  failed: number;
  health?: Health;
  message?: string;
}

const emptySummary = (status: SyncSummary["status"], message?: string): SyncSummary => ({ status, inserted: 0, updated: 0, removed: 0, held: 0, failed: 0, message });

export interface RunOptions {
  /** "auto" lists orders created since sync was enabled; "import" lists exactly `orderIds` (the explicit one-time import). */
  mode?: Mode;
  orderIds?: string[];
  force?: boolean;
  /** A dashboard action may run while sync is switched off (never an import or an automatic run). */
  allowDisabled?: boolean;
  /** A person approved held corrections: apply them instead of holding them again. */
  approve?: boolean;
}

/** One sync pass for one business. Idempotent: running it twice in a row changes nothing the second time. */
export async function runSync(businessSlug: string, options: RunOptions = {}): Promise<SyncSummary> {
  const mode: Mode = options.mode ?? "auto";
  const settings = await loadGdocSettings(businessSlug);
  if (!settings) return emptySummary("not_ready", "Google Docs sync is not set up in the database yet.");
  if (!settings.enabled && !options.allowDisabled) return emptySummary("disabled");
  if (!settings.document_id || !settings.can_edit) return emptySummary("not_ready", "Choose a document the connected account can edit.");
  if (mode === "auto" && !settings.sync_since) return emptySummary("not_ready", "Sync has not been enabled yet.");

  const token = await claimSync(businessSlug);
  if (!token) return emptySummary("busy");
  const summary = emptySummary("ok");
  const documentId = settings.document_id;
  try {
    const { client } = await openClient(businessSlug);
    const rows = await loadLines(businessSlug, documentId);
    const records = new Map<string, LineRow>(rows.map((r) => [r.order_id, r]));
    const policy: SyncPolicy = options.approve ? { ...policyOf(settings), onCorrected: "update" } : policyOf(settings);
    const orders =
      mode === "import" ? await ordersByIds(businessSlug, [...new Set(options.orderIds ?? [])].slice(0, ORDER_LIMIT)) : await autoCandidates(businessSlug, settings, records);

    let preconditionRetries = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      let doc: GoogleDocument = await client.getDocument(documentId);
      let section = findSection(doc, businessSlug);
      if (section.kind === "broken") throw new SyncBlocked("section_problem", section.reason);

      let plan = planSync({ orders, records, doc, policy, mode, force: options.force });
      const inserts = plan.actions.filter((a) => a.write?.type === "insert");

      if (inserts.length > 0 && section.kind === "none") {
        const position = resolvePosition(doc, settings.insertion);
        if (!position.ok) throw new SyncBlocked("section_problem", position.reason);
        await client.batchUpdate(documentId, planCreateSection(businessSlug, position).requests, doc.revisionId);
        await saveGdocSettings(businessSlug, { section_created_at: new Date().toISOString() });
        doc = await client.getDocument(documentId);
        section = findSection(doc, businessSlug);
        if (section.kind !== "found") throw new SyncBlocked("section_problem", "The AI section could not be created in the document.");
        plan = planSync({ orders, records, doc, policy, mode, force: options.force });
      }

      // Record-only outcomes (conflicts, held corrections, adopted lines, policy "leave"): no document write.
      const recordOnly = plan.actions.filter((a) => !a.write);
      for (const a of recordOnly) {
        await upsertLine(businessSlug, documentId, a.order, a.patch);
        records.set(a.order.id, { ...(records.get(a.order.id) as LineRow), ...toRecord(a.order, a.patch, records.get(a.order.id)) } as LineRow);
        if (a.patch.state === "conflict" || a.patch.state === "pending_review" || a.patch.state === "missing") summary.held += 1;
      }

      const edits = plan.actions.filter((a) => a.write && a.write.type !== "insert");
      const writes = (edits.length > 0 ? edits : plan.actions.filter((a) => a.write?.type === "insert")).slice(0, BATCH_SIZE);
      if (writes.length === 0) break;

      const requests = edits.length > 0 ? editRequests(writes) : writes.flatMap((a) => planInsertLine(section as Extract<typeof section, { kind: "found" }>, (a.write as { text: string }).text, a.order.ref_code));
      try {
        await client.batchUpdate(documentId, requests, doc.revisionId);
      } catch (err) {
        if (err instanceof GoogleApiError && err.kind === "precondition" && preconditionRetries < MAX_PRECONDITION_RETRIES) {
          preconditionRetries += 1; // a person edited the document since we read it: re-read and re-plan
          continue;
        }
        for (const a of writes) {
          const prev = records.get(a.order.id);
          await upsertLine(businessSlug, documentId, a.order, { state: "failed", last_text: prev?.last_text ?? null }, { attempts: (prev?.attempts ?? 0) + 1, last_error: describeError(err).message });
          summary.failed += 1;
        }
        throw err;
      }
      for (const a of writes) {
        await upsertLine(businessSlug, documentId, a.order, a.patch, { wrote: true });
        records.set(a.order.id, { ...(records.get(a.order.id) as LineRow), ...toRecord(a.order, a.patch, records.get(a.order.id)) } as LineRow);
        const type = a.write!.type;
        if (type === "insert") summary.inserted += 1;
        else if (type === "remove") summary.removed += 1;
        else summary.updated += 1;
      }
    }
    await saveGdocSettings(businessSlug, { last_sync_at: new Date().toISOString(), health: "ok", last_error: null });
    return summary;
  } catch (err) {
    const { health, message } = describeError(err);
    summary.status = err instanceof SyncBlocked ? "blocked" : "error";
    summary.health = health;
    summary.message = message;
    await saveGdocSettings(businessSlug, { health, last_error: message }).catch((e) => console.error("[gdocs] could not record error", e));
    if (health === "error" && !(err instanceof GoogleApiError)) console.error("[gdocs] sync failed", err);
    return summary;
  } finally {
    await releaseSync(businessSlug, token);
  }
}

// ── Triggers ─────────────────────────────────────────────────────────────────
/** After an order is created or changed. Cheap when the feature is off or not set up; never throws into the order flow. */
export async function triggerOrderSync(businessSlug: string): Promise<void> {
  try {
    const { data, error } = await agentDb().from("ai_agent_gdoc_settings").select("enabled").eq("business_slug", businessSlug).maybeSingle();
    if (error || !data || (data as { enabled?: boolean }).enabled !== true) return;
    await runSync(businessSlug);
  } catch (err) {
    if (!isSchemaPending(err)) console.error("[gdocs] order trigger", err instanceof Error ? err.message : err);
  }
}

/** Cron tick: every enabled business, most recently attempted last. */
export async function runDueGoogleDocSyncs(limit = 10): Promise<{ businesses: number; results: Record<string, SyncSummary["status"]> }> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_settings").select("business_slug").eq("enabled", true).order("last_attempt_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) {
    if (isSchemaPending(error)) return { businesses: 0, results: {} };
    throw new Error(error.message);
  }
  const results: Record<string, SyncSummary["status"]> = {};
  for (const row of (data ?? []) as { business_slug: string }[]) {
    results[row.business_slug] = (await runSync(row.business_slug)).status;
  }
  return { businesses: Object.keys(results).length, results };
}
