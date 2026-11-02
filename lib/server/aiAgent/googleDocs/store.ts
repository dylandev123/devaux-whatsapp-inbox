// Server-only: service-role access to the Google Docs sync tables (supabase/migrations/20261112000000). Every query is
// filtered by business_slug — the isolation boundary: one business can never read or use another's connection, document or lines.
// When the migration has not been run every read reports "setup pending" instead of throwing, so the rest of the app is unaffected.

import { randomUUID } from "crypto";
import { agentDb } from "@/lib/server/aiAgent/db";
import { defaultFormat, normalizeFormat, type FormatConfig } from "@/lib/aiAgent/gdocFormat";
import { normalizeInsertion, type Insertion } from "@/lib/aiAgent/gdocDocument";
import type { LinePatch, LineRecord, OnCorrected, OnFinished } from "@/lib/aiAgent/gdocPlan";

export function isSchemaPending(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const m = (e?.message ?? (typeof err === "string" ? err : "")).toLowerCase();
  return ["42P01", "42883", "PGRST205", "PGRST202"].includes(e?.code ?? "") || m.includes("could not find the table") || m.includes("could not find the function") || m.includes("does not exist") || m.includes("schema cache");
}

export type Health = "ok" | "needs_reconnect" | "no_access" | "doc_not_found" | "insufficient_scope" | "section_problem" | "error";

export interface GdocSettings {
  business_slug: string;
  enabled: boolean;
  document_id: string | null;
  document_title: string | null;
  can_edit: boolean;
  access_verified_at: string | null;
  format: FormatConfig;
  insertion: Insertion;
  on_completed: OnFinished;
  on_cancelled: OnFinished;
  on_corrected: OnCorrected;
  include_incomplete: boolean;
  sync_since: string | null;
  section_created_at: string | null;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  health: Health;
  last_error: string | null;
}

const SETTINGS_COLUMNS =
  "business_slug, enabled, document_id, document_title, can_edit, access_verified_at, format, insertion, on_completed, on_cancelled, on_corrected, include_incomplete, sync_since, section_created_at, last_sync_at, last_attempt_at, health, last_error";

function hydrate(row: Record<string, unknown>): GdocSettings {
  return { ...(row as unknown as GdocSettings), format: normalizeFormat(row.format), insertion: normalizeInsertion(row.insertion) };
}

export const defaultSettings = (businessSlug: string): GdocSettings => ({
  business_slug: businessSlug,
  enabled: false,
  document_id: null,
  document_title: null,
  can_edit: false,
  access_verified_at: null,
  format: defaultFormat(),
  insertion: { kind: "top" },
  on_completed: "mark",
  on_cancelled: "mark",
  on_corrected: "update",
  include_incomplete: true,
  sync_since: null,
  section_created_at: null,
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
export interface LineRow extends LineRecord {
  id: string;
  business_slug: string;
  document_id: string;
  pending_text: string | null;
  pending_action: string | null;
  pending_reason: string | null;
  found_text: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

const LINE_COLUMNS =
  "id, business_slug, document_id, order_id, tag, state, last_text, synced_version, synced_status, pending_text, pending_action, pending_reason, found_text, attempts, last_error, last_synced_at, updated_at";

export async function loadLines(businessSlug: string, documentId: string): Promise<LineRow[]> {
  const { data, error } = await agentDb().from("ai_agent_gdoc_lines").select(LINE_COLUMNS).eq("business_slug", businessSlug).eq("document_id", documentId).limit(5000);
  if (error) {
    if (isSchemaPending(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as LineRow[];
}

export async function loadLinesByState(businessSlug: string, documentId: string, states: string[]): Promise<LineRow[]> {
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

/** Create or update the order's line row. A successful write clears the attempt counter and the error. */
export async function upsertLine(businessSlug: string, documentId: string, order: { id: string; ref_code: string }, patch: LinePatch, extra: { attempts?: number; last_error?: string | null; wrote?: boolean } = {}): Promise<void> {
  const row: Record<string, unknown> = {
    business_slug: businessSlug,
    document_id: documentId,
    order_id: order.id,
    tag: order.ref_code,
    ...patch,
    attempts: extra.attempts ?? 0,
    last_error: extra.last_error ?? null,
  };
  if (extra.wrote) row.last_synced_at = new Date().toISOString();
  const { error } = await agentDb().from("ai_agent_gdoc_lines").upsert(row, { onConflict: "business_slug,document_id,order_id" });
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
