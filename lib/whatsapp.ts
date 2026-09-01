import { DisplayPhoneResult, formatPhoneDisplay, parseWhatsappJid, resolveDisplayPhone } from "@/lib/phone";

// Seed-data fallback only — once supabase/migrations/20260623000300_business_management.sql
// is run, the real source of truth is the `whatsapp_businesses` table, loaded
// into the directory cache below via setBusinessDirectory(). These statics
// are what businessLabel()/businessColor() fall back to before that first
// load completes, or for a slug that's missing from the table for some reason.
export const BUSINESS_LABELS: Record<string, string> = {
  dog_food: "Dog Food St. Lucia",
  by_sea: "By Sea Tours",
  cool_pool: "Cool & Pool Products",
  supplify: "Supplify SLU",
  candock: "Candock Carib",
};

const FALLBACK_BUSINESS_COLOUR_NAMES: Record<string, string> = {
  dog_food: "green",
  by_sea: "blue",
  cool_pool: "teal",
  candock: "orange",
  supplify: "purple",
};

export interface BusinessColor {
  dot: string;
  text: string;
  bg: string;
  border: string;
  /** Stronger shade for buttons/outbound bubbles; always paired with white text. */
  solid: string;
}

// Named palette matching the `colour` column on whatsapp_businesses (a few
// extras included beyond the 5 seeded businesses, for the admin colour picker).
export const COLOR_PALETTE: Record<string, BusinessColor> = {
  slate: { dot: "bg-slate-400", text: "text-slate-700", bg: "bg-slate-50", border: "border-slate-400", solid: "bg-slate-600" },
  green: { dot: "bg-green-500", text: "text-green-700", bg: "bg-green-50", border: "border-green-500", solid: "bg-green-600" },
  blue: { dot: "bg-blue-500", text: "text-blue-700", bg: "bg-blue-50", border: "border-blue-500", solid: "bg-blue-600" },
  teal: { dot: "bg-teal-500", text: "text-teal-700", bg: "bg-teal-50", border: "border-teal-500", solid: "bg-teal-600" },
  orange: { dot: "bg-orange-500", text: "text-orange-700", bg: "bg-orange-50", border: "border-orange-500", solid: "bg-orange-600" },
  purple: { dot: "bg-purple-500", text: "text-purple-700", bg: "bg-purple-50", border: "border-purple-500", solid: "bg-purple-600" },
  red: { dot: "bg-red-500", text: "text-red-700", bg: "bg-red-50", border: "border-red-500", solid: "bg-red-600" },
  pink: { dot: "bg-pink-500", text: "text-pink-700", bg: "bg-pink-50", border: "border-pink-500", solid: "bg-pink-600" },
  indigo: { dot: "bg-indigo-500", text: "text-indigo-700", bg: "bg-indigo-50", border: "border-indigo-500", solid: "bg-indigo-600" },
  amber: { dot: "bg-amber-500", text: "text-amber-700", bg: "bg-amber-50", border: "border-amber-500", solid: "bg-amber-600" },
};

export function colorByName(name: string | null | undefined): BusinessColor {
  return COLOR_PALETTE[(name ?? "slate").toLowerCase()] ?? COLOR_PALETTE.slate;
}

interface BusinessDirectoryEntry {
  displayName: string;
  colourName: string;
}

let businessDirectory = new Map<string, BusinessDirectoryEntry>();

// Populated from whatsapp_businesses (see lib/businesses.ts). Call this once
// the table has loaded so every existing businessLabel()/businessColor()
// call site picks up live data with no further changes.
export function setBusinessDirectory(
  rows: { business_slug: string; display_name: string; colour: string | null }[]
): void {
  businessDirectory = new Map(
    rows.map((r) => [r.business_slug, { displayName: r.display_name, colourName: r.colour ?? "slate" }])
  );
}

export function businessLabel(slug: string): string {
  return businessDirectory.get(slug)?.displayName ?? BUSINESS_LABELS[slug] ?? slug;
}

export function businessColor(slug: string): BusinessColor {
  const liveColourName = businessDirectory.get(slug)?.colourName;
  if (liveColourName) return colorByName(liveColourName);
  return colorByName(FALLBACK_BUSINESS_COLOUR_NAMES[slug]);
}

export interface WhatsappMessage {
  id: string;
  business_slug: string;
  chat_id: string;
  contact_name: string | null;
  contact_number: string | null;
  // The name saved in the connected WhatsApp Business account's own
  // phonebook, when the bridge reports it — see lib/contactName.ts. Always
  // null until the bridge sends it.
  business_contact_name: string | null;
  direction: string | null;
  message_body: string | null;
  message_type: string | null;
  media_url: string | null;
  created_at: string;
  timestamp: string;
  // Group-chat sender identity, pulled from the Baileys `raw` payload the
  // bridge already stores (raw.key.participant / raw.key.participantPn /
  // raw.pushName) via lightweight JSON-path selects — see
  // resolveGroupSenderName() below. Only populated for messages the bridge
  // received in a group ("@g.us") chat; null for everything else, including
  // every 1:1 message.
  sender_participant?: string | null;
  sender_participant_pn?: string | null;
  sender_push_name?: string | null;
  // The real MSISDN Baileys reports on an inbound 1:1 message's key
  // (`senderPn`) when the chat's JID is a WhatsApp "@lid" privacy id —
  // contact_number itself only ever stores that lid form, never this. Null
  // for outbound messages and for messages from a real (non-lid) phone JID,
  // where contact_number is already dialable. See resolveConversationPhone().
  sender_pn?: string | null;
  // Present only when this row has no plain-text message_body but the
  // underlying WhatsApp event still carries user-facing text: an emoji
  // reaction, or a "message deleted" event. See resolveBubbleText().
  reaction_text?: string | null;
  protocol_type?: string | null;
}

export interface WhatsappSession {
  business_slug: string;
  status: string | null;
  updated_at: string | null;
  last_connected_at: string | null;
}

export interface Conversation {
  chatId: string;
  contactName: string | null;
  contactNumber: string | null;
  businessContactName: string | null;
  lastMessage: WhatsappMessage;
  messages: WhatsappMessage[];
}

export function isOutbound(direction: string | null | undefined): boolean {
  return (direction ?? "").toLowerCase().includes("out");
}

export function isSessionConnected(status: string | null | undefined): boolean {
  return ["connected", "online", "active"].includes((status ?? "").toLowerCase());
}

// Group-chat display name for whoever actually sent an inbound message —
// distinct from `contact_name`, which for a group conversation as a whole
// just tracks whichever participant sent the *latest* message (see
// groupConversations() below). Priority: contact_name (the bridge already
// sets this to the sender's WhatsApp pushName for group messages) ->
// sender_push_name (same value, straight from the raw payload, in case a
// row ever has one without the other) -> a formatted phone number from
// participantPn/participant when no name was ever reported. Returns null
// for 1:1 chats and outbound messages, so callers can render nothing there.
export function resolveGroupSenderName(message: WhatsappMessage): string | null {
  if (isOutbound(message.direction)) return null;
  if (parseWhatsappJid(message.chat_id).kind !== "group") return null;

  const pushName = (message.contact_name || message.sender_push_name || "").trim();
  if (pushName) return pushName;

  const parsed = parseWhatsappJid(message.sender_participant_pn || message.sender_participant);
  if (parsed.kind === "phone" && parsed.digits) {
    return formatPhoneDisplay(parsed.digits);
  }
  return "Unknown participant";
}

// Real phone number for a 1:1 conversation whose contact uses WhatsApp's
// "@lid" privacy mode. A lid JID is a stable opaque id WhatsApp assigns
// instead of the phone number — not a phone number itself — and
// contact_number (and the customers.phone_number dedupe key derived from
// it) only ever stores that lid form for these contacts; deliberately left
// alone here since chat_id/threading and the customer record's identity
// both depend on it staying exactly what the bridge wrote. Baileys does
// still report the real MSISDN as `key.senderPn` on every inbound message
// from that contact, though, so this recovers it for *display* only by
// scanning the conversation's own messages. Falls back to
// resolveDisplayPhone's existing behavior (phone: null, isLid: true) if no
// message in the conversation has ever carried a senderPn — e.g. an @lid
// conversation with only outbound messages so far.
export function resolveConversationPhone(
  contactNumber: string | null | undefined,
  chatId: string | null | undefined,
  messages: WhatsappMessage[]
): DisplayPhoneResult {
  const direct = resolveDisplayPhone(contactNumber, chatId);
  if (!direct.isLid) return direct;

  const senderPn = messages.find((m) => m.sender_pn)?.sender_pn;
  const parsed = parseWhatsappJid(senderPn);
  if (parsed.kind === "phone" && parsed.digits) {
    return { phone: parsed.digits, isLid: false };
  }
  return direct;
}

// Text to show in a message bubble when message_body is empty. Most rows
// with no body and no media are WhatsApp protocol-level events with no
// user-facing text at all (history sync, key distribution, etc.) — those
// correctly fall through to null/"—". Two real exceptions Baileys reports
// with actual user-facing content the bridge doesn't copy into message_body:
// an emoji reaction (reactionMessage.text) and a "deleted for everyone"
// event (protocolMessage.type === "REVOKE"). Both are read from lightweight
// JSON-path selects (reaction_text/protocol_type), not the full `raw`
// column — see the loadMessages comment in Inbox.tsx for why that matters.
export function resolveBubbleText(message: WhatsappMessage): string | null {
  const body = message.message_body?.trim();
  if (body) return body;
  if (message.reaction_text) return `Reacted ${message.reaction_text}`;
  if (message.protocol_type === "REVOKE") return "This message was deleted";
  return null;
}

const SYSTEM_CHAT_IDS = new Set(["status@broadcast", "broadcast"]);

export function isSystemChatId(chatId: string): boolean {
  const normalized = chatId.toLowerCase();
  return SYSTEM_CHAT_IDS.has(normalized) || normalized.endsWith("@broadcast");
}

export function filterCustomerMessages(messages: WhatsappMessage[]): WhatsappMessage[] {
  return messages.filter((m) => !isSystemChatId(m.chat_id));
}

export function groupConversations(messages: WhatsappMessage[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const message of messages) {
    const existing = map.get(message.chat_id);
    if (existing) {
      existing.messages.push(message);
      existing.lastMessage = message;
      existing.contactName = message.contact_name ?? existing.contactName;
      existing.contactNumber = message.contact_number ?? existing.contactNumber;
      existing.businessContactName = message.business_contact_name ?? existing.businessContactName;
    } else {
      map.set(message.chat_id, {
        chatId: message.chat_id,
        contactName: message.contact_name,
        contactNumber: message.contact_number,
        businessContactName: message.business_contact_name,
        lastMessage: message,
        messages: [message],
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(b.lastMessage.timestamp).getTime() -
      new Date(a.lastMessage.timestamp).getTime()
  );
}

export function resolveRecipientNumber(
  contactNumber: string | null,
  chatId: string
): string {
  if (contactNumber) return contactNumber;
  return chatId.replace(/@s\.whatsapp\.net$/i, "");
}

export function matchesSearch(conversation: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (conversation.contactName ?? "").toLowerCase().includes(q) ||
    (conversation.contactNumber ?? "").toLowerCase().includes(q) ||
    conversation.chatId.toLowerCase().includes(q) ||
    conversation.messages.some((m) => (m.message_body ?? "").toLowerCase().includes(q))
  );
}
