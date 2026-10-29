// Server-only: a call report from the bridge (POST /api/bridge/ai-agent/call). Pure rules: lib/aiAgent/missedCalls.ts.
//
// Reply to a caller only when ALL of these hold: the agent and the missed-call rule are on, the mode may write to customers
// (Assisted or Approval Pilot), the bridge reported a reliably missed incoming one-to-one call, the caller's contact is permitted
// by the same contact scope as ordinary replies and no human is handling the chat, the caller has not been answered inside the
// cooldown, and the hourly cap is not reached. The last two are enforced in SQL under a per-caller lock
// (record_ai_agent_missed_call), so concurrent reports cannot both reply. Every decision is recorded in ai_agent_call_events.
// The reply is a fixed text the admin wrote: no model is involved, and it does not touch customer memory, orders or escalations.

import { outboxAllowed } from "@/lib/aiAgent/engine";
import { type CallReport, classifyCall } from "@/lib/aiAgent/missedCalls";
import { agentDb, audit, loadSettings } from "@/lib/server/aiAgent/db";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import { type BridgeOutboxItem, outboxRowById, toBridgeItem } from "@/lib/server/aiAgent/outbox";

export interface CallResult {
  status: "done" | "ignored";
  decision: "replied" | "skipped";
  reason: string;
  outbox: BridgeOutboxItem[];
}

const skipped = (reason: string): CallResult => ({ status: "ignored", decision: "skipped", reason, outbox: [] });

async function recordSkip(businessSlug: string, report: CallReport, reason: string): Promise<CallResult> {
  const { error } = await agentDb().from("ai_agent_call_events").upsert(
    { business_slug: businessSlug, call_id: report.callId, caller_jid: report.callerJid, decision: "skipped", reason, video: report.isVideo, call_at: report.offerAt ?? report.endedAt },
    { onConflict: "business_slug,call_id", ignoreDuplicates: true }
  );
  if (error) throw new Error(error.message);
  await audit(businessSlug, "bridge", null, "calls.skipped", { type: "call", id: report.callId }, { reason });
  return skipped(reason);
}

export async function processCallReport(businessSlug: string, report: CallReport, now: Date = new Date()): Promise<CallResult> {
  const settings = await loadSettings(businessSlug);
  // Unconfigured, disabled and rule-off businesses write nothing at all: the rule is off until an admin turns it on.
  if (!settings?.enabled) return skipped("agent_off");
  if (settings.missed_call_enabled !== true) return skipped("disabled");

  const verdict = classifyCall(report, now);
  if (!verdict.missed) return recordSkip(businessSlug, report, verdict.reason);

  const probe = { kind: "missed_call_reply", toJid: report.callerJid };
  if (!outboxAllowed(settings, probe)) return recordSkip(businessSlug, report, "mode_not_allowed");

  // The same contact rules as an ordinary reply, and never over a human who is in the conversation.
  const gate = await loadGateData(businessSlug, report.callerJid, report.callerJid.endsWith("@s.whatsapp.net") ? report.callerJid.split("@")[0] : null, settings);
  if (gate.contactRule === "exclude") return recordSkip(businessSlug, report, "contact_excluded");
  if (settings.contact_scope === "none" || (settings.contact_scope === "selected" && gate.contactRule !== "allow")) return recordSkip(businessSlug, report, "contact_not_permitted");
  const human = gate.conversation?.control === "human" && gate.conversation.human_until !== null && Date.parse(gate.conversation.human_until) > now.getTime();
  if (human || gate.staffActiveAt) return recordSkip(businessSlug, report, "human_active");

  const { data, error } = await agentDb().rpc("record_ai_agent_missed_call", {
    p_business_slug: businessSlug,
    p_call_id: report.callId,
    p_caller_jid: report.callerJid,
    p_video: report.isVideo,
    p_call_at: report.offerAt,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { decision: "replied" | "skipped"; reason: string; outbox_id: string | null } | undefined;
  if (!row) throw new Error("record_ai_agent_missed_call returned nothing");
  if (row.decision !== "replied" || !row.outbox_id) {
    await audit(businessSlug, "bridge", null, "calls.skipped", { type: "call", id: report.callId }, { reason: row.reason });
    return skipped(row.reason);
  }
  const outbox = await outboxRowById(row.outbox_id);
  if (!outbox) throw new Error("missed-call reply was queued but could not be read back");
  await audit(businessSlug, "bridge", null, "calls.missed_reply", { type: "call", id: report.callId }, { outbox_id: outbox.id });
  return { status: "done", decision: "replied", reason: "replied", outbox: [toBridgeItem(outbox, true)] };
}
