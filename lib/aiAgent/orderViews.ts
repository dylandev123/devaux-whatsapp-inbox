// The order views staff read — pure (no I/O), unit-tested in tests/aiAgentOrderViews.test.ts.
//
//   !orders [today|tomorrow|<date>|all|overdue|missing|undated]   what is outstanding, by the day it is FOR
//   !update                                                   what is new or materially changed since the last update
//
// Orders are placed on the day they are intended for (delivery or collection), never on the day the message arrived. The
// day is read from `requested_for` (see requestedDate in orderText.ts); an order with no readable day is "undated", and an
// order whose day has passed (or an undated one first mentioned on an earlier day) is "overdue". Nothing here completes,
// cancels or deletes an order: an old order stays listed under Overdue until a person completes or cancels it.

import { addDays, requestedDate, resolveRequestedDay } from "./orderText.ts";
import {
  computeMissing,
  conflictFields,
  conflictValueText,
  DEFAULT_ORDERS_TIMEZONE,
  displayRef,
  formatPhone,
  isOpenStatus,
  localParts,
  MISSING_TEXT,
  type OrderNames,
  orderDisplayName,
  orderItemText,
  orderWarning,
  reportItemText,
  type TrackedOrder,
} from "./orders.ts";

export type OrdersView =
  | { type: "default" }
  | { type: "today" }
  | { type: "tomorrow" }
  | { type: "day"; date: string }
  | { type: "all" }
  | { type: "overdue" }
  | { type: "missing" }
  | { type: "undated" };

/**
 * The argument after "!orders", or null when it is not one we understand (the caller shows the usage help).
 * "today" and "tomorrow" stay symbolic (resolved when the answer is built, so a retry after midnight is still right);
 * a written date ("30 Oct", "2026-10-30") is fixed here against `now`.
 */
export function parseOrdersView(arg: string, now: Date, timezone: string = DEFAULT_ORDERS_TIMEZONE): OrdersView | null {
  const text = arg.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim().toLowerCase();
  if (!text) return { type: "default" };
  if (text === "today") return { type: "today" };
  if (text === "tomorrow" || text === "tmrw") return { type: "tomorrow" };
  if (text === "all") return { type: "all" };
  if (text === "overdue") return { type: "overdue" };
  if (text === "missing") return { type: "missing" };
  if (text === "undated") return { type: "undated" };
  if (text.length > 40) return null;
  const day = resolveRequestedDay(text, now, timezone);
  return day ? { type: "day", date: day.date } : null;
}

// ── Dates ────────────────────────────────────────────────────────────────────

export type Bucket = "overdue" | "today" | "tomorrow" | "later" | "undated";

export interface DayContext {
  timezone: string;
  /** YYYY-MM-DD today in the business's timezone. */
  today: string;
  tomorrow: string;
}

export function dayContext(now: Date, timezone: string = DEFAULT_ORDERS_TIMEZONE): DayContext {
  const today = localParts(now, timezone).dateKey;
  return { timezone, today, tomorrow: addDays(today, 1).key };
}

/** The day an order is for (YYYY-MM-DD in the business's timezone), or null when it has none that can be read. */
export function orderDate(o: Pick<TrackedOrder, "requested_for" | "first_message_at">, timezone: string = DEFAULT_ORDERS_TIMEZONE): string | null {
  return requestedDate(o.requested_for, o.first_message_at, timezone);
}

/** "Wed 28 Oct". */
export const dayLabel = (dateKey: string): string => addDays(dateKey, 0).label;

/**
 * Where an order belongs today. An undated order is "undated" only on the day it was first mentioned; after that it is
 * overdue, so an old enquiry is never silently carried into a new day as if it were fresh.
 */
export function bucketOf(o: Pick<TrackedOrder, "requested_for" | "first_message_at">, ctx: DayContext): Bucket {
  const date = orderDate(o, ctx.timezone);
  if (date === null) return localParts(new Date(o.first_message_at), ctx.timezone).dateKey < ctx.today ? "overdue" : "undated";
  if (date < ctx.today) return "overdue";
  if (date === ctx.today) return "today";
  if (date === ctx.tomorrow) return "tomorrow";
  return "later";
}

/** What an order still lacks that a person needs to act on it: products, quantity, delivery/collection, address, a day. */
export function orderGaps(o: Pick<TrackedOrder, "items" | "fulfilment_method" | "delivery_address" | "requested_for" | "first_message_at">, timezone: string = DEFAULT_ORDERS_TIMEZONE): string[] {
  const missing = computeMissing(o).filter((m) => m !== "requested_for");
  // A day written in words that cannot be read ("sometime next week") counts as no day.
  if (orderDate(o, timezone) === null) missing.push("requested_for");
  return missing;
}

const gapText = (key: string) => (key === "requested_for" ? "day" : (MISSING_TEXT[key] ?? key));

/** Open, and something a person should look at: it is overdue, lacks essential information, or carries a warning. */
export function needsAttention(o: TrackedOrder, ctx: DayContext): boolean {
  if (!isOpenStatus(o.status)) return false;
  return bucketOf(o, ctx) === "overdue" || orderGaps(o, ctx.timezone).length > 0 || orderWarning(o) !== null;
}

export interface OrderCounts {
  open: number;
  today: number;
  tomorrow: number;
  later: number;
  overdue: number;
  /** Open orders with no readable day, of any age (a superset of the "undated" bucket). */
  undated: number;
  missing: number;
  attention: number;
}

/** The numbers shown beside the views (WhatsApp footer, website tabs): one definition for both. */
export function countOrders(orders: TrackedOrder[], ctx: DayContext): OrderCounts {
  const counts: OrderCounts = { open: 0, today: 0, tomorrow: 0, later: 0, overdue: 0, undated: 0, missing: 0, attention: 0 };
  for (const o of orders) {
    if (!isOpenStatus(o.status)) continue;
    counts.open += 1;
    const bucket = bucketOf(o, ctx);
    if (bucket !== "undated") counts[bucket] += 1;
    if (orderDate(o, ctx.timezone) === null) counts.undated += 1;
    if (orderGaps(o, ctx.timezone).length > 0) counts.missing += 1;
    if (needsAttention(o, ctx)) counts.attention += 1;
  }
  return counts;
}

/** Which orders a view lists, in the order they are shown (by day, then by when they were first mentioned). */
export function selectOrders(view: OrdersView, orders: TrackedOrder[], ctx: DayContext): TrackedOrder[] {
  const open = orders.filter((o) => isOpenStatus(o.status));
  const byDate = (a: TrackedOrder, b: TrackedOrder) =>
    (orderDate(a, ctx.timezone) ?? "9999").localeCompare(orderDate(b, ctx.timezone) ?? "9999") || Date.parse(a.first_message_at) - Date.parse(b.first_message_at);
  const inBucket = (...wanted: Bucket[]) => open.filter((o) => wanted.includes(bucketOf(o, ctx)));
  switch (view.type) {
    case "default":
      return inBucket("today", "tomorrow").sort(byDate);
    case "today":
      return inBucket("today").sort(byDate);
    case "tomorrow":
      return inBucket("tomorrow").sort(byDate);
    case "day":
      return open.filter((o) => orderDate(o, ctx.timezone) === view.date).sort(byDate);
    case "all":
      return [...open].sort(byDate);
    case "overdue":
      return inBucket("overdue").sort(byDate);
    case "undated":
      return open.filter((o) => orderDate(o, ctx.timezone) === null).sort(byDate);
    case "missing":
      return open.filter((o) => orderGaps(o, ctx.timezone).length > 0).sort(byDate);
  }
}

// ── Reading one order ────────────────────────────────────────────────────────

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
/** Customer-written text in a staff group: one line, never one that reads as a command. */
const safeText = (v: string | null | undefined, n: number) => clip((v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), n).replace(/^[!/]+/, "");

const TIME_OF_DAY = /\b(morning|afternoon|evening|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;

/** The part of `requested_for` worth repeating beside the day: "morning", "3pm". The day itself is shown from the date. */
const timeOfDay = (requestedFor: string | null): string | null => (requestedFor ?? "").match(TIME_OF_DAY)?.[1].toLowerCase() ?? null;

const STATUS_BADGE: Record<string, string> = { confirmed: "✅ confirmed", awaiting_confirmation: "🕓 to confirm", possible: "❔ incomplete" };

export interface LineOptions {
  /** Show the day the order is for (views not already grouped by day). */
  showDate?: boolean;
  timezone?: string;
}

/** One order as a short block: who, what, where, what is missing. */
export function orderViewBlock(o: TrackedOrder, index: number, names: OrderNames | undefined, opts: LineOptions = {}): string {
  const tz = opts.timezone ?? DEFAULT_ORDERS_TIMEZONE;
  const phone = formatPhone(o.contact_number);
  const named = orderDisplayName(o, names);
  const name = named ?? phone ?? "Unknown customer";
  const lines = [`*${index}. ${safeText(name, 40)} · ${displayRef(o.ref_code)}* ${STATUS_BADGE[o.status] ?? ""}`.trim()];
  if (o.items.length > 0) lines.push(o.items.map(reportItemText).join("; "));
  const date = orderDate(o, tz);
  const where = [
    o.fulfilment_method === "delivery" ? (o.delivery_address ? `📍 ${safeText(o.delivery_address, 80)}` : "📍 address needed") : o.fulfilment_method === "collection" ? "🛍 collection" : "",
    opts.showDate ? (date ? `🗓 ${dayLabel(date)}` : o.requested_for ? `🗓 “${safeText(o.requested_for, 40)}” (no date read)` : "🗓 no day") : "",
    timeOfDay(o.requested_for) ? `🕐 ${timeOfDay(o.requested_for)}` : "",
    named && phone ? `📞 ${phone}` : "",
  ].filter(Boolean);
  if (where.length > 0) lines.push(where.join(" · "));
  if (o.notes) lines.push(`Note: ${safeText(o.notes, 100)}`);
  const gaps = orderGaps(o, tz);
  if (gaps.length > 0) lines.push(`⚠️ Missing: ${gaps.map(gapText).join(", ")}`);
  const warning = orderWarning(o);
  if (warning) lines.push(`⚠️ ${warning}`);
  return lines.join("\n");
}

// ── !orders ──────────────────────────────────────────────────────────────────

const MAX_PART_CHARS = 3200;
const MAX_PARTS = 5;

interface Chunk {
  text: string;
  heading?: boolean;
}

/** Packs chunks into WhatsApp-sized messages; a heading never ends a message, and overflow is counted, not hidden. */
function pack(title: string, chunks: Chunk[]): { parts: string[]; omitted: number } {
  const base = title.length + 12;
  const bodies: Chunk[][] = [[]];
  let size = base;
  let omitted = 0;
  for (const [i, chunk] of chunks.entries()) {
    const current = bodies[bodies.length - 1];
    if (size + chunk.text.length + 2 > MAX_PART_CHARS && current.length > 0) {
      if (bodies.length >= MAX_PARTS) {
        omitted = chunks.slice(i).filter((c) => !c.heading && c.text.startsWith("*")).length;
        break;
      }
      const carried = current[current.length - 1]?.heading ? [current.pop()!] : [];
      bodies.push(carried);
      size = base + carried.reduce((n, c) => n + c.text.length + 2, 0);
    }
    bodies[bodies.length - 1].push(chunk);
    size += chunk.text.length + 2;
  }
  const total = bodies.length;
  const parts = bodies.map((body, i) => [`${title}${total > 1 ? ` (${i + 1}/${total})` : ""}`, ...body.map((c) => c.text)].join("\n\n"));
  return { parts, omitted };
}

const METHOD_HEADING: Record<string, string> = { delivery: "🚚 *Delivery*", collection: "🛍 *Collection*", none: "❓ *Delivery or collection not stated*" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface OrdersViewInput {
  view: OrdersView;
  /** Every open order of THIS business. */
  orders: TrackedOrder[];
  names?: OrderNames;
  now: Date;
  timezone?: string;
  /** Shown last: anything that makes the list incomplete (coverageWarning). */
  warning?: string | null;
}

export interface OrdersViewResult {
  parts: string[];
  shown: number;
  counts: OrderCounts;
}

/** The text of an !orders answer (also the morning post and the dashboard's "send now"). */
export function buildOrdersView(input: OrdersViewInput): OrdersViewResult {
  const tz = input.timezone ?? DEFAULT_ORDERS_TIMEZONE;
  const ctx = dayContext(input.now, tz);
  const counts = countOrders(input.orders, ctx);
  const picked = selectOrders(input.view, input.orders, ctx);
  const view = input.view;
  const chunks: Chunk[] = [];
  let number = 1;
  const numbered = (o: TrackedOrder, opts: LineOptions = {}) => orderViewBlock(o, number++, input.names, { timezone: tz, ...opts });

  /** One day: its heading, then Delivery / Collection / not-stated groups. Numbering continues across days. */
  const dayBlock = (key: string) => {
    const word = key === ctx.today ? "TODAY — " : key === ctx.tomorrow ? "TOMORROW — " : key < ctx.today ? "WAS DUE — " : "";
    const dayOrders = picked.filter((o) => orderDate(o, tz) === key);
    chunks.push({ text: `📅 *${word}${dayLabel(key)}* (${dayOrders.length})`, heading: true });
    if (dayOrders.length === 0) chunks.push({ text: "Nothing outstanding." });
    for (const method of ["delivery", "collection", "none"] as const) {
      const group = dayOrders.filter((o) => (o.fulfilment_method ?? "none") === method);
      if (group.length === 0) continue;
      chunks.push({ text: METHOD_HEADING[method], heading: true });
      for (const o of group) chunks.push({ text: numbered(o) });
    }
  };
  const flat = (orders: TrackedOrder[]) => orders.forEach((o) => chunks.push({ text: numbered(o, { showDate: true }) }));

  // Orders first mentioned today with no day yet are not lost, but they are not "today's" either.
  const fresh = input.orders.filter((o) => isOpenStatus(o.status) && bucketOf(o, ctx) === "undated");

  let title = "📋 *ORDERS*";
  let empty = "";
  switch (view.type) {
    case "default":
      title = `📋 *ORDERS — ${dayLabel(ctx.today)}*`;
      empty = "✅ Nothing outstanding for today or tomorrow.";
      if (picked.length > 0) {
        dayBlock(ctx.today);
        dayBlock(ctx.tomorrow);
      }
      if (fresh.length > 0) {
        chunks.push({ text: `❔ *NO DAY GIVEN YET (${fresh.length})*`, heading: true });
        flat(fresh);
      }
      break;
    case "today":
    case "tomorrow": {
      const key = view.type === "today" ? ctx.today : ctx.tomorrow;
      title = `📋 *ORDERS — ${view.type === "today" ? "TODAY" : "TOMORROW"}*`;
      empty = `✅ Nothing outstanding for ${view.type}.`;
      if (picked.length > 0) dayBlock(key);
      break;
    }
    case "day":
      title = `📋 *ORDERS — ${dayLabel(view.date)}*`;
      empty = `✅ Nothing outstanding for ${dayLabel(view.date)}.`;
      if (picked.length > 0) dayBlock(view.date);
      break;
    case "all": {
      title = "📋 *ALL OUTSTANDING ORDERS*";
      empty = "✅ No outstanding orders.";
      for (const key of [...new Set(picked.map((o) => orderDate(o, tz)).filter((d): d is string => d !== null))].sort()) dayBlock(key);
      const noDay = picked.filter((o) => orderDate(o, tz) === null);
      if (noDay.length > 0) {
        chunks.push({ text: `❔ *NO DAY GIVEN (${noDay.length})*`, heading: true });
        flat(noDay);
      }
      break;
    }
    case "overdue": {
      title = "📋 *OVERDUE ORDERS*";
      empty = "✅ No overdue orders.";
      for (const key of [...new Set(picked.map((o) => orderDate(o, tz)).filter((d): d is string => d !== null))].sort()) dayBlock(key);
      const noDay = picked.filter((o) => orderDate(o, tz) === null);
      if (noDay.length > 0) {
        chunks.push({ text: `❔ *NO DAY GIVEN — first mentioned before today (${noDay.length})*`, heading: true });
        flat(noDay);
      }
      if (picked.length > 0) chunks.push({ text: "Done? !order #REF completed · new day: !update #REF delivery <date> · cancel: !update #REF cancelled" });
      break;
    }
    case "missing":
      title = "📋 *ORDERS MISSING INFORMATION*";
      empty = "✅ Every outstanding order has the essentials (products, quantity, delivery or collection, address, day).";
      flat(picked);
      break;
    case "undated":
      title = "📋 *ORDERS WITH NO DAY*";
      empty = "✅ Every outstanding order has a day.";
      flat(picked);
      if (picked.length > 0) chunks.push({ text: "Set the day: !update #REF delivery <date>" });
      break;
  }
  if (chunks.length === 0) chunks.push({ text: empty });

  // Pointers to what this answer does NOT show, so nothing waits unseen.
  const pointers: string[] = [];
  if (view.type !== "overdue" && counts.overdue > 0) pointers.push(`⏰ ${plural(counts.overdue, "overdue order")} — !orders overdue`);
  if (view.type !== "missing" && counts.missing > 0) pointers.push(`⚠️ ${plural(counts.missing, "order")} missing information — !orders missing`);
  if (view.type === "default" && counts.later > 0) pointers.push(`🗓 ${plural(counts.later, "later order")} — !orders <date>`);
  if (view.type === "default") pointers.push("Details: !order #REF · Done: !order #REF completed");
  const footer = [input.warning, ...pointers].filter((x): x is string => Boolean(x));
  if (footer.length > 0) chunks.push({ text: footer.join("\n") });

  const packed = pack(title, chunks);
  if (packed.omitted > 0) packed.parts[packed.parts.length - 1] += `\n\n…and ${plural(packed.omitted, "more order")} — see the Orders page in the inbox.`;
  return { parts: packed.parts, shown: picked.length + (view.type === "default" ? fresh.length : 0), counts };
}

// ── !update: new and materially changed ──────────────────────────────────────

export interface OrderEventRow {
  order_id: string;
  kind: string;
  actor_kind: string;
  changes: Record<string, { before?: unknown; after?: unknown }>;
  created_at: string;
}

/** Fields whose change matters to someone preparing or delivering the order. */
const MATERIAL_FIELDS = ["items", "fulfilment_method", "delivery_address", "requested_for"] as const;

/**
 * Events that never make an order "changed": a staff WhatsApp command was already acknowledged in the group, and a
 * completion or reopening is bookkeeping (the order simply leaves or returns to !orders).
 */
export function isNoiseEvent(e: Pick<OrderEventRow, "kind">): boolean {
  return /^staff_whatsapp_/.test(e.kind) || /^manual_(fulfil|reopen|keep)$/.test(e.kind) || e.kind === "no_change";
}

export interface UpdateEntry {
  kind: "new" | "changed" | "cancelled" | "attention";
  order: TrackedOrder;
  /** Human-readable, one per changed field; first before → last after, however many edits happened in between. */
  changes: string[];
}

function valueOf(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "requested_for") return safeText(String(v).replace(/^(\w{3} \d{1,2} \w{3}) \(.*\)$/, "$1"), 40);
  if (field === "items" && Array.isArray(v)) return conflictValueText("items", v, 90);
  return safeText(String(v), 60);
}

const FIELD_WORD: Record<string, string> = { items: "products", fulfilment_method: "delivery/collection", delivery_address: "address", requested_for: "day" };

/**
 * Sorts what happened after `since` into entries. Rapid edits to one order are one entry: each field shows the value it
 * had at the cursor and the value it has now. An order created after the cursor is "new" whatever happened to it since.
 * `orders` are the orders with events in the window (any status), all from one business.
 */
export function summarizeUpdates(args: { since: Date; orders: TrackedOrder[]; events: OrderEventRow[] }): UpdateEntry[] {
  const since = args.since.getTime();
  const byOrder = new Map<string, OrderEventRow[]>();
  for (const e of args.events) {
    if (Date.parse(e.created_at) <= since) continue;
    byOrder.set(e.order_id, [...(byOrder.get(e.order_id) ?? []), e]);
  }
  const entries: UpdateEntry[] = [];
  for (const order of args.orders) {
    const events = (byOrder.get(order.id) ?? []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const isNew = Date.parse(order.created_at) > since;
    if (events.length === 0 && !isNew) continue;
    if (order.status === "fulfilled") continue;
    if (order.status === "cancelled") {
      // Asked for and withdrawn before anyone was told: nothing to act on. A cancellation staff typed was already acknowledged.
      const cancelledByOthers = events.some((e) => (e.changes.status as { after?: unknown } | undefined)?.after === "cancelled" && !/^staff_whatsapp_/.test(e.kind));
      if (!isNew && cancelledByOthers) entries.push({ kind: "cancelled", order, changes: [] });
      continue;
    }
    if (isNew) {
      entries.push({ kind: "new", order, changes: [] });
      continue;
    }
    const relevant = events.filter((e) => !isNoiseEvent(e));
    const changes: string[] = [];
    for (const field of MATERIAL_FIELDS) {
      const touched = relevant.filter((e) => field in e.changes);
      if (touched.length === 0) continue;
      const before = touched[0].changes[field]?.before;
      const after = touched[touched.length - 1].changes[field]?.after;
      if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
      changes.push(`${FIELD_WORD[field]}: ${valueOf(field, before)} → ${valueOf(field, after)}`);
    }
    if (relevant.some((e) => e.kind === "locked_field_conflict") && conflictFields(order).length > 0) {
      changes.push("customer asked to change something staff set — check before fulfilling");
    }
    if (changes.length > 0) {
      entries.push({ kind: "changed", order, changes });
    } else if (relevant.some((e) => e.kind === "attention_flagged") && orderWarning(order)) {
      entries.push({ kind: "attention", order, changes: [orderWarning(order)!] });
    }
  }
  const rank = { cancelled: 0, attention: 1, changed: 2, new: 3 } as const;
  return entries.sort((a, b) => rank[a.kind] - rank[b.kind] || Date.parse(a.order.first_message_at) - Date.parse(b.order.first_message_at));
}

const MAX_UPDATE_ENTRIES = 12;

export interface UpdateSummaryInput {
  entries: UpdateEntry[];
  since: Date;
  names?: OrderNames;
  timezone?: string;
  counts?: OrderCounts;
  /** True when no earlier update was delivered, so the window is the default (the last day), not "since the last update". */
  firstUpdate?: boolean;
  warning?: string | null;
}

/** The text of "!update": short, one message. It lists what happened and says plainly that nothing was marked reviewed. */
export function buildUpdateSummary(input: UpdateSummaryInput): string {
  const tz = input.timezone ?? DEFAULT_ORDERS_TIMEZONE;
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(input.since);
  const of = (k: UpdateEntry["kind"]) => input.entries.filter((e) => e.kind === k).length;
  const lines: string[] = [`🔔 *ORDER UPDATE* — since ${when}`];
  if (input.entries.length === 0) {
    lines.push(`✅ No new or changed orders${input.firstUpdate ? " in the last 24 hours" : ""}.`);
  } else {
    lines.push([of("new") ? `${of("new")} new` : "", of("changed") ? `${of("changed")} changed` : "", of("cancelled") ? `${of("cancelled")} cancelled` : "", of("attention") ? `${of("attention")} to check` : ""].filter(Boolean).join(" · "));
    for (const e of input.entries.slice(0, MAX_UPDATE_ENTRIES)) {
      const who = `*${safeText(orderDisplayName(e.order, input.names) ?? formatPhone(e.order.contact_number) ?? "Unknown customer", 30)} · ${displayRef(e.order.ref_code)}*`;
      if (e.kind === "new") {
        const date = orderDate(e.order, tz);
        const bits = [
          e.order.items.length ? e.order.items.map(orderItemText).join("; ") : "no products yet",
          e.order.fulfilment_method === "collection" ? "collection" : e.order.fulfilment_method === "delivery" ? `delivery${e.order.delivery_address ? ` ${safeText(e.order.delivery_address, 40)}` : ""}` : "",
          date ? dayLabel(date) : "no day yet",
        ].filter(Boolean);
        const gaps = orderGaps(e.order, tz).filter((g) => g !== "requested_for");
        lines.push(`🆕 ${who} — ${bits.join(" · ")}${gaps.length ? ` ⚠️ missing ${gaps.map(gapText).join(", ")}` : ""}`);
      } else if (e.kind === "cancelled") {
        lines.push(`🚫 ${who} — cancelled`);
      } else {
        lines.push(`${e.kind === "attention" ? "⚠️" : "✏️"} ${who} — ${e.changes.join("; ")}`);
      }
    }
    if (input.entries.length > MAX_UPDATE_ENTRIES) lines.push(`…and ${input.entries.length - MAX_UPDATE_ENTRIES} more — !orders`);
  }
  if (input.warning) lines.push(input.warning);
  const c = input.counts;
  const waiting = c ? [c.overdue ? `${c.overdue} overdue` : "", c.missing ? `${c.missing} missing info` : ""].filter(Boolean).join(" · ") : "";
  lines.push(`${waiting ? `${waiting} · ` : ""}Full list: !orders · This message does not mark anything as reviewed.`);
  return lines.join("\n");
}
