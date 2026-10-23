// Long-term customer memory — pure functions, no I/O, no path-alias imports (so
// they run under `npm test`). The server side (lib/server/aiAgent/memory.ts)
// loads rows and calls into this file; every rule about WHAT may be remembered,
// HOW it is labelled and how "same as last time" is resolved lives here.
//
// Three kinds of knowledge are kept strictly apart, and the labels survive all
// the way into the model prompt and the staff notice:
//   VERIFIED     customer_orders rows staff have processed (order_status
//                'Added' = entered in the real order system, 'Completed' =
//                delivered), plus facts staff confirmed (resolved issues).
//   CUSTOMER SAID explicit preferences the customer stated, each stored with
//                their verbatim words as evidence.
//   UNVERIFIED   AI inferences (customer_ai_profile), AI-detected orders still
//                'Needs adding', and open order requests. Never a purchase.

import type { ChatIdentity } from "./identity.ts";
import { detectPromptInjection, type OrderItem, type OrderRequestDraft } from "./engine.ts";

// ── Keys: who a memory belongs to ────────────────────────────────────────────

const VERIFIED_PHONE = /^\d{8,15}$/;

/**
 * Storage key for facts about this customer: the VERIFIED phone number, or
 * `chat:<chat_id>` when WhatsApp reported no phone for an @lid chat. Lid digits
 * and display names are never keys, so two customers can never be merged by
 * similar names or by lid digits that merely look like a number.
 */
export function primaryMemoryKey(chatId: string, identity: Pick<ChatIdentity, "phone">): string {
  return identity.phone && VERIFIED_PHONE.test(identity.phone) ? identity.phone : `chat:${chatId}`;
}

/** Every key whose facts provably belong to this contact (same verified phone, or one of its known chats). */
export function memoryKeysFor(identity: Pick<ChatIdentity, "phone" | "chatIds">): string[] {
  const keys = new Set<string>();
  if (identity.phone && VERIFIED_PHONE.test(identity.phone)) keys.add(identity.phone);
  for (const id of identity.chatIds) keys.add(`chat:${id}`);
  return [...keys];
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface OrderRow {
  id: string;
  order_seq?: number | null;
  chat_id?: string | null;
  summary: string | null;
  order_status: string | null;
  source_message_at: string | null;
  details?: { products_services?: unknown; quantity?: unknown } | null;
  delivery_address?: string | null;
  ai_memory_excluded?: boolean | null;
}

export interface OrderRecord {
  id: string;
  summary: string;
  status: string | null;
  at: string | null;
  products: string[];
  quantity: string | null;
  address: string | null;
  excluded: boolean;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;
}

export function orderRecordFromRow(row: OrderRow): OrderRecord {
  const raw = row.details?.products_services;
  const products = Array.isArray(raw)
    ? raw.map((p) => cleanString(p, 120)).filter((p): p is string => Boolean(p)).slice(0, 12)
    : [];
  return {
    id: row.id,
    summary: cleanString(row.summary, 400) ?? "",
    status: row.order_status,
    at: row.source_message_at,
    products,
    quantity: cleanString(row.details?.quantity, 60),
    address: cleanString(row.delivery_address, 200),
    excluded: row.ai_memory_excluded === true,
  };
}

/**
 * Only an order staff have processed counts as a purchase: 'Added' (entered
 * into the real system) or 'Completed' (delivered). 'Needs adding', or no
 * status at all, is just the AI's reading of a conversation.
 */
export function isVerifiedOrder(order: Pick<OrderRecord, "status">): boolean {
  return order.status === "Added" || order.status === "Completed";
}

function newestFirst(a: OrderRecord, b: OrderRecord): number {
  return (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0);
}

function dateLabel(iso: string | null): string {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "date unknown";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export interface BriefOrder {
  id: string;
  /** "Dog food 15kg ×2 — 12 Oct 2026". Built from stored fields only. */
  description: string;
  at: string | null;
  products: string[];
  quantity: string | null;
  verified: boolean;
}

export function describeOrder(order: OrderRecord): string {
  const items = order.products.length > 0 ? order.products.join(", ") : order.summary.slice(0, 120) || "order details not recorded";
  const qty = order.quantity ? ` ×${order.quantity.replace(/^[x×]\s*/i, "")}` : "";
  return `${items}${qty} — ${dateLabel(order.at)}`;
}

function toBrief(order: OrderRecord): BriefOrder {
  return {
    id: order.id,
    description: describeOrder(order),
    at: order.at,
    products: order.products,
    quantity: order.quantity,
    verified: isVerifiedOrder(order),
  };
}

// ── "Same as last time" ──────────────────────────────────────────────────────

const REPEAT_PATTERN =
  /\b(same (as|like|thing as) (last time|before|usual|previously|the (last|previous|other) (time|one|order|week|month))|same again|same (order|thing|stuff|one|as always)\b|(my|the) usual|as (usual|always|before|last time)|like (last time|before)|(repeat|redo|resend) (my |the )?(last |previous |usual )?(order|one)|(order|get|send) (me )?(the )?same|one more of (the )?same)/i;

export function detectRepeatOrderRequest(text: string): boolean {
  return REPEAT_PATTERN.test(text);
}

export type RepeatResolution =
  | { kind: "none" }
  | { kind: "no_history"; unconfirmed: number }
  | { kind: "unclear" }
  | { kind: "single"; order: BriefOrder; draft: OrderRequestDraft }
  | { kind: "ambiguous"; options: BriefOrder[]; question: string };

function signature(order: Pick<OrderRecord, "products" | "quantity" | "summary">): string {
  const products = order.products.map((p) => normalizeText(p)).sort().join("|");
  return `${products || normalizeText(order.summary)}#${normalizeText(order.quantity ?? "")}`;
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const STOP = new Set(["the", "and", "with", "that", "this", "from", "have", "your", "same", "last", "time", "order", "please", "like", "also", "want", "need", "would", "could", "some", "much", "when", "what", "for", "you"]);

function significantTokens(text: string): string[] {
  return [...new Set(normalizeText(text).split(" ").filter((t) => t.length >= 4 && !STOP.has(t)))];
}

/** Seed for the order request: items only. Address and delivery day are always asked again, never assumed. */
export function draftFromOrder(order: Pick<BriefOrder, "products" | "quantity">): OrderRequestDraft {
  const single = order.products.length === 1;
  const items: OrderItem[] = order.products.map((product) => ({ product, quantity: single ? order.quantity : null }));
  return { items, delivery_address: null, delivery_preference: null, notes: "Repeat of a previous order (confirm quantities)" };
}

export function buildClarificationQuestion(options: BriefOrder[]): string {
  const lines = options.map((o, i) => `${i + 1}) ${o.description}`);
  return `Happy to help! Just so I get it right, which of your previous orders do you mean?\n${lines.join("\n")}\nPlease reply with the number, or tell me what you'd like this time.`;
}

/**
 * Resolves "same as last time" against VERIFIED orders only. It never guesses:
 * when the history supports more than one reading it asks; when there is no
 * usable verified order it hands the request to staff.
 */
export function resolveRepeatOrder(orders: OrderRecord[], messageText: string): RepeatResolution {
  if (!detectRepeatOrderRequest(messageText)) return { kind: "none" };
  const usable = orders.filter((o) => !o.excluded);
  const verified = usable.filter(isVerifiedOrder).sort(newestFirst);
  if (verified.length === 0) {
    return { kind: "no_history", unconfirmed: usable.filter((o) => !isVerifiedOrder(o)).length };
  }

  // A product named in the message narrows the history ("same dog food as last time").
  const wanted = significantTokens(messageText);
  const named = wanted.length
    ? verified.filter((o) => {
        const haystack = normalizeText(`${o.products.join(" ")} ${o.summary}`);
        return wanted.some((t) => haystack.includes(t));
      })
    : [];
  const pool = named.length > 0 ? named : verified;

  // Distinct readings among the most recent orders (identical repeats are one reading).
  const distinct: OrderRecord[] = [];
  const seen = new Set<string>();
  for (const o of pool.slice(0, 5)) {
    const sig = signature(o);
    if (seen.has(sig)) continue;
    seen.add(sig);
    distinct.push(o);
  }

  if (distinct.length === 1) {
    const only = toBrief(distinct[0]);
    if (only.products.length === 0) return { kind: "unclear" };
    return { kind: "single", order: only, draft: draftFromOrder(only) };
  }
  const options = distinct.slice(0, 3).map(toBrief);
  return { kind: "ambiguous", options, question: buildClarificationQuestion(options) };
}

// ── Facts ────────────────────────────────────────────────────────────────────

export type MemoryFactKind = "preference" | "delivery_preference" | "resolved_issue" | "note";
export type MemoryFactSource = "customer_stated" | "staff_confirmed" | "admin";

export const MODEL_FACT_KINDS = ["preference", "delivery_preference"] as const;
export const MEMORY_FACT_MAX_CHARS = 200;
export const MEMORY_RETENTION_DAYS = 730;
const MAX_FACTS_PER_TURN = 3;

export interface MemoryFactRow {
  id: string;
  kind: MemoryFactKind;
  source: MemoryFactSource;
  content: string;
  evidence: string | null;
  expires_at: string | null;
  last_confirmed_at: string | null;
  updated_at: string;
}

export interface CandidateFact {
  kind: (typeof MODEL_FACT_KINDS)[number];
  content: string;
  evidence: string;
}

export function fingerprintOf(content: string): string {
  return normalizeText(content).slice(0, 200);
}

export function defaultExpiry(now: Date): string {
  return new Date(now.getTime() + MEMORY_RETENTION_DAYS * 86_400_000).toISOString();
}

// Anything that states a price, stock level, payment, or a delivery
// arrangement is not a preference and is never remembered.
const UNREMEMBERABLE =
  /(?:EC\$|US\$|XCD|\$)\s?\d|\d\s?(?:EC|XCD|USD|dollars?)\b|\bhttps?:\/\/|\bwww\.|\d{9,}|\b(in stock|out of stock|available|availability|restock\w*|price[sd]?|cost[s]?|paid|payment|owe[sd]?|refund\w*|discount\w*|free delivery|confirmed|promis\w*|guarantee\w*|will (be )?deliver\w*|delivered on|arriv\w+ (on|by))\b/i;

export type FactRejection =
  | "bad_kind"
  | "empty"
  | "too_long"
  | "no_evidence"
  | "evidence_not_verbatim"
  | "question"
  | "unremembered_content"
  | "evidence_unrelated";

/**
 * Filters the facts a model proposed. A fact is kept only when the customer's
 * own words, quoted verbatim, support it — the model can neither invent a
 * preference nor attach a price, stock claim or delivery promise to one.
 */
export function validateMemoryFacts(
  raw: unknown,
  customerText: string
): { accepted: CandidateFact[]; rejected: { content: string; reason: FactRejection }[] } {
  const accepted: CandidateFact[] = [];
  const rejected: { content: string; reason: FactRejection }[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };
  const haystack = normalizeText(customerText);

  for (const item of raw.slice(0, 8)) {
    const kind = (item as { kind?: unknown })?.kind;
    const content = cleanString((item as { content?: unknown })?.content, 400);
    const evidence = cleanString((item as { evidence?: unknown })?.evidence, 500);
    const reject = (reason: FactRejection) => rejected.push({ content: content ?? "", reason });

    if (!(MODEL_FACT_KINDS as readonly unknown[]).includes(kind)) reject("bad_kind");
    else if (!content) reject("empty");
    else if (content.length > MEMORY_FACT_MAX_CHARS) reject("too_long");
    else if (!evidence) reject("no_evidence");
    else if (evidence.trim().endsWith("?")) reject("question");
    else if (normalizeText(evidence).length < 6 || !haystack.includes(normalizeText(evidence))) reject("evidence_not_verbatim");
    else if (
      UNREMEMBERABLE.test(content) ||
      UNREMEMBERABLE.test(evidence) ||
      detectPromptInjection(content) ||
      detectPromptInjection(evidence)
    ) {
      reject("unremembered_content");
    }
    else if (!significantTokens(content).some((t) => normalizeText(evidence).includes(t))) reject("evidence_unrelated");
    else if (accepted.length < MAX_FACTS_PER_TURN && !accepted.some((a) => fingerprintOf(a.content) === fingerprintOf(content))) {
      accepted.push({ kind: kind as CandidateFact["kind"], content, evidence });
    }
  }
  return { accepted, rejected };
}

// ── Brief: concise, relevant memory for one turn ─────────────────────────────

export interface BriefFact {
  id: string;
  kind: MemoryFactKind;
  source: MemoryFactSource;
  content: string;
}

export interface MemoryBrief {
  verifiedOrders: BriefOrder[];
  /** AI-detected / unprocessed orders: a past REQUEST, not a purchase. */
  unconfirmedOrders: BriefOrder[];
  facts: BriefFact[];
  /** customer_ai_profile fields: AI inferences, may be stale or wrong. */
  inferences: Record<string, string>;
  repeat: RepeatResolution;
}

export const EMPTY_BRIEF: MemoryBrief = {
  verifiedOrders: [],
  unconfirmedOrders: [],
  facts: [],
  inferences: {},
  repeat: { kind: "none" },
};

const MAX_VERIFIED = 3;
const MAX_VERIFIED_WHEN_REPEAT = 5;
const MAX_UNCONFIRMED = 2;
const MAX_FACTS = 6;
const MAX_INFERENCE_CHARS = 200;

export function buildMemoryBrief(input: {
  orders: OrderRecord[];
  facts: MemoryFactRow[];
  profile: Record<string, string>;
  messageText: string;
  now: Date;
}): MemoryBrief {
  const repeat = resolveRepeatOrder(input.orders, input.messageText);
  const usable = input.orders.filter((o) => !o.excluded).sort(newestFirst);
  const verified = usable.filter(isVerifiedOrder).slice(0, repeat.kind === "none" ? MAX_VERIFIED : MAX_VERIFIED_WHEN_REPEAT);
  const unconfirmed = usable.filter((o) => !isVerifiedOrder(o)).slice(0, MAX_UNCONFIRMED);

  const wanted = significantTokens(input.messageText);
  const live = input.facts.filter((f) => !f.expires_at || Date.parse(f.expires_at) > input.now.getTime());
  const ranked = live
    .map((f) => {
      const text = normalizeText(f.content);
      const overlap = wanted.filter((t) => text.includes(t)).length;
      const age = (input.now.getTime() - (Date.parse(f.updated_at) || 0)) / 86_400_000;
      // Relevance to this message first, then recency; resolved issues stay visible.
      return { f, score: overlap * 3 + (f.kind === "resolved_issue" ? 1 : 0) - Math.min(age / 365, 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FACTS)
    .map(({ f }) => ({ id: f.id, kind: f.kind, source: f.source, content: f.content }));

  const inferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.profile)) {
    const v = cleanString(value, MAX_INFERENCE_CHARS);
    if (v) inferences[key] = v;
  }

  return {
    verifiedOrders: verified.map(toBrief),
    unconfirmedOrders: unconfirmed.map(toBrief),
    facts: ranked,
    inferences,
    repeat,
  };
}

const FACT_LABEL: Record<MemoryFactKind, string> = {
  preference: "Customer-stated preference",
  delivery_preference: "Customer-stated delivery preference",
  resolved_issue: "Earlier issue, resolved by staff",
  note: "Staff note",
};

/** The memory section of the model prompt. Each block says exactly how far it can be trusted. */
export function renderMemoryBrief(brief: MemoryBrief): string {
  const lines: string[] = [];
  lines.push(
    "VERIFIED ORDER HISTORY (orders staff have processed; the ONLY completed purchases):",
    brief.verifiedOrders.length ? brief.verifiedOrders.map((o) => `- ${o.description}`).join("\n") : "- none on record"
  );
  if (brief.unconfirmedOrders.length) {
    lines.push(
      "PAST REQUESTS NOT CONFIRMED (AI-detected, never processed by staff; NOT purchases, do not treat as bought):",
      brief.unconfirmedOrders.map((o) => `- ${o.description}`).join("\n")
    );
  }
  if (brief.facts.length) {
    lines.push("REMEMBERED FACTS:", brief.facts.map((f) => `- ${FACT_LABEL[f.kind]}: ${f.content}`).join("\n"));
  }
  if (Object.keys(brief.inferences).length) {
    lines.push("AI INFERENCES (unverified, may be stale or wrong; never state them as fact):", JSON.stringify(brief.inferences));
  }
  const r = brief.repeat;
  if (r.kind === "single") {
    lines.push(`REPEAT-ORDER REQUEST: the customer asked for the same as before. The one matching verified order is: ${r.order.description}. Quantities and delivery must still be confirmed; staff approve.`);
  } else if (r.kind === "ambiguous") {
    lines.push("REPEAT-ORDER REQUEST: the customer asked for the same as before, but their verified history supports several readings. Do NOT pick one; the server will ask which they mean.");
  } else if (r.kind === "no_history" || r.kind === "unclear") {
    lines.push("REPEAT-ORDER REQUEST: the customer asked for the same as before but there is no usable verified order. Do NOT guess; escalate.");
  }
  return lines.join("\n");
}

/** Short, labelled lines for the staff notice (max 5). Confirmed history is kept apart from the current request. */
export function historyLinesForStaff(brief: MemoryBrief): string[] {
  const clip = (s: string) => (s.length > 130 ? `${s.slice(0, 129)}…` : s);
  const out: string[] = [];
  for (const o of brief.verifiedOrders.slice(0, 2)) out.push(`✔ Confirmed order: ${o.description}`);
  for (const o of brief.unconfirmedOrders.slice(0, 1)) out.push(`✘ Earlier request, never confirmed: ${o.description}`);
  for (const f of brief.facts) {
    if (out.length >= 5) break;
    if (f.kind === "resolved_issue") out.push(`Earlier issue (resolved): ${f.content}`);
    else if (f.source === "customer_stated") out.push(`Customer said: ${f.content}`);
  }
  const r = brief.repeat;
  if (r.kind === "single") out.push(`Asked for "same as last time" → matches: ${r.order.description}`);
  else if (r.kind === "ambiguous") out.push(`Asked for "same as last time" → ${r.options.length} possible orders; customer was asked which`);
  else if (r.kind === "no_history" || r.kind === "unclear") out.push(`Asked for "same as last time" → no confirmed order to match`);
  return out.slice(0, 5).map(clip);
}
