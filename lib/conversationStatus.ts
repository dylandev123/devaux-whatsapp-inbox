import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors conversation_status from
// supabase/migrations/20260623000700_conversation_status.sql. A conversation
// with no row in that table is implicitly "Active".
export type ConversationStatusValue = "Active" | "Archived" | "Spam";

export const CONVERSATION_STATUSES: ConversationStatusValue[] = ["Active", "Archived", "Spam"];

// Inbox-level filter, layered on top of ConversationStatusValue: "Unread" is
// derived client-side from conversation_reads (see lib/reads.ts) rather than
// stored in conversation_status, since read state is per-staff-member and
// status is shared across the whole team. "Hidden" is the same idea applied
// to the `hidden` column added by
// supabase/migrations/20260902000000_conversation_hidden.sql: independent of
// Active/Archived/Spam (a hidden conversation keeps whatever status it
// already had), shared across the whole team, and excluded from every other
// filter — see fetchHiddenChatIds()/setConversationHidden() below.
export type InboxFilterValue = ConversationStatusValue | "All" | "Unread" | "Hidden";
export const INBOX_FILTERS: InboxFilterValue[] = ["All", "Active", "Unread", "Archived", "Spam", "Hidden"];

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

// App-only hide: never touches whatsapp_messages, so a hidden conversation's
// data stays exactly where it is in Supabase/WhatsApp — this only controls
// whether the inbox shows it. Same upsert-partial-columns idiom as
// setConversationStatus() above: omitting `status` from the payload leaves
// an existing row's status untouched on conflict, and a brand-new row falls
// back to conversation_status's own `status default 'Active'`.
export async function fetchHiddenChatIds(businessSlug: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("conversation_status")
    .select("chat_id")
    .eq("business_slug", businessSlug)
    .eq("hidden", true);
  if (error) {
    throw new Error(logAndDescribeError("fetchHiddenChatIds", error));
  }
  return new Set((data ?? []).map((row) => row.chat_id as string));
}

export async function setConversationHidden(
  businessSlug: string,
  chatId: string,
  hidden: boolean
): Promise<void> {
  const { error } = await supabase
    .from("conversation_status")
    .upsert(
      { business_slug: businessSlug, chat_id: chatId, hidden },
      { onConflict: "business_slug,chat_id" }
    );
  if (error) {
    throw new Error(logAndDescribeError("setConversationHidden", error));
  }
}
