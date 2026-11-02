// Decides what the Google Doc sync does for each order — pure, no I/O. The database (Supabase) stays the authoritative
// order record; this only reads orders and the document and returns the actions, so every rule is testable offline.
//
// Rules that keep a staff member's document safe:
//   * A line is rewritten or removed ONLY when the paragraph still holds exactly the text the app last wrote. If a person
//     changed it (or it is duplicated) the change is held as a conflict with both versions and nothing is written.
//   * A line a person deleted is never put back automatically ("missing"); a dashboard action decides.
//   * An order that already has a line is found by its tag first, so a retry, a reconnect or a crash between the document
//     write and the database write can never add the same order twice.
//   * Orders that might not be orders (under review), or have no items, are never listed.

import { formatOrderLine, markedText, sameText, type FormatConfig, type LineOrder } from "./gdocFormat.ts";
import { inspectLine, paragraphsWithTag, type DocParagraph, type GoogleDocument } from "./gdocDocument.ts";
import { isOpenStatus, isUnderReview } from "./orders.ts";

export type OnFinished = "leave" | "mark" | "remove";
export type OnCorrected = "update" | "review";

export interface SyncPolicy {
  format: FormatConfig;
  onCompleted: OnFinished;
  onCancelled: OnFinished;
  onCorrected: OnCorrected;
  includeIncomplete: boolean;
  /** Auto sync lists only orders created at or after this instant. null = nothing syncs automatically. */
  syncSince: string | null;
}

/** The order columns the sync reads (a subset of TrackedOrder). */
export interface SyncOrder extends LineOrder {
  id: string;
  version: number;
  attention: string | null;
  created_at: string;
}

export type LineState = "synced" | "pending_review" | "conflict" | "missing" | "failed";

/** An ai_agent_gdoc_lines row, the columns the planner reads. */
export interface LineRecord {
  order_id: string;
  tag: string;
  state: LineState;
  last_text: string | null;
  synced_version: number | null;
  synced_status: string | null;
  attempts: number;
}

export const MAX_AUTO_ATTEMPTS = 5;

export type Write =
  | { type: "insert"; text: string }
  | { type: "rewrite"; paragraph: DocParagraph; text: string; done: boolean }
  | { type: "remove"; paragraph: DocParagraph };

/** What to store on the order's line row. `applied` fields describe the document AFTER the write succeeds. */
export interface LinePatch {
  state: LineState;
  last_text?: string | null;
  synced_version?: number;
  synced_status?: string;
  pending_text?: string | null;
  pending_action?: "insert" | "update" | "mark" | "remove" | null;
  pending_reason?: string | null;
  found_text?: string | null;
}

export interface SyncAction {
  order: SyncOrder;
  write: Write | null;
  patch: LinePatch;
  /** One line for the activity trail / dashboard. */
  note: string;
}

export type Mode = "auto" | "import";

const CLEAR: Pick<LinePatch, "pending_text" | "pending_action" | "pending_reason" | "found_text"> = {
  pending_text: null,
  pending_action: null,
  pending_reason: null,
  found_text: null,
};

export const isFinished = (status: string): status is "fulfilled" | "cancelled" => status === "fulfilled" || status === "cancelled";

/** May this order get a NEW line? (An order that already has one is handled by its record.) */
export function eligibleForNewLine(order: SyncOrder, policy: SyncPolicy, mode: Mode): { ok: true } | { ok: false; reason: string } {
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

/** The line text the order should have now, and whether it is a finished order under the "mark" policy. */
function desiredLine(order: SyncOrder, policy: SyncPolicy): { text: string; done: boolean; action: "update" | "mark" | "remove" | "leave" } {
  const base = formatOrderLine(order, policy.format).text;
  if (order.status === "fulfilled") {
    return policy.onCompleted === "mark" ? { text: markedText(base, "fulfilled"), done: true, action: "mark" } : { text: base, done: false, action: policy.onCompleted === "remove" ? "remove" : "leave" };
  }
  if (order.status === "cancelled") {
    return policy.onCancelled === "mark" ? { text: markedText(base, "cancelled"), done: true, action: "mark" } : { text: base, done: false, action: policy.onCancelled === "remove" ? "remove" : "leave" };
  }
  return { text: base, done: false, action: "update" };
}

const synced = (order: SyncOrder, text: string | null): LinePatch => ({ state: "synced", last_text: text, synced_version: order.version, synced_status: order.status, ...CLEAR });

export interface PlanInput {
  orders: SyncOrder[];
  records: Map<string, LineRecord>;
  doc: GoogleDocument;
  policy: SyncPolicy;
  mode: Mode;
  /** Dashboard "retry" / "use AI version": failed lines are tried again regardless of the attempt count. */
  force?: boolean;
}

export interface Plan {
  actions: SyncAction[];
  /** Orders left alone, with the reason (shown in the import preview). */
  skipped: { order: SyncOrder; reason: string }[];
}

export function planSync(input: PlanInput): Plan {
  const { doc, policy, mode } = input;
  const actions: SyncAction[] = [];
  const skipped: Plan["skipped"] = [];
  const orders = [...input.orders].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.ref_code.localeCompare(b.ref_code));

  for (const order of orders) {
    const rec = input.records.get(order.id);

    // ── No line yet ──────────────────────────────────────────────────────────
    if (!rec || (rec.state === "failed" && rec.last_text === null)) {
      if (rec && !input.force && rec.attempts >= MAX_AUTO_ATTEMPTS) {
        skipped.push({ order, reason: "failed too many times — retry from the dashboard" });
        continue;
      }
      const ok = eligibleForNewLine(order, policy, mode);
      if (!ok.ok) {
        skipped.push({ order, reason: ok.reason });
        continue;
      }
      const text = formatOrderLine(order, policy.format).text;
      const present = paragraphsWithTag(doc, order.ref_code);
      if (present.length > 1) {
        actions.push({ order, write: null, patch: { state: "conflict", pending_text: text, pending_action: "insert", pending_reason: `This order's tag appears ${present.length} times in the document.`, found_text: null }, note: "duplicate tag in document" });
      } else if (present.length === 1) {
        // Already in the document (a retry, a crash after the write, or a reconnect): adopt it, never add a second copy.
        const found = inspectLine(doc, order.ref_code, text, sameText);
        if (found.state === "clean") actions.push({ order, write: null, patch: synced(order, text), note: "already in the document" });
        else if (found.state === "edited") {
          actions.push({ order, write: null, patch: { state: "conflict", pending_text: text, pending_action: "update", pending_reason: "A line for this order is already in the document with different text.", found_text: found.foundText }, note: "existing line differs" });
        }
      } else {
        actions.push({ order, write: { type: "insert", text }, patch: synced(order, text), note: "new line" });
      }
      continue;
    }

    // ── Has a line ───────────────────────────────────────────────────────────
    const unchanged = rec.synced_version === order.version && rec.synced_status === order.status;
    if (rec.state === "missing") {
      skipped.push({ order, reason: "staff removed this line from the document" });
      continue;
    }
    if (rec.state === "conflict" || rec.state === "pending_review") {
      // Keep the held change current so approving it applies the latest order, but never write.
      if (!unchanged) {
        const want = desiredLine(order, policy);
        actions.push({ order, write: null, patch: { state: rec.state, pending_text: want.text, pending_action: want.action === "leave" ? null : want.action, synced_version: order.version, synced_status: order.status }, note: "held change refreshed" });
      }
      continue;
    }
    if (unchanged && rec.state === "synced") continue;
    if (rec.state === "failed" && !input.force && rec.attempts >= MAX_AUTO_ATTEMPTS) {
      skipped.push({ order, reason: "failed too many times — retry from the dashboard" });
      continue;
    }

    const want = desiredLine(order, policy);
    if (want.action === "leave") {
      actions.push({ order, write: null, patch: { ...synced(order, rec.last_text), last_text: rec.last_text }, note: "left as is (policy)" });
      continue;
    }
    if (want.action !== "remove" && rec.last_text !== null && sameText(want.text, rec.last_text)) {
      actions.push({ order, write: null, patch: synced(order, rec.last_text), note: "line text unchanged" });
      continue;
    }

    const found = inspectLine(doc, order.ref_code, rec.last_text, sameText);
    if (found.state === "absent") {
      actions.push({ order, write: null, patch: { state: "missing", pending_text: want.text, pending_action: want.action, pending_reason: "The line is no longer in the document (a person removed it).", found_text: null }, note: "line removed by staff" });
      continue;
    }
    if (found.state === "ambiguous") {
      actions.push({ order, write: null, patch: { state: "conflict", pending_text: want.text, pending_action: want.action, pending_reason: `This order's tag appears ${found.count} times in the document.`, found_text: null }, note: "duplicate tag in document" });
      continue;
    }
    if (found.state === "edited") {
      actions.push({ order, write: null, patch: { state: "conflict", pending_text: want.text, pending_action: want.action, pending_reason: "A person edited this line in the document, so it was not overwritten.", found_text: found.foundText }, note: "line edited by staff" });
      continue;
    }
    // Clean: the paragraph is exactly what we wrote.
    if (want.action === "update" && policy.onCorrected === "review" && isOpenStatus(rec.synced_status ?? "")) {
      actions.push({ order, write: null, patch: { state: "pending_review", pending_text: want.text, pending_action: "update", pending_reason: "The order was corrected; corrections are set to wait for approval.", found_text: null }, note: "correction held for review" });
      continue;
    }
    if (want.action === "remove") {
      actions.push({ order, write: { type: "remove", paragraph: found.paragraph }, patch: synced(order, null), note: "line removed" });
      continue;
    }
    actions.push({ order, write: { type: "rewrite", paragraph: found.paragraph, text: want.text, done: want.done }, patch: synced(order, want.text), note: want.action === "mark" ? "marked" : "updated" });
  }
  return { actions, skipped };
}
