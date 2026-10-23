// Server-only: escalation records, staff actions on them (from the staff
// WhatsApp group or the admin UI — one shared code path), and per-conversation
// human takeover. Matching a staff message to an escalation is decided by
// matchStaffReply() in lib/aiAgent/engine.ts; the staff-group flow that loads
// candidates, drafts customer replies and applies the result lives in
// lib/server/aiAgent/staffGroup.ts.

import {
  AgentSettings,
  appendCustomerMessage,
  buildStaffNotice,
  type PriorNotice,
  canSendToCustomers,
  EscalationPriority,
  type ModelProposal,
  customerMessageSegments,
  OrderRequestDraft,
  priorityFor,
  StaffCommand,
} from "@/lib/aiAgent/engine";
import { ActorKind, agentDb, audit, newRefCode } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import { recordResolvedIssue } from "@/lib/server/aiAgent/memory";
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

/** Customer-facing sends (and staff-group feedback) need Assisted mode — necessary, not sufficient: see planCustomerSend(). */
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
  intent?: ModelProposal["intent"] | null;
  orderRequest: OrderRequestDraft | null;
  /** Verified-history lines (lib/aiAgent/memory.ts) kept on the escalation for the staff notice. */
  history?: string[];
  eventId: string | null;
}

const MAX_RECORDED_UPDATES = 20;

/** Opens an escalation, or appends to the conversation's open one. */
export async function createOrAppendEscalation(
  input: EscalateInput
): Promise<{ escalation: EscalationRow; followUp: boolean }> {
  const db = agentDb();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findOpenEscalation(input.businessSlug, input.chatId);
    if (existing) {
      const reasonCodes = Array.from(new Set([...existing.reason_codes, ...input.reasons]));
      const customerMessage = appendCustomerMessage(existing.customer_message, input.customerMessage);
      // Every follow-up that adds something new is logged on the escalation, so
      // an update is never lost even when no second notice is posted (Observe).
      // A re-processed batch adds nothing new and is not logged twice.
      const updates = Array.isArray(existing.context.updates) ? (existing.context.updates as unknown[]) : [];
      const isNew = customerMessage !== existing.customer_message;
      const nextUpdates = isNew
        ? [...updates, { at: new Date().toISOString(), text: input.customerMessage.slice(0, 300) }].slice(-MAX_RECORDED_UPDATES)
        : updates;
      const { data, error } = await db
        .from("ai_agent_escalations")
        .update({
          customer_message: customerMessage,
          reason_codes: reasonCodes,
          priority: priorityFor(reasonCodes, existing.priority),
          context: {
            ...existing.context,
            order_request: input.orderRequest ?? existing.context.order_request ?? null,
            intent: input.intent ?? existing.context.intent ?? null,
            history: input.history?.length ? input.history : existing.context.history ?? [],
            updates: nextUpdates,
          },
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
        context: { order_request: input.orderRequest, intent: input.intent ?? null, history: input.history ?? [] },
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
    // The escalation's accumulated codes and history, not just this message's.
    reasons: Array.from(new Set([...escalation.reason_codes, ...input.reasons])),
    customerMessage: escalation.customer_message ?? input.customerMessage,
    summary: escalation.ai_summary,
    intent: (escalation.context.intent as ModelProposal["intent"] | null | undefined) ?? null,
    draftReply: input.draftReply,
    orderRequest: input.orderRequest,
    followUp,
    observeOnly,
    history: Array.isArray(escalation.context.history) ? (escalation.context.history as string[]) : [],
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

// ── Resolved issues → long-term memory ───────────────────────────────────────

const ISSUE_CODES = ["complaint", "refund", "payment_claim", "health_concern", "legal_threat", "cancellation", "exception"];

/**
 * A staff-closed escalation about a real issue (not an ordinary order) becomes
 * a short "resolved earlier" note about that customer — staff-confirmed by
 * definition. Amounts are masked: memory never carries prices. Best effort.
 */
async function rememberResolvedIssue(e: EscalationRow, settings: AgentSettings | null): Promise<void> {
  if (!settings?.customer_memory_enabled || !e.reason_codes.some((c) => ISSUE_CODES.includes(c))) return;
  try {
    const gist = e.ai_summary ?? customerMessageSegments(e.customer_message ?? "")[0] ?? e.reason;
    const identity = await loadIdentity(e.business_slug, e.chat_id, e.contact_number);
    await recordResolvedIssue({
      businessSlug: e.business_slug,
      chatId: e.chat_id,
      identity,
      escalationId: e.id,
      refCode: e.ref_code,
      text: gist.replace(/(?:EC\$|US\$|\$)\s?\d[\d,.]*/g, "[amount]"),
    });
  } catch (err) {
    console.error("[aiAgent] rememberResolvedIssue", err instanceof Error ? err.message : err);
  }
}

/**
 * Records that staff answered an escalation. `notRelayed` says why the customer
 * was not messaged (kept for the admin UI); null means a message was queued.
 * With no body only the status and that flag change (approving an earlier draft).
 */
export async function markEscalationAnswered(
  e: EscalationRow,
  input: { body: string | null; actorId: string | null; via: "whatsapp" | "admin_ui"; notRelayed: string | null }
): Promise<void> {
  const context: Record<string, unknown> = { ...e.context };
  delete context.answer_not_relayed;
  const patch: Record<string, unknown> = {
    status: "answered",
    context: input.notRelayed ? { ...context, answer_not_relayed: input.notRelayed } : context,
  };
  if (input.body !== null) {
    patch.staff_answer = input.body;
    patch.answered_by = input.actorId;
    patch.answered_via = input.via;
    patch.answered_at = new Date().toISOString();
  }
  const { error } = await agentDb().from("ai_agent_escalations").update(patch).eq("id", e.id).eq("business_slug", e.business_slug);
  if (error) throw new Error(error.message);
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
    case "send":
      // Messaging a customer has ONE policy (planCustomerSend in customerSend.ts) and one
      // implementation per entry point (staffGroup.ts, adminSend.ts). This generic action
      // handler refuses to be a third, unguarded way in.
      throw new Error("Customer sends must go through planCustomerSend()");
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
      await rememberResolvedIssue(e, input.settings);
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
