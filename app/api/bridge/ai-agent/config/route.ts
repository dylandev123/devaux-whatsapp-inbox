import { NextResponse } from "next/server";
import { verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { routedGroups } from "@/lib/aiAgent/routing";
import { agentDb, isMissingColumn } from "@/lib/server/aiAgent/db";

// Bridge → app: which businesses the bridge should forward messages for, and
// each one's staff group. One entry per configured business; a business with
// no row is simply absent (= not forwarded). Purely an optimisation — forwarding a message for a
// disabled business is always safe (it is ignored without side effects).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const columns = "business_slug, enabled, mode, staff_group_jid, staff_notices_enabled, batching_enabled, batch_quiet_seconds, batch_max_wait_seconds, orders_summary_enabled, orders_group_jid";
  const read = (extra: string) => agentDb().from("ai_agent_settings").select(`${columns}${extra}`);
  let { data, error } = await read(", routing_rules, missed_call_enabled");
  // Deployed before migration 20261110000000: the older shape, with routing and missed calls off.
  if (error && isMissingColumn(error)) ({ data, error } = await read(""));
  if (error) return NextResponse.json({ error: "Failed to load AI agent config" }, { status: 500 });

  return NextResponse.json({
    pollOutboxSeconds: 10,
    businesses: ((data ?? []) as unknown as Record<string, any>[]).map((row) => ({
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
      // Daily order summary. ordersGroupJid is where the summary goes and where the order commands are honoured (null = the
      // staff group). A group other than staffGroupJid must also be forwarded to /message.
      ordersSummaryEnabled: row.orders_summary_enabled === true,
      ordersGroupJid: row.orders_summary_enabled === true && row.orders_group_jid ? row.orders_group_jid : null,
      // Rules & Routing: the extra groups (complaints / urgent / approvals) that behave like the staff group. Additive: a bridge that
      // does not know the field simply does not forward them. Never includes the staff group itself.
      routedGroupJids: routedGroups({ staff_group_jid: row.staff_group_jid, routing_rules: row.routing_rules }),
      // Missed-call rule: when false the bridge need not report calls (reporting is always safe; the Inbox ignores them).
      missedCallsEnabled: row.missed_call_enabled === true,
    })),
  });
}
