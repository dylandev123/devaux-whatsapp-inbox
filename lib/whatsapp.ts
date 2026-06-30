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
