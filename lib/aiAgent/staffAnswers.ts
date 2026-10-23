// What happens to a staff answer in the staff group — pure functions, no I/O,
// relative imports only (so they run under `npm test`). The server side
// (lib/server/aiAgent/staffGroup.ts) loads data, calls the model once, and
// defers every decision to this file:
//
//   * classification of what staff told us (durable / temporary /
//     customer-specific / one-off) and where each kind may be stored,
//   * conflicts between a proposed permanent fact and approved knowledge,
//   * whether a drafted customer reply may be SENT or must be withheld, and why,
//   * the wording of the staff-group messages (no technical reason codes).
//
// A staff answer is INFORMATION. It never messages a customer by itself:
// sending needs explicit authorization ("!send") AND every existing customer
// send policy to pass (Assisted mode, contact permissions, takeover, safety).

import {
  type AgentSettings,
  checkReplySafety,
  detectPromptInjection,
  type GateResult,
  hasCommitmentLanguage,
  KNOWLEDGE_KINDS,
  type KnowledgeKind,
  MAX_REPLY_CHARS,
  priorNoticeHold,
} from "./engine.ts";
import { fingerprintOf, normalizeText } from "./memory.ts";
import { BLOCK_REASONS } from "./outboxStatus.ts";

// ── Model output ─────────────────────────────────────────────────────────────

export const STAFF_FACT_CATEGORIES = ["durable", "temporary", "customer_specific", "one_off"] as const;
export type StaffFactCategory = (typeof STAFF_FACT_CATEGORIES)[number];

export interface StaffAnalysis {
  /** Concise customer-facing reply built from the staff answer; null when there is nothing to tell the customer. */
  customerReply: string | null;
  /** Raw, UNVALIDATED items; validateStaffItems() decides what is kept and what it may become. */
  items: unknown[];
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;
}

/** Strict parse of the model's JSON; throws on anything malformed (the caller records "draft unavailable"). */
export function parseStaffAnalysis(raw: string): StaffAnalysis {
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Model output is not an object");
  const reply = typeof parsed.customer_reply === "string" ? parsed.customer_reply.trim().slice(0, MAX_REPLY_CHARS * 2) : "";
  return {
    customerReply: reply || null,
    items: Array.isArray(parsed.items) ? parsed.items.slice(0, 8) : [],
  };
}

// ── Classification ───────────────────────────────────────────────────────────
//
// The model proposes a category per item. Deterministic cues in the staff's own
// words can only move an item to a MORE RESTRICTED category, never to a more
// permanent one: a model that calls "20% off for Jane today" durable still gets
// a one-off. Ranking, least to most restricted:
//   durable < customer_specific < temporary < one_off
// (temporary + customer cues together stay temporary AND conversation-scoped:
// a stock level is never written into permanent customer memory.)

const ONE_OFF_CUE =
  /\b(discount\w*|special (price|rate|deal|offer)|negotiat\w*|just this once|this once|one[- ]?off|one[- ]time|only for (him|her|them|this)|for (him|her|them) only|as a favou?r|on the house|free of charge|for free|waive\w*|refund\w*|money back|compensat\w*|half[- ]price|\d+ ?% ?off|knock(?:ed)? off|cheaper for|exception|promis\w*|honou?r)\b/i;

const CUSTOMER_CUE =
  /\b(for|to|with|tell|give) (him|her|them)\b|\b(her|his|their) (order|address|usual|gate|house|home|dog|dogs|puppy|account|number|preference|delivery)\b|\b(she|he) (always|prefers|wants|likes|bought|ordered|paid|picks|collects|needs|lives)\b|\bthis customer\b|\bcustomer'?s\b/i;

const TEMPORAL_CUE =
  /\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|weekend|month)|right now|at the moment|currently|for now|until (?:mon|tue|wed|thu|fri|sat|sun|next|further notice|tomorrow|the (?:end|weekend|restock))\w*|sold out|ran out|run(?:ning)? out|out of|no stock|only \d+ (left|remaining)|\d+ left|back in stock|restock\w*|shortage|temporar\w*|next (delivery|shipment|week)|closed (early|today)|closing early|power cut|public holiday|short[- ]staffed|fully booked|(?:in|out of) stock|stock (?:level|count|check)s?|none left|no more|unavailable|not available|low on|running low|few left|limited (?:stock|supply)|waiting (?:for|on) (?:stock|delivery|the shipment|shipment|supplier)|(?:arrives?|arriving|coming in) (?:on|next|tomorrow|today|this)|sold)\b/i;

const RANK: Record<StaffFactCategory, number> = { durable: 0, customer_specific: 1, temporary: 2, one_off: 3 };

export type Scope = "conversation" | "business";

export interface ClassifiedItem {
  category: StaffFactCategory;
  /** Knowledge kind for a durable item, null otherwise. */
  kind: KnowledgeKind | null;
  title: string;
  content: string;
  /** The staff's own words this item rests on (verbatim part of the answer). */
  evidence: string;
  /** Temporary items only: when the fact stops being usable. */
  validUntil: string | null;
  /** Temporary items only: the conversation it may be used in, or any conversation of the business until validUntil. */
  scope: Scope | null;
  /** The category the model proposed, when the cues moved the item somewhere more restricted. */
  moved_from?: StaffFactCategory;
}

export type ItemRejection =
  | "bad_category"
  | "bad_kind"
  | "empty"
  | "too_long"
  | "no_evidence"
  | "evidence_not_verbatim"
  | "unsupported_number"
  | "unsafe_content";

export const DEFAULT_TEMP_HOURS = 12;
export const MAX_TEMP_HOURS = 168;
const MAX_ITEMS = 6;
const MAX_DURABLE_CHARS = 600;
const MAX_CUSTOMER_FACT_CHARS = 280;

function numberSet(value: string): Set<string> {
  const out = new Set<string>();
  for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(String(Number(m[0].replace(/,/g, ""))));
  return out;
}

/** The least permanent category the staff's words allow. */
export function cueCategory(words: string, customerName: string | null): StaffFactCategory | null {
  if (ONE_OFF_CUE.test(words)) return "one_off";
  const named = customerName && customerName.trim().length >= 3 && normalizeText(words).split(" ").includes(normalizeText(customerName).split(" ")[0]);
  const customer = CUSTOMER_CUE.test(words) || Boolean(named);
  if (TEMPORAL_CUE.test(words)) return "temporary";
  if (customer) return "customer_specific";
  return null;
}

/**
 * Filters and re-classifies the items the model proposed. Nothing the model
 * says is trusted on its own: every item must quote the staff's actual words,
 * may not introduce a number the staff did not say, and can only be MORE
 * restricted than the cues in those words allow.
 */
export function validateStaffItems(
  raw: unknown,
  staffText: string,
  now: Date,
  customerName: string | null = null
): { accepted: ClassifiedItem[]; rejected: { content: string; reason: ItemRejection }[] } {
  const accepted: ClassifiedItem[] = [];
  const rejected: { content: string; reason: ItemRejection }[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };
  const haystack = normalizeText(staffText);
  const staffNumbers = numberSet(staffText);

  for (const entry of raw.slice(0, MAX_ITEMS + 2)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const content = text(item.content, 700);
    const evidence = text(item.evidence, 700);
    const reject = (reason: ItemRejection) => rejected.push({ content: content ?? "", reason });

    const proposed = item.category as StaffFactCategory;
    if (!(STAFF_FACT_CATEGORIES as readonly unknown[]).includes(proposed)) reject("bad_category");
    else if (!content) reject("empty");
    else if (!evidence) reject("no_evidence");
    else if (normalizeText(evidence).length < 4 || !haystack.includes(normalizeText(evidence))) reject("evidence_not_verbatim");
    else if (detectPromptInjection(content) || checkReplySafety(content, []).includes("credential_leak")) reject("unsafe_content");
    else if ([...numberSet(content)].some((n) => !staffNumbers.has(n))) reject("unsupported_number");
    else if (accepted.length < MAX_ITEMS) {
      // Cues are read from the item's own evidence AND its content, so a model
      // that quotes only the harmless half of a sentence is still caught.
      const cue = cueCategory(`${evidence} ${content}`, customerName);
      const customerCue = CUSTOMER_CUE.test(`${evidence} ${content}`);
      let category = proposed;
      if (cue && RANK[cue] > RANK[category]) category = cue;
      // A model "temporary" or "customer_specific" is also bounded by the cues of the other kind.
      if (category === "customer_specific" && TEMPORAL_CUE.test(`${evidence} ${content}`)) category = "temporary";

      const base = {
        content,
        evidence,
        moved_from: category !== proposed ? proposed : undefined,
      };
      if (category === "durable") {
        const kind = (KNOWLEDGE_KINDS as readonly unknown[]).includes(item.kind) && item.kind !== "tone" ? (item.kind as KnowledgeKind) : "faq";
        if (content.length > MAX_DURABLE_CHARS) reject("too_long");
        else {
          accepted.push({
            ...base,
            category,
            kind,
            title: text(item.title, 120) ?? content.slice(0, 60),
            validUntil: null,
            scope: null,
          });
        }
      } else if (category === "temporary") {
        const requested = typeof item.valid_hours === "number" && Number.isFinite(item.valid_hours) ? item.valid_hours : DEFAULT_TEMP_HOURS;
        const hours = Math.max(1, Math.min(MAX_TEMP_HOURS, requested));
        // Business-wide only when the model says so AND nothing ties the fact to one customer.
        const scope: Scope = item.scope === "business" && !customerCue && proposed === "temporary" ? "business" : "conversation";
        accepted.push({
          ...base,
          category,
          kind: null,
          title: text(item.title, 120) ?? content.slice(0, 60),
          validUntil: new Date(now.getTime() + hours * 3_600_000).toISOString(),
          scope,
        });
      } else if (category === "customer_specific" && content.length > MAX_CUSTOMER_FACT_CHARS) {
        reject("too_long");
      } else {
        accepted.push({
          ...base,
          category,
          kind: null,
          title: text(item.title, 120) ?? content.slice(0, 60),
          validUntil: null,
          scope: null,
        });
      }
    }
  }
  return { accepted, rejected };
}

/**
 * What may be written about a customer. Prices, links, long numbers (phone or
 * card numbers) and anything that looks like an instruction are never stored in
 * customer memory; the item stays on the audit record only.
 */
export function customerFactStorable(content: string): { ok: true } | { ok: false; reason: "contains_amount" | "contains_link" | "contains_long_number" | "unsafe_content" } {
  if (/(?:EC\$|US\$|XCD|\$)\s?\d|\d\s?(?:EC|XCD|USD|dollars?)\b/i.test(content)) return { ok: false, reason: "contains_amount" };
  if (/\bhttps?:\/\/|\bwww\./i.test(content)) return { ok: false, reason: "contains_link" };
  if (/\d{9,}/.test(content.replace(/[\s-]/g, ""))) return { ok: false, reason: "contains_long_number" };
  if (detectPromptInjection(content) || checkReplySafety(content, []).includes("credential_leak")) return { ok: false, reason: "unsafe_content" };
  return { ok: true };
}

// ── Conflicts with approved knowledge ────────────────────────────────────────

export interface KnowledgeEntryLite {
  id: string;
  kind: string;
  title: string;
  content: string;
}

export interface KnowledgeConflict {
  id: string;
  title: string;
  content: string;
  /** "conflict": the values differ. "related": covers the same topic, so it must not be added silently. */
  severity: "conflict" | "related";
  reason: string;
}

const STOP = new Set(["the", "and", "with", "that", "this", "from", "have", "your", "our", "for", "are", "you", "can", "will", "all", "any", "per", "each", "also", "only", "just", "get", "its"]);

function topicTokens(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((t) => t.length >= 3 && !/^\d/.test(t) && !STOP.has(t))
      .map((t) => t.replace(/s$/, ""))
  );
}

function moneySet(value: string): Set<string> {
  const out = new Set<string>();
  for (const m of value.matchAll(/(?:EC\$|US\$|XCD\s?|\$)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:EC|XCD|USD|dollars?)\b/gi)) {
    out.add(String(Number((m[1] ?? m[2]).replace(/,/g, ""))));
  }
  return out;
}

function detailSet(value: string): Set<string> {
  const out = new Set<string>();
  for (const m of value.matchAll(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi)) out.add(m[0].toLowerCase().replace(/\s/g, ""));
  for (const m of value.matchAll(/\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\b/gi)) out.add(m[1].toLowerCase().slice(0, 3));
  return out;
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && subset(a, b);

/**
 * Compares a proposed permanent fact with the approved knowledge of the SAME
 * business. A duplicate is dropped; anything else on the same topic is returned
 * so an admin must decide — a candidate never silently overwrites or sits next
 * to a contradicting fact.
 */
export function assessKnowledgeCandidate(
  candidate: { kind: string; title: string; content: string },
  approved: KnowledgeEntryLite[]
): { duplicateOf: KnowledgeEntryLite | null; conflicts: KnowledgeConflict[] } {
  const candText = `${candidate.title} ${candidate.content}`;
  const candTopic = topicTokens(candText);
  const candMoney = moneySet(candidate.content);
  const candDetails = detailSet(candidate.content);
  const conflicts: KnowledgeConflict[] = [];

  for (const entry of approved) {
    const exText = `${entry.title} ${entry.content}`;
    const exTopic = topicTokens(exText);
    const shared = [...candTopic].filter((t) => exTopic.has(t)).length;
    const union = new Set([...candTopic, ...exTopic]).size || 1;
    const sameKind = entry.kind === candidate.kind;
    const related = shared >= 2 && shared / union >= 0.25 ? true : sameKind && shared >= 1 && shared / union >= 0.5;
    if (!related) continue;

    const exMoney = moneySet(entry.content);
    const exDetails = detailSet(entry.content);
    const sameValues = sameSet(candMoney, exMoney) && sameSet(candDetails, exDetails);
    if (sameValues && (normalizeText(entry.content) === normalizeText(candidate.content) || shared / union >= 0.7)) {
      return { duplicateOf: entry, conflicts: [] };
    }

    let severity: KnowledgeConflict["severity"] = "related";
    let reason = "Covers the same topic as an approved entry";
    if (candMoney.size > 0 && exMoney.size > 0 && !subset(candMoney, exMoney)) {
      severity = "conflict";
      reason = `Price differs: approved entry says ${[...exMoney].map((m) => `EC$${m}`).join(", ")}, staff said ${[...candMoney].map((m) => `EC$${m}`).join(", ")}`;
    } else if (candDetails.size > 0 && exDetails.size > 0 && !sameSet(candDetails, exDetails)) {
      severity = "conflict";
      reason = "Days or times differ from an approved entry";
    }
    conflicts.push({ id: entry.id, title: entry.title, content: entry.content.slice(0, 300), severity, reason });
  }
  conflicts.sort((a, b) => Number(b.severity === "conflict") - Number(a.severity === "conflict"));
  return { duplicateOf: null, conflicts: conflicts.slice(0, 5) };
}

export function candidateFingerprint(content: string): string {
  return fingerprintOf(content);
}

// ── The drafted customer reply: safety ───────────────────────────────────────

const STAFF_AFFIRMS =
  /\b(yes|yeah|yep|confirm\w*|approv\w*|ok(?:ay)?|sure|can do|no problem|we can|will do|received|paid|have (?:it|them)|in stock|available|out of|sold out|ran out|run out|unavailable|not available|no longer)\b/i;

/**
 * Reason codes for anything unsafe in a draft built from a staff answer. Every
 * price and link must come from the staff's words or approved knowledge, and
 * the draft may not assert a commitment (stock, payment, delivery, refund) the
 * staff did not themselves make.
 */
export function checkStaffDraftSafety(draft: string, staffText: string, knowledge: { id?: string; content: string }[]): string[] {
  const codes = checkReplySafety(draft, [
    { id: "staff", content: staffText },
    ...knowledge.map((k, i) => ({ id: k.id ?? `k${i}`, content: k.content })),
  ]).filter((c) => c !== "unsafe_commitment");
  if (!draft.trim()) codes.push("empty_draft");
  if (hasCommitmentLanguage(draft) && !hasCommitmentLanguage(staffText) && !STAFF_AFFIRMS.test(staffText)) {
    codes.push("unsupported_commitment");
  }
  if (detectPromptInjection(draft)) codes.push("prompt_injection");
  return Array.from(new Set(codes));
}

/** Safety for text the staff typed themselves ("!send <text>"): only secrets and size are checked. */
export function checkExactSendSafety(body: string): string[] {
  return checkReplySafety(body, [{ id: "staff", content: body }]).filter((c) => c === "credential_leak" || c === "reply_too_long");
}

// ── Sent or withheld ─────────────────────────────────────────────────────────

export type WithholdReason =
  | "not_authorized"
  | "sender_not_authorized"
  | "observe_mode"
  | "agent_disabled"
  | "contact_excluded"
  | "contact_not_permitted"
  | "human_takeover"
  | "staff_recently_active"
  | "draft_needs_review"
  | "draft_unavailable"
  | "nothing_to_tell"
  | "draft_stale"
  | "draft_expired"
  | "already_sent"
  | "send_in_progress"
  | "send_unconfirmed"
  | "other_restriction";

export type SendDecision = { send: true } | { send: false; reason: WithholdReason };

/**
 * Whether the customer receives a message NOW. Order matters: a hard restriction
 * is reported before "you did not authorize it", because telling staff to reply
 * "send" would be misleading when the send would be refused anyway.
 *
 *   restrictions (agent off, Observe, contact permissions, takeover, recent
 *   human activity)  →  nothing to send / needs review  →  not authorized  →  send
 */
export function decideCustomerSend(input: {
  settings: AgentSettings | null;
  authorized: boolean;
  gate: GateResult;
  /** Reason codes from checkStaffDraftSafety()/checkExactSendSafety(). */
  safetyCodes: string[];
  hasText: boolean;
  /** Why there is no text: the model failed, or the answer simply has nothing to pass on. Default: failed. */
  noText?: "draft_unavailable" | "nothing_to_tell";
  /** Set when the draft is older than the customer's latest message. */
  stale?: boolean;
  /** Set when the temporary facts (stock, availability) the draft rests on have expired. */
  expired?: boolean;
  /** Why `authorized` is false, when it is the sender and not the missing "send" that is the problem. */
  unauthorizedReason?: "sender_not_authorized";
  /** priorNoticeHold-style verdict on earlier sends of the same text. */
  priorHold?: "already_sent" | "send_in_progress" | "send_unconfirmed" | null;
}): SendDecision {
  const { settings } = input;
  if (!settings?.enabled) return { send: false, reason: "agent_disabled" };
  if (settings.mode !== "assisted") return { send: false, reason: "observe_mode" };
  if (!input.gate.pass) return { send: false, reason: gateReasonToWithhold(input.gate.reasons) };
  if (!input.hasText) return { send: false, reason: input.noText ?? "draft_unavailable" };
  if (input.safetyCodes.length > 0) return { send: false, reason: "draft_needs_review" };
  if (!input.authorized) return { send: false, reason: input.unauthorizedReason ?? "not_authorized" };
  if (input.stale) return { send: false, reason: "draft_stale" };
  if (input.expired) return { send: false, reason: "draft_expired" };
  if (input.priorHold) return { send: false, reason: input.priorHold };
  return { send: true };
}

function gateReasonToWithhold(reasons: string[]): WithholdReason {
  if (reasons.includes("contact_excluded")) return "contact_excluded";
  if (reasons.includes("contact_not_permitted")) return "contact_not_permitted";
  if (reasons.includes("human_takeover")) return "human_takeover";
  if (reasons.includes("staff_recently_active")) return "staff_recently_active";
  if (reasons.includes("agent_disabled")) return "agent_disabled";
  return "other_restriction";
}

/** The sentence staff read after "Not sent:" — plain language, never a reason code. */
export const WITHHOLD_TEXT: Record<WithholdReason, string> = {
  not_authorized: "your reply was saved as information only — I message the customer only when you approve it",
  sender_not_authorized: "you're not on this business's list of people who can send customer replies from WhatsApp — ask an admin to add you, or reply to the customer yourself",
  observe_mode: "the AI agent is in Observe mode, so it never messages customers",
  agent_disabled: "the AI agent is switched off for this business",
  contact_excluded: "this customer is excluded from AI messaging",
  contact_not_permitted: "this customer isn't on the list of contacts the AI may message",
  human_takeover: "this chat is on human takeover",
  staff_recently_active: "someone on the team messaged this customer a moment ago",
  draft_needs_review: "the draft mentions details that weren't in your reply, so it needs a quick check first",
  draft_unavailable: "I couldn't prepare a draft just now",
  nothing_to_tell: "your reply doesn't contain anything to pass on to the customer",
  draft_stale: "the customer has written again since this draft was prepared",
  draft_expired: "the stock or availability details this draft rests on have expired — check them and send your own wording",
  already_sent: "this reply was already sent to the customer",
  send_in_progress: "this reply is already on its way to the customer",
  send_unconfirmed: "an earlier attempt to send this reply couldn't be confirmed, so I won't risk sending it twice — please check the chat",
  other_restriction: "customer messaging isn't allowed for this chat right now",
};

/** Hold on a repeat send of the same text, from the earlier outbox rows' states (see priorNoticeHold in engine.ts). */
export function relayHoldFrom(hold: string | null): "already_sent" | "send_in_progress" | "send_unconfirmed" | null {
  switch (hold) {
    case "notice_already_sent":
      return "already_sent";
    case "notice_in_flight":
      return "send_in_progress";
    case "notice_send_unconfirmed":
      return "send_unconfirmed";
    default:
      return null;
  }
}

/** True when the customer wrote after `since` — a draft prepared before that no longer answers them. */
export function customerWroteSince(updates: unknown, since: string): boolean {
  if (!Array.isArray(updates)) return false;
  const cutoff = Date.parse(since);
  return updates.some((u) => {
    const at = Date.parse((u as { at?: string } | null)?.at ?? "");
    return !Number.isNaN(at) && !Number.isNaN(cutoff) && at > cutoff;
  });
}

/** True when the temporary facts a draft rests on have run out — a stock claim must not outlive its facts. */
export function draftExpired(validUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!validUntil) return false;
  const until = Date.parse(validUntil);
  return !Number.isNaN(until) && until <= now.getTime();
}

/**
 * Whether text states a temporary condition (stock, "today", a shortage…). Such
 * text can never become permanent knowledge, whoever proposes it or edits it.
 */
export function statesTemporaryCondition(text: string): boolean {
  return TEMPORAL_CUE.test(text);
}

// ── Retrying a failed staff answer ───────────────────────────────────────────

export type RetryRefusal =
  | "not_failed"
  | "customer_send_may_have_happened"
  | "escalation_closed"
  | "sender_not_authorized";

export const RETRY_REFUSAL_TEXT: Record<RetryRefusal, string> = {
  not_failed: "This answer is not in a failed state.",
  customer_send_may_have_happened:
    "A message to the customer may already have been sent for this answer, so it cannot be retried automatically. Check the chat with the customer first.",
  escalation_closed: "This escalation is closed.",
  sender_not_authorized: "The staff member who asked for this send is no longer on the authorized list.",
};

/**
 * A failed answer may be run again only when that cannot message a customer
 * twice: it failed (not still running), the escalation is open, and no customer
 * message created for it is sent, in flight, or of unknown outcome. `relayRows`
 * are the customer-bound outbox rows created by the answer's own event.
 */
export function decideRetry(input: {
  state: string;
  command: "answer" | "send";
  escalationStatus: string;
  relayRows: { status: string; error: string | null }[];
  /** For a "send" only: the sender is still authorized. */
  senderStillAuthorized: boolean;
}): { ok: true } | { ok: false; reason: RetryRefusal } {
  if (input.state !== "failed") return { ok: false, reason: "not_failed" };
  if (input.escalationStatus === "resolved" || input.escalationStatus === "cancelled") return { ok: false, reason: "escalation_closed" };
  if (input.relayRows.length > 0 && priorNoticeHold(input.relayRows) !== null) return { ok: false, reason: "customer_send_may_have_happened" };
  if (input.command === "send" && !input.senderStillAuthorized) return { ok: false, reason: "sender_not_authorized" };
  return { ok: true };
}

/** Why the bridge did not deliver a customer reply — for the follow-up staff message. */
export function describeSendFailure(error: string | null): string {
  const code = (error ?? "").split(":")[0].trim();
  switch (code) {
    case "bridge_send_disabled":
      return "sending is switched off for the whole system right now";
    case "observe_mode":
    case "agent_disabled":
      return "the AI agent is not allowed to message customers right now";
    case "human_takeover":
      return "this chat is on human takeover";
    case "held_after_unknown_send":
      return "sending is paused after a message whose delivery couldn't be confirmed — please check the chat";
    case "chat_rate_limited":
    case "business_rate_limited":
      return "the sending limit was reached";
    case "stale_reply":
    case "superseded_by_newer_message":
      return "the customer has written again since";
    default:
      return BLOCK_REASONS.has(code) ? "a safety check stopped it" : "WhatsApp couldn't deliver it";
  }
}

// ── Staff-group wording ──────────────────────────────────────────────────────

function clip(value: string, max: number): string {
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type ItemDisposition =
  | "candidate"
  | "candidate_conflict"
  | "already_known"
  | "temporary"
  | "customer_memory"
  | "recorded_only"
  | "skipped";

export interface ItemOutcome {
  category: StaffFactCategory;
  disposition: ItemDisposition;
  title: string;
  content: string;
  validUntil?: string | null;
  /** Why an item was not stored (admin dashboard only; never printed in the group). */
  note?: string;
}

/** At most three short lines about what was learned. Quiet when there is nothing to say. */
export function summarizeOutcomes(outcomes: ItemOutcome[]): string[] {
  const lines: string[] = [];
  const candidates = outcomes.filter((o) => o.disposition === "candidate");
  const conflicts = outcomes.filter((o) => o.disposition === "candidate_conflict");
  const temps = outcomes.filter((o) => o.disposition === "temporary");
  const customer = outcomes.filter((o) => o.disposition === "customer_memory");
  if (conflicts.length > 0) {
    lines.push(`⚠️ "${clip(conflicts[0].title, 50)}" differs from what's on file — an admin will review it before anything changes.`);
  }
  if (candidates.length > 0) {
    lines.push(`📚 Suggested for the knowledge base (admin approves): ${clip(candidates[0].content, 90)}${candidates.length > 1 ? ` +${candidates.length - 1} more` : ""}`);
  }
  if (temps.length > 0) {
    lines.push(`🕒 Used for now only, not saved as a rule: ${clip(temps[0].content, 80)}`);
  }
  if (customer.length > 0) {
    lines.push(`🔒 Kept on this customer's record only: ${clip(customer[0].content, 80)}`);
  }
  return lines.slice(0, 3);
}

export interface StaffDraftMessageInput {
  refCode: string;
  customerLabel: string;
  draft: string | null;
  decision: SendDecision;
  learned: string[];
}

/**
 * The one message posted in the staff group after a staff answer: the proposed
 * customer reply and whether it was sent or held back. Concise, reason codes
 * never shown.
 */
export function buildStaffDraftMessage(input: StaffDraftMessageInput): string {
  const label = clip(input.customerLabel, 60);
  const lines: string[] = [];
  if (input.decision.send) {
    lines.push(`📤 Sending reply for #${input.refCode} · ${label}`, `"${clip(input.draft ?? "", 600)}"`);
  } else if (input.draft) {
    lines.push(`✍️ Draft reply for #${input.refCode} · ${label}`, `"${clip(input.draft, 600)}"`, "", `Not sent: ${WITHHOLD_TEXT[input.decision.reason]}.`);
    const canSendLater = !["observe_mode", "agent_disabled", "contact_excluded", "contact_not_permitted", "human_takeover", "staff_recently_active", "already_sent", "send_in_progress", "send_unconfirmed", "sender_not_authorized"].includes(input.decision.reason);
    if (canSendLater) {
      lines.push(
        input.decision.reason === "draft_needs_review" || input.decision.reason === "draft_stale" || input.decision.reason === "draft_expired"
          ? `To send your own wording: reply with !send <text>.`
          : `To send it: reply to this message with "send" (or !send <your own wording>).`
      );
    } else if (["observe_mode", "agent_disabled", "contact_excluded", "contact_not_permitted", "human_takeover", "staff_recently_active", "sender_not_authorized"].includes(input.decision.reason)) {
      lines.push("You can copy this draft and reply to the customer yourself.");
    }
  } else {
    lines.push(`ℹ️ Answer saved for #${input.refCode} · ${label}`, `Not sent: ${WITHHOLD_TEXT[input.decision.reason]}.`);
    if (input.decision.reason === "draft_unavailable") lines.push("To message the customer, reply with !send <your wording>.");
  }
  if (input.learned.length > 0) lines.push("", ...input.learned);
  return lines.join("\n");
}

/** Posted when the bridge reports that an authorized customer reply was not delivered. */
export function buildSendFailureMessage(input: { refCode: string; customerLabel: string; error: string | null }): string {
  return [
    `⚠️ Reply not sent for #${input.refCode} · ${clip(input.customerLabel, 60)}`,
    `The customer did not receive it: ${describeSendFailure(input.error)}.`,
  ].join("\n");
}

/**
 * Posted when a staff message could not be processed. Says honestly whether a
 * customer message may already have gone out; never blames, never shows codes.
 */
export function buildProcessingFailureMessage(input: { refCode: string | null; mayHaveSent: boolean }): string {
  const about = input.refCode ? ` for #${input.refCode}` : "";
  if (input.mayHaveSent) {
    return [
      `⚠️ Something went wrong while handling your message${about}.`,
      "A reply to the customer may or may not have been sent — please check the chat before doing anything else. It will not be retried automatically.",
    ].join("\n");
  }
  return [
    `⚠️ Something went wrong while handling your message${about}.`,
    input.refCode
      ? "Nothing was sent to the customer. An admin can retry it from the dashboard, or you can send your answer again."
      : "Nothing was sent to any customer. Please send it again.",
  ].join("\n");
}
