// WhatsApp order commands — pure parsing, selector resolution and reply text (no I/O), unit-tested in
// tests/aiAgentOrderCommands.test.ts. The server side (lib/server/aiAgent/orders.ts handleOrderCommand) loads the
// orders, checks who may do what, and applies the change through the same code the Orders dashboard uses.
//
//   !orders [today|tomorrow|<date>|all|overdue|missing|undated|review]   what is outstanding, by the day it is for (read-only)
//   !order <name or phone>          search active orders
//   !order #QU6U9 / !moreinfo #QU6U9   full details of one order
//   !order #QU6U9 confirmed         staff-confirm one order
//   !order #QU6U9 cancelled         cancel it
//   !order #QU6U9 2 bags            change its quantity (single-product orders)
//   !order #QU6U9 delivery tomorrow    change the requested delivery date
//   !order #QU6U9 completed         mark it done (status "fulfilled"): it leaves !orders, its history stays
//   !order #QU6U9 reopen            undo an accidental completion
//   !order #QU6U9 teach <words>     correct an order in plain language: previewed, applied only after !confirm C-CODE
//   !orders complete all            complete today's outstanding orders: previewed, applied only after !confirm B-CODE
//   !confirm C-CODE / !discard C-CODE   (also B-CODE) apply or drop a proposal made by one of the two commands above
//
// "!update" was retired: its report is replaced by !orders (and the 8 AM summary), and its per-order actions now live under
// "!order #REF …" and need the order reference. A message that starts with "!update" is ordinary staff chatter again.
//
// A selector is a reference (#QU6U9), a phone number, or a customer name. Whatever it is, it must identify exactly ONE
// active order; with two or more matches nothing is changed and the choices are listed. No model is involved.

import { normalizeText } from "./escalationUpdates.ts";
import { addressProvenance, addressSourceLine } from "./orderAddress.ts";
import { type DateSource, effectiveDate, effectiveMethod } from "./orderDefaults.ts";
import { dayLabel, orderDate, parseOrdersView, timeOfDay, type OrdersView } from "./orderViews.ts";
import { BULK_HELP, MAX_INSTRUCTION, parseProposalCode, TEACH_HELP, type ProposalKind } from "./orderTeach.ts";
import {
  ATTENTION_TEXT,
  DEFAULT_ORDERS_TIMEZONE,
  conflictFields,
  conflictText,
  displayRef,
  formatPhone,
  type OrderNames,
  orderBlock,
  orderDisplayName,
  orderItemText,
  orderProductText,
  parseOrderRef,
  type ResolvedName,
  type TrackedOrder,
} from "./orders.ts";

export type Selector =
  | { type: "ref"; ref: string }
  | { type: "phone"; digits: string }
  | { type: "name"; text: string }
  /** The number shown in a !orders report (1–999): resolved against the stored list, never against a fresh query. */
  | { type: "number"; n: number };

export type UpdateAction =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "quantity"; quantity: number }
  | { type: "delivery"; when: string }
  | { type: "complete" }
  | { type: "reopen" };

export type OrderCommand =
  | { kind: "orders"; view: OrdersView }
  | { kind: "update"; selector: Selector; action: UpdateAction }
  | { kind: "search"; query: string }
  | { kind: "info"; selector: Selector }
  /** `!order #REF teach <instruction>`: a natural-language correction, proposed and then confirmed with a code. */
  | { kind: "teach"; selector: Selector; instruction: string }
  /** `!orders complete all`: today's outstanding orders, proposed and then confirmed with a code. */
  | { kind: "bulk_complete" }
  /** `!confirm C-ABCDE` / `!discard B-ABCDE` */
  | { kind: "proposal"; action: "confirm" | "discard"; code: string; proposalKind: ProposalKind }
  | { kind: "help"; reason: "order" | "moreinfo" | "orders" | "teach" | "complete_all" }
  /** "order #REF teach …" typed without the "!": answered with the corrected command, never acted on. */
  | { kind: "help"; reason: "no_bang"; suggestion: string };

/** The commands that propose or settle a proposal (handled by lib/server/aiAgent/orderCorrections.ts). */
export type CorrectionCommand = Extract<OrderCommand, { kind: "teach" | "bulk_complete" | "proposal" }>;
export const isCorrectionCommand = (c: OrderCommand): c is CorrectionCommand => c.kind === "teach" || c.kind === "bulk_complete" || c.kind === "proposal";

const MAX_SELECTOR = 60;

/** A reference, a phone number (6+ digits) or a name. Empty or silly input is not a selector. */
export function parseSelector(raw: string): Selector | null {
  const text = raw.replace(/^["'“‘]+|["'”’]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_SELECTOR) return null;
  if (/^\d{1,3}$/.test(text) && Number(text) >= 1) return { type: "number", n: Number(text) };
  const ref = parseOrderRef(text);
  if (ref && /^#|^O-/i.test(text)) return { type: "ref", ref };
  if (/^\+?[\d\s()-]+$/.test(text)) {
    const digits = text.replace(/\D/g, "");
    return digits.length >= 6 && digits.length <= 15 ? { type: "phone", digits } : null;
  }
  // A bare five-letter code is only a reference when it cannot be a name: it has a digit.
  if (ref && /\d/.test(text)) return { type: "ref", ref };
  return /\p{L}/u.test(text) && !text.startsWith("!") ? { type: "name", text } : null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const QUANTITY_BODY = new RegExp(String.raw`^(?:(?:qty|quantity|x)\s*(\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})|(\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\s*(?:bags?|sacks?|boxe?s?|units?|pcs|pieces?|x))$`, "i");

/** The action part of "!order #REF <action>": confirmed, cancelled, "2 bags", "delivery tomorrow". Null when it is none of those. */
function parseOrderAction(body: string): UpdateAction | null {
  const text = body.replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
  let m = text.match(/^deliver(?:y|ed)?(?:\s+(?:date|on|for|by))?\s+(.+)$/i);
  if (m) return m[1].trim().length <= 100 ? { type: "delivery", when: m[1].trim() } : null;
  if (/^(?:confirm|confirmed)$/i.test(text)) return { type: "confirm" };
  if (/^(?:cancel|cancelled|canceled)$/i.test(text)) return { type: "cancel" };
  m = text.match(QUANTITY_BODY);
  if (m) {
    const word = (m[1] ?? m[2]).toLowerCase();
    const quantity = NUMBER_WORDS[word] ?? Number(word);
    return quantity >= 1 && quantity <= 999 ? { type: "quantity", quantity } : null;
  }
  return null;
}

/**
 * Recognises the order commands. Returns null for anything else, which is handed on to the existing escalation and
 * Approval Pilot commands untouched. "!moreinfo" is an order command only when it names an order reference
 * (#QU6U9); "!moreinfo" alone, or with an escalation code (#E-AB12C), stays with the escalation logic.
 */
export function parseOrderCommand(raw: string, opts: { now?: Date; timezone?: string | null } = {}): OrderCommand | null {
  // "! order #REF …" (a space after the bang) is the same command.
  const text = raw.replace(/\s+/g, " ").trim().replace(/^!\s+(?=orders?\b|more[\s-]*info\b|confirm\b|discard\b)/i, "!");
  // "order #QU6U9 teach …" / "order 3 completed" without the "!": staff chatter is left alone unless it is unmistakably this command.
  const bangless = text.match(/^(orders?)\s+(#?[A-HJ-NP-Z2-9]{5}|#[A-Z0-9]{3,8}|\d{1,3})\s+(teach|confirm\w*|cancel\w*|complete\w*|reopen\w*|delivery|deliver)\b/i);
  if (bangless && (bangless[2].startsWith("#") || /\d/.test(bangless[2]))) return { kind: "help", reason: "no_bang", suggestion: `!${text}`.slice(0, 160) };
  // "!confirm C-ABCDE" / "!discard B-ABCDE": only OUR codes. K- (knowledge), M- (notes) and E- (requests) stay with their own
  // commands, so "!confirm K-7QX2" never reaches an order and "!confirm C-ABCDE" never reaches the knowledge flow.
  let m = text.match(/^!(confirm|discard)\s+(\S+)$/i);
  if (m) {
    const code = parseProposalCode(m[2]);
    return code ? { kind: "proposal", action: m[1].toLowerCase() as "confirm" | "discard", code: code.code, proposalKind: code.kind } : null;
  }
  // "!orders" is the viewing command ("!order" is one order). An argument we do not understand gets the usage, not silence.
  m = text.match(/^!orders\b\s*(.*)$/i);
  if (m) {
    if (/^complete\b/i.test(m[1])) return /^complete\s+all\s*[.!]?$/i.test(m[1]) ? { kind: "bulk_complete" } : { kind: "help", reason: "complete_all" };
    const view = parseOrdersView(m[1], opts.now ?? new Date(), opts.timezone || DEFAULT_ORDERS_TIMEZONE);
    return view ? { kind: "orders", view } : { kind: "help", reason: "orders" };
  }
  m = text.match(/^!order\b\s*(.*)$/i);
  if (m) {
    const query = m[1].trim();
    if (!query) return { kind: "help", reason: "order" };
    // Teaching, completing or reopening needs an order REFERENCE: a name or phone could match the wrong order.
    // "!order teach #REF …" is the same as "!order #REF teach …".
    const teach = query.match(/^(\S+)\s+teach\b[\s:,-]*(.*)$/i) ?? query.match(/^teach\b[\s:,-]*(\S+)\s*(.*)$/i);
    if (teach) {
      const sel = parseSelector(teach[1]);
      const instruction = teach[2].replace(/\s+/g, " ").trim();
      return (sel?.type === "ref" || sel?.type === "number") && instruction && instruction.length <= MAX_INSTRUCTION ? { kind: "teach", selector: sel, instruction } : { kind: "help", reason: "teach" };
    }
    const done = query.match(/^(.*?)\s+(complete|completed|reopen|reopened)$/i);
    if (done) {
      const sel = parseSelector(done[1]);
      return sel?.type === "ref" || sel?.type === "number" ? { kind: "update", selector: sel, action: { type: /^reopen/i.test(done[2]) ? "reopen" : "complete" } } : { kind: "help", reason: "order" };
    }
    // "!order #QU6U9 confirmed | cancelled | 2 bags | delivery tomorrow": the reference is required (a name could match the wrong order).
    const acting = query.match(/^(\S+)\s+(.+)$/);
    const actingOn = acting ? parseSelector(acting[1]) : null;
    if (acting && (actingOn?.type === "ref" || actingOn?.type === "number")) {
      const action = parseOrderAction(acting[2]);
      return action ? { kind: "update", selector: actingOn, action } : { kind: "help", reason: "order" };
    }
    const s = parseSelector(query);
    if (s?.type === "ref" || s?.type === "number") return { kind: "info", selector: s };
    return query.length <= MAX_SELECTOR ? { kind: "search", query } : { kind: "help", reason: "order" };
  }
  m = text.match(/^!more[\s-]*info\b\s*(.*)$/i);
  if (m) {
    const s = m[1].trim() ? parseSelector(m[1]) : null;
    return s?.type === "ref" || s?.type === "number" ? { kind: "info", selector: s } : null;
  }
  return null;
}

// ── Selecting the order ──────────────────────────────────────────────────────

export type Resolution =
  | { kind: "one"; order: TrackedOrder }
  | { kind: "none" }
  | { kind: "many"; orders: TrackedOrder[] };

const tokens = (s: string) => normalizeText(s).split(" ").filter(Boolean);

/** Every name an order can be found under. */
function namesOf(o: TrackedOrder, names?: OrderNames): string[] {
  const resolved = names?.[o.id] as ResolvedName | undefined;
  return [...new Set([...(resolved?.all ?? []), ...(o.customer_name ? [o.customer_name] : [])])];
}

function phoneMatches(o: TrackedOrder, digits: string): boolean {
  const phone = (o.contact_number ?? "").replace(/\D/g, "");
  return phone.length >= 6 && phone.endsWith(digits);
}

/** Whole query words, each the start of a word in the customer's name ("jane" finds "Jane Doe" and "Janet"). */
function nameMatches(o: TrackedOrder, query: string, names?: OrderNames): boolean {
  const wanted = tokens(query);
  if (wanted.length === 0) return false;
  return namesOf(o, names).some((n) => {
    const have = tokens(n);
    return wanted.every((w) => have.some((h) => h.startsWith(w)));
  });
}

/**
 * Finds the order a selector means among `orders` (a reference is looked up in any status, a phone or a name only among
 * active ones, which the caller passes). Several matches are returned as "many", never reduced to one.
 */
export function resolveSelector(selector: Selector, orders: TrackedOrder[], names?: OrderNames): Resolution {
  // A number is resolved against the stored report (lib/aiAgent/orderNumbers.ts) before this is ever called.
  if (selector.type === "number") return { kind: "none" };
  const hits =
    selector.type === "ref"
      ? orders.filter((o) => o.ref_code.toUpperCase() === selector.ref)
      : selector.type === "phone"
        ? orders.filter((o) => phoneMatches(o, selector.digits))
        : orders.filter((o) => nameMatches(o, selector.text, names));
  if (hits.length === 0) return { kind: "none" };
  return hits.length === 1 ? { kind: "one", order: hits[0] } : { kind: "many", orders: hits };
}

/** Search for `!order <text>`: a phone number or a name (the reference form is handled as "info"). */
export function searchOrders(query: string, orders: TrackedOrder[], names?: OrderNames): TrackedOrder[] {
  const s = parseSelector(query);
  if (s?.type === "phone") return orders.filter((o) => phoneMatches(o, s.digits));
  if (s?.type === "ref") return orders.filter((o) => o.ref_code.toUpperCase() === s.ref);
  return orders.filter((o) => nameMatches(o, query, names));
}

// ── Reply text (short, for the staff group) ──────────────────────────────────

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const label = (o: TrackedOrder, names?: OrderNames) => `${displayRef(o.ref_code)} (${clip(orderDisplayName(o, names) ?? formatPhone(o.contact_number) ?? "customer", 30)})`;

const itemsOneLine = (o: TrackedOrder) => (o.items.length > 0 ? o.items.map(orderItemText).join("; ") : "no products yet");

const STATUS_NAME: Record<string, string> = { possible: "possible", awaiting_confirmation: "awaiting confirmation", confirmed: "confirmed", fulfilled: "completed", cancelled: "cancelled" };

export const NO_BANG_REPLY = (suggestion: string) =>
  `ℹ️ Commands start with “!”. I did not change anything. Did you mean:\n${suggestion}`;

export const ORDER_HELP = [
  "ℹ️ Order commands:",
  "!orders — outstanding orders for today and tomorrow",
  "!orders today | tomorrow | 30 Oct | all | overdue | missing | undated | review",
  "!order <name or phone> — find an order",
  "!order #REF — order details (also !moreinfo #REF)",
  "!order 2 … — the number shown in the latest !orders report works instead of #REF (reply to the report to be sure)",
  "!order #REF confirmed | cancelled | 2 bags | delivery tomorrow — change one order",
  "!order #REF completed — mark done (leaves !orders)",
  "!order #REF reopen — undo a completion",
  "!order #REF teach <what is wrong> — fix an order in your own words; I ask if something is missing, and you reply to my question (previewed first)",
  "  also: say “usually / always …” or “call him …” to save a customer preference (separate !confirm P-CODE)",
  "!orders complete all — complete today's outstanding orders (previewed first)",
  "!confirm C-CODE / B-CODE / P-CODE — apply a proposal · !discard … — drop it",
  "#REF is the code shown in the lists, e.g. #QU6U9.",
].join("\n");

export const ORDERS_HELP = [
  "ℹ️ !orders shows what is outstanding, by the day it is for:",
  "!orders — today and tomorrow",
  "!orders today · !orders tomorrow · !orders 30 Oct",
  "!orders all — every outstanding order, by day",
  "!orders overdue — older, still open",
  "!orders missing — lacking products, quantity, delivery/collection, address or day",
  "!orders undated — no day given",
  "!orders review — possible orders that are on no list until you confirm them",
  "Deliveries to the south are grouped under 🧭 South Deliveries on each day.",
  "!orders complete all — complete today's outstanding orders (preview, then !confirm B-CODE)",
].join("\n");

export const ORDER_REPLY = {
  none: (what: string) => `⚠️ No active order matches "${clip(what, 40)}". Nothing changed. Try !order <name or phone>.`,
  noRef: (ref: string) => `⚠️ No order ${displayRef(ref)} found. Nothing changed.`,
  many: (what: string, orders: TrackedOrder[], names?: OrderNames) =>
    [
      `⚠️ "${clip(what, 40)}" matches ${orders.length} active orders — nothing changed. Use the reference:`,
      ...orders.slice(0, 5).map((o) => `${label(o, names)} · ${clip(itemsOneLine(o), 60)}`),
      ...(orders.length > 5 ? [`…and ${orders.length - 5} more`] : []),
      "Example: !order #REF confirmed",
    ].join("\n"),
  closed: (o: TrackedOrder) => `ℹ️ ${displayRef(o.ref_code)} is already ${STATUS_NAME[o.status] ?? o.status} — nothing changed.`,
  alreadyCompleted: (o: TrackedOrder) => `ℹ️ ${displayRef(o.ref_code)} is already completed — no change.`,
  notCompleted: (o: TrackedOrder) => `ℹ️ ${displayRef(o.ref_code)} is not completed (${STATUS_NAME[o.status] ?? o.status}) — nothing to reopen.`,
  // Internal bookkeeping only, like confirmation: the customer is not told and nothing is delivered or sent.
  completed: (o: TrackedOrder, names?: OrderNames) => `✔️ ${label(o, names)}: completed. It no longer shows in !orders. The customer was not messaged. Undo: !order ${displayRef(o.ref_code)} reopen`,
  reopened: (o: TrackedOrder, names?: OrderNames) => `↩️ ${label(o, names)}: reopened (${STATUS_NAME[o.status] ?? o.status}). It shows in !orders again.`,
  alreadyConfirmed: (o: TrackedOrder, names?: OrderNames) => `ℹ️ ${label(o, names)} is already confirmed — no change.`,
  // Internal bookkeeping only: nothing here is, or implies, a message to the customer.
  confirmed: (o: TrackedOrder, before: string, names?: OrderNames) =>
    `✅ ${label(o, names)}: ${STATUS_NAME[before] ?? before} → confirmed (internal staff confirmation). The customer was not messaged.`,
  cancelled: (o: TrackedOrder, before: string, names?: OrderNames) => `🚫 ${label(o, names)}: ${STATUS_NAME[before] ?? before} → cancelled. The customer was not messaged.`,
  incomplete: (o: TrackedOrder, missing: string) => `⚠️ ${displayRef(o.ref_code)} can't be confirmed yet — missing: ${missing}. Nothing changed.`,
  quantity: (o: TrackedOrder, before: string | null, after: number, names?: OrderNames) =>
    `✅ ${label(o, names)}: quantity ${before ?? "not set"} → ${after} (${clip(orderProductText(o.items[0]), 60)}).`,
  sameQuantity: (o: TrackedOrder, q: number) => `ℹ️ ${displayRef(o.ref_code)} already has quantity ${q} — no change.`,
  severalProducts: (o: TrackedOrder) => `⚠️ ${displayRef(o.ref_code)} has ${o.items.length === 0 ? "no products" : `${o.items.length} products`} — change quantities in the Orders dashboard. Nothing changed.`,
  delivery: (o: TrackedOrder, when: string, names?: OrderNames, source: DateSource = "stated", defaultDay?: string | null) =>
    `✅ ${label(o, names)}: ${effectiveMethod(o).method} date → ${clip(when, 60)}.${
      source === "stated"
        ? ""
        : source === "default"
          ? ` ℹ️ No specific day in that${defaultDay ? `, so the order is for ${dayLabel(defaultDay)}` : ""}.`
          : " ⚠️ That is not a date I can read, so the order's day is unclear. Use e.g. “delivery 30 Oct” or “delivery tomorrow”."
    }`,
  sameDelivery: (o: TrackedOrder) => `ℹ️ ${displayRef(o.ref_code)} already has that date — no change.`,
  stale: (o: TrackedOrder) => `⚠️ ${displayRef(o.ref_code)} changed after your message was sent — nothing applied. Check !moreinfo ${displayRef(o.ref_code)} and send it again.`,
  conflict: (o: TrackedOrder) => `⚠️ ${displayRef(o.ref_code)} was just changed by someone else — nothing applied. Check !moreinfo ${displayRef(o.ref_code)} and try again.`,
  failed: () => "⚠️ The order could not be updated right now. Nothing changed.",
};

export function searchReply(query: string, found: TrackedOrder[], names?: OrderNames): string {
  if (found.length === 0) return `🔎 No active order matches "${clip(query, 40)}".`;
  const shown = found.slice(0, 5);
  return [
    `🔎 ${found.length} active ${found.length === 1 ? "order" : "orders"} for "${clip(query, 40)}":`,
    ...shown.map((o) => orderBlock(o, null, names, { status: true })),
    ...(found.length > shown.length ? [`…and ${found.length - shown.length} more — narrow the search.`] : []),
    "Details: !moreinfo #REF",
  ].join("\n\n");
}

export interface OrderEventLine {
  kind: string;
  actor_kind: string;
  actor_id?: string | null;
  created_at: string;
  changes: Record<string, { before?: unknown; after?: unknown }>;
}

function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "status") return STATUS_NAME[String(v)] ?? String(v);
  if (field === "items" && Array.isArray(v)) return clip(v.map((i) => orderItemText(i as never)).join("; ") || "—", 60);
  return clip(String(v), 40);
}

function changeText(changes: OrderEventLine["changes"]): string {
  const parts = Object.entries(changes)
    .filter(([field]) => !["staff_message", "removed_items", "inferred", "correction", "completion_batch", "answer_source", "product_source", "change_source", "staff_change_unclear", "answer_unclear", "field_conflicts"].includes(field))
    .slice(0, 3)
    .map(([field, c]) => `${field.replace(/_/g, " ")} ${valueText(field, c?.before)} → ${valueText(field, c?.after)}`);
  return parts.join("; ") || "noted";
}

/** "Completed 27 Oct, 14:05 by 1758…" from the order's own record and the event that completed it. */
function completionLine(o: TrackedOrder, events: (OrderEventLine & { actor_id?: string | null })[], when: (iso: string | null) => string | null): string {
  const by = events.find((e) => (e.changes?.status as { after?: unknown } | undefined)?.after === "fulfilled")?.actor_id;
  return `Completed ${when(o.fulfilled_at) ?? ""}${by ? ` by ${clip(by.replace(/@.*$/, ""), 30)}` : ""}`.trim();
}

/** Everything the dashboard has about one order, short enough for WhatsApp. */
export function moreInfoReply(args: { order: TrackedOrder; name: ResolvedName | undefined; events: OrderEventLine[]; timezone: string }): string {
  const { order: o, name, events, timezone } = args;
  const when = (iso: string | null) => {
    if (!iso) return null;
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? null : new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  };
  const phone = formatPhone(o.contact_number);
  const status =
    o.status === "confirmed"
      ? o.confirmed_by === "customer"
        ? "Confirmed (customer's own reply)"
        : "Staff-confirmed"
      : o.status === "awaiting_confirmation"
        ? `Awaiting confirmation${o.customer_confirmed_at ? " (customer replied yes — staff to verify)" : ""}`
        : o.status === "possible"
          ? "Possible order — details incomplete"
          : (o.status === "fulfilled" ? "Completed" : o.status.charAt(0).toUpperCase() + o.status.slice(1));
  const lines = [
    `🔎 *${orderDisplayName(o, name ? { [o.id]: name } : undefined) ?? phone ?? "Unknown customer"} · ${displayRef(o.ref_code)}*`,
    `Status: ${status}`,
    ...(phone ? [`Phone: ${phone}`] : []),
    ...(o.items.length > 0 ? o.items.map((i) => `• ${orderItemText(i)}`) : ["• no products yet"]),
    `Method: ${effectiveMethod(o).method}${effectiveMethod(o).defaulted ? " (default)" : ""}${o.delivery_address ? ` · ${clip(o.delivery_address, 120)}` : ""}`,
    ...(o.delivery_address ? [addressSourceLine(addressProvenance(o, events))].filter((l): l is string => Boolean(l)) : []),
    ...(() => {
      // The actual date only. Whether it was said, agreed by staff or defaulted stays in the order's history, not in this line.
      const day = effectiveDate(o, timezone);
      if (day.source === "unreadable") return [`When: ${clip(o.requested_for ?? "", 80)} — no date read`];
      const time = timeOfDay(o.requested_for);
      return [`Day: ${dayLabel(day.date!)}${time ? ` · ${time}` : ""}`];
    })(),
    ...(o.notes ? [`Note: ${clip(o.notes, 160)}`] : []),
    ...conflictFields(o).map((f) => {
      const c = o.field_conflicts[f]!;
      const evidence = c.evidence ? ` — “${clip(c.evidence, 80)}”` : "";
      return c.source === "staff_chat" ? `⚠️ Staff said in chat ${conflictText(f, c, 50)}${evidence}` : `⚠️ Customer now says ${conflictText(f, c, 50)}${evidence}`;
    }),
    ...(o.attention ? [`⚠️ ${clip(ATTENTION_TEXT[o.attention] ?? o.attention.replace(/_/g, " "), 140)}`] : []),
    ...(o.attention === "staff_change_unclear" || o.attention === "staff_changed_in_chat"
      ? events
          .map((e) => (e.changes?.staff_message as { after?: unknown } | undefined)?.after)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .slice(0, 1)
          .map((t) => `Staff wrote: “${clip(t, 140)}”`)
      : []),
    `First message ${when(o.first_message_at) ?? "?"} · last ${when(o.last_message_at) ?? "?"}`,
    ...(o.manual_locked_fields.length > 0 ? [`Edited by staff: ${o.manual_locked_fields.join(", ").replace(/_/g, " ")}`] : []),
    ...(o.status === "fulfilled" ? [completionLine(o, events, when)] : []),
    ...(o.status === "cancelled" ? [`Cancelled ${when(o.cancelled_at) ?? ""}${o.cancel_reason ? ` — ${clip(o.cancel_reason, 80)}` : ""}`.trim()] : []),
  ];
  // Values taken from the customer's earlier orders rather than from this conversation, so staff can check them.
  const from = (ref: unknown) => displayRef(String(ref));
  const inferred = events
    .map((e) => e.changes?.inferred?.after as { items?: string[]; delivery_address?: string; unresolved?: string[] } | undefined)
    .filter((i): i is NonNullable<typeof i> => Boolean(i));
  const filled = [
    ...(inferred.some((i) => i.items?.length) ? [`products from ${[...new Set(inferred.flatMap((i) => i.items ?? []))].map(from).join(", ")}`] : []),
  ];
  if (filled.length > 0) lines.push(`ℹ️ From earlier orders: ${filled.join("; ")} — not stated in this chat`);
  const unresolved = [...new Set(inferred.flatMap((i) => i.unresolved ?? []))];
  if (unresolved.length > 0) lines.push(`ℹ️ Not resolved from history: ${unresolved.map((u) => clip(u, 100)).join("; ")}`);
  // Why a product, quantity or address is what it is when the customer did not type it as an order: answered a staff question, or chosen from the conversation or history.
  const answered = events
    .map((e) => e.changes?.answer_source?.after as { kind?: string; question?: string; question_at?: string; answer?: string } | undefined)
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  for (const x of answered.slice(0, 3)) lines.push(`ℹ️ ${x.kind === "address" ? "Address" : x.kind === "quantity" ? "Quantity" : "Product"} from the chat: staff asked “${clip(x.question ?? "", 70)}” (${when(x.question_at ?? null) ?? "?"}), the customer replied “${clip(x.answer ?? "", 50)}”`);
  const sources = events.flatMap((e) => (Array.isArray(e.changes?.product_source?.after) ? (e.changes.product_source.after as { source?: string; product?: string; ref?: string; staffMessage?: string; customerText?: string }[]) : []));
  for (const x of sources.slice(0, 3)) {
    if (x.source === "conversation_confirmed") lines.push(`ℹ️ Product chosen: ${clip(x.product ?? "", 50)} — the customer confirmed it in this chat (staff asked “${clip(x.staffMessage ?? "", 60)}”, they replied “${clip(x.customerText ?? "", 40)}”)`);
    else if (x.source === "staff_saved") lines.push(`ℹ️ Product chosen: ${clip(x.product ?? "", 50)} — the usual product staff saved for this customer`);
    else if (x.source === "order_history") lines.push(`ℹ️ Product chosen: ${clip(x.product ?? "", 50)} — the customer's only verified purchase (${x.ref ? displayRef(x.ref) : "earlier order"})`);
    else if (x.source === "open_order") lines.push(`ℹ️ Product chosen: ${clip(x.product ?? "", 50)} — the product already on this order`);
  }
  const recent = events.slice(0, 5).map((e) => `• ${when(e.created_at) ?? ""} ${e.actor_kind}: ${clip(e.kind.replace(/_/g, " "), 24)} — ${clip(changeText(e.changes), 90)}`);
  if (recent.length > 0) lines.push("Recent changes:", ...recent);
  return lines.join("\n");
}
