// Business defaults for tracked orders — pure functions, no I/O.
//
// Cool & Pool / dog-food rules:
//   * Every order is DELIVERY unless the customer explicitly asked to collect. A missing method is never "missing".
//   * With no day given, an order is for TODAY when the customer's order request was written before 9:00 AM
//     Saint Lucia time, and for TOMORROW at or after 9:00. The clock that counts is the customer's message time
//     (the order's first_message_at), never the time the AI got around to processing it, so a late batch, a retry, a
//     backfill, or midnight passing cannot move the date. Nothing here promises delivery or confirms anything.
//
// NEW orders get both defaults WRITTEN when they are created (withCreationDefaults), from the customer's message time, so
// a later read never recomputes a different day. The stored day carries a "(default…)" marker so a value the business
// rules assumed can always be told apart from one the customer or staff set. Orders created before this change keep
// null columns and are DERIVED on read by effectiveDate / effectiveMethod, so no migration is needed. Both paths give
// the same answer for the same order.

import { DEFAULT_ORDERS_TIMEZONE, localParts, type FulfilmentMethod, type OrderFields, type TrackedOrder } from "./orders.ts";
import { normalizeText } from "./escalationUpdates.ts";
import { addDays, requestedDate } from "./orderText.ts";

/** Marks a stored day the business rules chose: "Fri 30 Oct (default)" or "Fri 30 Oct (default, morning)". */
const DEFAULT_DAY = /^(\w{3} \d{1,2} \w{3}) \(default(?:, (.+))?\)$/i;

/** Local hour (inclusive) from which an undated order request is for tomorrow. */
export const DEFAULT_ORDER_CUTOFF_HOUR = 9;

/**
 * The day an order is for when the customer named none: today if the request was written before 9:00 local time,
 * otherwise tomorrow. `requestedAtIso` is when the customer wrote it. null only for an unreadable timestamp.
 */
export function defaultOrderDate(requestedAtIso: string, timezone: string = DEFAULT_ORDERS_TIMEZONE): string | null {
  const at = new Date(requestedAtIso);
  if (Number.isNaN(at.getTime())) return null;
  const local = localParts(at, timezone);
  return local.minutes < DEFAULT_ORDER_CUTOFF_HOUR * 60 ? local.dateKey : addDays(local.dateKey, 1).key;
}

// "morning", "3pm", "around 10:30 am", "before noon", "asap": a time or urgency with no day in it. The day is then the
// business default and the wording is kept (the report still shows "🕐 morning").
const TIME_WORDS =
  /\b(?:morning|mornings|afternoon|evening|noon|midday|early|late|asap|anytime|any time|whenever|a\.?s\.?a\.?p|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|o'?clock|at|around|about|by|before|after|between|and|to|from|in|the|please|pls|plz|if|possible|can|you|thanks|thank)\b/gi;

/** A phrase that only talks about time of day ("morning", "around 3pm please"), so it names no day to read. */
export function isTimeOnlyPhrase(phrase: string | null | undefined): boolean {
  const text = (phrase ?? "").trim();
  if (!text) return false;
  return text.replace(TIME_WORDS, " ").replace(/[^\p{L}\p{N}]+/gu, "").length === 0;
}

export type DateSource =
  /** The customer (or staff) named a day that can be read. */
  | "stated"
  /** No day was named: the 9 AM business default. */
  | "default"
  /** Words were given but no single day can be read ("next week", "Friday or Saturday"): a person must look. */
  | "unreadable";

export interface EffectiveDate {
  /** YYYY-MM-DD in the business's timezone, or null when `source` is "unreadable". */
  date: string | null;
  source: DateSource;
}

/** True when `requestedFor` is a day the business default chose (not one anybody stated). */
export function isDefaultedDay(requestedFor: string | null | undefined): boolean {
  return DEFAULT_DAY.test((requestedFor ?? "").trim());
}

/** The stored form of a defaulted day; `wording` keeps a time of day the customer gave ("morning"). */
export function defaultedDayText(dateKey: string, wording?: string | null): string {
  const label = addDays(dateKey, 0).label;
  const w = (wording ?? "").trim();
  return w ? `${label} (default, ${w})` : `${label} (default)`;
}

export function effectiveDate(o: Pick<TrackedOrder, "requested_for" | "first_message_at">, timezone: string = DEFAULT_ORDERS_TIMEZONE): EffectiveDate {
  const text = (o.requested_for ?? "").trim();
  if (DEFAULT_DAY.test(text)) {
    const date = requestedDate(text, o.first_message_at, timezone);
    if (date) return { date, source: "default" };
  }
  if (text) {
    const stated = requestedDate(text, o.first_message_at, timezone);
    if (stated) return { date: stated, source: "stated" };
    if (!isTimeOnlyPhrase(text)) return { date: null, source: "unreadable" };
  }
  return { date: defaultOrderDate(o.first_message_at, timezone), source: "default" };
}

export interface EffectiveMethod {
  method: FulfilmentMethod;
  /** True when the customer said nothing about it and the business default (delivery) applies. */
  defaulted: boolean;
}

/** Delivery unless the order explicitly records collection. */
export function effectiveMethod(o: Pick<TrackedOrder, "fulfilment_method">): EffectiveMethod {
  return o.fulfilment_method ? { method: o.fulfilment_method, defaulted: false } : { method: "delivery", defaulted: true };
}

/**
 * What a NEW order gets when the customer gave no delivery/collection choice and no readable day. `requestedAtIso` is when
 * the customer wrote the request (the order's first_message_at). Explicit values, and words nobody can read as one day
 * ("next week"), are left exactly as they are. Pure: the caller stores the result.
 */
export function withCreationDefaults(
  fields: OrderFields,
  requestedAtIso: string,
  timezone: string = DEFAULT_ORDERS_TIMEZONE
): { fields: OrderFields; defaulted: ("fulfilment_method" | "requested_for")[] } {
  const next: OrderFields = { ...fields };
  const defaulted: ("fulfilment_method" | "requested_for")[] = [];
  if (!next.fulfilment_method) {
    next.fulfilment_method = "delivery";
    next.delivery_preference = next.delivery_preference ?? "delivery";
    defaulted.push("fulfilment_method");
  }
  const day = effectiveDate({ requested_for: next.requested_for, first_message_at: requestedAtIso }, timezone);
  if (day.source === "default" && !isDefaultedDay(next.requested_for)) {
    const key = defaultOrderDate(requestedAtIso, timezone);
    if (key) {
      next.requested_for = defaultedDayText(key, next.requested_for);
      defaulted.push("requested_for");
    }
  }
  return { fields: next, defaulted };
}

/**
 * A later turn repeating only a time of day ("morning") must not erase the stored default day. Returns the value to
 * offer the merge for `requested_for`: the stored default with the new wording, or `proposed` unchanged when it names a day.
 */
export function keepDefaultedDay(current: string | null | undefined, proposed: string | null): string | null {
  if (!isDefaultedDay(current)) return proposed;
  if (proposed === null) return null;
  if (!isTimeOnlyPhrase(proposed)) return proposed;
  const label = (current ?? "").match(DEFAULT_DAY)![1];
  return `${label} (default, ${proposed.trim()})`;
}

// ── Phone numbers written inside messages ────────────────────────────────────

const PHONE_RUN = /(?<![\d/])\+?\d[\d\s().-]{5,18}\d(?![\d/])/g;

/** Digits of every phone-looking number in `text` (7–15 digits; a quantity, price or date is not one). */
export function phonesIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PHONE_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    // 30/10/2026, 12.50 and 2026-10-30 are not numbers someone can ring.
    if (digits.length < 7 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(m[0].trim())) continue;
    found.push(digits);
  }
  return [...new Set(found)];
}

const PHONE_FILLER = /\b(?:call|ring|phone|text|whatsapp|wa|contact|number|no|tel|cell|mobile|me|us|him|her|them|on|at|is|my|his|her|their|the|driver|please|pls|reach|when|you|arrive|arrives|arrived|arrival|arriving|there|here|for|delivery|deliver|ok|okay|thanks|thank|tel|ph)\b/gi;

/** A note that is nothing but a phone number and the words around it ("call 758 123 4567 on arrival"). */
export function isPhoneOnlyNote(note: string | null | undefined): boolean {
  const text = (note ?? "").trim();
  if (!text || phonesIn(text).length === 0) return false;
  return text.replace(PHONE_RUN, " ").replace(PHONE_FILLER, " ").replace(/[^\p{L}\p{N}]+/gu, "").length === 0;
}

export const CONTACT_NOTE_PREFIX = "Delivery contact:";

/** "758 123 4567" → "+1 758 123 4567" is NOT guessed: the number is shown as the customer wrote its digits, grouped for reading. */
export function formatContactDigits(digits: string): string {
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}

/** The alternate delivery contact recorded in an order's notes, as digits, or null. */
export function deliveryContactIn(notes: string | null | undefined): string | null {
  const m = (notes ?? "").match(/Delivery contact:\s*([+\d][\d\s().-]*\d)/i);
  return m ? m[1].replace(/\D/g, "") : null;
}

const contactSegment = /^Delivery contact:/i;

/**
 * Records an alternate delivery contact in the notes. It lives in the notes (a staff-editable field), never in the order's
 * contact_number, which stays the verified sender's number. A newer number replaces an older "Delivery contact:" entry; the
 * rest of the note is kept.
 */
export function withDeliveryContact(notes: string | null | undefined, digits: string): string {
  const kept = (notes ?? "").split(" · ").map((x) => x.trim()).filter((x) => x && !contactSegment.test(x));
  if (kept.some((x) => phonesIn(x).includes(digits))) return kept.join(" · ");
  return [...kept, `${CONTACT_NOTE_PREFIX} ${formatContactDigits(digits)}`].join(" · ").slice(0, 1000);
}

const last7 = (digits: string) => digits.slice(-7);

/**
 * The alternate delivery contact for a draft: the number the model returned (or a note that is only a number), but only if
 * the customer actually WROTE those digits, and never the number they are writing from. Returns the digits as the customer
 * wrote them, or null.
 */
export function groundedContactPhone(
  draft: { contact_phone?: string | null; notes?: string | null },
  customerTexts: string[],
  senderDigits: string | null
): string | null {
  const written = phonesIn(customerTexts.join("\n"));
  const candidates = [
    ...phonesIn(draft.contact_phone ?? ""),
    ...(isPhoneOnlyNote(draft.notes) ? phonesIn(draft.notes ?? "") : []),
  ];
  for (const c of candidates) {
    const match = written.find((w) => last7(w) === last7(c));
    if (match && !(senderDigits && last7(senderDigits) === last7(match))) return match;
  }
  return null;
}

/** A name the customer wrote: every word of it appears in their own messages. */
export function nameStated(name: string, customerTexts: string[]): boolean {
  const said = new Set(normalizeText(customerTexts.join(" ")).split(" ").filter(Boolean));
  const words = normalizeText(name).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => said.has(w));
}
