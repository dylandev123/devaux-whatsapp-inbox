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

// ── Staff sender authorization ───────────────────────────────────────────────
//
// WhatsApp commands that message a customer ("!send", "send it") are honoured
// only from senders on the business's own allow-list. A sender is identified
// ONLY by identifiers WhatsApp itself reported — never by display name, and
// never by treating @lid digits as a phone number:
//   - a phone JID (`<msisdn>@s.whatsapp.net`) proves that phone number;
//   - an @lid JID proves only itself, plus a phone number the bridge reported
//     for it (Baileys participantPn) when that number is plausible and not the
//     @lid's own digits.
// An allow-list entry is either phone digits ("17585550001") or an exact
// "<digits>@lid" JID. The default list is empty: nobody may send until an
// admin adds them.

export const MAX_AUTHORIZED_SENDERS = 50;

/** One allow-list entry in canonical form (phone digits, or "<digits>@lid"), or null when it is neither. */
export function normalizeAuthorizedSender(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const lid = value.match(LID_JID);
  if (lid) return `${lid[1]}@lid`;
  const phone = value.match(PHONE_JID);
  const digits = (phone ? phone[1] : value).replace(/[\s()+.-]/g, "");
  if (!/^\d{8,15}$/.test(digits)) return null;
  return digits;
}

/** Parses an admin-typed list (commas, semicolons, whitespace or newlines). Invalid entries are reported, never guessed at. */
export function parseAuthorizedSenders(input: unknown): { ok: true; senders: string[] } | { ok: false; error: string } {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\n,;]+/) : null;
  if (!parts) return { ok: false, error: "staffAuthorizedSenders must be a list of phone numbers" };
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string" && !part.trim()) continue;
    const entry = normalizeAuthorizedSender(part);
    if (!entry) return { ok: false, error: `"${String(part).slice(0, 40)}" is not a phone number (8–15 digits) or a …@lid id` };
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > MAX_AUTHORIZED_SENDERS) return { ok: false, error: `At most ${MAX_AUTHORIZED_SENDERS} authorized senders` };
  return { ok: true, senders: out };
}

/**
 * The verified identifiers of a staff-group sender, strongest first. `phone`
 * is whatever the bridge reported alongside the participant JID; it counts
 * only when plausible and different from the @lid's own digits.
 */
export function verifiedSenderKeys(senderJid: string | null | undefined, reportedPhone: string | null | undefined): string[] {
  const jid = (senderJid ?? "").trim().toLowerCase();
  if (!jid) return [];
  const keys: string[] = [];
  const phone = jid.match(PHONE_JID);
  if (phone) keys.push(phone[1]);
  const lid = jid.match(LID_JID);
  if (lid) {
    const reported = verifiedPhoneDigits(jid, reportedPhone);
    if (reported) keys.push(reported);
    keys.push(`${lid[1]}@lid`);
  }
  return keys;
}

export interface SenderAuthorization {
  authorized: boolean;
  /** The verified identifier that matched the allow-list, or the best verified one when none did; null when the sender is not verifiable. */
  senderId: string | null;
}

export function authorizeStaffSender(
  allowList: readonly string[] | null | undefined,
  senderJid: string | null | undefined,
  reportedPhone: string | null | undefined
): SenderAuthorization {
  const keys = verifiedSenderKeys(senderJid, reportedPhone);
  const allowed = new Set((allowList ?? []).map(normalizeAuthorizedSender).filter((e): e is string => Boolean(e)));
  const match = keys.find((k) => allowed.has(k));
  return { authorized: Boolean(match), senderId: match ?? keys[0] ?? null };
}

/** Re-checks a previously recorded verified sender id against the CURRENT allow-list (used by retries). */
export function isSenderIdAuthorized(allowList: readonly string[] | null | undefined, senderId: string | null | undefined): boolean {
  const id = normalizeAuthorizedSender(senderId);
  return Boolean(id && (allowList ?? []).map(normalizeAuthorizedSender).includes(id));
}
