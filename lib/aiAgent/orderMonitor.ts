// Order monitoring — pure rules (no I/O), unit-tested in tests/aiAgentOrderMonitor.test.ts.
//
// Daily order tracking reads EVERY genuine 1:1 customer conversation of a business that switched it on, whether or not
// the AI may reply there. Two things stay strictly apart:
//
//   * monitoring (this file, lib/server/aiAgent/orderMonitor.ts): reads messages to keep order records. It can never
//     create an outbox item, never changes a customer's mode, and never grants permission to reply.
//   * replying (engine.ts, customerSend.ts): decided only by the existing gate and send policy.
//
// Conversations the AI also answers reuse that turn's single model call (decide.ts). Monitoring-only conversations use
// a separate, small, incremental call (model.ts proposeOrderUpdate) that sees the customer's open orders, the last few
// messages and the NEW message(s) only, never the whole history. A free, deterministic pre-filter decides whether even
// that call is worth making, and it errs on the side of analysing: with an open order, any real message is analysed,
// because a follow-up may change that order.

import { chatKind } from "./engine.ts";
import { isCancellation, isTrivialTurn } from "./escalationUpdates.ts";
import { turnIsConfirmation } from "./orders.ts";

/** Gate refusals that only mean "the AI may not REPLY here". Monitoring is independent of every one of them. */
export const MONITOR_GATE_REASONS = new Set([
  "contact_excluded",
  "contact_not_permitted",
  "unresolved_lid_identity",
  "human_takeover",
  "staff_recently_active",
  "customer_mode_manual_only",
]);

/** True when the gate stopped the AI ONLY for reasons that do not affect monitoring. */
export function gateAllowsMonitoring(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => MONITOR_GATE_REASONS.has(r));
}

/** A genuine 1:1 customer conversation: never a group (staff group included), status/broadcast, newsletter or system chat. */
export function monitorEligibleChat(chatId: string): boolean {
  return chatKind(chatId) === "direct";
}

// ── Pre-filter ───────────────────────────────────────────────────────────────

/** Words that suggest someone is ordering, changing or cancelling something. Deliberately broad: a miss is worse than a call. */
const ORDER_SIGNAL =
  /\d|\b(order\w*|want\w*|need\w*|bags?|kg|kilos?|lbs?|pounds?|box(?:es)?|cartons?|cases?|dozen|deliver\w*|collect\w*|pick\s?up|buy\w*|get me|send\w*|bring\w*|drop\s?off|cancel\w*|can i|could i|i'?ll take|i'?d like|would like|add|change|instead|also|another|more|less|same|usual|last time|as before|again|this time|somewhere else|different (?:place|address|location))\b/i;

/** Words a staff message may use about an existing order. */
const STAFF_SIGNAL =
  /\d|\b(confirm\w*|cancel\w*|deliver\w*|collect\w*|ready|total|price|cost|bags?|kg|order\w*|address|tomorrow|today|tonight|noted|dispatch\w*|done|sorted|all set|out of stock|don'?t have|only have|change\w*|instead)\b/i;

const MEDIA_PLACEHOLDER = "(media message without text)";

export type MonitorPlan = { action: "analyse" | "deterministic" | "skip"; reason: string };

export interface PrefilterInput {
  author: "customer" | "staff";
  /** The new message(s) as written, one per entry. */
  segments: string[];
  hasMedia: boolean;
  /** How many open orders this chat already has. */
  openOrders: number;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Decides, for free, how a message is handled:
 *   skip           nothing to analyse (no words, a pleasantry, or no sign of an order and none is open)
 *   deterministic  a bare "yes" or a short "cancel it" for an open order: the server's rules handle it, no model call
 *   analyse        one small incremental model call
 */
export function monitorPrefilter(input: PrefilterInput): MonitorPlan {
  const real = input.segments.map((s) => s.trim()).filter((s) => s && s !== MEDIA_PLACEHOLDER);
  if (real.length === 0) return { action: "skip", reason: input.hasMedia ? "orders_monitor_skipped_media_only" : "orders_monitor_skipped_empty" };
  if (isTrivialTurn(real)) return { action: "skip", reason: "orders_monitor_skipped_acknowledgement" };
  const joined = real.join(" ");

  if (input.author === "staff") {
    if (input.openOrders === 0) return { action: "skip", reason: "orders_monitor_skipped_no_open_order" };
    if (!STAFF_SIGNAL.test(joined)) return { action: "skip", reason: "orders_monitor_skipped_no_order_signal" };
    return { action: "analyse", reason: "orders_monitor_staff_message" };
  }

  if (input.openOrders > 0) {
    if (turnIsConfirmation(real)) return { action: "deterministic", reason: "orders_monitor_confirmation" };
    if (real.length === 1 && wordCount(real[0]) <= 6 && isCancellation(real[0])) return { action: "deterministic", reason: "orders_monitor_cancellation" };
    return { action: "analyse", reason: "orders_monitor_follow_up" };
  }
  if (!ORDER_SIGNAL.test(joined)) return { action: "skip", reason: "orders_monitor_skipped_no_order_signal" };
  return { action: "analyse", reason: "orders_monitor_new_message" };
}

// ── Budgets ──────────────────────────────────────────────────────────────────

/** Monitoring-only model calls allowed per chat and per business per hour. Beyond that the message is recorded as not analysed. */
export const MONITOR_CALLS_PER_CHAT_PER_HOUR = 20;
export const MONITOR_CALLS_PER_BUSINESS_PER_HOUR = 300;

export function monitorBudgetExceeded(counts: { chat: number; business: number }): boolean {
  return counts.chat >= MONITOR_CALLS_PER_CHAT_PER_HOUR || counts.business >= MONITOR_CALLS_PER_BUSINESS_PER_HOUR;
}

// ── Reason codes (what an event records, what coverage reads) ────────────────

/** The monitoring path ran and could not analyse: an error, a model failure. The report says orders there may be missing. */
export const MONITOR_FAILED_REASONS = new Set(["orders_monitor_failed", "orders_tracking_failed", "model_unavailable", "internal_error"]);
/** Not analysed because the hourly model budget was used up. Reported separately: it is a limit, not a fault. */
export const MONITOR_BUDGET_REASON = "orders_monitor_rate_limited";
/** Deliberately not analysed in detail by the free pre-filter (pleasantries, no order wording). Counted for the dashboard only. */
export const MONITOR_FILTERED_PREFIX = "orders_monitor_skipped_";

// ── Staff messages ───────────────────────────────────────────────────────────

export type StaffAction = "confirms" | "cancels" | "changes";

/**
 * What a staff message in the chat may do to an order: raise a flag for a person to verify. It never confirms,
 * cancels or edits the order (the business phone cannot say WHO wrote, and staff verification stays the rule), and it
 * never creates an order: a message staff wrote is not the customer's request.
 */
export const STAFF_ACTION_ATTENTION: Record<StaffAction, string> = {
  confirms: "staff_confirmed_in_chat",
  cancels: "staff_cancelled_in_chat",
  changes: "staff_changed_in_chat",
};

/** Flags that must not be replaced by a staff flag: they say the CUSTOMER changed or withdrew something. */
const STRONGER_ATTENTION = new Set(["changed_after_confirmation", "cancellation_requested"]);

export function staffFlagFor(action: StaffAction | null, existing: string | null): string | null {
  if (!action) return null;
  if (existing && STRONGER_ATTENTION.has(existing)) return null;
  const flag = STAFF_ACTION_ATTENTION[action];
  return flag === existing ? null : flag;
}

// ── Backfill (opt-in recovery of orders the old allow-list restriction never analysed) ──

export const BACKFILL_MAX_HOURS = 72;
/** Conversations one run will plan (the most recently active first); the rest is reported, never silently dropped. */
export const BACKFILL_CHAT_CAP = 200;
export const BACKFILL_CHUNK_SIZE = 25;
export const BACKFILL_MAX_CHUNKS_PER_CHAT = 6;

export function validBackfillHours(hours: unknown): hours is number {
  return typeof hours === "number" && Number.isInteger(hours) && hours >= 1 && hours <= BACKFILL_MAX_HOURS;
}

/**
 * Was this stored customer message already read for orders when it arrived? Used to plan a backfill of ONLY what was
 * missed. No event = the agent never saw it; an errored event = it failed; a gate refusal with no monitoring or order
 * code beside it = the old rules stopped it. Everything else (answered by the AI path, filtered, monitored) was read.
 */
export function messageWasAnalysed(event: { status: string; reason_codes: string[] | null } | undefined): boolean {
  if (!event) return false;
  if (event.status === "error") return false;
  const codes = event.reason_codes ?? [];
  const refusedByOldRules = codes.some((c) => MONITOR_GATE_REASONS.has(c));
  const monitored = codes.some((c) => c.startsWith("orders_monitor") || c.startsWith("order_") || c === "orders_tracked");
  return !(refusedByOldRules && !monitored);
}

export function chunkBy<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One line of a replayed conversation. The author is always explicit, so a staff line can never read as the customer's. */
export function historyLine(m: { outbound: boolean; text: string; at: string }): string {
  const t = Date.parse(m.at);
  const stamp = Number.isNaN(t) ? "" : `[${new Date(t).toISOString().slice(0, 16).replace("T", " ")}] `;
  return `${stamp}${m.outbound ? "STAFF" : "CUSTOMER"}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 400)}`;
}
