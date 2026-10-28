// Customer order memory for the daily order book — pure functions, no I/O, no path aliases (runs under `npm test`).
//
// "Same as last time", "the usual", "same location", "a bag of dog food": a repeat customer's words point at orders the
// business already holds. The history is NOT a new store: it is the customer's own rows in ai_agent_orders (staff
// corrections included), found by the same stable identity (verified phone / known @lid chats) and the same business.
//
// Rules that keep it honest:
//   * The customer's current words always win. History only fills what they did not say, and never overwrites.
//   * Only RELIABLE orders count: fulfilled, staff/customer-confirmed, or products a person corrected. An unconfirmed
//     enquiry is never a source.
//   * "Last time" is the most recent reliable order. "Usual" is the order (or product set) that repeats, and only when it
//     clearly repeats more than any other. A generic product name maps to a history product only when exactly one fits
//     or one clearly dominates. Anything else is left UNRESOLVED and flagged for a person, never guessed.
//   * Every value taken from history is reported back with the order it came from, so the order's history can say so.

import { normalizeText, productKey } from "./escalationUpdates.ts";
import { detectRepeatOrderRequest } from "./memory.ts";
import { quantityPhrases } from "./orderText.ts";
import { type OrderLine, sameLineProduct, type TrackedOrder } from "./orders.ts";

/** What the history needs of an order row. */
export type HistoryOrder = Pick<TrackedOrder, "id" | "ref_code" | "status" | "items" | "fulfilment_method" | "delivery_address" | "manual_locked_fields" | "last_message_at">;

/** Rows loaded per customer, and what the model is shown of them. */
export const HISTORY_LOAD_LIMIT = 12;
export const HISTORY_MODEL_ORDERS = 3;
export const HISTORY_MODEL_ITEMS = 5;
export const HISTORY_MODEL_ADDRESSES = 3;
/** "Usual" is read from at most this many recent reliable orders. */
const USUAL_WINDOW = 10;

// ── Which orders may be a source ─────────────────────────────────────────────

/** Fulfilled or confirmed, or products a person corrected. Never cancelled, never an unconfirmed enquiry. */
export function isReliableOrder(o: Pick<HistoryOrder, "status" | "items" | "manual_locked_fields">): boolean {
  if (o.status === "cancelled" || o.items.length === 0) return false;
  return o.status === "fulfilled" || o.status === "confirmed" || o.manual_locked_fields.includes("items");
}

/** An address a person stands behind: on a reliable order, or one staff typed themselves. Collection orders have none to reuse. */
export function hasVerifiedAddress(o: HistoryOrder): boolean {
  if (!o.delivery_address || o.status === "cancelled" || o.fulfilment_method === "collection") return false;
  return isReliableOrder(o) || o.manual_locked_fields.includes("delivery_address");
}

const newest = (a: HistoryOrder, b: HistoryOrder) => (Date.parse(b.last_message_at) || 0) - (Date.parse(a.last_message_at) || 0);

/** The reliable orders usable as a source, newest first, leaving out the order being edited. */
export function reliableHistory(history: HistoryOrder[], excludeIds: string[] = []): HistoryOrder[] {
  return history.filter((o) => !excludeIds.includes(o.id) && isReliableOrder(o)).sort(newest);
}

// ── What the customer's words point at ───────────────────────────────────────

export interface HistoryCue {
  /** "last": the most recent order. "usual": the one that repeats. */
  repeat: "last" | "usual" | null;
  /** "same dog food as last time": the product words, to narrow the lines. */
  product: string | null;
  sameLocation: boolean;
  /** "deliver somewhere else": do not reuse an address. */
  elsewhere: boolean;
  /** Only "this time" pointed back ("two bags this time"): a single-product source is required. */
  thisTimeOnly: boolean;
}

const USUAL = /\b(?:the |my )?usual\b|\bas (?:usual|always)\b|\bsame as always\b|\bregular order\b/i;
const SAME_PRODUCT = /\bsame\s+(?!as\b|again\b|order\b|thing\b|stuff\b|one\b|location\b|place\b|address\b|spot\b)([a-z0-9][a-z0-9 ]{1,30}?)\s+(?:as|like)\s+(?:last time|before|usual|previously)\b/i;
const SAME_LOCATION =
  /\bsame\s+(?:location|place|address|spot|delivery (?:address|location|spot))\b|\b(?:deliver|bring|send|drop)\w*\s+(?:it\s+|them\s+)?(?:to\s+|at\s+)?the same (?:place|location|address|spot)\b|\b(?:delivery|address|location|place)\s+(?:is\s+|are\s+)?(?:the\s+)?same\b(?!\s+(?:day|time|bag|product|order|thing|one)\b)|\bsame\s+(?:as|like)\s+(?:last time|before|usual|always)\s+(?:for\s+)?(?:the\s+)?(?:delivery|address|location|place)\b/i;
// "My usual location" points at the PLACE, not at the usual order: it must not also trigger an items repeat.
const USUAL_PLACE = /\b(?:the |my )?(?:usual|regular|normal|default|saved)\s+(?:delivery\s+)?(?:location|place|address|spot)\b/i;
const ELSEWHERE = /\b(?:some|any)(?:where|place) else\b|\b(?:a |an )?(?:different|another|new|other) (?:location|place|address|spot)\b/i;
const THIS_TIME = /\bthis time\b/i;

export function detectHistoryCue(texts: string[]): HistoryCue {
  const text = texts.join("\n");
  const elsewhere = ELSEWHERE.test(text);
  const sameLocation = !elsewhere && (SAME_LOCATION.test(text) || USUAL_PLACE.test(text));
  const withoutPlace = text.replace(USUAL_PLACE, " ");
  const usual = USUAL.test(withoutPlace);
  const last = detectRepeatOrderRequest(withoutPlace.replace(USUAL, ""));
  const thisTime = THIS_TIME.test(text);
  const repeat: HistoryCue["repeat"] = usual ? "usual" : last || thisTime ? "last" : null;
  const named = repeat ? SAME_PRODUCT.exec(text)?.[1] : undefined;
  const product = named ? normalizeText(named) : null;
  return { repeat, product, sameLocation, elsewhere, thisTimeOnly: repeat === "last" && !usual && !last };
}

export const cueActive = (c: HistoryCue) => c.repeat !== null || c.sameLocation || c.elsewhere;

// ── Product statistics ───────────────────────────────────────────────────────

const lineKey = (l: OrderLine) => [productKey(l.product), normalizeText(l.variant ?? ""), normalizeText(l.size ?? "")].join("|");
const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);
const tokens = (text: string) => normalizeText(text).split(" ").filter((w) => w.length >= 3 || /\d/.test(w)).map(stem);

interface LineStat {
  key: string;
  line: OrderLine;
  count: number;
  /** Newest reliable order that holds it. */
  ref: string;
}

/** How often each distinct product line (product + variant + size) appears across the reliable orders. */
export function lineStats(pool: HistoryOrder[]): LineStat[] {
  const stats = new Map<string, LineStat>();
  for (const o of pool) {
    for (const l of o.items) {
      const key = lineKey(l);
      const seen = stats.get(key);
      if (seen) seen.count += 1;
      else stats.set(key, { key, line: { product: l.product, quantity: null, variant: l.variant ?? null, size: l.size ?? null }, count: 1, ref: o.ref_code });
    }
  }
  return [...stats.values()].sort((a, b) => b.count - a.count);
}

/** The single clear winner: the only candidate, or one seen at least twice and at least three times as often as the next. */
function clearWinner(candidates: LineStat[]): LineStat | null {
  const sorted = [...candidates].sort((a, b) => b.count - a.count);
  if (sorted.length === 1) return sorted[0];
  if (sorted.length > 1 && sorted[0].count >= 2 && sorted[0].count >= sorted[1].count * 3) return sorted[0];
  return null;
}

// ── "The usual" ──────────────────────────────────────────────────────────────

/**
 * The order the customer repeats: the most common exact basket (products and quantities), else the most common set of
 * products with a quantity only where it never varied. Needs at least two occurrences and a strict lead; otherwise null.
 */
export function usualOrder(pool: HistoryOrder[]): { lines: OrderLine[]; ref: string } | null {
  const recent = pool.slice(0, USUAL_WINDOW);
  const strictLeader = (groups: Map<string, HistoryOrder[]>) => {
    const sizes = [...groups.values()].sort((a, b) => b.length - a.length);
    return sizes.length > 0 && sizes[0].length >= 2 && (sizes.length === 1 || sizes[0].length > sizes[1].length) ? sizes[0] : null;
  };
  const group = (sig: (o: HistoryOrder) => string) => {
    const groups = new Map<string, HistoryOrder[]>();
    for (const o of recent) groups.set(sig(o), [...(groups.get(sig(o)) ?? []), o]);
    return strictLeader(groups);
  };
  const withQuantity = group((o) => o.items.map((l) => `${lineKey(l)}|${normalizeText(l.quantity ?? "")}`).sort().join(";"));
  if (withQuantity) return { lines: withQuantity[0].items.map((l) => ({ ...l })), ref: withQuantity[0].ref_code };
  const sameProducts = group((o) => o.items.map(lineKey).sort().join(";"));
  if (!sameProducts) return null;
  const lines = sameProducts[0].items.map((l) => {
    const quantities = new Set(sameProducts.map((o) => normalizeText(o.items.find((x) => lineKey(x) === lineKey(l))?.quantity ?? "")));
    return { ...l, quantity: quantities.size === 1 ? l.quantity : null };
  });
  return { lines, ref: sameProducts[0].ref_code };
}

// ── Resolving a turn against the history ─────────────────────────────────────

/** Where a filled address came from when it is the staff-saved default rather than an earlier order's reference. */
export const SAVED_LOCATION_SOURCE = "saved location";

export interface HistoryFill {
  /** Lines to add where the order does not already hold that product. */
  items: OrderLine[];
  /** A delivery address to use when the order has none. */
  address: string | null;
  /** The customer pointed at a delivery place: record delivery when no method is set yet. */
  setDelivery: boolean;
  /** "Somewhere else": drop an address the order holds (the customer will give the new one). */
  clearAddress: boolean;
  /** Order reference each filled value came from. */
  sources: { items?: string; delivery_address?: string };
  /** What the customer pointed at but history could not answer safely. Non-empty means a person should look. */
  unresolved: string[];
}

export interface FillContext {
  /** The order being edited (null for a new one). */
  current: { id: string; items: OrderLine[]; delivery_address: string | null; fulfilment_method: string | null } | null;
  /** The lines the customer's own words (and the model's grounded reading) already give this turn. */
  draftItems: OrderLine[];
  draftAddress: string | null;
  /** The customer's staff-saved default delivery location, if any. "Same place" / "usual location" resolve to it first. */
  defaultLocation?: string | null;
  /**
   * No cue needed: when the customer gave no location (and is not collecting or going "somewhere else"), fill the
   * saved default, else the one verified earlier address. Only ever fills a gap; never overwrites a stated location.
   */
  implicitLocation?: boolean;
  /** The customer (or the order) is collecting, so there is no delivery location to fill. */
  collecting?: boolean;
}

const sameAddress = (a: string, b: string) => normalizeText(a) === normalizeText(b);

/**
 * The delivery address from the customer's earlier orders when it is UNAMBIGUOUS: every verified address (a reliable
 * order's, or one staff typed) is the same place. Two different verified places mean we cannot tell which one the
 * customer means today, so none is used.
 */
export function unambiguousVerifiedAddress(history: HistoryOrder[], excludeId?: string | null): HistoryOrder | null {
  const verified = history.filter((o) => o.id !== excludeId && hasVerifiedAddress(o)).sort(newest);
  if (verified.length === 0) return null;
  return verified.every((o) => sameAddress(o.delivery_address!, verified[0].delivery_address!)) ? verified[0] : null;
}

const emptyFill = (): HistoryFill => ({ items: [], address: null, setDelivery: false, clearAddress: false, sources: {}, unresolved: [] });

export function resolveFromHistory(history: HistoryOrder[], cue: HistoryCue, turnTexts: string[], ctx: FillContext): HistoryFill {
  const fill = emptyFill();
  const pool = reliableHistory(history, ctx.current ? [ctx.current.id] : []);
  const held = [...(ctx.current?.items ?? []), ...ctx.draftItems];

  if (cue.repeat) {
    const source = cue.repeat === "usual" ? usualOrder(pool) : pool[0] ? { lines: pool[0].items.map((l) => ({ ...l })), ref: pool[0].ref_code } : null;
    if (!source) fill.unresolved.push(cue.repeat === "usual" ? "items: no clear usual order" : "items: no verified earlier order");
    else {
      let lines = source.lines;
      if (cue.product) {
        const wanted = tokens(cue.product);
        lines = lines.filter((l) => wanted.every((w) => tokens(`${l.product} ${l.variant ?? ""}`).includes(w)));
      }
      if (lines.length === 0) fill.unresolved.push("items: no earlier product matches what the customer named");
      else if (cue.thisTimeOnly && lines.length > 1) fill.unresolved.push("items: the last order had several products");
      else {
        // "Two bags this time": one plain quantity, one product to apply it to.
        const phrases = quantityPhrases(turnTexts).filter((p) => !p.vague);
        if (phrases.length === 1 && lines.length === 1) lines = [{ ...lines[0], quantity: phrases[0].quantity }];
        const fresh = lines.filter((l) => !held.some((h) => sameLineProduct(h, l)));
        if (fresh.length > 0) {
          fill.items = fresh;
          fill.sources.items = source.ref;
        }
      }
    }
  }

  if (cue.elsewhere) {
    fill.clearAddress = Boolean(ctx.current?.delivery_address);
  } else if (cue.sameLocation && !ctx.draftAddress && !ctx.current?.delivery_address && ctx.defaultLocation) {
    // The location staff saved for this customer beats an address inferred from their last order.
    fill.address = ctx.defaultLocation;
    fill.setDelivery = ctx.current?.fulfilment_method !== "collection";
    fill.sources.delivery_address = SAVED_LOCATION_SOURCE;
  } else if (cue.sameLocation && !ctx.draftAddress && !ctx.current?.delivery_address) {
    const place = history.filter((o) => !(ctx.current && o.id === ctx.current.id) && hasVerifiedAddress(o)).sort(newest)[0];
    if (!place) fill.unresolved.push("delivery_address: no verified earlier address");
    else {
      fill.address = place.delivery_address;
      fill.setDelivery = ctx.current?.fulfilment_method !== "collection";
      fill.sources.delivery_address = place.ref_code;
    }
  } else if (ctx.implicitLocation && !cue.sameLocation && !ctx.collecting && !ctx.draftAddress && !ctx.current?.delivery_address) {
    // Priority: the location the customer states now (draftAddress, handled by the guards above) > the location staff
    // saved > one unambiguous verified earlier address > nothing (the order stays "address missing" for a person).
    if (ctx.defaultLocation) {
      fill.address = ctx.defaultLocation;
      fill.setDelivery = true;
      fill.sources.delivery_address = SAVED_LOCATION_SOURCE;
    } else {
      const place = unambiguousVerifiedAddress(history, ctx.current?.id);
      if (place) {
        fill.address = place.delivery_address;
        fill.setDelivery = true;
        fill.sources.delivery_address = place.ref_code;
      }
    }
  }
  return fill;
}

// ── Generic product names ("a bag of dog food") ──────────────────────────────

/**
 * A line the customer worded generically, with no variant or size, becomes the history product it unambiguously means:
 * every word they wrote appears in exactly one distinct history line, or one such line clearly dominates. Anything the
 * order already holds, or that matches several products without a clear winner, is left as the customer wrote it.
 */
export function upgradeGenericLines(lines: OrderLine[], pool: HistoryOrder[], held: OrderLine[]): { lines: OrderLine[]; sources: { product: string; ref: string }[] } {
  if (pool.length === 0) return { lines, sources: [] };
  const stats = lineStats(pool);
  const sources: { product: string; ref: string }[] = [];
  const out = lines.map((l) => {
    if (l.variant || l.size || held.some((h) => sameLineProduct(h, l))) return l;
    const wanted = tokens(l.product);
    if (wanted.length === 0) return l;
    const fits = stats.filter((s) => wanted.every((w) => tokens(`${s.line.product} ${s.line.variant ?? ""} ${s.line.size ?? ""}`).includes(w)));
    const winner = clearWinner(fits);
    if (!winner || lineKey(winner.line) === lineKey(l)) return l;
    sources.push({ product: winner.line.product, ref: winner.ref });
    return { ...winner.line, quantity: l.quantity };
  });
  return { lines: out, sources };
}

/**
 * The model may nominate a history product for a generic phrase (it understands "dog food" ≈ a Monello bag, which no
 * word match can). The server accepts it only if the nominated order is one it showed, that order really holds that
 * product, and the product is either the only one in the customer's history or clearly dominates it.
 */
export function acceptModelHistoryLine(
  nominated: { product: string; variant?: string | null; size?: string | null; from_history?: string | null },
  pool: HistoryOrder[]
): { line: OrderLine; ref: string } | null {
  const ref = nominated.from_history?.trim().toUpperCase();
  const order = ref ? pool.find((o) => o.ref_code.toUpperCase() === ref) : undefined;
  if (!order) return null;
  const asked: OrderLine = { product: nominated.product, quantity: null, variant: nominated.variant ?? null, size: nominated.size ?? null };
  const held = order.items.find((l) => sameLineProduct(l, asked));
  if (!held) return null;
  const line: OrderLine = { product: held.product, quantity: null, variant: held.variant ?? null, size: held.size ?? null };
  const stats = lineStats(pool);
  const winner = clearWinner(stats);
  if (!winner || lineKey(winner.line) !== lineKey(line)) return null;
  return { line, ref: order.ref_code };
}

// ── What the model is shown ──────────────────────────────────────────────────

/** Compact, bounded view of the customer's reliable history for the prompt, or null when there is none. */
export function historyForModel(history: HistoryOrder[]): unknown | null {
  const pool = reliableHistory(history);
  if (pool.length === 0) return null;
  const item = (l: OrderLine) => ({ product: l.product, quantity: l.quantity, variant: l.variant, size: l.size });
  const addresses = new Map<string, { address: string; times: number }>();
  for (const o of pool.filter(hasVerifiedAddress)) {
    const key = normalizeText(o.delivery_address ?? "");
    const seen = addresses.get(key);
    if (seen) seen.times += 1;
    else addresses.set(key, { address: o.delivery_address!, times: 1 });
  }
  return {
    recent_orders: pool.slice(0, HISTORY_MODEL_ORDERS).map((o) => ({
      ref: o.ref_code,
      date: o.last_message_at.slice(0, 10),
      items: o.items.map(item),
      delivery_address: hasVerifiedAddress(o) ? o.delivery_address : null,
    })),
    most_repeated_products: lineStats(pool)
      .filter((s) => s.count >= 2)
      .slice(0, HISTORY_MODEL_ITEMS)
      .map((s) => ({ ...item(s.line), times: s.count, ref: s.ref })),
    delivery_addresses: [...addresses.values()].slice(0, HISTORY_MODEL_ADDRESSES),
  };
}
