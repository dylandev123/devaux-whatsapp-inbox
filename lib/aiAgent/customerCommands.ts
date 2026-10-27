// Staff commands about ONE customer — "!location" (show / save / clear), "!customer", "!remember" — and "!rules" / "!help". Pure parsing,
// validation and reply text (no I/O), unit-tested in tests/aiAgentCustomerCommands.test.ts. The server side
// (lib/server/aiAgent/customerCommands.ts) resolves who the customer is, checks who may do what and stores the result.
//
// A customer is named in exactly one of these ways, never by display name (two customers can share one):
//   - replying to (quoting) a notice the agent posted about that customer,
//   - a request code   #E-ABCDE   (an escalation: it belongs to one chat),
//   - an order code    #QU6U9     (an order: it belongs to one chat),
//   - a phone number   17585550123 (8–15 digits).
// Anything else is refused with usage help; the parser never guesses a customer.

import { detectPromptInjection } from "./engine.ts";
import { parseOrderRef } from "./orders.ts";

export type CustomerRef =
  | { type: "escalation"; refCode: string }
  | { type: "order"; refCode: string }
  | { type: "phone"; digits: string };

export type CustomerCommand =
  | { kind: "rules" }
  | { kind: "location"; ref: CustomerRef | null; value: string | null }
  /** `!location [<customer>] clear`: remove the saved default delivery location. */
  | { kind: "location_clear"; ref: CustomerRef | null }
  | { kind: "customer"; ref: CustomerRef | null }
  /** `!remember <customer> <fact>`: propose a note. */
  | { kind: "remember"; ref: CustomerRef | null; fact: string }
  /** `!remember confirm|discard|remove M-ABCDE` */
  | { kind: "remember_review"; action: "confirm" | "discard" | "remove"; code: string }
  /** The first word looks like a customer or order code but is not one we know the format of (e.g. “X-0123”). */
  | { kind: "unknown_ref"; command: "location" | "customer" | "remember"; token: string }
  | { kind: "help"; command: "location" | "customer" | "remember" | "rules"; reason: "no_customer" | "no_fact" | "bad_arguments" };

const ESCALATION_REF = /^#?E-([A-Z0-9]{4,8})$/i;
const ORDER_REF = /^(?:#|O-)([A-HJ-NP-Z2-9]{5})$/i;
const PHONE_TOKEN = /^\+?\d[\d-]{6,18}\d$/;

/** The customer named by one token, or null when the token is not a customer reference. */
export function parseCustomerRef(token: string): CustomerRef | null {
  const t = token.trim();
  let m = t.match(ESCALATION_REF);
  if (m) return { type: "escalation", refCode: `E-${m[1].toUpperCase()}` };
  m = t.match(ORDER_REF);
  if (m) {
    const ref = parseOrderRef(m[1]);
    return ref ? { type: "order", refCode: ref } : null;
  }
  if (PHONE_TOKEN.test(t)) {
    const digits = t.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return { type: "phone", digits };
  }
  return null;
}

/** A "!remember" proposal nobody confirms within this long expires and can no longer be confirmed. */
export const PROPOSAL_TTL_DAYS = 7;
export const PROPOSAL_TTL_MS = PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Proposals created before this instant have expired. */
export const proposalCutoff = (now: number = Date.now()) => new Date(now - PROPOSAL_TTL_MS).toISOString();
export const isProposalExpired = (createdAt: string | null | undefined, now: number = Date.now()) => {
  const t = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(t) && t < now - PROPOSAL_TTL_MS;
};

export const MEMORY_CODE = /^M-([A-HJ-NP-Z2-9]{5})$/i;
const REVIEW_ACTIONS = new Set(["confirm", "discard", "remove"]);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// A first word shaped like a code ("#ABC12", "X-0123", "C1042") that is not a reference we know. With a quoted reply
// present it must NOT fall through to being part of the location or note and be saved against the quoted customer.
const CODE_SHAPED = /^(?:#\S+|[A-Za-z]{1,3}-?\d{2,}|\d{5,7})$/;

/** Splits an optional leading customer reference from the rest of the arguments. */
function splitRef(body: string): { ref: CustomerRef | null; rest: string; bad: string | null } {
  const text = clean(body);
  const [first = "", ...others] = text.split(" ");
  const ref = parseCustomerRef(first);
  if (ref) return { ref, rest: others.join(" ").trim(), bad: null };
  return { ref: null, rest: text, bad: CODE_SHAPED.test(first) ? first.slice(0, 30) : null };
}

/**
 * Recognises "!rules", "!help", "!location", "!customer" and "!remember" at the START of a message. Anything else
 * (including a message that only mentions them) is null and goes on to the existing handlers untouched.
 */
export function parseCustomerCommand(raw: string): CustomerCommand | null {
  const text = clean(raw);
  const m = text.match(/^!(rules|help|location|customer|remember)\b[\s:]*(.*)$/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const body = m[2];

  if (word === "rules" || word === "help") return { kind: "rules" };

  if (word === "customer") {
    const { ref, rest, bad } = splitRef(body);
    if (bad) return { kind: "unknown_ref", command: "customer", token: bad };
    return rest ? { kind: "help", command: "customer", reason: "bad_arguments" } : { kind: "customer", ref };
  }

  if (word === "location") {
    const { ref, rest, bad } = splitRef(body);
    if (bad) return { kind: "unknown_ref", command: "location", token: bad };
    // "clear" alone removes the location. "clear Cap Estate" is neither a clear nor a place: refused, never saved.
    if (/^clear$/i.test(rest)) return { kind: "location_clear", ref };
    if (/^clear\s/i.test(rest)) return { kind: "help", command: "location", reason: "bad_arguments" };
    return { kind: "location", ref, value: rest || null };
  }

  // remember: "!remember confirm M-ABCDE" is a review of a proposal; anything else proposes a fact.
  const review = clean(body).match(/^(confirm|discard|remove)\s+(M-[A-Z0-9]+)$/i);
  if (review && REVIEW_ACTIONS.has(review[1].toLowerCase())) {
    const code = review[2].match(MEMORY_CODE);
    return code ? { kind: "remember_review", action: review[1].toLowerCase() as "confirm" | "discard" | "remove", code: `M-${code[1].toUpperCase()}` } : { kind: "help", command: "remember", reason: "bad_arguments" };
  }
  const { ref, rest, bad } = splitRef(body);
  if (bad) return { kind: "unknown_ref", command: "remember", token: bad };
  return rest ? { kind: "remember", ref, fact: rest } : { kind: "help", command: "remember", reason: "no_fact" };
}

// ── What may be saved ────────────────────────────────────────────────────────

export const LOCATION_MAX_CHARS = 120;
export const NOTE_MAX_CHARS = 200;
/** Active + proposed notes one customer may hold: keeps the AI prompt (and the staff card) short. */
export const MAX_NOTES_PER_CUSTOMER = 12;

export type TextRejection = "empty" | "too_short" | "too_long" | "looks_like_command" | "placeholder" | "unsafe";

const PLACEHOLDER = /^(?:same|usual|normal|regular|default|home|none|n\/?a|unknown|tbc|tba|\?+|-+|clear|remove|delete|same (?:place|location|address|as before)|usual (?:place|location|address))$/i;
// Control and bidi/invisible characters have no place in a place name.
const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

function validateText(raw: string, max: number, min: number, placeholders: boolean): { ok: true; value: string } | { ok: false; reason: TextRejection } {
  const value = raw.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (value.length < min) return { ok: false, reason: "too_short" };
  if (value.length > max) return { ok: false, reason: "too_long" };
  if (value.startsWith("!")) return { ok: false, reason: "looks_like_command" };
  if (placeholders && PLACEHOLDER.test(value)) return { ok: false, reason: "placeholder" };
  if (detectPromptInjection(value)) return { ok: false, reason: "unsafe" };
  return { ok: true, value };
}

/** A delivery location: a place name or address, 2–120 characters, never a placeholder like "same" or "usual". */
export const validateLocation = (raw: string) => validateText(raw, LOCATION_MAX_CHARS, 2, true);
/** A customer note: 3–200 characters. */
export const validateNote = (raw: string) => validateText(raw, NOTE_MAX_CHARS, 3, false);

export const REJECTION_TEXT: Record<TextRejection, (what: string) => string> = {
  empty: (w) => `no ${w} given`,
  too_short: (w) => `that ${w} is too short`,
  too_long: (w) => `that ${w} is too long`,
  looks_like_command: (w) => `a ${w} can't start with “!”`,
  placeholder: (w) => `“same”, “usual”, “unknown” and similar words are not a real ${w}`,
  unsafe: (w) => `that ${w} looks like an instruction, not a ${w}`,
};

/** The same location written differently ("cap estate", "Cap  Estate.") is the same location. */
export const locationFingerprint = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 200);
export const noteFingerprint = locationFingerprint;

// A fact about where the customer lives or wants delivery belongs in !location: kept out of free-text notes so
// the default location has one source of truth and two active memories can't disagree about it.
const LOCATION_FACT = /\b(?:deliver(?:y|ed)?\s+(?:to|at)|(?:lives?|living|located|based|stays?)\s+(?:in|at|near|on)|(?:home|delivery|usual|default|billing)\s+(?:address|location|place)|(?:his|her|their)\s+address\s+is|address\s*(?:is|:))\b/i;
export const looksLikeLocationFact = (fact: string) => LOCATION_FACT.test(fact);

// "Same place" / "usual location" — a customer pointing at their saved default delivery location.
const SAVED_LOCATION_CUE =
  /\b(?:same|usual|regular|normal|default|saved)\s+(?:delivery\s+)?(?:location|place|address|spot)\b|\b(?:deliver|bring|send|drop)\w*\s+(?:it\s+|them\s+)?(?:to\s+|at\s+)?(?:the\s+)?(?:same|usual)\s+(?:place|location|address|spot)\b|\bsame (?:as )?(?:usual|always) (?:place|location|address)\b/i;
export const detectSavedLocationCue = (text: string) => SAVED_LOCATION_CUE.test(text);

// ── Reply text ───────────────────────────────────────────────────────────────

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export const USAGE = {
  location: [
    "ℹ️ Use:",
    "!location <customer> — show their saved delivery location",
    "!location <customer> Cap Estate — save or replace it",
    "!location <customer> clear — remove it",
    "<customer> = their phone number (17585550123), a request code (#E-ABCDE) or an order code (#QU6U9).",
    "Or reply to their notice with just !location, !location Cap Estate or !location clear.",
  ].join("\n"),
  customer: [
    "ℹ️ Use:",
    "!customer <customer> — show their saved profile",
    "<customer> = their phone number (17585550123), a request code (#E-ABCDE) or an order code (#QU6U9).",
    "Or reply to their notice with just !customer.",
  ].join("\n"),
  remember: [
    "ℹ️ Use:",
    "!remember <customer> <fact> — propose a note, e.g. !remember 17585550123 Dog is nervous, call first",
    `Then !remember confirm M-ABCDE to save it, or !remember discard M-ABCDE. An unconfirmed proposal expires after ${PROPOSAL_TTL_DAYS} days.`,
    "!remember remove M-ABCDE removes a saved note.",
    "<customer> = phone number, request code (#E-ABCDE) or order code (#QU6U9), or reply to their notice.",
  ].join("\n"),
  rules: "ℹ️ Use !rules (or !help) on its own to list the commands.",
} as const;

export const CUSTOMER_REPLY = {
  notAuthorized: "⛔ Only authorized staff can use staff commands — nothing was changed or shown. Ask an admin to add you to this business's staff list.",
  noCustomer: (command: "location" | "customer" | "remember") => `⚠️ Which customer? I won't guess.\n${USAGE[command]}`,
  unknownRef: (label: string) => `⚠️ I can't find a customer for ${label} in this business. Nothing was changed.\n(Use their phone number, a #E- request code, an order code, or reply to their notice.)`,
  mismatch: "⚠️ The message you replied to and the customer you typed are different people — nothing was changed. Use one or the other.",
  ambiguousQuote: "⚠️ The message you replied to is about more than one customer — nothing was changed. Reply to a single customer's notice, or give a phone number.",
  rejected: (what: string, why: string) => `⚠️ Not saved: ${why}. Nothing was changed.\n${what}`,
};

export interface LocationView {
  label: string;
  location: string | null;
  setAt: string | null;
  setBy: string | null;
  source: string | null;
}

export function formatLocationReply(v: LocationView, timeZone: string): string {
  if (!v.location) return `📍 ${v.label}: no default delivery location saved.\nSave one with: !location <customer> Cap Estate`;
  return `📍 ${v.label}: default delivery location is *${v.location}*${stamp(v.setAt, v.source, timeZone)}`;
}

export function formatLocationCleared(args: { label: string; previous: string | null }): string {
  return `🗑️ ${args.label}: default delivery location${args.previous ? ` *${args.previous}*` : ""} removed. No default is saved now. It stays in the history.`;
}

export function formatLocationSaved(args: { label: string; location: string; previous: string | null }): string {
  return args.previous
    ? `✅ ${args.label}: default delivery location changed from *${args.previous}* to *${args.location}*.`
    : `✅ ${args.label}: default delivery location saved as *${args.location}*.`;
}

/** "2 Nov 2026, 10:15 · set by staff on WhatsApp" */
function stamp(at: string | null, source: string | null, timeZone: string): string {
  const d = at ? new Date(at) : null;
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }) : null;
  const bits = [when, source].filter(Boolean);
  return bits.length > 0 ? `\n(${bits.join(" · ")})` : "";
}

export interface CustomerCard {
  label: string;
  phone: string | null;
  location: { value: string; at: string | null; source: string | null } | null;
  notes: { code: string | null; content: string; at: string | null }[];
  proposed: { code: string | null; content: string }[];
  customerSaid: string[];
  resolvedIssues: string[];
  recentOrders: string[];
  /** Delivery addresses on recent confirmed orders (information only: not the saved default). */
  recentAddresses: string[];
  /** AI guesses. Always labelled as unverified. */
  inferences: string[];
  timeZone: string;
}

export function formatCustomerCard(c: CustomerCard): string {
  const lines: string[] = [`👤 *${c.label}*${c.phone ? ` · ${c.phone}` : ""}`];
  lines.push(c.location ? `📍 Delivery location: *${c.location.value}*${stamp(c.location.at, c.location.source, c.timeZone).replace("\n", " ")}` : "📍 Delivery location: not saved");
  if (c.notes.length > 0) lines.push("", "📝 Staff notes:", ...c.notes.map((n) => `• ${clip(n.content, 160)}${n.code ? ` (${n.code})` : ""}`));
  if (c.proposed.length > 0) lines.push("", "⏳ Waiting for confirmation:", ...c.proposed.map((n) => `• ${clip(n.content, 160)}${n.code ? ` (${n.code})` : ""}`));
  if (c.customerSaid.length > 0) lines.push("", "💬 Customer said (preferences):", ...c.customerSaid.map((s) => `• ${clip(s, 160)}`));
  if (c.resolvedIssues.length > 0) lines.push("", "☑️ Earlier issues (resolved):", ...c.resolvedIssues.map((s) => `• ${clip(s, 160)}`));
  if (c.recentOrders.length > 0) lines.push("", "✔ Recent confirmed orders:", ...c.recentOrders.map((s) => `• ${clip(s, 160)}`));
  if (c.recentAddresses.length > 0) lines.push("", "🚚 Addresses on recent orders:", ...c.recentAddresses.map((s) => `• ${clip(s, 160)}`));
  if (c.inferences.length > 0) lines.push("", "⚠️ AI guesses (unverified):", ...c.inferences.map((s) => `• ${clip(s, 160)}`));
  if (!c.location && c.notes.length === 0 && c.customerSaid.length === 0 && c.recentOrders.length === 0) lines.push("", "Nothing else saved for this customer yet.");
  return lines.join("\n").slice(0, 3500);
}
