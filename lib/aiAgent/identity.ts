// Contact identity for the AI agent — pure functions, no I/O, no imports (like
// engine.ts), so they run under `npm test`.
//
// One WhatsApp contact can reach a business under two JIDs: the phone JID
// (`<msisdn>@s.whatsapp.net`) or the privacy-mode `<opaque>@lid`. The digits
// of an @lid are NOT a phone number, so the only link between the two is a
// phone number WhatsApp itself reported for that @lid chat (Baileys
// senderPn/participantPn, stored by the bridge as contact_number). Anything
// else — names, digit prefixes, lid digits that merely look like a number —
// is never used to join identities.

const PHONE_JID = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i;
const LID_JID = /^(\d+)(?::\d+)?@lid$/i;

export function isLidJid(chatId: string): boolean {
  return LID_JID.test(chatId.trim());
}

export function phoneJidFor(digits: string): string {
  return `${digits}@s.whatsapp.net`;
}

/**
 * The verified phone digits for a chat, or null.
 *  - phone JID: the JID itself.
 *  - @lid: `contactNumber` only when it is a different, plausible number than
 *    the @lid's own digits. The bridge falls back to the @lid digits when
 *    WhatsApp reported no phone, which proves nothing.
 */
export function verifiedPhoneDigits(chatId: string, contactNumber: string | null | undefined): string | null {
  const id = chatId.trim();
  const phone = id.match(PHONE_JID);
  if (phone) return phone[1];
  const lid = id.match(LID_JID);
  if (!lid) return null;
  const digits = (contactNumber ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits === lid[1]) return null;
  return digits;
}

export interface IdentityLinks {
  /** Verified phone for an @lid chat found in stored history (best effort). */
  storedPhone: string | null;
  /** @lid chats of this business whose verified phone equals this chat's phone. */
  lidChats: string[];
}

export interface ChatIdentity {
  /** Every JID known to belong to this contact, the incoming chat_id first. */
  chatIds: string[];
  phone: string | null;
  /** An @lid chat with no verified phone: only its own chat_id can match a rule. */
  unresolvedLid: boolean;
}

export function resolveChatIdentity(
  chatId: string,
  payloadContactNumber: string | null | undefined,
  links: IdentityLinks
): ChatIdentity {
  const ids = new Set<string>([chatId]);
  const phone =
    verifiedPhoneDigits(chatId, payloadContactNumber) ?? (isLidJid(chatId) ? verifiedPhoneDigits(chatId, links.storedPhone) : null);
  if (phone) {
    ids.add(phoneJidFor(phone));
    for (const lid of links.lidChats) ids.add(lid);
  }
  return { chatIds: [...ids], phone, unresolvedLid: isLidJid(chatId) && !phone };
}

export interface RuleRow {
  chat_id: string;
  rule: "allow" | "exclude";
}

/** Exclusions on ANY identity win; otherwise any allow; otherwise none. */
export function combineRules(rules: RuleRow[]): "allow" | "exclude" | null {
  if (rules.some((r) => r.rule === "exclude")) return "exclude";
  if (rules.some((r) => r.rule === "allow")) return "allow";
  return null;
}
