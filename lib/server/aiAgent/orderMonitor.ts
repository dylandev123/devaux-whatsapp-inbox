// Server-only: order monitoring of conversations the AI may NOT reply in (not on the allow-list, Manual Only, staff
// takeover, excluded, Observe…) and of what the business itself writes in a customer chat. The rules live in
// lib/aiAgent/orderMonitor.ts; this file loads data, makes the one small model call, and writes through the same
// trackOrders() / apply_ai_agent_order() the AI-eligible path uses.
//
// What this can never do: create an outbox item, change a customer's mode or takeover state, or grant permission to
// reply. It returns reason codes only. Every message that reaches it leaves a reason code on its event (analysed,
// skipped by the free filter and why, over budget, failed), which is what the report's coverage note counts.

import type { AgentSettings } from "@/lib/aiAgent/engine";
import {
  MONITOR_BUDGET_REASON,
  monitorBudgetExceeded,
  monitorEligibleChat,
  monitorPrefilter,
  type StaffAction,
} from "@/lib/aiAgent/orderMonitor";
import { loadCustomerDisplayName, loadRecentMessages } from "@/lib/server/aiAgent/context";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import { proposeOrderUpdate } from "@/lib/server/aiAgent/model";
import { historyForModel, type HistoryOrder } from "@/lib/aiAgent/orderHistory";
import { flagOrderFromStaff, loadCustomerHistory, loadOpenOrders, ordersForModel, trackOrders } from "@/lib/server/aiAgent/orders";

export interface MonitorResult {
  /** Reason codes for the event. Never empty. */
  reasons: string[];
}

const CALL_ACTION = "orders.monitor_call";

/** Model calls this chat and this business have used in the last hour (recorded in the audit log BEFORE each call). */
async function callsLastHour(businessSlug: string, chatId: string): Promise<{ chat: number; business: number }> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const db = agentDb();
  const [business, chat] = await Promise.all([
    db.from("ai_agent_audit_log").select("id", { count: "exact", head: true }).eq("business_slug", businessSlug).eq("action", CALL_ACTION).gte("created_at", since),
    db.from("ai_agent_audit_log").select("id", { count: "exact", head: true }).eq("business_slug", businessSlug).eq("action", CALL_ACTION).eq("target_id", chatId).gte("created_at", since),
  ]);
  if (business.error) throw new Error(business.error.message);
  if (chat.error) throw new Error(chat.error.message);
  return { business: business.count ?? 0, chat: chat.count ?? 0 };
}

/** True when a turn with this id already wrote an order change: a retried batch / message must change nothing and cost nothing. */
export async function alreadyApplied(dedupeBase: string): Promise<boolean> {
  const { data, error } = await agentDb().from("ai_agent_order_events").select("id").like("idempotency_key", `${dedupeBase}:%`).limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function failed(businessSlug: string, chatId: string, why: string, detail: string): Promise<void> {
  console.error("[aiAgent] order monitor", why, detail);
  await audit(businessSlug, "system", null, "orders.monitor_failed", { type: "chat", id: chatId }, { why, error: detail.slice(0, 300) });
}

export interface MonitorTurnArgs {
  settings: AgentSettings;
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  segments: string[];
  /** The new messages with their timestamps, as the model should read them. */
  transcript: string;
  hasMedia: boolean;
  messageIds: string[];
  firstAt: string;
  lastAt: string;
  /** `batch:<id>` or the event id: every write is keyed by it, so a retry changes nothing. */
  dedupeBase: string;
}

/**
 * A customer turn in a chat the AI may not reply in. Same order records and rules as the AI-eligible path
 * (trackOrders), fed by a separate, small, incremental model call, or by no model call at all when a bare "yes" or
 * "cancel it" can be handled by the rules.
 */
export async function monitorCustomerTurn(a: MonitorTurnArgs): Promise<MonitorResult> {
  const { businessSlug, chatId } = a;
  if (!monitorEligibleChat(chatId)) return { reasons: ["orders_monitor_skipped_not_a_customer_chat"] };
  try {
    if (await alreadyApplied(a.dedupeBase)) return { reasons: ["orders_monitor_already_applied"] };
    const open = await loadOpenOrders(businessSlug, chatId);
    const plan = monitorPrefilter({ author: "customer", segments: a.segments, hasMedia: a.hasMedia, openOrders: open.length });
    if (plan.action === "skip") return { reasons: [plan.reason] };

    const identity = await loadIdentity(businessSlug, chatId, a.contactNumber);
    const customerName = await loadCustomerDisplayName(identity, a.contactNumber, chatId);
    let proposal: Parameters<typeof trackOrders>[0]["proposal"] = null;
    let intent: string | null = null;
    const recent = await loadRecentMessages(businessSlug, chatId, a.messageIds);
    // The customer's earlier orders: shown to the model in compact form and used by the server to resolve "same as last time".
    const history: HistoryOrder[] = plan.action === "analyse" ? await loadCustomerHistory(businessSlug, identity.chatIds, identity.phone).catch(() => []) : [];
    if (plan.action === "analyse") {
      if (monitorBudgetExceeded(await callsLastHour(businessSlug, chatId))) {
        await audit(businessSlug, "system", null, "orders.monitor_rate_limited", { type: "chat", id: chatId }, {});
        return { reasons: [MONITOR_BUDGET_REASON] };
      }
      // Counted before the call, so a failing model still uses budget (a broken key can't be retried into a bill).
      await audit(businessSlug, "system", null, CALL_ACTION, { type: "chat", id: chatId }, { author: "customer" });
      const res = await proposeOrderUpdate({
        businessSlug,
        customerName,
        openOrders: ordersForModel(open),
        orderHistory: historyForModel(history) ?? undefined,
        transcript: recent,
        newMessages: a.transcript,
        author: "customer",
      });
      if (!res.proposal) {
        await failed(businessSlug, chatId, "model", res.error ?? "no proposal");
        return { reasons: ["orders_monitor_failed"] };
      }
      proposal = { order_request: res.proposal.order_request, order_target: res.proposal.order_target ?? null, other_orders: res.proposal.other_orders };
      intent = res.proposal.intent;
    }
    const tracked = await trackOrders({
      settings: a.settings,
      businessSlug,
      chatId,
      phone: identity.phone,
      customerName,
      intent,
      proposal,
      segments: a.segments,
      // Grounding: the customer's own words only (this turn, and their earlier messages in the stored history).
      customerWords: [...a.segments, ...recent.filter((m) => m.who === "Customer").map((m) => m.text)],
      chatIds: identity.chatIds,
      history,
      messageIds: a.messageIds,
      firstAt: a.firstAt,
      lastAt: a.lastAt,
      dedupeBase: a.dedupeBase,
    });
    return { reasons: [plan.reason, ...tracked.reasons] };
  } catch (err) {
    await failed(businessSlug, chatId, "track", err instanceof Error ? err.message : "Unknown error");
    return { reasons: ["orders_monitor_failed"] };
  }
}

export interface MonitorStaffArgs {
  settings: AgentSettings;
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  text: string;
  hasMedia: boolean;
  whatsappMessageId: string;
  timestamp: string | null;
  eventId: string;
}

/**
 * A message the business itself wrote in a customer chat (business phone, inbox, linked device). It is read for what
 * it says about an EXISTING order and can only flag that order for a person to verify (see flagOrderFromStaff).
 * Only when an order is open and the wording could matter does it cost a model call.
 */
export async function monitorStaffMessage(a: MonitorStaffArgs): Promise<MonitorResult> {
  const { businessSlug, chatId } = a;
  if (!a.settings.orders_tracking_enabled) return { reasons: [] };
  if (!monitorEligibleChat(chatId)) return { reasons: [] };
  try {
    const key = `${a.eventId}:staffflag`;
    if (await alreadyApplied(a.eventId)) return { reasons: ["orders_monitor_already_applied"] };
    const open = await loadOpenOrders(businessSlug, chatId);
    const plan = monitorPrefilter({ author: "staff", segments: [a.text], hasMedia: a.hasMedia, openOrders: open.length });
    if (plan.action !== "analyse") return { reasons: [plan.reason] };
    if (monitorBudgetExceeded(await callsLastHour(businessSlug, chatId))) {
      await audit(businessSlug, "system", null, "orders.monitor_rate_limited", { type: "chat", id: chatId }, {});
      return { reasons: [MONITOR_BUDGET_REASON] };
    }
    await audit(businessSlug, "system", null, CALL_ACTION, { type: "chat", id: chatId }, { author: "staff" });
    const identity = await loadIdentity(businessSlug, chatId, a.contactNumber);
    const customerName = await loadCustomerDisplayName(identity, a.contactNumber, chatId);
    const recent = await loadRecentMessages(businessSlug, chatId, [a.whatsappMessageId]);
    const res = await proposeOrderUpdate({
      businessSlug,
      customerName,
      openOrders: ordersForModel(open),
      transcript: recent,
      newMessages: `[${(a.timestamp && !Number.isNaN(Date.parse(a.timestamp)) ? new Date(a.timestamp) : new Date()).toISOString().slice(11, 19)}] ${a.text}`,
      author: "staff",
    });
    if (!res.proposal) {
      await failed(businessSlug, chatId, "model", res.error ?? "no proposal");
      return { reasons: ["orders_monitor_failed"] };
    }
    const action: StaffAction | null = res.proposal.staff_action;
    if (!action) return { reasons: [plan.reason, "orders_monitor_staff_no_order_effect"] };
    const flagged = await flagOrderFromStaff({
      businessSlug,
      chatId,
      target: res.proposal.order_target ?? null,
      action,
      text: a.text,
      messageId: a.whatsappMessageId,
      key,
    });
    return { reasons: [plan.reason, flagged.reason] };
  } catch (err) {
    await failed(businessSlug, chatId, "staff", err instanceof Error ? err.message : "Unknown error");
    return { reasons: ["orders_monitor_failed"] };
  }
}
