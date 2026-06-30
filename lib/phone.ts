// Builds a dialable tel: href from whatever format a phone number happens to
// be stored/displayed in (digits only, with a "+", with stray spaces, etc.)
// so it works as a tap-to-call link on mobile regardless of source.
export function telHref(phoneNumber: string): string {
  return `tel:+${phoneNumber.replace(/[^0-9]/g, "")}`;
}

export type WhatsappJidKind = "phone" | "lid" | "group" | "broadcast" | "unknown";

// Classifies a WhatsApp JID (chat_id) by its suffix. "@lid" is WhatsApp's
// privacy-mode linked id — a stable opaque identifier, not a real MSISDN —
// used instead of a phone number when a contact has phone-number privacy
// enabled. The digits in a @lid JID must never be presented as a phone
// number: they don't correspond to anything dialable.
export function parseWhatsappJid(chatId: string | null | undefined): {
  digits: string | null;
  kind: WhatsappJidKind;
} {
  const id = (chatId ?? "").trim();
  if (!id) return { digits: null, kind: "unknown" };
  const lower = id.toLowerCase();
  if (lower === "status@broadcast" || lower.endsWith("@broadcast")) return { digits: null, kind: "broadcast" };
  if (lower.endsWith("@g.us")) return { digits: null, kind: "group" };
  const lidMatch = id.match(/^(\d+)@lid$/i);
  if (lidMatch) return { digits: lidMatch[1], kind: "lid" };
  const phoneMatch = id.match(/^(\d+)@(s\.whatsapp\.net|c\.us)$/i);
  if (phoneMatch) return { digits: phoneMatch[1], kind: "phone" };
  if (/^\d+$/.test(id)) return { digits: id, kind: "phone" };
  return { digits: null, kind: "unknown" };
}

export interface DisplayPhoneResult {
  /** A real, dialable phone number in digits-only form, or null when this contact only has a WhatsApp privacy id. */
  phone: string | null;
  /** True when the only identifier available for this contact is a WhatsApp @lid privacy id, not a real phone number. */
  isLid: boolean;
}

// Same priority order as resolveRecipientNumber() in lib/whatsapp.ts (real
// contact_number first, chat_id as fallback) but, unlike that function, never
// returns @lid digits dressed up as a phone number — callers use `isLid` to
// show an honest "no phone number" state instead. resolveRecipientNumber()
// itself stays untouched since it's also used to address outgoing sends and
// as the customers.phone_number dedupe key, where its current behavior is
// relied on elsewhere.
export function resolveDisplayPhone(
  contactNumber: string | null | undefined,
  chatId: string | null | undefined
): DisplayPhoneResult {
  const cleanedContact = contactNumber?.trim() || null;
  if (cleanedContact && !cleanedContact.includes("@")) {
    return { phone: cleanedContact, isLid: false };
  }
  const parsed = parseWhatsappJid(cleanedContact || chatId);
  if (parsed.kind === "phone" && parsed.digits) {
    return { phone: parsed.digits, isLid: false };
  }
  if (parsed.kind === "lid") {
    return { phone: null, isLid: true };
  }
  return { phone: null, isLid: false };
}

// Real phone numbers (E.164) max out at 15 digits. customers.phone_number is
// normalized to digits-only before storage (see
// supabase/migrations/20260623000900_contact_phone_improvements.sql), which
// strips the "@lid" suffix along with everything else non-numeric — so a
// privacy-mode contact's opaque lid digits can land there indistinguishable
// from a phone number by the time they reach the customers table. Anywhere
// only customer.phone_number is available (no chat_id to classify properly
// via resolveDisplayPhone), treat implausibly long digit strings as
// non-dialable rather than presenting them as a real number.
export function isPlausiblePhoneNumber(phoneNumber: string | null | undefined): boolean {
  if (!phoneNumber) return false;
  const digits = phoneNumber.replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Lightweight, dependency-free "readable" grouping — not strict E.164
// validation, just enough structure (a leading "+", a country-code-sized
// first group, then groups of 3) that a phone number reads like a phone
// number instead of one long digit blob.
export function formatPhoneDisplay(phoneNumber: string | null | undefined): string | null {
  if (!phoneNumber) return null;
  const digits = phoneNumber.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.length > 10) {
    const countryCode = digits.slice(0, digits.length - 10);
    const national = digits.slice(-10);
    return `+${countryCode} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }
  if (digits.length === 10) {
    return `+1 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  const groups: string[] = [];
  let remaining = digits;
  while (remaining.length > 3) {
    groups.unshift(remaining.slice(-3));
    remaining = remaining.slice(0, -3);
  }
  if (remaining) groups.unshift(remaining);
  return `+${groups.join(" ")}`;
}
