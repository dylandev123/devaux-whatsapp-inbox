import { NextResponse } from "next/server";
import { verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { agentDb } from "@/lib/server/aiAgent/db";

// Bridge → app: which businesses the bridge should forward messages for, and
// each one's staff group. One entry per configured business; a business with
// no row is simply absent (= not forwarded). Purely an optimisation — forwarding a message for a
// disabled business is always safe (it is ignored without side effects).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const { data, error } = await agentDb()
    .from("ai_agent_settings")
    .select("business_slug, enabled, mode, staff_group_jid, staff_notices_enabled, batching_enabled, batch_quiet_seconds, batch_max_wait_seconds");
  if (error) return NextResponse.json({ error: "Failed to load AI agent config" }, { status: 500 });

  return NextResponse.json({
    pollOutboxSeconds: 10,
    businesses: (data ?? []).map((row) => ({
      businessSlug: row.business_slug,
      forwardMessages: row.enabled,
      mode: row.mode,
      staffGroupJid: row.staff_group_jid,
      // Observe mode: bridge may send staff_notice (only) to staffGroupJid when true.
      staffNoticesEnabled: row.staff_notices_enabled === true,
      // Informational: batched messages come back as { status: "done", decision: null, reasons: ["batched"], outbox: [] };
      // the decision's outbox items arrive later through /outbox/claim.
      batchingEnabled: row.batching_enabled === true,
      batchQuietSeconds: row.batch_quiet_seconds,
      batchMaxWaitSeconds: row.batch_max_wait_seconds,
    })),
  });
}
