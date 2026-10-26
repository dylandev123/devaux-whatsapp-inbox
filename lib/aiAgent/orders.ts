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

/** A customer message that contradicts a staff-locked field: the value they proposed beside the value staff set. */
export interface FieldConflict {
  proposed: unknown;
  current: unknown;
  at: string;
}
export type FieldConflicts = Partial<Record<EditableOrderField, FieldConflict>>;

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
  /** What the customer asked for in a field staff had locked, by field. Never applied: a person resolves it. */
  field_conflicts: FieldConflicts;
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
  history_unresolved: "Customer referred to an earlier order or place that could not be matched safely — please check",
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

const compatible = (a: string | null | undefined, b: string | null | undefined) => !a || !b || norm(a) === norm(b);

/** The same product line: same product, and variant/size that do not contradict each other (a blank one is compatible). */
export function sameLineProduct(a: OrderLine, b: OrderLine): boolean {
  return productKey(a.product) === productKey(b.product) && compatible(a.variant, b.variant) && compatible(a.size, b.size);
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
  customerName: string | null = null,
  /** Says whether the customer stated this value in the CURRENT turn (a cumulative draft also repeats older words). */
  statedNow?: (field: EditableOrderField, proposed: unknown) => boolean
): { fields: OrderFields; changes: FieldChange[]; conflicts: FieldChange[] } {
  const base = existing ?? emptyFields();
  const isLocked = (f: EditableOrderField) => locked.includes(f);
  const fields: OrderFields = { ...base, items: [...base.items] };
  const changes: FieldChange[] = [];
  const conflicts: FieldChange[] = [];
  const set = <K extends EditableOrderField>(field: K, next: OrderFields[K], same: boolean) => {
    if (same) return;
    if (isLocked(field)) {
      // The staff value stays. A customer who now says something else is recorded, never applied.
      if (statedNow?.(field, next)) conflicts.push({ field, before: base[field], after: next });
      return;
    }
    changes.push({ field, before: base[field], after: next });
    fields[field] = next;
  };

  if (draft.items.length > 0) {
    const lines = draft.items.map(toLine);
    if (!isLocked("items")) set("items", lines, sameLines(lines, base.items));
    else {
      // Staff locked the products. A product that is simply new, or a detail staff left blank, is still added: that is
      // not a contradiction. Only a changed quantity or a withdrawn product contradicts the staff value.
      const filled = base.items.map((b) => {
        const d = lines.find((l) => sameLineProduct(b, l));
        return d ? { product: b.product, quantity: b.quantity ?? d.quantity, variant: b.variant ?? d.variant, size: b.size ?? d.size } : b;
      });
      const added = lines.filter((l) => !base.items.some((b) => sameLineProduct(b, l)));
      const next = [...filled, ...added];
      if (!sameLines(next, base.items)) {
        changes.push({ field: "items", before: base.items, after: next });
        fields.items = next;
      }
      const changedQuantity = base.items.some((b) => lines.some((l) => sameLineProduct(b, l) && b.quantity && l.quantity && norm(b.quantity) !== norm(l.quantity)));
      const withdrawn = base.items.some((b) => !lines.some((l) => sameLineProduct(b, l)));
      if (withdrawn || (changedQuantity && statedNow?.("items", lines))) conflicts.push({ field: "items", before: next, after: lines });
    }
  }
  if (draft.delivery_address) set("delivery_address", draft.delivery_address, norm(draft.delivery_address) === norm(base.delivery_address));
  if (draft.requested_for) set("requested_for", draft.requested_for, norm(draft.requested_for) === norm(base.requested_for));
  if (draft.notes) set("notes", draft.notes, norm(draft.notes) === norm(base.notes));
  const method = fulfilmentMethod(draft.delivery_preference);
  if (method) set("fulfilment_method", method, method === base.fulfilment_method);
  if (draft.delivery_preference && !isLocked("fulfilment_method")) fields.delivery_preference = draft.delivery_preference;
  if (!base.customer_name && customerName) fields.customer_name = customerName;
  return { fields, changes, conflicts };
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
  const product = `${safe(l.product, 80)}${detail ? ` (${detail})` : ""}`;
  return l.quantity ? `${safe(l.quantity, 20)} × ${product}` : `${product} — quantity needed`;
}


export function isStale(o: Pick<TrackedOrder, "status" | "last_message_at" | "updated_at">, now: Date): boolean {
  if (o.status === "confirmed") return false;
  const last = Date.parse(o.last_message_at);
  return !Number.isNaN(last) && now.getTime() - last > STALE_AFTER_DAYS * 86_400_000;
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


// ── Compact references, phones and names ─────────────────────────────────────

/** "O-QU6U9" → "#QU6U9". The reference never changes after the order is created, so it is what staff type back. */
export const displayRef = (refCode: string): string => `#${refCode.replace(/^O-/i, "")}`;

const REF_TOKEN = /^#?(?:O-)?([A-HJ-NP-Z2-9]{5})$/i;

/** "#QU6U9", "qu6u9" and "O-QU6U9" are the same order. Returns the stored reference ("O-QU6U9") or null. */
export function parseOrderRef(token: string): string | null {
  const m = token.trim().match(REF_TOKEN);
  return m ? `O-${m[1].toUpperCase()}` : null;
}

/** St Lucia numbers read as staff say them (286-7466); other NANP and international numbers keep their country code. */
export function formatPhone(digits: string | null | undefined): string | null {
  const d = (digits ?? "").replace(/\D/g, "");
  if (d.length < 7) return null;
  if (/^1758\d{7}$/.test(d)) return `${d.slice(4, 7)}-${d.slice(7)}`;
  if (/^1\d{10}$/.test(d)) return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return `+${d}`;
}

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const PLACEHOLDER_NAMES = new Set(["unknown", "unknown contact", "unknown customer", "whatsapp user", "whatsapp", "customer", "n/a", "na", "none", "null", "undefined"]);

/** A name safe to show: not a number or a JID, not a placeholder, not symbols or emoji only, not absurdly long. */
export function isReliableName(value: string | null | undefined): boolean {
  const t = (value ?? "").replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 60) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/@(s\.whatsapp\.net|lid|c\.us|g\.us)\b/i.test(t) || /^\+?[\d\s()-]{6,}$/.test(t)) return false;
  if (PLACEHOLDER_NAMES.has(t.toLowerCase())) return false;
  if (/^(.)\1+$/u.test(t)) return false;
  return true;
}

const cleanName = (value: string | null | undefined): string | null =>
  isReliableName(value) ? (value ?? "").replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[!/]+/, "") : null;

export type NameSource = "staff" | "saved" | "profile";

export interface ResolvedName {
  /** The best reliable name, or null (the phone is the fallback). */
  name: string | null;
  source: NameSource | null;
  /** Every reliable name known for this customer, for searching. */
  all: string[];
}

export interface NameSources {
  /** The order's own name when staff edited it (a locked field). */
  orderNameLocked?: string | null;
  /** First + last name entered on the customer's profile by staff. */
  crmName?: string | null;
  /** The name saved for this contact on the linked phone (Baileys Contact.name). */
  savedName?: string | null;
  /** The customer's own WhatsApp profile name (pushName). */
  profileName?: string | null;
  /** The name the order recorded when it was created (origin unknown). */
  orderName?: string | null;
}

/** Staff-entered name first, then the saved contact name, then the WhatsApp profile name. Unreliable values never win. */
export function pickCustomerName(s: NameSources): ResolvedName {
  const tiers: [NameSource, string | null | undefined][] = [
    ["staff", s.orderNameLocked],
    ["staff", s.crmName],
    ["saved", s.savedName],
    ["profile", s.profileName],
    ["profile", s.orderName],
  ];
  const usable = tiers.map(([source, v]) => [source, cleanName(v)] as const).filter((t): t is readonly [NameSource, string] => Boolean(t[1]));
  const all = [...new Set(usable.map((t) => t[1]))];
  return usable.length > 0 ? { name: usable[0][1], source: usable[0][0], all } : { name: null, source: null, all };
}

// ── The daily report ─────────────────────────────────────────────────────────

/** One WhatsApp message stays well inside the outbox limit; longer reports become numbered parts. */
const MAX_PART_CHARS = 3500;
const MAX_REPORT_PARTS = 6;

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const titleDate = (dateKey: string) => {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]}`;
};

/**
 * The only reasons the WhatsApp report interrupts a block: each could make someone fulfil the wrong thing. Everything else
 * (missing details, "needs confirmation", a recorded yes, technical conflict wording) lives in the dashboard and !moreinfo.
 */
const REPORT_ATTENTION: Record<string, string> = {
  changed_after_confirmation: "Changed after confirmation — re-confirm",
  cancellation_requested: "Customer may want to cancel",
  check_if_duplicate: "May be a duplicate order",
  staff_cancelled_in_chat: "Staff cancelled in chat — verify",
  staff_changed_in_chat: "Staff changed it in chat — check",
  history_unresolved: "Refers to an earlier order — check",
};

export const CONFLICT_LABEL: Record<EditableOrderField, string> = {
  customer_name: "name",
  items: "products",
  fulfilment_method: "delivery/collection",
  delivery_address: "address",
  requested_for: "day/time",
  notes: "note",
};

/** The locked fields the customer has since contradicted. */
export function conflictFields(o: Pick<TrackedOrder, "field_conflicts">): EditableOrderField[] {
  return (Object.keys(o.field_conflicts ?? {}) as EditableOrderField[]).filter((f) => o.field_conflicts[f]);
}

/** One value as a person reads it ("2 × Monello; …", "delivery", "Fri 30 Oct"). */
export function conflictValueText(field: EditableOrderField, v: unknown, max = 60): string {
  if (v === null || v === undefined || v === "") return "—";
  const text = field === "items" && Array.isArray(v) ? v.map((l) => orderItemText(l as OrderLine)).join("; ") : String(v);
  return safe(text, max);
}

/** "Customer now says day/time: Fri 30 Oct (staff set Thu 29 Oct)". */
export function conflictText(field: EditableOrderField, c: FieldConflict, max = 60): string {
  return `${CONFLICT_LABEL[field]}: ${conflictValueText(field, c.proposed, max)} (staff set ${conflictValueText(field, c.current, max)})`;
}

/** The one warning the report may show for an order, or null. A contradicted staff value outranks everything else. */
export function orderWarning(o: Pick<TrackedOrder, "attention"> & Partial<Pick<TrackedOrder, "field_conflicts">>): string | null {
  if (o.field_conflicts && conflictFields({ field_conflicts: o.field_conflicts }).length > 0) return "Customer asked for a change — check before fulfilling";
  return o.attention ? (REPORT_ATTENTION[o.attention] ?? null) : null;
}

/** "1 × Monello Chicken 25kg": product, variant and size read as one product name. */
export function orderItemText(l: OrderLine): string {
  return l.quantity ? `${safe(l.quantity, 20)} × ${orderProductText(l)}` : `${orderProductText(l)} — quantity needed`;
}

/** "Monello Chicken 25kg": product, variant and size, without repeating what the product name already says. */
export function orderProductText(l: OrderLine): string {
  const product = safe(l.product, 80);
  const have = normalizeText(product);
  const extras = [l.variant, l.size].map((v) => safe(v, 40)).filter((v) => v && !have.includes(normalizeText(v)));
  return [product, ...extras].join(" ");
}

function fulfilmentLine(o: TrackedOrder): string | null {
  const when = o.requested_for ? safe(o.requested_for, 80) : "";
  if (o.fulfilment_method === "delivery") {
    const parts = [o.delivery_address ? safe(o.delivery_address, 120) : "", when].filter(Boolean);
    return parts.length > 0 ? `Delivery: ${parts.join(" · ")}` : "Delivery";
  }
  if (o.fulfilment_method === "collection") return when ? `Collection: ${when}` : "Collection";
  return when ? `Wanted: ${when}` : null;
}

export interface OrderNames {
  [orderId: string]: ResolvedName | undefined;
}

/** The name an order is listed under: the resolved one, else a reliable name the order itself holds, else null. */
export function orderDisplayName(o: Pick<TrackedOrder, "id" | "customer_name">, names?: OrderNames): string | null {
  return names?.[o.id]?.name ?? cleanName(o.customer_name);
}

/** A product line as the report reads it: only what is known, so an unknown quantity is just the product name. */
export function reportItemText(l: OrderLine): string {
  return l.quantity ? `${safe(l.quantity, 20)} × ${orderProductText(l)}` : orderProductText(l);
}

/** One order as it reads in the staff group: known facts only. `status` adds a Confirmed/Open line (used by search, not the report). */
export function orderBlock(o: TrackedOrder, index: number | null, names?: OrderNames, opts: { status?: boolean } = {}): string {
  const phone = formatPhone(o.contact_number);
  const name = orderDisplayName(o, names);
  const lead = index === null ? "" : `${index}. `;
  const lines = [`*${lead}${name ?? phone ?? "Unknown customer"} · ${displayRef(o.ref_code)}*`];
  if (opts.status) lines.push(o.status === "confirmed" ? "Confirmed" : "Open");
  if (name && phone) lines.push(phone);
  if (o.items.length > 0) lines.push(...o.items.map(reportItemText));
  const how = fulfilmentLine(o);
  if (how) lines.push(how);
  if (o.notes) lines.push(`Note: ${safe(o.notes, 160)}`);
  const warning = orderWarning(o);
  if (warning) lines.push(`⚠️ ${warning}`);
  return lines.join("\n");
}

/** One line in the report for anything that makes the list incomplete, or null. */
export function coverageWarning(c: Coverage | undefined): string | null {
  if (!c) return null;
  if (!c.trackingOn) return "⚠️ Order tracking is OFF — this list may be incomplete.";
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const gaps: string[] = [];
  if (c.failedChats > 0) gaps.push(`${plural(c.failedChats, "chat", "chats")} could not be analysed`);
  if ((c.budgetChats ?? 0) > 0) gaps.push(`${plural(c.budgetChats ?? 0, "chat", "chats")} hit the analysis limit`);
  if ((c.notForwardedMessages ?? 0) > 0) gaps.push(`${plural(c.notForwardedMessages ?? 0, "message", "messages")} never reached the agent`);
  return gaps.length > 0 ? `⚠️ May be incomplete: ${gaps.join(", ")}. Check the inbox.` : null;
}

export interface SummaryInput {
  timezone: string;
  now: Date;
  /** Every outstanding (possible / awaiting / confirmed) order of THIS business, from the database. */
  orders: TrackedOrder[];
  /** Best names by order id (loadOrderNames); orders without one fall back to the phone. */
  names?: OrderNames;
  coverage?: Coverage;
  /** Accepted for older callers; the report no longer prints either. */
  businessLabel?: string;
  trigger?: "scheduled" | "manual";
}

export interface SummaryResult {
  /** The whole report (parts joined). */
  text: string;
  /** What is actually sent: one WhatsApp message per entry, numbered "(1/2)" when there is more than one. */
  parts: string[];
  confirmed: number;
  attention: number;
  carriedForward: number;
  omittedStale: number;
  truncated: number;
}

export function buildOrderSummary(input: SummaryInput): SummaryResult {
  const { timezone: tz, now } = input;
  const today = localParts(now, tz).dateKey;
  const all = input.orders.filter((o) => isOpenStatus(o.status));
  const live = all.filter((o) => !isStale(o, now));
  const omittedStale = all.length - live.length;
  const byAge = (a: TrackedOrder, b: TrackedOrder) => Date.parse(a.first_message_at) - Date.parse(b.first_message_at);
  // "Confirmed" means a person (or the customer's own yes, when allowed) confirmed it: nothing else, whatever the warnings.
  const confirmed = live.filter((o) => o.status === "confirmed").sort(byAge);
  const open = live.filter((o) => o.status !== "confirmed").sort(byAge);
  const carriedForward = live.filter((o) => localParts(new Date(o.first_message_at), tz).dateKey < today).length;

  const title = `📋 *DAILY ORDERS — ${titleDate(today)}*`;
  const count = (n: number) => `${n} ${n === 1 ? "order" : "orders"}`;
  const summaryLine = live.length === 0 ? "No outstanding orders." : `${count(live.length)} · ${confirmed.length} confirmed · ${open.length} open`;

  const footer: string[] = [];
  if (omittedStale > 0) footer.push(`${omittedStale} older unconfirmed ${omittedStale === 1 ? "enquiry" : "enquiries"} (${STALE_AFTER_DAYS}+ days) not shown.`);
  const gap = coverageWarning(input.coverage);
  if (gap) footer.push(gap);

  type Section = "confirmed" | "open";
  const entries = [...confirmed.map((o) => ({ o, section: "confirmed" as Section })), ...open.map((o) => ({ o, section: "open" as Section }))];
  const headingFor = (section: Section, cont: boolean) => `${section === "confirmed" ? "✅ *CONFIRMED*" : "📦 *OPEN ORDERS*"}${cont ? " (cont.)" : ""}`;

  const base = title.length + 10;
  const bodies: string[][] = [[]];
  let size = base + summaryLine.length + 2;
  let current: Section | null = null;
  let truncated = 0;
  for (const [i, e] of entries.entries()) {
    const block = orderBlock(e.o, i + 1, input.names);
    const heading = e.section !== current ? headingFor(e.section, false) : null;
    if (size + block.length + (heading?.length ?? 0) + 3 > MAX_PART_CHARS && bodies[bodies.length - 1].length > 0) {
      if (bodies.length >= MAX_REPORT_PARTS) {
        truncated = entries.length - i;
        break;
      }
      bodies.push([]);
      size = base;
      // A section that continues onto the next message says so.
      current = null;
    }
    const lead = e.section !== current ? (heading ?? headingFor(e.section, true)) : null;
    const body = bodies[bodies.length - 1];
    if (lead) {
      body.push(lead);
      size += lead.length + 1;
    }
    body.push(block);
    size += block.length + 2;
    current = e.section;
  }
  const tail = [...(truncated > 0 ? [`…and ${truncated} more ${truncated === 1 ? "order" : "orders"} — see the Orders page in the inbox.`] : []), ...footer];
  if (tail.length > 0) bodies[bodies.length - 1].push(tail.join("\n"));

  const total = bodies.length;
  const parts = bodies.map((body, i) => {
    const head = `${title}${total > 1 ? ` (${i + 1}/${total})` : ""}`;
    // Heading and blocks are separated by a single line break, blocks from each other by a blank line.
    const joined = body.map((chunk, j) => (j > 0 && /^(✅|📦) \*(CONFIRMED|OPEN ORDERS)\*/.test(body[j - 1]) ? `\n${chunk}` : `\n\n${chunk}`)).join("");
    return `${head}${i === 0 ? `\n${summaryLine}` : ""}${joined}`.trim();
  });
  return { text: parts.join("\n\n"), parts, confirmed: confirmed.length, attention: open.length, carriedForward, omittedStale, truncated };
}
