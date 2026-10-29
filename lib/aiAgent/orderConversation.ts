// Continuous order understanding — pure rules, no I/O, no model call (unit-tested in tests/aiAgentConversationOrders.test.ts).
//
// A customer and the business talk in turns, and an order is usually completed by those turns rather than by one message:
//
//   Staff:    "Which bag did you want, Bandit 25kg?"      a QUESTION (it names a candidate product)
//   Customer: "Yes, that one."                            its ANSWER  -> the order's product is Bandit 25kg
//   Staff:    "Where should we deliver?"                  a QUESTION
//   Customer: "Cap Estate"                                its ANSWER  -> the order's delivery address
//   Staff:    "How many bags?" / Customer: "two"          -> quantity 2
//
// This module reads those pairs from the conversation lines the server already loads. What it will never do:
//
//   * take an UNANSWERED staff suggestion as the customer's choice: a product counts only when the customer's own words
//     (or an explicit yes to a staff question that names exactly one product) say so;
//   * pick between several candidates: two named products and a bare "yes" is ambiguous, nothing is chosen;
//   * invent a product, quantity, address or day: every value returned is a candidate staff named or words the customer wrote;
//   * look at who the customer is, or at any other business: the caller passes the conversation and the customer's own history.
//
// The server (lib/server/aiAgent/orders.ts) decides whether an answer may be written: locks, versions and idempotency live there.

import { isTrivialMessage, normalizeText } from "./escalationUpdates.ts";
import { lineStats, type HistoryOrder } from "./orderHistory.ts";
import { pointsAtPicture } from "./orderImages.ts";
import type { OrderLine } from "./orders.ts";
import { quantityPhrases } from "./orderText.ts";
import { type ConversationLine, isAffirmation, isRejection, OFFER_WINDOW_HOURS } from "./staffDelivery.ts";

const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);
const tokens = (text: string): string[] => normalizeText(text).split(" ").filter((w) => w.length >= 2 || /\d/.test(w)).map(stem);
const lineTokens = (l: Pick<OrderLine, "product" | "variant" | "size">) => tokens(`${l.product} ${l.variant ?? ""} ${l.size ?? ""}`);
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── What staff asked ─────────────────────────────────────────────────────────

export type StaffAsk =
  | { kind: "address" }
  | { kind: "quantity" }
  /** `candidates` are the products the question itself names (possibly none: "which bag did you want?"). `open` = a "which one?" question, as against "do you want the X?". */
  | { kind: "product"; candidates: OrderLine[]; open: boolean };

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const QUESTIONISH =
  /\?|^(?:which|what|where|how many|how much|do you|did you|would you|could you|can you|will you|shall we|is it|is that|are you|please (?:let|tell|send|confirm|give|share))\b|\b(?:let me know|tell me|can i (?:get|have)|could i (?:get|have)|i need|we need|need (?:the|your)|send (?:me|us) (?:the|your))\b/i;

const ADDRESS_WHERE = /\bwhere\b/i;
const ADDRESS_WHERE_CONTEXT = /\b(?:deliver\w*|send|bring|drop|take|go|located|you|u|it|them|this|that|to|be|are you|is it)\b/i;
const ADDRESS_NOUN = /\b(?:delivery |your |the |what(?:'s| is)? )?(?:address|location)\b/i;
const ADDRESS_WHICH = /\bwhich (?:area|address|location|part|direction)\b|\bwhat area\b/i;
const QUANTITY_ASK = /\bhow many\b|\bhow much (?:do|did|would|will) you (?:want|need|like)\b|\bwhat (?:quantity|number|amount)\b|\bquantity\b/i;
const PRODUCT_OPEN = /\bwhich\b|\bwhat (?:size|kind|type|brand|flavou?r|food|product|bag)\b/i;
const PRODUCT_YESNO = /\b(?:do|did|would|will) you (?:want|like|mean|need)\b|\bis (?:it|that|this) the\b|\bthe (?:one|bag)\b|\bwant(?:ed)?\b|\bsame (?:one|bag)\b/i;

const STOP_START = new Set(["which", "what", "do", "did", "would", "could", "can", "you", "your", "the", "a", "an", "hi", "hello", "hey", "morning", "yes", "ok", "okay", "sorry", "so", "is", "it", "please", "just", "only", "and", "we", "i", "or", "want", "wanted", "like", "need", "one", "of", "to", "for", "got", "have", "had", "sure", "then", "thanks"]);
const SIZE_UNIT = String.raw`(?:kgs?|kilos?|lbs?|g|ml|l|litres?|liters?)`;
const NAMED = new RegExp(String.raw`((?:\p{Lu}[\p{L}'’-]*\s+){0,3}\p{Lu}[\p{L}'’-]*)\s+(\d+(?:\.\d+)?)\s?(${SIZE_UNIT})\b`, "u");

/** "Bandit 25kg" when staff typed a capitalised name directly before a weight. Nothing is inferred from lower-case words. */
function namedProduct(text: string): OrderLine | null {
  const m = NAMED.exec(text);
  if (!m) return null;
  const words = m[1].split(/\s+/);
  while (words.length > 0 && STOP_START.has(words[0].toLowerCase())) words.shift();
  if (words.length === 0) return null;
  return { product: words.join(" "), quantity: null, variant: null, size: `${m[2]}${m[3].toLowerCase().replace(/^kilos?$|^kgs$/, "kg")}` };
}

const lineKey = (l: OrderLine) => [normalizeText(l.product), normalizeText(l.variant ?? ""), normalizeText(l.size ?? "")].join("|");

/** The products one staff sentence names: lines the customer is known to buy or sell, else a capitalised name beside a weight. */
export function candidatesIn(text: string, known: OrderLine[]): OrderLine[] {
  const have = new Set(tokens(text));
  let hits = known.filter((l) => {
    const w = lineTokens(l);
    return w.length > 0 && w.every((x) => have.has(x));
  });
  const named = namedProduct(text);
  if (named) {
    const namedTokens = lineTokens(named);
    hits = hits.filter((h) => !lineTokens(h).every((x) => namedTokens.includes(x)));
    if (!hits.some((h) => namedTokens.every((x) => lineTokens(h).includes(x)))) hits.push(named);
  }
  // A hit whose words are all inside a more specific hit is the same product named less precisely.
  const specific = hits.filter((h, i) => !hits.some((o, j) => j !== i && lineTokens(o).length > lineTokens(h).length && lineTokens(h).every((x) => lineTokens(o).includes(x))));
  const seen = new Set<string>();
  return specific.filter((l) => (seen.has(lineKey(l)) ? false : (seen.add(lineKey(l)), true)));
}

/** Every question one staff message asks that a customer's short reply could answer. */
export function readStaffAsks(text: string, known: OrderLine[] = []): StaffAsk[] {
  const out: StaffAsk[] = [];
  for (const s of sentences(text)) {
    if (!QUESTIONISH.test(s)) continue;
    if ((ADDRESS_WHERE.test(s) && ADDRESS_WHERE_CONTEXT.test(s)) || ADDRESS_NOUN.test(s) || ADDRESS_WHICH.test(s)) {
      if (!out.some((a) => a.kind === "address")) out.push({ kind: "address" });
      continue;
    }
    if (QUANTITY_ASK.test(s)) {
      if (!out.some((a) => a.kind === "quantity")) out.push({ kind: "quantity" });
      continue;
    }
    const candidates = candidatesIn(s, known);
    if (candidates.length > 0 || PRODUCT_OPEN.test(s) || PRODUCT_YESNO.test(s)) {
      const prior = out.find((a): a is Extract<StaffAsk, { kind: "product" }> => a.kind === "product");
      if (prior) {
        prior.candidates = candidatesIn(`${prior.candidates.map((c) => c.product).join(" ")} ${s}`, [...known, ...prior.candidates, ...candidates]);
        prior.open = prior.open || PRODUCT_OPEN.test(s);
      } else out.push({ kind: "product", candidates, open: PRODUCT_OPEN.test(s) });
    }
  }
  return out;
}

// ── What the customer answered ───────────────────────────────────────────────

export interface AnswerSource {
  text: string;
  at: string;
  id: string | null;
}

export type ConversationAnswer =
  | { kind: "product"; line: OrderLine; how: "confirmed" | "named"; open: boolean; staff: AnswerSource; customerText: string }
  | { kind: "quantity"; quantity: string; staff: AnswerSource; customerText: string }
  | { kind: "address"; address: string; staff: AnswerSource; customerText: string };

export type AnswerReading =
  | { status: "answer"; answer: ConversationAnswer }
  /** The customer replied to a staff question but the reply does not pick one answer (two products and a bare yes). Nothing is written. */
  | { status: "ambiguous"; kind: StaffAsk["kind"]; reason: string; staff: AnswerSource };

const STRONG_YES = /\b(?:yes|yeah|yep|yup|correct|exactly)\b|^(?:that|this)(?:'s| is)? (?:it|the one|right|correct)\b|\b(?:that|this|the same) one\b|\bthats? (?:it|the one|right)\b/i;
const WEAK_YES = new Set(["sure", "ok", "okay", "alright", "all right", "fine", "good", "sounds good", "that works", "works for me", "perfect", "great", "sure thing", "of course"]);

/** "Yes, that one." — a clear yes. A weak ack ("ok", "sure", 👍) only counts as one when a yes/no question named a single product. */
export function isProductAffirmation(text: string, strict: boolean): boolean {
  const t = text.trim();
  // A number in it is an answer of its own ("yes, 2 of those"): the quantity must not be swallowed by a product yes.
  if (!t || /\?/.test(t) || /\d/.test(t) || isRejection(t) || t.split(/\s+/).length > 8) return false;
  if (STRONG_YES.test(t)) return true;
  if (strict) return false;
  if (/^(?:👍|👌|✅)+$/u.test(t.replace(/\s+/g, ""))) return true;
  return isAffirmation(t) || WEAK_YES.has(normalizeText(t));
}

const NUMBER_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT = "bags?|sacks?|boxe?s?|cartons?|cases?|packs?|packets?|tins?|cans?|tubs?|units?|pieces?|pcs|x";
const BARE_QUANTITY = new RegExp(String.raw`^(?:just |only |i(?:'ll| will)? (?:take|need|want|have) |make it |let'?s say |we(?:'ll| will)? (?:take|need|want) )?(\d{1,3}|${Object.keys(NUMBER_WORD).join("|")})(?:\s*(?:${UNIT}))?(?: please| thanks| thank you)?$`, "i");

/** "two", "2 bags", "just one": a quantity and nothing else. */
export function readBareQuantity(text: string): string | null {
  const t = text.trim().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const m = BARE_QUANTITY.exec(t);
  if (!m) return null;
  const n = NUMBER_WORD[m[1].toLowerCase()] ?? Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? String(n) : null;
}

const ADDRESS_LEAD = /^(?:(?:it(?:'s| is)|its|to|at|in|near|deliver(?:y)? (?:it )?to|send (?:it )?to|bring (?:it )?to|please|the address is|address(?: is)?:?|location(?: is)?:?|we(?:'re| are) at|i(?:'m| am) at|im at|my address is|it should go to)\s+)+/i;
const NOT_AN_ADDRESS = /^(?:no|nope|nah|never ?mind|cancel|thanks|thank you|hi|hello|hey|ok|okay|sure|yes|yeah|wait|actually|sorry|maybe|idk|i don'?t know)\b/i;
const DAY_ONLY = /^(?:today|tomorrow|tonight|this (?:morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
const REQUESTISH = /\b(?:want|wanted|need|needs|like|order|buy|get|take|send|bring|deliver|delivery|add|also|another|more|instead|cancel|change|actually|can you|could you|do you|have you|how much|price|thanks|thank|please|sorry|bag|bags|kg)\b/i;
const COLLECTION_WORDS = /\b(?:collect\w*|pick ?-?up|come (?:and )?(?:get|collect))\b/i;

/** The customer's own place words, when the whole reply is one short place and nothing else; otherwise null. */
export function readAddressAnswer(segments: string[], known: OrderLine[] = []): string | null {
  const real = segments.map((s) => s.trim()).filter(Boolean);
  if (real.length === 0 || real.length > 3) return null;
  const joined = real.join(", ").replace(/\s+/g, " ");
  if (joined.length > 120 || joined.split(/\s+/).length > 10 || /\?/.test(joined)) return null;
  if (isTrivialMessage(joined) || isAffirmation(joined) || NOT_AN_ADDRESS.test(joined) || DAY_ONLY.test(joined) || COLLECTION_WORDS.test(joined)) return null;
  if (/^[\d\s+()-]{6,}$/.test(joined)) return null;
  if (quantityPhrases([joined]).length > 0 || new RegExp(String.raw`\d\s?${SIZE_UNIT}\b`, "i").test(joined)) return null;
  const jt = tokens(joined);
  if (known.some((l) => lineTokens(l).length > 0 && lineTokens(l).every((x) => jt.includes(x)))) return null;
  const value = joined.replace(ADDRESS_LEAD, "").replace(/(?:[,\s]+(?:please|pls|thanks|thank you))+[.!]*$/i, "").replace(/[.!]+$/, "").trim();
  // A request, a change of mind or a question is an order message in its own right, not a place.
  if (REQUESTISH.test(value)) return null;
  return /\p{L}/u.test(value) && value.length >= 3 ? value : null;
}

// ── Finding the question a reply answers ─────────────────────────────────────

interface FoundAsk {
  ask: StaffAsk;
  source: AnswerSource;
  /** True when the question was quoted by the customer: it is then the one answered, however long ago. */
  quoted: boolean;
}

/** The newest staff question(s) a reply at `at` can be answering: the quoted staff message, else the staff messages directly before it. */
function findAsks(args: { at: string; recent: ConversationLine[]; quotedId?: string | null; known: OrderLine[] }): FoundAsk[] {
  const turnAt = Date.parse(args.at);
  const earlier = args.recent.filter((m) => m.text.trim() && (Number.isNaN(turnAt) || Date.parse(m.at) <= turnAt));
  const within = (m: ConversationLine, hours: number) => Number.isNaN(turnAt) || turnAt - Date.parse(m.at) <= hours * 3_600_000;
  const asksOf = (m: ConversationLine, quoted: boolean): FoundAsk[] =>
    readStaffAsks(m.text, args.known).map((ask) => ({ ask, quoted, source: { text: clip(m.text), at: m.at, id: m.id ?? null } }));
  const quoted = args.quotedId ? earlier.find((m) => m.id === args.quotedId) : undefined;
  if (quoted) return quoted.who === "Staff" && within(quoted, 72) ? asksOf(quoted, true) : [];
  // Without a quote the reply must directly follow staff: anything the customer said in between breaks the link.
  const run: ConversationLine[] = [];
  for (let i = earlier.length - 1; i >= 0 && earlier[i].who === "Staff"; i -= 1) run.push(earlier[i]);
  return run.filter((m) => within(m, OFFER_WINDOW_HOURS)).flatMap((m) => asksOf(m, false));
}

export interface ResolveArgs {
  /** The customer's new messages of this turn, verbatim. */
  segments: string[];
  at: string;
  /** Earlier lines of the chat, oldest first, EXCLUDING this turn. */
  recent: ConversationLine[];
  quotedId?: string | null;
  /** Products the customer is known to buy (their verified history, the open orders): used to recognise a product staff named. */
  known: OrderLine[];
}

/**
 * Does this customer turn answer a staff question? Returns the answer, or "ambiguous" when it replied but did not choose, or null
 * when it answers nothing (the normal order reading then applies). Short replies only: a long message is a request in its own right
 * and goes through the usual order reading.
 */
export function resolveConversationAnswer(args: ResolveArgs): AnswerReading | null {
  const real = args.segments.map((s) => s.trim()).filter(Boolean);
  if (real.length === 0) return null;
  const text = real.join(" ");
  if (text.length > 160 || (isRejection(text) && !isAffirmation(text))) return null;
  const asks = findAsks({ at: args.at, recent: args.recent, quotedId: args.quotedId, known: args.known });
  if (asks.length === 0) return null;
  const customerText = clip(text, 200);

  for (const found of asks) {
    const { ask, source } = found;
    if (ask.kind === "product") {
      const yes = real.length === 1 && isProductAffirmation(real[0], !(ask.candidates.length === 1 && /\?/.test(source.text)));
      if (ask.candidates.length > 0 && yes) {
        if (ask.candidates.length > 1) return { status: "ambiguous", kind: "product", reason: `several products were offered (${ask.candidates.map((c) => c.product + (c.size ? ` ${c.size}` : "")).join(", ")}) and the reply did not choose`, staff: source };
        return { status: "answer", answer: { kind: "product", line: { ...ask.candidates[0], quantity: null }, how: "confirmed", open: ask.open, staff: source, customerText } };
      }
      if (ask.candidates.length > 1) {
        // "The 25kg one": the words that tell the offered products apart, said by the customer.
        const said = new Set(tokens(text));
        const shared = (c: OrderLine) => lineTokens(c).filter((x) => ask.candidates.every((o) => lineTokens(o).includes(x)));
        const picked = ask.candidates.filter((c) => lineTokens(c).filter((x) => !shared(c).includes(x)).some((x) => said.has(x)));
        if (picked.length === 1) return { status: "answer", answer: { kind: "product", line: { ...picked[0], quantity: null }, how: "named", open: ask.open, staff: source, customerText } };
        if (real.length === 1 && text.split(/\s+/).length <= 6) return { status: "ambiguous", kind: "product", reason: "the reply does not say which of the offered products", staff: source };
      }
      continue;
    }
    if (ask.kind === "quantity") {
      const quantity = real.length === 1 ? readBareQuantity(real[0]) : null;
      if (quantity) return { status: "answer", answer: { kind: "quantity", quantity, staff: source, customerText } };
      continue;
    }
    const address = readAddressAnswer(real, args.known);
    if (address) return { status: "answer", answer: { kind: "address", address, staff: source, customerText } };
  }
  return null;
}

export interface ConfirmedProduct {
  line: OrderLine;
  at: string;
  staff: AnswerSource;
  customerText: string;
}

/**
 * The product the customer most recently confirmed in this conversation: a staff question that named it and the customer's
 * explicit answer. A staff suggestion nobody answered, or an ambiguous reply, is never a confirmation.
 */
export function latestConfirmedProduct(recent: ConversationLine[], known: OrderLine[]): ConfirmedProduct | null {
  const lines = [...recent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let latest: ConfirmedProduct | null = null;
  for (const [i, m] of lines.entries()) {
    if (m.who !== "Customer" || !m.text.trim()) continue;
    const reading = resolveConversationAnswer({ segments: [m.text], at: m.at, recent: lines.slice(0, i), quotedId: m.quotedId, known });
    if (reading?.status === "answer" && reading.answer.kind === "product") latest = { line: reading.answer.line, at: m.at, staff: reading.answer.staff, customerText: reading.answer.customerText };
  }
  return latest;
}

// ── "Send me one bag": a request that names no product ───────────────────────

const GENERIC = new Set(["bag", "sack", "one", "unit", "item", "thing", "product", "food", "stuff", "pack", "packet", "box", "carton", "case", "tin", "can", "kind", "type", "regular", "normal", "the", "a", "an", "some", "of", "more", "another", "other"]);

/** "bag", "one bag", "a sack": only a container or a count, no product. ("this one" under a photo is the picture reader's, not ours.) */
export function isGenericProduct(line: Pick<OrderLine, "product" | "variant" | "size">): boolean {
  if (line.variant || line.size || pointsAtPicture(line.product)) return false;
  const w = tokens(line.product);
  return w.length > 0 && w.every((x) => GENERIC.has(x));
}

/** Why a product was chosen for the customer, kept on the order's history so staff can see it. */
export type ProductSource =
  | { source: "open_order"; product: string }
  | { source: "conversation_confirmed"; product: string; staffMessage: string; staffAt: string; staffMessageId: string | null; customerText: string }
  | { source: "staff_saved"; product: string }
  | { source: "order_history"; product: string; ref: string };

export type GenericResolution = { kind: "keep" } | { kind: "resolved"; line: OrderLine; source: ProductSource } | { kind: "unresolved"; reason: string };

const productName = (l: Pick<OrderLine, "product" | "size">) => `${l.product}${l.size && !normalizeText(l.product).includes(normalizeText(l.size)) ? ` ${l.size}` : ""}`;

/**
 * Resolves a request that names no product. Order of trust: the one product already on this order; the product the customer
 * explicitly confirmed in this conversation; the usual product staff saved for the customer; the customer's only verified product. Several plausible products is never a choice:
 * it is unresolved and a person looks. Quotations, cancelled orders and unconfirmed drafts are not in `pool` (see isReliableOrder).
 */
export function resolveGenericProduct(args: { line: OrderLine; held: OrderLine[]; confirmed: ConfirmedProduct | null; pool: HistoryOrder[]; staffUsual?: OrderLine | null }): GenericResolution {
  const { line, held, confirmed, pool, staffUsual } = args;
  if (!isGenericProduct(line)) return { kind: "keep" };
  const keepQuantity = (l: OrderLine): OrderLine => ({ ...l, quantity: line.quantity });
  if (held.length === 1) return { kind: "resolved", line: keepQuantity(held[0]), source: { source: "open_order", product: productName(held[0]) } };
  if (held.length > 1) return { kind: "unresolved", reason: `items: “${line.product}” could be any of ${held.map(productName).join(", ")}` };
  if (confirmed) {
    return {
      kind: "resolved",
      line: keepQuantity(confirmed.line),
      source: { source: "conversation_confirmed", product: productName(confirmed.line), staffMessage: confirmed.staff.text, staffAt: confirmed.staff.at, staffMessageId: confirmed.staff.id, customerText: confirmed.customerText },
    };
  }
  // The product staff themselves confirmed as this customer's usual, ahead of any statistic from their past orders.
  if (staffUsual) return { kind: "resolved", line: keepQuantity(staffUsual), source: { source: "staff_saved", product: productName(staffUsual) } };
  const stats = lineStats(pool);
  if (stats.length === 0) return { kind: "unresolved", reason: `items: “${line.product}” names no product and there is no verified earlier order` };
  if (stats.length === 1) return { kind: "resolved", line: keepQuantity(stats[0].line), source: { source: "order_history", product: productName(stats[0].line), ref: stats[0].ref } };
  return { kind: "unresolved", reason: `items: “${line.product}” could be ${stats.slice(0, 4).map((s) => productName(s.line)).join(" or ")}` };
}

// ── What staff say they will do ──────────────────────────────────────────────

const HEDGE = /\b(?:(?:we|i) can|can check|check with|i'?ll check|maybe|perhaps|possibly|might|may be|could|should be able|try(?:ing)? to|hopefully|if (?:possible|we can|you|there'?s|that works|that'?s ok)|depending|tentative|not sure|can'?t promise|cannot promise|unlikely|probably|likely|i think|let me (?:check|see|find out|confirm)|will check|will let you know|to be confirmed|tbc|subject to|would you|do you want|would you like|want me to|shall we|should we|how about|what about|or would)\b/i;
const INTERROGATIVE = /^(?:can|could|would|will|shall|do|does|did|is|are|how about|what about|want|wanna|which|what|where|how|any)\b/i;

/**
 * A message in which the business says what IS or WILL BE done ("we'll send 2 bags of Bandit 25kg", "I've put you down for
 * collection"), as against a question, an offer, a suggestion or a hedge. Only a statement can change an order.
 */
export function staffStatesCommitment(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const parts = sentences(t);
  if (parts.some((s) => /\?/.test(s) || INTERROGATIVE.test(s.replace(/^[^\p{L}\p{N}]+/u, "")))) return false;
  return !HEDGE.test(t);
}

const SUBSTITUTION = /\b(?:instead|rather than|in place of|swap\w*|replac\w*|switch\w*|change[ds]?(?: it)? to|substitut\w*)\b/i;
export const staffSubstitutes = (text: string): boolean => SUBSTITUTION.test(text);

/** A bare quantity staff commit to ("we'll send 3 bags", "that's 2 bags"): exactly one plain phrase and nothing hedged. For the read-only review. */
export function readStaffQuantity(text: string): string | null {
  if (!staffStatesCommitment(text)) return null;
  const phrases = quantityPhrases([text]).filter((p) => !p.vague);
  return phrases.length === 1 && /\b(?:send|bring|deliver|put you down|that'?s|so|total|will be)\b/i.test(text) ? phrases[0].quantity : null;
}


// ── Writing an answer into an order's lines ──────────────────────────────────

const sameQuantity = (a: string | null | undefined, b: string | null | undefined) => normalizeText(a ?? "") === normalizeText(b ?? "");
const sameLineSet = (a: OrderLine[], b: OrderLine[]) => a.length === b.length && a.every((l, i) => lineKey(l) === lineKey(b[i]) && sameQuantity(l.quantity, b[i].quantity));

/** One product line names the other (every word of one is in the other): "Bandit" and "Bandit 25kg" are the same product, the longer is the more exact. */
export function sameProductLoose(a: OrderLine, b: OrderLine): boolean {
  const ta = lineTokens(a);
  const tb = lineTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta.every((x) => tb.includes(x)) || tb.every((x) => ta.includes(x));
}

const moreExact = (a: OrderLine, b: OrderLine): OrderLine => (lineTokens(b).length > lineTokens(a).length ? b : a);

export type ItemsPatch =
  | { kind: "patch"; items: OrderLine[] }
  /** The order already says this. */
  | { kind: "same" }
  /** The order holds a different specific product: the answer is recorded for a person, never written over it. */
  | { kind: "conflict"; proposed: OrderLine[] }
  | { kind: "unclear"; reason: string };

/** A product line with no size and no variant: the customer's category word ("dog food", "Monello") rather than one exact bag. */
export const isUnspecificLine = (l: Pick<OrderLine, "variant" | "size">): boolean => !l.size && !l.variant;

/**
 * The order's lines after the customer confirmed `answer` as the product. Fills an empty order or a generic line, completes a product's
 * size, and refines an unspecific line ("dog food") when staff asked WHICH one (`open`). It never replaces a different specific product,
 * and a yes/no question never replaces a different product at all: that becomes a conflict for a person.
 */
export function patchWithProduct(items: OrderLine[], answer: OrderLine, open = false): ItemsPatch {
  const fresh = { ...answer, quantity: null };
  if (items.length === 0) return { kind: "patch", items: [fresh] };
  const complete = (cur: OrderLine): ItemsPatch => {
    const best = moreExact(cur, fresh);
    const merged: OrderLine = { product: best.product, quantity: cur.quantity, variant: best.variant ?? cur.variant ?? fresh.variant, size: best.size ?? cur.size ?? fresh.size };
    const next = items.map((i) => (i === cur ? merged : i));
    return sameLineSet(next, items) ? { kind: "same" } : { kind: "patch", items: next };
  };
  const hit = items.find((i) => sameProductLoose(i, fresh));
  if (hit) return complete(hit);
  const refinable = items.filter((i) => isGenericProduct(i) || (open && isUnspecificLine(i)));
  if (refinable.length === 1) return { kind: "patch", items: items.map((i) => (i === refinable[0] ? { ...fresh, quantity: i.quantity } : i)) };
  if (items.length === 1) return { kind: "conflict", proposed: [{ ...fresh, quantity: items[0].quantity }] };
  return { kind: "unclear", reason: "the order has several products and none of them is the one confirmed" };
}

/** The order's lines after the customer answered how many. The one line that has no quantity yet, else the order's only line. */
export function patchWithQuantity(items: OrderLine[], quantity: string): ItemsPatch {
  const missing = items.filter((i) => !i.quantity);
  const target = missing.length === 1 ? missing[0] : items.length === 1 ? items[0] : null;
  if (!target) return { kind: "unclear", reason: items.length === 0 ? "the order has no product to give a quantity to" : "the order has several products and the answer does not say which" };
  if (sameQuantity(target.quantity, quantity)) return { kind: "same" };
  return { kind: "patch", items: items.map((i) => (i === target ? { ...i, quantity } : i)) };
}

/**
 * The order's lines after staff stated products or quantities. A stated line updates the line it names (a generic "2 bags" updates the
 * order's only line); a different product replaces the only line when staff say so ("instead"), otherwise it is added. Null = no change.
 */
export function mergeStaffItems(current: OrderLine[], stated: OrderLine[], substitution: boolean): OrderLine[] | null {
  let out = current.map((l) => ({ ...l }));
  for (const s of stated) {
    const idx = out.findIndex((r) => sameProductLoose(r, s));
    if (idx >= 0) {
      const best = moreExact(out[idx], s);
      out[idx] = { product: best.product, quantity: s.quantity ?? out[idx].quantity, variant: best.variant ?? out[idx].variant ?? s.variant, size: best.size ?? out[idx].size ?? s.size };
    } else if (isGenericProduct(s) && out.length === 1) {
      out[0] = { ...out[0], quantity: s.quantity ?? out[0].quantity };
    } else if (substitution && out.length === 1) {
      out = [{ ...s, quantity: s.quantity ?? out[0].quantity }];
    } else if (!isGenericProduct(s)) {
      out.push({ ...s });
    }
  }
  return sameLineSet(out, current) ? null : out;
}

/** Only a short reply can answer a staff question; a long message is a request in its own right. */
export const mayAnswerQuestion = (segments: string[]): boolean => segments.join(" ").trim().length <= 160;
