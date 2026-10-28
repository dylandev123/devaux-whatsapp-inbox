// Re-evaluating existing OPEN orders against the business rules and their own conversation — pure, no I/O.
//
// This is a PLANNER. It reads an order and the messages the order was built from, and proposes corrections with the words
// that justify each one. It never calls a model: everything it proposes is a rule applied to the customer's own words
// (an explicit "collect", a written date, a "same place" pointing at a staff-saved or verified location, a phone number
// parked in the notes), so running it twice gives the same answer and a preview is exactly what an apply would do.
//
// What it will not do:
//   * touch a completed or cancelled order (they are not planned at all);
//   * overwrite a field staff edited (manual_locked_fields): it is listed as skipped;
//   * change what was confirmed: on a confirmed order only cosmetic repairs (name, a bare phone number in the notes) are
//     proposed, everything else is listed for a person to review;
//   * invent products, quantities, addresses or names: a gap with no evidence in the conversation stays a gap, and the
//     customer's source messages are shown so a person can fill it;
//   * message anyone: the result is data.

import { CONTACT_NOTE_PREFIX, deliveryContactIn, effectiveDate, effectiveMethod, groundedContactPhone, isPhoneOnlyNote, isTimeOnlyPhrase, phonesIn, withDeliveryContact } from "./orderDefaults.ts";
import { detectHistoryCue } from "./orderHistory.ts";
import { detectFulfilment, resolveRequestedDay } from "./orderText.ts";
import { computeMissing, isComplete, isOpenStatus, isReliableName, type OrderFields, type OrderStatus, type TrackedOrder } from "./orders.ts";

export interface RepairMessage {
  id: string;
  who: "Customer" | "Staff";
  text: string;
  /** ISO timestamp. */
  at: string;
}

export interface RepairContext {
  /** The chat around the order, oldest first. Staff lines are context only. */
  messages: RepairMessage[];
  /** The verified number the customer writes from (never a number found inside a message). */
  senderPhone: string | null;
  /** A reliable name for this customer from staff, the saved contact or the WhatsApp profile (pickCustomerName), else null. */
  profileName: string | null;
  /** The default delivery location STAFF saved for this customer (!location), if any. */
  savedLocation: string | null;
  /** The address on this customer's newest verified earlier order, if any. */
  verifiedAddress: { ref: string; address: string } | null;
  timezone: string;
}

export type RepairField = "customer_name" | "fulfilment_method" | "delivery_address" | "requested_for" | "notes" | "status";

export interface RepairChange {
  field: RepairField;
  before: unknown;
  after: unknown;
  /** Why, in a sentence a staff member can check. */
  reason: string;
  /** The customer's words (or the record) this rests on. */
  evidence: string | null;
}

export interface RepairItem {
  orderId: string;
  ref: string;
  status: OrderStatus;
  version: number;
  changes: RepairChange[];
  /** For a person: things this planner will not decide. Never applied. */
  review: string[];
  /** Fields it would have changed but must not (staff edited them). */
  skipped: { field: RepairField; reason: string }[];
  /** Identifies exactly these changes on exactly this version of the order; apply requires it to match. */
  fingerprint: string;
}

const COSMETIC: ReadonlySet<RepairField> = new Set(["customer_name", "notes"]);

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** Small stable string hash (djb2). Not security: a guard against applying a stale preview. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The messages the order was built from: the ones it recorded, plus the customer's messages between its first and last. */
function orderWindow(order: TrackedOrder, messages: RepairMessage[]): RepairMessage[] {
  const from = Date.parse(order.first_message_at) - 60_000;
  const to = Date.parse(order.last_message_at) + 60_000;
  const recorded = new Set(order.source_message_ids);
  return messages.filter((m) => recorded.has(m.id) || (Date.parse(m.at) >= from && Date.parse(m.at) <= to));
}

/**
 * Proposes the corrections for one OPEN order, or null when the order is closed. `changes` is empty when nothing needs
 * repair (the planner is idempotent: after the changes are applied it returns no changes).
 */
export function planRepair(order: TrackedOrder, ctx: RepairContext): RepairItem | null {
  if (!isOpenStatus(order.status)) return null;
  const tz = ctx.timezone;
  const window = orderWindow(order, ctx.messages);
  const customer = window.filter((m) => m.who === "Customer" && m.text.trim());
  const texts = customer.map((m) => m.text);
  const confirmed = order.status === "confirmed";
  const locked = new Set(order.manual_locked_fields);

  const changes: RepairChange[] = [];
  const review: string[] = [];
  const skipped: { field: RepairField; reason: string }[] = [];
  const next: OrderFields = {
    customer_name: order.customer_name,
    items: order.items,
    fulfilment_method: order.fulfilment_method,
    delivery_preference: order.delivery_preference,
    delivery_address: order.delivery_address,
    requested_for: order.requested_for,
    notes: order.notes,
  };

  /** Records a proposal, or the reason it was held back. Returns whether the field changes. */
  const propose = (field: Exclude<RepairField, "status">, after: string | null, reason: string, evidence: string | null): boolean => {
    const before = order[field];
    if ((before ?? null) === (after ?? null)) return false;
    if (locked.has(field)) {
      skipped.push({ field, reason: "edited by staff — left as it is" });
      return false;
    }
    if (confirmed && !COSMETIC.has(field)) {
      review.push(`${field.replace(/_/g, " ")}: would change “${before ?? "—"}” → “${after ?? "—"}” (${reason}), but the order is confirmed — check it with a person`);
      return false;
    }
    changes.push({ field, before: before ?? null, after, reason, evidence });
    (next as unknown as Record<string, unknown>)[field] = after;
    return true;
  };

  // 1. Delivery vs collection: delivery is the default (so a missing method needs no repair); only an explicit statement changes it.
  const said = detectFulfilment(texts);
  if (said === "collection" && effectiveMethod(order).method !== "collection") {
    const m = [...customer].reverse().find((x) => detectFulfilment([x.text]) === "collection");
    propose("fulfilment_method", "collection", "the customer asked to collect", m ? clip(m.text, 120) : null);
  } else if (said === "delivery" && order.fulfilment_method === "collection") {
    const m = [...customer].reverse().find((x) => detectFulfilment([x.text]) === "delivery");
    propose("fulfilment_method", "delivery", "the customer's latest word is delivery", m ? clip(m.text, 120) : null);
  }

  // 2. The day: a day the customer wrote beats the default. Only filled when the order has none that can be read; a different
  //    readable day on the order is shown for a person, never swapped (a later message may be about another order).
  const day = effectiveDate(order, tz);
  const fromWords = [...customer].reverse().map((m) => ({ m, d: resolveRequestedDay(m.text, new Date(m.at), tz) })).find((x) => x.d);
  if (fromWords?.d) {
    if (day.source !== "stated") {
      const keep = order.requested_for && isTimeOnlyPhrase(order.requested_for) ? ` (${order.requested_for})` : "";
      propose("requested_for", `${fromWords.d.label}${keep}`, "the customer named a day", clip(fromWords.m.text, 120));
    } else if (day.date !== fromWords.d.date) {
      review.push(`day: the order is for ${day.date} but “${clip(fromWords.m.text, 80)}” reads as ${fromWords.d.date} — check which is right`);
    }
  } else if (day.source === "unreadable") {
    review.push(`day: “${clip(order.requested_for ?? "", 80)}” cannot be read as one day — ask the customer`);
  }

  // 3. Phone numbers: a bare number in the notes is a contact, not an instruction. It becomes the delivery contact only when
  //    the customer wrote it and it is not the number they write from; the verified sender number is never changed.
  const sender7 = ctx.senderPhone?.slice(-7) ?? null;
  const ownNumber = (notes: string | null) => Boolean(sender7) && phonesIn(notes ?? "").some((p) => p.slice(-7) === sender7);
  if (isPhoneOnlyNote(order.notes) && !(order.notes ?? "").startsWith(CONTACT_NOTE_PREFIX)) {
    const contact = groundedContactPhone({ notes: order.notes }, texts, ctx.senderPhone);
    if (contact) propose("notes", withDeliveryContact(null, contact), "a bare phone number is a delivery contact, not a note", clip(order.notes ?? "", 80));
    else if (ownNumber(order.notes)) propose("notes", null, "the note is only the customer's own number", clip(order.notes ?? "", 80));
    else review.push(`notes: “${clip(order.notes ?? "", 60)}” is only a phone number the customer's messages do not show — check it`);
  } else if (deliveryContactIn(order.notes) && ownNumber(order.notes)) {
    review.push("notes: the delivery contact is the customer's own number");
  }

  // 4. Identity: a placeholder or number stored as the name is replaced by a reliable profile name, never by a guess.
  if (order.customer_name && !isReliableName(order.customer_name)) {
    propose("customer_name", ctx.profileName, ctx.profileName ? "a reliable name is known for this customer" : "the stored name is a placeholder or a number", clip(order.customer_name, 60));
  }

  // 5. Location: only an explicit "same place" points at a saved/verified address. No cue, no address is invented.
  const isCollection = next.fulfilment_method === "collection";
  if (!isCollection && !next.delivery_address) {
    const cue = detectHistoryCue(texts);
    if (cue.sameLocation && !cue.elsewhere) {
      const m = [...customer].reverse().find((x) => detectHistoryCue([x.text]).sameLocation);
      if (ctx.savedLocation) propose("delivery_address", ctx.savedLocation, "the customer said “same place”; this is the location staff saved for them", m ? clip(m.text, 120) : null);
      else if (ctx.verifiedAddress) propose("delivery_address", ctx.verifiedAddress.address, `the customer said “same place”; this is the address on their verified order #${ctx.verifiedAddress.ref.replace(/^O-/i, "")}`, m ? clip(m.text, 120) : null);
      else review.push("address: the customer said “same place” but no verified location is saved for them — ask or save one with !location");
    } else {
      review.push("address: none given and no “same place” in the conversation — ask the customer");
    }
  }

  // 6. Products / quantity: never re-guessed here. Show the customer's own words so a person can fill the gap.
  const gaps = computeMissing(next).filter((g) => g === "items" || g === "quantity");
  if (gaps.length > 0 && texts.length > 0) {
    review.push(`${gaps.includes("items") ? "products" : "quantity"} missing — the customer wrote: ${texts.slice(-3).map((t) => `“${clip(t, 80)}”`).join(" / ")}`);
  }

  // 7. Status follows the essentials. A confirmed order is never moved by a rule change.
  const complete = isComplete(computeMissing(next));
  let status: OrderStatus = order.status;
  if (order.status === "possible" && complete) status = "awaiting_confirmation";
  else if (order.status === "awaiting_confirmation" && !complete) status = "possible";
  if (status !== order.status) {
    changes.push({
      field: "status",
      before: order.status,
      after: status,
      reason: status === "awaiting_confirmation" ? "delivery and the day are defaults, so nothing essential is missing" : "an essential detail is still missing",
      evidence: null,
    });
  }

  const fingerprint = hash(JSON.stringify({ id: order.id, v: order.version, c: changes.map((c) => [c.field, c.after]) }));
  return { orderId: order.id, ref: order.ref_code, status: order.status, version: order.version, changes, review, skipped, fingerprint };
}

export interface RepairSummary {
  open: number;
  withChanges: number;
  needReview: number;
  unchanged: number;
}

export function summarizeRepair(items: RepairItem[]): RepairSummary {
  return {
    open: items.length,
    withChanges: items.filter((i) => i.changes.length > 0).length,
    needReview: items.filter((i) => i.review.length > 0).length,
    unchanged: items.filter((i) => i.changes.length === 0 && i.review.length === 0).length,
  };
}
