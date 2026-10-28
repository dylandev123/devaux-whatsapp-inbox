// Read-only review of EXISTING orders — pure rules, no I/O, no model call, no writes.
//
// The extraction rules improved (order intent, staff-agreed delivery days, pictures, names). Orders already on the book were
// built by the old rules, and this module shows where the evidence in their own conversation now points somewhere else. It
// never changes an order: it returns suggestions with the messages that support them, and a person decides. An order staff
// edited, confirmed, completed or cancelled is never suggested for change; neither are customer memories or approved corrections.

import { classifyOrderIntent, staffRecentlyOfferedDelivery } from "./orderIntent.ts";
import { effectiveDate } from "./orderDefaults.ts";
import { dayLabel } from "./orderViews.ts";
import { agreedDeliveryDate, type ConversationLine, isAffirmation, readStaffDeliveryDate } from "./staffDelivery.ts";
import { isOpenStatus, isUnderReview, type TrackedOrder } from "./orders.ts";
import { pointsAtPicture, type PictureReading } from "./orderImages.ts";

export type FindingKind = "might_not_be_order" | "delivery_day" | "picture_unresolved";

export interface EvidenceLine {
  who: "Customer" | "Staff";
  at: string;
  text: string;
}

export interface ReviewFinding {
  kind: FindingKind;
  /** One plain sentence for staff. */
  summary: string;
  /** What the order says now / what the conversation points to (display text, or null). */
  current: string | null;
  suggested: string | null;
  evidence: EvidenceLine[];
}

export interface OrderReview {
  orderId: string;
  ref: string;
  findings: ReviewFinding[];
}

export interface ReviewLine extends ConversationLine {
  mediaKind?: string | null;
  mediaUrl?: string | null;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const evidenceOf = (m: ConversationLine): EvidenceLine => ({ who: m.who, at: m.at, text: clip(m.text) });

/** True when staff or the customer has already settled the order: nothing is suggested for it. */
function settled(o: TrackedOrder): boolean {
  return !isOpenStatus(o.status) || o.status === "confirmed" || Boolean(o.confirmed_at) || o.manual_locked_fields.length > 0;
}

/**
 * What the conversation says about one existing order. `lines` is the whole stored conversation of its chat around the order,
 * oldest first. `readings` holds picture readings that were ALREADY made (never triggers one).
 */
export function reviewOrder(args: { order: TrackedOrder; lines: ReviewLine[]; timezone: string; readings?: Record<string, PictureReading> }): OrderReview {
  const { order: o, timezone } = args;
  const lines = [...args.lines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const findings: ReviewFinding[] = [];
  if (!isOpenStatus(o.status) || settled(o) && !isUnderReview(o)) return { orderId: o.id, ref: o.ref_code, findings };

  const first = Date.parse(o.first_message_at);
  const sourceIds = new Set(o.source_message_ids);
  const turn = lines.filter((m) => m.who === "Customer" && m.id && sourceIds.has(m.id));
  const before = lines.filter((m) => Date.parse(m.at) < (turn[0] ? Date.parse(turn[0].at) : first) && m.text.trim());

  // 1. Was it an order at all?
  if (!isUnderReview(o) && turn.length > 0 && !settled(o)) {
    // Staff offered delivery and the customer accepted: a plain order, whatever the first message looked like.
    const staffOffered = lines.some((m, i) => m.who === "Customer" && Date.parse(m.at) >= first && isAffirmation(m.text) && staffRecentlyOfferedDelivery(lines.slice(0, i), 12, m.at));
    const verdict = classifyOrderIntent({
      segments: turn.map((m) => m.text).filter(Boolean),
      recent: before,
      modelIntent: "order",
      items: o.items.map((i) => ({ quantity: i.quantity ?? null })),
      hasAddress: Boolean(o.delivery_address),
      hasDay: Boolean(o.requested_for) && effectiveDate(o, timezone).source === "stated",
      staffAgreement: staffOffered,
    });
    if (verdict.kind !== "confirmed") {
      findings.push({
        kind: "might_not_be_order",
        summary:
          verdict.kind === "non_order"
            ? "The messages this order was built from read as paperwork, a price or a product question, not a request for goods."
            : "Nothing in the conversation clearly asks for this to be supplied.",
        current: "Active order",
        suggested: "Review: confirm it if it is an order, cancel it if it is not",
        evidence: [...turn.slice(0, 3).map(evidenceOf), ...before.slice(-2).map(evidenceOf)],
      });
    }
  }

  // 2. A delivery day staff stated or the customer accepted, that the order does not carry.
  if (!o.manual_locked_fields.includes("requested_for") && o.status !== "confirmed") {
    const current = effectiveDate(o, timezone);
    const after = lines.filter((m) => Date.parse(m.at) >= first - 3_600_000);
    let proposed: { date: string; label: string; evidence: ConversationLine[]; how: string } | null = null;
    for (const [i, m] of after.entries()) {
      if (m.who === "Staff") {
        const reading = readStaffDeliveryDate(m.text, new Date(m.at), timezone);
        if (reading.kind === "commitment" && reading.date && reading.label) proposed = { date: reading.date, label: reading.label, evidence: [m], how: "staff said they would deliver" };
      } else {
        const agreed = agreedDeliveryDate({ segments: [m.text], at: m.at, recent: after.slice(0, i), quotedId: m.quotedId, timezone });
        if (agreed) {
          const offer = after.find((x) => x.id && x.id === agreed.staffMessageId) ?? [...after.slice(0, i)].reverse().find((x) => x.who === "Staff");
          proposed = { date: agreed.date, label: agreed.label, evidence: [...(offer ? [offer] : []), m], how: "the customer accepted a staff offer" };
        }
      }
    }
    if (proposed && proposed.date !== current.date) {
      findings.push({
        kind: "delivery_day",
        summary: `In the conversation ${proposed.how} for ${proposed.label}.`,
        current: current.date ? dayLabel(current.date) : "No clear day",
        suggested: proposed.label,
        evidence: proposed.evidence.map(evidenceOf),
      });
    }
  }

  // 3. "This one": the product is a picture the customer sent, and the order never learned what it shows.
  const vague = o.items.some((i) => pointsAtPicture(i.product) && !/\d/.test(i.product) && i.product.trim().split(/\s+/).length <= 3);
  if (vague) {
    const pictures = lines.filter((m) => m.who === "Customer" && m.mediaKind === "image" && m.id && Math.abs(Date.parse(m.at) - first) < 3_600_000);
    if (pictures.length > 0) {
      const reading = pictures.map((p) => args.readings?.[p.id!]).find((r) => r?.kind === "product" && r.product);
      findings.push({
        kind: "picture_unresolved",
        summary: reading ? `The product is “${o.items[0].product}” but the customer's photo shows ${reading.product}${reading.size ? ` (${reading.size})` : ""}.` : "The product is only “this one”: the customer sent a photo that has not been read.",
        current: o.items.map((i) => i.product).join("; "),
        suggested: reading?.product ? `${reading.product}${reading.size ? ` ${reading.size}` : ""}` : null,
        evidence: pictures.slice(0, 2).map((p) => evidenceOf({ ...p, text: p.text || "(photo)" })),
      });
    }
  }
  return { orderId: o.id, ref: o.ref_code, findings };
}
