// Loads the business's known chats for the AI agent pickers.
//
// Sources, all filtered by business_slug (nothing here ever reads another
// business's rows):
//   * list_known_chats()      — every chat with a stored message. whatsapp_messages
//                               is purged after 7 days, so this is "recent" chats.
//   * whatsapp_messages       — direct query, only if the RPC isn't installed.
//   * customer_orders         — real chat_ids that outlive the purge.
//   * ai_agent_contact_rules  — contacts an admin already allowed/excluded.
// Uses the service role (admin routes only) so it does not depend on the
// caller's RLS; business isolation is the explicit .eq("business_slug") filters.

import { type DirectoryChat, dedupeChats } from "./chatDirectory.ts";

// Structural slice of the Supabase client, so tests can pass a fake. Server
// callers use lib/server/aiAgent/chats.ts, which supplies the service client.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ChatSourceDb {
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BusinessChats {
  contacts: DirectoryChat[];
  groups: (DirectoryChat & { lastSender: string | null })[];
  /** false → the list_known_chats RPC is missing and the fallback covered only recent rows. */
  rpcAvailable: boolean;
}

interface ChatRow {
  chat_id: string;
  contact_name: string | null;
  contact_number: string | null;
  last_message_at: string | null;
}

const FALLBACK_ROW_LIMIT = 5000;

function isSystem(chatId: string): boolean {
  const id = chatId.trim().toLowerCase();
  return id === "broadcast" || id.endsWith("@broadcast") || id.endsWith("@newsletter");
}

async function loadMessageChats(db: ChatSourceDb, businessSlug: string): Promise<{ rows: ChatRow[]; rpcAvailable: boolean }> {
  const rpc = await db.rpc("list_known_chats", { p_business_slug: businessSlug });
  if (!rpc.error) return { rows: (rpc.data ?? []) as ChatRow[], rpcAvailable: true };

  const { data, error } = await db
    .from("whatsapp_messages")
    .select("chat_id, contact_name, contact_number, direction, timestamp")
    .eq("business_slug", businessSlug)
    .not("chat_id", "is", null)
    .order("timestamp", { ascending: false })
    .limit(FALLBACK_ROW_LIMIT);
  if (error) throw new Error(error.message);

  const byChat = new Map<string, ChatRow>();
  for (const m of (data ?? []) as (ChatRow & { direction: string | null; timestamp: string | null })[]) {
    const prev = byChat.get(m.chat_id);
    const inbound = !m.direction || !m.direction.toLowerCase().includes("out");
    if (!prev) {
      byChat.set(m.chat_id, {
        chat_id: m.chat_id,
        contact_name: inbound ? m.contact_name : null,
        contact_number: m.contact_number,
        last_message_at: m.timestamp,
      });
    } else {
      // rows arrive newest-first: only fill gaps.
      prev.contact_name ??= inbound ? m.contact_name : null;
      prev.contact_number ??= m.contact_number;
    }
  }
  return { rows: [...byChat.values()], rpcAvailable: false };
}

export async function loadBusinessChats(db: ChatSourceDb, businessSlug: string): Promise<BusinessChats> {
  const { rows, rpcAvailable } = await loadMessageChats(db, businessSlug);

  const extra: DirectoryChat[] = [];
  const [orders, rules] = await Promise.all([
    db.from("customer_orders").select("chat_id, contact_number, customer_name").eq("business_slug", businessSlug).limit(2000),
    db.from("ai_agent_contact_rules").select("chat_id, display_name").eq("business_slug", businessSlug),
  ]);
  // Both are best-effort enrichments; a missing table must not break the picker.
  for (const o of (orders.data ?? []) as { chat_id: string; contact_number: string | null; customer_name: string | null }[]) {
    extra.push({ chatId: o.chat_id, name: o.customer_name, number: o.contact_number, lastMessageAt: null });
  }
  for (const r of (rules.data ?? []) as { chat_id: string; display_name: string | null }[]) {
    extra.push({ chatId: r.chat_id, name: r.display_name, number: null, lastMessageAt: null });
  }

  const direct: DirectoryChat[] = [];
  const groups: BusinessChats["groups"] = [];
  for (const r of rows) {
    if (!r.chat_id || isSystem(r.chat_id)) continue;
    if (r.chat_id.toLowerCase().endsWith("@g.us")) {
      // A group's stored contact_name is its latest SENDER, not its subject.
      groups.push({ chatId: r.chat_id, name: null, number: null, lastMessageAt: r.last_message_at, lastSender: r.contact_name });
    } else {
      direct.push({ chatId: r.chat_id, name: r.contact_name, number: r.contact_number, lastMessageAt: r.last_message_at });
    }
  }
  const contacts = dedupeChats([...direct, ...extra.filter((c) => !isSystem(c.chatId) && !c.chatId.toLowerCase().endsWith("@g.us"))]);
  return { contacts, groups, rpcAvailable };
}
