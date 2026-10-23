// Server-only: escalation records, staff actions on them (from the staff
// WhatsApp group or the admin UI — one shared code path), and per-conversation
// human takeover. Matching a staff message to an escalation is decided by
// matchStaffReply() in lib/aiAgent/engine.ts; this file only loads candidates
// and applies the result.

import {
  AgentSettings,
  buildStaffNotice,
  type PriorNotice,
  canSendToCustomers,
  EscalationPriority,
  extractRefCodes,
  MatchableEscalation,
  matchStaffReply,
  OrderRequestDraft,
  priorityFor,
  StaffCommand,
} from "@/lib/aiAgent/engine";
import { ActorKind, agentDb, audit, newRefCode } from "@/lib/server/aiAgent/db";
import { OutboxInsert } from "@/lib/server/aiAgent/outbox";

export interface EscalationRow {
  id: string;
  ref_code: string;
  business_slug: string;
  chat_id: string;
  contact_number: string | null;
  customer_name: string | null;
  priority: EscalationPriority;
  status: "open" | "notified" | "answered" | "resolved" | "cancelled";
  reason: string;
  reason_codes: string[];
  customer_message: string | null;
  ai_summary: string | null;
  proposed_reply: string | null;
  context: Record<string, unknown>;
  notice_message_id: string | null;
  staff_answer: string | null;
  answered_by: string | null;
  answered_via: string | null;
  answered_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ESCALATION_COLUMNS =
  "id, ref_code, business_slug, chat_id, contact_number, customer_name, priority, status, reason, reason_codes, customer_message, ai_summary, proposed_reply, context, notice_message_id, staff_answer, answered_by, answered_via, answered_at, resolved_at, created_at, updated_at";

/** Customer-facing sends (and staff-group feedback) need Assisted mode; see canSendStaffNotice() for notices. */
export function canSend(settings: AgentSettings | null): boolean {
  return canSendToCustomers(settings);
}

export async function findOpenEscalation(businessSlug: string, chatId: string): Promise<EscalationRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .in("status", ["open", "notified"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as EscalationRow | null) ?? null;
}

export interface EscalateInput {
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  customerName: string;
  reasons: string[];
  priority: EscalationPriority;
  customerMessage: string;
  draftReply: string | null;
  summary: string | null;
  orderRequest: OrderRequestDraft | null;
  eventId: string | null;
}

/** Opens an escalation, or appends to the conversation's open one. */
export async function createOrAppendEscalation(
  input: EscalateInput
): Promise<{ escalation: EscalationRow; followUp: boolean }> {
  const db = agentDb();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findOpenEscalation(input.businessSlug, input.chatId);
    if (existing) {
      const reasonCodes = Array.from(new Set([...existing.reason_codes, ...input.reasons]));
      const { data, error } = await db
        .from("ai_agent_escalations")
        .update({
          customer_message: `${existing.customer_message ?? ""}\n---\n${input.customerMessage}`.slice(-4000),
          reason_codes: reasonCodes,
          priority: priorityFor(reasonCodes, existing.priority),
          context: { ...existing.context, order_request: input.orderRequest ?? existing.context.order_request ?? null },
        })
        .eq("id", existing.id)
        .select(ESCALATION_COLUMNS)
        .single();
      if (error) throw new Error(error.message);
      return { escalation: data as EscalationRow, followUp: true };
    }

    const { data, error } = await db
      .from("ai_agent_escalations")
      .insert({
        ref_code: await newRefCode(),
        business_slug: input.businessSlug,
        chat_id: input.chatId,
        contact_number: input.contactNumber,
        customer_name: input.customerName,
        priority: input.priority,
        reason: input.reasons[0] ?? "escalated",
        reason_codes: input.reasons,
        customer_message: input.customerMessage.slice(0, 4000),
        ai_summary: input.summary,
        proposed_reply: input.draftReply,
        context: { order_request: input.orderRequest },
        source_event_id: input.eventId,
      })
      .select(ESCALATION_COLUMNS)
      .single();
    if (!error) return { escalation: data as EscalationRow, followUp: false };
    // 23505 on ai_agent_escalations_one_open_idx: a concurrent message opened
    // one first — loop once and append to it instead.
    if (error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not open or append an escalation");
}

/** Every staff_notice already created for an escalation, whatever its status. */
export async function priorStaffNotices(businessSlug: string, escalationId: string): Promise<PriorNotice[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_outbox")
    .select("status, error")
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("kind", "staff_notice");
  if (error) throw new Error(error.message);
  return (data ?? []) as PriorNotice[];
}

/** The escalation as first recorded, for a first notice sent on a later message. */
export function originalEscalationInput(
  escalation: EscalationRow,
  current: Pick<EscalateInput, "customerMessage" | "draftReply" | "orderRequest" | "reasons">
): Pick<EscalateInput, "customerMessage" | "draftReply" | "orderRequest" | "reasons"> {
  return {
    customerMessage: escalation.customer_message ?? current.customerMessage,
    draftReply: escalation.proposed_reply ?? current.draftReply,
    orderRequest: current.orderRequest ?? (escalation.context.order_request as OrderRequestDraft | null | undefined) ?? null,
    reasons: escalation.reason_codes.length ? escalation.reason_codes : current.reasons,
  };
}

export function staffNoticeFor(
  escalation: EscalationRow,
  input: Pick<EscalateInput, "customerMessage" | "draftReply" | "orderRequest" | "reasons">,
  followUp: boolean,
  observeOnly = false
): string {
  return buildStaffNotice({
    refCode: escalation.ref_code,
    priority: escalation.priority,
    customerLabel: [escalation.customer_name, escalation.contact_number].filter(Boolean).join(" · ") || escalation.chat_id,
    reasons: input.reasons,
    customerMessage: input.customerMessage,
    draftReply: input.draftReply,
    orderRequest: input.orderRequest,
    followUp,
    observeOnly,
  });
}

// ── Conversation control ─────────────────────────────────────────────────────

export async function setConversationControl(input: {
  businessSlug: string;
  chatId: string;
  control: "ai" | "human";
  minutes: number | null;
  reason: string;
  actorKind: ActorKind;
  actorId: string | null;
}): Promise<void> {
  const now = new Date();
  const humanUntil =
    input.control === "human" && input.minutes ? new Date(now.getTime() + input.minutes * 60_000).toISOString() : null;
  const { error } = await agentDb()
    .from("ai_agent_conversations")
    .upsert(
      {
        business_slug: input.businessSlug,
        chat_id: input.chatId,
        control: input.control,
        human_until: humanUntil,
        control_reason: input.reason,
        control_changed_by: input.actorKind === "admin" ? input.actorId : null,
        control_changed_at: now.toISOString(),
      },
      { onConflict: "business_slug,chat_id" }
    );
  if (error) throw new Error(error.message);
  await audit(input.businessSlug, input.actorKind, input.actorId, `conversation.${input.control === "human" ? "takeover" : "resume"}`, {
    type: "conversation",
    id: input.chatId,
  }, { reason: input.reason, human_until: humanUntil });
}

// ── Staff actions (shared by WhatsApp group + admin UI) ──────────────────────

export interface StaffActionResult {
  outbox: OutboxInsert[];
  feedback: string;
}

export async function applyStaffAction(input: {
  escalation: EscalationRow;
  command: StaffCommand;
  body: string;
  settings: AgentSettings | null;
  actorKind: ActorKind;
  actorId: string | null;
  via: "whatsapp" | "admin_ui";
  dedupeBase: string;
}): Promise<StaffActionResult> {
  const { escalation: e, command, body } = input;
  if (input.settings && input.settings.business_slug !== e.business_slug) {
    throw new Error("Escalation belongs to a different business");
  }
  const db = agentDb();
  const now = new Date().toISOString();
  const outbox: OutboxInsert[] = [];
  let feedback: string;

  switch (command) {
    case "send": {
      const sendable = canSend(input.settings);
      if (sendable) {
        outbox.push({
          businessSlug: e.business_slug,
          chatId: e.chat_id,
          kind: "staff_relay",
          toJid: e.chat_id,
          body,
          dedupeKey: `${input.dedupeBase}:staff_relay`,
          escalationId: e.id,
          createdBy: input.actorKind === "admin" ? input.actorId : null,
        });
      }
      const { error } = await db
        .from("ai_agent_escalations")
        .update({
          status: "answered",
          staff_answer: body,
          answered_by: input.actorId,
          answered_via: input.via,
          answered_at: now,
          // Recorded for review only: nothing was queued for the customer.
          context: sendable ? e.context : { ...e.context, answer_not_relayed: input.settings?.mode ?? "disabled" },
        })
        .eq("id", e.id);
      if (error) throw new Error(error.message);
      // A correction candidate only — becomes knowledge solely on admin approval.
      await db
        .from("ai_agent_learning_candidates")
        .upsert(
          { business_slug: e.business_slug, escalation_id: e.id, question: e.customer_message, staff_answer: body },
          { onConflict: "escalation_id", ignoreDuplicates: true }
        );
      feedback = sendable
        ? `✅ #${e.ref_code}: sending your answer to the customer.`
        : `⚠️ #${e.ref_code}: answer saved, but the agent is not in Assisted mode so nothing was sent. Reply to the customer directly.`;
      break;
    }
    case "note": {
      const notes = Array.isArray(e.context.notes) ? e.context.notes : [];
      const { error } = await db
        .from("ai_agent_escalations")
        .update({ context: { ...e.context, notes: [...notes, { at: now, by: input.actorId, text: body.slice(0, 1000) }] } })
        .eq("id", e.id);
      if (error) throw new Error(error.message);
      feedback = `📝 #${e.ref_code}: note saved (not sent to the customer).`;
      break;
    }
    case "close": {
      const { error } = await db
        .from("ai_agent_escalations")
        .update({ status: "resolved", resolved_at: now })
        .eq("id", e.id);
      if (error) throw new Error(error.message);
      feedback = `☑️ #${e.ref_code}: closed.`;
      break;
    }
    case "takeover":
    case "resume": {
      await setConversationControl({
        businessSlug: e.business_slug,
        chatId: e.chat_id,
        control: command === "takeover" ? "human" : "ai",
        minutes: null,
        reason: `${input.via}:${e.ref_code}`,
        actorKind: input.actorKind,
        actorId: input.actorId,
      });
      feedback =
        command === "takeover"
          ? `🙋 #${e.ref_code}: AI paused for this customer until resumed.`
          : `🤖 #${e.ref_code}: AI resumed for this customer.`;
      break;
    }
  }

  await audit(e.business_slug, input.actorKind, input.actorId, `escalation.${command}`, { type: "escalation", id: e.id }, {
    via: input.via,
    ref_code: e.ref_code,
    body: body ? body.slice(0, 500) : null,
  });
  return { outbox, feedback };
}

// ── Staff group messages ─────────────────────────────────────────────────────

async function matchCandidates(
  businessSlug: string,
  text: string,
  quotedMessageId: string | null
): Promise<MatchableEscalation[]> {
  const db = agentDb();
  const refs = extractRefCodes(text);
  const byId = new Map<string, MatchableEscalation>();

  if (refs.length > 0) {
    const { data, error } = await db
      .from("ai_agent_escalations")
      .select("id, ref_code, notice_message_id, status")
      .eq("business_slug", businessSlug)
      .in("ref_code", refs);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) byId.set(row.id, row as MatchableEscalation);
  }

  if (quotedMessageId) {
    // Any notice we posted (first or follow-up) identifies its escalation.
    const { data: notices, error } = await db
      .from("ai_agent_outbox")
      .select("escalation_id")
      .eq("business_slug", businessSlug)
      .eq("kind", "staff_notice")
      .eq("whatsapp_message_id", quotedMessageId);
    if (error) throw new Error(error.message);
    const ids = Array.from(new Set((notices ?? []).map((n) => n.escalation_id).filter(Boolean)));
    if (ids.length > 0) {
      const { data, error: escError } = await db
        .from("ai_agent_escalations")
        .select("id, ref_code, notice_message_id, status")
        .eq("business_slug", businessSlug)
        .in("id", ids);
      if (escError) throw new Error(escError.message);
      for (const row of data ?? []) byId.set(row.id, { ...(row as MatchableEscalation), notice_message_id: quotedMessageId });
    }
  }
  return Array.from(byId.values());
}

export async function processStaffGroupMessage(input: {
  settings: AgentSettings;
  text: string;
  quotedMessageId: string | null;
  senderJid: string | null;
  eventId: string;
}): Promise<{ outbox: OutboxInsert[]; outcome: string; escalationId: string | null }> {
  const { settings } = input;
  const groupJid = settings.staff_group_jid!;
  const candidates = await matchCandidates(settings.business_slug, input.text, input.quotedMessageId);
  const match = matchStaffReply({ text: input.text, quotedMessageId: input.quotedMessageId }, candidates);

  const feedback = (body: string): OutboxInsert => ({
    businessSlug: settings.business_slug,
    chatId: groupJid,
    kind: "staff_feedback",
    toJid: groupJid,
    body,
    dedupeKey: `${input.eventId}:staff_feedback`,
    eventId: input.eventId,
  });
  // Staff feedback only speaks in Assisted mode — Observe never posts anything.
  const speak = canSend(settings);

  switch (match.kind) {
    case "unmatched":
      return { outbox: [], outcome: "unmatched", escalationId: null };
    case "ambiguous":
      return {
        outbox: speak ? [feedback(`⚠️ Not sent: that message matches more than one escalation (${match.refCodes.map((r) => `#${r}`).join(", ")}). Reply to one escalation at a time.`)] : [],
        outcome: "ambiguous",
        escalationId: null,
      };
    case "unknown_ref":
      return {
        outbox: speak ? [feedback(`⚠️ Not sent: no escalation ${match.refCodes.map((r) => `#${r}`).join(", ")} found.`)] : [],
        outcome: "unknown_ref",
        escalationId: null,
      };
    case "closed":
      return {
        outbox: speak ? [feedback(`ℹ️ #${match.refCode} is already closed — nothing was sent.`)] : [],
        outcome: "closed",
        escalationId: match.escalationId,
      };
    case "empty":
      return {
        outbox: speak ? [feedback(`⚠️ #${match.refCode}: no answer text found — nothing was sent.`)] : [],
        outcome: "empty",
        escalationId: match.escalationId,
      };
    case "matched": {
      const { data, error } = await agentDb()
        .from("ai_agent_escalations")
        .select(ESCALATION_COLUMNS)
        .eq("id", match.escalationId)
        .eq("business_slug", settings.business_slug)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        // Belt and braces: candidates are already business-scoped, so this
        // means the row belongs to another business. Never act on it.
        return { outbox: [], outcome: "unknown_ref", escalationId: null };
      }
      const result = await applyStaffAction({
        escalation: data as EscalationRow,
        command: match.command,
        body: match.body,
        settings,
        actorKind: "staff",
        actorId: input.senderJid,
        via: "whatsapp",
        dedupeBase: input.eventId,
      });
      const outbox: OutboxInsert[] = result.outbox.map((o) => ({ ...o, eventId: input.eventId }));
      if (speak) outbox.push(feedback(result.feedback));
      return { outbox, outcome: `matched:${match.command}`, escalationId: match.escalationId };
    }
  }
}
