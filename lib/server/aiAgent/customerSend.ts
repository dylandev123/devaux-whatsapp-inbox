// Server-only: THE policy for "may this text be sent to this customer now?" for
// everything a person triggers on an escalation — an authorized "!send" in the
// staff WhatsApp group and the dashboard's "Send to customer" button. Both call
// planCustomerSend(); there is no second implementation to drift. It applies,
// in the order decideCustomerSend() defines:
//
//   business match → agent enabled + Assisted mode → contact scope / allow /
//   exclude → human takeover → recent human activity → safe text → authorized
//   (an allow-listed WhatsApp sender, or an authenticated admin) → draft not
//   stale / not expired → not already sent, in flight or of unknown outcome
//
// It only PLANS: the caller enqueues the returned outbox item (the live path
// returns it to the bridge, the dashboard queues it as pending), and an item the
// plan did not produce can never reach a customer.

import { createHash } from "crypto";
import {
  type AgentSettings,
  canSendApproved,
  evaluateGate,
  type GateResult,
  type PriorNotice,
  priorNoticeHold,
} from "@/lib/aiAgent/engine";
import {
  checkExactSendSafety,
  checkStaffDraftSafety,
  customerWroteSince,
  decideCustomerSend,
  draftExpired,
  relayHoldFrom,
  type SendDecision,
} from "@/lib/aiAgent/staffAnswers";
import { isOutbound } from "@/lib/whatsapp";
import { agentDb, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import type { EscalationRow } from "@/lib/server/aiAgent/escalations";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import type { OutboxInsert } from "@/lib/server/aiAgent/outbox";
import type { StaffAnswerRow } from "@/lib/server/aiAgent/staffKnowledge";

export const sha = (value: string) => createHash("sha256").update(value.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 16);

/** Who is asking for the send. An admin is authenticated by the route; a WhatsApp sender by the allow-list. */
export type SendRequester =
  | { kind: "admin"; adminId: string | null }
  | { kind: "staff"; senderAuthorized: boolean; senderId: string | null };

export interface CustomerSendRequest {
  settings: AgentSettings | null;
  escalation: EscalationRow;
  requester: SendRequester;
  /** Exactly what the customer would receive. */
  text: string;
  /**
   * A stored draft being approved: it is checked against the staff words it was
   * made from, and goes stale when the customer writes after it or its facts expire.
   */
  draft?: Pick<StaffAnswerRow, "body" | "created_at" | "valid_until"> | null;
  /** Typed text only: when the person last looked at the escalation. A customer message after that makes it stale. */
  basedOn?: string | null;
  eventId?: string | null;
  /** A pilot draft's own expiry (its facts may be time-bound); same effect as a stored draft's valid_until. */
  validUntil?: string | null;
  now?: Date;
}

export interface CustomerSendPlan {
  decision: SendDecision;
  /** Present only when decision.send; the one customer-bound item that may be queued. */
  item: OutboxInsert | null;
  relayKey: string;
  /** Earlier outbox rows for the same text (any status): evidence for the duplicate / unknown-send hold. */
  earlier: PriorNotice[];
}

/** The same contact / takeover / recent-human rules a customer message goes through (evaluateGate). */
export async function customerGate(settings: AgentSettings, e: EscalationRow, now: Date = new Date()): Promise<GateResult> {
  const g = await loadGateData(e.business_slug, e.chat_id, e.contact_number, settings);
  return evaluateGate({
    businessSlug: e.business_slug,
    chatId: e.chat_id,
    fromMe: false,
    text: "(staff reply)",
    hasMedia: false,
    settings,
    contactRule: g.contactRule,
    unresolvedLid: g.unresolvedLid,
    conversation: g.conversation,
    staffActiveAt: g.staffActiveAt,
    now,
    explicitStaffSend: true,
  });
}

/**
 * Whether the customer has written since `since`. A message that arrives after an
 * escalation was answered opens a NEW escalation, so the escalation's own
 * follow-ups are not enough: a newer escalation for the chat, or any inbound
 * message stored after `since`, also counts.
 */
export async function customerWroteAfter(e: EscalationRow, since: string): Promise<boolean> {
  if (customerWroteSince(e.context.updates, since)) return true;
  const db = agentDb();
  const { data: newer, error } = await db
    .from("ai_agent_escalations")
    .select("id")
    .eq("business_slug", e.business_slug)
    .eq("chat_id", e.chat_id)
    .gt("created_at", since)
    .limit(1);
  if (error) throw new Error(error.message);
  if ((newer ?? []).length > 0) return true;
  // Strict invalidation: ANY customer message after the draft counts, even "thanks" (which never reaches the
  // escalation's updates). The agent's own event log records every inbound message it was handed, so this does not
  // depend on the bridge's message storage.
  const { data: inbound, error: inboundError } = await db
    .from("ai_agent_events")
    .select("id")
    .eq("business_slug", e.business_slug)
    .eq("chat_id", e.chat_id)
    .eq("kind", "customer_inbound")
    .gt("created_at", since)
    .limit(1);
  if (inboundError) throw new Error(inboundError.message);
  if ((inbound ?? []).length > 0) return true;
  // Stored messages are best effort (retention-limited); a failed lookup cannot make a draft look fresher.
  const { data: messages } = await db
    .from("whatsapp_messages")
    .select("direction")
    .eq("business_slug", e.business_slug)
    .eq("chat_id", e.chat_id)
    .gt("timestamp", since)
    .limit(30);
  return ((messages ?? []) as { direction: string }[]).some((m) => !isOutbound(m.direction));
}

/** Every customer-bound row already created for this exact text on this escalation, whatever its status. */
export async function earlierRelays(businessSlug: string, relayBase: string): Promise<PriorNotice[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_outbox")
    .select("status, error")
    .eq("business_slug", businessSlug)
    .like("dedupe_key", `${relayBase}:%`);
  if (error) throw new Error(error.message);
  return (data ?? []) as PriorNotice[];
}

export const relayBaseFor = (escalationId: string, text: string) => `staffrelay:${escalationId}:${sha(text)}`;

export async function planCustomerSend(req: CustomerSendRequest): Promise<CustomerSendPlan> {
  const { settings, escalation: e, text } = req;
  const now = req.now ?? new Date();
  // Settings, escalation and outbox are per business: another business's row must never authorize a send.
  if (settings && settings.business_slug !== e.business_slug) throw new Error("Escalation belongs to a different business");

  const relayBase = relayBaseFor(e.id, text);
  const earlier = await earlierRelays(e.business_slug, relayBase);
  // A provably unsent earlier attempt may be retried under the next key; anything else holds (priorNoticeHold below).
  const relayKey = `${relayBase}:${earlier.length}`;

  // Nothing about the customer is looked up when the agent cannot message customers at all.
  const sendable = canSendApproved(settings);
  const gate: GateResult = settings && sendable ? await customerGate(settings, e, now) : { pass: false, decision: "NO_REPLY", reasons: ["agent_disabled"] };

  const knowledge = req.draft && sendable ? await loadActiveKnowledge(e.business_slug) : [];
  const safetyCodes = req.draft ? checkStaffDraftSafety(text, req.draft.body, knowledge) : checkExactSendSafety(text);
  const basis = req.draft?.created_at ?? req.basedOn ?? null;
  const stale = sendable && basis ? await customerWroteAfter(e, basis) : false;
  const expired = draftExpired(req.draft?.valid_until ?? req.validUntil ?? null, now);

  const authorized = req.requester.kind === "admin" ? true : req.requester.senderAuthorized;
  const decision = decideCustomerSend({
    settings,
    authorized,
    unauthorizedReason: authorized ? undefined : "sender_not_authorized",
    gate,
    safetyCodes,
    hasText: Boolean(text.trim()),
    stale,
    expired,
    priorHold: relayHoldFrom(priorNoticeHold(earlier)),
  });

  const item: OutboxInsert | null = decision.send
    ? {
        businessSlug: e.business_slug,
        chatId: e.chat_id,
        kind: "staff_relay",
        toJid: e.chat_id,
        body: text,
        dedupeKey: relayKey,
        eventId: req.eventId ?? null,
        escalationId: e.id,
        createdBy: req.requester.kind === "admin" ? req.requester.adminId : null,
      }
    : null;
  return { decision, item, relayKey, earlier };
}
