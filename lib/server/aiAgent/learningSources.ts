// Server-only: where an automatically learned fact came from. The knowledge row keeps only identifiers (the WhatsApp
// message id, its time, and the chat id); the business's original message is read from the inbox (whatsapp_messages)
// at the moment someone asks, so no chat text is ever copied into the knowledge database. Always scoped to one
// business: a message id from another business matches nothing.

import { agentDb } from "@/lib/server/aiAgent/db";

export interface SourceRef {
  id: string;
  learned_message_id: string | null;
  learned_message_at: string | null;
  learned_chat_id: string | null;
}

export interface SourceInfo {
  messageId: string;
  chatId: string | null;
  /** When the business sent the message (the inbox's time, else the time recorded at learning). */
  at: string | null;
  /** The business's own original message; null when not requested or no longer in the inbox. */
  original: string | null;
  originalAvailable: boolean;
}

/** Source details by knowledge id. Entries without a recorded message id are simply absent. */
export async function loadSources(businessSlug: string, refs: SourceRef[], opts: { withText: boolean }): Promise<Map<string, SourceInfo>> {
  const out = new Map<string, SourceInfo>();
  const withMessage = refs.filter((r) => r.learned_message_id);
  if (withMessage.length === 0) return out;
  const ids = [...new Set(withMessage.map((r) => r.learned_message_id!))];
  const found = new Map<string, { chat_id: string | null; timestamp: string | null; message_body: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await agentDb()
      .from("whatsapp_messages")
      .select(opts.withText ? "whatsapp_message_id, chat_id, timestamp, message_body" : "whatsapp_message_id, chat_id, timestamp")
      .eq("business_slug", businessSlug)
      .in("whatsapp_message_id", ids.slice(i, i + 100))
      .limit(500);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as unknown as { whatsapp_message_id: string; chat_id: string | null; timestamp: string | null; message_body?: string | null }[]) {
      if (!found.has(m.whatsapp_message_id)) found.set(m.whatsapp_message_id, { chat_id: m.chat_id, timestamp: m.timestamp, message_body: m.message_body ?? null });
    }
  }
  for (const r of withMessage) {
    const m = found.get(r.learned_message_id!);
    // A message that sits in a different chat than the one recorded at learning is not this fact's source.
    const matches = m && (!r.learned_chat_id || !m.chat_id || m.chat_id === r.learned_chat_id);
    const body = matches && opts.withText ? m.message_body?.trim() || null : null;
    out.set(r.id, {
      messageId: r.learned_message_id!,
      chatId: r.learned_chat_id ?? (matches ? m.chat_id : null),
      at: (matches && m.timestamp ? new Date(m.timestamp).toISOString() : null) ?? r.learned_message_at,
      original: body,
      originalAvailable: Boolean(matches),
    });
  }
  return out;
}
