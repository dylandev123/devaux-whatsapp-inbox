import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors conversation_reads + its two RPCs from
// supabase/migrations/20260623000100_unread_counts.sql. Read state lives in
// Postgres (not localStorage) so it stays in sync across devices/tabs for the
// same staff member.
export interface UnreadCount {
  businessSlug: string;
  chatId: string;
  unreadCount: number;
}

interface UnreadCountRow {
  business_slug: string;
  chat_id: string;
  unread_count: number;
}

export async function fetchUnreadCounts(): Promise<UnreadCount[]> {
  const { data, error } = await supabase.rpc("conversation_unread_counts");
  if (error) {
    throw new Error(logAndDescribeError("fetchUnreadCounts", error));
  }
  return ((data ?? []) as UnreadCountRow[]).map((row) => ({
    businessSlug: row.business_slug,
    chatId: row.chat_id,
    unreadCount: Number(row.unread_count),
  }));
}

export async function markConversationRead(
  businessSlug: string,
  chatId: string,
  lastReadAt: string
): Promise<void> {
  const { error } = await supabase.rpc("mark_conversation_read", {
    p_business_slug: businessSlug,
    p_chat_id: chatId,
    p_last_read_at: lastReadAt,
  });
  if (error) {
    throw new Error(
      logAndDescribeError(`markConversationRead(${businessSlug}, ${chatId})`, error)
    );
  }
}

export function sumUnreadByBusiness(counts: UnreadCount[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const c of counts) {
    totals[c.businessSlug] = (totals[c.businessSlug] ?? 0) + c.unreadCount;
  }
  return totals;
}

export function unreadByChatId(
  counts: UnreadCount[],
  businessSlug: string | null
): Record<string, number> {
  const byChat: Record<string, number> = {};
  if (!businessSlug) return byChat;
  for (const c of counts) {
    if (c.businessSlug !== businessSlug) continue;
    byChat[c.chatId] = c.unreadCount;
  }
  return byChat;
}
