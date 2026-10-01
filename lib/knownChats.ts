import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";
import { parseWhatsappJid } from "@/lib/phone";
import { Conversation, isSystemChatId } from "@/lib/whatsapp";

// One row per chat for the "Manage chats" view — mirrors list_known_chats()
// from supabase/migrations/20260903000000_list_known_chats.sql. On/Off
// visibility is NOT part of this: it's conversation_status.hidden, read via
// fetchHiddenChatIds() in lib/conversationStatus.ts.
export interface KnownChat {
  chatId: string;
  isGroup: boolean;
  contactName: string | null;
  contactNumber: string | null;
  lastMessageBody: string | null;
  lastDirection: string | null;
  lastMessageAt: string | null;
  messageCount: number | null;
}

interface KnownChatRow {
  chat_id: string;
  contact_name: string | null;
  contact_number: string | null;
  last_message_body: string | null;
  last_direction: string | null;
  last_message_at: string | null;
  message_count: number | string | null;
}

export function isGroupChatId(chatId: string): boolean {
  return parseWhatsappJid(chatId).kind === "group";
}

// `complete` is false when the RPC isn't available (migration not run yet)
// and the list was built from the inbox's own loaded window instead.
export interface KnownChatsResult {
  chats: KnownChat[];
  complete: boolean;
}

export async function fetchKnownChats(
  businessSlug: string,
  loadedConversations: Conversation[]
): Promise<KnownChatsResult> {
  const { data, error } = await supabase.rpc("list_known_chats", { p_business_slug: businessSlug });
  if (error) {
    // Most likely PGRST202 (function not found) before the migration has
    // been run — don't block the view, just fall back to recent chats.
    logAndDescribeError("fetchKnownChats", error);
    return { chats: knownChatsFromConversations(loadedConversations), complete: false };
  }
  const chats = ((data ?? []) as KnownChatRow[])
    .filter((row) => row.chat_id && !isSystemChatId(row.chat_id))
    .map((row) => ({
      chatId: row.chat_id,
      isGroup: isGroupChatId(row.chat_id),
      contactName: row.contact_name,
      contactNumber: row.contact_number,
      lastMessageBody: row.last_message_body,
      lastDirection: row.last_direction,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count === null ? null : Number(row.message_count),
    }));
  return { chats, complete: true };
}

export function knownChatsFromConversations(conversations: Conversation[]): KnownChat[] {
  return conversations.map((c) => ({
    chatId: c.chatId,
    isGroup: isGroupChatId(c.chatId),
    contactName: c.contactName,
    contactNumber: c.contactNumber,
    lastMessageBody: c.lastMessage.message_body,
    lastDirection: c.lastMessage.direction,
    lastMessageAt: c.lastMessage.timestamp,
    messageCount: null,
  }));
}
