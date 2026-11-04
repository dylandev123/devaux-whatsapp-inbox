// What a customer's words say about each product line, who sent the order, and who it is for — pure, no I/O, unit-tested in
// tests/aiAgentOrderLines.test.ts.
//
// The language model still does the main reading. These rules are the deterministic safety net around it, for the mistakes
// a model makes with run-on order text ("Need 2 case acid 10 lbs cal hypo bill to anthony macnamara"):
//
//   * a number belongs only to the product (and packaging) it stands in front of. "10 lbs" is a package size, not a quantity,
//     and one product's count is never carried to the next product;
//   * a size with no count in front of it ("10 lbs cal hypo") is one sized item; no size and no count stays unknown (staff ask);
//   * "bill to <name>" is a billing instruction, a sign-off ("Thanks / Louise") is the sender's own name, and a name line followed
//     by a phone line is the person an order is being placed FOR.
//
// Nothing is invented: every value returned comes from the customer's own words.

import type { OrderItem, OrderRequestDraft } from "./engine.ts";
import { normalizeText } from "./escalationUpdates.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const PACK_UNITS = new Set(["bag", "bags", "sack", "sacks", "box", "boxes", "carton", "cartons", "case", "cases", "pack", "packs", "packet", "packets", "tin", "tins", "can", "cans", "tub", "tubs", "unit", "units", "piece", "pieces", "pcs", "bucket", "buckets", "drum", "drums", "bottle", "bottles", "pail", "pails", "pallet", "pallets", "roll", "rolls"]);
const SIZE_UNITS = new Set(["kg", "kgs", "kilo", "kilos", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "oz", "l", "ltr", "ltrs", "litre", "litres", "liter", "liters", "ml", "gal", "gals", "gallon", "gallons", "inch", "inches"]);
const SIZE_WORDS = new Set(["large", "small", "medium", "big", "mini", "jumbo", "xl", "xxl"]);

const TOKEN = /\d+(?:\.\d+)?|\p{L}+/gu;
const isNumber = (t: string) => /^\d+(?:\.\d+)?$/.test(t);
const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);

interface Tok {
  t: string;
  start: number;
  end: number;
}

function tokens(line: string): Tok[] {
  return [...line.matchAll(TOKEN)].map((m) => ({ t: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

// Anything a phone number, a price or a long number could be mistaken for a count.
const NOISE = /\+?\d[\d\s().-]{6,}\d|\$\s?\d[\d,.]*/g;

// ── Product lines ────────────────────────────────────────────────────────────

/** What the words around one product mention say. */
export interface LineReading {
  count: number | null;
  unit: string | null;
  size: string | null;
  /** "small", "large": a size word the customer used. */
  sizeWord: string | null;
  /** "(damaged)" written straight after the product. */
  qualifier: string | null;
  /** "Narural" in "1 small Birbo Chicken for Narural at St Remy": who that line is for, when it is not the place. */
  forWho: string | null;
}

interface Mention {
  itemIndex: number;
  /** Token index range [from, to) of the product words in the line. */
  from: number;
  to: number;
}

function findMentions(toks: Tok[], items: OrderItem[]): Mention[] {
  const out: Mention[] = [];
  const taken = new Set<string>();
  // Longer product names first, so "cal hypo" is never read as the "hypo" of something else.
  const order = items.map((_, i) => i).sort((a, b) => words(items[b].product).length - words(items[a].product).length);
  const seen = new Map<string, number>();
  for (const itemIndex of order) {
    const need = words(items[itemIndex].product).map(stem);
    if (need.length === 0) continue;
    // The k-th item with the same product is the k-th time it is written.
    const key = need.join(" ");
    const skip = seen.get(key) ?? 0;
    seen.set(key, skip + 1);
    let found = 0;
    for (let i = 0; i + need.length <= toks.length; i += 1) {
      if (!need.every((w, k) => stem(toks[i + k].t) === w)) continue;
      const span = `${i}-${i + need.length}`;
      if (taken.has(span) || overlaps(out, i, i + need.length)) continue;
      if (found === skip) {
        taken.add(span);
        out.push({ itemIndex, from: i, to: i + need.length });
        break;
      }
      found += 1;
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

const words = (product: string) => normalizeText(product).split(" ").filter(Boolean);
const overlaps = (list: Mention[], from: number, to: number) => list.some((m) => from < m.to && to > m.from);

/** Reads right-to-left from the product: [count] [size word] [pack unit] [of] [size], then, to the right, a size, "x2" and "(qualifier)". */
function readMention(line: string, toks: Tok[], m: Mention, floor: number, nextFrom: number): { reading: LineReading; used: Set<number> } {
  const used = new Set<number>();
  let count: number | null = null;
  let unit: string | null = null;
  let size: string | null = null;
  let sizeWord: string | null = null;
  const separated = (i: number) => /[,;:!?()\n]|\.\s/.test(line.slice(toks[i].end, toks[i + 1].start));

  let i = m.from - 1;
  // A punctuation mark between the words and the product ends the product's own words ("..., 2 bags.  Cal Hypo").
  if (i >= floor && separated(i)) i = floor - 1;
  while (i >= floor) {
    const t = toks[i].t;
    if (t === "of" || t === "x") {
      used.add(i);
      i -= 1;
    } else if (PACK_UNITS.has(t) && unit === null) {
      unit = t;
      used.add(i);
      i -= 1;
    } else if (SIZE_UNITS.has(t) && i - 1 >= floor && isNumber(toks[i - 1].t) && size === null) {
      size = line.slice(toks[i - 1].start, toks[i].end).replace(/\s+/g, " ");
      used.add(i);
      used.add(i - 1);
      i -= 2;
    } else if (SIZE_WORDS.has(t) && sizeWord === null) {
      sizeWord = t;
      used.add(i);
      i -= 1;
    } else break;
    if (i >= floor && i + 1 < toks.length && separated(i)) {
      i = floor - 1;
      break;
    }
  }
  if (i >= floor && (isNumber(toks[i].t) || toks[i].t in COUNT_WORDS)) {
    const n = isNumber(toks[i].t) ? Number(toks[i].t) : COUNT_WORDS[toks[i].t];
    if (Number.isInteger(n) && n >= 1 && n <= 999) {
      count = n;
      used.add(i);
    }
  }

  // To the right of the product: "25kg", "x2", "(damaged)", "for Narural at …".
  let j = m.to;
  const stopAt = nextFrom;
  // A size straight before the NEXT product ("acid 10 lbs cal hypo") is that product's, not this one's.
  const sizeBelongsToNext = j + 2 === stopAt && stopAt < toks.length;
  if (size === null && j + 1 < stopAt && j + 1 < toks.length && isNumber(toks[j].t) && SIZE_UNITS.has(toks[j + 1].t) && !separated(m.to - 1) && !sizeBelongsToNext) {
    size = line.slice(toks[j].start, toks[j + 1].end).replace(/\s+/g, " ");
    used.add(j);
    used.add(j + 1);
    j += 2;
  }
  if (count === null && j + 1 < stopAt && j + 1 < toks.length && toks[j].t === "x" && isNumber(toks[j + 1].t)) {
    count = Number(toks[j + 1].t);
    used.add(j + 1);
    j += 2;
  }
  const lastEnd = toks[Math.min(j, toks.length) - 1]?.end ?? toks[m.to - 1].end;
  const paren = line.slice(lastEnd).match(/^\s*\(([^()]{1,30})\)/);
  const qualifier = paren ? paren[1].trim() : null;
  const tail = line.slice(lastEnd).replace(/^\s*\([^()]*\)/, "");
  const who = tail.match(/^\s+for\s+(.{2,40}?)\s+(?:at|in)\s+\S/i);
  const forWho = who ? who[1].trim() : null;
  return { reading: { count, unit, size, sizeWord, qualifier, forWho }, used };
}

export interface LineAnalysis {
  /** One reading per item (by index), or null when its product is not written in the text. */
  readings: (LineReading | null)[];
  /** Digits that no product line accounts for (a stray number a sentence may still need). */
  loose: string[];
}

/** Reads every product line of ONE message. */
export function analyseLines(text: string, items: OrderItem[]): LineAnalysis {
  const readings: (LineReading | null)[] = items.map(() => null);
  const loose: string[] = [];
  const claimed = new Set<number>(); // item indexes already read in an earlier line
  for (const rawLine of text.split(/\r?\n+/)) {
    const line = rawLine.replace(NOISE, (m) => " ".repeat(m.length));
    const toks = tokens(line);
    if (toks.length === 0) continue;
    const remaining = items.map((it, i) => ({ it, i })).filter(({ i }) => !claimed.has(i));
    const mentions = findMentions(toks, remaining.map((r) => r.it)).map((m) => ({ ...m, itemIndex: remaining[m.itemIndex].i }));
    const used = new Set<number>();
    mentions.forEach((m, k) => {
      const floor = k === 0 ? 0 : mentions[k - 1].to;
      const next = k + 1 < mentions.length ? mentions[k + 1].from : toks.length;
      const { reading, used: u } = readMention(line, toks, m, floor, next);
      readings[m.itemIndex] = reading;
      claimed.add(m.itemIndex);
      for (let x = m.from; x < m.to; x += 1) used.add(x);
      u.forEach((x) => used.add(x));
    });
    toks.forEach((t, i) => {
      if (isNumber(t.t) && !used.has(i)) loose.push(t.t);
    });
  }
  return { readings, loose };
}

const singular = (unit: string) => (unit.endsWith("ses") || unit.endsWith("xes") ? unit.slice(0, -2) : unit.replace(/s$/, ""));

/**
 * Corrects the quantity, size and qualifier of each product line against the message it was written in. `texts` are the customer
 * messages of THIS turn only: an older message may since have been corrected ("make that 3"), so it is never used to overrule.
 *
 *   * "2 case acid" → 2, case.        * "10 lbs cal hypo" (no count) → one 10 lbs item, not the previous product's 2.
 *   * a model quantity that is really another product's count or a package size is dropped (to 1 when the item has a size, else
 *     unknown, so staff are asked);
 *   * a size and a "(damaged)" the customer wrote are kept on the line.
 */
export function reconcileLineQuantities(draft: OrderRequestDraft, texts: string[]): OrderRequestDraft {
  if (draft.items.length === 0 || texts.length === 0) return draft;
  const items = draft.items.map((i) => ({ ...i }));
  let notes = draft.notes;
  let touched = false;
  // Each item is read in the newest message that writes it.
  const done = new Set<number>();
  for (const text of [...texts].reverse()) {
    const pending = items.map((it, i) => ({ it, i })).filter(({ i }) => !done.has(i));
    if (pending.length === 0) break;
    const analysis = analyseLines(text, items);
    const counts = new Set<string>();
    const sizeNumbers = new Set<string>();
    for (const r of analysis.readings) {
      if (!r) continue;
      if (r.count !== null) counts.add(String(r.count));
      for (const n of (r.size ?? "").match(/\d+(?:\.\d+)?/g) ?? []) sizeNumbers.add(n);
    }
    for (const { it, i } of pending) {
      const r = analysis.readings[i];
      if (!r) continue;
      done.add(i);
      const had = it.quantity ?? null;
      if (r.count !== null) {
        if (had !== String(r.count)) {
          it.quantity = String(r.count);
          touched = true;
        }
      } else if (had !== null && (counts.has(had) || sizeNumbers.has(had))) {
        // The number is another line's count or this line's package weight: it does not qualify THIS product.
        it.quantity = r.size ? "1" : null;
        touched = true;
      }
      // A count that was never given ("Bandit 25kg", "10 lbs cal hypo") is NOT guessed: staff ask "how many?". One is used only to
      // replace a number that belonged to another line (above), where the size shows the customer asked for a single item.
      const sizeText = r.size ?? r.sizeWord ?? (r.unit && singular(r.unit) !== "bag" ? singular(r.unit) : null);
      if (sizeText && !it.size) {
        it.size = sizeText;
        touched = true;
      }
      if (r.qualifier && !it.variant && normalizeText(r.qualifier) !== normalizeText(it.product)) {
        it.variant = r.qualifier;
        if (notes && normalizeText(notes) === normalizeText(r.qualifier)) notes = null;
        touched = true;
      }
    }
  }
  return touched ? { ...draft, items, notes } : draft;
}

/**
 * "for Narural" on a line that continues "at <place>": the person or business that line is for, as a note
 * ("Birbo Chicken (small): for Narural"), so a multi-line message keeps who each line is for.
 */
export function lineRecipientNotes(items: OrderItem[], texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const analysis = analyseLines(text, items);
    analysis.readings.forEach((r, i) => {
      if (!r?.forWho || /^(?:the|my|our|a|an)\s/i.test(r.forWho)) return;
      const it = items[i];
      const label = [r.sizeWord ?? it.size, it.product].filter(Boolean).join(" ");
      out.push(`${label} for ${r.forWho}`);
    });
  }
  return [...new Set(out)];
}

// ── Billing, payment, sign-off ───────────────────────────────────────────────

const NAME_STOP = new Set(["and", "for", "please", "pls", "plz", "thanks", "thank", "thx", "today", "tomorrow", "tmrw", "tonight", "on", "at", "to", "from", "with", "by", "when", "then", "also", "as", "if", "or", "but"]);
const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const BILL_TO = /\b(?:bill|invoice|charge)(?:\s+(?:it|this|that|them|these|all))?\s+to\s+(?:the\s+)?(?:account\s+of\s+)?([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3})/iu;

/** "Bill to Anthony Macnamara" from "… bill to anthony macnamara", or null. The newest message that says it wins. */
export function billingInstruction(texts: string[]): string | null {
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(BILL_TO);
      if (!m) continue;
      const name: string[] = [];
      for (const w of m[1].split(/\s+/)) {
        if (NAME_STOP.has(w.toLowerCase().replace(/[.,]+$/, ""))) break;
        name.push(titleCase(w.replace(/[.,]+$/, "")));
      }
      if (name.length > 0 && name.join(" ").length >= 2) return `Bill to ${name.join(" ")}`;
    }
  }
  return null;
}

const PAYMENT_LINE = /\$\s?\d[\d,.]*.*\b(?:paid|pay|payment|cash|card|owing|owes|cod|on delivery|in store|account)\b|\b(?:paid|pay|payment|cash|card|owing|owes|cod)\b.*\$\s?\d[\d,.]*/i;

/** A line such as "$155 Paid in store", as the customer wrote it, or null. */
export function paymentNote(texts: string[]): string | null {
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line && line.length <= 80 && PAYMENT_LINE.test(line) && !/\?/.test(line)) return line;
    }
  }
  return null;
}

const THANKS_LINE = /^(?:many\s+)?(?:thanks?(?:\s+(?:you|a lot|so much|again|very much))?|thank\s*u|thx|tks|ty|regards|kind regards|best regards|best|cheers|blessings|have a (?:good|great|nice) day)[!.,\s]*$/i;
const SIGN_NAME = /^(?:[-–—~]\s*)?(\p{Lu}[\p{L}'’-]{1,24}(?:\s+\p{Lu}[\p{L}'’-]{1,24})?)[.!]?$/u;
const NOT_NAMES = new Set(["thanks", "thank", "regards", "cheers", "best", "hi", "hello", "hey", "please", "ok", "okay", "yes", "no", "sorry", "dear"]);

/** The name a message is signed with ("Thanks" / "Louise"), or null. Only a sign-off after a thanks line counts. */
export function signedName(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const last = lines[lines.length - 1];
  const m = last.match(SIGN_NAME);
  if (!m || NOT_NAMES.has(m[1].toLowerCase())) return null;
  const before = lines[lines.length - 2];
  return THANKS_LINE.test(before) || /\b(?:thanks?|thank you|regards)[!.,]?$/i.test(before) ? m[1] : null;
}

// ── Who the order is for ─────────────────────────────────────────────────────

export interface Recipient {
  name: string;
  /** Digits as written, a 10-digit North American number gets its leading 1. */
  phone: string;
}

const NAME_LINE = /^\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}$/u;
const GREETING_WORDS = new Set(["hi", "hello", "hey", "dear", "good", "thanks", "thank", "please", "regards", "cheers", "morning", "afternoon", "evening", "need", "deliver", "delivery", "send", "bring", "call", "order", "paid", "total"]);

export const nanpDigits = (digits: string): string => (digits.length === 10 ? `1${digits}` : digits);
const last7 = (d: string) => d.slice(-7);

/** A phone number alone on its line ("+1 (758) 484-7702", "Tel: 758 484 7702"), as digits, or null. */
function phoneOnlyLine(line: string): string | null {
  const body = line.replace(/^(?:tel|phone|ph|cell|mobile|whatsapp|number|no)\.?\s*:?\s*/i, "");
  if (!/^\+?[\d\s().-]{7,22}$/.test(body)) return null;
  const digits = body.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/**
 * The person an order is being placed FOR: a line holding just a name, straight followed by a line holding just a phone number
 * ("Tamara Amos" / "+1 (758) 484-7702"). The sender's own number never counts, and neither does a greeting or a command line.
 */
export function readRecipientBlock(texts: string[], senderDigits: string | null): Recipient | null {
  for (const text of texts) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i + 1 < lines.length; i += 1) {
      const nameLine = lines[i].replace(/[:,.]+$/, "");
      if (!NAME_LINE.test(nameLine) || nameLine.length > 40 || nameLine.split(/\s+/).some((w) => GREETING_WORDS.has(w.toLowerCase()))) continue;
      const digits = phoneOnlyLine(lines[i + 1]);
      if (!digits) continue;
      if (senderDigits && last7(senderDigits) === last7(digits)) continue;
      return { name: nameLine, phone: nanpDigits(digits) };
    }
  }
  return null;
}

// ── Note segments ────────────────────────────────────────────────────────────
// Notes are a staff-editable field: facts the system adds live in it as short, recognisable segments joined by " · " (the way the
// alternate "Delivery contact:" already does), so nothing needs a new column and a person can read and edit them.

export const NOTE_SEPARATOR = " · ";
export const PLACED_BY_PREFIX = "Placed by ";
export const SIGNED_BY_PREFIX = "Signed by ";
export const BILL_TO_PREFIX = "Bill to ";

const segmentsOf = (notes: string | null | undefined): string[] => (notes ?? "").split(NOTE_SEPARATOR).map((x) => x.trim()).filter(Boolean);

/** The first segment starting with `prefix` (case-insensitive), or null. */
export function noteSegment(notes: string | null | undefined, prefix: string): string | null {
  return segmentsOf(notes).find((s) => s.toLowerCase().startsWith(prefix.toLowerCase())) ?? null;
}

/**
 * Puts `segment` into the notes: with a `prefix`, it replaces the segment that starts with it (so a newer value wins); without one,
 * it is added unless the notes already say the same thing. Everything else in the notes is kept.
 */
export function withNoteSegment(notes: string | null | undefined, segment: string, prefix?: string): string {
  const kept = segmentsOf(notes).filter((s) => (prefix ? !s.toLowerCase().startsWith(prefix.toLowerCase()) : true));
  const same = (s: string) => normalizeText(s) === normalizeText(segment);
  if (!prefix && (kept.some(same) || normalizeText(notes ?? "").includes(normalizeText(segment)))) return kept.join(NOTE_SEPARATOR).slice(0, 1000);
  return [...kept, segment].join(NOTE_SEPARATOR).slice(0, 1000);
}

/** "Placed by Gary Devaux (+17587162997)": who sent an order that is for somebody else. */
export function placedByText(senderName: string | null, senderDigits: string | null): string {
  const phone = senderDigits ? `+${senderDigits}` : null;
  return `${PLACED_BY_PREFIX}${[senderName, phone ? (senderName ? `(${phone})` : phone) : null].filter(Boolean).join(" ") || "another contact"}`;
}

/** True when the notes say the order was placed by somebody else on this order's customer's behalf. */
export const isPlacedForOther = (notes: string | null | undefined): boolean => noteSegment(notes, PLACED_BY_PREFIX) !== null;
