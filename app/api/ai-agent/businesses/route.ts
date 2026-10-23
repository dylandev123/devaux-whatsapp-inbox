import { NextResponse } from "next/server";
import { buildBusinessList, SessionInput } from "@/lib/aiAgent/businessList";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb } from "@/lib/server/aiAgent/db";
import { callBridge, statusPath } from "@/lib/server/whatsappBridge";
import { BUSINESS_LABELS } from "@/lib/whatsapp";

// Admin-only. The businesses selectable on /admin/ai-agent, with each one's
// WhatsApp connection and agent ON/OFF state. Read-only: listing a business
// never creates settings or enables anything.
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const db = agentDb();
  const [bizRes, settingsRes, bridge] = await Promise.all([
    db.from("whatsapp_businesses").select("business_slug, display_name").eq("is_active", true),
    db.from("ai_agent_settings").select("business_slug, enabled, mode, contact_scope"),
    callBridge<{ sessions?: { businessSlug?: unknown; status?: unknown }[] }>(statusPath()),
  ]);
  if (settingsRes.error) return jsonError(settingsRes.error.message, 500);

  // whatsapp_businesses unreadable (migration not run): static list instead.
  const businesses = bizRes.error
    ? Object.entries(BUSINESS_LABELS).map(([business_slug, display_name]) => ({ business_slug, display_name }))
    : (bizRes.data ?? []);

  let sessions: SessionInput[] | null = null;
  if (bridge.ok && Array.isArray(bridge.data?.sessions)) {
    sessions = bridge.data.sessions
      .filter((s) => typeof s.businessSlug === "string")
      .map((s) => ({ businessSlug: s.businessSlug as string, status: typeof s.status === "string" ? s.status : "" }));
  } else {
    // Bridge unreachable: the last status it wrote to Supabase is the next best signal.
    const { data, error } = await db.from("whatsapp_sessions").select("business_slug, status");
    if (!error && data) sessions = data.map((s) => ({ businessSlug: s.business_slug, status: s.status ?? "" }));
  }

  return NextResponse.json({
    businesses: buildBusinessList(businesses, sessions, settingsRes.data ?? []),
    sessionsKnown: sessions !== null,
  });
}
