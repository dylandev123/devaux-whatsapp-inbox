// How one order becomes one line of the Google Doc — pure, no I/O, shared by the dashboard (live preview) and the sync.
//
// A line is the enabled fields in the configured order, joined by the configured separator, followed by the order's stable
// tag. A detail the order does not have yet is shown as a visible placeholder ("(no phone)") — never guessed, never
// silently dropped — unless the administrator turned placeholders off. Customer-written text is flattened to one line and
// stripped of the characters the tag uses, so an order can never forge another order's tag.

import type { OrderLine } from "./orders.ts";
import { formatLine } from "./orders.ts";

export const FIELD_KEYS = ["name", "phone", "location", "items", "notes", "date", "ref", "status"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: "Name",
  phone: "Phone",
  location: "Location",
  items: "Product / quantity",
  notes: "Notes",
  date: "Delivery date",
  ref: "Order reference",
  status: "Status",
};

/** The fields that are always worth showing even when empty (a placeholder says what is missing). */
const CORE: ReadonlySet<FieldKey> = new Set(["name", "phone", "location", "items"]);

export interface FormatConfig {
  fields: { key: FieldKey; enabled: boolean }[];
  separator: string;
  /** Show "(no phone)" etc. for a missing core detail. false = leave it out. */
  placeholders: boolean;
}

export const DEFAULT_SEPARATOR = " — ";
export const SEPARATOR_PRESETS = [" — ", " | ", " - ", ", ", " · ", "; "] as const;
const DEFAULT_ENABLED: readonly FieldKey[] = ["name", "phone", "location", "items", "notes"];

export function defaultFormat(): FormatConfig {
  return {
    fields: [...DEFAULT_ENABLED, ...FIELD_KEYS.filter((k) => !DEFAULT_ENABLED.includes(k))].map((key) => ({ key, enabled: DEFAULT_ENABLED.includes(key) })),
    separator: DEFAULT_SEPARATOR,
    placeholders: true,
  };
}

/** Anything the browser (or a stored row) sends becomes a valid config; unknown / duplicate keys are dropped. */
export function normalizeFormat(raw: unknown): FormatConfig {
  const base = defaultFormat();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as { fields?: unknown; separator?: unknown; placeholders?: unknown };
  const seen = new Set<FieldKey>();
  const fields: FormatConfig["fields"] = [];
  if (Array.isArray(r.fields)) {
    for (const f of r.fields) {
      const key = (f as { key?: unknown })?.key;
      if (typeof key !== "string" || !(FIELD_KEYS as readonly string[]).includes(key) || seen.has(key as FieldKey)) continue;
      seen.add(key as FieldKey);
      fields.push({ key: key as FieldKey, enabled: (f as { enabled?: unknown }).enabled === true });
    }
  }
  if (fields.length === 0) return { ...base, placeholders: r.placeholders === false ? false : true };
  for (const key of FIELD_KEYS) if (!seen.has(key)) fields.push({ key, enabled: false });
  if (!fields.some((f) => f.enabled)) return { ...base, separator: sanitizeSeparator(r.separator), placeholders: r.placeholders !== false };
  return { fields, separator: sanitizeSeparator(r.separator), placeholders: r.placeholders !== false };
}

export function sanitizeSeparator(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SEPARATOR;
  // One line, no control characters, no marker characters, at most 8 characters. Spaces around it are kept as typed.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u2028\u2029⟨⟩]/g, "").slice(0, 8);
  return cleaned.trim() === "" ? DEFAULT_SEPARATOR : cleaned;
}

/** The order columns a line is made from (a subset of TrackedOrder). */
export interface LineOrder {
  ref_code: string;
  customer_name: string | null;
  contact_number: string | null;
  items: OrderLine[];
  fulfilment_method: "delivery" | "collection" | null;
  delivery_address: string | null;
  requested_for: string | null;
  notes: string | null;
  status: string;
}

export const STATUS_LABELS: Record<string, string> = {
  possible: "Not confirmed",
  awaiting_confirmation: "Awaiting confirmation",
  confirmed: "Confirmed",
  fulfilled: "Completed",
  cancelled: "Cancelled",
};

const TAG_CHARS = /[⟨⟩]/g;
const FIELD_MAX = 160;
const LINE_MAX = 600;

/** One line of plain text: no control characters or line breaks, no marker characters, clipped. */
export function flatten(value: string | null | undefined, max = FIELD_MAX): string {
  const t = (value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(TAG_CHARS, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function phoneText(digits: string | null): string | null {
  const d = (digits ?? "").replace(/\D/g, "");
  return d.length >= 7 && d.length <= 15 ? `+${d}` : null;
}

function itemsText(items: OrderLine[]): string | null {
  const parts = (items ?? []).map((l) => flatten(formatLine(l), 100)).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export interface FormattedLine {
  /** The line without its tag. */
  text: string;
  /** Labels of the core details this order does not have yet (always reported, whatever the placeholder setting). */
  missing: string[];
}

export function formatOrderLine(order: LineOrder, format: FormatConfig): FormattedLine {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const { key, enabled } of format.fields) {
    let value: string | null = null;
    let placeholder: string | null = null;
    switch (key) {
      case "name":
        value = flatten(order.customer_name) || null;
        placeholder = "(no name)";
        break;
      case "phone":
        value = phoneText(order.contact_number);
        placeholder = "(no phone)";
        break;
      case "location":
        value = flatten(order.delivery_address) || (order.fulfilment_method === "collection" ? "Collection" : null);
        placeholder = "(no location)";
        break;
      case "items":
        value = itemsText(order.items);
        placeholder = "(no items)";
        break;
      case "notes":
        value = flatten(order.notes) || null;
        break;
      case "date":
        value = flatten(order.requested_for, 60) || null;
        break;
      case "ref":
        value = `#${flatten(order.ref_code, 20)}`;
        break;
      case "status":
        value = STATUS_LABELS[order.status] ?? null;
        break;
    }
    // Missing details are reported even for a field switched off, so the dashboard can warn about them.
    if (!value && CORE.has(key)) missing.push(FIELD_LABELS[key]);
    if (!enabled) continue;
    if (value) parts.push(value);
    else if (placeholder && format.placeholders && CORE.has(key)) parts.push(placeholder);
  }
  let text = parts.join(format.separator);
  if (text.length > LINE_MAX) text = `${text.slice(0, LINE_MAX - 1)}…`;
  return { text, missing };
}

// ── Stable tag ───────────────────────────────────────────────────────────────
// The small marker ending every line. It is what lets the app recognise its own line after a crash or a lost response
// without reading the whole document on every insertion. Customer text cannot contain the brackets (see flatten).

export const TAG_OPEN = "⟨";
export const TAG_CLOSE = "⟩";

export const tagFor = (refCode: string): string => `${TAG_OPEN}${refCode}${TAG_CLOSE}`;
export const withTag = (text: string, refCode: string): string => `${text} ${tagFor(refCode)}`;

/** A representative order for the live preview when no real order is at hand. */
export const SAMPLE_ORDER: LineOrder = {
  ref_code: "E-7K2QX",
  customer_name: "Jane Joseph",
  contact_number: "17585550142",
  items: [
    { product: "Chicken & rice", quantity: "3", variant: null, size: "5kg" },
    { product: "Puppy kibble", quantity: "1", variant: null, size: null },
  ],
  fulfilment_method: "delivery",
  delivery_address: "Rodney Bay, near Baywalk",
  requested_for: "Friday",
  notes: "Call on arrival",
  status: "confirmed",
};
