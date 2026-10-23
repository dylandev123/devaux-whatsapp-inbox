// Pure merge behind the Admin → AI Agent business selector (client-safe, no
// I/O — unit-tested in tests/aiAgentMultiBusiness.test.ts). The route feeds it
// the configured businesses, the WhatsApp sessions the bridge reports and the
// per-business agent settings; it returns one row per selectable account.
//
// A business with no settings row is reported OFF / observe / none — the same
// values a freshly created row takes — and this module has no way to turn
// anything on.

import { isValidBusinessSlug } from "./engine.ts";

export interface BusinessInput {
  business_slug: string;
  display_name: string;
}
export interface SessionInput {
  businessSlug: string;
  status: string;
}
export interface SettingsInput {
  business_slug: string;
  enabled: boolean;
  mode: "observe" | "assisted";
  contact_scope: "none" | "all" | "selected";
}

export type ConnectionState = "connected" | "disconnected" | "unknown";

export interface AgentBusiness {
  businessSlug: string;
  label: string;
  connection: ConnectionState;
  sessionStatus: string | null;
  enabled: boolean;
  mode: "observe" | "assisted";
  contactScope: "none" | "all" | "selected";
  configured: boolean;
}

const CONNECTED_STATUSES = new Set(["open", "connected", "ready", "online"]);

export function connectionOf(status: string | null | undefined): ConnectionState {
  if (!status) return "disconnected";
  return CONNECTED_STATUSES.has(status.toLowerCase()) ? "connected" : "disconnected";
}

/**
 * sessions === null means session state could not be read at all: every
 * configured business is listed with an "unknown" connection instead of being
 * hidden. With sessions known, a business is listed when it has a session or
 * already has agent settings.
 */
export function buildBusinessList(
  businesses: BusinessInput[],
  sessions: SessionInput[] | null,
  settings: SettingsInput[]
): AgentBusiness[] {
  const sessionBySlug = new Map((sessions ?? []).map((s) => [s.businessSlug, s]));
  const settingsBySlug = new Map(settings.map((s) => [s.business_slug, s]));
  const out: AgentBusiness[] = [];
  for (const b of businesses) {
    if (!isValidBusinessSlug(b.business_slug)) continue;
    const session = sessionBySlug.get(b.business_slug) ?? null;
    const cfg = settingsBySlug.get(b.business_slug) ?? null;
    if (sessions !== null && !session && !cfg) continue;
    out.push({
      businessSlug: b.business_slug,
      label: b.display_name,
      connection: sessions === null ? "unknown" : connectionOf(session?.status),
      sessionStatus: session?.status ?? null,
      enabled: cfg?.enabled ?? false,
      mode: cfg?.mode ?? "observe",
      contactScope: cfg?.contact_scope ?? "none",
      configured: Boolean(cfg),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
