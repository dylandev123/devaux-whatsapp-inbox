// Server-only: the Google Docs order sync engine. APPEND-ONLY AT THE TOP: a new actionable order becomes one new paragraph at
// the very start of the document's first tab (lib/aiAgent/gdocInsert.ts). Nothing already in the document is read, rewritten,
// deleted or reordered; staff edit lines by hand. Supabase stays the authoritative order record. It never sends a WhatsApp
// message (it does not import the outbox) and never runs while sync is disabled.
//
// The document can be hundreds of pages, so a normal run makes NO document read: it reads orders and line rows from Supabase
// and sends one small insertText per new order.
//
// Duplicate prevention and the crash window
//   1. Before writing, the order's line row is claimed in the database (claim_gdoc_line, one atomic statement against a unique
//      index): only one caller can ever hold the attempt for an order, whatever the number of runs, triggers or retries.
//   2. The write is one atomic batchUpdate. Afterwards the row is marked 'synced'.
//   3. The window between "Google applied the write" and "the row says synced" (a crash, a lost response, a timeout) cannot be
//      closed from this side: Google offers no idempotency key. So this is AT-LEAST-ONCE with detection, not exactly-once:
//        * an explicit Google refusal (4xx) means the document is unchanged → row 'failed' → safely retried;
//        * anything else (timeout, network, 5xx, a crash) leaves the row 'inserting'/'unconfirmed' → the order is NEVER
//          written again automatically. After a settle period a text-only read looks for the order's small tag ⟨E-xxxxx⟩
//          in the first tab: found → 'synced'; absent → 'failed' (retry); read impossible → stays 'unconfirmed' and shows in
//          the dashboard, where a person chooses "it is there" / "add again" / "skip".
//      Residual risk, stated plainly: if Google were to apply an abandoned request later than the settle period, or a person
//      deletes the line before it is verified, a duplicate/omission is possible and is shown to staff, never hidden.
//
// No timers are used here (see tests/aiAgentBatchWiring): retries happen on the next cron tick or dashboard action.

import { randomUUID } from "crypto";
import { agentDb } from "@/lib/server/aiAgent/db";
import { decryptSecret } from "@/lib/server/aiAgent/googleDocs/crypto";
import { docsClient, GoogleApiError, oauthConfig, refreshAccessToken, TIMEOUT_MS, VERIFY_TIMEOUT_MS, WRITE_TIMEOUT_MS, type DocsClient } from "@/lib/server/aiAgent/googleDocs/google";
import {
  claimLine,
  claimSync,
  finishAttempt,
  isSchemaPending,
  loadConnection,
  loadGdocSettings,
  loadLinesByState,
  loadLinesForOrders,
  markConnection,
  releaseSync,
  saveGdocSettings,
  settleLine,
  type GdocSettings,
  type Health,
  type LineRow,
} from "@/lib/server/aiAgent/googleDocs/store";
import { formatOrderLine } from "@/lib/aiAgent/gdocFormat";
import { insertLineRequests, planInsertions, type InsertPolicy, type Mode, type SyncOrder } from "@/lib/aiAgent/gdocInsert";
import { OPEN_ORDER_STATUSES } from "@/lib/aiAgent/orders";

export const SYNC_ORDER_COLUMNS = "id, ref_code, customer_name, contact_number, items, fulfilment_method, delivery_address, requested_for, notes, status, attention, created_at";

const ORDER_LIMIT = 500;
/** Orders written per run (one small request each); the rest waits for the next tick. */
const MAX_INSERTS_PER_RUN = 15;
/** An attempt of unknown outcome is only judged after this long, so a slow request still in flight cannot be mistaken for lost. */
export const SETTLE_MS = 120_000;
/** Between verification reads of the same unconfirmed line (each read downloads the first tab's text). */
const VERIFY_COOLDOWN_MS = 10 * 60_000;
/** After this many unsuccessful verification reads the line is left to a person. */
export const MAX_VERIFY_ATTEMPTS = 6;
/** After a failed run the automatic triggers wait this long, so one outage is not hammered by every incoming order. */
const BACKOFF_MS = 5 * 60_000;
const DEFAULT_BUDGET_MS = 50_000;

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
        return { health: "no_access", message: "The connected Google account does not have permission to open this document. Share it with that account (edit access), then test again." };
      case "insufficient_scope":
        return { health: "insufficient_scope", message: "The Google connection is missing a required permission (Docs or Drive). Disconnect, then connect again and allow every requested permission." };
      case "api_disabled":
        return { health: "error", message: "Google API error: the Google Docs or Google Drive API is not enabled for the app’s Google Cloud project. Enable both APIs in Google Cloud Console, then try again." };
      case "not_found":
        return { health: "doc_not_found", message: "Google cannot find this document. It may have been deleted, or the connected account cannot see it." };
      case "rate_limited":
        return { health: "error", message: "Google is rate-limiting requests. It will retry on the next run." };
      case "timeout":
        return { health: "error", message: `Google took too long to answer (${err.op ?? "request"} timed out). ${err.op === "Docs write" ? "The line may or may not have been added: it is checked in the document before it is ever added again." : "Nothing was changed."} Try again in a moment; if it keeps happening, check status.cloud.google.com.` };
      case "network":
        return { health: "error", message: `Could not reach Google (${err.op ?? "request"}). ${err.op === "Docs write" ? "The line may or may not have been added: it is checked in the document before it is ever added again." : "Nothing was changed."} Try again in a moment.` };
      case "bad_request":
        if (err.op === "Docs write") {
          return {
            health: "document_problem",
            message: `Google would not add text at the very start of the first tab (${err.message.slice(0, 120)}). The document may begin with a table or another element that cannot take text above it. Put an empty paragraph at the top of the document, then press “Sync now”.`,
          };
        }
        return { health: "error", message: `Google error: ${err.message.slice(0, 200)}` };
      default:
        return { health: "error", message: `Google error: ${err.message.slice(0, 200)}` };
    }
  }
  return { health: "error", message: `Sync failed: ${(err instanceof Error ? err.message : "unknown error").slice(0, 200)}` };
}

// ── Orders ───────────────────────────────────────────────────────────────────
export const policyOf = (s: GdocSettings): InsertPolicy => ({ format: s.format, includeIncomplete: s.include_incomplete, syncSince: s.sync_since });

export async function ordersByIds(businessSlug: string, ids: string[]): Promise<SyncOrder[]> {
  const out: SyncOrder[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SyncOrder[]));
  }
  return out;
}

/** Open orders created at or after `since` (or all open orders when null), oldest first. */
export async function openOrders(businessSlug: string, since: string | null): Promise<SyncOrder[]> {
  let query = agentDb().from("ai_agent_orders").select(SYNC_ORDER_COLUMNS).eq("business_slug", businessSlug).in("status", [...OPEN_ORDER_STATUSES]);
  if (since) query = query.gte("created_at", since);
  const { data, error } = await query.order("created_at").limit(ORDER_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? []) as SyncOrder[];
}

// ── Run ──────────────────────────────────────────────────────────────────────
export interface SyncSummary {
  status: "ok" | "disabled" | "busy" | "waiting" | "blocked" | "error" | "not_ready";
  /** Lines added to the document in this run. */
  inserted: number;
  /** Lines whose earlier, uncertain write was found in the document (marked done, not written again). */
  confirmed: number;
  /** Lines whose result is still unknown and need a person. */
  unconfirmed: number;
  failed: number;
  health?: Health;
  message?: string;
}

const emptySummary = (status: SyncSummary["status"], message?: string): SyncSummary => ({ status, inserted: 0, confirmed: 0, unconfirmed: 0, failed: 0, message });

export interface RunOptions {
  /** "auto" lists orders created since sync was enabled; "import" lists exactly `orderIds` (the explicit one-time import). */
  mode?: Mode;
  orderIds?: string[];
  /** A dashboard action may run while sync is switched off (never an import or an automatic run). */
  allowDisabled?: boolean;
  /** Triggered by an order or the cron tick: after a failed run, wait out the backoff instead of retrying at once. */
  backoff?: boolean;
  /** A person pressed a button: verify unconfirmed lines now instead of waiting for the cooldown. */
  manual?: boolean;
  /** How long this run may take in total (the hosting function has a hard limit). */
  budgetMs?: number;
}

/** One sync pass for one business. Idempotent: running it twice in a row changes nothing the second time. */
export async function runSync(businessSlug: string, options: RunOptions = {}): Promise<SyncSummary> {
  const mode: Mode = options.mode ?? "auto";
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const remaining = () => deadline - Date.now();
  const settings = await loadGdocSettings(businessSlug);
  if (!settings) return emptySummary("not_ready", "Google Docs sync is not set up in the database yet.");
  if (!settings.enabled && !options.allowDisabled) return emptySummary("disabled");
  if (!settings.document_id || !settings.can_edit) return emptySummary("not_ready", "Choose a document the connected account can edit.");
  if (mode === "auto" && !settings.sync_since) return emptySummary("not_ready", "Sync has not been enabled yet.");
  if (options.backoff && settings.health !== "ok" && settings.last_attempt_at && Date.now() - Date.parse(settings.last_attempt_at) < BACKOFF_MS) return emptySummary("waiting", settings.last_error ?? undefined);

  const token = await claimSync(businessSlug, Math.max(90, Math.ceil((options.budgetMs ?? DEFAULT_BUDGET_MS) / 1000) + 30));
  if (!token) return emptySummary("busy");
  const summary = emptySummary("ok");
  const documentId = settings.document_id;
  try {
    const { client } = await openClient(businessSlug);

    // 1. Settle earlier attempts whose outcome is unknown (crash / lost response). Never writes.
    await reconcile(businessSlug, documentId, client, summary, remaining, options.manual === true);

    // 2. Insert the orders that have no line yet (or whose last attempt definitely failed), oldest first so the newest ends on top.
    const orders = mode === "import" ? await ordersByIds(businessSlug, [...new Set(options.orderIds ?? [])].slice(0, ORDER_LIMIT)) : settings.sync_since ? await openOrders(businessSlug, settings.sync_since) : [];
    const states = new Map((await loadLinesForOrders(businessSlug, documentId, orders.map((o) => o.id))).map((r) => [r.order_id, r.state as string]));
    const plan = planInsertions(orders, states, policyOf(settings), mode);
    for (const order of plan.insert.slice(0, MAX_INSERTS_PER_RUN)) {
      if (remaining() < WRITE_TIMEOUT_MS / 2) break; // out of time: the rest goes in on the next tick
      const attemptId = randomUUID();
      if (!(await claimLine(businessSlug, documentId, order, attemptId))) continue; // someone else owns this order's attempt
      const key = { businessSlug, documentId, orderId: order.id };
      const text = formatOrderLine(order, settings.format).text;
      try {
        await writeLine(client, documentId, text, order.ref_code, Math.min(WRITE_TIMEOUT_MS, Math.max(5_000, remaining() - 2_000)));
      } catch (err) {
        const message = describeError(err).message;
        // An explicit Google refusal proves the document is unchanged → safe to retry. Anything else may have been applied.
        const unknown = !(err instanceof GoogleApiError) || err.outcomeUnknown;
        await finishAttempt(key, attemptId, { state: unknown ? "unconfirmed" : "failed", last_error: message });
        if (unknown) summary.unconfirmed += 1;
        else summary.failed += 1;
        throw err;
      }
      await recordSuccess(key, attemptId, text);
      summary.inserted += 1;
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

/** The styled insert; if Google refuses the styling requests, the bare insert still puts the order in the document. */
async function writeLine(client: DocsClient, documentId: string, text: string, refCode: string, timeoutMs: number): Promise<void> {
  try {
    await client.batchUpdate(documentId, insertLineRequests(text, refCode), timeoutMs);
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.kind !== "bad_request") throw err;
    await client.batchUpdate(documentId, insertLineRequests(text, refCode, { styled: false }), timeoutMs);
  }
}

/**
 * The write reached Google; now record it. The record is retried immediately a few times (a transient database blip must not
 * leave a written line unrecorded). If it still fails, the row stays 'inserting' and the verification above settles it later.
 */
async function recordSuccess(key: { businessSlug: string; documentId: string; orderId: string }, attemptId: string, text: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 3; i += 1) {
    try {
      await finishAttempt(key, attemptId, { state: "synced", last_text: text });
      return;
    } catch (err) {
      last = err;
    }
  }
  console.error("[gdocs] line written but not recorded; it will be verified by its tag", key.orderId, last instanceof Error ? last.message : last);
  throw last;
}

/**
 * Settles lines whose insert outcome is unknown by looking for their tag in the first tab's text (ONE bounded read for all of
 * them). Found → synced. Absent from a successful read → failed (retryable). Read failed → unconfirmed, tried again later, and
 * after MAX_VERIFY_ATTEMPTS left to a person. Never writes to the document.
 */
async function reconcile(businessSlug: string, documentId: string, client: DocsClient, summary: SyncSummary, remaining: () => number, manual: boolean): Promise<void> {
  const now = Date.now();
  const due = (await loadLinesByState(businessSlug, documentId, ["inserting", "unconfirmed"])).filter((row) => {
    if (now - Date.parse(row.attempt_started_at ?? row.updated_at) < SETTLE_MS) return false; // may still be in flight
    if (manual) return true;
    if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS) return false;
    return !row.last_verify_at || now - Date.parse(row.last_verify_at) >= VERIFY_COOLDOWN_MS;
  });
  if (due.length === 0) return;
  // Verification comes first; whatever time is left afterwards decides how many new lines this run can still add.
  const timeoutMs = Math.min(VERIFY_TIMEOUT_MS, remaining() - 5_000);
  if (timeoutMs < 5_000) return; // not enough time left in this run; the next one will verify
  let found: Set<string> | null = null;
  let failure: string | null = null;
  try {
    found = await client.findTags(documentId, due.map((r) => r.tag), timeoutMs);
  } catch (err) {
    if (err instanceof GoogleApiError && (err.kind === "invalid_grant" || err.kind === "insufficient_scope" || err.kind === "api_disabled")) throw err;
    failure = describeError(err).message;
  }
  for (const row of due) {
    const key = { businessSlug, documentId, orderId: row.order_id };
    if (found === null) {
      await settleLine(key, { state: "unconfirmed", last_error: failure, verify_attempts: row.verify_attempts + 1 });
      summary.unconfirmed += 1;
    } else if (found.has(row.tag)) {
      await settleLine(key, { state: "synced", verify_attempts: row.verify_attempts + 1 });
      summary.confirmed += 1;
    } else {
      await settleLine(key, { state: "failed", last_error: "The earlier attempt did not reach the document; it will be added again.", verify_attempts: row.verify_attempts + 1 });
    }
  }
}

// ── Triggers ─────────────────────────────────────────────────────────────────
/** True when a row still needs a person (unknown outcome that verification cannot settle). */
export const needsPerson = (row: Pick<LineRow, "state" | "verify_attempts">): boolean => row.state === "unconfirmed" && row.verify_attempts >= MAX_VERIFY_ATTEMPTS;

/**
 * After an order is created or changed. NOT part of the order flow's critical path: it returns at once with the work already
 * running, and tells the host to keep the function alive until it finishes (Next.js `after`) without delaying the response.
 * Cheap when the feature is off; never throws into the order flow. A run that is cut short is simply continued by the cron tick.
 */
export function triggerOrderSync(businessSlug: string): Promise<void> {
  const task = (async () => {
    try {
      const { data, error } = await agentDb().from("ai_agent_gdoc_settings").select("enabled").eq("business_slug", businessSlug).maybeSingle();
      if (error || !data || (data as { enabled?: boolean }).enabled !== true) return;
      await runSync(businessSlug, { backoff: true, budgetMs: 40_000 });
    } catch (err) {
      if (!isSchemaPending(err)) console.error("[gdocs] order trigger", err instanceof Error ? err.message : err);
    }
  })();
  keepAlive(task);
  return task;
}

function keepAlive(task: Promise<void>): void {
  import("next/server").then(
    ({ after }) => {
      try {
        after(task);
      } catch {
        // Not inside a request (a script, a test): the promise simply runs to completion on its own.
      }
    },
    () => undefined
  );
}

/** Cron tick: every enabled business, longest-waiting first, within the time left in the function. */
export async function runDueGoogleDocSyncs(limit = 10, budgetMs = DEFAULT_BUDGET_MS): Promise<{ businesses: number; results: Record<string, SyncSummary["status"]> }> {
  const deadline = Date.now() + budgetMs;
  const { data, error } = await agentDb().from("ai_agent_gdoc_settings").select("business_slug").eq("enabled", true).order("last_attempt_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) {
    if (isSchemaPending(error)) return { businesses: 0, results: {} };
    throw new Error(error.message);
  }
  const results: Record<string, SyncSummary["status"]> = {};
  for (const row of (data ?? []) as { business_slug: string }[]) {
    const left = deadline - Date.now();
    if (left < TIMEOUT_MS) break;
    results[row.business_slug] = (await runSync(row.business_slug, { backoff: true, budgetMs: left })).status;
  }
  return { businesses: Object.keys(results).length, results };
}
