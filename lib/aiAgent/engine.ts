// The AI agent's decision rules — pure functions, no I/O (only the pure outboxStatus helpers), so the
// whole policy is unit-testable (tests/aiAgentEngine.test.ts) and identical in
// the live path, the test console and the bridge contract. The server
// orchestrator (lib/server/aiAgent/decide.ts) loads data, calls the model, and
// then defers EVERY decision to resolveDecision()/evaluateGate() here. Nothing
// in the bridge or the browser makes AI decisions.
//
// Mandatory safeguards (complaints, discounts, refunds, payment claims,
// exceptions, order approval, prompt injection, unverified facts, unsafe
// commitments) always escalate. The autonomy slider only moves the confidence
// bar for otherwise-clean REPLY/ASK proposals — it can never bypass them.

import { BLOCK_REASONS, failureReason } from "./outboxStatus.ts";
import type { RepeatResolution } from "./memory.ts";
import { type CustomerMode, effectiveCustomerMode } from "./customerMode.ts";
import type { PilotCommand } from "./pilot.ts";

// ── Constants ────────────────────────────────────────────────────────────────

// Any configured business may run the agent, but every business starts OFF /
// observe / no contacts (the ai_agent_settings column defaults) and is only
// ever enabled by an explicit admin action. There is no allow-list: the former
// Dog Food-only restriction (and its ai_agent_settings_pilot_only constraint)
// was removed by 20261023000000_ai_agent_multi_business.sql.
export const DEFAULT_AGENT_SETTINGS = {
  enabled: false,
  mode: "observe",
  contact_scope: "none",
} as const;

export const AGENT_DECISIONS = ["REPLY", "ASK", "ESCALATE", "NO_REPLY", "HUMAN"] as const;
export type AgentDecision = (typeof AGENT_DECISIONS)[number];

// observe: never messages customers. approval_pilot: the AI never sends on its own; an explicitly
// authorized staff member's !approve / !send (staff_relay) is the only way a customer is messaged.
// assisted: the AI may also send its own verified replies.
export const AGENT_MODES = ["observe", "approval_pilot", "assisted"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const CONTACT_SCOPES = ["none", "all", "selected"] as const;
export type ContactScope = (typeof CONTACT_SCOPES)[number];

export const ESCALATION_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type EscalationPriority = (typeof ESCALATION_PRIORITIES)[number];

export const KNOWLEDGE_KINDS = ["product", "price", "policy", "hours", "delivery", "faq", "tone", "other"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const DEFAULT_AUTONOMY = 30;
export const MAX_REPLY_CHARS = 1000;

export const HOLDING_REPLY_GENERAL =
  "Thanks for your message! I've passed this to our team and someone will get back to you shortly.";
export const HOLDING_REPLY_ORDER =
  "Thanks! I've noted your order request and passed it to our team. They'll confirm availability, the total and delivery details with you shortly.";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentSettings {
  business_slug: string;
  enabled: boolean;
  mode: AgentMode;
  contact_scope: ContactScope;
  autonomy: number;
  staff_group_jid: string | null;
  staff_group_name: string | null;
  auto_takeover_minutes: number;
  max_auto_replies_per_hour: number;
  send_holding_reply: boolean;
  /** Observe mode only: permit staff_notice (never customer messages) to the staff group. Default false. */
  staff_notices_enabled: boolean;
  /** Group a customer's rapid-fire messages into one turn (see lib/aiAgent/batching.ts). Default false. */
  batching_enabled: boolean;
  /** Seconds of silence after the latest inbound message before the batch is processed (0–120). */
  batch_quiet_seconds: number;
  /** A batch is processed at most this long after its first message, however chatty the customer is. */
  batch_max_wait_seconds: number;
  /** Let the agent capture explicit customer preferences / resolved issues into long-term memory. Default false. */
  customer_memory_enabled: boolean;
  /**
   * Verified WhatsApp identities (phone digits or exact "<digits>@lid") allowed to make the agent message a
   * customer from the staff group ("!send"). Empty/absent = nobody. See authorizeStaffSender() in identity.ts.
   */
  staff_authorized_senders?: string[] | null;
  /** Mode of every customer without their own setting (lib/aiAgent/customerMode.ts). Absent/unknown = Staff First. */
  default_customer_mode?: CustomerMode | null;
  /** Passive learning from authorized staff messages (lib/aiAgent/pilot.ts). Absent = "off". */
  passive_learning_scope?: PassiveLearningScope | null;
  /** Authorized senders may confirm knowledge candidates with !confirm. Absent/false = admins only. */
  knowledge_confirm_via_whatsapp?: boolean | null;
  /** Daily order tracking (lib/aiAgent/orders.ts): extract orders from conversations into ai_agent_orders. Absent = off. */
  orders_tracking_enabled?: boolean | null;
  /** The 8 AM summary and the "!update" command. Absent = off. */
  orders_summary_enabled?: boolean | null;
  /** Where the summary is posted; null = the staff group. */
  orders_group_jid?: string | null;
  orders_group_name?: string | null;
  /** IANA timezone of the schedule. Absent = America/St_Lucia. */
  orders_timezone?: string | null;
  orders_summary_hour?: number | null;
  /** Rollout safety: may a customer's own "yes" finalize an order? Absent/false = it is only recorded for staff to verify. */
  orders_customer_confirms?: boolean | null;
  /** When order tracking was last switched on. */
  orders_tracking_since?: string | null;
}

/** Where the order summary goes and "!update" is accepted: the orders group, else the staff group. */
export function ordersGroupJid(settings: AgentSettings | null): string | null {
  return settings?.orders_group_jid || settings?.staff_group_jid || null;
}

/** The orders group is a different group from the staff group (so it needs its own bridge forwarding and send rule). */
export function hasSeparateOrdersGroup(settings: AgentSettings | null): boolean {
  return Boolean(settings?.orders_group_jid && settings.orders_group_jid !== settings.staff_group_jid);
}

/** Whether the order summary (scheduled or "!update") may be posted right now. Never customer-bound. */
export function canPostOrderSummary(settings: AgentSettings | null): boolean {
  if (!settings?.enabled || !settings.orders_summary_enabled || !ordersGroupJid(settings)) return false;
  if (settings.mode === "assisted" || settings.mode === "approval_pilot") return true;
  return settings.mode === "observe" && settings.staff_notices_enabled === true;
}

export const PASSIVE_LEARNING_SCOPES = ["off", "staff_group", "staff_group_and_chats"] as const;
export type PassiveLearningScope = (typeof PASSIVE_LEARNING_SCOPES)[number];

export type ContactRule = "allow" | "exclude";

export interface ConversationControl {
  control: "ai" | "human";
  human_until: string | null;
  /** This customer's own handling mode; null/absent = the business default. */
  customer_mode?: CustomerMode | null;
}

export interface OrderItem {
  product: string;
  quantity: string | null;
  /** Daily order tracking only (lib/aiAgent/orders.ts). Present only when the customer stated it. */
  variant?: string | null;
  size?: string | null;
  /**
   * Daily order tracking only, from the model: the reference of an earlier verified order whose product this line names
   * (a generic "dog food" → that customer's usual bag). Unvalidated; the server accepts it only against the customer's own history.
   */
  from_history?: string | null;
}

export interface OrderRequestDraft {
  items: OrderItem[];
  delivery_address: string | null;
  delivery_preference: string | null;
  notes: string | null;
  /** Daily order tracking only: the day/time the customer asked for, in their words. Present only when stated. */
  requested_for?: string | null;
}

/** A further, distinct order the same customer turn started (daily order tracking). */
export interface AdditionalOrderDraft {
  /** Reference of the open order it adds to, or "new". */
  target: string;
  order: OrderRequestDraft;
}

export interface ModelProposal {
  decision: "REPLY" | "ASK" | "ESCALATE";
  intent: "question" | "order" | "complaint" | "smalltalk" | "other";
  reply: string | null;
  confidence: number;
  knowledge_ids: string[];
  escalation_reason: string | null;
  priority: EscalationPriority | null;
  summary: string | null;
  order_request: OrderRequestDraft | null;
  /** Daily order tracking: which open order `order_request` adds to (its reference), "new", or null when not stated. Unvalidated. */
  order_target?: string | null;
  /** Daily order tracking: further distinct orders in the same turn. Unvalidated. */
  other_orders?: AdditionalOrderDraft[];
  /** Raw, UNVALIDATED memory candidates; validateMemoryFacts() (lib/aiAgent/memory.ts) decides what is kept. */
  memory_facts?: unknown[];
}

export interface KnowledgeFact {
  id: string;
  content: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Canonical slug shape (see lib/businessSlug.ts); says nothing about whether the business exists. */
export function isValidBusinessSlug(businessSlug: string): boolean {
  return /^[a-z0-9_]{1,64}$/.test(businessSlug);
}

/**
 * Minimum model confidence for an auto-sent REPLY/ASK. Autonomy 0 never
 * auto-sends; 30 (default) ≈ 0.87; 100 ≈ 0.65. Never lower than 0.65.
 */
export function requiredConfidence(autonomy: number): number {
  const a = Math.max(0, Math.min(100, Math.round(autonomy)));
  if (a === 0) return Number.POSITIVE_INFINITY;
  return Math.round((0.97 - 0.32 * (a / 100)) * 1000) / 1000;
}

export function isHumanControlActive(conversation: ConversationControl | null, now: Date): boolean {
  if (!conversation || conversation.control !== "human") return false;
  if (!conversation.human_until) return true;
  return new Date(conversation.human_until).getTime() > now.getTime();
}

export function chatKind(chatId: string): "group" | "system" | "direct" {
  const id = chatId.trim().toLowerCase();
  if (id.endsWith("@g.us")) return "group";
  if (id === "broadcast" || id.endsWith("@broadcast") || id.endsWith("@newsletter")) return "system";
  return "direct";
}

// ── Send policy: which outbox kinds a business may produce ───────────────────
//
// customer_reply / holding_reply / staff_relay reach a customer and exist only
// in Assisted mode. staff_notice, staff_draft and staff_feedback go to the staff
// group: staff_notice and staff_draft (the drafted customer reply posted after a
// staff answer) may also be sent in Observe mode, but only when the business has
// staff_notices_enabled AND a staff group. Observe mode never sends anything
// else. Staff-group sending (canSendStaffNotice) and customer sending
// (canSendToCustomers) are separate permissions: neither implies the other.
// The bridge enforces the same table independently.

export const STAFF_GROUP_KINDS = ["staff_notice", "staff_draft", "staff_feedback"] as const;

/** True for outbox kinds addressed to the customer (everything but the staff-group kinds). */
export function isCustomerBoundKind(kind: string): boolean {
  return !(STAFF_GROUP_KINDS as readonly string[]).includes(kind);
}

/** Autonomous customer-facing sends (the AI's own replies, questions, holding replies): Assisted mode only. */
export function canSendToCustomers(settings: AgentSettings | null): boolean {
  return Boolean(settings?.enabled && settings.mode === "assisted");
}

/**
 * Whether an explicitly authorized staff send (staff_relay: "!send", "!approve", the dashboard button) may reach a
 * customer, and whether the staff group gets feedback messages. Assisted and Approval Pilot; never Observe.
 */
export function canSendApproved(settings: AgentSettings | null): boolean {
  return Boolean(settings?.enabled && (settings.mode === "assisted" || settings.mode === "approval_pilot"));
}

/** Whether an escalation notice may be posted to the staff group right now. */
export function canSendStaffNotice(settings: AgentSettings | null): boolean {
  if (!settings?.enabled || !settings.staff_group_jid) return false;
  if (settings.mode === "assisted" || settings.mode === "approval_pilot") return true;
  return settings.mode === "observe" && settings.staff_notices_enabled === true;
}

/** Observe-capable staff-group kinds: a notice, or the draft posted after a staff answer. */
const OBSERVE_STAFF_KINDS: readonly string[] = ["staff_notice", "staff_draft"];

/** Final gate on every item the live path is about to enqueue. */
export function outboxAllowed(settings: AgentSettings | null, item: { kind: string; toJid: string }): boolean {
  if (!settings?.enabled) return false;
  // A separate orders group takes only the order summary (and refusals to "!update"), in the same modes the staff
  // group takes notices. The staff group's own rules below are unchanged.
  if (hasSeparateOrdersGroup(settings) && item.toJid === settings.orders_group_jid) {
    const kinds = settings.mode === "observe" ? ["staff_notice"] : ["staff_notice", "staff_feedback"];
    return kinds.includes(item.kind) && canPostOrderSummary(settings);
  }
  if (settings.mode === "assisted") return true;
  if (settings.mode === "approval_pilot") {
    // Staff-group kinds to the staff group, or a staff_relay (an authorized staff send). Never the AI's own customer kinds.
    if (item.toJid === settings.staff_group_jid) return (STAFF_GROUP_KINDS as readonly string[]).includes(item.kind) && canSendStaffNotice(settings);
    return item.kind === "staff_relay";
  }
  return OBSERVE_STAFF_KINDS.includes(item.kind) && canSendStaffNotice(settings) && item.toJid === settings.staff_group_jid;
}

/** A staff_notice outbox row already created for an escalation (any status). */
export interface PriorNotice {
  status: string;
  error: string | null;
}

/** Failure codes that mean "nothing reached WhatsApp" and no ambiguity remains. */
function provablyNotSent(n: PriorNotice): boolean {
  if (n.status !== "failed") return false;
  const code = failureReason(n.error);
  if (!code) return false;
  // held_after_unknown_send is a block, but it follows an ambiguous send.
  if (code === "held_after_unknown_send") return false;
  return code === "not_sent" || BLOCK_REASONS.has(code);
}

/**
 * Why a follow-up on an open escalation must not post another notice, or null
 * when no notice was ever delivered or could still be delivered. Anything
 * pending, in flight, delivered, unresolved, or failed without proof it was
 * not sent holds the escalation: a possibly-delivered message is never retried.
 */
export function priorNoticeHold(prior: PriorNotice[]): string | null {
  if (prior.some((n) => n.status === "sent")) return "notice_already_sent";
  if (prior.some((n) => n.status === "pending" || n.status === "dispatched")) return "notice_in_flight";
  if (prior.some((n) => !provablyNotSent(n))) return "notice_send_unconfirmed";
  return null;
}

/**
 * True when the escalation still needs its FIRST notice: it is not a brand-new
 * escalation but no notice has gone out, nor can one still go out.
 */
export function needsFirstNotice(followUp: boolean, prior: PriorNotice[] | undefined): boolean {
  return followUp && prior !== undefined && priorNoticeHold(prior) === null;
}

/**
 * Why a staff notice (first notice or update) cannot be posted at all, or null when it may be.
 * Whether an OPEN escalation needs a new notice is a separate question — a customer's later
 * message is only worth one when it changes something (lib/aiAgent/escalationUpdates.ts); this
 * only answers "is posting to the staff group permitted for this business right now".
 */
export function staffNoticeSkipReason(settings: AgentSettings | null): string | null {
  if (!settings?.staff_group_jid) return "no_staff_group";
  if (!canSendStaffNotice(settings)) return "staff_notices_disabled";
  return null;
}

// ── Gate: should the agent consider this message at all? ─────────────────────

export interface GateInput {
  businessSlug: string;
  chatId: string;
  fromMe: boolean;
  text: string;
  hasMedia: boolean;
  settings: AgentSettings | null;
  contactRule: ContactRule | null;
  /** An @lid chat with no verified phone number (see lib/aiAgent/identity.ts); diagnostic only, never grants access. */
  unresolvedLid?: boolean;
  conversation: ConversationControl | null;
  /** Newest manual (non-agent) staff message in this chat, if any. */
  staffActiveAt: string | null;
  now: Date;
  /**
   * A person explicitly asked for this send ("!send", the dashboard button): the customer's AI handling mode
   * governs what the AI does on its own and does not apply. Every other rule still does.
   */
  explicitStaffSend?: boolean;
}

export type GateResult =
  | { pass: true }
  | { pass: false; decision: "NO_REPLY" | "HUMAN" | "ESCALATE"; reasons: string[] };

export function evaluateGate(input: GateInput): GateResult {
  const { settings } = input;
  if (!isValidBusinessSlug(input.businessSlug)) return stop("NO_REPLY", "invalid_business");
  if (!settings || !settings.enabled) return stop("NO_REPLY", "agent_disabled");
  // Settings, rules and takeover state are per business: another business's
  // row must never authorise a reply here.
  if (settings.business_slug !== input.businessSlug) return stop("NO_REPLY", "business_mismatch");

  const kind = chatKind(input.chatId);
  if (kind === "system") return stop("NO_REPLY", "system_chat");
  if (kind === "group") return stop("NO_REPLY", "group_chat");
  if (input.fromMe) return stop("NO_REPLY", "outbound_message");

  if (input.contactRule === "exclude") return stop("NO_REPLY", "contact_excluded");
  if (settings.contact_scope === "none") return stop("NO_REPLY", "contact_not_permitted");
  if (settings.contact_scope === "selected" && input.contactRule !== "allow") {
    return input.unresolvedLid
      ? { pass: false, decision: "NO_REPLY", reasons: ["contact_not_permitted", "unresolved_lid_identity"] }
      : stop("NO_REPLY", "contact_not_permitted");
  }

  if (isHumanControlActive(input.conversation, input.now)) return stop("HUMAN", "human_takeover");
  if (input.staffActiveAt && settings.auto_takeover_minutes > 0) {
    const age = input.now.getTime() - new Date(input.staffActiveAt).getTime();
    if (age >= 0 && age < settings.auto_takeover_minutes * 60_000) return stop("HUMAN", "staff_recently_active");
  }

  // Checked after every business-wide rule above: a customer's mode only ever narrows what they allow.
  if (!input.explicitStaffSend && effectiveCustomerMode(settings, input.conversation) === "manual_only") return stop("NO_REPLY", "customer_mode_manual_only");

  if (!input.text.trim()) {
    return input.hasMedia ? stop("ESCALATE", "unsupported_media") : stop("NO_REPLY", "empty_message");
  }
  return { pass: true };
}

function stop(decision: "NO_REPLY" | "HUMAN" | "ESCALATE", reason: string): GateResult {
  return { pass: false, decision, reasons: [reason] };
}

// ── Mandatory safeguards on the CUSTOMER message ─────────────────────────────

const SAFEGUARD_PATTERNS: [code: string, pattern: RegExp][] = [
  ["health_concern", /\b(sick|vomit\w*|diarrh\w*|poison\w*|allerg\w*|seizure\w*|died|dead|emergency)\b/i],
  ["legal_threat", /\b(lawyer|attorney|legal action|sue|suing|police|consumer affairs)\b/i],
  [
    "complaint",
    /\b(complain\w*|disappoint\w*|unhappy|not happy|terrible|awful|worst|rude|damaged|broken|spoil\w*|expired|mou?ld\w*|maggot\w*|scam\w*|wrong (order|item|bag|food|product)|(never|still not|hasn'?t|didn'?t|did not) (arrive|arrived|come|came|receive|received))\b/i,
  ],
  ["refund", /\b(refund\w*|money back|charge ?back|overcharg\w*|double[- ]charg\w*|reimburs\w*)\b/i],
  [
    "discount",
    /\b(discount\w*|cheaper|best price|special price|promo\w*|coupon\w*|negotiat\w*|lower (the |your )?price|price match|waive\w*|free delivery|for free)\b/i,
  ],
  [
    "payment_claim",
    /\b(i('ve| have)? (just |already )?(paid|sent (the |you )?(money|payment|transfer)|transferred)|payment (sent|made|done)|proof of payment|(here('s| is)|attached|sending) (the |my )?(receipt|proof))\b/i,
  ],
  ["cancellation", /\b(cancel\w*)\b/i],
  ["exception", /\b(exception|special (request|arrangement|case)|pay (you )?later|on account|on credit|put it on (my )?tab)\b/i],
  ["human_requested", /\b((speak|talk|chat) (to|with) (a |the )?(human|person|someone|manager|owner|staff)|real person)\b/i],
];

const INJECTION_PATTERN =
  /((ignore|disregard|forget|override) (all |any |the )?(previous|prior|above|earlier|your|system) (instructions?|rules|prompts?|messages?))|system prompt|you are now|developer mode|jailbreak|act as (an? )?(admin|developer|system|different)|(reveal|show|print|tell me) (me )?(your|the) (prompt|instructions|rules|key|secret|password|config)|api[ _-]?key|secret key|service[ _-]?role|admin[ _-]?secret|access token|<\/?(system|assistant|instructions?)>/i;

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERN.test(text);
}

/** Reason codes that force ESCALATE regardless of autonomy. */
export function detectSafeguards(text: string): string[] {
  const codes = SAFEGUARD_PATTERNS.filter(([, p]) => p.test(text)).map(([code]) => code);
  if (detectPromptInjection(text)) codes.push("prompt_injection");
  return codes;
}

// ── Output safety on the PROPOSED REPLY ──────────────────────────────────────

const CREDENTIAL_PATTERN =
  /sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.|service[_ -]?role|supabase|whatsapp_admin|admin[_ -]?secret|api[_ -]?key|password|bearer\s+[A-Za-z0-9]/i;

// The agent may never confirm stock, payment, delivery, fulfilment, refunds
// or discounts — only staff can.
const COMMITMENT_PATTERN =
  /\b((is|are|been|be|all|now|and) confirmed|(order|booking|delivery|payment) (is |has been )?(placed|booked|confirmed|scheduled|received)|confirm(ed)? your (order|delivery|payment)|in stock|out of stock|(we|i) have (it|them|that|plenty|some) (available|in stock)?|available (now|today)|(will|'ll|shall) (be )?(deliver(ed)?|ship(ped)?|drop(ped)? (it )?off|arrive) (today|tomorrow|tonight|on|by|at|this|next)|received (your|the) (payment|money|transfer)|guarantee\w*|refund (is |has been )?(approved|issued|processed)|discount (is |has been )?(approved|applied))\b/i;

/** True when the text itself asserts stock, payment, delivery or another commitment. */
export function hasCommitmentLanguage(text: string): boolean {
  return COMMITMENT_PATTERN.test(text);
}

const MONEY_PATTERN =
  /(?:EC\$|US\$|XCD\s?|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:EC|XCD|USD|dollars?)\b/gi;

const LINK_PATTERN = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;

function normalizeAmount(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : raw;
}

function amountsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MONEY_PATTERN)) out.push(normalizeAmount(m[1] ?? m[2]));
  return out;
}

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)) out.add(normalizeAmount(m[0]));
  return out;
}

/**
 * Reason codes for anything unsafe in a reply the agent wants to send. Every
 * price and link must appear verbatim in the knowledge entries it cited.
 */
export function checkReplySafety(reply: string, citedKnowledge: KnowledgeFact[]): string[] {
  const codes: string[] = [];
  const corpus = citedKnowledge.map((k) => k.content).join("\n");
  if (CREDENTIAL_PATTERN.test(reply)) codes.push("credential_leak");
  if (COMMITMENT_PATTERN.test(reply)) codes.push("unsafe_commitment");

  const known = numbersIn(corpus);
  if (amountsIn(reply).some((a) => !known.has(a))) codes.push("unverified_price");

  const links = reply.match(LINK_PATTERN) ?? [];
  if (links.some((l) => !corpus.includes(l))) codes.push("unverified_link");

  if (reply.length > MAX_REPLY_CHARS) codes.push("reply_too_long");
  return codes;
}

// ── Order collection ─────────────────────────────────────────────────────────

function cleanText(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Later non-empty values win; items are replaced as a whole (the model returns the cumulative list). */
export function mergeOrderRequest(
  prior: OrderRequestDraft | null,
  update: OrderRequestDraft | null
): OrderRequestDraft | null {
  if (!prior && !update) return null;
  const base: OrderRequestDraft = prior ?? { items: [], delivery_address: null, delivery_preference: null, notes: null };
  if (!update) return base;
  return {
    items: update.items.length > 0 ? update.items : base.items,
    delivery_address: update.delivery_address ?? base.delivery_address,
    delivery_preference: update.delivery_preference ?? base.delivery_preference,
    notes: update.notes ?? base.notes,
  };
}

export type OrderField = "items" | "quantity" | "delivery_address" | "delivery_preference";

/** The customer will collect it themselves, so there is nothing to deliver and no address to ask for. */
export function isCollection(preference: string | null | undefined): boolean {
  return /\b(collect(ion|ing)?|pick[\s-]?up|pick(ing)? (it|them) up|come (and )?get|fetch)\b/i.test(preference ?? "");
}

export function missingOrderFields(request: OrderRequestDraft | null): OrderField[] {
  if (!request) return ["items", "quantity", "delivery_address", "delivery_preference"];
  const missing: OrderField[] = [];
  if (request.items.length === 0) missing.push("items");
  else if (request.items.some((i) => !i.quantity)) missing.push("quantity");
  if (!request.delivery_address && !isCollection(request.delivery_preference)) missing.push("delivery_address");
  if (!request.delivery_preference) missing.push("delivery_preference");
  return missing;
}

const FIELD_QUESTIONS: Record<OrderField, string> = {
  items: "which product(s) you'd like",
  quantity: "how many of each",
  delivery_address: "your delivery address",
  delivery_preference: "whether you'd like delivery or to collect, and your preferred day and time",
};

/** Deterministic fallback question when the model's ASK text is missing or unsafe. */
export function askForMissingFields(missing: OrderField[]): string {
  const parts = missing.map((f) => FIELD_QUESTIONS[f]);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Happy to help with that! So I can pass your request to the team, could you please let me know ${list}?`;
}

// ── Final decision ───────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<EscalationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

const CODE_PRIORITY: Record<string, EscalationPriority> = {
  health_concern: "urgent",
  legal_threat: "urgent",
  complaint: "high",
  refund: "high",
  payment_claim: "high",
  human_requested: "high",
  credential_leak: "high",
  cancellation: "normal",
  discount: "normal",
  exception: "normal",
  order_approval: "normal",
  prompt_injection: "normal",
  unsupported_media: "low",
};

export function priorityFor(codes: string[], modelPriority: EscalationPriority | null = null): EscalationPriority {
  let best: EscalationPriority = modelPriority ?? "normal";
  for (const code of codes) {
    const p = CODE_PRIORITY[code];
    if (p && PRIORITY_RANK[p] > PRIORITY_RANK[best]) best = p;
  }
  return best;
}

export interface ResolveInput {
  autonomy: number;
  safeguardCodes: string[];
  proposal: ModelProposal | null;
  activeKnowledge: KnowledgeFact[];
  priorOrderRequest: OrderRequestDraft | null;
  autoRepliesLastHour: number;
  maxAutoRepliesPerHour: number;
  hasOpenEscalation: boolean;
  /** "Same as last time" resolved against verified orders (lib/aiAgent/memory.ts); omit when not asked. */
  repeatOrder?: RepeatResolution;
}

export interface Resolution {
  decision: "REPLY" | "ASK" | "ESCALATE";
  reasons: string[];
  /** Text safe to auto-send to the customer (REPLY/ASK only). */
  reply: string | null;
  /** The model's suggestion, shown to staff when escalating. Never auto-sent. */
  draftReply: string | null;
  priority: EscalationPriority;
  confidence: number | null;
  requiredConfidence: number;
  orderRequest: OrderRequestDraft | null;
  orderComplete: boolean;
}

export function resolveDecision(input: ResolveInput): Resolution {
  const { proposal } = input;
  const threshold = requiredConfidence(input.autonomy);
  const repeat: RepeatResolution = input.repeatOrder ?? { kind: "none" };
  // "Same as last time" seeds the request with the one matching VERIFIED order's
  // items — but a request the customer is already building takes precedence.
  const prior =
    repeat.kind === "single" && (input.priorOrderRequest?.items.length ?? 0) === 0
      ? mergeOrderRequest(repeat.draft, input.priorOrderRequest)
      : input.priorOrderRequest;
  const orderRequest =
    proposal?.intent === "order" || prior
      ? mergeOrderRequest(prior, proposal?.order_request ?? null)
      : null;
  const missing = orderRequest ? missingOrderFields(orderRequest) : [];
  const orderComplete = Boolean(orderRequest) && missing.length === 0;

  const base = {
    draftReply: proposal?.reply ?? null,
    confidence: proposal?.confidence ?? null,
    requiredConfidence: threshold,
    orderRequest,
    orderComplete,
  };
  const escalate = (reasons: string[]): Resolution => ({
    ...base,
    decision: "ESCALATE",
    reasons,
    reply: null,
    priority: priorityFor(reasons, proposal?.priority ?? null),
  });

  if (input.hasOpenEscalation) return escalate(["open_escalation", ...input.safeguardCodes]);
  if (input.safeguardCodes.length > 0) return escalate(input.safeguardCodes);

  // No usable verified order to repeat: staff handle it, nothing is guessed.
  if (repeat.kind === "no_history" || repeat.kind === "unclear") return escalate([`repeat_order_${repeat.kind}`]);
  // Several readings of "same as last time": ask, from verified records only.
  // Deterministic text (no model), but the same send limits still apply.
  if (repeat.kind === "ambiguous") {
    const unsafe = checkReplySafety(repeat.question, []);
    if (unsafe.length > 0) return escalate(["repeat_order_ambiguous", ...unsafe]);
    if (threshold === Number.POSITIVE_INFINITY) return escalate(["autonomy_zero"]);
    if (input.autoRepliesLastHour >= input.maxAutoRepliesPerHour) return escalate(["rate_limited"]);
    return { ...base, decision: "ASK", reasons: ["repeat_order_ambiguous"], reply: repeat.question, priority: "low" };
  }
  if (!proposal) return escalate(["model_unavailable"]);
  if (proposal.decision === "ESCALATE") return escalate([proposal.escalation_reason ? "model_escalated" : "model_uncertain"]);
  if (orderComplete) return escalate(["order_approval"]);

  let reply = proposal.reply?.trim() || null;
  let decision = proposal.decision;
  const reasons: string[] = [];

  // An unfinished order always becomes a question for the missing details. A
  // model REPLY there wasn't a question, so the deterministic one replaces it.
  if (orderRequest && missing.length > 0) {
    if (decision === "REPLY" || !reply || checkReplySafety(reply, []).length > 0) reply = askForMissingFields(missing);
    decision = "ASK";
    reasons.push("collecting_order_details");
  }
  if (!reply) return escalate(["empty_reply"]);

  if (decision === "REPLY") {
    const activeIds = new Set(input.activeKnowledge.map((k) => k.id));
    if (proposal.knowledge_ids.length === 0 || proposal.knowledge_ids.some((id) => !activeIds.has(id))) {
      return escalate(["unverified_answer"]);
    }
  }
  const cited = input.activeKnowledge.filter((k) => proposal.knowledge_ids.includes(k.id));
  const unsafe = checkReplySafety(reply, cited);
  if (unsafe.length > 0) return escalate(unsafe);

  if (threshold === Number.POSITIVE_INFINITY) return escalate(["autonomy_zero"]);
  if (proposal.confidence < threshold) return escalate(["low_confidence"]);
  if (input.autoRepliesLastHour >= input.maxAutoRepliesPerHour) return escalate(["rate_limited"]);

  return {
    ...base,
    decision,
    reasons: reasons.length > 0 ? reasons : ["verified_answer"],
    reply,
    priority: "low",
  };
}

// ── Model output parsing ─────────────────────────────────────────────────────

function parseItems(value: unknown): OrderItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      product: cleanText(item?.product, 200) ?? "",
      quantity: cleanText(typeof item?.quantity === "number" ? String(item.quantity) : item?.quantity, 50),
      variant: cleanText(item?.variant, 100),
      size: cleanText(item?.size, 50),
      from_history: cleanText(item?.from_history, 40),
    }))
    .filter((item) => item.product)
    .map(({ variant, size, from_history, ...item }) => ({
      ...item,
      ...(variant ? { variant } : {}),
      ...(size ? { size } : {}),
      ...(from_history ? { from_history } : {}),
    }))
    .slice(0, 20);
}

function parseOrderDraft(order: Record<string, unknown>): OrderRequestDraft {
  const requestedFor = cleanText(order.requested_for, 200);
  return {
    items: parseItems(order.items),
    delivery_address: cleanText(order.delivery_address),
    delivery_preference: cleanText(order.delivery_preference),
    notes: cleanText(order.notes),
    ...(requestedFor ? { requested_for: requestedFor } : {}),
  };
}

/** Strict parse of the model's JSON. Throws on anything malformed — the caller escalates. */
export function parseModelProposal(raw: string): ModelProposal {
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Model output is not an object");
  if (!["REPLY", "ASK", "ESCALATE"].includes(parsed.decision)) {
    throw new Error(`Model returned an invalid decision: ${JSON.stringify(parsed.decision)}`);
  }
  const intent = ["question", "order", "complaint", "smalltalk", "other"].includes(parsed.intent)
    ? parsed.intent
    : "other";
  const order = parsed.order_request && typeof parsed.order_request === "object" ? parsed.order_request : null;
  return {
    decision: parsed.decision,
    intent,
    reply: cleanText(parsed.reply, 2000),
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    knowledge_ids: Array.isArray(parsed.knowledge_ids)
      ? parsed.knowledge_ids.filter((id: unknown): id is string => typeof id === "string").slice(0, 20)
      : [],
    escalation_reason: cleanText(parsed.escalation_reason, 300),
    priority: (ESCALATION_PRIORITIES as readonly string[]).includes(parsed.priority) ? parsed.priority : null,
    summary: cleanText(parsed.summary, 500),
    memory_facts: Array.isArray(parsed.memory_facts) ? parsed.memory_facts.slice(0, 8) : [],
    order_request: order ? parseOrderDraft(order) : null,
    ...(cleanText(parsed.order_target, 40) ? { order_target: cleanText(parsed.order_target, 40) } : {}),
    ...(Array.isArray(parsed.other_orders) && parsed.other_orders.length > 0
      ? {
          other_orders: parsed.other_orders
            .filter((o: unknown): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
            .slice(0, 3)
            .map((o: Record<string, unknown>) => ({
              target: cleanText(o.target, 40) ?? "new",
              order: parseOrderDraft((o.order_request ?? o.order ?? o) as Record<string, unknown>),
            }))
            .filter((o: AdditionalOrderDraft) => o.order.items.length > 0),
        }
      : {}),
  };
}

/** What order monitoring asks the model for: the order picture only, never a reply. */
export interface OrderOnlyProposal {
  intent: ModelProposal["intent"];
  order_request: OrderRequestDraft | null;
  order_target?: string | null;
  other_orders?: AdditionalOrderDraft[];
  /** Only meaningful when the NEW message was written by staff: what it says about an existing order. */
  staff_action: "confirms" | "cancels" | "changes" | null;
}

/** Strict parse of the order-monitoring JSON. Throws on anything malformed — the caller records a failed analysis. */
export function parseOrderOnlyProposal(raw: string): OrderOnlyProposal {
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Model output is not an object");
  const intent = ["question", "order", "complaint", "smalltalk", "other"].includes(parsed.intent) ? parsed.intent : "other";
  const order = parsed.order_request && typeof parsed.order_request === "object" ? parsed.order_request : null;
  const proposal = parseModelProposal(
    JSON.stringify({ decision: "ESCALATE", intent, order_request: order, order_target: parsed.order_target, other_orders: parsed.other_orders })
  );
  return {
    intent,
    order_request: proposal.order_request,
    ...(proposal.order_target ? { order_target: proposal.order_target } : {}),
    ...(proposal.other_orders ? { other_orders: proposal.other_orders } : {}),
    staff_action: ["confirms", "cancels", "changes"].includes(parsed.staff_action) ? parsed.staff_action : null,
  };
}

// ── Staff group reply matching ───────────────────────────────────────────────

export interface MatchableEscalation {
  id: string;
  ref_code: string;
  notice_message_id: string | null;
  status: string;
}

/** Commands that act on an escalation. "send" is explicit authorization to message the customer. */
export type StaffCommand = "send" | "note" | "close" | "takeover" | "resume";
/** What a staff-group message can mean: a command, or a plain answer (information, never authorization). */
export type StaffGroupCommand = StaffCommand | "answer" | PilotCommand | "loose_approval";

export type StaffMatch =
  | {
      kind: "matched";
      escalationId: string;
      refCode: string;
      command: StaffGroupCommand;
      body: string;
      /** How the escalation was identified: a quoted reply to one of our messages, or an explicit #E- code. */
      via: "quote" | "ref";
    }
  | { kind: "closed"; escalationId: string; refCode: string }
  | { kind: "ambiguous"; refCodes: string[] }
  | { kind: "unknown_ref"; refCodes: string[] }
  | { kind: "empty"; escalationId: string; refCode: string }
  | { kind: "unmatched" };

const REF_PATTERN = /#?\bE-([A-Z0-9]{4,8})\b/gi;

/**
 * Text that only ever appears in messages the agent itself posts in the staff
 * group. A message containing any of these (an echo, a forward, a copy-paste)
 * is never an instruction.
 */
export const AGENT_MESSAGE_MARKERS = [
  "AI escalation #",
  "Follow-up on #",
  "Update on #",
  "Commands: !note",
  "Draft reply for #",
  "Sending reply for #",
  "Answer saved for #",
  "Reply not sent for #",
] as const;

/** Approval Pilot's own staff-group posts (a draft version, the AI suggestion block). */
const PILOT_ECHO = /Draft v\d+ for #E-|AI suggestion v\d+ —|Nothing is sent until an authorized person sends|AI suggests(?: \(replaces the earlier one\))?:|!edit <text> · !reject · !moreinfo|^ℹ️ #E-[A-Z0-9]{4,8} ·/m;

/** True for text the agent itself posts in the staff group (an echo, a forward, a copy-paste). */
export function looksLikeAgentMessage(text: string): boolean {
  return AGENT_MESSAGE_MARKERS.some((m) => text.includes(m)) || PILOT_ECHO.test(text);
}

export function extractRefCodes(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(REF_PATTERN), (m) => `E-${m[1].toUpperCase()}`)));
}

// A message that is nothing but an approval ("send it", "go ahead") authorizes
// the draft it replies to. Anything longer is an answer, not an approval.
const AUTHORIZE_ONLY =
  /^(?:yes[ ,]+|ok(?:ay)?[ ,]+|please[ ,]+)?(?:send(?: (?:it|this|that|the (?:draft|reply)|draft|reply))?(?: please)?|go ahead(?: and send(?: it)?)?)[.! ]*$/i;

/**
 * Matches a staff-group message to exactly one escalation, by a quoted reply to
 * a message the agent posted for it (its notice or a draft) or by an explicit
 * "#E-XXXXX" reference. Anything else — no reference, several references, a
 * quote and a reference that disagree, an unknown code — is never guessed, and
 * recency or the customer's name are never consulted.
 *
 * A plain message is an ANSWER: information for the agent, never permission to
 * message the customer. Only "!send" (or a message that is just "send it")
 * authorizes a customer message.
 */
export function matchStaffReply(
  message: { text: string; quotedMessageId: string | null },
  escalations: MatchableEscalation[],
  options: { explicitCommandsOnly?: boolean } = {}
): StaffMatch {
  // Anything shaped like our own messages (an echo, a forward, a copy-paste) is
  // never an answer — relaying it would send internal staff text to a customer.
  if (AGENT_MESSAGE_MARKERS.some((m) => message.text.includes(m)) || PILOT_ECHO.test(message.text)) return { kind: "unmatched" };
  const refs = extractRefCodes(message.text);
  const byQuote = message.quotedMessageId
    ? escalations.filter((e) => e.notice_message_id && e.notice_message_id === message.quotedMessageId)
    : [];

  if (byQuote.length > 1) return { kind: "ambiguous", refCodes: byQuote.map((e) => e.ref_code) };
  if (refs.length > 1) return { kind: "ambiguous", refCodes: refs };

  let target: MatchableEscalation | undefined;
  let via: "quote" | "ref";
  if (byQuote.length === 1) {
    target = byQuote[0];
    via = "quote";
    if (refs.length === 1 && refs[0] !== target.ref_code) {
      return { kind: "ambiguous", refCodes: [target.ref_code, refs[0]] };
    }
  } else if (refs.length === 1) {
    target = escalations.find((e) => e.ref_code === refs[0]);
    via = "ref";
    if (!target) return { kind: "unknown_ref", refCodes: refs };
  } else {
    return { kind: "unmatched" };
  }

  const stripped = message.text.replace(REF_PATTERN, " ").replace(/\s+/g, " ").trim().replace(/^!more[\s-]+info\b/i, "!moreinfo");
  const cmd = stripped.match(/^!(send|note|close|takeover|resume|approve|edit|reject|moreinfo|status|teach|confirm|discard)\b\s*/i);
  // A closed request can still be read (!moreinfo is read-only); every other command is refused.
  if ((target.status === "resolved" || target.status === "cancelled") && cmd?.[1].toLowerCase() !== "moreinfo") {
    return { kind: "closed", escalationId: target.id, refCode: target.ref_code };
  }
  let command: StaffGroupCommand;
  let body: string;
  if (cmd) {
    command = cmd[1].toLowerCase() as StaffGroupCommand;
    body = stripped.slice(cmd[0].length).trim();
  } else if (AUTHORIZE_ONLY.test(stripped)) {
    // Approval Pilot: a casual "send it" is never a send. Only an explicit !command is.
    command = options.explicitCommandsOnly ? "loose_approval" : "send";
    body = "";
  } else {
    command = "answer";
    body = stripped;
  }
  // "!send" alone is valid (it approves the draft); an answer or note needs text.
  if ((command === "answer" || command === "note" || command === "edit" || command === "teach") && !body) {
    return { kind: "empty", escalationId: target.id, refCode: target.ref_code };
  }
  return { kind: "matched", escalationId: target.id, refCode: target.ref_code, command, body, via };
}

// ── Text builders ────────────────────────────────────────────────────────────

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "E-" + 5 chars from an unambiguous alphabet. Caller supplies randomness (crypto) and retries on collision. */
export function generateRefCode(random: Uint8Array): string {
  let code = "";
  for (let i = 0; i < 5; i += 1) code += REF_ALPHABET[(random[i] ?? 0) % REF_ALPHABET.length];
  return `E-${code}`;
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function formatOrderRequest(request: OrderRequestDraft | null): string | null {
  if (!request || request.items.length === 0) return null;
  const items = request.items.map((i) => (i.quantity ? `${i.quantity} × ${i.product}` : `${i.product} — quantity needed`)).join(", ");
  return [
    items,
    `Address: ${request.delivery_address ?? "—"}`,
    `Delivery: ${request.delivery_preference ?? "—"}`,
  ].join(" | ");
}

// ── Customer message history ─────────────────────────────────────────────────

/** Joins the customer messages of one escalation inside ai_agent_escalations.customer_message. */
export const CUSTOMER_MESSAGE_SEPARATOR = "\n---\n";
const MEDIA_PLACEHOLDER = "(media message without text)";
const MAX_CUSTOMER_MESSAGE_CHARS = 4000;

function normalizeMessage(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Appends a follow-up message to the stored history, skipping one the customer already sent. */
export function appendCustomerMessage(existing: string | null, next: string): string {
  // `next` may itself be a whole batched turn (messages joined with the separator):
  // append each message in order, skipping any the customer already sent.
  let history = existing;
  for (const part of next.split(CUSTOMER_MESSAGE_SEPARATOR)) history = appendOneMessage(history, part);
  return history ?? "";
}

function appendOneMessage(existing: string | null, next: string): string {
  if (!existing) return next.slice(0, MAX_CUSTOMER_MESSAGE_CHARS);
  const seen = existing.split(CUSTOMER_MESSAGE_SEPARATOR).map(normalizeMessage);
  if (seen.includes(normalizeMessage(next))) return existing;
  return `${existing}${CUSTOMER_MESSAGE_SEPARATOR}${next}`.slice(-MAX_CUSTOMER_MESSAGE_CHARS);
}

const GREETING_ONLY =
  /^(hi+|hello+|hey+|hola|bonjour|ok(ay)?|thanks?|thank you|thx|good (morning|afternoon|evening)|please|\?+)\W*$/i;

/** The distinct, meaningful customer messages in a stored history, oldest first. */
export function customerMessageSegments(history: string): string[] {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of history.split(CUSTOMER_MESSAGE_SEPARATOR)) {
    const text = raw.replace(/\s+/g, " ").trim();
    const key = normalizeMessage(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    all.push(text);
  }
  const meaningful = all.filter((t) => !GREETING_ONLY.test(t));
  return meaningful.length > 0 ? meaningful : all;
}

// ── Request category ─────────────────────────────────────────────────────────

export type RequestCategory =
  | "new_order"
  | "product_enquiry"
  | "complaint"
  | "payment_issue"
  | "unanswered_question"
  | "other";

const CATEGORY_LABEL: Record<RequestCategory, string> = {
  new_order: "🛒 New order",
  product_enquiry: "📦 Product enquiry",
  complaint: "⚠️ Complaint",
  payment_issue: "💳 Payment issue",
  unanswered_question: "❓ Unanswered question",
  other: "📌 Other request",
};

const COMPLAINT_CODES = ["complaint", "health_concern", "legal_threat", "refund"];
const PRODUCT_WORDS = /\b(price|prices|cost|how much|in stock|stock|available|availability|do you (have|sell|stock)|kg|size|sizes|ingredients?|brand|product|products)\b/i;

/** Derives the request category from data we already have — no extra model call. */
export function categorizeRequest(input: {
  reasons: string[];
  intent?: ModelProposal["intent"] | null;
  orderRequest: OrderRequestDraft | null;
  messages: string[];
}): RequestCategory {
  const { reasons, intent } = input;
  if (intent === "complaint" || reasons.some((r) => COMPLAINT_CODES.includes(r))) return "complaint";
  if (reasons.includes("payment_claim")) return "payment_issue";
  if (
    intent === "order" ||
    (input.orderRequest?.items.length ?? 0) > 0 ||
    reasons.includes("order_approval") ||
    reasons.includes("collecting_order_details")
  ) {
    return "new_order";
  }
  if (PRODUCT_WORDS.test(input.messages.join(" "))) return "product_enquiry";
  if (intent === "question" || reasons.some((r) => ["unverified_answer", "low_confidence", "model_uncertain"].includes(r))) {
    return "unanswered_question";
  }
  return "other";
}

const MISSING_ORDER_LABEL: Record<OrderField, string> = {
  items: "Which product(s) the customer wants",
  quantity: "Quantity for each product",
  delivery_address: "Delivery address",
  delivery_preference: "Delivery day/time",
};

function requestLines(input: { orderRequest: OrderRequestDraft | null; category: RequestCategory }): {
  details: string[];
  actions: string[];
} {
  const order = input.orderRequest;
  const details: string[] = [];
  if (order) {
    for (const item of order.items) {
      details.push(`${clip(item.product, 100)} — ${item.quantity ? `qty ${clip(item.quantity, 30)}` : "qty not given"}`);
    }
    if (order.delivery_address) details.push(`Address: ${clip(order.delivery_address, 150)}`);
    if (order.delivery_preference) details.push(`Delivery: ${clip(order.delivery_preference, 100)}`);
    if (order.notes) details.push(`Note: ${clip(order.notes, 150)}`);
  }

  const actions: string[] = [];
  if (input.category === "new_order") {
    if (!order || (order.items.length === 0 && !order.delivery_address && !order.delivery_preference)) {
      actions.push("Order details were not captured — confirm products, quantities, delivery address and day/time");
    } else {
      const missing = missingOrderFields(order);
      if (missing.length === 0) actions.push("Check availability and price, then confirm the order with the customer");
      else for (const f of missing) actions.push(`Missing: ${MISSING_ORDER_LABEL[f]}`);
    }
  } else if (input.category === "complaint") {
    actions.push("Review the complaint and respond to the customer personally");
  } else if (input.category === "payment_issue") {
    actions.push("Check the payment on your side before replying");
  } else if (input.category === "product_enquiry" || input.category === "unanswered_question") {
    actions.push("Answer the customer's question(s) above");
  } else {
    actions.push("Review and respond to the customer");
  }
  return { details, actions };
}

const MAX_REQUEST_BULLETS = 4;

export interface StaffNoticeInput {
  refCode: string;
  priority: EscalationPriority;
  customerLabel: string;
  /** Diagnostic codes. Used only to pick the category — never printed (they live in the admin dashboard). */
  reasons: string[];
  /** Every customer message of the escalation, joined with CUSTOMER_MESSAGE_SEPARATOR. */
  customerMessage: string;
  /** The model's one-sentence summary of the FIRST customer message, when it produced one. */
  summary?: string | null;
  intent?: ModelProposal["intent"] | null;
  /** The model's draft for the first message; shown only while it is still current. */
  draftReply: string | null;
  orderRequest: OrderRequestDraft | null;
  followUp: boolean;
  /** Observe mode: nothing is sent to the customer; staff answers are recorded for review only. */
  observeOnly?: boolean;
  /** Verified-history lines (historyLinesForStaff); shown apart from the current, unconfirmed request. */
  history?: string[];
}

export function buildStaffNotice(input: StaffNoticeInput): string {
  const messages = customerMessageSegments(input.customerMessage).map((m) =>
    m === MEDIA_PLACEHOLDER ? "📎 Sent media without text" : m
  );
  const category = categorizeRequest({
    reasons: input.reasons,
    intent: input.intent,
    orderRequest: input.orderRequest,
    messages,
  });
  const header = input.followUp
    ? `🔁 Follow-up on #${input.refCode} · ${input.priority.toUpperCase()}`
    : `🔔 AI escalation #${input.refCode} · ${input.priority.toUpperCase()}`;

  // The summary only describes the first message; later messages follow as their own lines.
  const summary = input.summary ? clip(input.summary, 200) : null;
  const points = messages.length > 0 ? messages.map((m) => clip(m, 160)) : ["(no text)"];
  if (summary) points[0] = summary;
  let shown = points;
  let omitted = 0;
  if (points.length > MAX_REQUEST_BULLETS) {
    shown = [points[0], ...points.slice(-(MAX_REQUEST_BULLETS - 1))];
    omitted = points.length - MAX_REQUEST_BULLETS;
  }

  const { details, actions } = requestLines({ orderRequest: input.orderRequest, category });
  const lines = [header, CATEGORY_LABEL[category], `👤 ${clip(input.customerLabel, 80)}`, "", "*Request*"];
  lines.push(...shown.map((p) => `• ${p}`));
  if (omitted > 0) lines.push(`• (+${omitted} more message${omitted === 1 ? "" : "s"} in the dashboard)`);
  if (details.length > 0) {
    lines.push("", "*Order details* (NOT confirmed)", ...details.map((d) => `• ${d}`));
  }
  if (input.history && input.history.length > 0) {
    lines.push("", "*Customer history* (from records)", ...input.history.map((h) => `• ${h}`));
  }
  lines.push("", "*Action needed*", ...actions.map((a) => `• ${a}`));

  // A draft answers the first message only: once the customer has written
  // again it is stale, so it is dropped rather than presented as current.
  if (input.draftReply && !input.followUp && messages.length <= 1) {
    lines.push("", `${input.observeOnly ? "AI draft (NOT sent)" : "Suggested reply"}: "${clip(input.draftReply, 400)}"`);
  }
  lines.push(
    "",
    input.observeOnly
      ? `👀 Observe mode: nothing is sent to the customer. Reply to this message (or include #${input.refCode}) with your answer — I'll record it and post a draft reply you can copy.`
      : `↩️ Reply to this message (or include #${input.refCode}) with your answer. I'll draft the customer reply here — it is sent only when you reply "send".`,
    "Commands: !note <text> · !send <text> · !close · !takeover · !resume"
  );
  return lines.join("\n");
}
