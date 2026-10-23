// Server-only: assembles what the agent knows about a customer, reusing the
// existing memory tables rather than duplicating them —
//   customers            (verified, staff-entered identity)
//   customer_ai_profile  (AI-inferred soft facts, maintained by the analysis engine)
//   customer_orders      (permanent order history, survives the 7-day purge)
// plus a short slice of recent whatsapp_messages for conversational context.
// Read-only: the agent never writes any of these tables.

import { resolveContactName } from "@/lib/contactName";
import { isOutbound, resolveRecipientNumber } from "@/lib/whatsapp";
import { OrderRequestDraft } from "@/lib/aiAgent/engine";
import { agentDb } from "@/lib/server/aiAgent/db";

const TRANSCRIPT_MESSAGES = 12;

export interface CustomerContext {
  customerKey: string;
  customerName: string;
  profile: Record<string, string>;
  recentOrders: { summary: string; status: string | null; at: string | null }[];
  transcript: { who: "Customer" | "Staff"; text: string; at: string }[];
}

export async function loadCustomerContext(
  businessSlug: string,
  chatId: string,
  contactNumber: string | null,
  excludeMessageId: string | null
): Promise<CustomerContext> {
  const db = agentDb();
  const customerKey = resolveRecipientNumber(contactNumber, chatId);

  const [customer, profile, orders, messages] = await Promise.all([
    db
      .from("customers")
      .select("first_name, last_name, whatsapp_name, business_contact_name")
      .eq("phone_number", customerKey)
      .maybeSingle(),
    db
      .from("customer_ai_profile")
      .select("preferences, common_orders, addresses, payment_habits, important_notes, last_known_intent")
      .eq("business_slug", businessSlug)
      .eq("contact_number", customerKey)
      .maybeSingle(),
    db
      .from("customer_orders")
      .select("summary, order_status, source_message_at")
      .eq("business_slug", businessSlug)
      .eq("contact_number", customerKey)
      .order("source_message_at", { ascending: false, nullsFirst: false })
      .limit(3),
    db
      .from("whatsapp_messages")
      .select("whatsapp_message_id, direction, message_body, timestamp")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .order("timestamp", { ascending: false })
      .limit(TRANSCRIPT_MESSAGES + 1),
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

  const profileFacts: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.data ?? {})) {
    if (typeof value === "string" && value.trim()) profileFacts[key] = value.trim();
  }

  const transcript = (messages.data ?? [])
    .filter((m) => !excludeMessageId || m.whatsapp_message_id !== excludeMessageId)
    .filter((m) => m.message_body?.trim())
    .slice(0, TRANSCRIPT_MESSAGES)
    .reverse()
    .map((m) => ({
      who: isOutbound(m.direction) ? ("Staff" as const) : ("Customer" as const),
      text: m.message_body!.trim().slice(0, 600),
      at: m.timestamp,
    }));

  return {
    customerKey,
    customerName,
    profile: profileFacts,
    recentOrders: (orders.data ?? []).map((o) => ({
      summary: o.summary,
      status: o.order_status,
      at: o.source_message_at,
    })),
    transcript,
  };
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
