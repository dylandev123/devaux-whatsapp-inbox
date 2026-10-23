// Server-only: resolves every JID that provably belongs to one contact (see
// lib/aiAgent/identity.ts for the rules). Shared by the decision pipeline, the
// memory loader and the admin memory routes so they can never disagree about
// who a customer is.

import { ChatIdentity, isLidJid, resolveChatIdentity, verifiedPhoneDigits } from "@/lib/aiAgent/identity";
import { agentDb } from "@/lib/server/aiAgent/db";

// Stored history is best-effort (messages are purged after 7 days); a failed
// lookup just leaves the chat_id on its own, which can only narrow, never
// widen, who is matched.
export async function loadIdentity(businessSlug: string, chatId: string, contactNumber: string | null): Promise<ChatIdentity> {
  const db = agentDb();
  let storedPhone: string | null = null;
  if (isLidJid(chatId) && !verifiedPhoneDigits(chatId, contactNumber)) {
    const { data } = await db
      .from("whatsapp_messages")
      .select("contact_number")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .not("contact_number", "is", null)
      .order("timestamp", { ascending: false })
      .limit(50);
    storedPhone =
      (data ?? []).map((r) => verifiedPhoneDigits(chatId, r.contact_number)).find((p): p is string => Boolean(p)) ?? null;
  }
  const phone = verifiedPhoneDigits(chatId, contactNumber) ?? storedPhone;
  let lidChats: string[] = [];
  if (phone) {
    const { data } = await db
      .from("whatsapp_messages")
      .select("chat_id")
      .eq("business_slug", businessSlug)
      .eq("contact_number", phone)
      .like("chat_id", "%@lid")
      .limit(200);
    lidChats = [...new Set((data ?? []).map((r) => r.chat_id as string))];
  }
  return resolveChatIdentity(chatId, contactNumber, { storedPhone, lidChats });
}
