// Daily order tracking — pure functions, no I/O (like engine.ts), so they run under `npm test`.
//
// The database (ai_agent_orders) is the only source of truth. This module decides what a customer
// turn changes in it, when an order may count as confirmed, and how the morning report reads. The
// language model only supplies a DRAFT (the same cumulative order_request the agent already makes);
// every status change below is decided by rules over the customer's own words.
//
// Statuses
//   possible               something order-like was said; details are incomplete
//   awaiting_confirmation  every required detail is present; nobody has confirmed it yet
//   confirmed              the customer said an unambiguous "yes/confirm" to a complete order that
//                          staff/the agent had put in front of them, or staff confirmed it
//   fulfilled | cancelled  closed (never reopened by the AI)
//
// Nothing here prices, promises stock, or promises a delivery slot.

import type { AdditionalOrderDraft, OrderItem, OrderRequestDraft } from "./engine.ts";
import { isCollection } from "./engine.ts";
import { normalizeText, productKey } from "./escalationUpdates.ts";

export const ORDER_STATUSES = ["possible", "awaiting_confirmation", "confirmed", "fulfilled", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ["possible", "awaiting_confirmation", "confirmed"];
export const isOpenStatus = (s: string): s is OrderStatus => (OPEN_ORDER_STATUSES as readonly string[]).includes(s);

export type FulfilmentMethod = "delivery" | "collection";

export interface OrderLine {
  product: string;
  quantity: string | null;
  variant: string | null;
  size: string | null;
}

/** What staff and the AI can edit. */
export interface OrderFields {
  customer_name: string | null;
  items: OrderLine[];
  fulfilment_method: FulfilmentMethod | null;
  delivery_preference: string | null;
  delivery_address: string | null;
  requested_for: string | null;
  notes: string | null;
}

export const EDITABLE_ORDER_FIELDS = [
  "customer_name",
  "items",
  "fulfilment_method",
  "delivery_address",
  "requested_for",
  "notes",
] as const;
export type EditableOrderField = (typeof EDITABLE_ORDER_FIELDS)[number];

/** An ai_agent_orders row. */
export interface TrackedOrder extends OrderFields {
  id: string;
  ref_code: string;
  business_slug: string;
  chat_id: string;
  contact_number: string | null;
  status: OrderStatus;
  missing_fields: string[];
  attention: string | null;
  source_message_ids: string[];
  first_message_at: string;
  last_message_at: string;
  awaiting_since: string | null;
  manual_locked_fields: string[];
  confirmed_by: string | null;
  confirmed_at: string | null;
  /** The customer replied an unambiguous yes (recorded even when only staff may finalize). */
  customer_confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  fulfilled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export const ATTENTION_TEXT: Record<string, string> = {
  changed_after_confirmation: "Customer changed the order after it was confirmed — please re-confirm",
  cancellation_requested: "Customer may want to cancel — please check with them",
  check_if_duplicate: "May be a second copy of another order from this customer",
  customer_replied_yes: "Customer replied yes — staff to verify with them and confirm",
  staff_confirmed_in_chat: "Staff wrote a confirmation in WhatsApp — verify it and press Confirm",
  staff_cancelled_in_chat: "Staff wrote in WhatsApp that this was cancelled — verify and cancel it here",
  staff_changed_in_chat: "Staff wrote about changes to this order in WhatsApp — check the order",
  other_customer_note: "Needs a staff look",
};

// ── Field helpers ────────────────────────────────────────────────────────────

export const emptyFields = (): OrderFields => ({
  customer_name: null,
  items: [],
  fulfilment_method: null,
  delivery_preference: null,
  delivery_address: null,
  requested_for: null,
  notes: null,
});

export function fulfilmentMethod(preference: string | null | undefined): FulfilmentMethod | null {
  if (!preference) return null;
  if (isCollection(preference)) return "collection";
  if (/\bdeliver\w*|drop[\s-]?off|bring (it|them)|send (it|them)\b/i.test(preference)) return "delivery";
  return null;
}

const DELIVERY_WORDS = /\b(deliver\w*|drop[\s-]?(it |them )?off|bring (it|them)|send (it|them))\b/i;
const COLLECTION_WORDS = /\b(collect\w*|pick[\s-]?(it |them )?up|come (and )?(get|collect)|fetch)\b/i;

/**
 * The model's delivery_preference only survives if the customer said delivery (or collection) in some form:
 * "delivered", "drop it off", "I'll pick up". Plain word-overlap grounding would drop "delivery" for "delivered".
 */
export function groundDeliveryPreference(preference: string | null | undefined, customerTexts: string[]): string | null {
  const method = fulfilmentMethod(preference);
  if (!preference || !method) return null;
  const said = customerTexts.some((t) => (method === "delivery" ? DELIVERY_WORDS : COLLECTION_WORDS).test(t));
  return said ? preference : null;
}

export function toLine(item: OrderItem): OrderLine {
  return { product: item.product, quantity: item.quantity ?? null, variant: item.variant ?? null, size: item.size ?? null };
}

const norm = (v: string | null | undefined) => normalizeText(v ?? "");

export function sameLines(a: OrderLine[], b: OrderLine[]): boolean {
  if (a.length !== b.length) return false;
  const key = (l: OrderLine) => [productKey(l.product), norm(l.quantity), norm(l.variant), norm(l.size)].join("|");
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

const SOFT_FIELDS = new Set(["requested_for"]);

/** Everything still unknown. `requested_for` is reported but never blocks awaiting_confirmation. */
export function computeMissing(f: Pick<OrderFields, "items" | "fulfilment_method" | "delivery_address" | "requested_for">): string[] {
  const missing: string[] = [];
  if (f.items.length === 0) missing.push("items");
  else if (f.items.some((i) => !i.quantity)) missing.push("quantity");
  if (!f.fulfilment_method) missing.push("fulfilment_method");
  else if (f.fulfilment_method === "delivery" && !f.delivery_address) missing.push("delivery_address");
  if (!f.requested_for) missing.push("requested_for");
  return missing;
}

export const isComplete = (missing: string[]) => missing.every((m) => SOFT_FIELDS.has(m));

export const MISSING_TEXT: Record<string, string> = {
  items: "products",
  quantity: "quantity",
  fulfilment_method: "delivery or collection",
  delivery_address: "delivery address",
  requested_for: "day/time wanted",
};

export interface FieldChange {
  field: EditableOrderField;
  before: unknown;
  after: unknown;
}

/**
 * Folds the model's cumulative draft into an order. A field a person edited (locked) is never overwritten by the
 * AI. Items are replaced as a whole (the model returns the cumulative list); other fields change only when the
 * draft states a value.
 */
export function mergeDraft(
  existing: OrderFields | null,
  draft: OrderRequestDraft,
  locked: readonly string[] = [],
  customerName: string | null = null
): { fields: OrderFields; changes: FieldChange[] } {
  const base = existing ?? emptyFields();
  const isLocked = (f: EditableOrderField) => locked.includes(f);
  const fields: OrderFields = { ...base, items: [...base.items] };
  const changes: FieldChange[] = [];
  const set = <K extends EditableOrderField>(field: K, next: OrderFields[K], same: boolean) => {
    if (isLocked(field) || same) return;
    changes.push({ field, before: base[field], after: next });
    fields[field] = next;
  };

  if (draft.items.length > 0) {
    const lines = draft.items.map(toLine);
    set("items", lines, sameLines(lines, base.items));
  }
  if (draft.delivery_address) set("delivery_address", draft.delivery_address, norm(draft.delivery_address) === norm(base.delivery_address));
  if (draft.requested_for) set("requested_for", draft.requested_for, norm(draft.requested_for) === norm(base.requested_for));
  if (draft.notes) set("notes", draft.notes, norm(draft.notes) === norm(base.notes));
  const method = fulfilmentMethod(draft.delivery_preference);
  if (method) set("fulfilment_method", method, method === base.fulfilment_method);
  if (draft.delivery_preference && !isLocked("fulfilment_method")) fields.delivery_preference = draft.delivery_preference;
  if (!base.customer_name && customerName) fields.customer_name = customerName;
  return { fields, changes };
}

// ── Customer words ───────────────────────────────────────────────────────────

const CONFIRM_PATTERNS: RegExp[] = [
  /^(yes|yep|yeah|yea|yup)( please| thanks| thank you)?$/,
  /^(yes |yep |yeah )?(i )?confirm(ed)?( it| that| the order| my order| this)?( please)?$/,
  /^(yes |yep |yeah )?(please )?(go ahead|proceed)( please| with it| with the order)?$/,
  /^(yes )?(that s |that is |it s |this is )?(correct|right|perfect|exactly)( thanks| thank you)?$/,
  /^(yes )?that s (good|fine|all good)( thanks| thank you)?$/,
  /^(yes )?(the )?order is (correct|right|good)$/,
];

/**
 * A reply that can ONLY mean "yes, that is my order". Hedges ("ok", "sure", "I think so", "maybe"), anything
 * with a question or a change in it, and a thumbs-up on its own are NOT confirmations.
 */
export function isPureConfirmation(text: string): boolean {
  if (/[?]/.test(text)) return false;
  const t = normalizeText(text);
  if (!t || t.split(" ").length > 8) return false;
  if (/\b(not|no|dont|don t|wait|but|actually|change|instead|maybe|think|probably|later|tomorrow)\b/.test(t)) return false;
  return CONFIRM_PATTERNS.some((p) => p.test(t));
}

const ACK_ONLY = /^(thanks|thank you|thank u|thx|ty|ok|okay|great|cool|noted)$/;

/** Every message of the turn is a confirmation or a pleasantry, and at least one is a confirmation. */
export function turnIsConfirmation(segments: string[]): boolean {
  const real = segments.map((s) => s.trim()).filter(Boolean);
  if (real.length === 0) return false;
  let confirmed = false;
  for (const s of real) {
    if (isPureConfirmation(s)) confirmed = true;
    else if (!ACK_ONLY.test(normalizeText(s))) return false;
  }
  return confirmed;
}

const WHOLE_CANCEL = [
  /\bcancel(?:l?ed|l?ing)?\s+(?:my |the |that |this |our )?(?:whole |entire |full |complete )?(?:order|everything|all|it|them)\b/,
  /\b(?:call|calling) (?:it|the order|that) off\b/,
  /\b(?:forget|never ?mind)\b.{0,20}\b(?:order|it)\b/,
  /\b(?:don'?t|do not|no longer) (?:want|need) (?:it|the order|them|any of it)(?: any ?more)?\b/,
];
const PARTIAL_HINT = /\b(but|instead|except|only|just the|one of|the (?:other|second|first)|change|swap|replace|add|also)\b/;

/** The customer withdraws the whole order (not one item of it, not "cancel the delivery, I'll collect"). */
export function isWholeOrderCancellation(text: string): boolean {
  const t = text.toLowerCase();
  if (PARTIAL_HINT.test(t) || /\bdeliver\w*\b/.test(t)) return false;
  return WHOLE_CANCEL.some((p) => p.test(t));
}

// ── Which order does a turn belong to? ───────────────────────────────────────

export type OrderTarget =
  | { kind: "merge"; order: TrackedOrder; flag?: string }
  | { kind: "create"; flag?: string };

const productSet = (lines: OrderLine[]) => new Set(lines.map((l) => productKey(l.product)));

/**
 * `target` is the reference the model named (must be one of the customer's OPEN orders), "new", or null. A
 * reference the model made up is ignored. With several open orders and no valid reference nothing is guessed:
 * the draft joins an order only if it shares a product with it, else it starts a flagged new order.
 */
export function resolveOrderTarget(openOrders: TrackedOrder[], target: string | null | undefined, draft: OrderRequestDraft): OrderTarget {
  const named = target && target !== "new" ? openOrders.find((o) => o.ref_code.toLowerCase() === target.trim().toLowerCase()) : undefined;
  if (named) return { kind: "merge", order: named };

  const draftProducts = productSet(draft.items.map(toLine));
  const duplicate = openOrders.find((o) => {
    if (draftProducts.size === 0) return false;
    const mine = productSet(o.items);
    return mine.size === draftProducts.size && [...draftProducts].every((k) => mine.has(k)) && sameLines(o.items, draft.items.map(toLine));
  });
  // The same order again (a retry, a repeated message): never a second copy.
  if (duplicate) return { kind: "merge", order: duplicate };

  if (target === "new") return { kind: "create" };
  if (openOrders.length === 0) return { kind: "create" };
  if (openOrders.length === 1) return { kind: "merge", order: openOrders[0] };
  const overlapping = openOrders.filter((o) => [...productSet(o.items)].some((k) => draftProducts.has(k)));
  if (overlapping.length === 1) return { kind: "merge", order: overlapping[0] };
  return { kind: "create", flag: "check_if_duplicate" };
}

/** The drafts a turn produced, primary first, each with the reference the model attached it to. */
export function turnDrafts(proposal: {
  order_request: OrderRequestDraft | null;
  order_target?: string | null;
  other_orders?: AdditionalOrderDraft[];
}): { target: string | null; draft: OrderRequestDraft }[] {
  const out: { target: string | null; draft: OrderRequestDraft }[] = [];
  if (proposal.order_request) out.push({ target: proposal.order_target ?? null, draft: proposal.order_request });
  for (const o of proposal.other_orders ?? []) out.push({ target: o.target, draft: o.order });
  return out;
}

// ── Status transitions ───────────────────────────────────────────────────────

export interface PlanInput {
  existing: Pick<TrackedOrder, "status" | "attention" | "awaiting_since"> & { customer_confirmed_at?: string | null } | null;
  fields: OrderFields;
  /** The draft changed something (always true for a new order). */
  contentChanged: boolean;
  customerTexts: string[];
  /** Something was sent to the customer (staff, an approved draft) after the order became complete. */
  outboundSinceAwaiting: boolean;
  /** Rollout switch: may the customer's own yes finalize the order (true), or only be recorded for staff to verify (false)? */
  customerMayConfirm?: boolean;
  now: Date;
}

export interface Plan {
  status: OrderStatus;
  attention: string | null;
  awaitingSince: string | null;
  missing: string[];
  event: "created" | "ai_update" | "customer_confirmed" | "customer_replied_yes" | "customer_cancelled" | "attention_flagged" | "no_change";
  confirmedByCustomer: boolean;
  /** When the customer's yes was recorded (kept until the order's content changes). */
  customerConfirmedAt: string | null;
}

/**
 * Confirmation rules (all must hold): the order was already `awaiting_confirmation` and complete; this turn's
 * messages are ONLY an unambiguous yes/confirm; the turn changed nothing in the order; and something was sent to
 * the customer after the order became complete (so there was something to say yes to). An AI-written reply never
 * counts: only the customer's own words and a person's action do.
 */
export function planOrderUpdate(input: PlanInput): Plan {
  const { existing, fields, now } = input;
  const missing = computeMissing(fields);
  const complete = isComplete(missing);
  const nowIso = now.toISOString();
  const texts = input.customerTexts;
  const prevStatus: OrderStatus = existing?.status ?? "possible";
  let attention = existing?.attention ?? null;

  const wholeCancel = texts.some(isWholeOrderCancellation) && !input.contentChanged;
  if (existing && wholeCancel && (prevStatus === "possible" || prevStatus === "awaiting_confirmation")) {
    return { status: "cancelled", attention, awaitingSince: null, missing, event: "customer_cancelled", confirmedByCustomer: false, customerConfirmedAt: existing.customer_confirmed_at ?? null };
  }
  const cancelHint = texts.some((t) => /\bcancel\w*\b/i.test(t));
  if (existing && cancelHint && attention !== "cancellation_requested") attention = "cancellation_requested";

  if (existing && prevStatus === "awaiting_confirmation" && complete && !input.contentChanged && turnIsConfirmation(texts) && input.outboundSinceAwaiting) {
    if (input.customerMayConfirm) {
      return {
        status: "confirmed",
        attention: attention === "changed_after_confirmation" ? null : attention,
        awaitingSince: existing.awaiting_since,
        missing,
        event: "customer_confirmed",
        confirmedByCustomer: true,
        customerConfirmedAt: nowIso,
      };
    }
    // Rollout: the yes is recorded, but only a person can finalize it.
    const already = Boolean(existing.customer_confirmed_at);
    return {
      status: "awaiting_confirmation",
      attention: attention ?? "customer_replied_yes",
      awaitingSince: existing.awaiting_since,
      missing,
      event: already ? "no_change" : "customer_replied_yes",
      confirmedByCustomer: false,
      customerConfirmedAt: existing.customer_confirmed_at ?? nowIso,
    };
  }

  let status: OrderStatus = prevStatus;
  let awaitingSince = existing?.awaiting_since ?? null;
  if (!existing) {
    status = complete ? "awaiting_confirmation" : "possible";
    awaitingSince = complete ? nowIso : null;
  } else if (input.contentChanged) {
    if (prevStatus === "confirmed") {
      // What the customer confirmed is no longer what the order says.
      status = "awaiting_confirmation";
      attention = "changed_after_confirmation";
      awaitingSince = nowIso;
    } else {
      status = complete ? "awaiting_confirmation" : "possible";
      // A new or changed summary needs a fresh confirmation.
      awaitingSince = complete ? nowIso : null;
    }
  }
  if (!existing) return { status, attention, awaitingSince, missing, event: "created", confirmedByCustomer: false, customerConfirmedAt: null };
  // A change to what the customer said yes to voids that yes.
  if (input.contentChanged && attention === "customer_replied_yes") attention = null;
  const flagged = attention !== (existing.attention ?? null);
  const event = input.contentChanged ? "ai_update" : flagged ? "attention_flagged" : "no_change";
  return { status, attention, awaitingSince, missing, event, confirmedByCustomer: false, customerConfirmedAt: input.contentChanged ? null : (existing.customer_confirmed_at ?? null) };
}

// ── Schedule (timezone-aware) ────────────────────────────────────────────────

export const DEFAULT_ORDERS_TIMEZONE = "America/St_Lucia";
export const DEFAULT_SUMMARY_HOUR = 8;
/** A scheduled summary missed by more than this is recorded as missed, not sent (a "morning" report at night misleads). */
export const CATCH_UP_HOURS = 6;
/** Possible / awaiting orders with no customer activity for this long drop out of the report (still in the dashboard). */
export const STALE_AFTER_DAYS = 7;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  dateKey: string;
  minutes: number;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export type ScheduleState = { state: "not_yet" | "due" | "missed" | "done"; localDate: string };

/** What the scheduler should do right now for one business. `lastRunDate` = local date of the newest scheduled run. */
export function scheduleState(args: { now: Date; timezone: string; hour: number; lastRunDate: string | null }): ScheduleState {
  const { dateKey, minutes } = localParts(args.now, args.timezone);
  if (args.lastRunDate === dateKey) return { state: "done", localDate: dateKey };
  const start = args.hour * 60;
  if (minutes < start) return { state: "not_yet", localDate: dateKey };
  if (minutes >= start + CATCH_UP_HOURS * 60) return { state: "missed", localDate: dateKey };
  return { state: "due", localDate: dateKey };
}

// ── The !update command ──────────────────────────────────────────────────────

/** Exactly "!update" (case/spacing/punctuation tolerant). "!update the price" is not the command. */
export function isUpdateCommand(text: string): boolean {
  return /^!update\s*[.!]?\s*$/i.test(text.trim());
}

// ── The morning report ───────────────────────────────────────────────────────

const MAX_REPORT_CHARS = 3800;

function safe(value: string | null | undefined, max: number): string {
  // Customer-written text goes into a staff group: no control characters, and never a line that reads as a command.
  const t = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clipped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return clipped.replace(/^[!/]+/, "");
}

export function formatLine(l: OrderLine): string {
  const detail = [l.variant, l.size].filter(Boolean).map((v) => safe(v, 40)).join(", ");
  return `${l.quantity ? safe(l.quantity, 20) : "qty ?"} × ${safe(l.product, 80)}${detail ? ` (${detail})` : ""}`;
}

const displayPhone = (digits: string | null) => (digits ? `+${digits}` : "phone not verified");

function dayLabel(dateKey: string, tz: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function isStale(o: Pick<TrackedOrder, "status" | "last_message_at" | "updated_at">, now: Date): boolean {
  if (o.status === "confirmed") return false;
  const last = Date.parse(o.last_message_at);
  return !Number.isNaN(last) && now.getTime() - last > STALE_AFTER_DAYS * 86_400_000;
}

export function needsAttention(o: TrackedOrder): boolean {
  return o.status !== "confirmed" || Boolean(o.attention) || !isComplete(o.missing_fields);
}

/** What the report can honestly claim to cover. */
export interface Coverage {
  trackingOn: boolean;
  trackingSince: string | null;
  /** Kept for the dashboard. Order tracking no longer depends on it: every 1:1 customer conversation is read. */
  contactScope: string;
  /** Conversations in the window whose processing failed (or whose batch failed / is stuck). */
  failedChats: number;
  /** Conversations in the window the old rules skipped and monitoring did not pick up (before it was switched on). */
  skippedChats: number;
  /** Conversations not analysed because the hourly monitoring budget was used up. */
  budgetChats?: number;
  /** Messages the free pre-filter judged to carry no order wording (information only; not a gap). */
  filteredMessages?: number;
  /** Customer messages the bridge stored but never forwarded to the agent. */
  notForwardedMessages?: number;
  windowHours: number;
}

export function coverageLines(c: Coverage | undefined, tz: string): string[] {
  if (!c) return [];
  const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  const lines: string[] = [];
  if (!c.trackingOn) {
    lines.push("⚠️ *Incomplete:* order tracking is switched OFF for this business. New conversations are not being read for orders, so this list only shows orders recorded earlier or entered by staff. Do not treat it as complete.");
    return lines;
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (c.failedChats > 0) lines.push(`⚠️ ${plural(c.failedChats, "conversation", "conversations")} could not be analysed in the last ${c.windowHours} h (processing error). Orders there may be missing: check the inbox.`);
  if ((c.notForwardedMessages ?? 0) > 0) lines.push(`⚠️ ${plural(c.notForwardedMessages ?? 0, "customer message", "customer messages")} in the last ${c.windowHours} h reached the inbox but not the AI agent (bridge not forwarding). Orders in them may be missing: check the inbox.`);
  if ((c.budgetChats ?? 0) > 0) lines.push(`⚠️ ${plural(c.budgetChats ?? 0, "conversation was", "conversations were")} not analysed in the last ${c.windowHours} h because the hourly analysis limit was reached. Check the inbox.`);
  if (c.skippedChats > 0) lines.push(`ℹ️ ${plural(c.skippedChats, "conversation was", "conversations were")} handled in the last ${c.windowHours} h before every conversation was being read for orders. Orders there may be missing.`);
  if (c.trackingSince) lines.push(`ℹ️ Tracking has been on since ${day(c.trackingSince)}; earlier conversations were not analysed.`);
  if (!lines.some((l) => l.startsWith("⚠️"))) lines.push("Covers every customer chat the agent received, including ones the AI does not reply in.");
  return lines;
}

export function confirmationLabel(o: Pick<TrackedOrder, "confirmed_by" | "customer_confirmed_at">): string {
  if (o.confirmed_by === "customer") return "confirmed by the customer's reply";
  if (o.confirmed_by) return `verified by staff${o.customer_confirmed_at ? " (customer also replied yes)" : ""}`;
  return "confirmed";
}

export interface SummaryInput {
  businessLabel: string;
  timezone: string;
  now: Date;
  /** Every outstanding (possible / awaiting / confirmed) order of THIS business, from the database. */
  orders: TrackedOrder[];
  trigger: "scheduled" | "manual";
  coverage?: Coverage;
}

export interface SummaryResult {
  text: string;
  confirmed: number;
  attention: number;
  carriedForward: number;
  omittedStale: number;
  truncated: number;
}

const STATUS_TEXT: Record<OrderStatus, string> = {
  possible: "Possible order — details incomplete",
  awaiting_confirmation: "Awaiting customer confirmation",
  confirmed: "Confirmed",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

export function buildOrderSummary(input: SummaryInput): SummaryResult {
  const { timezone: tz, now } = input;
  const today = localParts(now, tz).dateKey;
  const all = input.orders.filter((o) => isOpenStatus(o.status));
  const live = all.filter((o) => !isStale(o, now));
  const omittedStale = all.length - live.length;
  const byAge = (a: TrackedOrder, b: TrackedOrder) => Date.parse(a.first_message_at) - Date.parse(b.first_message_at);
  const confirmed = live.filter((o) => !needsAttention(o)).sort(byAge);
  const attention = live.filter(needsAttention).sort(byAge);
  const carried = (o: TrackedOrder) => localParts(new Date(o.first_message_at), tz).dateKey < today;
  const carriedForward = live.filter(carried).length;

  const render = (o: TrackedOrder, compact: boolean): string => {
    const who = `${safe(o.customer_name, 60) || "Unnamed customer"} (${displayPhone(o.contact_number)})`;
    const head = `*${o.ref_code}* · ${who}`;
    const items = o.items.length > 0 ? o.items.map(formatLine).join("; ") : "no products yet";
    const carry = carried(o) ? ` ↪ carried forward from ${dayLabel(localParts(new Date(o.first_message_at), tz).dateKey, tz)}` : "";
    if (compact) return `${head}\n   ${items}${carry}`;
    const lines = [head, `   ${items}`];
    const how = o.fulfilment_method === "delivery" ? "Delivery" : o.fulfilment_method === "collection" ? "Collection" : "Delivery/collection not stated";
    const where = o.fulfilment_method === "delivery" && o.delivery_address ? ` — ${safe(o.delivery_address, 120)}` : "";
    const when = o.requested_for ? ` — ${safe(o.requested_for, 80)}` : "";
    lines.push(`   ${how}${where}${when}`);
    if (o.notes) lines.push(`   Note: ${safe(o.notes, 160)}`);
    const missing = o.missing_fields.filter((m) => m in MISSING_TEXT);
    if (missing.length > 0) lines.push(`   Missing: ${missing.map((m) => MISSING_TEXT[m]).join(", ")}`);
    if (needsAttention(o)) lines.push(`   Status: ${STATUS_TEXT[o.status]}`);
    else lines.push(`   Status: ${confirmationLabel(o)}`);
    if (o.attention) lines.push(`   ⚠ ${ATTENTION_TEXT[o.attention] ?? ATTENTION_TEXT.other_customer_note}`);
    if (carry) lines.push(`  ${carry}`);
    return lines.join("\n");
  };

  const when = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
  const header = [`📋 *Orders — ${safe(input.businessLabel, 60)}*`, `${when} · ${clock}${input.trigger === "manual" ? " · requested update" : ""}`];

  const build = (compact: boolean): { text: string; truncated: number } => {
    const out = [...header, ""];
    const coverage = coverageLines(input.coverage, tz);
    let budget = MAX_REPORT_CHARS - header.join("\n").length - 220 - coverage.join("\n").length;
    let truncated = 0;
    const section = (title: string, orders: TrackedOrder[]) => {
      out.push(`${title} (${orders.length})`);
      if (orders.length === 0) out.push("   None");
      for (const o of orders) {
        const block = render(o, compact);
        if (block.length + 1 > budget) {
          truncated += 1;
          continue;
        }
        budget -= block.length + 1;
        out.push(block);
      }
      out.push("");
    };
    section("✅ *CONFIRMED*", confirmed);
    section("⚠️ *NEEDS ATTENTION*", attention);
    if (truncated > 0) out.push(`…and ${truncated} more not shown — see the Orders page in the inbox.`);
    if (omittedStale > 0) out.push(`${omittedStale} older unconfirmed ${omittedStale === 1 ? "enquiry" : "enquiries"} (no reply for ${STALE_AFTER_DAYS}+ days) not listed.`);
    if (live.length === 0 && omittedStale === 0) out.push("No outstanding orders found.");
    if (coverage.length > 0) out.push("", ...coverage);
    return { text: out.join("\n").trim(), truncated };
  };

  let built = build(false);
  if (built.text.length > MAX_REPORT_CHARS || built.truncated > 0) built = build(true);
  return {
    text: built.text.slice(0, 4000),
    confirmed: confirmed.length,
    attention: attention.length,
    carriedForward,
    omittedStale,
    truncated: built.truncated,
  };
}
