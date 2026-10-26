// Server-only: assembles what the agent knows about a customer, reusing the
// existing memory tables rather than duplicating them (see
// lib/server/aiAgent/memory.ts) — verified orders, customer-stated facts and
// AI inferences arrive as ONE concise, labelled brief — plus a short slice of
// recent whatsapp_messages for conversational context (retention-limited).
// Read-only: loading context never writes anything.

import { resolveContactName } from "@/lib/contactName";
import { isOutbound, resolveRecipientNumber } from "@/lib/whatsapp";
import { OrderRequestDraft } from "@/lib/aiAgent/engine";
import { ChatIdentity } from "@/lib/aiAgent/identity";
import { MemoryBrief } from "@/lib/aiAgent/memory";
import { agentDb } from "@/lib/server/aiAgent/db";
import { loadMemoryBrief } from "@/lib/server/aiAgent/memory";

const TRANSCRIPT_MESSAGES = 12;

export interface CustomerContext {
  customerKey: string;
  customerName: string;
  memory: MemoryBrief;
  transcript: { who: "Customer" | "Staff"; text: string; at: string }[];
}

export async function loadCustomerContext(
  businessSlug: string,
  chatId: string,
  contactNumber: string | null,
  excludeMessageIds: string[],
  identity: ChatIdentity,
  messageText: string,
  /** Simulations of a past turn: only conversation from before it (the messages the model could have seen then). */
  options: { before?: string } = {}
): Promise<CustomerContext> {
  const db = agentDb();
  // Display label only. Customer rows are matched by a VERIFIED phone, never
  // by lid digits that merely look like a number.
  const customerKey = identity.phone ?? resolveRecipientNumber(contactNumber, chatId);
  const excluded = new Set(excludeMessageIds);

  const [customer, memory, messages] = await Promise.all([
    identity.phone
      ? db
          .from("customers")
          .select("first_name, last_name, whatsapp_name, business_contact_name")
          .eq("phone_number", identity.phone)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    loadMemoryBrief(businessSlug, identity, messageText),
    (() => {
      const query = db
        .from("whatsapp_messages")
        .select("whatsapp_message_id, direction, message_body, timestamp")
        .eq("business_slug", businessSlug)
        .eq("chat_id", chatId);
      return (options.before ? query.lt("timestamp", options.before) : query)
        .order("timestamp", { ascending: false })
        .limit(TRANSCRIPT_MESSAGES + excluded.size + 1);
    })(),
  ]);

  // Missing tables / rows degrade to "nothing known", never to a failure.
  const c = customer.data;
  const customerName = resolveContactName({
    businessContactName: c?.business_contact_name,
    firstName: c?.first_name,
    lastName: c?.last_name,
    whatsappName: c?.whatsapp_name,
    phoneNumber: customerKey,
  });

  const transcript = (messages.data ?? [])
    .filter((m) => !excluded.has(m.whatsapp_message_id))
    .filter((m) => m.message_body?.trim())
    .slice(0, TRANSCRIPT_MESSAGES)
    .reverse()
    .map((m) => ({
      who: isOutbound(m.direction) ? ("Staff" as const) : ("Customer" as const),
      text: m.message_body!.trim().slice(0, 600),
      at: m.timestamp,
    }));

  return { customerKey, customerName, memory, transcript };
}

/** The customer's saved name (or their verified number / chat id when none is saved). Display only. */
export async function loadCustomerDisplayName(identity: ChatIdentity, contactNumber: string | null, chatId: string): Promise<string> {
  const customerKey = identity.phone ?? resolveRecipientNumber(contactNumber, chatId);
  const { data: c } = identity.phone
    ? await agentDb().from("customers").select("first_name, last_name, whatsapp_name, business_contact_name").eq("phone_number", identity.phone).maybeSingle()
    : { data: null };
  return resolveContactName({
    businessContactName: c?.business_contact_name,
    firstName: c?.first_name,
    lastName: c?.last_name,
    whatsappName: c?.whatsapp_name,
    phoneNumber: customerKey,
  });
}

/** The last few stored messages of a chat (oldest first), labelled. Order monitoring's only look at history. */
export async function loadRecentMessages(
  businessSlug: string,
  chatId: string,
  excludeMessageIds: string[],
  limit = 8
): Promise<{ who: "Customer" | "Staff"; text: string; at: string }[]> {
  const excluded = new Set(excludeMessageIds);
  const { data } = await agentDb()
    .from("whatsapp_messages")
    .select("whatsapp_message_id, direction, message_body, timestamp")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .order("timestamp", { ascending: false })
    .limit(limit + excluded.size + 1);
  return (data ?? [])
    .filter((m) => !excluded.has(m.whatsapp_message_id) && m.message_body?.trim())
    .slice(0, limit)
    .reverse()
    .map((m) => ({ who: isOutbound(m.direction) ? ("Staff" as const) : ("Customer" as const), text: m.message_body!.trim().slice(0, 400), at: m.timestamp }));
}

export interface OpenOrderRequest extends OrderRequestDraft {
  id: string;
  status: "collecting" | "pending_approval";
}

export async function loadOpenOrderRequest(businessSlug: string, chatId: string): Promise<OpenOrderRequest | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_order_requests")
    .select("id, status, items, delivery_address, delivery_preference, notes")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .in("status", ["collecting", "pending_approval"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OpenOrderRequest | null) ?? null;
}

/**
 * Newest manual staff message in this chat, i.e. an outbound whatsapp_messages
 * row that the agent itself did not send. Agent sends are recognised by the
 * WhatsApp id the bridge acked or, before the ack lands, by identical body.
 */
export async function latestManualStaffMessageAt(
  businessSlug: string,
  chatId: string,
  sinceMinutes: number
): Promise<string | null> {
  if (sinceMinutes <= 0) return null;
  const db = agentDb();
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const [outbound, agentSends] = await Promise.all([
    db
      .from("whatsapp_messages")
      .select("whatsapp_message_id, message_body, timestamp")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .ilike("direction", "%out%")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false })
      .limit(20),
    db
      .from("ai_agent_outbox")
      .select("whatsapp_message_id, body")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .gte("created_at", new Date(Date.now() - (sinceMinutes + 60) * 60_000).toISOString()),
  ]);
  if (outbound.error) throw new Error(outbound.error.message);

  const agentIds = new Set((agentSends.data ?? []).map((o) => o.whatsapp_message_id).filter(Boolean));
  const agentBodies = new Set((agentSends.data ?? []).map((o) => o.body.trim()));
  const manual = (outbound.data ?? []).find(
    (m) =>
      !(m.whatsapp_message_id && agentIds.has(m.whatsapp_message_id)) &&
      !agentBodies.has((m.message_body ?? "").trim())
  );
  return manual?.timestamp ?? null;
}
