import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { isLidJid, verifiedPhoneDigits } from "@/lib/aiAgent/identity";
import { agentDb, loadSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only, read-only. Recent decisions (ai_agent_events), outbox items
// (ai_agent_outbox) and the audit trail. Items still awaiting the bridge
// (pending/dispatched) are always included, however old, so an unresolved
// send never scrolls out of view behind newer ones.
export const dynamic = "force-dynamic";

const OUTBOX_COLUMNS =
  "id, business_slug, chat_id, kind, to_jid, body, status, event_id, escalation_id, whatsapp_message_id, error, dispatched_at, sent_at, created_at";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  const chatId = params.get("chatId");

  const db = agentDb();
  let events = db
    .from("ai_agent_events")
    .select("id, chat_id, kind, status, message_excerpt, decision, reason_codes, confidence, proposed_reply, mode, escalation_id, error, latency_ms, created_at")
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(100);
  if (chatId) events = events.eq("chat_id", chatId);

  const outbox = (open: boolean) => {
    let query = db
      .from("ai_agent_outbox")
      .select(OUTBOX_COLUMNS)
      .eq("business_slug", businessSlug)
      .order("created_at", { ascending: false })
      .limit(100);
    if (open) query = query.in("status", ["pending", "dispatched"]);
    return chatId ? query.eq("chat_id", chatId) : query;
  };

  const [eventsResult, recentOutbox, openOutbox, auditResult] = await Promise.all([
    events,
    outbox(false),
    outbox(true),
    db
      .from("ai_agent_audit_log")
      .select("id, actor_kind, actor_id, action, target_type, target_id, details, created_at")
      .eq("business_slug", businessSlug)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (eventsResult.error) return jsonError(eventsResult.error.message, 500);
  if (recentOutbox.error) return jsonError(recentOutbox.error.message, 500);
  if (openOutbox.error) return jsonError(openOutbox.error.message, 500);
  if (auditResult.error) return jsonError(auditResult.error.message, 500);

  const byId = new Map<string, { id: string; created_at: string }>();
  for (const row of [...(openOutbox.data ?? []), ...(recentOutbox.data ?? [])]) byId.set(row.id, row);
  const outboxRows = Array.from(byId.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));

  return NextResponse.json({
    events: eventsResult.data ?? [],
    outbox: outboxRows,
    audit: auditResult.data ?? [],
    diagnostics: await loadDiagnostics(businessSlug),
  });
}

// Why-nothing-happened summary for the Activity tab. Flags and counts only:
// never secret values, tokens or message bodies.
async function loadDiagnostics(businessSlug: string) {
  const db = agentDb();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [settings, rules, recent, failures] = await Promise.all([
    loadSettings(businessSlug),
    db.from("ai_agent_contact_rules").select("chat_id, display_name, rule").eq("business_slug", businessSlug),
    db
      .from("ai_agent_events")
      .select("created_at", { count: "exact" })
      .eq("business_slug", businessSlug)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1),
    db
      .from("ai_agent_audit_log")
      .select("created_at", { count: "exact" })
      .eq("business_slug", businessSlug)
      .eq("action", "bridge.message_failed")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  // Verified phone per @lid rule, from phone numbers WhatsApp reported in stored messages.
  const ruleRows = (rules.data ?? []) as { chat_id: string; display_name: string | null; rule: "allow" | "exclude" }[];
  const lidIds = ruleRows.map((r) => r.chat_id).filter(isLidJid);
  const phoneByLid = new Map<string, string>();
  if (lidIds.length > 0) {
    const { data } = await db
      .from("whatsapp_messages")
      .select("chat_id, contact_number")
      .eq("business_slug", businessSlug)
      .in("chat_id", lidIds)
      .not("contact_number", "is", null)
      .order("timestamp", { ascending: false })
      .limit(500);
    for (const m of data ?? []) {
      const phone = verifiedPhoneDigits(m.chat_id, m.contact_number);
      if (phone && !phoneByLid.has(m.chat_id)) phoneByLid.set(m.chat_id, phone);
    }
  }

  return {
    bridgeSecretConfigured: Boolean(process.env.AI_AGENT_BRIDGE_SECRET),
    enabled: settings?.enabled ?? false,
    mode: settings?.mode ?? null,
    contactScope: settings?.contact_scope ?? null,
    staffGroupConfigured: Boolean(settings?.staff_group_jid),
    eventsLast24h: recent.count ?? 0,
    lastEventAt: (recent.data?.[0]?.created_at as string | undefined) ?? null,
    bridgeFailuresLast24h: failures.count ?? 0,
    contacts: ruleRows.map((r) => ({
      chatId: r.chat_id,
      name: r.display_name,
      rule: r.rule,
      isLid: isLidJid(r.chat_id),
      phone: isLidJid(r.chat_id) ? (phoneByLid.get(r.chat_id) ?? null) : (r.chat_id.split("@")[0] || null),
    })),
  };
}
