// Per-customer AI handling modes — pure, no I/O (like engine.ts, which imports it).
//
//   auto_reply   the AI answers by itself when approved knowledge and every existing safety rule
//                allow it, and escalates when staff are needed
//   staff_first  the AI prepares summaries, escalations and drafts for staff but NEVER sends a
//                customer-bound message of its own (the default for everyone)
//   manual_only  no automatic AI replies and no automatic escalations
//
// A mode only ever NARROWS what the business-wide settings allow. The kill switch, Observe mode,
// contact scope / allow-list, human takeover and send authorization are all checked first and are
// never relaxed by a customer's mode: Auto-Reply on a customer in Observe mode still sends nothing.

export const CUSTOMER_MODES = ["auto_reply", "staff_first", "manual_only"] as const;
export type CustomerMode = (typeof CUSTOMER_MODES)[number];

/** What a customer gets when neither their conversation nor the business says otherwise. */
export const FALLBACK_CUSTOMER_MODE: CustomerMode = "staff_first";

export const CUSTOMER_MODE_LABEL: Record<CustomerMode, string> = {
  auto_reply: "AI Auto-Reply",
  staff_first: "Staff First",
  manual_only: "Manual Only",
};

export const CUSTOMER_MODE_HINT: Record<CustomerMode, string> = {
  auto_reply: "AI answers routine questions from approved knowledge and escalates the rest.",
  staff_first: "AI prepares summaries and drafts for staff. It never messages the customer by itself.",
  manual_only: "No automatic AI replies or escalations for this customer.",
};

export function isCustomerMode(value: unknown): value is CustomerMode {
  return typeof value === "string" && (CUSTOMER_MODES as readonly string[]).includes(value);
}

/**
 * The mode in force: the customer's own setting, else the business default, else Staff First.
 * An unrecognised stored value fails to the safest non-silent mode, never to Auto-Reply.
 */
export function effectiveCustomerMode(
  settings: { default_customer_mode?: string | null } | null | undefined,
  conversation: { customer_mode?: string | null } | null | undefined
): CustomerMode {
  const own = conversation?.customer_mode;
  if (own) return isCustomerMode(own) ? own : FALLBACK_CUSTOMER_MODE;
  const fallback = settings?.default_customer_mode;
  return isCustomerMode(fallback) ? fallback : FALLBACK_CUSTOMER_MODE;
}

/** Outbox kinds the AI itself creates for the customer, without a person asking for that exact text. */
export const AUTONOMOUS_CUSTOMER_KINDS = ["customer_reply", "holding_reply"] as const;

/**
 * True when an item of this kind may exist for a customer in this mode. Only the autonomous kinds
 * depend on the mode; a "!send" / dashboard relay is a person's explicit authorization and goes
 * through the central send policy (customerSend.ts) instead.
 */
export function customerModeAllowsKind(mode: CustomerMode, kind: string): boolean {
  if ((AUTONOMOUS_CUSTOMER_KINDS as readonly string[]).includes(kind)) return mode === "auto_reply";
  return true;
}

export type ModeDecision = "REPLY" | "ASK" | "ESCALATE" | "NO_REPLY";

/**
 * What a customer's mode makes of the engine's decision for their message.
 *   auto_reply   unchanged
 *   staff_first  a reply the AI would have sent becomes an escalation carrying that reply as a draft for
 *                staff — unless there is nothing for staff to do (small talk), which stays quiet
 *   manual_only  nothing (the gate normally stops these messages earlier; this is the backstop)
 * An ESCALATE stays an ESCALATE in Staff First.
 */
export function modeAdjustedDecision(
  mode: CustomerMode,
  decision: "REPLY" | "ASK" | "ESCALATE",
  opts: { noActionNeeded: boolean }
): ModeDecision {
  if (mode === "auto_reply") return decision;
  if (mode === "manual_only") return "NO_REPLY";
  if (decision === "ESCALATE") return "ESCALATE";
  return opts.noActionNeeded ? "NO_REPLY" : "ESCALATE";
}
