// Server-only: the agent's outbox — every WhatsApp message the agent wants
// sent, handed to the bridge exactly once (see the ai_agent_outbox comment in
// the migration). Items created while answering a bridge request are returned
// in that response already 'dispatched'; items created from the admin UI stay
// 'pending' until the bridge claims them via claim_ai_agent_outbox().

import { outboxAllowed } from "@/lib/aiAgent/engine";
import { buildSendFailureMessage } from "@/lib/aiAgent/staffAnswers";
import { agentDb, loadSettings } from "@/lib/server/aiAgent/db";

export type OutboxKind = "customer_reply" | "holding_reply" | "staff_notice" | "staff_draft" | "staff_relay" | "staff_feedback";

export interface OutboxInsert {
  businessSlug: string;
  chatId: string;
  kind: OutboxKind;
  toJid: string;
  body: string;
  dedupeKey: string;
  eventId?: string | null;
  escalationId?: string | null;
  createdBy?: string | null;
  /** Staff group only: the WhatsApp message to quote when posting (the staff member's answer). Optional for the bridge. */
  replyToMessageId?: string | null;
}

/** Wire shape returned to the bridge. Only `send: true` items may be sent. */
export interface BridgeOutboxItem {
  id: string;
  businessSlug: string;
  kind: OutboxKind;
  to: string;
  body: string;
  send: boolean;
  /** Present only when the bridge may post this item as a quote of that message; ignoring it is safe. */
  replyToMessageId?: string;
}

interface OutboxRow {
  id: string;
  business_slug: string;
  kind: OutboxKind;
  to_jid: string;
  body: string;
  status: string;
  reply_to_message_id?: string | null;
  error?: string | null;
}

const OUTBOX_ROW_COLUMNS = "id, business_slug, kind, to_jid, body, status, reply_to_message_id, error";

export function toBridgeItem(row: OutboxRow, send: boolean): BridgeOutboxItem {
  const item: BridgeOutboxItem = { id: row.id, businessSlug: row.business_slug, kind: row.kind, to: row.to_jid, body: row.body, send };
  if (row.reply_to_message_id) item.replyToMessageId = row.reply_to_message_id;
  return item;
}

/**
 * Inserts items, skipping any whose dedupe_key already exists, and returns the
 * rows actually created. dispatchNow = the caller hands them to the bridge in
 * its own response.
 */
export async function enqueue(items: OutboxInsert[], dispatchNow: boolean): Promise<OutboxRow[]> {
  if (items.length === 0) return [];
  const now = new Date().toISOString();
  const { data, error } = await agentDb()
    .from("ai_agent_outbox")
    .upsert(
      items.map((i) => ({
        business_slug: i.businessSlug,
        chat_id: i.chatId,
        kind: i.kind,
        to_jid: i.toJid,
        body: i.body.slice(0, 4096),
        dedupe_key: i.dedupeKey,
        event_id: i.eventId ?? null,
        escalation_id: i.escalationId ?? null,
        created_by: i.createdBy ?? null,
        reply_to_message_id: i.replyToMessageId ?? null,
        status: dispatchNow ? "dispatched" : "pending",
        dispatched_at: dispatchNow ? now : null,
      })),
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    )
    .select(OUTBOX_ROW_COLUMNS);
  if (error) throw new Error(error.message);
  return (data ?? []) as OutboxRow[];
}

/**
 * True when a forwarded message is the agent's own send coming back (by the
 * WhatsApp id from the ack, or — before the ack lands — by identical body in
 * the same chat). The bridge contract says never to forward these; this is
 * the backstop, because treating our own staff notice as a staff answer
 * would relay it to the customer.
 */
export async function isAgentEcho(
  businessSlug: string,
  chatId: string,
  whatsappMessageId: string,
  text: string
): Promise<boolean> {
  const db = agentDb();
  const { data: byId, error } = await db
    .from("ai_agent_outbox")
    .select("id")
    .eq("business_slug", businessSlug)
    .eq("whatsapp_message_id", whatsappMessageId)
    .limit(1);
  if (error) throw new Error(error.message);
  if ((byId ?? []).length > 0) return true;
  if (!text.trim()) return false;

  const { data: recent, error: recentError } = await db
    .from("ai_agent_outbox")
    .select("body")
    .eq("business_slug", businessSlug)
    .eq("to_jid", chatId)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .limit(200);
  if (recentError) throw new Error(recentError.message);
  return (recent ?? []).some((r) => r.body.trim() === text.trim());
}

export async function outboxForEvent(eventId: string): Promise<OutboxRow[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_outbox")
    .select(OUTBOX_ROW_COLUMNS)
    .eq("event_id", eventId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as OutboxRow[];
}

export async function claimOutbox(businessSlug: string | null, limit: number): Promise<BridgeOutboxItem[]> {
  const { data, error } = await agentDb().rpc("claim_ai_agent_outbox", {
    p_business_slug: businessSlug,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as OutboxRow[]).map((row) => toBridgeItem(row, true));
}

export type AckResult = "ok" | "not_found" | "conflict";

/**
 * Records the bridge's send outcome. Only dispatched items can be acked;
 * re-acking with the same outcome is a no-op success (idempotent).
 */
export async function ackOutbox(input: {
  outboxId: string;
  status: "sent" | "failed";
  whatsappMessageId: string | null;
  error: string | null;
}): Promise<AckResult> {
  const db = agentDb();
  const { data: row, error } = await db
    .from("ai_agent_outbox")
    .select("id, business_slug, kind, status, escalation_id")
    .eq("id", input.outboxId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return "not_found";
  if (row.status === input.status) return "ok";
  if (row.status !== "dispatched") return "conflict";

  const { error: updateError } = await db
    .from("ai_agent_outbox")
    .update({
      status: input.status,
      whatsapp_message_id: input.whatsappMessageId,
      error: input.error?.slice(0, 1000) ?? null,
      sent_at: input.status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", row.id)
    .eq("status", "dispatched");
  if (updateError) throw new Error(updateError.message);

  // The first delivered staff notice is the escalation's canonical notice;
  // quoted replies to any notice are matched via the outbox itself.
  if (input.status === "sent" && row.kind === "staff_notice" && row.escalation_id) {
    await db
      .from("ai_agent_escalations")
      .update({ notice_message_id: input.whatsappMessageId, status: "notified" })
      .eq("id", row.escalation_id)
      .eq("business_slug", row.business_slug)
      .eq("status", "open")
      .is("notice_message_id", null);
  }
  // An authorized customer reply that the bridge could not deliver: tell the
  // staff group, in plain words, that the customer did NOT receive it. Best effort.
  if (input.status === "failed" && row.kind === "staff_relay" && row.escalation_id) {
    await notifyStaffRelayFailed(row.id, row.business_slug, row.escalation_id, input.error).catch((err) =>
      console.error("[aiAgent] notifyStaffRelayFailed", err instanceof Error ? err.message : err)
    );
  }
  return "ok";
}

async function notifyStaffRelayFailed(outboxId: string, businessSlug: string, escalationId: string, error: string | null): Promise<void> {
  const [settings, { data: e, error: loadError }] = await Promise.all([
    loadSettings(businessSlug),
    agentDb()
      .from("ai_agent_escalations")
      .select("ref_code, customer_name, contact_number, chat_id")
      .eq("id", escalationId)
      .eq("business_slug", businessSlug)
      .maybeSingle(),
  ]);
  if (loadError) throw new Error(loadError.message);
  if (!e || !settings?.staff_group_jid) return;
  const item: OutboxInsert = {
    businessSlug,
    chatId: settings.staff_group_jid,
    kind: "staff_feedback",
    toJid: settings.staff_group_jid,
    body: buildSendFailureMessage({
      refCode: e.ref_code,
      customerLabel: e.customer_name ?? e.contact_number ?? e.chat_id,
      error,
    }),
    dedupeKey: `ack:${outboxId}:relay_failed`,
    escalationId,
  };
  // Staff-group sending is its own permission: same final gate as every other item.
  if (outboxAllowed(settings, item)) await enqueue([item], false);
}
