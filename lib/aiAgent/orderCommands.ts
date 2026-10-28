// WhatsApp order commands — pure parsing, selector resolution and reply text (no I/O), unit-tested in
// tests/aiAgentOrderCommands.test.ts. The server side (lib/server/aiAgent/orders.ts handleOrderCommand) loads the
// orders, checks who may do what, and applies the change through the same code the Orders dashboard uses.
//
//   !orders [today|tomorrow|<date>|all|overdue|missing|undated]   what is outstanding, by the day it is for (read-only)
//   !update                         what is new or changed since the last update (read-only)
//   !update #QU6U9 confirmed        staff-confirm one order
//   !update #QU6U9 cancelled        cancel it
//   !update #QU6U9 2 bags           change its quantity (single-product orders)
//   !update #QU6U9 delivery tomorrow   change the requested delivery date
//   !order <name or phone>          search active orders
//   !order #QU6U9 / !moreinfo #QU6U9   full details of one order
//   !order #QU6U9 completed         mark it done (status "fulfilled"): it leaves !orders, its history stays
//   !order #QU6U9 reopen            undo an accidental completion
//   !order #QU6U9 teach <words>     correct an order in plain language: previewed, applied only after !confirm C-CODE
//   !orders complete all            complete today's outstanding orders: previewed, applied only after !confirm B-CODE
//   !confirm C-CODE / !discard C-CODE   (also B-CODE) apply or drop a proposal made by one of the two commands above
//
// A selector is a reference (#QU6U9), a phone number, or a customer name. Whatever it is, it must identify exactly ONE
// active order; with two or more matches nothing is changed and the choices are listed. No model is involved.

import { normalizeText } from "./escalationUpdates.ts";
import { addressProvenance, addressSourceLine } from "./orderAddress.ts";
import { type DateSource, effectiveDate, effectiveMethod, isDefaultedDay } from "./orderDefaults.ts";
import { dayLabel, orderDate, parseOrdersView, type OrdersView } from "./orderViews.ts";
import { BULK_HELP, MAX_INSTRUCTION, parseProposalCode, TEACH_HELP, type ProposalKind } from "./orderTeach.ts";
import {
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
  | { type: "name"; text: string };

export type UpdateAction =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "quantity"; quantity: number }
  | { type: "delivery"; when: string }
  | { type: "complete" }
  | { type: "reopen" };

export type OrderCommand =
  | { kind: "report" }
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
  | { kind: "help"; reason: "update" | "order" | "moreinfo" | "orders" | "teach" | "complete_all" };

/** The commands that propose or settle a proposal (handled by lib/server/aiAgent/orderCorrections.ts). */
export type CorrectionCommand = Extract<OrderCommand, { kind: "teach" | "bulk_complete" | "proposal" }>;
export const isCorrectionCommand = (c: OrderCommand): c is CorrectionCommand => c.kind === "teach" || c.kind === "bulk_complete" || c.kind === "proposal";

const MAX_SELECTOR = 60;

/** A reference, a phone number (6+ digits) or a name. Empty or silly input is not a selector. */
export function parseSelector(raw: string): Selector | null {
  const text = raw.replace(/^["'“‘]+|["'”’]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_SELECTOR) return null;
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
const QUANTITY_TAIL = new RegExp(String.raw`^(.*?)\s+(?:(?:qty|quantity|x)\s*(\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})|(\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\s*(?:bags?|sacks?|boxe?s?|units?|pcs|pieces?|x))$`, "i");

function parseUpdateBody(body: string): OrderCommand | null {
  const text = body.replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
  // "!update the price list please" is staff chatter, as it always was. A message that starts like an order selector (a
  // reference or a phone number) but has no action we understand gets the usage help instead of silence.
  const first = parseSelector(text.split(" ")[0] ?? "");
  const help: OrderCommand | null = first && first.type !== "name" ? { kind: "help", reason: "update" } : null;
  const withAction = (selector: string, action: UpdateAction): OrderCommand | null => {
    const s = parseSelector(selector);
    return s ? { kind: "update", selector: s, action } : help;
  };
  let m = text.match(/^(.*?)\s+deliver(?:y|ed)?(?:\s+(?:date|on|for|by))?\s+(.+)$/i);
  if (m) return m[2].trim().length <= 100 ? withAction(m[1], { type: "delivery", when: m[2].trim() }) : help;
  m = text.match(/^(.*?)\s+(?:confirm|confirmed)$/i);
  if (m) return withAction(m[1], { type: "confirm" });
  m = text.match(/^(.*?)\s+(?:cancel|cancelled|canceled)$/i);
  if (m) return withAction(m[1], { type: "cancel" });
  m = text.match(QUANTITY_TAIL);
  if (m) {
    const word = (m[2] ?? m[3]).toLowerCase();
    const quantity = NUMBER_WORDS[word] ?? Number(word);
    return quantity >= 1 && quantity <= 999 ? withAction(m[1], { type: "quantity", quantity }) : help;
  }
  return help;
}

/** Exactly "!update" (case/spacing/punctuation tolerant). */
const REPORT = /^!update\s*[.!]?\s*$/i;

/**
 * Recognises the order commands. Returns null for anything else, which is handed on to the existing escalation and
 * Approval Pilot commands untouched. "!moreinfo" is an order command only when it names an order reference
 * (#QU6U9); "!moreinfo" alone, or with an escalation code (#E-AB12C), stays with the escalation logic.
 */
export function parseOrderCommand(raw: string, opts: { now?: Date; timezone?: string | null } = {}): OrderCommand | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (REPORT.test(text)) return { kind: "report" };
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
  m = text.match(/^!update\s+(.+)$/i);
  if (m) return parseUpdateBody(m[1]);
  m = text.match(/^!order\b\s*(.*)$/i);
  if (m) {
    const query = m[1].trim();
    if (!query) return { kind: "help", reason: "order" };
    // Teaching, completing or reopening needs an order REFERENCE: a name or phone could match the wrong order.
    const teach = query.match(/^(\S+)\s+teach\b\s*(.*)$/i);
    if (teach) {
      const sel = parseSelector(teach[1]);
      const instruction = teach[2].replace(/\s+/g, " ").trim();
      return sel?.type === "ref" && instruction && instruction.length <= MAX_INSTRUCTION ? { kind: "teach", selector: sel, instruction } : { kind: "help", reason: "teach" };
    }
    const done = query.match(/^(.*?)\s+(complete|completed|reopen|reopened)$/i);
    if (done) {
      const sel = parseSelector(done[1]);
      return sel?.type === "ref" ? { kind: "update", selector: sel, action: { type: /^reopen/i.test(done[2]) ? "reopen" : "complete" } } : { kind: "help", reason: "order" };
    }
    const s = parseSelector(query);
    if (s?.type === "ref") return { kind: "info", selector: s };
    return query.length <= MAX_SELECTOR ? { kind: "search", query } : { kind: "help", reason: "order" };
  }
  m = text.match(/^!more[\s-]*info\b\s*(.*)$/i);
  if (m) {
    const s = m[1].trim() ? parseSelector(m[1]) : null;
    return s?.type === "ref" ? { kind: "info", selector: s } : null;
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

export const ORDER_HELP = [
  "ℹ️ Order commands:",
  "!orders — outstanding orders for today and tomorrow",
  "!orders today | tomorrow | 30 Oct | all | overdue | missing | undated",
  "!update — what is new or changed since the last update",
  "!update #REF confirmed | cancelled | 2 bags | delivery tomorrow",
  "!order <name or phone> — find an order",
  "!order #REF — order details (also !moreinfo #REF)",
  "!order #REF completed — mark done (leaves !orders)",
  "!order #REF reopen — undo a completion",
  "!order #REF teach <what is wrong> — fix an order in your own words (previewed first)",
  "!orders complete all — complete today's outstanding orders (previewed first)",
  "!confirm C-CODE / B-CODE — apply a proposal · !discard C-CODE / B-CODE — drop it",
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
      "Example: !update #REF confirmed",
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
          ? ` ℹ️ No specific day in that, so the order uses the default day${defaultDay ? ` (${dayLabel(defaultDay)})` : ""}.`
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
    .filter(([field]) => !["staff_message", "removed_items", "inferred", "correction", "completion_batch"].includes(field))
    .slice(0, 3)
    .map(([field, c]) => `${field.replace(/_/g, " ")} ${valueText(field, c?.before)} → ${valueText(field, c?.after)}`);
  return parts.join("; ") || "noted";
}

const NAME_SOURCE_TEXT: Record<string, string> = { staff: "entered by staff", saved: "saved contact", profile: "WhatsApp profile name" };

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
    ...(name?.name && name.source ? [`Name: ${NAME_SOURCE_TEXT[name.source]}`] : []),
    ...(o.items.length > 0 ? o.items.map((i) => `• ${orderItemText(i)}`) : ["• no products yet"]),
    `Method: ${effectiveMethod(o).method}${effectiveMethod(o).defaulted ? " (default)" : ""}${o.delivery_address ? ` · ${clip(o.delivery_address, 120)}` : ""}`,
    ...(o.delivery_address ? [addressSourceLine(addressProvenance(o, events))].filter((l): l is string => Boolean(l)) : []),
    ...(() => {
      const day = effectiveDate(o, timezone);
      if (day.source === "unreadable") return [`When: ${clip(o.requested_for ?? "", 80)} — no date read`];
      const shown = dayLabel(day.date!);
      if (day.source === "default") {
        // A stored "Thu 29 Oct (default)" is the business rule's own value, not the customer's words; only a time of day they gave is theirs.
        const said = isDefaultedDay(o.requested_for) ? ((o.requested_for ?? "").match(/\(default, (.+)\)$/)?.[1] ?? null) : o.requested_for;
        return [`Day: ${shown} (default${said ? `; they said “${clip(said, 40)}”` : " — no day given"})`];
      }
      return [`Day: ${shown} (${clip(o.requested_for ?? "", 60)})`];
    })(),
    ...(o.notes ? [`Note: ${clip(o.notes, 160)}`] : []),
    ...conflictFields(o).map((f) => `⚠️ Customer now says ${conflictText(f, o.field_conflicts[f]!, 50)}`),
    ...(o.attention ? [`⚠️ ${clip(o.attention.replace(/_/g, " "), 60)}`] : []),
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
  if (unresolved.length > 0) lines.push(`ℹ️ Not resolved from history: ${unresolved.map((u) => clip(u, 60)).join("; ")}`);
  const recent = events.slice(0, 5).map((e) => `• ${when(e.created_at) ?? ""} ${e.actor_kind}: ${clip(e.kind.replace(/_/g, " "), 24)} — ${clip(changeText(e.changes), 90)}`);
  if (recent.length > 0) lines.push("Recent changes:", ...recent);
  return lines.join("\n");
}
