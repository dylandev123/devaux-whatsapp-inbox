// Where an order's delivery address came from — pure functions, no I/O, NO new data.
//
// The evidence already exists in the order's history: when the AI fills an address the customer never wrote, the event that
// sets it carries `changes.inferred.after.delivery_address` = "saved location" (the staff-saved customer default) or the
// reference of the verified earlier order it was copied from. This module reads that trail and answers one question for the
// CURRENT address, always erring toward "the customer's / staff's own":
//
//   customer  — given by the customer (or no evidence of anything else, e.g. orders from before the trail existed)
//   staff     — typed or corrected by staff (also any address staff locked)
//   saved     — filled from the customer's saved default, and nobody has changed or confirmed it since
//   previous  — copied from a verified previous order, and nobody has changed or confirmed it since
//
// "Inferred" never outlives a change: a later event that sets the address (customer, staff, repair), clears it, or
// confirms the order, or a current address that is no longer the one that was filled, turns it back into a plain
// customer/staff address.

import { normalizeText } from "./escalationUpdates.ts";
import { SAVED_LOCATION_SOURCE } from "./orderHistory.ts";
import type { TrackedOrder } from "./orders.ts";

export type AddressOrigin = "customer" | "staff" | "saved" | "previous";

export interface AddressProvenance {
  /** null when the order has no address. */
  origin: AddressOrigin | null;
  /** For "previous": the reference of the order the address was copied from (as stored, e.g. O-K3PD7). */
  fromRef?: string;
}

export interface AddressEvent {
  kind: string;
  actor_kind: string;
  changes: Record<string, { before?: unknown; after?: unknown }> | null;
  created_at: string;
}

const isStaffActor = (actor: string) => actor === "staff" || actor === "admin";
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** The same place, however it is spelled or spaced. */
export const sameAddress = (a: string, b: string) => normalizeText(a) === normalizeText(b);
const same = sameAddress;

/** True when an event is somebody accepting the order as it stands: staff confirming it, or the customer saying yes. */
function confirmsOrder(e: AddressEvent): boolean {
  if (e.kind === "customer_confirmed" || e.kind === "customer_replied_yes" || e.kind === "address_confirmed") return true;
  const status = e.changes?.status?.after;
  return status === "confirmed" && isStaffActor(e.actor_kind);
}

export function addressProvenance(order: Pick<TrackedOrder, "delivery_address" | "manual_locked_fields">, events: AddressEvent[]): AddressProvenance {
  const address = text(order.delivery_address);
  if (!address) return { origin: null };
  const settled: AddressProvenance = { origin: order.manual_locked_fields.includes("delivery_address") ? "staff" : "customer" };

  // Oldest first, whatever order the caller loaded them in.
  const trail = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.created_at.localeCompare(b.e.created_at) || a.i - b.i).map((x) => x.e);

  let current: { origin: AddressOrigin; fromRef?: string; address: string } | null = null;
  for (const e of trail) {
    const change = e.changes?.delivery_address;
    if (change && "after" in change) {
      const after = text(change.after);
      const source = text((e.changes?.inferred?.after as { delivery_address?: unknown } | undefined)?.delivery_address);
      if (after && source && !isStaffActor(e.actor_kind)) {
        current = source === SAVED_LOCATION_SOURCE ? { origin: "saved", address: after } : { origin: "previous", fromRef: source, address: after };
      } else current = null; // set by a person or from the customer's words, or cleared: nothing inferred about it any more
    } else if (current && confirmsOrder(e)) {
      current = null;
    }
  }
  // The address on the order must still be the one that was filled, and staff must not have locked it.
  if (!current || settled.origin === "staff" || !same(current.address, address)) return settled;
  return { origin: current.origin, ...(current.fromRef ? { fromRef: current.fromRef } : {}) };
}

/** True for the two origins the AI filled in. */
export const isInferredAddress = (p: AddressProvenance) => p.origin === "saved" || p.origin === "previous";

const refText = (ref: string) => `#${ref.replace(/^O-/i, "")}`;

/** WhatsApp label after the address in a list: only inferred addresses are marked ("Saved address" / "Previous address"). */
export function addressTag(p: AddressProvenance): string {
  return p.origin === "saved" ? " (Saved address)" : p.origin === "previous" ? " (Previous address)" : "";
}

/** `!order #REF` line: who the address is from, in a few words. */
export function addressSourceLine(p: AddressProvenance): string | null {
  switch (p.origin) {
    case "customer":
      return "Address: given by the customer";
    case "staff":
      return "Address: set by staff";
    case "saved":
      return "Address: Saved address — not stated in this chat";
    case "previous":
      return `Address: Previous address${p.fromRef ? ` (from ${refText(p.fromRef)})` : ""} — not stated in this chat`;
    default:
      return null;
  }
}

/** Website badge text. */
export const ADDRESS_ORIGIN_LABEL: Record<AddressOrigin, string> = {
  customer: "Customer-provided",
  staff: "Set by staff",
  saved: "Saved address",
  previous: "Previous address",
};
