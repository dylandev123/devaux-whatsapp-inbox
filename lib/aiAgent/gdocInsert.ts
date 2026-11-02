// The Google Docs side of the order sync — pure, no I/O. The sync is APPEND-ONLY AT THE TOP: a new order becomes one new
// paragraph at the very start of the document's first tab. Nothing already in the document is ever read back, rewritten,
// deleted or moved by the app; staff edit the lines they want to change by hand.
//
// Google Docs index rules this relies on (all indices are UTF-16 code units, i.e. String.length):
//   * Index 0 is the document's section break and can never take text. The first character of the body is index 1, so a
//     new first paragraph is inserted at index 1.
//   * `location.tabId` is deliberately omitted. Per the Docs API, an insert without a tabId applies to the FIRST tab (and to
//     the only tab of a single-tab document), so no tab id has to be looked up — which would mean reading the document.
//   * Inserted text takes the paragraph style and character style of whatever it lands in. A document that opens with a
//     Title, a heading, a bulleted item or bold/coloured text must not turn the order line into one: the new paragraph is
//     explicitly reset to plain body text. Only the NEW paragraph's range is styled; the paragraph that was first (and
//     is now second) keeps its own style untouched.
//   * A document that opens with a table cannot take text at index 1; Google rejects that write with a 400, which the sync
//     reports as a document problem instead of guessing a different place.

import { formatOrderLine, tagFor, type FormatConfig, type LineOrder } from "./gdocFormat.ts";
import { isOpenStatus, isUnderReview } from "./orders.ts";

export type DocRequest = Record<string, unknown>;

/** The first character of a document body (index 0 is the section break). */
export const INSERT_INDEX = 1;

// ── Requests ─────────────────────────────────────────────────────────────────
const GREY = { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } };
const RESET_TEXT_FIELDS = "bold,italic,underline,strikethrough,smallCaps,foregroundColor,backgroundColor,fontSize,baselineOffset";
const RESET_PARAGRAPH_FIELDS = "namedStyleType,alignment,indentStart,indentFirstLine,direction";
const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex });

/** The exact text inserted for one order: the line, a space, the small tag, a line break. */
export const lineParagraph = (text: string, refCode: string): string => `${text} ${tagFor(refCode)}\n`;

/**
 * The batchUpdate requests that put one order line at the very start of the first tab.
 * `styled: false` is the bare insert (used as a fallback when Google refuses the styling requests, so a cosmetic problem can
 * never keep an order out of the document).
 */
export function insertLineRequests(text: string, refCode: string, options: { styled?: boolean } = {}): DocRequest[] {
  const paragraph = lineParagraph(text, refCode);
  const insert: DocRequest = { insertText: { location: { index: INSERT_INDEX }, text: paragraph } };
  if (options.styled === false) return [insert];
  const start = INSERT_INDEX;
  const end = start + paragraph.length; // just after the new paragraph's line break
  const tagStart = start + text.length + 1;
  return [
    insert,
    { updateParagraphStyle: { range: range(start, end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: RESET_PARAGRAPH_FIELDS } },
    { deleteParagraphBullets: { range: range(start, end) } },
    { updateTextStyle: { range: range(start, end - 1), textStyle: {}, fields: RESET_TEXT_FIELDS } },
    { updateTextStyle: { range: range(tagStart, end - 1), textStyle: { foregroundColor: GREY, fontSize: { magnitude: 8, unit: "PT" } }, fields: "foregroundColor,fontSize" } },
  ];
}

// ── Recognising our own line (crash recovery only) ───────────────────────────
export interface TextRunDocument {
  body?: { content?: { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] };
}

/** Which of these order tags appear in the document text. Used only to settle an insert whose outcome is unknown. */
export function tagsPresent(doc: TextRunDocument, refCodes: string[]): Set<string> {
  const wanted = new Map(refCodes.map((r) => [tagFor(r), r]));
  const found = new Set<string>();
  for (const el of doc.body?.content ?? []) {
    for (const e of el.paragraph?.elements ?? []) {
      const text = e.textRun?.content;
      if (!text || !text.includes("⟨")) continue;
      for (const [tag, ref] of wanted) if (text.includes(tag)) found.add(ref);
    }
  }
  return found;
}

// ── Which orders get a line ──────────────────────────────────────────────────
/** The order columns the sync reads (a subset of TrackedOrder). */
export interface SyncOrder extends LineOrder {
  id: string;
  attention: string | null;
  created_at: string;
}

export type Mode = "auto" | "import";

export interface InsertPolicy {
  format: FormatConfig;
  includeIncomplete: boolean;
  /** Auto sync lists only orders created at or after this instant. null = nothing syncs automatically. */
  syncSince: string | null;
}

/** May this order get a NEW line? */
export function eligibleForNewLine(order: SyncOrder, policy: InsertPolicy, mode: Mode): { ok: true } | { ok: false; reason: string } {
  if (!isOpenStatus(order.status)) return { ok: false, reason: "closed order" };
  if (isUnderReview({ status: order.status as never, attention: order.attention })) return { ok: false, reason: "might not be an order — waiting for staff to confirm it" };
  if (!order.items || order.items.length === 0) return { ok: false, reason: "no products yet" };
  if (mode === "auto") {
    if (!policy.syncSince) return { ok: false, reason: "sync has not been enabled" };
    if (Date.parse(order.created_at) < Date.parse(policy.syncSince)) return { ok: false, reason: "created before sync was enabled" };
  }
  if (!policy.includeIncomplete) {
    const { missing } = formatOrderLine(order, policy.format);
    if (order.status === "possible" || missing.length > 0) return { ok: false, reason: "incomplete order (incomplete orders are switched off)" };
  }
  return { ok: true };
}

export interface InsertPlan {
  /** Oldest first: inserting each at the top in this order leaves the newest order on top. */
  insert: SyncOrder[];
  skipped: { order: SyncOrder; reason: string }[];
}

/**
 * Orders that should be written now. `states` maps order id → the state of its existing line row. An order is a candidate
 * only when it has no row, or its last attempt is known to have failed before reaching the document; every other state
 * (synced, in flight, unconfirmed, skipped, anything older) means "do not insert again".
 */
export function planInsertions(orders: SyncOrder[], states: Map<string, string>, policy: InsertPolicy, mode: Mode): InsertPlan {
  const insert: SyncOrder[] = [];
  const skipped: InsertPlan["skipped"] = [];
  const sorted = [...orders].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.ref_code.localeCompare(b.ref_code));
  for (const order of sorted) {
    const state = states.get(order.id);
    if (state !== undefined && state !== "failed") continue;
    const ok = eligibleForNewLine(order, policy, mode);
    if (ok.ok) insert.push(order);
    else skipped.push({ order, reason: ok.reason });
  }
  return { insert, skipped };
}
