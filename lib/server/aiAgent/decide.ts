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
  priorNoticeHold,
  categorizeRequest,
  customerMessageSegments,
  missingOrderFields,
  staffNoticeSkipReason,
} from "@/lib/aiAgent/engine";
import { assessDraftReadiness, buildPilotNotice } from "@/lib/aiAgent/pilot";
import { type CustomerMode, customerModeAllowsKind, effectiveCustomerMode, modeAdjustedDecision } from "@/lib/aiAgent/customerMode";
import {
  buildShadowRecord,
  historicalKey,
  knowledgeVersion,
  type ShadowUsage,
  shadowCaptureSkip,
  simulationKey,
  SIMULATIONS_PER_HOUR,
} from "@/lib/aiAgent/evaluation";
import {
  buildStaffUpdate,
  diffSnapshots,
  groundOrderDraft,
  isCancellation,
  isTrivialTurn,
  isUrgentChange,
  parseSnapshot,
  type RequestSnapshot,
  snapshotFromContext,
} from "@/lib/aiAgent/escalationUpdates";
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
import {
  countRecentSimulations,
  findHistoricalForEvents,
  findShadowByKey,
  purgeShadowResults,
  saveShadowRecord,
  shadowCaptureEnabled,
} from "@/lib/server/aiAgent/evaluation";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import { saveCustomerFacts } from "@/lib/server/aiAgent/memory";
import { draftMetaFrom, ensureAiDraft, purgePilotDrafts } from "@/lib/server/aiAgent/pilot";
import { maybeExtractPassive } from "@/lib/server/aiAgent/teach";
import {
  canSend,
  createOrAppendEscalation,
  type EscalateInput,
  type EscalationRow,
  type EscalationWrite,
  findOpenEscalation,
  findRecentAnsweredEscalation,
  loadEscalation,
  originalEscalationInput,
  postEscalationNotice,
  priorStaffNotices,
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
  type OutboxRow,
  outboxForEvent,
  outboxRowById,
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
        fromMe: input.fromMe,
        eventId,
        whatsappMessageId: input.whatsappMessageId,
        timestamp: input.timestamp,
      });
      outcome = {
        decision: "NO_REPLY",
        reasons: [`staff_group_${staff.outcome}`],
        outbox: staff.outbox,
        queued: staff.queued,
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
          dispatchNow: true,
        }
      );
    }

    // Last line of defence: whatever the handlers produced, only kinds the
    // business's mode permits are enqueued. Observe mode can never produce a
    // customer-bound item, even if a handler regresses.
    const allowed = outcome.outbox.filter((o) => outboxAllowed(settings, o));
    if (allowed.length !== outcome.outbox.length) outcome.reasons = [...outcome.reasons, "outbox_blocked_by_mode"];
    const rows = [
      ...(await enqueue(
        allowed.map((o) => ({ ...o, eventId })),
        true
      )),
      // Staff notices posted by handleCustomerTurn through post_ai_agent_escalation_notice are already 'dispatched'.
      ...(outcome.queued ?? []),
    ];
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
  /** Outbox rows already created inside the turn (staff notices), returned to the bridge as they are. */
  queued?: OutboxRow[];
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
  // The business's own message in a customer chat may state a reusable fact. Only with the admin's explicit
  // "staff chats" scope; stored as a PENDING suggestion (never knowledge), never customer text.
  if (settings.passive_learning_scope === "staff_group_and_chats" && !input.chatId.endsWith("@g.us")) {
    const passive = await maybeExtractPassive({
      settings,
      source: "staff_chat",
      text: input.text,
      senderAuth: null,
      senderJid: null,
      chatId: input.chatId,
      contactNumber: input.contactNumber,
      eventId: input.whatsappMessageId,
      whatsappMessageId: input.whatsappMessageId,
      timestamp: input.timestamp,
    });
    return { decision: "HUMAN", reasons: ["staff_message", ...(passive.outcome === "passive:skipped" ? [] : [passive.outcome.replace(":", "_")])], outbox: passive.outbox };
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
  /** This customer's effective handling mode (their own setting, else the business default). */
  customerMode: CustomerMode;
  /** Every message of the turn is a thank-you / hello / ok: nothing for staff or the AI to act on. */
  trivialTurn: boolean;
  /** Tokens of the model call the pipeline made (null when it made none). */
  usage: ShadowUsage | null;
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
  /** The turn's individual customer messages (defaults to `text` as one). */
  segments?: string[];
  hasMedia: boolean;
  /** The turn's own messages: left out of the "recent conversation" slice. */
  excludeMessageIds: string[];
  settings: AgentSettings | null;
  forceGatePass: boolean;
  /**
   * Re-running a PAST turn (admin simulation): only conversation from before `asOf` is shown to the model, and
   * live state (open escalation, collected order, send rate) is ignored because it describes today, not then.
   */
  asOf?: string;
  /** Simulations only: stop before any model call when the contact is not permitted for the agent. */
  requirePermittedContact?: boolean;
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
  const customerMode = effectiveCustomerMode(settings, gateData.conversation);
  const trivialTurn = !args.hasMedia && isTrivialTurn(args.segments ?? [args.text]);

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
    customerMode,
    trivialTurn,
    usage: null,
  };
  if (!gate.pass && !args.forceGatePass) return empty;
  if (args.requirePermittedContact && !gate.pass && gate.reasons.some((c) => PERMISSION_CODES.includes(c))) return empty;
  if (!args.text.trim()) return empty;

  const [knowledge, context, openOrder, openEscalation, recentReplies] = await Promise.all([
    loadActiveKnowledge(businessSlug),
    chatId && identity
      ? loadCustomerContext(businessSlug, chatId, args.contactNumber, args.excludeMessageIds, identity, args.text, { before: args.asOf })
      : Promise.resolve(null),
    chatId && !args.asOf ? loadOpenOrderRequest(businessSlug, chatId) : Promise.resolve(null),
    chatId && !args.asOf ? findOpenEscalation(businessSlug, chatId) : Promise.resolve(null),
    chatId && !args.asOf ? autoRepliesLastHour(businessSlug, chatId) : Promise.resolve(0),
  ]);

  const safeguards = detectSafeguards(args.text);
  // The request the customer is building: the collected order request, else what the escalation they
  // are following up on already holds (so the model returns a CUMULATIVE request, not a fragment).
  const anchor = openEscalation ?? (chatId && !args.asOf ? await findRecentAnsweredEscalation(businessSlug, chatId) : null);
  const anchorOrder = (anchor?.context.order_request ?? null) as OrderRequestDraft | null;
  const priorOrder: OrderRequestDraft | null = openOrder
    ? {
        items: openOrder.items ?? [],
        delivery_address: openOrder.delivery_address,
        delivery_preference: openOrder.delivery_preference,
        notes: openOrder.notes,
      }
    : anchorOrder && anchorOrder.items
      ? { ...anchorOrder }
      : null;

  // "Same as last time" is resolved from VERIFIED orders (lib/aiAgent/memory.ts).
  // When the answer is a question or a hand-off the model has nothing to add.
  const repeat = context?.memory.repeat;
  const repeatDecided = repeat?.kind === "ambiguous" || repeat?.kind === "no_history" || repeat?.kind === "unclear";

  // Injection attempts and thank-yous never reach the model. With an open escalation staff own the
  // conversation: the model still runs, but only to extract what the customer added or changed.
  const skipModel = safeguards.includes("prompt_injection") || trivialTurn || repeatDecided;
  const modelResult = skipModel
    ? { proposal: null, model: null, error: null }
    : await proposeReply({
        businessSlug,
        messageText: args.transcript ?? args.text,
        knowledge,
        context,
        pendingOrder: priorOrder,
        openEscalation: Boolean(openEscalation),
      });

  // The model may only restate what the customer actually wrote: ungrounded products, quantities,
  // addresses and times are dropped before anything is merged, stored or shown to staff.
  let proposal = modelResult.proposal;
  if (proposal?.order_request) {
    const customerWords = [args.text, ...(context?.transcript.filter((t) => t.who === "Customer").map((t) => t.text) ?? [])];
    proposal = { ...proposal, order_request: groundOrderDraft(proposal.order_request, priorOrder, customerWords) };
  }

  const resolution = resolveDecision({
    autonomy: settings?.autonomy ?? 0,
    safeguardCodes: safeguards,
    proposal,
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
    proposal,
    model: modelResult.model,
    modelError: modelResult.error,
    knowledge,
    customerName: context?.customerName ?? empty.customerName,
    history: context ? historyLinesForStaff(context.memory) : [],
    memory: context?.memory ?? null,
    openOrder,
    hasOpenEscalation: Boolean(openEscalation),
    customerMode,
    trivialTurn,
    usage: modelResult.usage ?? null,
  };
}

/** Gate codes meaning "the agent may not engage with this contact". */
const PERMISSION_CODES = ["contact_not_permitted", "contact_excluded", "unresolved_lid_identity"];

interface TurnContext {
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  settings: AgentSettings;
  /** Prefix of every outbox dedupe key: the event id (single message) or `batch:<id>` (batched turn). */
  dedupeBase: string;
  /** The live path hands notices to the bridge in its own response; the batch worker leaves them 'pending'. */
  dispatchNow: boolean;
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
    segments: turn.segments,
    hasMedia: turn.hasMedia,
    excludeMessageIds: turn.whatsappMessageIds,
    settings,
    forceGatePass: false,
  });
  // Autonomous customer messages need BOTH the business (enabled + Assisted) and this customer (Auto-Reply).
  const sendable = canSend(settings) && p.customerMode === "auto_reply";

  if (!p.gate.pass && p.gate.decision !== "ESCALATE") {
    return { decision: p.gate.decision, reasons: p.gate.reasons, outbox: [] };
  }

  // "thanks", "ok", "hello": no staff update, no new escalation, and nothing sent while staff own the issue.
  if (p.gate.pass && p.trivialTurn && (p.hasOpenEscalation || p.customerMode !== "auto_reply")) {
    return { decision: "NO_REPLY", reasons: ["trivial_acknowledgement"], outbox: [] };
  }

  // Evaluation: keep what the AI proposed on its own, from the model call already made. Write-only evidence
  // for admins; it can neither change this outcome nor reach the outbox.
  await recordHistoricalShadow(p, turn, ctx, sendable);

  const r = p.resolution;
  const reasons = [...(p.gate.pass ? r!.reasons : p.gate.reasons), ...p.identityNotes];
  const engineDecision: AgentDecision = p.gate.pass ? r!.decision : "ESCALATE";
  // The customer's mode decides what the engine's decision becomes: Staff First turns a reply the AI
  // would have sent into an escalation carrying it as a draft; Manual Only does nothing.
  const adjusted = p.gate.pass
    ? modeAdjustedDecision(p.customerMode, engineDecision as "REPLY" | "ASK" | "ESCALATE", {
        noActionNeeded: p.proposal?.intent === "smalltalk" && p.safeguards.length === 0 && !r!.orderRequest,
      })
    : "ESCALATE";
  const common = {
    confidence: r?.confidence ?? null,
    proposedReply: r?.reply ?? r?.draftReply ?? null,
    model: p.model,
    knowledgeIds: p.proposal?.knowledge_ids.filter((id) => p.knowledge.some((k) => k.id === id)) ?? [],
    error: p.modelError,
  };
  if (adjusted === "NO_REPLY") {
    return { ...common, decision: "NO_REPLY", reasons: [...reasons, `customer_mode_${p.customerMode}`, "no_staff_action_needed"], outbox: [] };
  }
  const decision: AgentDecision = adjusted;
  if (decision === "ESCALATE" && engineDecision !== "ESCALATE") reasons.push("staff_first");

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
    const escalateInput: EscalateInput = {
      businessSlug,
      chatId,
      contactNumber: ctx.contactNumber,
      customerName: p.customerName,
      reasons,
      priority: r?.priority ?? priorityFor(reasons),
      customerMessage,
      segments: turn.segments,
      // A reply the AI wanted to send (Staff First) is what staff see as the draft.
      draftReply: (engineDecision !== "ESCALATE" ? r?.reply : null) ?? r?.draftReply ?? null,
      summary: p.proposal?.summary ?? null,
      intent: p.proposal?.intent ?? null,
      orderRequest: r?.orderRequest ?? null,
      history: p.history,
      eventId,
      ...pilotDraftInfo(settings, p, r, reasons),
    };
    const write = await createOrAppendEscalation(escalateInput);
    const { escalation, followUp } = write;
    if (orderRequestId && r?.orderComplete) {
      await agentDb()
        .from("ai_agent_order_requests")
        .update({ escalation_id: escalation.id })
        .eq("id", orderRequestId);
    }

    if (write.reopened) reasons.push("escalation_reopened");
    const outbox: OutboxInsert[] = [];
    const queued: OutboxRow[] = [];
    // Staff hear about it through ONE path for every case — a brand-new escalation, an open one whose
    // notice never went out, and a change the customer made later (see notifyStaff).
    const skip = staffNoticeSkipReason(settings);
    if (!skip && settings.staff_group_jid) {
      const posted = await notifyStaff({ ctx, turn, write, escalateInput, eventId });
      reasons.push(...posted.reasons);
      if (posted.row) queued.push(posted.row);
    } else if (skip) {
      reasons.push(`staff_notice_skipped_${skip}`);
      // First notice for this escalation never went out: say why in the admin UI.
      if (!followUp || priorNoticeHold(await priorStaffNotices(businessSlug, escalation.id)) === null) {
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
    return { ...common, decision, reasons, outbox: outbox.filter((o) => customerModeAllowsKind(p.customerMode, o.kind)), queued, escalationId: escalation.id };
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
  return { ...common, decision, reasons, outbox: outbox.filter((o) => customerModeAllowsKind(p.customerMode, o.kind)) };
}

const ORDER_FIELD_TEXT: Record<string, string> = {
  items: "Which products the customer wants",
  quantity: "How many of each",
  delivery_address: "Delivery address",
  delivery_preference: "Delivery day/time",
};

/**
 * Approval Pilot only: how far the AI's draft can be trusted and what it could not work out — computed from the
 * proposal the live pipeline already made (no extra model call) and kept on the escalation.
 */
function pilotDraftInfo(settings: AgentSettings, p: Pipeline, r: Resolution | null, reasons: string[]): Pick<EscalateInput, "draftMeta" | "missing"> {
  if (settings.mode !== "approval_pilot") return {};
  const reply = r?.reply ?? r?.draftReply ?? null;
  const missing = [
    ...(p.proposal?.escalation_reason ? [p.proposal.escalation_reason] : []),
    ...(r?.orderRequest ? missingOrderFields(r.orderRequest).map((f) => ORDER_FIELD_TEXT[f]) : []),
  ];
  if (!reply || !p.proposal) return { missing };
  const readiness = assessDraftReadiness({
    reply,
    proposal: p.proposal,
    activeKnowledge: p.knowledge.map((k) => ({ id: k.id, content: k.content })),
    safeguardCodes: p.safeguards,
    reasonCodes: reasons,
    requiredConfidence: r?.requiredConfidence ?? Number.POSITIVE_INFINITY,
  });
  return {
    missing,
    draftMeta: draftMetaFrom(
      readiness,
      p.proposal.knowledge_ids.filter((id) => p.knowledge.some((k) => k.id === id)),
      knowledgeVersion(p.knowledge)
    ),
  };
}

/**
 * Stores the AI's independent proposal for this turn (kind = historical). Free: it reuses the live model
 * call, so duplicates, acknowledgements, injection attempts and turns staff already own cost nothing and
 * store nothing. Best effort: a failure here is logged and never touches the decision.
 */
async function recordHistoricalShadow(p: Pipeline, turn: CustomerTurn, ctx: TurnContext, aiRepliesDirectly: boolean): Promise<void> {
  try {
    const skip = shadowCaptureSkip({
      enabled: true,
      gatePass: p.gate.pass,
      aiRepliesDirectly,
      trivialTurn: p.trivialTurn,
      openEscalation: p.hasOpenEscalation,
      safeguards: p.safeguards,
      hasProposal: Boolean(p.proposal && p.resolution),
    });
    if (skip || !p.resolution || !p.proposal || !turn.primaryEventId) return;
    if (!(await shadowCaptureEnabled(ctx.businessSlug))) return;
    await saveShadowRecord(
      buildShadowRecord({
        kind: "historical",
        businessSlug: ctx.businessSlug,
        chatId: ctx.chatId,
        sourceEventId: turn.primaryEventId,
        customerQuestion: turn.segments.join("\n"),
        turnAt: turn.lastAt && !Number.isNaN(Date.parse(turn.lastAt)) ? new Date(turn.lastAt).toISOString() : null,
        resolution: p.resolution,
        proposal: p.proposal,
        category: categorizeRequest({
          reasons: p.resolution.reasons,
          intent: p.proposal.intent,
          orderRequest: p.resolution.orderRequest,
          messages: turn.segments,
        }),
        model: p.model,
        knowledgeIds: p.proposal.knowledge_ids.filter((id) => p.knowledge.some((k) => k.id === id)),
        knowledgeVersion: knowledgeVersion(p.knowledge),
        knowledgeCount: p.knowledge.length,
        memoryUsed: p.memory !== null,
        usage: p.usage,
      })
    );
  } catch (err) {
    console.error("[aiAgent] recordHistoricalShadow", err instanceof Error ? err.message : err);
  }
}

/**
 * Tells the staff group about an escalation — the ONE place a staff notice is composed and queued.
 *
 *  - Nothing delivered, in flight or possibly delivered yet (a brand-new escalation, or an open one
 *    whose first notice never went out / provably failed): post the FIRST notice, complete.
 *  - Otherwise: post an UPDATE only when the customer's request changed since the last notice staff
 *    were sent (diffSnapshots). Thank-yous, repeats and duplicates change nothing and post nothing.
 *
 * The notice and the "what staff have seen" snapshot are written together under a row lock
 * (post_ai_agent_escalation_notice), so concurrent workers, redelivered batches and restarts can neither
 * post twice nor drop a change; a lost race simply re-reads and decides again.
 */
async function notifyStaff(args: {
  ctx: TurnContext;
  turn: CustomerTurn;
  write: EscalationWrite;
  escalateInput: EscalateInput;
  eventId: string | null;
}): Promise<{ reasons: string[]; row: OutboxRow | null }> {
  const { ctx, write, escalateInput } = args;
  const { settings, businessSlug } = ctx;
  const group = settings.staff_group_jid;
  if (!group) return { reasons: ["staff_notice_skipped_no_staff_group"], row: null };
  const observeOnly = settings.mode !== "assisted";

  let escalation: EscalationRow = write.escalation;
  let current: RequestSnapshot = write.current;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prior = write.followUp || attempt > 0 ? await priorStaffNotices(businessSlug, escalation.id) : [];
    const first = priorNoticeHold(prior) === null;

    let body: string;
    let urgent = false;
    if (first && settings.mode === "approval_pilot") {
      // Approval Pilot: concise notice with the AI's independent suggestion (version 1), made before any staff input.
      const draft = await ensureAiDraft(escalation);
      body = buildPilotNotice({
        refCode: escalation.ref_code,
        priority: escalation.priority,
        customerLabel: [escalation.customer_name, escalation.contact_number].filter(Boolean).join(" · ") || escalation.chat_id,
        messages: customerMessageSegments(escalation.customer_message ?? escalateInput.customerMessage),
        draft: draft ? { version: draft.version, body: draft.body, ready: draft.ready, notes: draft.confirm_notes } : null,
        missing: escalateInput.missing ?? [],
      });
    } else if (first) {
      body = staffNoticeFor(escalation, write.followUp ? originalEscalationInput(escalation, escalateInput) : escalateInput, false, observeOnly);
    } else {
      const baseline = parseSnapshot(escalation.notified_snapshot) ?? write.previous;
      const changes = diffSnapshots(baseline, current);
      if (changes.length === 0) return { reasons: ["staff_update_not_material"], row: null };
      urgent = isUrgentChange(changes);
      body = buildStaffUpdate({
        refCode: escalation.ref_code,
        priority: escalation.priority,
        customerLabel: [escalation.customer_name, escalation.contact_number].filter(Boolean).join(" · ") || escalation.chat_id,
        current,
        changes,
        afterStaffReply: Boolean(escalation.answered_at),
        observeOnly: observeOnly && settings.mode !== "approval_pilot",
        pilot: settings.mode === "approval_pilot",
      });
    }

    // Same last line of defence as every other item: only what the business's mode permits.
    if (!outboxAllowed(settings, { kind: "staff_notice", toJid: group })) return { reasons: ["outbox_blocked_by_mode"], row: null };

    const posted = await postEscalationNotice({
      escalation,
      snapshot: current,
      toJid: group,
      body,
      eventId: args.eventId,
      dispatchNow: ctx.dispatchNow,
    });
    if (posted.outcome === "queued") {
      return {
        reasons: [first ? "staff_notice_queued" : "staff_update_queued", ...(urgent ? ["staff_update_urgent"] : [])],
        row: await outboxRowById(posted.outboxId),
      };
    }
    if (posted.outcome === "duplicate") return { reasons: ["staff_notice_duplicate"], row: null };
    if (posted.outcome === "closed") return { reasons: ["staff_notice_skipped_escalation_closed"], row: null };
    // Stale: another worker posted first. Re-read what staff have now been told and decide again.
    const fresh = await loadEscalation(businessSlug, escalation.id);
    if (!fresh) return { reasons: ["staff_notice_skipped_escalation_closed"], row: null };
    escalation = fresh;
    current = snapshotFromContext(fresh.context);
  }
  return { reasons: ["staff_notice_contended"], row: null };
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
  const reasons = [BATCHED_REASON];
  // A cancellation must not wait out the quiet period when staff are already working on this customer:
  // the batch becomes due now (the next sweep or cron run picks it up). Only the deadline moves — the
  // message is processed by the same worker, in the same order, as any other.
  if (isCancellation(input.text) && !queued.duplicate && (await staffAreWorkingOn(input.businessSlug, input.chatId))) {
    const { error } = await agentDb()
      .from("ai_agent_batches")
      .update({ due_at: new Date().toISOString() })
      .eq("id", queued.batchId)
      .eq("status", "collecting");
    if (error) console.error("[aiAgent] expedite batch", error.message);
    else reasons.push("batch_expedited_cancellation");
  }
  return { decision: "NO_REPLY", reasons, outbox: [], batched: { batchId: queued.batchId } };
}

/** An open escalation, or one staff answered recently, exists for this chat. */
async function staffAreWorkingOn(businessSlug: string, chatId: string): Promise<boolean> {
  return Boolean((await findOpenEscalation(businessSlug, chatId)) ?? (await findRecentAnsweredEscalation(businessSlug, chatId)));
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
      dispatchNow: false,
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
  if (summary.claimed === 0 && Math.random() < 0.02) {
    await purgeFinishedBatches();
    await purgeShadowResults();
    await purgePilotDrafts();
  }
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
  /** The customer's effective handling mode (their own, else the business default). */
  customerMode: CustomerMode;
}

async function contactNumberFor(businessSlug: string, chatId: string): Promise<string | null> {
  const { data } = await agentDb()
    .from("whatsapp_messages")
    .select("contact_number")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .not("contact_number", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.contact_number ?? null;
}

export async function simulateMessage(input: {
  businessSlug: string;
  chatId: string | null;
  text: string;
}): Promise<SimulationResult> {
  const settings = await loadSettings(input.businessSlug);
  const contactNumber = input.chatId ? await contactNumberFor(input.businessSlug, input.chatId) : null;

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
  const engineDecision: AgentDecision = r?.decision ?? (p.gate.pass ? "NO_REPLY" : p.gate.decision);
  // Same adjustment as the live path: Staff First never sends, it hands the draft to staff.
  const adjusted =
    r && (engineDecision === "REPLY" || engineDecision === "ASK" || engineDecision === "ESCALATE")
      ? modeAdjustedDecision(p.customerMode, engineDecision, {
          noActionNeeded: p.proposal?.intent === "smalltalk" && p.safeguards.length === 0 && !r.orderRequest,
        })
      : engineDecision;
  const decision: AgentDecision = adjusted;
  const sendable = canSend(settings) && p.customerMode === "auto_reply";

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
    customerMode: p.customerMode,
  };
}

// ── Evaluation: admin-triggered simulation of a past turn ────────────────────

export type HistoricalSimulationResult =
  | { status: "simulated" | "cached" | "historical_exists"; id: string }
  | { status: "skipped"; reason: string };

/**
 * Re-runs ONE past customer turn through the same pipeline (same prompt, same engine, same model) using
 * TODAY's approved knowledge, and stores it as kind = 'simulation'. It is never mixed into historical
 * results and is flagged with the knowledge entries that changed since the turn.
 *
 * Cost guards, all before any model call: a turn that already has a historical result is returned as is;
 * the same turn with unchanged knowledge is returned from the earlier simulation; acknowledgements,
 * prompt-injection attempts, contacts the agent may not engage with and an exhausted hourly limit are
 * refused. Writes only ai_agent_shadow_results; nothing is ever queued or sent.
 */
export async function simulateHistoricalTurn(input: {
  businessSlug: string;
  eventId: string;
  adminId: string;
  /** Approval Pilot "Test Again": simulate even though a historical result exists (the label keeps them apart). */
  ignoreHistorical?: boolean;
}): Promise<HistoricalSimulationResult> {
  const { businessSlug } = input;
  const db = agentDb();
  const settings = await loadSettings(businessSlug);
  if (!settings) return { status: "skipped", reason: "agent_not_configured" };

  const { data: event, error } = await db
    .from("ai_agent_events")
    .select("id, kind, chat_id, whatsapp_message_id, message_excerpt, batch_id, created_at")
    .eq("business_slug", businessSlug)
    .eq("id", input.eventId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!event) return { status: "skipped", reason: "not_found" };
  if (event.kind !== "customer_inbound") return { status: "skipped", reason: "not_a_customer_message" };

  // The turn: every message of the batch it was decided with, or the message alone.
  let turnEvents = [event];
  if (event.batch_id) {
    const { data: siblings, error: siblingError } = await db
      .from("ai_agent_events")
      .select("id, kind, chat_id, whatsapp_message_id, message_excerpt, batch_id, created_at")
      .eq("business_slug", businessSlug)
      .eq("batch_id", event.batch_id)
      .eq("kind", "customer_inbound")
      .order("created_at");
    if (siblingError) throw new Error(siblingError.message);
    if ((siblings ?? []).length > 0) turnEvents = siblings!;
  }
  const eventIds = turnEvents.map((e) => e.id);
  const primaryEventId = turnEvents[turnEvents.length - 1].id;

  const existing = input.ignoreHistorical ? null : await findHistoricalForEvents(businessSlug, eventIds);
  if (existing) return { status: "historical_exists", id: existing.id };

  // The words as they were sent (stored messages are retention-limited; the event excerpt is the fallback).
  const { data: stored } = await db
    .from("whatsapp_messages")
    .select("whatsapp_message_id, message_body, timestamp")
    .eq("business_slug", businessSlug)
    .eq("chat_id", event.chat_id)
    .in("whatsapp_message_id", turnEvents.map((e) => e.whatsapp_message_id));
  const storedById = new Map((stored ?? []).map((m) => [m.whatsapp_message_id, m]));
  const turn = buildCustomerTurn(
    turnEvents.map((e, position) => {
      const m = storedById.get(e.whatsapp_message_id);
      return {
        id: e.whatsapp_message_id,
        whatsappMessageId: e.whatsapp_message_id,
        eventId: e.id,
        text: (m?.message_body ?? e.message_excerpt ?? "").trim(),
        hasMedia: false,
        messageAt: m?.timestamp ?? null,
        receivedAt: e.created_at,
        position,
      };
    })
  );
  if (!turn.text.trim()) return { status: "skipped", reason: "no_text" };
  if (isTrivialTurn(turn.segments)) return { status: "skipped", reason: "acknowledgement" };
  if (detectSafeguards(turn.text).includes("prompt_injection")) return { status: "skipped", reason: "prompt_injection" };

  const knowledge = await loadActiveKnowledge(businessSlug);
  const version = knowledgeVersion(knowledge);
  const cached = await findShadowByKey(businessSlug, simulationKey(primaryEventId, version));
  if (cached) return { status: "cached", id: cached.id };
  if ((await countRecentSimulations(businessSlug)) >= SIMULATIONS_PER_HOUR) return { status: "skipped", reason: "simulation_limit" };

  const asOf = turn.firstAt && !Number.isNaN(Date.parse(turn.firstAt)) ? new Date(turn.firstAt).toISOString() : event.created_at;
  const p = await runPipeline({
    businessSlug,
    chatId: event.chat_id,
    contactNumber: await contactNumberFor(businessSlug, event.chat_id),
    text: turn.text,
    transcript: turn.transcript,
    segments: turn.segments,
    hasMedia: false,
    excludeMessageIds: turn.whatsappMessageIds,
    settings,
    // Live-only gate checks (takeover, staff active, business off) say nothing about a past turn;
    // contact permission still applies and is enforced before any model call.
    forceGatePass: true,
    requirePermittedContact: true,
    asOf,
  });
  if (!p.gate.pass && p.gate.reasons.some((c) => PERMISSION_CODES.includes(c))) return { status: "skipped", reason: "contact_not_permitted" };
  if (p.modelError) return { status: "skipped", reason: "model_error" };
  if (!p.proposal || !p.resolution) return { status: "skipped", reason: "no_model_call" };

  const turnAt = turn.lastAt && !Number.isNaN(Date.parse(turn.lastAt)) ? new Date(turn.lastAt).toISOString() : null;
  const changedSince = turnAt ? p.knowledge.filter((k) => Date.parse(k.updated_at) > Date.parse(turnAt)).map((k) => k.id) : [];
  const saved = await saveShadowRecord(
    buildShadowRecord({
      kind: "simulation",
      businessSlug,
      chatId: event.chat_id,
      sourceEventId: primaryEventId,
      customerQuestion: turn.segments.join("\n"),
      turnAt,
      resolution: p.resolution,
      proposal: p.proposal,
      category: categorizeRequest({
        reasons: p.resolution.reasons,
        intent: p.proposal.intent,
        orderRequest: p.resolution.orderRequest,
        messages: turn.segments,
      }),
      model: p.model,
      knowledgeIds: p.proposal.knowledge_ids.filter((id) => p.knowledge.some((k) => k.id === id)),
      knowledgeVersion: knowledgeVersion(p.knowledge),
      knowledgeCount: p.knowledge.length,
      postTurnKnowledgeIds: changedSince,
      memoryUsed: p.memory !== null,
      usage: p.usage,
      simulatedBy: input.adminId,
    })
  );
  // A concurrent identical click stored it first.
  const row = saved ?? (await findShadowByKey(businessSlug, simulationKey(primaryEventId, knowledgeVersion(p.knowledge))));
  if (!row) throw new Error("Simulation could not be stored");
  await audit(businessSlug, "admin", input.adminId, "evaluation.simulate", { type: "shadow_result", id: row.id }, { event_id: primaryEventId });
  return { status: saved ? "simulated" : "cached", id: row.id };
}

/**
 * Approval Pilot "Test Again": re-runs the customer turn behind one pilot request with TODAY's approved knowledge,
 * through the same simulation (same cost guards, cache by knowledge version, hourly limit, nothing sent) and stores
 * it as a SIMULATION. The historical draft staff saw is never touched.
 */
export async function simulatePilotRequest(input: { businessSlug: string; escalationId: string; adminId: string }): Promise<HistoricalSimulationResult> {
  const { data, error } = await agentDb()
    .from("ai_agent_events")
    .select("id")
    .eq("business_slug", input.businessSlug)
    .eq("escalation_id", input.escalationId)
    .eq("kind", "customer_inbound")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const eventId = ((data ?? [])[0] as { id: string } | undefined)?.id;
  if (!eventId) return { status: "skipped", reason: "not_found" };
  return simulateHistoricalTurn({ businessSlug: input.businessSlug, eventId, adminId: input.adminId, ignoreHistorical: true });
}
