// Server-only: the dashboard's "Send to customer". The route authenticates the
// admin (requireAdmin) and validates the request; everything about whether the
// customer is actually messaged is planCustomerSend() — the same policy as an
// authorized "!send" in the staff WhatsApp group: business mode, contact scope,
// takeover, recent human activity, stale text, safety, duplicates and
// unknown-send holds. A dashboard click is not a way around any of them.

import type { AgentSettings } from "@/lib/aiAgent/engine";
import { WITHHOLD_TEXT, type WithholdReason } from "@/lib/aiAgent/staffAnswers";
import { audit } from "@/lib/server/aiAgent/db";
import { planCustomerSend, sha } from "@/lib/server/aiAgent/customerSend";
import { type EscalationRow, markEscalationAnswered } from "@/lib/server/aiAgent/escalations";
import { enqueue } from "@/lib/server/aiAgent/outbox";
import { recordAdminAnswer } from "@/lib/server/aiAgent/staffKnowledge";

export type AdminSendResult =
  | { ok: true; sent: true; message: string; queued: number }
  /** Observe mode: the answer is recorded for review; nothing is sent, by design. */
  | { ok: true; sent: false; message: string; queued: 0 }
  | { ok: false; status: number; reason: WithholdReason; message: string };

export async function sendAdminAnswer(args: {
  settings: AgentSettings | null;
  escalation: EscalationRow;
  text: string;
  adminId: string | null;
  /** When the admin last looked at this escalation (its updated_at as displayed). */
  basedOn: string;
}): Promise<AdminSendResult> {
  const { settings, escalation: e } = args;
  const text = args.text.trim();
  const plan = await planCustomerSend({
    settings,
    escalation: e,
    requester: { kind: "admin", adminId: args.adminId },
    text,
    basedOn: args.basedOn,
  });
  const { decision } = plan;

  if (!decision.send) {
    const observe = decision.reason === "observe_mode";
    await audit(e.business_slug, "admin", args.adminId, "escalation.send_withheld", { type: "escalation", id: e.id }, {
      via: "admin_ui",
      ref_code: e.ref_code,
      reason: decision.reason,
    });
    if (!observe) {
      return { ok: false, status: 409, reason: decision.reason, message: `Not sent: ${WITHHOLD_TEXT[decision.reason]}.` };
    }
    // Observe mode: keep the answer for review and learning, exactly as before.
    await markEscalationAnswered(e, { body: text, actorId: args.adminId, via: "admin_ui", notRelayed: decision.reason });
    await recordAdminAnswer({
      settings,
      escalation: e,
      text,
      adminId: args.adminId,
      digest: `${sha(text)}:held`,
      relayed: false,
      withheldReason: decision.reason,
    }).catch((err) => console.error("[aiAgent] recordAdminAnswer", err instanceof Error ? err.message : err));
    return {
      ok: true,
      sent: false,
      queued: 0,
      message: `⚠️ #${e.ref_code}: answer saved, but the agent is not in Assisted mode so nothing was sent. Reply to the customer directly.`,
    };
  }

  // Pending: the bridge claims it. An identical item already queued collapses onto the same dedupe key.
  const rows = await enqueue([plan.item!], false);
  await markEscalationAnswered(e, { body: text, actorId: args.adminId, via: "admin_ui", notRelayed: null });
  await audit(e.business_slug, "admin", args.adminId, "escalation.send", { type: "escalation", id: e.id }, {
    via: "admin_ui",
    ref_code: e.ref_code,
    body: text.slice(0, 500),
    queued: rows.length,
  });
  await recordAdminAnswer({
    settings,
    escalation: e,
    text,
    adminId: args.adminId,
    digest: `${sha(text)}:${plan.relayKey}`,
    relayed: true,
  }).catch((err) => console.error("[aiAgent] recordAdminAnswer", err instanceof Error ? err.message : err));
  return { ok: true, sent: true, queued: rows.length, message: `✅ #${e.ref_code}: sending your answer to the customer.` };
}
