// Automatic business learning — the pure rules (no I/O), unit-tested in tests/aiAgentAutoLearning.test.ts.
//
// A genuine outgoing HUMAN message of the business account may state a reusable fact (a standard price, a
// dimension, an opening time). This file decides what happens to each fact the model proposed, and the model's
// word is never enough on its own:
//
//   save      a clear, complete, standard, non-conflicting fact          → approved knowledge, counted in the digest
//   update    an explicit correction of a fact this system learned      → the old entry is archived, never edited
//   duplicate the same fact is already known                            → nothing changes, nothing is counted
//   review    anything a person should decide (conflicting price,        → a pending suggestion, dashboard only
//             ambiguous product, customer terms, a policy, weak evidence)
//   skip      not reusable business knowledge (one-off, temporary,       → nothing is stored
//             private, vague, a special price)
//
// Customers never reach this file: it sees the business's own words, and only reads the conversation to NAME the
// product a sentence is about. Every figure in a fact must be in the business's own message.

import { KNOWLEDGE_KINDS, looksLikeAgentMessage } from "./engine.ts";
import { normalizeText } from "./memory.ts";
import { looksLikeStatement } from "./pilot.ts";
import {
  assessKnowledgeCandidate,
  candidateFingerprint,
  type ClassifiedItem,
  type KnowledgeConflict,
  statesTemporaryCondition,
} from "./staffAnswers.ts";

/** Meaningful automatic changes per business before one digest goes to the staff group. */
export const DIGEST_THRESHOLD = 10;
/** Whatever has not reached the threshold is announced once, when the oldest such fact is this many days old. */
export const WEEKLY_DIGEST_DAYS = 7;
/** A fact forgotten or rejected is not relearned from the same fact for this long. */
export const RELEARN_BLOCK_DAYS = 30;
/** Below this the model is not trusted at all; between this and AUTO_CONFIDENCE a person decides. */
export const MIN_CONFIDENCE = 0.5;
export const AUTO_CONFIDENCE = 0.75;
/** A product named only by the surrounding conversation (not by the message itself) needs more certainty. */
export const CONTEXT_CONFIDENCE = 0.85;
/** Model calls a business may spend on automatic learning per hour. */
export const AUTO_CALLS_PER_HOUR = 20;
export const MAX_LEARNED_CHARS = 400;

// ── Is this message even a candidate? ────────────────────────────────────────

/**
 * A genuine human message of the business account in a customer chat. The bridge's echo check (our own outbox)
 * has already run; this rejects what remains: groups, commands, media-only, and anything that carries the
 * agent's own markers (a forwarded draft, a copied notice).
 */
export function isGenuineHumanOutgoing(input: { fromMe: boolean; chatId: string; text: string; hasMedia?: boolean }): boolean {
  if (!input.fromMe || input.chatId.endsWith("@g.us") || !/@(s\.whatsapp\.net|lid)$/.test(input.chatId)) return false;
  const text = input.text.replace(/\s+/g, " ").trim();
  if (text.length < 12) return false;
  if (text.startsWith("!")) return false;
  if (looksLikeAgentMessage(input.text)) return false;
  if (/^\(media message/i.test(text)) return false;
  return true;
}

const UNIT = "(?:ft|feet|foot|inch|inches|cm|mm|metres?|meters?|kgs?|lbs?|pounds?|oz|ml|litres?|liters?|gal|gallons?)";
const FRACTION = "[¼½¾⅓⅔⅛]";
const MEASURE = new RegExp(`(?:\\d+(?:\\.\\d+)?${FRACTION}?|${FRACTION})\\s?${UNIT}\\b|\\d+\\s?(?:'|″|")(?=\\s|$|[.,;)])`, "gi");
const MONEY = /(?:EC\$|US\$|XCD\s?|\$)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:EC|XCD|USD|dollars?)\b/gi;

export function moneyAmounts(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(MONEY)) out.add(Number((m[1] ?? m[2]).replace(/,/g, "")));
  return [...out];
}

export function measurementsOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MEASURE), (m) => m[0].toLowerCase().replace(/\s+/g, "")))];
}

/** A free pre-filter before any model call: a statement that carries a price, a measurement or a usual business cue. */
export function autoLearnWorthLooking(text: string): boolean {
  return looksLikeStatement(text, false) && (moneyAmounts(text).length > 0 || measurementsOf(text).length > 0 || looksLikeStatement(text, true));
}

// ── The model's extra fields ─────────────────────────────────────────────────

export interface LearningMeta {
  /** The product or service the fact is about, as the model resolved it from the message and the conversation. */
  subject: string | null;
  priceScope: "standard" | "special" | "unclear";
  /** The business explicitly corrects something it said or we knew before ("actually", "now", "no longer"). */
  correction: boolean;
  confidence: number;
}

export function readLearningMeta(raw: unknown): LearningMeta {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const subject = typeof item.subject === "string" && item.subject.trim() ? item.subject.replace(/\s+/g, " ").trim().slice(0, 80) : null;
  const scope = item.price_scope === "standard" || item.price_scope === "special" ? item.price_scope : "unclear";
  const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0;
  return { subject, priceScope: scope, correction: item.is_correction === true, confidence };
}

// ── Subject identity ─────────────────────────────────────────────────────────

const GENERIC_SUBJECT = new Set(["item", "items", "it", "this", "that", "these", "those", "one", "ones", "thing", "things", "product", "products", "size", "them", "stuff", "unit", "model", "option"]);
const SUBJECT_STOP = new Set(["the", "a", "an", "of", "our", "your", "my", "for", "and"]);

function tokens(text: string): string[] {
  // "25 ft" and "25ft" are the same word.
  return normalizeText(text.replace(/(\d)\s+(?=[a-z])/gi, "$1"))
    .split(" ")
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function subjectTokens(subject: string): string[] {
  return tokens(subject).filter((t) => !SUBJECT_STOP.has(t));
}

/** Stable identity of a product: its significant words, sorted. "The 25ft Hose" and "hose 25ft" are the same. */
export function subjectKey(subject: string | null): string | null {
  if (!subject) return null;
  const t = subjectTokens(subject);
  return t.length > 0 ? [...new Set(t)].sort().join(" ") : null;
}

/**
 * Whether a subject the model named is really in the business's message or the recent conversation. validateStaffItems
 * lets a fact repeat the digits of such a name ("25ft hose"); every price and measurement is checked on its own below.
 */
export function subjectInConversation(subject: string | null, staffText: string, contextText: string): boolean {
  if (!subject) return false;
  const sub = subjectTokens(subject);
  if (sub.length === 0) return false;
  const seen = new Set([...tokens(staffText), ...tokens(contextText)]);
  return sub.every((t) => seen.has(t));
}

export type SubjectCheck = { ok: true; from: "message" | "context" } | { ok: false; reason: "no_subject" | "generic_subject" | "subject_not_in_conversation" | "content_missing_subject" };

/**
 * The subject must be a real name (not "the item"), must actually appear in the business's message or the
 * recent conversation (so a model cannot invent one), and the fact's own sentence must name it (so the stored
 * fact still makes sense on its own, years later).
 */
export function checkSubject(subject: string | null, content: string, staffText: string, contextText: string): SubjectCheck {
  if (!subject) return { ok: false, reason: "no_subject" };
  const sub = subjectTokens(subject);
  if (sub.length === 0 || sub.every((t) => GENERIC_SUBJECT.has(t))) return { ok: false, reason: "generic_subject" };
  const inStaff = new Set(tokens(staffText));
  const inContext = new Set(tokens(contextText));
  const named = sub.every((t) => inStaff.has(t));
  if (!named && !sub.every((t) => inStaff.has(t) || inContext.has(t))) return { ok: false, reason: "subject_not_in_conversation" };
  const inContent = new Set(tokens(content));
  if (!sub.every((t) => inContent.has(t))) return { ok: false, reason: "content_missing_subject" };
  return { ok: true, from: named ? "message" : "context" };
}

// ── Cues that move a fact to a person ────────────────────────────────────────

/** Commercial terms for one customer or one deal: never general knowledge, however it was phrased. */
const CUSTOMER_TERMS =
  /\b(credit|on account|on tab|tab\b|pay (?:later|next|me|us when)|invoice|instal?lments?|layaway|owes?|quote[sd]?|quotation|your (?:total|order)|for you|for u\b|special|deal|discount\w*|negotiat\w*|best (?:price|i can)|lowest|i(?:'ll| can| could| will) (?:do|give|let)|let you have|if you (?:take|buy|order|get)|take (?:both|all|the lot)|bulk|wholesale|mate'?s rate|this time|just this once|one[- ]?off|half now)\b/i;

/** Policies and promises a mistake in which would cost the business: always a person's decision. */
const RISKY_POLICY =
  /\b(refund\w*|money back|return\w*|exchange\w*|warrant\w*|guarantee\w*|liab\w*|cancel\w*|non[- ]?refundable|damag\w*|allerg\w*|medic\w*|vet\b|dosage|health|safety|legal|terms|penalt\w*|compensat\w*|insur\w*|deposit\w*)\b/i;

export function hasCustomerTerms(text: string): boolean {
  return CUSTOMER_TERMS.test(text);
}

export function hasRiskyPolicy(text: string): boolean {
  return RISKY_POLICY.test(text);
}

// ── Decisions ────────────────────────────────────────────────────────────────

export type ReviewReason =
  | "price_conflict"
  | "conflicts_existing"
  | "overlaps_existing"
  | "ambiguous_subject"
  | "customer_terms"
  | "price_scope_unclear"
  | "risky_policy"
  | "insufficient_evidence"
  | "changes_staff_entry"
  | "corrects_removed";

export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  price_conflict: "The price differs from what is on file",
  conflicts_existing: "It contradicts something already on file",
  overlaps_existing: "It overlaps an existing entry",
  ambiguous_subject: "It is not clear which product this is about",
  customer_terms: "It sounds like terms for one customer, not a general rule",
  price_scope_unclear: "It is not clear this is the standard price",
  risky_policy: "It states a policy or promise that needs a person's approval",
  insufficient_evidence: "The AI was not sure enough to learn it on its own",
  changes_staff_entry: "It would change an entry that staff wrote",
  corrects_removed: "It corrects a fact that was removed — a person must decide",
};

export type SkipReason = "unsupported_figure" | "not_reusable" | "temporary" | "private" | "special_price" | "low_confidence" | "bad_kind" | "too_long" | "blocked";

export interface AutoFact {
  kind: string;
  title: string;
  content: string;
  subject: string | null;
  subjectKey: string | null;
  /** The standard price when the fact states exactly one amount. */
  priceAmount: number | null;
  fingerprint: string;
  summary: string;
  confidence: number;
}

export type AutoDecision =
  | { action: "save"; fact: AutoFact }
  | { action: "update"; fact: AutoFact; replaceId: string; replaced: ActiveFact }
  | { action: "duplicate"; ofId: string | null }
  | { action: "review"; reason: ReviewReason; fact: AutoFact; conflicts: KnowledgeConflict[] }
  | { action: "skip"; reason: SkipReason };

/** An active knowledge entry as the decision sees it. */
export interface ActiveFact {
  id: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  subject_key: string | null;
  price_amount: number | null;
  fingerprint: string | null;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function formatMoney(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** One short line for the digest, built from stored fields only ("25ft hose — $128"). */
export function summaryLine(fact: Pick<AutoFact, "subject" | "priceAmount" | "title" | "content">): string {
  if (fact.priceAmount !== null && fact.subject) return `${clip(fact.subject, 40)} — ${formatMoney(fact.priceAmount)}`;
  return clip((fact.title || fact.content).replace(/\s+/g, " ").trim(), 60);
}

/**
 * Equivalent facts share a fingerprint: the same product with the same price (or the same measurement) is one
 * fact however it was worded; anything else falls back to the normalised sentence.
 */
export function factFingerprint(content: string, key: string | null, amounts: number[], measures: string[]): string {
  if (key && (amounts.length > 0 || measures.length > 0)) {
    return `${key}|${amounts.slice().sort((a, b) => a - b).join(",")}|${measures.slice().sort().join(",")}`;
  }
  return candidateFingerprint(content);
}

/** A fact a person removed (!forget / Archive) or a suggestion they rejected, recently enough to still be remembered. */
export interface RemovedFact {
  kind: string | null;
  title: string | null;
  content: string;
  subject_key: string | null;
  price_amount: number | null;
  fingerprint: string | null;
}

/**
 * What a recently removed fact means for a new one:
 *   suppress  the same claim again (same fingerprint, or the same figures reworded), or a different value for the same
 *             product that the business did not explicitly present as a correction → nothing is stored or suggested
 *   review    a genuinely different value for the same product that the business explicitly states as a correction
 *             → a person decides; nothing is learned automatically and nothing is reactivated
 *   none      unrelated
 * Only a person ever brings a removed fact back (Restore, or approving a new suggestion).
 */
export function checkRemoved(fact: AutoFact, meta: LearningMeta, removed: RemovedFact[]): "none" | "suppress" | "review" {
  if (removed.length === 0) return "none";
  const sameClaim = removed.some((r) => (r.fingerprint ?? candidateFingerprint(r.content)) === fact.fingerprint);
  if (sameClaim) return "suppress";
  const reworded = assessKnowledgeCandidate(
    { kind: fact.kind, title: fact.title, content: fact.content },
    removed.map((r, i) => ({ id: String(i), kind: r.kind ?? fact.kind, title: r.title ?? "", content: r.content }))
  );
  if (reworded.duplicateOf) return "suppress";
  // The same product and the same kind of claim (a price against a price, a plain fact against a plain fact).
  const slot = removed.some((r) => fact.subjectKey !== null && r.subject_key === fact.subjectKey && (r.price_amount !== null) === (fact.priceAmount !== null));
  if (!slot) return "none";
  return meta.correction ? "review" : "suppress";
}

export function decideAutoLearn(input: {
  item: ClassifiedItem;
  meta: LearningMeta;
  staffText: string;
  contextText: string;
  active: ActiveFact[];
  /** Facts removed in the last RELEARN_BLOCK_DAYS days (see checkRemoved). */
  removed?: RemovedFact[];
}): AutoDecision {
  const { item, meta, staffText, contextText } = input;
  const evidenceText = `${item.evidence} ${item.content}`;

  if (item.category !== "durable") {
    // The model called it reusable but the words say otherwise (a discount, one customer's arrangement): a person
    // decides whether it was meant as a rule. Anything the model itself called one-off or temporary is dropped.
    if (item.moved_from === "durable" && item.category !== "temporary" && (moneyAmounts(item.content).length > 0 || hasCustomerTerms(evidenceText))) {
      return { action: "review", reason: "customer_terms", fact: buildFact(item, meta, [], []), conflicts: [] };
    }
    return { action: "skip", reason: item.category === "temporary" ? "temporary" : "not_reusable" };
  }
  const kind = item.kind ?? "faq";
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(kind) || kind === "tone") return { action: "skip", reason: "bad_kind" };
  if (item.content.length > MAX_LEARNED_CHARS) return { action: "skip", reason: "too_long" };
  if (/\d{9,}/.test(item.content.replace(/[\s-]/g, "")) || /@\w+\.\w+|https?:\/\/|\bwww\./i.test(item.content)) return { action: "skip", reason: "private" };
  if (statesTemporaryCondition(evidenceText)) return { action: "skip", reason: "temporary" };
  if (meta.confidence < MIN_CONFIDENCE) return { action: "skip", reason: "low_confidence" };
  if (meta.priceScope === "special") return { action: "skip", reason: "special_price" };

  const amounts = moneyAmounts(item.content);
  const measures = measurementsOf(item.content);
  // Every price and measurement must be the business's own words. Only the product's NAME may come from the conversation
  // ("25ft hose" named by the customer), so measurements inside the subject are the one allowed exception.
  const staffMoney = new Set(moneyAmounts(staffText));
  const staffMeasures = new Set(measurementsOf(staffText));
  const inSubject = new Set(measurementsOf(meta.subject ?? ""));
  if (amounts.some((a) => !staffMoney.has(a)) || measures.some((m) => !staffMeasures.has(m) && !inSubject.has(m))) return { action: "skip", reason: "unsupported_figure" };
  const fact = buildFact(item, meta, amounts, measures);
  const review = (reason: ReviewReason, conflicts: KnowledgeConflict[] = []): AutoDecision => ({ action: "review", reason, fact, conflicts });

  // 0. Was this (or this product's value) removed by a person recently?
  const removedVerdict = checkRemoved(fact, meta, input.removed ?? []);
  if (removedVerdict === "suppress") return { action: "skip", reason: "blocked" };
  if (removedVerdict === "review") return review("corrects_removed");

  // 1. Is the product identified, reliably?
  const needsSubject = kind === "product" || kind === "price" || amounts.length > 0 || measures.length > 0;
  if (needsSubject) {
    const subject = checkSubject(meta.subject, item.content, staffText, contextText);
    if (!subject.ok) return review("ambiguous_subject");
    if (subject.from === "context" && meta.confidence < CONTEXT_CONFIDENCE) return review("ambiguous_subject");
  }

  // 2. Whose terms are these?
  if (hasCustomerTerms(staffText)) return review("customer_terms");
  if (amounts.length > 0 && meta.priceScope !== "standard") return review("price_scope_unclear");
  if (kind === "policy" || hasRiskyPolicy(evidenceText)) return review("risky_policy");
  if (meta.confidence < AUTO_CONFIDENCE) return review("insufficient_evidence");

  // 3. What does the business already say about it?
  // Two different products never conflict; an entry with no recorded subject is compared by topic.
  const comparable = input.active.filter((e) => !(e.subject_key && fact.subjectKey && e.subject_key !== fact.subjectKey));
  const same = comparable.find((e) => e.fingerprint !== null && e.fingerprint === fact.fingerprint);
  if (same) return { action: "duplicate", ofId: same.id };

  if (fact.subjectKey && amounts.length === 1) {
    const sameProduct = comparable.filter((e) => e.subject_key === fact.subjectKey && e.price_amount !== null);
    if (sameProduct.some((e) => e.price_amount === amounts[0])) return { action: "duplicate", ofId: sameProduct.find((e) => e.price_amount === amounts[0])!.id };
    const differing = sameProduct.find((e) => e.price_amount !== amounts[0]);
    if (differing) return review("price_conflict", [conflictOf(differing, `Price differs: on file ${formatMoney(differing.price_amount!)}, now ${formatMoney(amounts[0])}`, "conflict")]);
  }

  const assessment = assessKnowledgeCandidate({ kind, title: fact.title, content: fact.content }, comparable.map((e) => ({ id: e.id, kind: e.kind, title: e.title, content: e.content })));
  if (assessment.duplicateOf) return { action: "duplicate", ofId: assessment.duplicateOf.id };
  const conflicts = assessment.conflicts;
  if (conflicts.length === 0) return { action: "save", fact };

  // A price is never changed automatically, correction or not.
  if (amounts.length > 0) return review(conflicts.some((c) => c.severity === "conflict") ? "price_conflict" : "overlaps_existing", conflicts);

  // An explicit correction of exactly one fact this system learned replaces it (the old one is archived, not edited).
  const target = conflicts.length === 1 ? input.active.find((e) => e.id === conflicts[0].id) : undefined;
  if (meta.correction && target) {
    return target.source === "auto" || target.source === "whatsapp"
      ? { action: "update", fact, replaceId: target.id, replaced: target }
      : review("changes_staff_entry", conflicts);
  }
  return review(conflicts.some((c) => c.severity === "conflict") ? "conflicts_existing" : "overlaps_existing", conflicts);
}

function conflictOf(e: ActiveFact, reason: string, severity: KnowledgeConflict["severity"]): KnowledgeConflict {
  return { id: e.id, title: e.title, content: e.content.slice(0, 300), severity, reason };
}

function buildFact(item: ClassifiedItem, meta: LearningMeta, amounts: number[], measures: string[]): AutoFact {
  const key = subjectKey(meta.subject);
  const fact: AutoFact = {
    kind: item.kind ?? "faq",
    title: clip(item.title || item.content, 120),
    content: item.content,
    subject: meta.subject,
    subjectKey: key,
    priceAmount: amounts.length === 1 ? amounts[0] : null,
    fingerprint: factFingerprint(item.content, key, amounts, measures),
    summary: "",
    confidence: meta.confidence,
  };
  fact.summary = summaryLine(fact);
  return fact;
}

// ── Staff-group wording ──────────────────────────────────────────────────────

export interface DigestInput {
  factCount: number;
  /** One short line per fact, oldest first. */
  lines: string[];
  pendingCount: number;
  /** The weekly summary of what is left below the threshold. */
  weekly?: boolean;
}

const DIGEST_LINES = 3;

/** The batched notification: short, deterministic, no model call. */
export function buildLearningDigest(input: DigestInput): string {
  const out = ["📚 *AI MEMORY UPDATED*", `${input.factCount} ${input.factCount === 1 ? "fact" : "facts"} learned${input.weekly ? " this week" : ""}`, ""];
  const shown = input.lines.slice(0, DIGEST_LINES);
  out.push(...shown.map((l) => `• ${clip(l, 70)}`));
  const more = input.factCount - shown.length;
  if (more > 0) out.push(`+${more} more`);
  if (input.pendingCount > 0) out.push("", `⏳ ${input.pendingCount} ${input.pendingCount === 1 ? "suggestion needs" : "suggestions need"} review (dashboard)`);
  out.push("", "!memory — View details", "!forget K-XXXXX — Remove a fact");
  return out.join("\n");
}

export interface MemoryListInput {
  recent: { code: string | null; summary: string; learnedAt: string | null; updated: boolean; /** "3 Nov, 14:05 · chat …0101" */ source?: string | null }[];
  pending: { code: string | null; text: string; reason: string | null }[];
  pendingTotal: number;
  /** Authorized senders may approve from WhatsApp with !confirm. */
  confirmViaWhatsapp: boolean;
}

export const MEMORY_RECENT_SHOWN = 8;
export const MEMORY_PENDING_SHOWN = 5;

/** `!memory`: recent learned facts and pending reviews, from stored data only. */
export function buildMemoryList(input: MemoryListInput): string {
  const out = ["📚 *AI MEMORY*"];
  if (input.recent.length === 0) out.push("", "Nothing learned automatically yet.");
  else {
    out.push("", "Recently learned:");
    for (const r of input.recent.slice(0, MEMORY_RECENT_SHOWN)) {
      out.push(`• ${r.code ?? "—"} ${clip(r.summary, 80)}${r.updated ? " (updated)" : ""}`);
      if (r.source) out.push(`   ↳ ${clip(r.source, 70)}`);
    }
  }
  if (input.pendingTotal > 0) {
    out.push("", `Needs review (${input.pendingTotal}):`);
    for (const p of input.pending.slice(0, MEMORY_PENDING_SHOWN)) {
      out.push(`• ${p.code ?? "—"} ${clip(p.text, 80)}${p.reason ? ` — ${clip(p.reason, 60)}` : ""}`);
    }
    if (input.pendingTotal > Math.min(input.pending.length, MEMORY_PENDING_SHOWN)) out.push(`+${input.pendingTotal - Math.min(input.pending.length, MEMORY_PENDING_SHOWN)} more in the dashboard`);
    out.push(input.confirmViaWhatsapp ? "!confirm K-XXXXX to approve · !discard K-XXXXX to reject" : "Approve or reject them in the dashboard (AI Agent → Review).");
  }
  out.push("", "!memory K-XXXXX — Where a fact came from", "!forget K-XXXXX — Remove a fact");
  return out.join("\n");
}

// ── Where a fact came from ───────────────────────────────────────────────────

/** A chat reference that identifies the conversation without printing a customer's number in a group. */
export function maskChat(chatId: string | null): string | null {
  if (!chatId) return null;
  const digits = chatId.split("@")[0].replace(/\D/g, "");
  return digits.length >= 4 ? `chat …${digits.slice(-4)}` : "chat";
}

/** "3 Nov, 14:05" in the business's time zone. */
export function formatSourceTime(iso: string | null, timeZone: string): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  }
}

export interface MemoryDetailInput {
  code: string;
  summary: string;
  /** "active" | "removed" | "replaced" | "draft" */
  state: string;
  learnedAt: string | null;
  chatId: string | null;
  messageAt: string | null;
  /** The business's own original message, read from the inbox just now; null = no longer available / not shown. */
  original: string | null;
  /** Whether the viewer may see the original message text. */
  mayShowOriginal: boolean;
  timeZone: string;
}

export const ORIGINAL_SHOWN_CHARS = 300;

/** `!memory K-XXXXX`: where one fact came from. The chat text lives in the inbox, never in the knowledge entry. */
export function buildMemoryDetail(input: MemoryDetailInput): string {
  const out = [`🔎 *${input.code}* ${clip(input.summary, 80)}`, `Status: ${input.state}`];
  const learned = formatSourceTime(input.learnedAt, input.timeZone);
  if (learned) out.push(`Learned: ${learned}`);
  const chat = maskChat(input.chatId);
  const sent = formatSourceTime(input.messageAt, input.timeZone);
  out.push(chat || sent ? `Source: ${[chat, sent ? `sent ${sent}` : null].filter(Boolean).join(" · ")}` : "Source: not recorded");
  if (!input.mayShowOriginal) out.push("Original message: only shown to people who can manage knowledge");
  else if (input.original) out.push(`Original message: “${clip(input.original.replace(/\s+/g, " ").trim(), ORIGINAL_SHOWN_CHARS)}”`);
  else out.push("Original message: no longer available in the inbox");
  out.push("", "The chat itself is not copied into the knowledge — it is read from the inbox when you ask.", `!forget ${input.code} — Remove this fact`);
  return out.join("\n");
}
