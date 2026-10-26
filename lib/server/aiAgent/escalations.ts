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
import { type CustomerMode } from "@/lib/aiAgent/customerMode";
import {
  contextFromSnapshot,
  diffSnapshots,
  nextSnapshot,
  ORDER_CHANGE_KINDS,
  type RequestSnapshot,
  snapshotFromContext,
  EMPTY_SNAPSHOT,
} from "@/lib/aiAgent/escalationUpdates";
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
  /** How many staff notices (first notice + updates) were queued for this escalation. */
  notified_seq: number;
  /** The request exactly as the latest notice showed it: the baseline for "what changed". */
  notified_snapshot: unknown;
  last_notified_at: string | null;
}

export const ESCALATION_COLUMNS =
  "id, ref_code, business_slug, chat_id, contact_number, customer_name, priority, status, reason, reason_codes, customer_message, ai_summary, proposed_reply, context, notice_message_id, staff_answer, answered_by, answered_via, answered_at, resolved_at, created_at, updated_at, notified_seq, notified_snapshot, last_notified_at";

/** A staff-answered escalation still counts as "the same issue" for an order change this long after the answer. */
export const REOPEN_WINDOW_MS = 24 * 60 * 60_000;

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

export async function loadEscalation(businessSlug: string, id: string): Promise<EscalationRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as EscalationRow | null) ?? null;
}

/** The chat's most recent escalation staff answered (but did not close) within the reopen window. */
export async function findRecentAnsweredEscalation(businessSlug: string, chatId: string, now: Date = new Date()): Promise<EscalationRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .eq("status", "answered")
    .gte("answered_at", new Date(now.getTime() - REOPEN_WINDOW_MS).toISOString())
    .order("answered_at", { ascending: false })
    .limit(1)
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
  /** The turn's individual customer messages (a batch is several); defaults to customerMessage as one. */
  segments?: string[];
  /** Approval Pilot: how far the AI's draft can be trusted (kept on the escalation; never sent anywhere). */
  draftMeta?: { ready: boolean; notes: string[]; knowledge_ids: string[]; knowledge_version: string | null } | null;
  /** What the AI could not work out, for the pilot notice ("Missing / uncertain"). */
  missing?: string[];
  /**
   * Approval Pilot: an escalation staff already answered stays closed. The customer's next message is a reply
   * to what staff approved, so it is a new request with its own AI draft, not a change to the old one.
   */
  noReopen?: boolean;
}

export interface EscalationWrite {
  escalation: EscalationRow;
  /** The turn joined an existing escalation (open, or a recently answered one that was reopened). */
  followUp: boolean;
  /** The picture of the request before this turn, and after it. */
  previous: RequestSnapshot;
  current: RequestSnapshot;
  /** An escalation staff had already answered was reopened because the customer changed the order. */
  reopened: boolean;
}

const MAX_RECORDED_UPDATES = 20;
// Each lost race (another turn wrote the escalation first) costs one more read-merge-write round.
const MAX_WRITE_ATTEMPTS = 8;

function turnFacts(input: EscalateInput) {
  return {
    segments: input.segments ?? [input.customerMessage],
    orderRequest: input.orderRequest,
    cancellation: input.reasons.includes("cancellation"),
    modelIntent: input.intent ?? null,
  };
}

/**
 * Opens an escalation, or appends to the conversation's open one. When the chat has none open but staff
 * answered one recently and the customer now CHANGES that order (adds, removes, re-quantifies, relocates,
 * cancels), the answered escalation is reopened instead — staff see the change against the same reference.
 * Anything else (a new question, a new subject) opens a new escalation.
 */
export async function createOrAppendEscalation(input: EscalateInput): Promise<EscalationWrite> {
  const db = agentDb();
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const existing = await findOpenEscalation(input.businessSlug, input.chatId);
    const answered = existing || input.noReopen ? null : await findRecentAnsweredEscalation(input.businessSlug, input.chatId);
    const anchorPrev = answered ? snapshotFromContext(answered.context) : null;
    const anchorNext = anchorPrev ? nextSnapshot(anchorPrev, turnFacts(input)) : null;
    const reopen =
      answered && anchorPrev && anchorNext && diffSnapshots(anchorPrev, anchorNext).some((c) => ORDER_CHANGE_KINDS.includes(c.kind))
        ? answered
        : null;
    const target = existing ?? reopen;
    if (target) {
      const previous = snapshotFromContext(target.context);
      const current = nextSnapshot(previous, turnFacts(input));
      const reasonCodes = Array.from(new Set([...target.reason_codes, ...input.reasons]));
      const customerMessage = appendCustomerMessage(target.customer_message, input.customerMessage);
      // Every follow-up that adds something new is logged on the escalation, so
      // an update is never lost even when no second notice is posted (Observe).
      // A re-processed batch adds nothing new and is not logged twice.
      const updates = Array.isArray(target.context.updates) ? (target.context.updates as unknown[]) : [];
      const isNew = customerMessage !== target.customer_message;
      const nextUpdates = isNew
        ? [...updates, { at: new Date().toISOString(), text: input.customerMessage.slice(0, 300) }].slice(-MAX_RECORDED_UPDATES)
        : updates;
      const snapshotContext = contextFromSnapshot(current);
      let priority = priorityFor(reasonCodes, target.priority);
      // A withdrawal after staff already acted needs eyes soon.
      if (current.cancelled && !previous.cancelled && target.answered_at && priority === "normal") priority = "high";
      const { data, error } = await db
        .from("ai_agent_escalations")
        .update({
          customer_message: customerMessage,
          reason_codes: reasonCodes,
          priority,
          // Back to "waiting for staff": a reopened escalation is unanswered again.
          ...(reopen ? { status: reopen.notice_message_id ? "notified" : "open" } : {}),
          context: {
            ...target.context,
            ...snapshotContext,
            order_request: snapshotContext.order_request ?? input.orderRequest ?? target.context.order_request ?? null,
            intent: input.intent ?? target.context.intent ?? null,
            history: input.history?.length ? input.history : target.context.history ?? [],
            updates: nextUpdates,
            ...(input.missing ? { missing: input.missing } : {}),
            ...(reopen ? { reopened_at: new Date().toISOString() } : {}),
          },
        })
        .eq("id", target.id)
        // Optimistic concurrency: the merge above was computed from this exact version of the row. If
        // anything wrote it since (another customer turn, a notice ack, a staff action) nothing is
        // updated and the loop re-reads — a concurrent turn's questions and messages are never overwritten.
        .eq("updated_at", target.updated_at)
        .select(ESCALATION_COLUMNS)
        .maybeSingle();
      if (error) {
        // 23505: another open escalation appeared while reopening this one — loop and join it instead.
        if (reopen && error.code === "23505") continue;
        throw new Error(error.message);
      }
      // Lost a race (resolved or answered concurrently): decide again from the new state.
      if (!data) continue;
      return { escalation: data as EscalationRow, followUp: true, previous, current, reopened: Boolean(reopen) };
    }

    const current = nextSnapshot(EMPTY_SNAPSHOT, turnFacts(input));
    const snapshotContext = contextFromSnapshot(current);

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
        context: {
          ...snapshotContext,
          order_request: snapshotContext.order_request ?? input.orderRequest,
          intent: input.intent ?? null,
          history: input.history ?? [],
          ...(input.draftMeta ? { draft_meta: input.draftMeta } : {}),
          // What the AI could not work out: kept so !moreinfo and the dashboard can show it without another model call.
          ...(input.missing?.length ? { missing: input.missing } : {}),
        },
        source_event_id: input.eventId,
      })
      .select(ESCALATION_COLUMNS)
      .single();
    if (!error) return { escalation: data as EscalationRow, followUp: false, previous: EMPTY_SNAPSHOT, current, reopened: false };
    // 23505 on ai_agent_escalations_one_open_idx: a concurrent message opened
    // one first — loop once and append to it instead.
    if (error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not open or append an escalation");
}

export type NoticePost =
  | { outcome: "queued"; outboxId: string; seq: number }
  | { outcome: "stale" | "duplicate" | "closed"; outboxId: null; seq: number | null };

/**
 * Queues ONE staff notice for an escalation and records what it showed, atomically
 * (post_ai_agent_escalation_notice). `expectedSeq` is the escalation's notified_seq as read: if another
 * worker posted in between the result is "stale" and nothing is written. The dedupe key is derived from
 * the sequence number, so a redelivered batch can never post the same notice twice.
 */
export async function postEscalationNotice(input: {
  escalation: EscalationRow;
  snapshot: RequestSnapshot;
  toJid: string;
  body: string;
  eventId: string | null;
  dispatchNow: boolean;
}): Promise<NoticePost> {
  const e = input.escalation;
  const { data, error } = await agentDb().rpc("post_ai_agent_escalation_notice", {
    p_business_slug: e.business_slug,
    p_escalation_id: e.id,
    p_expected_seq: e.notified_seq,
    p_snapshot: input.snapshot,
    p_chat_id: e.chat_id,
    p_to_jid: input.toJid,
    p_body: input.body,
    p_dedupe_key: `escalation:${e.id}:notice:${e.notified_seq + 1}`,
    p_event_id: input.eventId,
    p_status: input.dispatchNow ? "dispatched" : "pending",
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { outbox_id: string | null; seq: number | null; outcome: string } | undefined;
  if (!row) throw new Error("post_ai_agent_escalation_notice returned nothing");
  if (row.outcome === "queued" && row.outbox_id) return { outcome: "queued", outboxId: row.outbox_id, seq: Number(row.seq) };
  return { outcome: row.outcome as "stale" | "duplicate" | "closed", outboxId: null, seq: row.seq === null ? null : Number(row.seq) };
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

/** Sets one customer's handling mode; null returns them to the business default. Never touches takeover state. */
export async function setCustomerMode(input: {
  businessSlug: string;
  chatId: string;
  mode: CustomerMode | null;
  actorKind: ActorKind;
  actorId: string | null;
}): Promise<void> {
  const { error } = await agentDb()
    .from("ai_agent_conversations")
    .upsert(
      {
        business_slug: input.businessSlug,
        chat_id: input.chatId,
        customer_mode: input.mode,
        customer_mode_changed_by: input.actorKind === "admin" ? input.actorId : null,
        customer_mode_changed_at: new Date().toISOString(),
      },
      { onConflict: "business_slug,chat_id" }
    );
  if (error) throw new Error(error.message);
  await audit(input.businessSlug, input.actorKind, input.actorId, "conversation.customer_mode", { type: "conversation", id: input.chatId }, {
    mode: input.mode ?? "default",
  });
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
