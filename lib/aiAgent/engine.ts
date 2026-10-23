// The AI agent's decision rules — pure functions, no I/O, no imports, so the
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

// ── Constants ────────────────────────────────────────────────────────────────

// Pilot allow-list. Mirrors the ai_agent_settings_pilot_only check constraint
// in supabase/migrations/20261022000000_ai_agent.sql — both must change to
// extend the pilot.
export const AI_AGENT_PILOT_BUSINESSES = ["dog_food"] as const;

export const AGENT_DECISIONS = ["REPLY", "ASK", "ESCALATE", "NO_REPLY", "HUMAN"] as const;
export type AgentDecision = (typeof AGENT_DECISIONS)[number];

export const AGENT_MODES = ["observe", "assisted"] as const;
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
}

export type ContactRule = "allow" | "exclude";

export interface ConversationControl {
  control: "ai" | "human";
  human_until: string | null;
}

export interface OrderItem {
  product: string;
  quantity: string | null;
}

export interface OrderRequestDraft {
  items: OrderItem[];
  delivery_address: string | null;
  delivery_preference: string | null;
  notes: string | null;
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
}

export interface KnowledgeFact {
  id: string;
  content: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function isPilotBusiness(businessSlug: string): boolean {
  return (AI_AGENT_PILOT_BUSINESSES as readonly string[]).includes(businessSlug);
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

function chatKind(chatId: string): "group" | "system" | "direct" {
  const id = chatId.trim().toLowerCase();
  if (id.endsWith("@g.us")) return "group";
  if (id === "broadcast" || id.endsWith("@broadcast") || id.endsWith("@newsletter")) return "system";
  return "direct";
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
  conversation: ConversationControl | null;
  /** Newest manual (non-agent) staff message in this chat, if any. */
  staffActiveAt: string | null;
  now: Date;
}

export type GateResult =
  | { pass: true }
  | { pass: false; decision: "NO_REPLY" | "HUMAN" | "ESCALATE"; reasons: string[] };

export function evaluateGate(input: GateInput): GateResult {
  const { settings } = input;
  if (!isPilotBusiness(input.businessSlug)) return stop("NO_REPLY", "business_not_in_pilot");
  if (!settings || !settings.enabled) return stop("NO_REPLY", "agent_disabled");

  const kind = chatKind(input.chatId);
  if (kind === "system") return stop("NO_REPLY", "system_chat");
  if (kind === "group") return stop("NO_REPLY", "group_chat");
  if (input.fromMe) return stop("NO_REPLY", "outbound_message");

  if (input.contactRule === "exclude") return stop("NO_REPLY", "contact_excluded");
  if (settings.contact_scope === "none") return stop("NO_REPLY", "contact_not_permitted");
  if (settings.contact_scope === "selected" && input.contactRule !== "allow") {
    return stop("NO_REPLY", "contact_not_permitted");
  }

  if (isHumanControlActive(input.conversation, input.now)) return stop("HUMAN", "human_takeover");
  if (input.staffActiveAt && settings.auto_takeover_minutes > 0) {
    const age = input.now.getTime() - new Date(input.staffActiveAt).getTime();
    if (age >= 0 && age < settings.auto_takeover_minutes * 60_000) return stop("HUMAN", "staff_recently_active");
  }

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

export function missingOrderFields(request: OrderRequestDraft | null): OrderField[] {
  if (!request) return ["items", "quantity", "delivery_address", "delivery_preference"];
  const missing: OrderField[] = [];
  if (request.items.length === 0) missing.push("items");
  else if (request.items.some((i) => !i.quantity)) missing.push("quantity");
  if (!request.delivery_address) missing.push("delivery_address");
  if (!request.delivery_preference) missing.push("delivery_preference");
  return missing;
}

const FIELD_QUESTIONS: Record<OrderField, string> = {
  items: "which product(s) you'd like",
  quantity: "how many of each",
  delivery_address: "your delivery address",
  delivery_preference: "your preferred delivery day and time",
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
  const orderRequest =
    proposal?.intent === "order" || input.priorOrderRequest
      ? mergeOrderRequest(input.priorOrderRequest, proposal?.order_request ?? null)
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
    }))
    .filter((item) => item.product)
    .slice(0, 20);
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
    order_request: order
      ? {
          items: parseItems(order.items),
          delivery_address: cleanText(order.delivery_address),
          delivery_preference: cleanText(order.delivery_preference),
          notes: cleanText(order.notes),
        }
      : null,
  };
}

// ── Staff group reply matching ───────────────────────────────────────────────

export interface MatchableEscalation {
  id: string;
  ref_code: string;
  notice_message_id: string | null;
  status: string;
}

export type StaffCommand = "send" | "note" | "close" | "takeover" | "resume";

export type StaffMatch =
  | { kind: "matched"; escalationId: string; refCode: string; command: StaffCommand; body: string }
  | { kind: "closed"; escalationId: string; refCode: string }
  | { kind: "ambiguous"; refCodes: string[] }
  | { kind: "unknown_ref"; refCodes: string[] }
  | { kind: "empty"; escalationId: string; refCode: string }
  | { kind: "unmatched" };

const REF_PATTERN = /#?\bE-([A-Z0-9]{4,8})\b/gi;

const NOTICE_MARKERS = ["AI escalation #", "Follow-up on #", "Commands: !note"];

export function extractRefCodes(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(REF_PATTERN), (m) => `E-${m[1].toUpperCase()}`)));
}

/**
 * Matches a staff-group message to exactly one escalation, by a quoted reply to
 * the escalation notice or by an explicit "#E-XXXXX" reference. Anything else —
 * no reference, several references, a quote and a reference that disagree, an
 * unknown code — is never guessed.
 */
export function matchStaffReply(
  message: { text: string; quotedMessageId: string | null },
  escalations: MatchableEscalation[]
): StaffMatch {
  // Anything shaped like our own notice (an echo, a forward, a copy-paste) is
  // never an answer — relaying it would send internal staff text to a customer.
  if (NOTICE_MARKERS.some((m) => message.text.includes(m))) return { kind: "unmatched" };
  const refs = extractRefCodes(message.text);
  const byQuote = message.quotedMessageId
    ? escalations.filter((e) => e.notice_message_id && e.notice_message_id === message.quotedMessageId)
    : [];

  if (byQuote.length > 1) return { kind: "ambiguous", refCodes: byQuote.map((e) => e.ref_code) };
  if (refs.length > 1) return { kind: "ambiguous", refCodes: refs };

  let target: MatchableEscalation | undefined;
  if (byQuote.length === 1) {
    target = byQuote[0];
    if (refs.length === 1 && refs[0] !== target.ref_code) {
      return { kind: "ambiguous", refCodes: [target.ref_code, refs[0]] };
    }
  } else if (refs.length === 1) {
    target = escalations.find((e) => e.ref_code === refs[0]);
    if (!target) return { kind: "unknown_ref", refCodes: refs };
  } else {
    return { kind: "unmatched" };
  }

  if (target.status === "resolved" || target.status === "cancelled") {
    return { kind: "closed", escalationId: target.id, refCode: target.ref_code };
  }

  const stripped = message.text.replace(REF_PATTERN, " ").replace(/\s+/g, " ").trim();
  const cmd = stripped.match(/^!(note|close|takeover|resume)\b\s*/i);
  const command: StaffCommand = cmd ? (cmd[1].toLowerCase() as StaffCommand) : "send";
  const body = cmd ? stripped.slice(cmd[0].length).trim() : stripped;
  if ((command === "send" || command === "note") && !body) {
    return { kind: "empty", escalationId: target.id, refCode: target.ref_code };
  }
  return { kind: "matched", escalationId: target.id, refCode: target.ref_code, command, body };
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
  const items = request.items.map((i) => `${i.quantity ?? "?"} × ${i.product}`).join(", ");
  return [
    items,
    `Address: ${request.delivery_address ?? "—"}`,
    `Delivery: ${request.delivery_preference ?? "—"}`,
  ].join(" | ");
}

export interface StaffNoticeInput {
  refCode: string;
  priority: EscalationPriority;
  customerLabel: string;
  reasons: string[];
  customerMessage: string;
  draftReply: string | null;
  orderRequest: OrderRequestDraft | null;
  followUp: boolean;
}

export function buildStaffNotice(input: StaffNoticeInput): string {
  const header = input.followUp
    ? `🔁 Follow-up on #${input.refCode}`
    : `🔔 AI escalation #${input.refCode} (${input.priority.toUpperCase()})`;
  const lines = [
    header,
    `Customer: ${clip(input.customerLabel, 80)}`,
    `Reason: ${input.reasons.join(", ")}`,
    `Message: "${clip(input.customerMessage, 500)}"`,
  ];
  const order = formatOrderRequest(input.orderRequest);
  if (order) lines.push(`Order request (NOT confirmed): ${clip(order, 400)}`);
  if (input.draftReply && !input.followUp) lines.push(`Suggested reply: "${clip(input.draftReply, 400)}"`);
  lines.push(
    `↩️ Reply to this message (or include #${input.refCode}) with the exact text to send the customer.`,
    "Commands: !note <text> · !close · !takeover · !resume"
  );
  return lines.join("\n");
}
