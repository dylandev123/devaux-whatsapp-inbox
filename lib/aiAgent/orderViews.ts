// The order views staff read — pure (no I/O), unit-tested in tests/aiAgentOrderViews.test.ts.
//
//   !orders [today|tomorrow|<date>|all|overdue|missing|undated]   what is outstanding, by the day it is FOR
//
// Orders are placed on the day they are intended for (delivery or collection), never on the day the message arrived. The
// day is read from `requested_for` (see requestedDate in orderText.ts); an order with no readable day is "undated", and an
// order whose day has passed (or an undated one first mentioned on an earlier day) is "overdue". Nothing here completes,
// cancels or deletes an order: an old order stays listed under Overdue until a person completes or cancels it.

import { type AddressProvenance, addressTag } from "./orderAddress.ts";
import { classifyDeliveryRegion, southGroupOrder } from "./deliveryRegions.ts";
import { effectiveDate, effectiveMethod } from "./orderDefaults.ts";
import { addDays, resolveRequestedDay } from "./orderText.ts";
import {
  computeMissing,
  conflictFields,
  conflictValueText,
  DEFAULT_ORDERS_TIMEZONE,
  displayRef,
  formatPhone,
  isOpenStatus,
  isUnderReview,
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
  | { type: "undated" }
  /** Open orders that might not be orders at all (an invoice, a price talk…): waiting for a person to confirm or cancel them. */
  | { type: "review" };

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
  if (text === "review" || text === "possible") return { type: "review" };
  if (text.length > 40) return null;
  const day = resolveRequestedDay(text, now, timezone);
  return day ? { type: "day", date: day.date } : null;
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** "review": might not be an order; it is in no day's list until a person confirms it. */
export type Bucket = "overdue" | "today" | "tomorrow" | "later" | "undated" | "review";

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

/**
 * The day an order is for (YYYY-MM-DD in the business's timezone): the day the customer named or, when they named none,
 * the business default (today before 9:00 AM Saint Lucia time, otherwise tomorrow, counted from when the request was
 * written; see orderDefaults.ts). null only when they gave words that cannot be read as one day ("next week").
 */
export function orderDate(o: Pick<TrackedOrder, "requested_for" | "first_message_at">, timezone: string = DEFAULT_ORDERS_TIMEZONE): string | null {
  return effectiveDate(o, timezone).date;
}

/** "Wed 28 Oct". */
export const dayLabel = (dateKey: string): string => addDays(dateKey, 0).label;

/**
 * Where an order belongs today. An undated order is "undated" only on the day it was first mentioned; after that it is
 * overdue, so an old enquiry is never silently carried into a new day as if it were fresh.
 */
export function bucketOf(o: Pick<TrackedOrder, "requested_for" | "first_message_at"> & Partial<Pick<TrackedOrder, "status" | "attention">>, ctx: DayContext): Bucket {
  if (o.status !== undefined && o.attention !== undefined && isUnderReview({ status: o.status, attention: o.attention })) return "review";
  const date = orderDate(o, ctx.timezone);
  if (date === null) return localParts(new Date(o.first_message_at), ctx.timezone).dateKey < ctx.today ? "overdue" : "undated";
  if (date < ctx.today) return "overdue";
  if (date === ctx.today) return "today";
  if (date === ctx.tomorrow) return "tomorrow";
  return "later";
}

/**
 * What an order genuinely lacks: products, a quantity, a delivery address (unless it is a collection), or a day the customer
 * gave in words that cannot be read. A missing delivery/collection choice and a missing day are NOT gaps: the business
 * defaults (delivery; today before 9 AM, else tomorrow) apply.
 */
export function orderGaps(o: Pick<TrackedOrder, "items" | "fulfilment_method" | "delivery_address" | "requested_for" | "first_message_at">, timezone: string = DEFAULT_ORDERS_TIMEZONE): string[] {
  const missing = computeMissing(o).filter((m) => m !== "requested_for");
  // A day written in words that cannot be read ("sometime next week") is a real gap; no day at all is not.
  if (effectiveDate(o, timezone).source === "unreadable") missing.push("requested_for");
  return missing;
}

const gapText = (key: string) => (key === "requested_for" ? "day" : (MISSING_TEXT[key] ?? key));

/** Open, and something a person should look at: it is overdue, lacks essential information, or carries a warning. */
export function needsAttention(o: TrackedOrder, ctx: DayContext): boolean {
  if (!isOpenStatus(o.status)) return false;
  return isUnderReview(o) || bucketOf(o, ctx) === "overdue" || orderGaps(o, ctx.timezone).length > 0 || orderWarning(o) !== null;
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
  /** Open orders waiting for a person to say whether they are orders. Counted in `open`, in no day. */
  review: number;
}

/** The numbers shown beside the views (WhatsApp footer, website tabs): one definition for both. */
export function countOrders(orders: TrackedOrder[], ctx: DayContext): OrderCounts {
  const counts: OrderCounts = { open: 0, today: 0, tomorrow: 0, later: 0, overdue: 0, undated: 0, missing: 0, attention: 0, review: 0 };
  for (const o of orders) {
    if (!isOpenStatus(o.status)) continue;
    counts.open += 1;
    if (isUnderReview(o)) {
      counts.review += 1;
      counts.attention += 1;
      continue;
    }
    const bucket = bucketOf(o, ctx);
    if (bucket !== "undated" && bucket !== "review") counts[bucket] += 1;
    if (orderDate(o, ctx.timezone) === null) counts.undated += 1;
    if (orderGaps(o, ctx.timezone).length > 0) counts.missing += 1;
    if (needsAttention(o, ctx)) counts.attention += 1;
  }
  return counts;
}

/** Which orders a view lists, in the order they are shown (by day, then by when they were first mentioned). */
export function selectOrders(view: OrdersView, orders: TrackedOrder[], ctx: DayContext): TrackedOrder[] {
  const everyOpen = orders.filter((o) => isOpenStatus(o.status));
  // An order that might not be an order is in no day's list: it has its own view, and "all" ends with it.
  const open = everyOpen.filter((o) => !isUnderReview(o));
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
    case "review":
      return everyOpen.filter(isUnderReview).sort((a, b) => Date.parse(a.first_message_at) - Date.parse(b.first_message_at));
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
export const timeOfDay = (requestedFor: string | null): string | null => (requestedFor ?? "").match(TIME_OF_DAY)?.[1].toLowerCase() ?? null;

const STATUS_BADGE: Record<string, string> = { confirmed: "✅ confirmed", awaiting_confirmation: "🕓 to confirm", possible: "❔ incomplete" };

export interface LineOptions {
  /** Where each order's address came from (orderAddress.ts), by order id. Only inferred addresses are marked. */
  addresses?: Record<string, AddressProvenance>;
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
  const day = effectiveDate(o, tz);
  const date = day.date;
  const { method } = effectiveMethod(o);
  const where = [
    method === "delivery" ? (o.delivery_address ? `📍 ${safeText(o.delivery_address, 80)}${addressTag(opts.addresses?.[o.id] ?? { origin: "customer" })}` : "📍 address needed") : "🛍 collection",
    // Grouped views already show the day in their heading. Where no heading does, the actual date is shown; whether the day
    // was stated or defaulted stays in the stored value (orderDefaults.ts) and in !order #REF, not in the report line.
    opts.showDate
      ? date
        ? `🗓 ${dayLabel(date)}`
        : o.requested_for
          ? `🗓 “${safeText(o.requested_for, 40)}” (no date read)`
          : "🗓 no day"
      : "",
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

export const SOUTH_HEADING = "🧭 *South Deliveries*";

/** The southern deliveries among `orders` (all of them deliveries), grouped by destination in the table's order. */
export function southDeliveries(orders: TrackedOrder[]): { group: string; orders: TrackedOrder[] }[] {
  const byGroup = new Map<string, TrackedOrder[]>();
  for (const o of orders) {
    if (effectiveMethod(o).method !== "delivery") continue;
    const region = classifyDeliveryRegion(o.delivery_address);
    if (region.region === "south") byGroup.set(region.group, [...(byGroup.get(region.group) ?? []), o]);
  }
  const order = southGroupOrder();
  return [...byGroup.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([group, list]) => ({ group, orders: list }));
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
  /** Address provenance by order id (loadAddressProvenance). Missing entries read as the customer's own address. */
  addresses?: Record<string, AddressProvenance>;
}

/** The stored kind of a report: one list per kind (and per date for a specific day) stays current. */
export const viewKind = (view: OrdersView): string => (view.type === "day" ? `day:${view.date}` : view.type);

export interface OrdersViewResult {
  parts: string[];
  /** The orders in the order they were numbered in the text (1, 2, 3 …): what "!order 2" means for this report. */
  numbered: { n: number; order: TrackedOrder }[];
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
  const numberedOrders: { n: number; order: TrackedOrder }[] = [];
  const numbered = (o: TrackedOrder, opts: LineOptions = {}) => {
    numberedOrders.push({ n: number, order: o });
    return orderViewBlock(o, number++, input.names, { timezone: tz, addresses: input.addresses, ...opts });
  };

  /** One day: its heading, then Delivery / Collection / not-stated groups. Numbering continues across days. */
  const dayBlock = (key: string) => {
    const word = key === ctx.today ? "TODAY — " : key === ctx.tomorrow ? "TOMORROW — " : key < ctx.today ? "WAS DUE — " : "";
    const dayOrders = picked.filter((o) => orderDate(o, tz) === key);
    chunks.push({ text: `📅 *${word}${dayLabel(key)}* (${dayOrders.length})`, heading: true });
    if (dayOrders.length === 0) chunks.push({ text: "Nothing outstanding." });
    for (const method of ["delivery", "collection"] as const) {
      const group = dayOrders.filter((o) => effectiveMethod(o).method === method);
      if (group.length === 0) continue;
      if (method === "collection") {
        chunks.push({ text: METHOD_HEADING[method], heading: true });
        for (const o of group) chunks.push({ text: numbered(o) });
        continue;
      }
      // Deliveries going to a reviewed southern destination are listed together under it (one run for the driver); each
      // order appears once, in exactly one of the two lists. Anything not clearly southern stays in the ordinary Delivery list.
      const south = southDeliveries(group);
      const rest = group.filter((o) => !south.some((g) => g.orders.includes(o)));
      if (rest.length > 0) {
        chunks.push({ text: METHOD_HEADING.delivery, heading: true });
        for (const o of rest) chunks.push({ text: numbered(o) });
      }
      if (south.length > 0) {
        chunks.push({ text: SOUTH_HEADING, heading: true });
        for (const g of south) {
          chunks.push({ text: `📍 *${g.group}* (${g.orders.length})`, heading: true });
          for (const o of g.orders) chunks.push({ text: numbered(o) });
        }
      }
    }
  };
  const flat = (orders: TrackedOrder[], showDate = true) => orders.forEach((o) => chunks.push({ text: numbered(o, { showDate }) }));
  const reviewing = input.orders.filter(isUnderReview).sort((a, b) => Date.parse(a.first_message_at) - Date.parse(b.first_message_at));

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
        chunks.push({ text: `❔ *DAY NOT CLEAR (${fresh.length})*`, heading: true });
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
        chunks.push({ text: `❔ *DAY NOT CLEAR (${noDay.length})*`, heading: true });
        flat(noDay);
      }
      if (reviewing.length > 0) {
        chunks.push({ text: `🔎 *MIGHT NOT BE AN ORDER (${reviewing.length})*`, heading: true });
        flat(reviewing, false);
      }
      break;
    }
    case "overdue": {
      title = "📋 *OVERDUE ORDERS*";
      empty = "✅ No overdue orders.";
      for (const key of [...new Set(picked.map((o) => orderDate(o, tz)).filter((d): d is string => d !== null))].sort()) dayBlock(key);
      const noDay = picked.filter((o) => orderDate(o, tz) === null);
      if (noDay.length > 0) {
        chunks.push({ text: `❔ *DAY NOT CLEAR — first mentioned before today (${noDay.length})*`, heading: true });
        flat(noDay);
      }
      if (picked.length > 0) chunks.push({ text: "Done? !order #REF completed · new day: !order #REF delivery <date> · cancel: !order #REF cancelled" });
      break;
    }
    case "missing":
      title = "📋 *ORDERS MISSING INFORMATION*";
      empty = "✅ Every outstanding order has the essentials (products, quantity, delivery address).";
      flat(picked);
      break;
    case "review":
      title = "📋 *POSSIBLE ORDERS TO REVIEW*";
      empty = "✅ Nothing waiting for review.";
      flat(picked, false);
      if (picked.length > 0) chunks.push({ text: "These are not on any delivery list. Real order: !order #REF confirmed · not an order: !order #REF cancelled" });
      break;
    case "undated":
      title = "📋 *ORDERS WITH AN UNCLEAR DAY*";
      empty = "✅ Every outstanding order has a clear day.";
      flat(picked);
      if (picked.length > 0) chunks.push({ text: "Set the day: !order #REF delivery <date>" });
      break;
  }
  if (chunks.length === 0) chunks.push({ text: empty });

  // Pointers to what this answer does NOT show, so nothing waits unseen.
  const pointers: string[] = [];
  if (view.type !== "overdue" && counts.overdue > 0) pointers.push(`⏰ ${plural(counts.overdue, "overdue order")} — !orders overdue`);
  if (view.type !== "review" && view.type !== "all" && counts.review > 0) pointers.push(`🔎 ${plural(counts.review, "possible order")} to review (not on any list) — !orders review`);
  if (view.type !== "missing" && counts.missing > 0) pointers.push(`⚠️ ${plural(counts.missing, "order")} missing information — !orders missing`);
  if (view.type === "default" && counts.later > 0) pointers.push(`🗓 ${plural(counts.later, "later order")} — !orders <date>`);
  if (view.type === "default") pointers.push("Details: !order #REF · Done: !order #REF completed");
  const footer = [input.warning, ...pointers].filter((x): x is string => Boolean(x));
  if (footer.length > 0) chunks.push({ text: footer.join("\n") });

  const packed = pack(title, chunks);
  if (packed.omitted > 0) packed.parts[packed.parts.length - 1] += `\n\n…and ${plural(packed.omitted, "more order")} — see the Orders page in the inbox.`;
  return { parts: packed.parts, numbered: numberedOrders, shown: picked.length + (view.type === "default" ? fresh.length : 0), counts };
}
