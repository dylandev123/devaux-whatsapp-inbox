// Natural-language order phrases — pure functions, no I/O, unit-tested in tests/aiAgentOrderLanguage.test.ts.
//
// The language model still does the main reading of a customer's message. These rules are the deterministic safety
// net around it: they fill a quantity or a delivery/collection choice the customer plainly stated, resolve "tomorrow"
// against the time the customer WROTE it (never against the time a later job happens to run), and stop a model
// reply from silently dropping a product the customer never withdrew.
//
// Nothing here invents anything: a quantity, a method or a date is produced only from words the customer wrote, and
// anything ambiguous is left unset for a person to resolve.

import type { OrderItem, OrderRequestDraft } from "./engine.ts";
import { normalizeText, productKey } from "./escalationUpdates.ts";
import { type EditableOrderField, fulfilmentMethod, localParts, type OrderLine } from "./orders.ts";

// ── Quantities ───────────────────────────────────────────────────────────────

const QUANTITY_WORDS: Record<string, { n: number; vague?: boolean }> = {
  a: { n: 1 }, an: { n: 1 }, one: { n: 1 }, single: { n: 1 },
  two: { n: 2 }, three: { n: 3 }, four: { n: 4 }, five: { n: 5 }, six: { n: 6 }, seven: { n: 7 }, eight: { n: 8 }, nine: { n: 9 }, ten: { n: 10 },
  // "a couple of bags" is two, but only a person's reading of the whole order can say which product it belongs to.
  couple: { n: 2, vague: true },
};

const UNITS = "bags?|sacks?|boxe?s?|cartons?|cases?|packs?|packets?|tins?|cans?|tubs?|units?|pieces?|pcs";
const SIZE = String.raw`(?:\d+(?:\.\d+)?\s?(?:kgs?|kilos?|lbs?|g)\s+)`;
const PHRASE = new RegExp(
  String.raw`\b(a couple of|couple of|an?|one|single|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})\s+(?:x\s*)?${SIZE}?(?:${UNITS})\b(?:\s+of)?((?:(?!\b(?:and|plus|with|then|also|but|for|to|at|on|please)\b)[^,.;!?\n])*)`,
  "gi"
);

export interface QuantityPhrase {
  quantity: string;
  /** "a couple of": the number is an interpretation, so it is only used when it clearly belongs to one product. */
  vague: boolean;
  /** The product words that followed ("of Monello"), as normalised words. */
  tail: string[];
}

/** Every "<quantity> <unit> [of <product>]" in the customer's words. */
export function quantityPhrases(texts: string[]): QuantityPhrase[] {
  const out: QuantityPhrase[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(PHRASE)) {
      const head = m[1].toLowerCase().replace(/^a couple of$|^couple of$/, "couple");
      const word = QUANTITY_WORDS[head];
      const n = word ? word.n : Number(head);
      if (!Number.isFinite(n) || n < 1) continue;
      const tail = normalizeText(m[2] ?? "").split(" ").filter(Boolean);
      out.push({ quantity: String(n), vague: Boolean(word?.vague), tail });
    }
  }
  return out;
}

const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);

function mentions(item: OrderItem, tail: string[]): boolean {
  if (tail.length === 0) return false;
  const words = new Set(normalizeText(`${item.product} ${item.variant ?? ""}`).split(" ").map(stem));
  return tail.some((w) => words.has(stem(w)));
}

/**
 * Fills a missing quantity from a plain phrase ("a bag of Monello" → 1, "two bags" → 2, "a couple of bags" → 2).
 * Only for items with no quantity; only when exactly one phrase fits; "a couple of" only when the order has a single
 * product (or the phrase names the product). Nothing is guessed: with two products and a bare "two bags", both stay
 * unset.
 */
export function fillStatedQuantities(draft: OrderRequestDraft, customerTexts: string[]): OrderRequestDraft {
  const phrases = quantityPhrases(customerTexts);
  if (phrases.length === 0 || draft.items.every((i) => i.quantity)) return draft;
  const open = draft.items.filter((i) => !i.quantity);
  const items = draft.items.map((item) => {
    if (item.quantity) return item;
    const named = phrases.filter((p) => mentions(item, p.tail));
    if (named.length === 1) return { ...item, quantity: named[0].quantity };
    if (named.length > 1) return item;
    // A phrase that names no product belongs to the order only when the order has one open line and one phrase.
    const anonymous = phrases.filter((p) => !draft.items.some((i) => mentions(i, p.tail)));
    if (open.length === 1 && draft.items.length === 1 && anonymous.length === 1) return { ...item, quantity: anonymous[0].quantity };
    return item;
  });
  return { ...draft, items };
}

// ── Delivery or collection ───────────────────────────────────────────────────

const DELIVERY =
  /\b(deliver(?:y|ed|ing|s)?|drop(?:\s+(?:it|them|that|these))?\s+(?:off|by|at|to|over)|bring(?:\s+(?:it|them|that|these))?\s+(?:to|over|by|round|around|up|down)|send(?:\s+(?:it|them|that|these))?\s+(?:to|over))\b/gi;
const COLLECTION =
  /\b(collect(?:ion|ing|ed|s)?|pick(?:ing)?[\s-]?(?:it|them|that|these)?[\s-]?up|pickup|come\s+(?:and\s+)?(?:get|collect|pick)|swing\s+by|grab\s+(?:it|them)\s+(?:myself|ourselves))\b/gi;
const NEGATED = /\b(no|not|don'?t|do not|won'?t|without|cancel(?:led)?|instead of|rather than|skip|forget)\s+(?:\w+\s+){0,2}$/i;
/** Questions about whether the business delivers, or what it costs: not a request to deliver. */
const DELIVERY_ENQUIRY = /\b(do you|does (?:the|your)|are you)\s+(?:\w+\s+){0,2}(?:deliver\w*|offer delivery)|\bdelivery\s+(?:fee|charge|cost|price|rate|available|areas?|options?)|\bhow much\b.*\bdeliver/i;

function lastMatch(text: string, pattern: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (!NEGATED.test(before)) last = m.index;
  }
  return last;
}

/**
 * The method the customer asked for in their own words, or null. The latest statement wins ("deliver it … actually
 * I'll collect" is collection); a negated mention ("don't deliver", "cancel the delivery") and a plain enquiry
 * ("do you deliver?") never count.
 */
export function detectFulfilment(customerTexts: string[]): "delivery" | "collection" | null {
  let found: "delivery" | "collection" | null = null;
  for (const text of customerTexts) {
    const d = DELIVERY_ENQUIRY.test(text) ? -1 : lastMatch(text, DELIVERY);
    const c = lastMatch(text, COLLECTION);
    if (d < 0 && c < 0) continue;
    // "delivery or collection?" offers both: it is a question, not a choice.
    if (d >= 0 && c >= 0 && /\bor\b/i.test(text)) continue;
    found = c > d ? "collection" : "delivery";
  }
  return found;
}

/**
 * The deterministic pass over a model draft, after grounding: a plainly stated quantity is filled, and a plainly stated
 * delivery/collection choice is recorded (so the customer is never asked again what they already said). The choice
 * written in THIS turn wins over an older one; an older one is used only when it is the single method ever stated.
 */
export function refineOrderDraft(draft: OrderRequestDraft, turnTexts: string[], allTexts: string[]): OrderRequestDraft {
  if (draft.items.length === 0) return draft;
  let out = fillStatedQuantities(draft, allTexts);
  const fromTurn = detectFulfilment(turnTexts);
  const ever = new Set(allTexts.map((t) => detectFulfilment([t])).filter(Boolean));
  const method = fromTurn ?? (ever.size === 1 ? [...ever][0] : null);
  const current = fulfilmentMethod(out.delivery_preference);
  if (method && current !== method && (fromTurn || !current)) out = { ...out, delivery_preference: method };
  return out;
}

// ── Relative dates (America/St_Lucia, from the message's own timestamp) ──────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES: [RegExp, number][] = [
  [/\b(?:sun(?:day)?)\b/i, 0], [/\b(?:mon(?:day)?)\b/i, 1], [/\b(?:tue(?:s|sday)?)\b/i, 2], [/\b(?:wed(?:s|nesday)?)\b/i, 3],
  [/\b(?:thu(?:r|rs|rsday)?)\b/i, 4], [/\b(?:fri(?:day)?)\b/i, 5], [/\b(?:sat(?:urday)?)\b/i, 6],
];

function addDays(dateKey: string, days: number): { key: string; weekday: number; label: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
  return { key, weekday: t.getUTCDay(), label: `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}` };
}

export interface ResolvedDay {
  /** YYYY-MM-DD in the business's timezone. */
  date: string;
  /** "Tue 27 Oct". */
  label: string;
}

/**
 * "today", "tonight", "tomorrow", "day after tomorrow", "Friday", "this Friday" → a calendar day, counted from the
 * local date of `at` (when the customer WROTE it). Anything that could mean two days ("next Friday", "tomorrow or
 * Friday", a weekday said on that same weekday) returns null and is left as the customer's words.
 */
export function resolveRelativeDay(phrase: string, at: Date, timezone: string): ResolvedDay | null {
  const text = phrase.toLowerCase();
  if (Number.isNaN(at.getTime())) return null;
  const today = localParts(at, timezone);
  const hits: number[] = [];
  if (/\bday after tomorrow\b/.test(text)) hits.push(2);
  else if (/\b(?:tomorrow|tmrw|tmr)\b/.test(text)) hits.push(1);
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/.test(text)) hits.push(0);
  const [y, m, d] = today.dateKey.split("-").map(Number);
  const todayWeekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const named = DAY_NAMES.filter(([pattern]) => pattern.test(text));
  if (/\bnext\b/.test(text) && named.length > 0) return null;
  for (const [, weekday] of named) {
    if (weekday === todayWeekday) return null;
    hits.push((weekday - todayWeekday + 7) % 7);
  }
  if (hits.length !== 1) return null;
  const day = addDays(today.dateKey, hits[0]);
  return { date: day.key, label: day.label };
}

const stored = /^(\w{3} \d{1,2} \w{3}) \((.+)\)$/;

/** The same wish, whether stored as the customer's words ("tomorrow") or as the resolved form ("Tue 27 Oct (tomorrow)"). */
export function sameRequestedFor(existing: string | null | undefined, phrase: string | null | undefined): boolean {
  if (!existing || !phrase) return false;
  const original = existing.match(stored)?.[2] ?? existing;
  return normalizeText(original) === normalizeText(phrase) || normalizeText(existing) === normalizeText(phrase);
}

/**
 * The value stored in `requested_for`: "Tue 27 Oct (tomorrow morning)" when the phrase resolves, else the phrase as
 * written. A phrase already stored (the model repeating "tomorrow" in a later turn's cumulative draft) is kept as it
 * is, so a later message can never move an earlier date.
 */
export function anchorRequestedFor(phrase: string | null | undefined, existing: string | null | undefined, at: Date, timezone: string): string | null {
  const text = (phrase ?? "").trim();
  if (!text) return existing ?? null;
  if (sameRequestedFor(existing, text)) return existing ?? text;
  if (stored.test(text)) return text;
  const day = resolveRelativeDay(text, at, timezone);
  return day ? `${day.label} (${text})` : text;
}

/** When the customer wrote the message that holds `phrase` (the last one sharing a word with it), else `fallback`. */
export function messageTimeFor(phrase: string, segments: string[], times: string[] | undefined, fallback: string): Date {
  if (times && times.length === segments.length) {
    const words = normalizeText(phrase).split(" ").filter((w) => w.length > 2);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const text = normalizeText(segments[i]);
      const at = new Date(times[i]);
      if (!Number.isNaN(at.getTime()) && words.some((w) => text.includes(w))) return at;
    }
  }
  const at = new Date(fallback);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

// ── Items the customer withdrew ──────────────────────────────────────────────

const REMOVAL_CUE = /\b(just|only|no longer|instead|remove|removed|without|scrap|forget|drop|take (?:off|out)|delete|not the|don'?t (?:want|need)|never ?mind|cancel|change)\b/i;

export interface RemovalCheck<T extends { product: string }> {
  items: T[];
  /** Products the customer clearly withdrew (dropped from the order, listed in its history). */
  removed: T[];
  /** Products the model left out although the customer never withdrew them (restored). */
  restored: T[];
}

/**
 * The model returns the CUMULATIVE item list. A product missing from it is dropped only when the customer's words
 * withdraw something ("just the Monello bags", "no, only…", "instead", "remove"); otherwise it is restored, so a
 * model slip can never silently delete part of an order.
 */
export function guardRemovedItems<T extends { product: string }>(prior: T[], next: T[], customerTexts: string[]): RemovalCheck<T> {
  const nextKeys = new Set(next.map((i) => productKey(i.product)));
  const missing = prior.filter((i) => !nextKeys.has(productKey(i.product)));
  if (missing.length === 0) return { items: next, removed: [], restored: [] };
  if (customerTexts.some((t) => REMOVAL_CUE.test(t))) return { items: next, removed: missing, restored: [] };
  return { items: [...next, ...missing], removed: [], restored: missing };
}

// ── Did the customer say it now? (staff-locked fields) ───────────────────────

const NUMBER_NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const lineKey = (l: OrderLine) => [productKey(l.product), normalizeText(l.quantity ?? ""), normalizeText(l.variant ?? ""), normalizeText(l.size ?? "")].join("|");

/**
 * Whether the customer wrote `proposed` for `field` in THIS turn. The model's draft is cumulative, so after a staff edit it
 * also repeats what the customer said before the edit; only words from the current turn count as the customer
 * contradicting a locked value. Words only, nothing inferred: a product line counts when its product (and its quantity,
 * as a digit or a number word) appears in the turn.
 */
export function statedThisTurn(field: EditableOrderField, proposed: unknown, turnTexts: string[], baseItems: OrderLine[] = []): boolean {
  const words = new Set(normalizeText(turnTexts.join(" ")).split(" ").filter(Boolean).map(stem));
  const has = (text: string) => {
    const wanted = normalizeText(text).split(" ").filter((w) => w.length > 2).map(stem);
    return wanted.length > 0 && wanted.every((w) => words.has(w));
  };
  if (field === "fulfilment_method") return detectFulfilment(turnTexts) === proposed;
  if (field === "items") {
    if (!Array.isArray(proposed)) return false;
    const known = new Set(baseItems.map(lineKey));
    return (proposed as OrderLine[]).some((l) => {
      if (known.has(lineKey(l))) return false;
      const product = normalizeText(`${l.product} ${l.variant ?? ""}`).split(" ").filter((w) => w.length > 2).map(stem);
      if (!product.some((w) => words.has(w))) return false;
      if (!l.quantity) return true;
      const q = normalizeText(l.quantity);
      return words.has(q) || (/^\d+$/.test(q) && NUMBER_NAMES[Number(q)] !== undefined && words.has(NUMBER_NAMES[Number(q)]));
    });
  }
  if (typeof proposed !== "string") return false;
  // "Fri 30 Oct (friday)": the customer's own words are the part in brackets.
  return has(proposed.match(stored)?.[2] ?? proposed);
}
