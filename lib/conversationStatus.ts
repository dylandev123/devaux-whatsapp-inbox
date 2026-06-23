import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors conversation_status from
// supabase/migrations/20260623000700_conversation_status.sql. A conversation
// with no row in that table is implicitly "Active".
export type ConversationStatusValue = "Active" | "Archived" | "Spam";

export const CONVERSATION_STATUSES: ConversationStatusValue[] = ["Active", "Archived", "Spam"];
export const CONVERSATION_STATUS_FILTERS: (ConversationStatusValue | "All")[] = [
  "Active",
  "Archived",
  "Spam",
  "All",
];

export interface ConversationStatusRow {
  business_slug: string;
  chat_id: string;
  status: ConversationStatusValue;
}

export async function fetchConversationStatuses(
  businessSlug: string
): Promise<Map<string, ConversationStatusValue>> {
  const { data, error } = await supabase
    .from("conversation_status")
    .select("business_slug, chat_id, status")
    .eq("business_slug", businessSlug);
  if (error) {
    throw new Error(logAndDescribeError("fetchConversationStatuses", error));
  }
  const map = new Map<string, ConversationStatusValue>();
  for (const row of (data ?? []) as ConversationStatusRow[]) {
    map.set(row.chat_id, row.status);
  }
  return map;
}

export async function setConversationStatus(
  businessSlug: string,
  chatId: string,
  status: ConversationStatusValue
): Promise<void> {
  const { error } = await supabase
    .from("conversation_status")
    .upsert(
      { business_slug: businessSlug, chat_id: chatId, status },
      { onConflict: "business_slug,chat_id" }
    );
  if (error) {
    throw new Error(logAndDescribeError("setConversationStatus", error));
  }
}
