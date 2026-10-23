import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, pilotSlug } from "@/lib/server/aiAgent/db";

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
  const businessSlug = pilotSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("businessSlug must be a pilot business", 400);
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

  return NextResponse.json({ events: eventsResult.data ?? [], outbox: outboxRows, audit: auditResult.data ?? [] });
}
