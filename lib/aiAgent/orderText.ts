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

// ── "Another bag", "2 more", "make that 3" ───────────────────────────────────

const COUNT_WORD = String.raw`\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten`;
const INCREMENT = new RegExp(
  String.raw`\b(?:(another|an extra|an additional|a further)|(${COUNT_WORD})\s+(?:more|extra|additional))\b\s*(?:x\s*)?(?:(?:${UNITS})\b)?(?:\s+of)?((?:(?!\b(?:and|plus|with|then|also|but|for|to|at|on|please|too)\b)[^,.;!?\n])*)`,
  "gi"
);
const SET_TO = new RegExp(String.raw`\bmake\s+(?:that|it|them)(?:\s+be)?\s+(${COUNT_WORD})\b`, "gi");
const FILLER = new Set(["one", "ones", "of", "as", "well", "thanks", "thank", "you"]);

const countOf = (word: string): number => {
  const w = word.toLowerCase();
  return w in QUANTITY_WORDS ? QUANTITY_WORDS[w].n : Number(w);
};

export interface QuantityAdjustment {
  /** "more": add `n` to the current quantity ("another bag", "2 more"). "set": the new quantity ("make that 3"). */
  kind: "more" | "set";
  n: number;
  /** The product words that followed ("of Bandit"), normalised. */
  tail: string[];
}

/** Every "another bag", "2 more bags of X" and "make that 3" in the customer's words, in order. */
export function quantityAdjustments(texts: string[]): QuantityAdjustment[] {
  const out: QuantityAdjustment[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(INCREMENT)) {
      const n = m[1] ? 1 : countOf(m[2]);
      if (!Number.isFinite(n) || n < 1) continue;
      out.push({ kind: "more", n, tail: normalizeText(m[3] ?? "").split(" ").filter((w) => w && !FILLER.has(w)) });
    }
    for (const m of text.matchAll(SET_TO)) {
      const n = countOf(m[1]);
      if (Number.isFinite(n) && n >= 1) out.push({ kind: "set", n, tail: [] });
    }
  }
  return out;
}

/**
 * Deterministic quantity changes the model's draft cannot be trusted with, because the number is not written in the
 * customer's words ("another bag" has no digit, so grounding would throw the model's "2" away). Applied after
 * grounding, to the lines the order already holds:
 *   - "another bag", "2 more bags", "one more": the current quantity plus that many, for the one line it clearly means
 *     (named, or the only line); nothing when the line has no numeric quantity or the target is unclear.
 *   - "another bag of Bandit" for a product the order does not hold yet: that line, quantity 1.
 *   - "make that 3": only on an order with a single line (otherwise the model's grounded reading stands).
 */
export function applyQuantityAdjustments(prior: OrderItem[], draft: OrderRequestDraft, turnTexts: string[]): OrderRequestDraft {
  const adjustments = quantityAdjustments(turnTexts);
  if (adjustments.length === 0) return draft;
  const items = draft.items.map((i) => ({ ...i }));
  const quantities = new Map(prior.map((i) => [productKey(i.product), i.quantity]));
  const touch = (line: OrderItem, quantity: number) => {
    const key = productKey(line.product);
    const at = items.findIndex((i) => productKey(i.product) === key);
    if (at >= 0) items[at] = { ...items[at], quantity: String(quantity) };
    else items.push({ ...line, quantity: String(quantity) });
    quantities.set(key, String(quantity));
  };
  for (const a of adjustments) {
    const named = a.tail.length > 0 ? prior.filter((i) => mentions(i, a.tail)) : [];
    const target = named.length === 1 ? named[0] : a.tail.length === 0 && prior.length === 1 ? prior[0] : null;
    if (target) {
      const current = quantities.get(productKey(target.product));
      if (a.kind === "set") touch(target, a.n);
      else if (current && /^\d+$/.test(current.trim())) touch(target, Number(current) + a.n);
      continue;
    }
    if (a.kind === "more" && a.tail.length > 0) {
      // Not on the order yet: the model's line for it, with the quantity the words give.
      const fresh = draft.items.filter((i) => !quantities.has(productKey(i.product)) && mentions(i, a.tail));
      if (fresh.length === 1 && !fresh[0].quantity) touch(fresh[0], a.n);
    }
  }
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

export function addDays(dateKey: string, days: number): { key: string; weekday: number; label: string } {
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

// ── Explicit dates ("30 Oct", "Oct 30th", "30/10", "2026-10-30") ─────────────

const MONTH_PATTERN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthIndex = (name: string) => MONTHS.findIndex((m) => name.toLowerCase().startsWith(m.toLowerCase()));
const keyOf = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const realDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m, d, 12));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
};
const dayNumber = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const labelOf = (key: string) => addDays(key, 0).label;

/** The calendar day (YYYY-MM-DD) nearest to `anchor` that has this month and day; `weekday` (0-6) narrows the years. */
function nearestYear(anchorKey: string, month: number, day: number, weekday?: number): string | null {
  const anchorYear = Number(anchorKey.slice(0, 4));
  let best: { key: string; gap: number } | null = null;
  for (const y of [anchorYear - 1, anchorYear, anchorYear + 1]) {
    if (!realDate(y, month, day)) continue;
    const key = keyOf(y, month, day);
    if (weekday !== undefined && addDays(key, 0).weekday !== weekday) continue;
    const gap = Math.abs(dayNumber(key) - dayNumber(anchorKey));
    if (!best || gap < best.gap) best = { key, gap };
  }
  return best?.key ?? null;
}

/**
 * A date written out: "30 Oct", "30th October 2026", "Oct 30", "2026-10-30", "30/10/2026" (day first, as in St Lucia). With no year
 * it is the occurrence nearest to the day `at` falls on. Two different dates in one phrase, or an impossible one
 * ("31 Nov"), return null: the customer's words are kept and the order stays undated.
 */
export function resolveExplicitDay(phrase: string, at: Date, timezone: string): ResolvedDay | null {
  if (Number.isNaN(at.getTime())) return null;
  const anchor = localParts(at, timezone).dateKey;
  const found = new Set<string>();
  const add = (key: string | null) => key && found.add(key);
  const text = phrase.toLowerCase();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    add(realDate(y, mo, d) ? keyOf(y, mo, d) : null);
  }
  const withYear = (y: string | undefined) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : undefined);
  const pick = (d: number, mo: number, y: number | undefined) => {
    if (y !== undefined) return add(realDate(y, mo, d) ? keyOf(y, mo, d) : null);
    // No year: 29 Feb is real in some years, other impossible days ("31 Nov") in none.
    return add(realDate(2024, mo, d) ? nearestYear(anchor, mo, d) : null);
  };
  for (const m of text.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_PATTERN})\b(?:\s*,?\s*(\d{4}))?`, "g"))) pick(Number(m[1]), monthIndex(m[2]), withYear(m[3]));
  for (const m of text.matchAll(new RegExp(String.raw`\b(${MONTH_PATTERN})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s*,?\s*(\d{4}))?`, "g"))) pick(Number(m[2]), monthIndex(m[1]), withYear(m[3]));
  // Only a full 30/10/2026 (or 30/10/26): "1/2 a bag" and "2.5 bags" are quantities, not dates.
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) pick(Number(m[1]), Number(m[2]) - 1, withYear(m[3]));
  if (found.size !== 1) return null;
  const key = [...found][0];
  return { date: key, label: labelOf(key) };
}

/**
 * The day a phrase means: a relative day ("tomorrow", "Friday") or a written date. When both appear they must agree
 * ("Friday 30 Oct" is fine; "tomorrow, 30 Oct" said on the 27th is not), otherwise null.
 */
export function resolveRequestedDay(phrase: string, at: Date, timezone: string): ResolvedDay | null {
  const relative = resolveRelativeDay(phrase, at, timezone);
  const explicit = resolveExplicitDay(phrase, at, timezone);
  if (relative && explicit) return relative.date === explicit.date ? relative : null;
  return relative ?? explicit;
}

/**
 * The calendar day an order is for (YYYY-MM-DD in the business's timezone), or null when it has none or it cannot be
 * read safely. Works on what is stored in `requested_for`: the resolved form "Fri 30 Oct (tomorrow)" (its weekday picks
 * the year), or the customer's own words, counted from `anchorIso` (when the order was first written).
 */
export function requestedDate(requestedFor: string | null | undefined, anchorIso: string, timezone: string): string | null {
  const text = (requestedFor ?? "").trim();
  if (!text) return null;
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) return null;
  const label = text.match(stored)?.[1] ?? text.match(/^(\w{3} \d{1,2} \w{3})$/)?.[1];
  if (label) {
    const [wd, day, mon] = label.split(" ");
    const weekday = WEEKDAYS.findIndex((w) => w.toLowerCase() === wd.toLowerCase());
    const month = MONTHS.findIndex((m) => m.toLowerCase() === mon.toLowerCase());
    if (weekday >= 0 && month >= 0) return nearestYear(localParts(anchor, timezone).dateKey, month, Number(day), weekday);
  }
  return resolveRequestedDay(text, anchor, timezone)?.date ?? null;
}

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
  const day = resolveRequestedDay(text, at, timezone);
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
