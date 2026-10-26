// Server-only: service-role access to the ai_agent_* tables
// (supabase/migrations/20261022000000_ai_agent.sql). Every ai_agent_* table is
// admin-read-only under RLS, so all writes funnel through here — callers are
// either admin API routes (middleware.ts + requireAdmin()) or bridge routes
// (AI_AGENT_BRIDGE_SECRET). Never import from a client component.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { AgentSettings, generateRefCode, isValidBusinessSlug, KnowledgeKind } from "@/lib/aiAgent/engine";
import { normalizeBusinessSlug } from "@/lib/businessSlug";
import { BUSINESS_LABELS } from "@/lib/whatsapp";

let cached: SupabaseClient | null = null;

/** Tests only: route every ai_agent_* query to a stand-in client (tests/helpers/pgSupabase.ts). Pass null to restore. */
export function setAgentDbForTests(client: SupabaseClient | null): void {
  cached = client;
}

export function agentDb(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service role is not configured (SUPABASE_SERVICE_ROLE_KEY missing)");
  }
  cached = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cached;
}

/** Normalized slug when well-formed (no existence check), else null. Used on the bridge path. */
export function parseBusinessSlug(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const slug = normalizeBusinessSlug(raw);
  return isValidBusinessSlug(slug) ? slug : null;
}

/**
 * Admin routes: normalized slug of a business that actually exists (an active
 * whatsapp_businesses row, or one that already has agent settings), else null
 * — so a typo can never create settings for a business that isn't there.
 */
export async function resolveBusinessSlug(raw: unknown): Promise<string | null> {
  const slug = parseBusinessSlug(raw);
  if (!slug) return null;
  const db = agentDb();
  const [biz, cfg] = await Promise.all([
    db.from("whatsapp_businesses").select("business_slug").eq("business_slug", slug).eq("is_active", true).maybeSingle(),
    db.from("ai_agent_settings").select("business_slug").eq("business_slug", slug).maybeSingle(),
  ]);
  if (biz.data || cfg.data) return slug;
  // whatsapp_businesses missing (migration not run): fall back to the static list.
  if (biz.error && slug in BUSINESS_LABELS) return slug;
  return null;
}

/**
 * Makes sure the business has a settings row. A new row takes the column
 * defaults — OFF, observe, contact scope none — and an existing row is never
 * touched, so this can never enable anything or reset a configuration.
 */
export async function ensureSettings(businessSlug: string): Promise<AgentSettings> {
  const existing = await loadSettings(businessSlug);
  if (existing) return existing;
  const { error } = await agentDb()
    .from("ai_agent_settings")
    .upsert({ business_slug: businessSlug }, { onConflict: "business_slug", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  const created = await loadSettings(businessSlug);
  if (!created) throw new Error("Could not create AI agent settings");
  return created;
}

export const SETTINGS_COLUMNS =
  "business_slug, enabled, mode, contact_scope, autonomy, staff_group_jid, staff_group_name, auto_takeover_minutes, max_auto_replies_per_hour, send_holding_reply, staff_notices_enabled, batching_enabled, batch_quiet_seconds, batch_max_wait_seconds, customer_memory_enabled, staff_authorized_senders, default_customer_mode, passive_learning_scope, knowledge_confirm_via_whatsapp, orders_tracking_enabled, orders_summary_enabled, orders_group_jid, orders_group_name, orders_timezone, orders_summary_hour, orders_customer_confirms, orders_tracking_since, auto_learning_enabled, updated_at";

export async function loadSettings(businessSlug: string): Promise<AgentSettings | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_settings")
    .select(SETTINGS_COLUMNS)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AgentSettings | null) ?? null;
}

export interface KnowledgeRow {
  id: string;
  business_slug: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  status: "draft" | "approved" | "archived";
  source: "admin" | "staff_correction" | "import" | "whatsapp" | "auto";
  source_ref: string | null;
  expires_at: string | null;
  version: number;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
  /** Automatic learning: the K-XXXX code staff use with !forget, the product identity and the standard price. */
  short_code: string | null;
  subject_key: string | null;
  price_amount: number | null;
  fingerprint: string | null;
  learned_message_at: string | null;
  supersedes_id: string | null;
  superseded_by: string | null;
  archived_reason: string | null;
  archived_at: string | null;
}

export const KNOWLEDGE_COLUMNS =
  "id, business_slug, kind, title, content, status, source, source_ref, expires_at, version, approved_by, approved_at, updated_at, short_code, subject_key, price_amount, fingerprint, learned_message_at, supersedes_id, superseded_by, archived_reason, archived_at";

/** What the dashboard also reads: the identifiers of an automatic fact's source (never sent to the model). */
export const KNOWLEDGE_ADMIN_COLUMNS = `${KNOWLEDGE_COLUMNS}, learned_message_id, learned_chat_id`;

/** Only approved, unexpired entries — the sole facts the agent may state. */
export async function loadActiveKnowledge(businessSlug: string): Promise<KnowledgeRow[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_knowledge")
    .select(KNOWLEDGE_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("status", "approved")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("kind")
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeRow[];
}

export type ActorKind = "admin" | "staff" | "bridge" | "system";

/** Append-only audit trail. Never throws — an audit failure must not abort the action it records. */
export async function audit(
  businessSlug: string,
  actorKind: ActorKind,
  actorId: string | null,
  action: string,
  target: { type?: string; id?: string | null } = {},
  details: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await agentDb().from("ai_agent_audit_log").insert({
    business_slug: businessSlug,
    actor_kind: actorKind,
    actor_id: actorId,
    action,
    target_type: target.type ?? null,
    target_id: target.id ?? null,
    details,
  });
  if (error) console.error("[aiAgent audit]", action, error.message);
}

export async function newRefCode(): Promise<string> {
  // 32^5 ≈ 33M codes; collisions are vanishingly rare but still checked.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRefCode(randomBytes(5));
    const { data } = await agentDb().from("ai_agent_escalations").select("id").eq("ref_code", code).maybeSingle();
    if (!data) return code;
  }
  throw new Error("Could not allocate an escalation reference code");
}
