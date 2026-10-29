// Rules & Routing: which WhatsApp group hears about what. Pure (no I/O), unit-tested in tests/aiAgentRouting.test.ts.
//
//   orders       the daily summary and the order commands. This category IS the existing "orders group" (orders_group_jid);
//                it takes order commands only and never escalations or drafts, exactly as before.
//   complaints   escalations about a complaint, refund, payment claim, health or legal matter
//   urgent       escalations whose priority is urgent (wins over complaints)
//   approvals    in Approval Pilot, the escalation notices that carry a draft reply for staff to approve
//
// Anything a rule does not claim (a disabled or empty rule, or a notice no category fits) goes to the staff group, which is
// the fallback and the only group that is always honoured. A notice is sent to exactly ONE group.
//
// A group named by an enabled rule is an authorized staff group for that business: its messages are processed like the staff
// group's (escalation answers, !approve …), still only from the sender allow-list, and order commands are refused in it
// unless it is also the orders group. Rules are stored per business (ai_agent_settings.routing_rules), so one business's groups
// can never receive or answer another business's notices.

import type { AgentMode, AgentSettings } from "./engine.ts";

export const ROUTED_CATEGORIES = ["complaints", "urgent", "approvals"] as const;
export type RoutedCategory = (typeof ROUTED_CATEGORIES)[number];

export interface RoutingRule {
  enabled: boolean;
  group_jid: string | null;
  group_name: string | null;
}
export type RoutingRules = Partial<Record<RoutedCategory, RoutingRule>>;

export const CATEGORY_LABEL: Record<RoutedCategory | "orders", string> = {
  orders: "Orders and daily summaries",
  complaints: "Complaints and disputes",
  urgent: "Urgent escalations",
  approvals: "AI response approvals",
};

const GROUP_JID = /^[0-9]+(?:-[0-9]+)*@g\.us$/;
export const isGroupJid = (v: unknown): v is string => typeof v === "string" && GROUP_JID.test(v.trim().toLowerCase());

/** Reads stored rules defensively: unknown categories, malformed JIDs and non-booleans are dropped, never trusted. */
export function parseRoutingRules(raw: unknown): RoutingRules {
  const out: RoutingRules = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const category of ROUTED_CATEGORIES) {
    const r = (raw as Record<string, unknown>)[category];
    if (!r || typeof r !== "object") continue;
    const rule = r as Record<string, unknown>;
    const jid = isGroupJid(rule.group_jid) ? String(rule.group_jid).trim().toLowerCase() : null;
    out[category] = {
      enabled: rule.enabled === true && jid !== null,
      group_jid: jid,
      group_name: typeof rule.group_name === "string" ? rule.group_name.slice(0, 200) || null : null,
    };
  }
  return out;
}

type RoutingSettings = Pick<AgentSettings, "staff_group_jid"> & { routing_rules?: unknown };

/** The group an enabled rule sends `category` to, or null. A rule pointing at the staff group is no routing at all. */
export function routedGroup(settings: RoutingSettings | null, category: RoutedCategory): string | null {
  // Without a staff group there is no fallback, so no routing: rules wait until one is set.
  if (!settings?.staff_group_jid) return null;
  const rule = parseRoutingRules(settings?.routing_rules)[category];
  if (!rule?.enabled || !rule.group_jid) return null;
  return rule.group_jid === settings?.staff_group_jid ? null : rule.group_jid;
}

/** Every group an enabled rule names (never the staff group itself), without repeats. */
export function routedGroups(settings: RoutingSettings | null): string[] {
  return [...new Set(ROUTED_CATEGORIES.flatMap((c) => routedGroup(settings, c) ?? []))];
}

export const isRoutedGroup = (settings: RoutingSettings | null, jid: string | null | undefined): boolean => Boolean(jid) && routedGroups(settings).includes(jid!);

const COMPLAINT_CODES = ["complaint", "refund", "payment_claim", "health_concern", "legal_threat"];

/** The category an escalation notice belongs to, or null (unclassified: it goes to the staff group). */
export function categoryForEscalation(e: { priority: string; reasonCodes: string[]; mode: AgentMode }): RoutedCategory | null {
  if (e.priority === "urgent") return "urgent";
  if (e.reasonCodes.some((c) => COMPLAINT_CODES.includes(c))) return "complaints";
  // In Approval Pilot a notice IS an approval request (it carries the AI's draft).
  if (e.mode === "approval_pilot") return "approvals";
  return null;
}

/**
 * Where a notice goes: the routed group of its category, else the staff group. `null` category = unclassified.
 * Never returns a group of another business: the rules are read from this business's own settings.
 */
export function noticeGroup(settings: RoutingSettings | null, category: RoutedCategory | null): string | null {
  return (category ? routedGroup(settings, category) : null) ?? settings?.staff_group_jid ?? null;
}

/**
 * The settings a message from a routed group is processed with: that group stands in as the staff group, so every reply (feedback,
 * drafts, relays' confirmations) goes back to the group the staff member wrote in, and the orders group is pinned to what it was, so
 * order commands are still refused in a routed group.
 */
export function settingsForRoutedGroup(settings: AgentSettings, chatId: string): AgentSettings {
  return { ...settings, staff_group_jid: chatId, orders_group_jid: settings.orders_group_jid ?? settings.staff_group_jid };
}

export interface RoutingPatchRule {
  enabled: boolean;
  groupJid: string | null;
  groupName?: string | null;
}

/** Validates an admin's routing rules from the request body. Returns the rules to store or an error message. */
export function validateRoutingRules(input: unknown, staffGroupJid: string | null): { ok: true; rules: RoutingRules } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "routingRules must be an object" };
  const rules: RoutingRules = {};
  for (const [category, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(ROUTED_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: `Unknown routing category "${category}"` };
    if (!value || typeof value !== "object") return { ok: false, error: `${category}: invalid rule` };
    const v = value as Record<string, unknown>;
    if (typeof v.enabled !== "boolean") return { ok: false, error: `${category}: enabled must be a boolean` };
    const jid = v.groupJid === null || v.groupJid === undefined || v.groupJid === "" ? null : isGroupJid(v.groupJid) ? String(v.groupJid).trim().toLowerCase() : "invalid";
    if (jid === "invalid") return { ok: false, error: `${category}: the group must be a WhatsApp group id (…@g.us)` };
    if (v.enabled && !jid) return { ok: false, error: `${category}: choose a group before turning the rule on` };
    if (v.enabled && !staffGroupJid) return { ok: false, error: "Set the staff group first: it is the fallback for anything a rule does not claim" };
    rules[category as RoutedCategory] = {
      enabled: v.enabled,
      group_jid: jid,
      group_name: typeof v.groupName === "string" ? v.groupName.trim().slice(0, 200) || null : null,
    };
  }
  return { ok: true, rules };
}
