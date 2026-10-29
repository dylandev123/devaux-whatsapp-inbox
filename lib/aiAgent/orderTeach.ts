// Natural-language order corrections ("!order #REF teach …") and bulk completion ("!orders complete all") — pure (no I/O),
// unit-tested in tests/aiAgentOrderTeach.test.ts. The server side (lib/server/aiAgent/orderCorrections.ts) stores the
// proposals, checks who may confirm them and applies them through the same order mutation the dashboard uses.
//
// The language model only PROPOSES. What it returns is untrusted: parseCorrectionProposal() validates its shape and
// planCorrection() checks every value against the staff member's own words (a product, address, name, day or number the
// instruction does not mention is refused, never applied) and against the order (a value equal to the current one is not a
// change). Anything doubtful is reported as an ambiguity and the whole instruction is refused: no half-understood change
// ever becomes a proposal. A proposal is a preview with a one-time code; nothing is applied until staff confirm it.

import { normalizeText } from "./escalationUpdates.ts";
import { defaultedDayText, effectiveDate, effectiveMethod, isDefaultedDay, isTimeOnlyPhrase, withDeliveryContact } from "./orderDefaults.ts";
import { anchorRequestedFor, resolveRequestedDay } from "./orderText.ts";
import { bucketOf, dayLabel, type DayContext, orderDate, timeOfDay } from "./orderViews.ts";
import {
  displayRef,
  type EditableOrderField,
  formatPhone,
  isOpenStatus,
  isReliableName,
  type OrderLine,
  type OrderNames,
  orderDisplayName,
  orderItemText,
  type TrackedOrder,
} from "./orders.ts";

// ── Codes, lifetimes, parsing limits ─────────────────────────────────────────

/** How long a proposed correction can be confirmed. A stale preview is worse than none. */
export const CORRECTION_TTL_MS = 30 * 60_000;
/** A bulk completion is bigger, so its token lives shorter. */
export const BULK_TTL_MS = 10 * 60_000;
/** A bulk completion that was claimed but never finished (the process died) may be retried after this long. */
export const CLAIM_RETRY_MS = 2 * 60_000;
export const MAX_INSTRUCTION = 600;

export type ProposalKind = "correction" | "bulk_complete" | "customer_preference";

const PROPOSAL_CODE = /^#?([CBP])-([A-HJ-NP-Z2-9]{5})$/i;

/** "C-ABCDE" (a correction), "B-ABCDE" (a bulk completion) or "P-ABCDE" (a customer preference). Knowledge codes (K-), notes (M-) and requests (E-) are not ours. */
export function parseProposalCode(token: string): { kind: ProposalKind; code: string } | null {
  const m = token.trim().replace(/[.!]+$/, "").match(PROPOSAL_CODE);
  return m ? { kind: ({ C: "correction", B: "bulk_complete", P: "customer_preference" } as const)[m[1].toUpperCase() as "C" | "B" | "P"], code: `${m[1].toUpperCase()}-${m[2].toUpperCase()}` } : null;
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
/** Staff or customer text in a group message: one line, never one that reads as a command. */
export const safe = (v: string | null | undefined, n: number) => clip((v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), n).replace(/^[!/]+/, "");

// ── What the model returns ───────────────────────────────────────────────────

export interface ReusableSuggestion {
  scope: "customer" | "business";
  text: string;
}

export interface CorrectionProposal {
  /** The COMPLETE product list the order should have afterwards, or null when the instruction does not touch products. */
  items: OrderLine[] | null;
  customer_name: string | null;
  fulfilment_method: "delivery" | "collection" | null;
  delivery_address: string | null;
  /** The staff member's own words for the day/time ("tomorrow morning"), never a converted date. */
  requested_for: string | null;
  /** An alternate contact number for the delivery. */
  contact_phone: string | null;
  /** Text to ADD to the order's notes. */
  note: string | null;
  /** Anything the instruction left unclear or contradictory. */
  ambiguities: string[];
  reusable: ReusableSuggestion[];
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/** The model's JSON, validated. null when it is not usable at all (the caller treats that as "not understood"). */
export function parseCorrectionProposal(raw: string | null | undefined): CorrectionProposal | null {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    json = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  let items: OrderLine[] | null = null;
  if (Array.isArray(json.items)) {
    items = [];
    for (const raw of json.items.slice(0, 20)) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const product = str(r.product, 200);
      if (!product) continue;
      items.push({ product, quantity: str(r.quantity, 50), variant: str(r.variant, 100), size: str(r.size, 50) });
    }
  }
  const method = typeof json.fulfilment_method === "string" ? json.fulfilment_method.toLowerCase() : null;
  const ambiguities = (Array.isArray(json.ambiguities) ? json.ambiguities : []).map((a) => str(a, 160)).filter((a): a is string => Boolean(a)).slice(0, 5);
  const reusable = (Array.isArray(json.reusable) ? json.reusable : [])
    .map((r): ReusableSuggestion | null => {
      const o = (r ?? {}) as Record<string, unknown>;
      const t = str(o.text, 200);
      return t && (o.scope === "customer" || o.scope === "business") ? { scope: o.scope, text: t } : null;
    })
    .filter((r): r is ReusableSuggestion => r !== null)
    .slice(0, 2);
  return {
    items,
    customer_name: str(json.customer_name, 120),
    fulfilment_method: method === "delivery" || method === "collection" ? method : null,
    delivery_address: str(json.delivery_address, 500),
    requested_for: str(json.requested_for, 100),
    contact_phone: str(json.contact_phone, 40),
    note: str(json.note, 300),
    ambiguities,
    reusable,
  };
}

// ── Checking the proposal against the instruction ────────────────────────────

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "his", "her", "their", "its", "are", "was", "has", "have", "will", "wants", "want", "food", "order", "bag", "bags"]);
export const words = (s: string): string[] => normalizeText(s).split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

/** Fraction of `value`'s significant words that the instruction contains (1 = all of them, 0 = none or nothing to check). */
export function overlap(instructionWords: Set<string>, value: string): number {
  const w = words(value);
  return w.length === 0 ? 0 : w.filter((x) => instructionWords.has(x)).length / w.length;
}

export function quantityStated(instruction: string, quantity: string): boolean {
  const q = quantity.trim().toLowerCase();
  const tokens = normalizeText(instruction).split(" ");
  if (tokens.includes(q)) return true;
  if (tokens.some((t) => NUMBER_WORDS[t] === q)) return true;
  return q === "1" && tokens.some((t) => t === "a" || t === "an" || t === "single");
}

const COLLECT = /\b(collect(?:s|ed|ing|ion)?|pick(?:s|ed|ing)?[\s-]?up|pickup|come(?:s|ing)?\s+(?:to\s+)?(?:get|collect|pick)|will\s+get\s+it|fetch(?:es|ing)?)\b/i;
const DELIVER = /\b(deliver(?:s|ed|ing|y)?|bring(?:s|ing)?|drop(?:s|ped|ping)?[\s-]?off|send(?:s|ing)?|courier)\b/i;
/** Wording that makes a correction a statement about the whole thing being reusable, never a one-off. */
export const GENERAL_CUE = /\b(always|usually|every(?:\s+(?:time|week|day|order))?|each\s+time|whenever|normally|from\s+now\s+on|as\s+usual|never|typically)\b/i;

const lineKey = (l: OrderLine) => normalizeText(orderItemText(l));
const sameItems = (a: OrderLine[], b: OrderLine[]) => a.length === b.length && a.every((l, i) => lineKey(l) === lineKey(b[i]));

// ── Planning ─────────────────────────────────────────────────────────────────

export interface PlannedChange {
  field: EditableOrderField;
  /** What staff read: "Products", "Delivery address"… */
  label: string;
  before: string;
  after: string;
  /** The stored values (for the audit trail and the stale check). */
  beforeValue: unknown;
  afterValue: unknown;
  /** Staff edited this field before: this correction replaces a person's value (the lock stays). */
  wasLocked: boolean;
}

export interface CorrectionPlan {
  changes: PlannedChange[];
  /** What updateOrderManually receives. */
  patch: Partial<Record<EditableOrderField, unknown>>;
  /** Why the instruction cannot be turned into a proposal. Non-empty means: apply nothing, ask the staff member. */
  ambiguities: string[];
  /** Suggestions for reusable facts, only when the staff member's words generalise. Never stored by this planner. */
  reusable: ReusableSuggestion[];
}

export interface PlanContext {
  /** The staff member's own words. */
  instruction: string;
  /** When they wrote it: relative days ("tomorrow") are counted from here, in the business's timezone. */
  at: Date;
  timezone: string;
}

const FIELD_LABEL: Record<string, string> = {
  items: "Products",
  customer_name: "Customer name",
  fulfilment_method: "Delivery / collection",
  delivery_address: "Delivery address",
  requested_for: "Day / time",
  notes: "Notes",
};

/** "Thu 29 Oct, morning" from what is stored; the customer's own words when no day can be read. */
export function whenText(requestedFor: string | null, firstMessageAt: string, timezone: string): string {
  if (!requestedFor) return "no day set";
  const day = effectiveDate({ requested_for: requestedFor, first_message_at: firstMessageAt }, timezone);
  if (!day.date) return `“${safe(requestedFor, 60)}” (no date read)`;
  const tod = timeOfDay(requestedFor);
  return `${dayLabel(day.date)}${tod ? `, ${tod}` : ""}`;
}

const itemsText = (items: OrderLine[]) => (items.length > 0 ? items.map(orderItemText).join("; ") : "no products");
const methodText = (m: string | null) => (m === "collection" ? "collection" : m === "delivery" ? "delivery" : "delivery (default)");

/**
 * Turns the model's proposal into the changes it justifies. Pure: the same instruction, order and proposal always give the
 * same plan. Every value must be traceable to the instruction; the rest is dropped and reported as an ambiguity.
 */
export function planCorrection(order: TrackedOrder, proposal: CorrectionProposal, ctx: PlanContext): CorrectionPlan {
  const instruction = ctx.instruction;
  const said = new Set(words(instruction));
  const ambiguities = [...proposal.ambiguities];
  const changes: PlannedChange[] = [];
  const patch: Partial<Record<EditableOrderField, unknown>> = {};
  const locked = new Set(order.manual_locked_fields);
  const push = (field: EditableOrderField, before: string, after: string, beforeValue: unknown, afterValue: unknown) => {
    changes.push({ field, label: FIELD_LABEL[field], before, after, beforeValue, afterValue, wasLocked: locked.has(field) });
    patch[field] = afterValue;
  };

  // Products and quantities: the complete list the order should have afterwards.
  if (proposal.items) {
    const proposed = proposal.items;
    const existing = new Set(order.items.map(lineKey));
    const ungrounded = proposed.filter((l) => !existing.has(lineKey(l)) && overlap(said, `${l.product} ${l.variant ?? ""} ${l.size ?? ""}`) === 0);
    const unstated = proposed.filter((l) => {
      if (!l.quantity || existing.has(lineKey(l))) return false;
      const before = order.items.find((o) => normalizeText(o.product) === normalizeText(l.product));
      return before?.quantity !== l.quantity && !quantityStated(instruction, l.quantity);
    });
    if (proposed.length === 0) ambiguities.push("I could not tell which products the order should have.");
    else if (ungrounded.length > 0) ambiguities.push(`“${safe(ungrounded[0].product, 40)}” is not in what you wrote.`);
    else if (unstated.length > 0) ambiguities.push(`The quantity for ${safe(unstated[0].product, 40)} is not in what you wrote.`);
    else if (!sameItems(order.items, proposed)) {
      push("items", itemsText(order.items), itemsText(proposed), order.items, proposed.map((l) => ({ ...l })));
    }
  }

  if (proposal.delivery_address) {
    const address = proposal.delivery_address;
    if (overlap(said, address) < 0.5) ambiguities.push(`The address “${safe(address, 50)}” is not in what you wrote.`);
    else if (normalizeText(address) !== normalizeText(order.delivery_address ?? "")) {
      push("delivery_address", order.delivery_address ? safe(order.delivery_address, 80) : "not set", safe(address, 120), order.delivery_address, address);
    }
  }

  if (proposal.fulfilment_method) {
    const method = proposal.fulfilment_method;
    const current = effectiveMethod(order).method;
    if (method !== current) {
      const cue = method === "collection" ? COLLECT.test(instruction) : DELIVER.test(instruction);
      if (!cue) ambiguities.push(`You did not say whether it is ${method === "collection" ? "collected" : "delivered"}.`);
      else push("fulfilment_method", methodText(order.fulfilment_method), methodText(method), order.fulfilment_method, method);
    }
  }

  if (proposal.customer_name) {
    const name = proposal.customer_name;
    if (!isReliableName(name) || overlap(said, name) < 1) ambiguities.push(`The name “${safe(name, 40)}” is not clearly in what you wrote.`);
    else if (normalizeText(name) !== normalizeText(order.customer_name ?? "")) {
      push("customer_name", order.customer_name ? safe(order.customer_name, 60) : "not set", safe(name, 60), order.customer_name, name);
    }
  }

  if (proposal.requested_for) {
    const phrase = proposal.requested_for;
    const grounded = words(phrase).every((w) => said.has(w)) && words(phrase).length > 0;
    const day = resolveRequestedDay(phrase, ctx.at, ctx.timezone);
    const current = effectiveDate(order, ctx.timezone);
    let stored: string | null = null;
    if (!grounded) ambiguities.push(`The day “${safe(phrase, 40)}” is not in what you wrote.`);
    else if (day) stored = anchorRequestedFor(phrase, order.requested_for, ctx.at, ctx.timezone);
    else if (isTimeOnlyPhrase(phrase)) {
      // A time with no day keeps the order's own day (and keeps it marked as a default if that is what it was).
      if (!current.date) ambiguities.push(`“${safe(phrase, 40)}” is a time but the order has no readable day.`);
      else stored = current.source === "default" || isDefaultedDay(order.requested_for) ? defaultedDayText(current.date, phrase) : `${dayLabel(current.date)} (${phrase})`;
    } else ambiguities.push(`I could not read “${safe(phrase, 40)}” as one day. Give a day or date, e.g. “tomorrow morning” or “30 Oct”.`);
    if (stored && stored !== order.requested_for) {
      push("requested_for", whenText(order.requested_for, order.first_message_at, ctx.timezone), whenText(stored, order.first_message_at, ctx.timezone), order.requested_for, stored);
    }
  }

  // Notes: the alternate contact number and any instruction worth keeping, both added to what is there, never replacing it.
  let notes = order.notes;
  if (proposal.contact_phone) {
    const digits = proposal.contact_phone.replace(/\D/g, "");
    const own = (order.contact_number ?? "").slice(-7);
    if (digits.length < 7 || digits.length > 15 || !instruction.replace(/\D/g, "").includes(digits)) ambiguities.push(`The number ${safe(proposal.contact_phone, 20)} is not clearly in what you wrote.`);
    else if (!own || digits.slice(-7) !== own) notes = withDeliveryContact(notes, digits);
  }
  if (proposal.note) {
    const note = safe(proposal.note, 300);
    if (overlap(said, note) === 0) ambiguities.push(`The note “${safe(note, 40)}” is not in what you wrote.`);
    else if (!(notes ?? "").toLowerCase().includes(note.toLowerCase())) notes = [notes, note].filter(Boolean).join(" · ").slice(0, 1000);
  }
  if (notes !== order.notes) push("notes", order.notes ? safe(order.notes, 80) : "none", safe(notes, 160), order.notes, notes);

  const reusable = GENERAL_CUE.test(instruction) ? proposal.reusable.filter((r) => overlap(said, r.text) >= 0.5 && !/\d{6,}/.test(r.text)) : [];
  return { changes, patch, ambiguities: [...new Set(ambiguities)].slice(0, 5), reusable };
}

// ── Reply text ───────────────────────────────────────────────────────────────

const labelOf = (o: TrackedOrder, names?: OrderNames) => `${displayRef(o.ref_code)} (${clip(safe(orderDisplayName(o, names) ?? formatPhone(o.contact_number) ?? "customer", 30), 30)})`;
const minutes = (ms: number) => Math.round(ms / 60_000);

export const TEACH_HELP = [
  "ℹ️ !order #REF teach <what is wrong or should change> — tell me in your own words.",
  "e.g. !order #ZWL67 teach The address is Cap Estate and the food is 1 Bandit 25kg",
  "I show a before/after and change nothing until you reply !confirm C-CODE (or !discard C-CODE).",
  "The customer is never messaged. Use the order code (#REF), not a name.",
].join("\n");

export const CORRECTION_REPLY = {
  preview: (o: TrackedOrder, names: OrderNames | undefined, plan: CorrectionPlan, code: string, instruction: string) =>
    [
      `✏️ *Proposed correction — ${labelOf(o, names)}*`,
      `You said: “${safe(instruction, 160)}”`,
      ...plan.changes.map((c) => `• ${c.label}: ${c.before} → *${c.after}*${c.wasLocked ? " (replaces a value staff set earlier)" : ""}`),
      ...(o.status === "confirmed" ? ["⚠️ This order is already confirmed."] : []),
      `Nothing has changed yet. Apply: !confirm ${code} · Cancel: !discard ${code}`,
      `Valid for ${minutes(CORRECTION_TTL_MS)} minutes. The customer is not messaged.`,
    ].join("\n"),
  ambiguous: (o: TrackedOrder, names: OrderNames | undefined, ambiguities: string[]) =>
    [`❓ I could not safely turn that into a change for ${labelOf(o, names)}. Nothing changed.`, ...ambiguities.map((a) => `• ${a}`), "Say it again with the exact product, quantity, place or day.", "Example: !order #REF teach Jason wants 2 Birbo Meat 25kg delivered to Gros Islet"].join("\n"),
  nothing: (o: TrackedOrder, names: OrderNames | undefined) => `ℹ️ ${labelOf(o, names)} already matches that — nothing to change.`,
  unavailable: () => "⚠️ I could not read that instruction right now (the assistant is unavailable). Nothing changed. Try again, or use !order #REF …",
  closed: (o: TrackedOrder) => `ℹ️ ${displayRef(o.ref_code)} is ${o.status === "fulfilled" ? "completed" : o.status} — it cannot be corrected. Reopen it first if needed (!order ${displayRef(o.ref_code)} reopen).`,
  applied: (o: TrackedOrder, names: OrderNames | undefined, plan: PlannedChange[], reusable: ReusableSuggestion[]) =>
    [
      `✅ ${labelOf(o, names)} corrected: ${plan.map((c) => c.label.toLowerCase()).join(", ")}. The customer was not messaged.`,
      "These values are now staff-set: later customer messages cannot overwrite them.",
      ...(reusable.length > 0
        ? [
            "💡 Reusable? Nothing is saved from this. Only if you want it kept:",
            ...reusable.map((r) => (r.scope === "customer" ? `• this customer: !remember ${displayRef(o.ref_code)} ${safe(r.text, 120)}` : `• whole business: !teach ${safe(r.text, 120)}`)),
          ]
        : []),
    ].join("\n"),
  alreadyApplied: (code: string) => `ℹ️ ${code} was already applied — nothing more to do.`,
  discarded: (code: string) => `🗑 ${code} discarded. Nothing changed.`,
  alreadyDiscarded: (code: string) => `ℹ️ ${code} was already discarded.`,
  expired: (code: string) => `⌛ ${code} expired, so nothing was applied. Send the correction again.`,
  superseded: (code: string) => `ℹ️ ${code} was replaced by a newer proposal for the same order — nothing applied. Use the newest code.`,
  stale: (code: string, o: TrackedOrder) => `⚠️ ${displayRef(o.ref_code)} changed since ${code} was proposed — nothing applied. Check !order ${displayRef(o.ref_code)} and send the correction again.`,
  unknown: (code: string) => `⚠️ No open proposal ${code} in this business. Nothing changed.`,
  wrongGroup: (code: string) => `⚠️ ${code} was proposed in another group — nothing applied.`,
  busy: (code: string) => `ℹ️ ${code} is being applied right now — wait a moment.`,
  failed: () => "⚠️ The order could not be updated right now. Nothing changed.",
};

// ── Bulk completion ──────────────────────────────────────────────────────────

export interface BulkScope {
  /** Open orders for TODAY (the business's local day). The only ones a completion may touch. */
  today: TrackedOrder[];
  /** Open orders deliberately left alone, by why. */
  excluded: { tomorrow: number; later: number; overdue: number; undated: number };
}

export function bulkScope(orders: TrackedOrder[], ctx: DayContext): BulkScope {
  const scope: BulkScope = { today: [], excluded: { tomorrow: 0, later: 0, overdue: 0, undated: 0 } };
  const byDate = (a: TrackedOrder, b: TrackedOrder) => Date.parse(a.first_message_at) - Date.parse(b.first_message_at);
  for (const o of orders) {
    if (!isOpenStatus(o.status)) continue;
    const bucket = bucketOf(o, ctx);
    // An order waiting for review is not an order yet: a bulk completion never touches it.
    if (bucket === "review") continue;
    if (bucket === "today") scope.today.push(o);
    else scope.excluded[bucket] += 1;
  }
  scope.today.sort(byDate);
  return scope;
}

/** The day an order is for, used to check at confirm time that it is still the order that was previewed. */
export const orderDay = (o: TrackedOrder, timezone: string) => orderDate(o, timezone);

export interface BulkPayload {
  /** YYYY-MM-DD: the day the preview covered. */
  date: string;
  orders: { id: string; ref: string; version: number }[];
}

const STATE_BADGE: Record<string, string> = { confirmed: "confirmed", awaiting_confirmation: "to confirm", possible: "incomplete" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_LISTED = 20;

export const BULK_HELP = [
  "ℹ️ !orders complete all — mark today's outstanding orders completed in one go.",
  "I list them first and change nothing until you reply !confirm B-CODE (or !discard B-CODE).",
  "Only today's orders are included — never tomorrow's, overdue, later or undated ones.",
].join("\n");

export const BULK_REPLY = {
  preview: (args: { code: string; dateKey: string; scope: BulkScope; names?: OrderNames }) => {
    const { code, dateKey, scope, names } = args;
    const listed = scope.today.slice(0, MAX_LISTED);
    const unconfirmed = scope.today.filter((o) => o.status !== "confirmed").length;
    const left = Object.entries({ tomorrow: scope.excluded.tomorrow, later: scope.excluded.later, overdue: scope.excluded.overdue, "no clear day": scope.excluded.undated })
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    return [
      `✅ *Complete all of today's outstanding orders — ${dayLabel(dateKey)}*`,
      `${plural(scope.today.length, "order")} will be marked *completed (fulfilled)*:`,
      ...listed.map((o, i) => `${i + 1}. ${clip(safe(orderDisplayName(o, names) ?? formatPhone(o.contact_number) ?? "customer", 30), 30)} · ${displayRef(o.ref_code)} · ${STATE_BADGE[o.status] ?? o.status}`),
      ...(scope.today.length > listed.length ? [`…and ${scope.today.length - listed.length} more`] : []),
      ...(unconfirmed > 0 ? [`⚠️ ${plural(unconfirmed, "order")} not confirmed yet — they would be completed too.`] : []),
      ...(left.length > 0 ? [`Left alone: ${left.join(", ")}.`] : []),
      "Completed means fulfilled — delivered or collected — not just hidden. Orders leave !orders but stay in history; undo one with !order #REF reopen.",
      "Customers are NOT messaged and nothing is dispatched.",
      `Apply: !confirm ${code} · Cancel: !discard ${code}`,
      `Valid for ${minutes(BULK_TTL_MS)} minutes; orders that change before then are skipped.`,
    ].join("\n");
  },
  none: (dateKey: string, excluded: BulkScope["excluded"]) => {
    const left = excluded.tomorrow + excluded.later + excluded.overdue + excluded.undated;
    return `✅ Nothing outstanding for today (${dayLabel(dateKey)}) — nothing to complete.${left > 0 ? ` ${plural(left, "other open order")} left alone (see !orders all).` : ""}`;
  },
  discarded: (code: string) => `🗑 ${code} discarded. No order was completed.`,
};

export type BulkOutcome = "completed" | "already_completed" | "skipped" | "failed";
export interface BulkLine {
  ref: string;
  outcome: BulkOutcome;
  reason?: string;
}

export function bulkResultText(code: string, lines: BulkLine[], dateKey: string): string {
  const by = (o: BulkOutcome) => lines.filter((l) => l.outcome === o);
  const done = by("completed");
  const already = by("already_completed");
  const skipped = by("skipped");
  const failed = by("failed");
  return [
    `${failed.length > 0 ? "⚠️" : "✅"} *Bulk completion ${code} — ${dayLabel(dateKey)}*`,
    `Completed: ${done.length}${already.length > 0 ? ` (+${already.length} already completed)` : ""}`,
    ...(skipped.length > 0 ? [`Skipped: ${skipped.length}`, ...skipped.slice(0, 8).map((l) => `• ${displayRef(l.ref)} — ${l.reason ?? "changed"}`)] : []),
    ...(failed.length > 0 ? [`Failed: ${failed.length}`, ...failed.slice(0, 8).map((l) => `• ${displayRef(l.ref)} — ${l.reason ?? "error"}`), `Nothing was lost: !confirm ${code} again retries only the failed ones.`] : []),
    "Completed = fulfilled. The orders left !orders; history is kept (!order #REF reopen undoes one). Customers were not messaged.",
  ].join("\n");
}

export const BULK_STATE_REPLY = {
  alreadyApplied: (code: string) => `ℹ️ ${code} was already applied — nothing more to do.`,
  expired: (code: string) => `⌛ ${code} expired, so no order was completed. Send !orders complete all again.`,
  superseded: (code: string) => `ℹ️ ${code} was replaced by a newer !orders complete all — use the newest code. Nothing applied.`,
};
