// Server-only: THE decision engine entry point. Every message the bridge
// forwards goes through processBridgeMessage(); the admin test console goes
// through simulateMessage(), which runs the identical gate → context → model →
// resolveDecision() pipeline with no writes and no sends. All decision rules
// live in lib/aiAgent/engine.ts — this file only loads data, persists results,
// and turns decisions into outbox items.
//
// Idempotency: the (business_slug, whatsapp_message_id) unique key on
// ai_agent_events is claimed BEFORE any model call or side effect. A retried
// request gets the stored outcome back with every outbox item marked
// send: false, so a bridge retry can never double-send or double-escalate.

import {
  AgentDecision,
  AgentSettings,
  CUSTOMER_MESSAGE_SEPARATOR,
  canSendStaffNotice,
  detectSafeguards,
  evaluateGate,
  GateResult,
  HOLDING_REPLY_GENERAL,
  HOLDING_REPLY_ORDER,
  isValidBusinessSlug,
  ModelProposal,
  outboxAllowed,
  OrderRequestDraft,
  priorityFor,
  requiredConfidence,
  resolveDecision,
  Resolution,
  needsFirstNotice,
  staffNoticeSkipReason,
} from "@/lib/aiAgent/engine";
import { normalizeBusinessSlug } from "@/lib/businessSlug";
import {
  BATCHED_DECISION,
  BATCHED_REASON,
  batchingActive,
  buildCustomerTurn,
  CustomerTurn,
  singleMessageTurn,
} from "@/lib/aiAgent/batching";
import { ChatIdentity } from "@/lib/aiAgent/identity";
import { historyLinesForStaff, MemoryBrief, validateMemoryFacts } from "@/lib/aiAgent/memory";
import {
  loadCustomerContext,
  loadOpenOrderRequest,
  OpenOrderRequest,
} from "@/lib/server/aiAgent/context";
import {
  BatchRow,
  claimBatches,
  completeBatch,
  enqueueBatchMessage,
  loadBatchMessages,
  MAX_BATCH_ATTEMPTS,
  newWorkerId,
  purgeFinishedBatches,
  releaseBatch,
} from "@/lib/server/aiAgent/batches";
import { agentDb, audit, KnowledgeRow, loadActiveKnowledge, loadSettings } from "@/lib/server/aiAgent/db";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import { saveCustomerFacts } from "@/lib/server/aiAgent/memory";
import {
  canSend,
  createOrAppendEscalation,
  originalEscalationInput,
  priorStaffNotices,
  findOpenEscalation,
  setConversationControl,
  staffNoticeFor,
} from "@/lib/server/aiAgent/escalations";
import { proposeReply } from "@/lib/server/aiAgent/model";
import { processStaffGroupMessage, reportStaffFailure } from "@/lib/server/aiAgent/staffGroup";
import {
  BridgeOutboxItem,
  enqueue,
  isAgentEcho,
  OutboxInsert,
  outboxForEvent,
  toBridgeItem,
} from "@/lib/server/aiAgent/outbox";

const STALE_PROCESSING_MS = 2 * 60_000;

export interface BridgeMessageInput {
  businessSlug: string;
  whatsappMessageId: string;
  chatId: string;
  contactNumber: string | null;
  fromMe: boolean;
  text: string;
  hasMedia: boolean;
  quotedMessageId: string | null;
  senderJid: string | null;
  /** Phone number WhatsApp reported for an @lid group participant (Baileys participantPn); null when unknown. */
  senderPhone?: string | null;
  timestamp: string | null;
}

export interface BridgeMessageResponse {
  eventId: string | null;
  status: "done" | "duplicate" | "in_progress" | "ignored" | "error";
  decision: AgentDecision | null;
  reasons: string[];
  outbox: BridgeOutboxItem[];
}

const ignored = (reason: string): BridgeMessageResponse => ({
  eventId: null,
  status: "ignored",
  decision: "NO_REPLY",
  reasons: [reason],
  outbox: [],
});

// ── Live path ────────────────────────────────────────────────────────────────

export async function processBridgeMessage(raw: BridgeMessageInput): Promise<BridgeMessageResponse> {
  const startedAt = Date.now();
  const input = { ...raw, businessSlug: normalizeBusinessSlug(raw.businessSlug) };

  // Malformed, unconfigured (no settings row = default OFF) and disabled
  // businesses are dropped without writing anything.
  if (!isValidBusinessSlug(input.businessSlug)) return ignored("invalid_business");
  const settings = await loadSettings(input.businessSlug);
  if (!settings?.enabled) return ignored("agent_disabled");

  const isStaffGroup = Boolean(settings.staff_group_jid) && input.chatId === settings.staff_group_jid;
  // Our own sends echoed back by the bridge are dropped before anything else:
  // an echoed staff notice must never be read as a staff answer, and an echoed
  // AI reply must never look like a human taking over.
  if ((isStaffGroup || input.fromMe) && (await isAgentEcho(input.businessSlug, input.chatId, input.whatsappMessageId, input.text))) {
    await recordIgnored(input, isStaffGroup ? "staff_group" : "staff_outbound", "agent_echo", settings);
    return ignored("agent_echo");
  }
  const kind = isStaffGroup ? "staff_group" : input.fromMe ? "staff_outbound" : "customer_inbound";

  const claim = await claimEvent(input, kind, settings);
  let eventId: string;
  if ("response" in claim) {
    // Enqueueing into a batch is idempotent, so a customer message whose first
    // delivery died before reaching its batch is simply resumed on retry.
    if (!(claim.resumable && kind === "customer_inbound" && batchingActive(settings))) return claim.response;
    eventId = claim.response.eventId!;
  } else {
    eventId = claim.eventId;
  }

  try {
    let outcome: Outcome;
    if (isStaffGroup) {
      const staff = await processStaffGroupMessage({
        settings,
        text: input.text,
        quotedMessageId: input.quotedMessageId,
        senderJid: input.senderJid,
        senderPhone: input.senderPhone ?? null,
        eventId,
        whatsappMessageId: input.whatsappMessageId,
        timestamp: input.timestamp,
      });
      outcome = {
        decision: "NO_REPLY",
        reasons: [`staff_group_${staff.outcome}`],
        outbox: staff.outbox,
        escalationId: staff.escalationId,
      };
    } else if (input.fromMe) {
      outcome = await handleManualStaffMessage(input, settings);
    } else if (batchingActive(settings)) {
      outcome = await handleBatchedCustomerMessage(input, settings, eventId);
    } else {
      outcome = await handleCustomerTurn(
        singleMessageTurn({
          whatsappMessageId: input.whatsappMessageId,
          eventId,
          text: input.text,
          hasMedia: input.hasMedia,
          timestamp: input.timestamp,
        }),
        {
          businessSlug: input.businessSlug,
          chatId: input.chatId,
          contactNumber: input.contactNumber,
          settings,
          dedupeBase: eventId,
        }
      );
    }

    // Last line of defence: whatever the handlers produced, only kinds the
    // business's mode permits are enqueued. Observe mode can never produce a
    // customer-bound item, even if a handler regresses.
    const allowed = outcome.outbox.filter((o) => outboxAllowed(settings, o));
    if (allowed.length !== outcome.outbox.length) outcome.reasons = [...outcome.reasons, "outbox_blocked_by_mode"];
    const rows = await enqueue(
      allowed.map((o) => ({ ...o, eventId })),
      true
    );
    await finishEvent(eventId, startedAt, outcome);
    // A message waiting in a batch has no decision yet: the batch's worker
    // decides it, and the response is "nothing to send" (no bridge change).
    if (outcome.batched) {
      return { eventId, status: "done", decision: null, reasons: outcome.reasons, outbox: [] };
    }
    if (!isStaffGroup) {
      await agentDb()
        .from("ai_agent_conversations")
        .upsert(
          {
            business_slug: input.businessSlug,
            chat_id: input.chatId,
            contact_number: input.contactNumber,
            last_decision: outcome.decision,
            last_event_at: new Date().toISOString(),
          },
          { onConflict: "business_slug,chat_id" }
        );
    }
    return {
      eventId,
      status: "done",
      decision: outcome.decision,
      reasons: outcome.reasons,
      outbox: rows.map((r) => toBridgeItem(r, true)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[aiAgent] processBridgeMessage failed", message);
    await agentDb()
      .from("ai_agent_events")
      .update({ status: "error", error: message.slice(0, 1000), finished_at: new Date().toISOString() })
      .eq("id", eventId);
    // A staff answer that died part-way must not vanish: mark it failed (retryable only when no
    // customer message may have gone out) and tell the staff group / dashboard.
    if (isStaffGroup) await reportStaffFailure({ settings, eventId, error: err });
    // Fail closed: nothing is sent; the event row records what went wrong.
    return { eventId, status: "error", decision: null, reasons: ["internal_error"], outbox: [] };
  }
}

// An enabled business's message that was dropped before a decision: leave an
// 'ignored' event so Activity shows it arrived and why nothing happened.
// Best effort; disabled/unknown businesses are still never written.
async function recordIgnored(input: BridgeMessageInput, kind: string, reason: string, settings: AgentSettings): Promise<void> {
  const { error } = await agentDb().from("ai_agent_events").insert({
    business_slug: input.businessSlug,
    chat_id: input.chatId,
    whatsapp_message_id: input.whatsappMessageId,
    kind: "ignored",
    status: "done",
    message_excerpt: input.text.slice(0, 500) || null,
    decision: "NO_REPLY",
    reason_codes: [reason, `source_${kind}`],
    mode: settings.mode,
    autonomy: settings.autonomy,
    finished_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") console.error("[aiAgent] recordIgnored", error.message);
}

interface Outcome {
  decision: AgentDecision;
  reasons: string[];
  outbox: OutboxInsert[];
  escalationId?: string | null;
  confidence?: number | null;
  proposedReply?: string | null;
  model?: string | null;
  knowledgeIds?: string[];
  error?: string | null;
  /** The message was queued into this batch; a worker decides it later. */
  batched?: { batchId: string };
}

async function claimEvent(
  input: BridgeMessageInput,
  kind: string,
  settings: AgentSettings
): Promise<{ eventId: string } | { response: BridgeMessageResponse; resumable: boolean }> {
  const db = agentDb();
  const { data, error } = await db
    .from("ai_agent_events")
    .insert({
      business_slug: input.businessSlug,
      chat_id: input.chatId,
      whatsapp_message_id: input.whatsappMessageId,
      kind,
      message_excerpt: input.text.slice(0, 500) || null,
      mode: settings.mode,
      autonomy: settings.autonomy,
    })
    .select("id")
    .single();
  if (!error) return { eventId: data.id };
  if (error.code !== "23505") throw new Error(error.message);

  const { data: existing, error: loadError } = await db
    .from("ai_agent_events")
    .select("id, status, decision, reason_codes, created_at")
    .eq("business_slug", input.businessSlug)
    .eq("whatsapp_message_id", input.whatsappMessageId)
    .single();
  if (loadError) throw new Error(loadError.message);

  const processing =
    existing.status === "processing" && Date.now() - new Date(existing.created_at).getTime() < STALE_PROCESSING_MS;
  const items = await outboxForEvent(existing.id);
  return {
    resumable: existing.status === "processing",
    response: {
      eventId: existing.id,
      status: processing ? "in_progress" : "duplicate",
      decision: existing.decision === BATCHED_DECISION ? null : existing.decision,
      reasons: existing.reason_codes ?? [],
      outbox: items.map((r) => toBridgeItem(r, false)),
    },
  };
}

async function finishEvent(eventId: string, startedAt: number, outcome: Outcome, batchId?: string): Promise<void> {
  const { error } = await agentDb()
    .from("ai_agent_events")
    .update({
      status: "done",
      decision: outcome.batched ? BATCHED_DECISION : outcome.decision,
      batch_id: outcome.batched?.batchId ?? batchId ?? null,
      reason_codes: outcome.reasons,
      confidence: outcome.confidence ?? null,
      proposed_reply: outcome.proposedReply ?? null,
      model: outcome.model ?? null,
      knowledge_ids: outcome.knowledgeIds ?? [],
      escalation_id: outcome.escalationId ?? null,
      error: outcome.error ?? null,
      latency_ms: Date.now() - startedAt,
      finished_at: new Date().toISOString(),
    })
    .eq("id", eventId);
  if (error) throw new Error(error.message);
}

// A manual message from the business phone/inbox = a human is handling this
// chat. Pause the agent there for auto_takeover_minutes. (Agent-originated
// sends are never forwarded by the bridge — see the contract.)
async function handleManualStaffMessage(input: BridgeMessageInput, settings: AgentSettings): Promise<Outcome> {
  if (settings.auto_takeover_minutes > 0 && !input.chatId.endsWith("@g.us")) {
    await setConversationControl({
      businessSlug: input.businessSlug,
      chatId: input.chatId,
      control: "human",
      minutes: settings.auto_takeover_minutes,
      reason: "staff_message",
      actorKind: "system",
      actorId: null,
    });
  }
  return { decision: "HUMAN", reasons: ["staff_message"], outbox: [] };
}

async function autoRepliesLastHour(businessSlug: string, chatId: string): Promise<number> {
  const { count, error } = await agentDb()
    .from("ai_agent_outbox")
    .select("id", { count: "exact", head: true })
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .eq("kind", "customer_reply")
    .in("status", ["dispatched", "sent"])
    .gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

interface Pipeline {
  gate: GateResult;
  /** Diagnostic reason codes about how the contact was identified. */
  identityNotes: string[];
  identity: ChatIdentity | null;
  safeguards: string[];
  resolution: Resolution | null;
  proposal: ModelProposal | null;
  model: string | null;
  modelError: string | null;
  knowledge: KnowledgeRow[];
  customerName: string;
  /** Verified-history / customer-said lines for the staff notice (empty when nothing is on record). */
  history: string[];
  memory: MemoryBrief | null;
  openOrder: OpenOrderRequest | null;
  hasOpenEscalation: boolean;
}

/**
 * Shared by the live path and the test console. `forceGatePass` (console only)
 * evaluates the policy as if the gate had passed, while still reporting the
 * real gate result. `text` is the customer's words (safeguards run on all of
 * them); `transcript` is the same turn with per-message timestamps for the
 * model, and defaults to `text`.
 */
async function runPipeline(args: {
  businessSlug: string;
  chatId: string | null;
  contactNumber: string | null;
  text: string;
  transcript?: string;
  hasMedia: boolean;
  /** The turn's own messages: left out of the "recent conversation" slice. */
  excludeMessageIds: string[];
  settings: AgentSettings | null;
  forceGatePass: boolean;
}): Promise<Pipeline> {
  const { businessSlug, chatId, settings } = args;
  const { matchedViaAlias, identity, ...gateData } = chatId
    ? await loadGateData(businessSlug, chatId, args.contactNumber, settings)
    : { identity: null, contactRule: null, unresolvedLid: false, matchedViaAlias: false, conversation: null, staffActiveAt: null };
  const gate = evaluateGate({
    businessSlug,
    chatId: chatId ?? "test-console@s.whatsapp.net",
    fromMe: false,
    text: args.text,
    hasMedia: args.hasMedia,
    settings,
    ...gateData,
    now: new Date(),
  });

  const empty: Pipeline = {
    gate,
    identityNotes: matchedViaAlias ? ["contact_matched_via_linked_identity"] : [],
    identity,
    safeguards: [],
    resolution: null,
    proposal: null,
    model: null,
    modelError: null,
    knowledge: [],
    customerName: chatId ?? "Test customer",
    history: [],
    memory: null,
    openOrder: null,
    hasOpenEscalation: false,
  };
  if (!gate.pass && !args.forceGatePass) return empty;
  if (!args.text.trim()) return empty;

  const [knowledge, context, openOrder, openEscalation, recentReplies] = await Promise.all([
    loadActiveKnowledge(businessSlug),
    chatId && identity
      ? loadCustomerContext(businessSlug, chatId, args.contactNumber, args.excludeMessageIds, identity, args.text)
      : Promise.resolve(null),
    chatId ? loadOpenOrderRequest(businessSlug, chatId) : Promise.resolve(null),
    chatId ? findOpenEscalation(businessSlug, chatId) : Promise.resolve(null),
    chatId ? autoRepliesLastHour(businessSlug, chatId) : Promise.resolve(0),
  ]);

  const safeguards = detectSafeguards(args.text);
  const priorOrder: OrderRequestDraft | null = openOrder
    ? {
        items: openOrder.items ?? [],
        delivery_address: openOrder.delivery_address,
        delivery_preference: openOrder.delivery_preference,
        notes: openOrder.notes,
      }
    : null;

  // "Same as last time" is resolved from VERIFIED orders (lib/aiAgent/memory.ts).
  // When the answer is a question or a hand-off the model has nothing to add.
  const repeat = context?.memory.repeat;
  const repeatDecided = repeat?.kind === "ambiguous" || repeat?.kind === "no_history" || repeat?.kind === "unclear";

  // Injection attempts never reach the model; an open escalation means staff
  // own the conversation, so there is nothing for the model to draft.
  const skipModel = safeguards.includes("prompt_injection") || Boolean(openEscalation) || repeatDecided;
  const modelResult = skipModel
    ? { proposal: null, model: null, error: null }
    : await proposeReply({
        businessSlug,
        messageText: args.transcript ?? args.text,
        knowledge,
        context,
        pendingOrder: priorOrder,
      });

  const resolution = resolveDecision({
    autonomy: settings?.autonomy ?? 0,
    safeguardCodes: safeguards,
    proposal: modelResult.proposal,
    activeKnowledge: knowledge.map((k) => ({ id: k.id, content: k.content })),
    priorOrderRequest: priorOrder,
    autoRepliesLastHour: recentReplies,
    maxAutoRepliesPerHour: settings?.max_auto_replies_per_hour ?? 0,
    hasOpenEscalation: Boolean(openEscalation),
    repeatOrder: repeat,
  });

  return {
    gate,
    identityNotes: empty.identityNotes,
    identity,
    safeguards,
    resolution,
    proposal: modelResult.proposal,
    model: modelResult.model,
    modelError: modelResult.error,
    knowledge,
    customerName: context?.customerName ?? empty.customerName,
    history: context ? historyLinesForStaff(context.memory) : [],
    memory: context?.memory ?? null,
    openOrder,
    hasOpenEscalation: Boolean(openEscalation),
  };
}

interface TurnContext {
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  settings: AgentSettings;
  /** Prefix of every outbox dedupe key: the event id (single message) or `batch:<id>` (batched turn). */
  dedupeBase: string;
}

/**
 * ONE customer turn → one decision, at most one escalation, one staff notice.
 * A turn is a single live message (batching off) or every message of a batch.
 */
async function handleCustomerTurn(turn: CustomerTurn, ctx: TurnContext): Promise<Outcome> {
  const { settings, businessSlug, chatId } = ctx;
  const eventId = turn.primaryEventId;
  const p = await runPipeline({
    businessSlug,
    chatId,
    contactNumber: ctx.contactNumber,
    text: turn.text,
    transcript: turn.transcript,
    hasMedia: turn.hasMedia,
    excludeMessageIds: turn.whatsappMessageIds,
    settings,
    forceGatePass: false,
  });
  const sendable = canSend(settings);

  if (!p.gate.pass && p.gate.decision !== "ESCALATE") {
    return { decision: p.gate.decision, reasons: p.gate.reasons, outbox: [] };
  }

  const r = p.resolution;
  const reasons = [...(p.gate.pass ? r!.reasons : p.gate.reasons), ...p.identityNotes];
  const decision: AgentDecision = p.gate.pass ? r!.decision : "ESCALATE";
  const common = {
    confidence: r?.confidence ?? null,
    proposedReply: r?.reply ?? r?.draftReply ?? null,
    model: p.model,
    knowledgeIds: p.proposal?.knowledge_ids.filter((id) => p.knowledge.some((k) => k.id === id)) ?? [],
    error: p.modelError,
  };

  // Long-term memory: only what the customer explicitly said, in their own
  // words (validated against the turn), and only when the admin enabled capture.
  if (settings.customer_memory_enabled && p.identity && p.proposal && p.safeguards.length === 0) {
    const { accepted, rejected } = validateMemoryFacts(p.proposal.memory_facts, turn.text);
    if (rejected.length > 0) reasons.push("memory_fact_rejected");
    if (accepted.length > 0) {
      try {
        const saved = await saveCustomerFacts({
          businessSlug,
          chatId,
          identity: p.identity,
          messageId: turn.whatsappMessageIds[turn.whatsappMessageIds.length - 1] ?? null,
          facts: accepted,
        });
        if (saved > 0) reasons.push("memory_saved");
      } catch (err) {
        // Memory is an extra: a failure here must never block the decision.
        console.error("[aiAgent] saveCustomerFacts", err instanceof Error ? err.message : err);
      }
    }
  }

  // Persist the (never-confirmed) order request as it is collected.
  let orderRequestId: string | null = p.openOrder?.id ?? null;
  if (r?.orderRequest) {
    orderRequestId = await saveOrderRequest(
      { businessSlug, chatId, contactNumber: ctx.contactNumber },
      p.openOrder,
      r.orderRequest,
      r.orderComplete
    );
  }

  if (decision === "ESCALATE") {
    const customerMessage = turn.segments.join(CUSTOMER_MESSAGE_SEPARATOR) || "(media message without text)";
    const escalateInput = {
      businessSlug,
      chatId,
      contactNumber: ctx.contactNumber,
      customerName: p.customerName,
      reasons,
      priority: r?.priority ?? priorityFor(reasons),
      customerMessage,
      draftReply: r?.draftReply ?? null,
      summary: p.proposal?.summary ?? null,
      intent: p.proposal?.intent ?? null,
      orderRequest: r?.orderRequest ?? null,
      history: p.history,
      eventId,
    };
    const { escalation, followUp } = await createOrAppendEscalation(escalateInput);
    if (orderRequestId && r?.orderComplete) {
      await agentDb()
        .from("ai_agent_order_requests")
        .update({ escalation_id: escalation.id })
        .eq("id", orderRequestId);
    }

    const outbox: OutboxInsert[] = [];
    // The staff notice is the only thing Observe mode may send (when its
    // staff_notices_enabled flag is on). A follow-up on an already-open
    // escalation updates the record but never posts a second notice in Observe.
    // An open escalation whose notice never went out (e.g. notices were off
    // when it opened) is still owed its first notice, in the original format.
    const prior = followUp ? await priorStaffNotices(businessSlug, escalation.id) : [];
    const skip = staffNoticeSkipReason(settings, followUp, prior);
    const firstNotice = !followUp || needsFirstNotice(followUp, prior);
    if (!skip && settings.staff_group_jid) {
      outbox.push({
        businessSlug,
        chatId,
        kind: "staff_notice",
        toJid: settings.staff_group_jid,
        body: staffNoticeFor(
          escalation,
          firstNotice && followUp ? originalEscalationInput(escalation, escalateInput) : escalateInput,
          !firstNotice,
          settings.mode !== "assisted"
        ),
        // A late first notice is keyed per escalation (and attempt number) so two
        // concurrent messages cannot both queue it.
        dedupeKey: followUp ? `escalation:${escalation.id}:staff_notice:${prior.length}` : `${ctx.dedupeBase}:staff_notice`,
        escalationId: escalation.id,
      });
    } else if (skip) {
      reasons.push(`staff_notice_skipped_${skip}`);
      // First notice for this escalation never went out: say why in the admin UI.
      if (firstNotice) {
        await agentDb()
          .from("ai_agent_escalations")
          .update({ context: { ...escalation.context, notice_skipped: skip } })
          .eq("id", escalation.id)
          .eq("business_slug", businessSlug);
      }
    }
    if (sendable && settings.send_holding_reply && !followUp) {
      outbox.push({
        businessSlug,
        chatId,
        kind: "holding_reply",
        toJid: chatId,
        body: r?.orderComplete ? HOLDING_REPLY_ORDER : HOLDING_REPLY_GENERAL,
        dedupeKey: `${ctx.dedupeBase}:holding_reply`,
        escalationId: escalation.id,
      });
    }
    await audit(businessSlug, "system", null, followUp ? "escalation.append" : "escalation.open", {
      type: "escalation",
      id: escalation.id,
    }, { ref_code: escalation.ref_code, reasons, messages: turn.messages.length });
    return { ...common, decision, reasons, outbox, escalationId: escalation.id };
  }

  // REPLY / ASK
  const outbox: OutboxInsert[] =
    sendable && r?.reply
      ? [
          {
            businessSlug,
            chatId,
            kind: "customer_reply",
            toJid: chatId,
            body: r.reply,
            dedupeKey: `${ctx.dedupeBase}:customer_reply`,
          },
        ]
      : [];
  return { ...common, decision, reasons, outbox };
}

// ── Batching ─────────────────────────────────────────────────────────────────

/**
 * Live path with batching on: an eligible customer message is stored in the
 * chat's batch (nothing is decided or sent now); anything the gate would stop
 * anyway is answered immediately, exactly as without batching.
 */
async function handleBatchedCustomerMessage(input: BridgeMessageInput, settings: AgentSettings, eventId: string): Promise<Outcome> {
  const gateData = await loadGateData(input.businessSlug, input.chatId, input.contactNumber, settings);
  // Media-only messages are eligible: the customer may follow with the words.
  const gate = evaluateGate({
    businessSlug: input.businessSlug,
    chatId: input.chatId,
    fromMe: false,
    text: input.text.trim() || (input.hasMedia ? "(media)" : ""),
    hasMedia: input.hasMedia,
    settings,
    ...gateData,
    now: new Date(),
  });
  if (!gate.pass) return { decision: gate.decision, reasons: gate.reasons, outbox: [] };

  const queued = await enqueueBatchMessage({
    businessSlug: input.businessSlug,
    chatId: input.chatId,
    contactNumber: input.contactNumber,
    whatsappMessageId: input.whatsappMessageId,
    eventId,
    text: input.text,
    hasMedia: input.hasMedia,
    messageAt: input.timestamp,
  });
  return { decision: "NO_REPLY", reasons: [BATCHED_REASON], outbox: [], batched: { batchId: queued.batchId } };
}

const RETRY_BACKOFF_SECONDS = 30;

/** Settles the events of every message in a processed batch. */
async function finishBatchEvents(turn: CustomerTurn, batchId: string, startedAt: number, outcome: Outcome): Promise<void> {
  const primary = turn.primaryEventId;
  if (primary) await finishEvent(primary, startedAt, outcome, batchId);
  const others = turn.eventIds.filter((id) => id !== primary);
  if (others.length === 0) return;
  const { error } = await agentDb()
    .from("ai_agent_events")
    .update({
      status: "done",
      decision: outcome.decision,
      reason_codes: [...outcome.reasons, `batched_with_${turn.messages.length}`],
      escalation_id: outcome.escalationId ?? null,
      batch_id: batchId,
      finished_at: new Date().toISOString(),
    })
    .in("id", others);
  if (error) throw new Error(error.message);
}

async function markBatchEventsFailed(eventIds: string[], batchId: string, message: string): Promise<void> {
  if (eventIds.length === 0) return;
  await agentDb()
    .from("ai_agent_events")
    .update({ status: "error", error: message.slice(0, 1000), batch_id: batchId, finished_at: new Date().toISOString() })
    .in("id", eventIds);
}

/**
 * Decides ONE claimed batch. Everything here is safe to run twice (a worker
 * that crashed after a side effect, or lost its lease): events are settled by
 * id, outbox rows by dedupe key, escalations by the one-open-per-chat index.
 */
async function processClaimedBatch(batch: BatchRow, worker: string): Promise<"done" | "retry" | "failed" | "cancelled"> {
  const startedAt = Date.now();
  let eventIds: string[] = [];
  try {
    const settings = await loadSettings(batch.business_slug);
    const messages = await loadBatchMessages(batch.id);
    const turn = buildCustomerTurn(messages);
    eventIds = turn.eventIds;

    // Settings are re-read now: a business switched off while the batch waited sends nothing.
    if (!settings?.enabled || messages.length === 0) {
      const outcome: Outcome = { decision: "NO_REPLY", reasons: [settings?.enabled ? "empty_batch" : "agent_disabled"], outbox: [] };
      await finishBatchEvents(turn, batch.id, startedAt, outcome);
      await completeBatch(batch.id, worker, "cancelled", outcome.decision);
      return "cancelled";
    }

    const outcome = await handleCustomerTurn(turn, {
      businessSlug: batch.business_slug,
      chatId: batch.chat_id,
      contactNumber: batch.contact_number,
      settings,
      dedupeBase: `batch:${batch.id}`,
    });

    // Same last line of defence as the live path: only kinds the business's
    // mode permits are enqueued (Observe: a staff notice to the staff group, nothing else).
    const allowed = outcome.outbox.filter((o) => outboxAllowed(settings, o));
    if (allowed.length !== outcome.outbox.length) outcome.reasons = [...outcome.reasons, "outbox_blocked_by_mode"];
    // 'pending': the bridge collects these from its outbox poll (claim_ai_agent_outbox,
    // which re-checks the mode in SQL); there is no request to answer.
    await enqueue(allowed.map((o) => ({ ...o, eventId: turn.primaryEventId })), false);

    await finishBatchEvents(turn, batch.id, startedAt, outcome);
    await agentDb()
      .from("ai_agent_conversations")
      .upsert(
        {
          business_slug: batch.business_slug,
          chat_id: batch.chat_id,
          contact_number: batch.contact_number,
          last_decision: outcome.decision,
          last_event_at: new Date().toISOString(),
        },
        { onConflict: "business_slug,chat_id" }
      );
    const owned = await completeBatch(batch.id, worker, "done", outcome.decision);
    if (!owned) console.warn("[aiAgent] batch lease was taken over before completion", batch.id);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[aiAgent] processClaimedBatch failed", batch.id, message);
    if (batch.attempts >= MAX_BATCH_ATTEMPTS) {
      // Out of attempts: fail closed. Nothing was sent for this batch.
      await markBatchEventsFailed(eventIds, batch.id, message).catch(() => {});
      await completeBatch(batch.id, worker, "failed", null, message).catch(() => {});
      return "failed";
    }
    await releaseBatch(batch.id, worker, message, RETRY_BACKOFF_SECONDS * batch.attempts).catch(() => {});
    return "retry";
  }
}

export interface BatchRunSummary {
  claimed: number;
  done: number;
  retry: number;
  failed: number;
  cancelled: number;
}

/**
 * The scheduler's unit of work. Safe to call from any number of places at
 * once (cron endpoint, bridge outbox poll, forwarded messages): Postgres hands
 * each due batch to exactly one caller, and a crashed caller's batch is
 * re-offered when its lease expires. `budgetMs` bounds one invocation.
 */
export async function processDueBatches(options: { budgetMs?: number; concurrency?: number } = {}): Promise<BatchRunSummary> {
  const worker = newWorkerId();
  const deadline = Date.now() + (options.budgetMs ?? 40_000);
  const summary: BatchRunSummary = { claimed: 0, done: 0, retry: 0, failed: 0, cancelled: 0 };
  while (Date.now() < deadline) {
    const batches = await claimBatches(options.concurrency ?? 3, worker);
    if (batches.length === 0) break;
    summary.claimed += batches.length;
    const results = await Promise.all(batches.map((b) => processClaimedBatch(b, worker)));
    for (const r of results) summary[r] += 1;
  }
  if (summary.claimed === 0 && Math.random() < 0.02) await purgeFinishedBatches();
  return summary;
}

async function saveOrderRequest(
  input: Pick<BridgeMessageInput, "businessSlug" | "chatId" | "contactNumber">,
  existing: OpenOrderRequest | null,
  draft: OrderRequestDraft,
  complete: boolean
): Promise<string> {
  const db = agentDb();
  const fields = {
    items: draft.items,
    delivery_address: draft.delivery_address,
    delivery_preference: draft.delivery_preference,
    notes: draft.notes,
  };
  if (existing) {
    const { error } = await db
      .from("ai_agent_order_requests")
      .update({ ...fields, status: complete ? "pending_approval" : existing.status })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return existing.id;
  }
  const { data, error } = await db
    .from("ai_agent_order_requests")
    .insert({
      ...fields,
      business_slug: input.businessSlug,
      chat_id: input.chatId,
      contact_number: input.contactNumber,
      status: complete ? "pending_approval" : "collecting",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

// ── Test console (dry run: no writes, no sends) ──────────────────────────────

export interface SimulationResult {
  gate: { pass: boolean; decision: AgentDecision | null; reasons: string[] };
  decision: AgentDecision;
  reasons: string[];
  reply: string | null;
  draftReply: string | null;
  confidence: number | null;
  requiredConfidence: number | null;
  safeguards: string[];
  knowledgeUsed: { id: string; title: string }[];
  orderRequest: OrderRequestDraft | null;
  orderComplete: boolean;
  wouldSendToCustomer: boolean;
  wouldNotifyStaff: boolean;
  modelError: string | null;
  mode: string | null;
}

export async function simulateMessage(input: {
  businessSlug: string;
  chatId: string | null;
  text: string;
}): Promise<SimulationResult> {
  const settings = await loadSettings(input.businessSlug);
  let contactNumber: string | null = null;
  if (input.chatId) {
    const { data } = await agentDb()
      .from("whatsapp_messages")
      .select("contact_number")
      .eq("business_slug", input.businessSlug)
      .eq("chat_id", input.chatId)
      .not("contact_number", "is", null)
      .limit(1)
      .maybeSingle();
    contactNumber = data?.contact_number ?? null;
  }

  const p = await runPipeline({
    businessSlug: input.businessSlug,
    chatId: input.chatId,
    contactNumber,
    text: input.text,
    hasMedia: false,
    excludeMessageIds: [],
    settings,
    forceGatePass: true,
  });
  const r = p.resolution;
  const live = p.gate.pass;
  const decision: AgentDecision = r?.decision ?? (p.gate.pass ? "NO_REPLY" : p.gate.decision);
  const sendable = canSend(settings);

  return {
    gate: p.gate.pass
      ? { pass: true, decision: null, reasons: [] }
      : { pass: false, decision: p.gate.decision, reasons: p.gate.reasons },
    decision,
    reasons: r?.reasons ?? [],
    reply: r?.reply ?? null,
    draftReply: r?.draftReply ?? null,
    confidence: r?.confidence ?? null,
    requiredConfidence: settings ? requiredConfidence(settings.autonomy) : null,
    safeguards: p.safeguards,
    knowledgeUsed: p.knowledge
      .filter((k) => p.proposal?.knowledge_ids.includes(k.id))
      .map((k) => ({ id: k.id, title: k.title })),
    orderRequest: r?.orderRequest ?? null,
    orderComplete: r?.orderComplete ?? false,
    wouldSendToCustomer: live && sendable && (decision === "REPLY" || decision === "ASK" || (decision === "ESCALATE" && Boolean(settings?.send_holding_reply) && !p.hasOpenEscalation)),
    wouldNotifyStaff: live && decision === "ESCALATE" && !p.hasOpenEscalation && canSendStaffNotice(settings),
    modelError: p.modelError,
    mode: settings?.mode ?? null,
  };
}
