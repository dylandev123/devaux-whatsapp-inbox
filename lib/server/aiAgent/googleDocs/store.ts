// Server-only: service-role access to the Google Docs sync tables (supabase/migrations/20261112000000). Every query is
// filtered by business_slug — the isolation boundary: one business can never read or use another's connection, document or lines.
// When the migration has not been run every read reports "setup pending" instead of throwing, so the rest of the app is unaffected.

import { randomUUID } from "crypto";
import { agentDb } from "@/lib/server/aiAgent/db";
import { defaultFormat, normalizeFormat, type FormatConfig } from "@/lib/aiAgent/gdocFormat";

export function isSchemaPending(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const m = (e?.message ?? (typeof err === "string" ? err : "")).toLowerCase();
  return ["42P01", "42883", "PGRST205", "PGRST202"].includes(e?.code ?? "") || m.includes("could not find the table") || m.includes("could not find the function") || m.includes("does not exist") || m.includes("schema cache");
}

export type Health = "ok" | "needs_reconnect" | "no_access" | "doc_not_found" | "insufficient_scope" | "document_problem" | "error";

export interface GdocSettings {
  business_slug: string;
  enabled: boolean;
  document_id: string | null;
  document_title: string | null;
  can_edit: boolean;
  access_verified_at: string | null;
  format: FormatConfig;
  include_incomplete: boolean;
  sync_since: string | null;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  health: Health;
  last_error: string | null;
}

const SETTINGS_COLUMNS =
  "business_slug, enabled, document_id, document_title, can_edit, access_verified_at, format, include_incomplete, sync_since, last_sync_at, last_attempt_at, health, last_error";

function hydrate(row: Record<string, unknown>): GdocSettings {
  return { ...(row as unknown as GdocSettings), format: normalizeFormat(row.format) };
}

export const defaultSettings = (businessSlug: string): GdocSettings => ({
  business_slug: businessSlug,
  enabled: false,
  document_id: null,
  document_title: null,
  can_edit: false,
  access_verified_at: null,
  format: defaultFormat(),
  include_incomplete: true,
  sync_since: null,
  last_sync_at: null,
  last_attempt_at: null,
  health: "ok",
  last_error: null,
});

/** null = the migration has not been run. A business that never configured anything gets the (disabled) defaults. */
export async function loadGdocSettings(businessSlug: string): Promise<GdocSettings | null> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_settings").select(SETTINGS_COLUMNS).eq("business_slug", businessSlug).maybeSingle();
  if (error) {
    if (isSchemaPending(error)) return null;
    throw new Error(error.message);
  }
  return data ? hydrate(data as Record<string, unknown>) : defaultSettings(businessSlug);
}

export async function saveGdocSettings(businessSlug: string, patch: Partial<Omit<GdocSettings, "business_slug">>, updatedBy?: string | null): Promise<GdocSettings> {
  const row: Record<string, unknown> = { business_slug: businessSlug, ...patch };
  if (updatedBy !== undefined) row.updated_by = updatedBy;
  const { error } = await agentDb().from("ai_agent_gdoc_settings").upsert(row, { onConflict: "business_slug" });
  if (error) throw new Error(error.message);
  const loaded = await loadGdocSettings(businessSlug);
  if (!loaded) throw new Error("Google Docs sync is not set up in the database yet");
  return loaded;
}

// ── Connection (encrypted refresh token) ─────────────────────────────────────
export interface ConnectionRow {
  business_slug: string;
  account_email: string;
  refresh_token_enc: string;
  scopes: string[];
  status: "connected" | "revoked" | "error";
  last_error: string | null;
  connected_at: string;
}

const CONNECTION_COLUMNS = "business_slug, account_email, refresh_token_enc, scopes, status, last_error, connected_at";

export async function loadConnection(businessSlug: string): Promise<ConnectionRow | null> {
  const { data, error } = await agentDb().from("ai_agent_google_connections").select(CONNECTION_COLUMNS).eq("business_slug", businessSlug).maybeSingle();
  if (error) {
    if (isSchemaPending(error)) return null;
    throw new Error(error.message);
  }
  return (data as ConnectionRow | null) ?? null;
}

export async function saveConnection(row: { business_slug: string; account_email: string; refresh_token_enc: string; scopes: string[]; connected_by: string }): Promise<void> {
  const { error } = await agentDb()
    .from("ai_agent_google_connections")
    .upsert({ ...row, status: "connected", last_error: null, connected_at: new Date().toISOString() }, { onConflict: "business_slug" });
  if (error) throw new Error(error.message);
}

export async function markConnection(businessSlug: string, status: "connected" | "revoked" | "error", lastError: string | null): Promise<void> {
  const { error } = await agentDb().from("ai_agent_google_connections").update({ status, last_error: lastError }).eq("business_slug", businessSlug);
  if (error && !isSchemaPending(error)) console.error("[gdocs] markConnection", error.message);
}

export async function deleteConnection(businessSlug: string): Promise<void> {
  const { error } = await agentDb().from("ai_agent_google_connections").delete().eq("business_slug", businessSlug);
  if (error) throw new Error(error.message);
}

// ── Lines ────────────────────────────────────────────────────────────────────
// One row per (business, document, order). The unique index on that triple is what makes "one order, one line" a database
// guarantee: claim_gdoc_line() hands the single insert attempt to exactly one caller.
export type LineState = "synced" | "inserting" | "unconfirmed" | "failed" | "skipped" | "pending_review" | "conflict" | "missing";

export interface LineRow {
  id: string;
  business_slug: string;
  document_id: string;
  order_id: string;
  tag: string;
  state: LineState;
  last_text: string | null;
  attempts: number;
  attempt_id: string | null;
  attempt_started_at: string | null;
  verify_attempts: number;
  last_verify_at: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

const LINE_COLUMNS =
  "id, business_slug, document_id, order_id, tag, state, last_text, attempts, attempt_id, attempt_started_at, verify_attempts, last_verify_at, last_error, last_synced_at, updated_at";

export async function loadLines(businessSlug: string, documentId: string): Promise<LineRow[]> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_lines").select(LINE_COLUMNS).eq("business_slug", businessSlug).eq("document_id", documentId).limit(5000);
  if (error) {
    if (isSchemaPending(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as LineRow[];
}

/** The rows for just these orders (what a run needs to decide who is still to be written). */
export async function loadLinesForOrders(businessSlug: string, documentId: string, orderIds: string[]): Promise<LineRow[]> {
  const out: LineRow[] = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    const { data, error } = await agentDb().from("ai_agent_gdoc_lines").select(LINE_COLUMNS).eq("business_slug", businessSlug).eq("document_id", documentId).in("order_id", orderIds.slice(i, i + 100));
    if (error) {
      if (isSchemaPending(error)) return [];
      throw new Error(error.message);
    }
    out.push(...((data ?? []) as LineRow[]));
  }
  return out;
}

export async function loadLinesByState(businessSlug: string, documentId: string, states: LineState[]): Promise<LineRow[]> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_lines").select(LINE_COLUMNS).eq("business_slug", businessSlug).eq("document_id", documentId).in("state", states).order("updated_at", { ascending: false }).limit(200);
  if (error) {
    if (isSchemaPending(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as LineRow[];
}

export async function loadLine(businessSlug: string, documentId: string, lineId: string): Promise<LineRow | null> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_lines").select(LINE_COLUMNS).eq("business_slug", businessSlug).eq("document_id", documentId).eq("id", lineId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LineRow | null) ?? null;
}

/**
 * Start the single insert attempt for an order. True = this caller owns it and may write; false = another run owns it or the
 * order is already in the document (or in an unknown state that only verification / a person may settle).
 */
export async function claimLine(businessSlug: string, documentId: string, order: { id: string; ref_code: string }, attemptId: string): Promise<boolean> {
  const { data, error } = await agentDb().rpc("claim_gdoc_line", { p_business_slug: businessSlug, p_document_id: documentId, p_order_id: order.id, p_tag: order.ref_code, p_attempt_id: attemptId });
  if (error) throw new Error(error.message);
  return data === true;
}

interface LineKey {
  businessSlug: string;
  documentId: string;
  orderId: string;
}

/** Record the outcome of an attempt. Guarded by the attempt id, so a late or zombie run can never overwrite a newer attempt. */
export async function finishAttempt(key: LineKey, attemptId: string, patch: { state: "synced" | "failed" | "unconfirmed"; last_text?: string | null; last_error?: string | null }): Promise<void> {
  const row: Record<string, unknown> = { ...patch, last_error: patch.last_error ?? null };
  if (patch.state === "synced") row.last_synced_at = new Date().toISOString();
  const { error } = await agentDb().from("ai_agent_gdoc_lines").update(row).eq("business_slug", key.businessSlug).eq("document_id", key.documentId).eq("order_id", key.orderId).eq("attempt_id", attemptId).in("state", ["inserting", "unconfirmed"]);
  if (error) throw new Error(error.message);
}

/** Outcome of a verification read for a row whose insert outcome was unknown. */
export async function settleLine(key: LineKey, patch: { state: "synced" | "failed" | "unconfirmed"; last_error?: string | null; verify_attempts: number }): Promise<void> {
  const row: Record<string, unknown> = { ...patch, last_error: patch.last_error ?? null, last_verify_at: new Date().toISOString() };
  if (patch.state === "synced") row.last_synced_at = new Date().toISOString();
  const { error } = await agentDb().from("ai_agent_gdoc_lines").update(row).eq("business_slug", key.businessSlug).eq("document_id", key.documentId).eq("order_id", key.orderId).in("state", ["inserting", "unconfirmed"]);
  if (error) throw new Error(error.message);
}

/** A person's decision about a line (dashboard): any state to synced / failed (insert again) / skipped. */
export async function setLineState(key: LineKey, state: "synced" | "failed" | "skipped"): Promise<void> {
  const row: Record<string, unknown> = { state, last_error: null, attempt_id: null };
  if (state === "synced") row.last_synced_at = new Date().toISOString();
  const { error } = await agentDb().from("ai_agent_gdoc_lines").update(row).eq("business_slug", key.businessSlug).eq("document_id", key.documentId).eq("order_id", key.orderId);
  if (error) throw new Error(error.message);
}

// ── Lease ────────────────────────────────────────────────────────────────────
export async function claimSync(businessSlug: string, ttlSeconds = 90): Promise<string | null> {
  const token = randomUUID();
  const { data, error } = await agentDb().rpc("claim_gdoc_sync", { p_business_slug: businessSlug, p_token: token, p_ttl_seconds: ttlSeconds });
  if (error) {
    if (isSchemaPending(error)) return null;
    throw new Error(error.message);
  }
  return data === true ? token : null;
}

export async function releaseSync(businessSlug: string, token: string): Promise<void> {
  const { error } = await agentDb().rpc("release_gdoc_sync", { p_business_slug: businessSlug, p_token: token });
  if (error) console.error("[gdocs] release", error.message);
}
