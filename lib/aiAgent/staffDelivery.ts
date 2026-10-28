// Delivery dates agreed in a conversation — pure rules, no I/O, no model call.
//
// A delivery day is often fixed by STAFF, not by the customer: "we'll deliver tomorrow", "driver will be there Friday",
// or an offer the customer then accepts ("Would you like us to put you down for tomorrow?" / "Yes sure"). This module reads
// those messages deterministically. The day is resolved from the timestamp of the message that CONTAINS the phrase, in the
// business's timezone, never from "now": a message written at 22:30 on Tuesday evening in Saint Lucia means Wednesday for
// "tomorrow" even when it is processed (or replayed) days later.
//
// What counts:
//   commitment   a declarative staff statement that a delivery will happen on a day ("we will deliver tomorrow")
//   offer        a question, a hedge, or "it'll have to be tomorrow": a proposal that is NOT a delivery date until the
//                customer accepts it (agreedDeliveryDate)
//   none         everything else: a policy ("we deliver every Friday"), a refusal ("we can't deliver Friday"), a collection
//                time, a past delivery ("we delivered today"), a day that cannot be read as one calendar day
//
// Anything doubtful reads as `none`: the order keeps the day it has.

import { normalizeText } from "./escalationUpdates.ts";
import { DEFAULT_ORDERS_TIMEZONE } from "./orders.ts";
import { resolveRequestedDay } from "./orderText.ts";

export type StaffDateKind = "commitment" | "offer" | "none";

export interface StaffDateReading {
  kind: StaffDateKind;
  /** YYYY-MM-DD (business timezone) for a commitment or an offer; null for `none`. */
  date: string | null;
  /** "Wed 28 Oct". */
  label: string | null;
  /** The sentence the day was read from, clipped. */
  phrase: string | null;
}

const NONE: StaffDateReading = { kind: "none", date: null, label: null, phrase: null };

/** Words that tie a sentence to delivery. "put you down for" is how this business books a delivery slot. */
const DELIVERY_CONTEXT =
  /\b(?:deliver\w*|bring(?:ing)?|drop(?:ping)? ?(?:it |them )?off|dispatch\w*|send(?:ing)? (?:it|them|out)|driver|arriv\w+|reach (?:you|there)|on (?:the|its|their) way|put (?:you|them|it|that|this) down|book(?:ing)? (?:you|them|it) |schedul\w+ (?:you|them|it|for)|on (?:the|our) (?:list|route)|get (?:it|them) to you|with you)\b/i;

/** A declarative statement that a delivery WILL happen. */
const COMMITMENT =
  /\b(?:we|i|our driver|the driver|driver|it|they|delivery|the delivery|your order|your delivery|you)\b[^.?!]{0,50}?\b(?:will|'ll|shall|going to|gonna|are going to|is going to|is scheduled|are scheduled|is booked|will be|are down|am going to)\b[^.?!]{0,50}?\b(?:deliver\w*|bring|drop|send|dispatch\w*|arrive|reach|come|be (?:delivered|dropped|brought|sent|there|with you|out|on)|be down|get to you)\b|\b(?:delivery|deliveries|delivering)\b[^.?!]{0,30}\b(?:is|are|will be|scheduled|set|planned|arranged|booked|confirmed)\b|\b(?:you(?:'re| are)|you will be|you'll be)\b[^.?!]{0,20}\b(?:down|booked|scheduled|on the (?:list|route))\b|\b(?:put|have) you down for\b(?![^.?!]*\?)|\bscheduled for\b|\bbooked for\b/i;

/** A day proposed as a constraint ("it'll have to be tomorrow"): an offer, not yet a date. */
const HAS_TO_BE = /\b(?:it(?:'ll| will)|that(?:'ll| will)|it has to|it would have to|it'?ll have to|will have to)\b[^.?!]{0,15}\bbe\b/i;

const HEDGE =
  /\b(?:maybe|perhaps|possibly|might|may be|could|should be able|try(?:ing)? to|hopefully|if (?:possible|we can|all goes|the driver|there'?s|you)|depending|tentative|not sure|can'?t promise|cannot promise|unlikely|probably|likely|i think|think we|let me (?:check|see|find out|confirm)|will check|will let you know|will confirm|to be confirmed|tbc|subject to)\b/i;

const NEGATIVE = /\b(?:can'?t|cannot|can not|won'?t|unable|not able|no delivery|no deliveries|don'?t deliver|do not deliver|not deliver\w*|isn'?t possible|not possible|not going|no driver)\b/i;

/** "every Friday", "usually", "on Fridays": how the business works in general, not what happens to this order. */
const POLICY = /\b(?:every|each|usually|normally|always|generally|typically|on (?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/i;

/** Paperwork, not goods: "we'll send the invoice tomorrow" is not a delivery day. */
const PAPERWORK = /\b(?:invoices?|quot(?:e|es|ation|ations)|estimates?|pro ?forma|receipts?|statements?|bills?)\b/i;

const COLLECTION = /\b(?:collect\w*|pick(?:ed)? ?-?up|pick it up|ready (?:for|to)|come (?:and|to) (?:get|collect|pick))\b/i;

/** Past-tense delivery ("we delivered today", "already dropped off"). */
const PAST = /\b(?:delivered|dropped off|brought|was sent|were sent|has been delivered|have been delivered|already (?:delivered|sent|dropped)|did deliver)\b/i;

const INTERROGATIVE_START = /^(?:can|could|would|will|shall|do|does|did|is|are|how about|what about|want|wanna|would you like|do you want|shall we|are you|is that|any)\b/i;

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const isQuestion = (s: string) => /\?\s*$/.test(s) || INTERROGATIVE_START.test(s.replace(/^[^\p{L}\p{N}]+/u, ""));

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What one staff message says about a delivery day. `at` is when it was written. With several sentences the first
 * decisive one wins, except that a refusal anywhere in the message makes it `none` (the safe reading).
 */
export function readStaffDeliveryDate(text: string, at: Date, timezone: string = DEFAULT_ORDERS_TIMEZONE, context: { deliveryContext?: boolean } = {}): StaffDateReading {
  if (!text.trim() || Number.isNaN(at.getTime())) return NONE;
  const parts = sentences(text);
  if (parts.some((s) => NEGATIVE.test(s) && DELIVERY_CONTEXT.test(s))) return NONE;
  let offer: StaffDateReading | null = null;
  for (const sentence of parts) {
    // The day is read from the main clause only: "…tomorrow as our driver leaves at 9am every morning" gives a reason, not a policy.
    const main = sentence.split(/\b(?:as|because|since|so that)\b/i)[0];
    if (POLICY.test(main) || (PAST.test(sentence) && !/\b(?:will|'ll|to be|be)\b/i.test(sentence))) continue;
    if (COLLECTION.test(sentence) && !/\bdeliver\w*\b/i.test(sentence)) continue;
    if (PAPERWORK.test(sentence) && !/\bdeliver\w*\b/i.test(sentence)) continue;
    const day = resolveRequestedDay(main, at, timezone);
    if (!day) continue;
    const delivery = DELIVERY_CONTEXT.test(sentence) || context.deliveryContext === true;
    if (!delivery) continue;
    const reading = (kind: StaffDateKind): StaffDateReading => ({ kind, date: day.date, label: day.label, phrase: clip(sentence) });
    if (isQuestion(sentence) || HEDGE.test(sentence) || HAS_TO_BE.test(sentence)) {
      offer ??= reading("offer");
      continue;
    }
    if (COMMITMENT.test(sentence)) return reading("commitment");
  }
  return offer ?? NONE;
}

// ── A customer accepting what staff offered ──────────────────────────────────

const AFFIRMATION = new Set([
  "yes", "yes sure", "yes please", "yes pls", "yes plz", "yes thanks", "yes thank you", "yes ok", "yes okay", "yes that is fine", "yes thats fine", "yes that works", "yes perfect", "yes go ahead",
  "yeah", "yeah sure", "yeah ok", "yep", "yup", "ok", "okay", "ok sure", "ok thanks", "ok thank you", "okay thanks", "okay great", "ok great", "ok perfect", "sure", "sure thing", "sure thanks", "of course", "alright", "all right",
  "that works", "that is fine", "thats fine", "that is good", "thats good", "that is great", "thats great", "works for me", "works", "sounds good", "sounds great", "perfect", "great", "fine", "good", "go ahead", "please do", "do that", "put me down", "put me down please",
]);

/** A bare "yes sure", "ok perfect", 👍: the customer accepting what was just offered, adding nothing. */
export function isAffirmation(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/^(?:👍|👌|✅|🙏|👍🏽|👍🏿|👍🏻|👍🏼)+$/u.test(raw.replace(/\s+/g, ""))) return true;
  return AFFIRMATION.has(normalizeText(raw).replace(/\b(?:pls|plz)\b/g, "please"));
}

const REJECTION = /\b(?:no|nope|not|can'?t|cannot|won'?t|doesn'?t|isn'?t|rather|instead|but|however|another|different|later|earlier|too (?:soon|late)|not (?:good|possible|ok|okay|working))\b/i;

/** The customer turning an offer down or changing it ("no, Friday is better", "can't do tomorrow"). */
export function isRejection(text: string): boolean {
  const t = text.trim();
  return Boolean(t) && !isAffirmation(t) && REJECTION.test(t);
}

export interface ConversationLine {
  who: "Customer" | "Staff";
  text: string;
  /** ISO time the message was written. */
  at: string;
  /** WhatsApp id, when known. */
  id?: string | null;
  /** The id of the message this one replied to (WhatsApp quote), when known. */
  quotedId?: string | null;
}

export interface AgreedDate {
  date: string;
  label: string;
  /** The staff message the day came from. */
  staffAt: string;
  staffMessageId: string | null;
  phrase: string;
  /** "offer_accepted": a question or proposal the customer said yes to. "commitment": staff had already stated it (the yes only agrees). */
  basis: "offer_accepted" | "commitment";
}

/** How long a staff offer stays open for a bare "yes". Beyond this the yes is not tied to it. */
export const OFFER_WINDOW_HOURS = 12;

/**
 * The delivery day a customer's bare "yes" agreed to: the staff offer they quoted, or else the last staff message before
 * their reply. The offer's day is resolved from the staff message's own time. Returns null unless the whole turn is an
 * acceptance, the offer names exactly one readable day, and nothing the customer wrote in between disagrees.
 */
export function agreedDeliveryDate(args: {
  /** The customer's new messages in this turn. */
  segments: string[];
  /** When the turn was written. */
  at: string;
  /** Earlier messages of the chat, oldest first, EXCLUDING this turn. */
  recent: ConversationLine[];
  /** WhatsApp id of the message the customer replied to, when the bridge supplied it. */
  quotedId?: string | null;
  timezone?: string;
}): AgreedDate | null {
  const tz = args.timezone ?? DEFAULT_ORDERS_TIMEZONE;
  const real = args.segments.map((s) => s.trim()).filter(Boolean);
  if (real.length === 0 || !real.every(isAffirmation)) return null;
  const turnAt = Date.parse(args.at);
  const earlier = args.recent.filter((m) => m.text.trim() && (Number.isNaN(turnAt) || Date.parse(m.at) <= turnAt));
  const quoted = args.quotedId ? earlier.find((m) => m.id === args.quotedId) : undefined;
  const offerLine = quoted ?? [...earlier].reverse().find((m) => m.who === "Staff");
  if (!offerLine || offerLine.who !== "Staff") return null;
  if (!Number.isNaN(turnAt) && turnAt - Date.parse(offerLine.at) > OFFER_WINDOW_HOURS * 3_600_000) return null;
  // Without a quote, the customer must not have said anything else after the offer (a disagreement, another question).
  if (!quoted && earlier.some((m) => m.who === "Customer" && Date.parse(m.at) > Date.parse(offerLine.at) && m.text.trim())) return null;
  const staffAt = new Date(offerLine.at);
  // The day comes from the staff line alone; an earlier staff line in the same run supplies "this is about delivery".
  const priorStaff = earlier.filter((m) => m.who === "Staff" && Date.parse(m.at) <= Date.parse(offerLine.at));
  const deliveryContext = priorStaff.some((m) => DELIVERY_CONTEXT.test(m.text));
  const reading = readStaffDeliveryDate(offerLine.text, staffAt, tz, { deliveryContext });
  if (reading.kind === "none" || !reading.date || !reading.label) return null;
  return {
    date: reading.date,
    label: reading.label,
    staffAt: offerLine.at,
    staffMessageId: offerLine.id ?? null,
    phrase: reading.phrase ?? "",
    basis: reading.kind === "commitment" ? "commitment" : "offer_accepted",
  };
}

/** Staff words that offer or promise delivery at all (no day needed): used to read "yes" as an order, not small talk. */
export function staffOffersDelivery(text: string): boolean {
  const t = text.trim();
  if (!t || NEGATIVE.test(t) && !/\bwe can deliver\b/i.test(t)) return false;
  return /\b(?:we|i)(?: can| could|'ll| will| do)? (?:deliver|bring|drop|send)\b|\bcan deliver\b|\bdelivery (?:is|will be|available)\b|\bput you down\b|\bwe deliver\b/i.test(t) && !COLLECTION.test(t);
}
