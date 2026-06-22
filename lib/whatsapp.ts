export const BUSINESS_LABELS: Record<string, string> = {
  dog_food: "Dog Food St. Lucia",
  by_sea: "By Sea Tours",
  cool_pool: "Cool & Pool Products",
  supplify: "Supplify SLU",
  candock: "Candock Carib",
};

export function businessLabel(slug: string): string {
  return BUSINESS_LABELS[slug] ?? slug;
}

export interface BusinessColor {
  dot: string;
  text: string;
  bg: string;
  border: string;
  /** Stronger shade for buttons/outbound bubbles; always paired with white text. */
  solid: string;
}

// Only 4 of the 5 businesses had a colour specified; "supplify" falls back to
// a neutral slate until a colour is chosen for it.
export const BUSINESS_COLORS: Record<string, BusinessColor> = {
  by_sea: {
    dot: "bg-blue-500",
    text: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-500",
    solid: "bg-blue-600",
  },
  dog_food: {
    dot: "bg-green-500",
    text: "text-green-700",
    bg: "bg-green-50",
    border: "border-green-500",
    solid: "bg-green-600",
  },
  cool_pool: {
    dot: "bg-teal-500",
    text: "text-teal-700",
    bg: "bg-teal-50",
    border: "border-teal-500",
    solid: "bg-teal-600",
  },
  candock: {
    dot: "bg-orange-500",
    text: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-500",
    solid: "bg-orange-600",
  },
};

const DEFAULT_BUSINESS_COLOR: BusinessColor = {
  dot: "bg-slate-400",
  text: "text-slate-700",
  bg: "bg-slate-50",
  border: "border-slate-400",
  solid: "bg-slate-600",
};

export function businessColor(slug: string): BusinessColor {
  return BUSINESS_COLORS[slug] ?? DEFAULT_BUSINESS_COLOR;
}

export interface WhatsappMessage {
  id: string;
  business_slug: string;
  chat_id: string;
  contact_name: string | null;
  contact_number: string | null;
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

export function isRealCustomerConversation(conversation: Conversation): boolean {
  return conversation.messages.some((m) => !isOutbound(m.direction));
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
    } else {
      map.set(message.chat_id, {
        chatId: message.chat_id,
        contactName: message.contact_name,
        contactNumber: message.contact_number,
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
