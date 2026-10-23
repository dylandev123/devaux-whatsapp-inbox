// Server-only: service-role access to the ai_agent_* tables
// (supabase/migrations/20261022000000_ai_agent.sql). Every ai_agent_* table is
// admin-read-only under RLS, so all writes funnel through here — callers are
// either admin API routes (middleware.ts + requireAdmin()) or bridge routes
// (AI_AGENT_BRIDGE_SECRET). Never import from a client component.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { AgentSettings, generateRefCode, KnowledgeKind, isPilotBusiness } from "@/lib/aiAgent/engine";
import { normalizeBusinessSlug } from "@/lib/businessSlug";

let cached: SupabaseClient | null = null;

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

/** Normalized slug, or null when it isn't a pilot business (callers 400/ignore). */
export function pilotSlug(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const slug = normalizeBusinessSlug(raw);
  return isPilotBusiness(slug) ? slug : null;
}

export const SETTINGS_COLUMNS =
  "business_slug, enabled, mode, contact_scope, autonomy, staff_group_jid, staff_group_name, auto_takeover_minutes, max_auto_replies_per_hour, send_holding_reply, updated_at";

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
  source: "admin" | "staff_correction" | "import";
  source_ref: string | null;
  expires_at: string | null;
  version: number;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
}

export const KNOWLEDGE_COLUMNS =
  "id, business_slug, kind, title, content, status, source, source_ref, expires_at, version, approved_by, approved_at, updated_at";

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
