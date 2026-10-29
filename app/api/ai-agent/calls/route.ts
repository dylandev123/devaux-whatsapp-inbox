import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only, read-only: the missed-call rule's audit trail (every call the bridge reported and what was decided).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  const { data, error } = await agentDb()
    .from("ai_agent_call_events")
    .select("id, call_id, caller_jid, decision, reason, video, call_at, created_at")
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return jsonError("Failed to load calls", 500);
  return NextResponse.json({ calls: data ?? [] });
}
