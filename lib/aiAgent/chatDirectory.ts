// Pure helpers for the AI agent's contact / staff-group pickers — no I/O, no
// imports (like engine.ts), so they run under `npm test`.
//
// JID facts this relies on (WhatsappOperation src/messageFields.ts +
// src/agent/messages.ts): the bridge forwards `chatId` = the raw remoteJid it
// also stored in whatsapp_messages.chat_id — `<digits>@s.whatsapp.net`, or
// `<opaque>@lid` for privacy-mode contacts, or `<id>@g.us` for groups. The
// gate matches contact rules by EXACT chat_id, so anything saved must be in
// that representation.

export type ContactRuleKind = "allow" | "exclude";

export interface DirectoryChat {
  chatId: string;
  name: string | null;
  /** contact_number as stored by the bridge (real MSISDN even for @lid chats), if any. */
  number: string | null;
  lastMessageAt: string | null;
}

const PHONE_JID = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i;
const LID_JID = /^(\d+)(?::\d+)?@lid$/i;
const GROUP_JID = /^\d+(?:-\d+)?@g\.us$/i;

export function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9]/g, "");
}

export type NormalizedContact =
  | { ok: true; chatId: string; digits: string; kind: "phone" | "lid" }
  | { ok: false; error: string };

/**
 * Turns whatever an admin typed ("+1 (758) 123-4567", "758-123-4567",
 * "0017581234567", "17581234567@c.us", "123456@lid") into the exact chat_id
 * the bridge uses. Never guesses: ambiguous input (letters, 7-digit local
 * numbers, groups) is rejected rather than mapped to some other contact.
 */
export function normalizeContactInput(raw: string): NormalizedContact {
  const input = raw.trim();
  if (!input) return { ok: false, error: "Enter a phone number or WhatsApp ID" };

  if (input.includes("@")) {
    if (/@g\.us$/i.test(input)) return { ok: false, error: "Groups never get AI replies" };
    const lid = input.match(LID_JID);
    if (lid) return { ok: true, chatId: `${lid[1]}@lid`, digits: lid[1], kind: "lid" };
    const phone = input.match(PHONE_JID);
    if (phone) {
      if (phone[1].length < 8 || phone[1].length > 15) return { ok: false, error: "That is not a valid phone number" };
      return { ok: true, chatId: `${phone[1]}@s.whatsapp.net`, digits: phone[1], kind: "phone" };
    }
    return { ok: false, error: "Unrecognised WhatsApp ID — expected …@s.whatsapp.net or …@lid" };
  }

  if (!/^[+\d\s().\-]+$/.test(input)) return { ok: false, error: "Phone numbers may only contain digits, spaces, + ( ) - ." };
  let digits = digitsOf(input);
  const explicitInternational = input.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (!explicitInternational) {
    // 10-digit North American numbers (St. Lucia is +1 758) get the country code.
    if (digits.length === 10 && /^[2-9]/.test(digits)) digits = `1${digits}`;
    else if (digits.length < 11) {
      return { ok: false, error: "Include the country code (e.g. +1 758 123 4567)" };
    }
  }
  if (digits.length < 8 || digits.length > 15) return { ok: false, error: "That is not a valid phone number" };
  return { ok: true, chatId: `${digits}@s.whatsapp.net`, digits, kind: "phone" };
}

export function normalizeGroupJid(raw: string): string | null {
  const jid = raw.trim().toLowerCase();
  return GROUP_JID.test(jid) ? jid : null;
}

/** Real dialable digits for a chat (never the opaque @lid digits). */
export function chatPhoneDigits(chat: Pick<DirectoryChat, "chatId" | "number">): string {
  const fromNumber = digitsOf(chat.number);
  // The bridge falls back to the @lid's own digits when WhatsApp gave no phone.
  const lid = chat.chatId.match(LID_JID);
  if (fromNumber && !(lid && lid[1] === fromNumber)) return fromNumber;
  const phone = chat.chatId.match(PHONE_JID);
  return phone ? phone[1] : "";
}

/**
 * Case-insensitive search over name, phone digits (partial, formatting- and
 * country-code-insensitive) and the raw JID. A query is "numeric" when it only
 * holds digits/phone punctuation; those match on digits so "758 123", "+1758123"
 * and "(758)123" all find 17581234567. @lid digits are opaque and are never
 * matched as phone digits.
 */
export function matchesChatSearch(chat: DirectoryChat, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((chat.name ?? "").toLowerCase().includes(q)) return true;
  if (/^[+\d\s().\-]+$/.test(q)) {
    let d = digitsOf(q);
    if (d.startsWith("00")) d = d.slice(2);
    return d.length >= 3 && chatPhoneDigits(chat).includes(d);
  }
  if (chat.chatId.toLowerCase().includes(q)) return true;
  return false;
}

export function dedupeChats(chats: DirectoryChat[]): DirectoryChat[] {
  const byId = new Map<string, DirectoryChat>();
  for (const c of chats) {
    const prev = byId.get(c.chatId);
    if (!prev) {
      byId.set(c.chatId, c);
      continue;
    }
    byId.set(c.chatId, {
      chatId: c.chatId,
      name: prev.name ?? c.name,
      number: prev.number ?? c.number,
      lastMessageAt: [prev.lastMessageAt, c.lastMessageAt].filter(Boolean).sort().pop() ?? null,
    });
  }
  return [...byId.values()];
}

export function sortByRecent<T extends { lastMessageAt: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/**
 * Every chat_id that denotes the same person as `digits`: the canonical
 * `<digits>@s.whatsapp.net` plus any KNOWN chat of this business (e.g. an
 * @lid chat) whose bridge-reported contact_number is exactly those digits.
 * Exact-digit equality only — never prefix/suffix — so an unrelated contact
 * cannot be pulled in.
 */
export function aliasChatIds(digits: string, knownChats: DirectoryChat[]): string[] {
  const ids = new Set<string>([`${digits}@s.whatsapp.net`]);
  for (const c of knownChats) {
    if (c.chatId.endsWith("@g.us")) continue;
    if (digitsOf(c.number) === digits && chatPhoneDigits(c) === digits) ids.add(c.chatId);
  }
  return [...ids];
}

export function groupLabel(chat: { chatId: string; name: string | null }): string {
  if (chat.name?.trim()) return chat.name.trim();
  const id = chat.chatId.split("@")[0];
  return `Group …${id.slice(-6)}`;
}
