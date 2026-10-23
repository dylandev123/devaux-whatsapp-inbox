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
  ContactRule,
  ConversationControl,
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
  ChatIdentity,
  combineRules,
  isLidJid,
  resolveChatIdentity,
  verifiedPhoneDigits,
} from "@/lib/aiAgent/identity";
import {
  latestManualStaffMessageAt,
  loadCustomerContext,
  loadOpenOrderRequest,
  OpenOrderRequest,
} from "@/lib/server/aiAgent/context";
import { agentDb, audit, KnowledgeRow, loadActiveKnowledge, loadSettings } from "@/lib/server/aiAgent/db";
import {
  canSend,
  createOrAppendEscalation,
  originalEscalationInput,
  priorStaffNotices,
  findOpenEscalation,
  processStaffGroupMessage,
  setConversationControl,
  staffNoticeFor,
} from "@/lib/server/aiAgent/escalations";
import { proposeReply } from "@/lib/server/aiAgent/model";
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
  if ("response" in claim) return claim.response;
  const eventId = claim.eventId;

  try {
    let outcome: Outcome;
    if (isStaffGroup) {
      const staff = await processStaffGroupMessage({
        settings,
        text: input.text,
        quotedMessageId: input.quotedMessageId,
        senderJid: input.senderJid,
        eventId,
      });
      outcome = {
        decision: "NO_REPLY",
        reasons: [`staff_group_${staff.outcome}`],
        outbox: staff.outbox,
        escalationId: staff.escalationId,
      };
    } else if (input.fromMe) {
      outcome = await handleManualStaffMessage(input, settings);
    } else {
      outcome = await handleCustomerMessage(input, settings, eventId);
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
}

async function claimEvent(
  input: BridgeMessageInput,
  kind: string,
  settings: AgentSettings
): Promise<{ eventId: string } | { response: BridgeMessageResponse }> {
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
    response: {
      eventId: existing.id,
      status: processing ? "in_progress" : "duplicate",
      decision: existing.decision,
      reasons: existing.reason_codes ?? [],
      outbox: items.map((r) => toBridgeItem(r, false)),
    },
  };
}

async function finishEvent(eventId: string, startedAt: number, outcome: Outcome): Promise<void> {
  const { error } = await agentDb()
    .from("ai_agent_events")
    .update({
      status: "done",
      decision: outcome.decision,
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

// Every JID that provably belongs to this contact (see lib/aiAgent/identity.ts):
// the incoming chat_id, its verified phone JID and any @lid chats WhatsApp
// reported the same phone for. Stored history is best-effort (messages are
// purged after 7 days); a failed lookup just leaves the chat_id on its own,
// which can only narrow, never widen, who is allowed.
async function loadIdentity(businessSlug: string, chatId: string, contactNumber: string | null): Promise<ChatIdentity> {
  const db = agentDb();
  let storedPhone: string | null = null;
  if (isLidJid(chatId) && !verifiedPhoneDigits(chatId, contactNumber)) {
    const { data } = await db
      .from("whatsapp_messages")
      .select("contact_number")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .not("contact_number", "is", null)
      .order("timestamp", { ascending: false })
      .limit(50);
    storedPhone =
      (data ?? []).map((r) => verifiedPhoneDigits(chatId, r.contact_number)).find((p): p is string => Boolean(p)) ?? null;
  }
  const phone = verifiedPhoneDigits(chatId, contactNumber) ?? storedPhone;
  let lidChats: string[] = [];
  if (phone) {
    const { data } = await db
      .from("whatsapp_messages")
      .select("chat_id")
      .eq("business_slug", businessSlug)
      .eq("contact_number", phone)
      .like("chat_id", "%@lid")
      .limit(200);
    lidChats = [...new Set((data ?? []).map((r) => r.chat_id as string))];
  }
  return resolveChatIdentity(chatId, contactNumber, { storedPhone, lidChats });
}

async function loadGateData(businessSlug: string, chatId: string, contactNumber: string | null, settings: AgentSettings | null) {
  const db = agentDb();
  const identity = await loadIdentity(businessSlug, chatId, contactNumber);
  const [rules, conversation, staffActiveAt] = await Promise.all([
    db.from("ai_agent_contact_rules").select("chat_id, rule").eq("business_slug", businessSlug).in("chat_id", identity.chatIds),
    db
      .from("ai_agent_conversations")
      .select("control, human_until")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .maybeSingle(),
    latestManualStaffMessageAt(businessSlug, chatId, settings?.auto_takeover_minutes ?? 0),
  ]);
  const matched = (rules.data ?? []) as { chat_id: string; rule: ContactRule }[];
  const contactRule = combineRules(matched);
  return {
    contactRule,
    unresolvedLid: identity.unresolvedLid,
    // Rule found only under another identity of the same contact (phone <-> @lid).
    matchedViaAlias: contactRule !== null && !matched.some((r) => r.chat_id === chatId && r.rule === contactRule),
    conversation: (conversation.data as ConversationControl | null) ?? null,
    staffActiveAt,
  };
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
  safeguards: string[];
  resolution: Resolution | null;
  proposal: ModelProposal | null;
  model: string | null;
  modelError: string | null;
  knowledge: KnowledgeRow[];
  customerName: string;
  openOrder: OpenOrderRequest | null;
  hasOpenEscalation: boolean;
}

/**
 * Shared by the live path and the test console. `forceGatePass` (console only)
 * evaluates the policy as if the gate had passed, while still reporting the
 * real gate result.
 */
async function runPipeline(args: {
  businessSlug: string;
  chatId: string | null;
  contactNumber: string | null;
  text: string;
  hasMedia: boolean;
  whatsappMessageId: string | null;
  settings: AgentSettings | null;
  forceGatePass: boolean;
}): Promise<Pipeline> {
  const { businessSlug, chatId, settings } = args;
  const { matchedViaAlias, ...gateData } = chatId
    ? await loadGateData(businessSlug, chatId, args.contactNumber, settings)
    : { contactRule: null, unresolvedLid: false, matchedViaAlias: false, conversation: null, staffActiveAt: null };
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
    safeguards: [],
    resolution: null,
    proposal: null,
    model: null,
    modelError: null,
    knowledge: [],
    customerName: chatId ?? "Test customer",
    openOrder: null,
    hasOpenEscalation: false,
  };
  if (!gate.pass && !args.forceGatePass) return empty;
  if (!args.text.trim()) return empty;

  const [knowledge, context, openOrder, openEscalation, recentReplies] = await Promise.all([
    loadActiveKnowledge(businessSlug),
    chatId ? loadCustomerContext(businessSlug, chatId, args.contactNumber, args.whatsappMessageId) : Promise.resolve(null),
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

  // Injection attempts never reach the model; an open escalation means staff
  // own the conversation, so there is nothing for the model to draft.
  const skipModel = safeguards.includes("prompt_injection") || Boolean(openEscalation);
  const modelResult = skipModel
    ? { proposal: null, model: null, error: null }
    : await proposeReply({ businessSlug, messageText: args.text, knowledge, context, pendingOrder: priorOrder });

  const resolution = resolveDecision({
    autonomy: settings?.autonomy ?? 0,
    safeguardCodes: safeguards,
    proposal: modelResult.proposal,
    activeKnowledge: knowledge.map((k) => ({ id: k.id, content: k.content })),
    priorOrderRequest: priorOrder,
    autoRepliesLastHour: recentReplies,
    maxAutoRepliesPerHour: settings?.max_auto_replies_per_hour ?? 0,
    hasOpenEscalation: Boolean(openEscalation),
  });

  return {
    gate,
    identityNotes: empty.identityNotes,
    safeguards,
    resolution,
    proposal: modelResult.proposal,
    model: modelResult.model,
    modelError: modelResult.error,
    knowledge,
    customerName: context?.customerName ?? empty.customerName,
    openOrder,
    hasOpenEscalation: Boolean(openEscalation),
  };
}

async function handleCustomerMessage(
  input: BridgeMessageInput,
  settings: AgentSettings,
  eventId: string
): Promise<Outcome> {
  const p = await runPipeline({
    businessSlug: input.businessSlug,
    chatId: input.chatId,
    contactNumber: input.contactNumber,
    text: input.text,
    hasMedia: input.hasMedia,
    whatsappMessageId: input.whatsappMessageId,
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

  // Persist the (never-confirmed) order request as it is collected.
  let orderRequestId: string | null = p.openOrder?.id ?? null;
  if (r?.orderRequest) {
    orderRequestId = await saveOrderRequest(input, p.openOrder, r.orderRequest, r.orderComplete);
  }

  if (decision === "ESCALATE") {
    const customerMessage = input.text.trim() || "(media message without text)";
    const escalateInput = {
      businessSlug: input.businessSlug,
      chatId: input.chatId,
      contactNumber: input.contactNumber,
      customerName: p.customerName,
      reasons,
      priority: r?.priority ?? priorityFor(reasons),
      customerMessage,
      draftReply: r?.draftReply ?? null,
      summary: p.proposal?.summary ?? null,
      orderRequest: r?.orderRequest ?? null,
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
    const prior = followUp ? await priorStaffNotices(input.businessSlug, escalation.id) : [];
    const skip = staffNoticeSkipReason(settings, followUp, prior);
    const firstNotice = !followUp || needsFirstNotice(followUp, prior);
    if (!skip && settings.staff_group_jid) {
      outbox.push({
        businessSlug: input.businessSlug,
        chatId: input.chatId,
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
        dedupeKey: followUp ? `escalation:${escalation.id}:staff_notice:${prior.length}` : `${eventId}:staff_notice`,
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
          .eq("business_slug", input.businessSlug);
      }
    }
    if (sendable && settings.send_holding_reply && !followUp) {
      outbox.push({
        businessSlug: input.businessSlug,
        chatId: input.chatId,
        kind: "holding_reply",
        toJid: input.chatId,
        body: r?.orderComplete ? HOLDING_REPLY_ORDER : HOLDING_REPLY_GENERAL,
        dedupeKey: `${eventId}:holding_reply`,
        escalationId: escalation.id,
      });
    }
    await audit(input.businessSlug, "system", null, followUp ? "escalation.append" : "escalation.open", {
      type: "escalation",
      id: escalation.id,
    }, { ref_code: escalation.ref_code, reasons });
    return { ...common, decision, reasons, outbox, escalationId: escalation.id };
  }

  // REPLY / ASK
  const outbox: OutboxInsert[] =
    sendable && r?.reply
      ? [
          {
            businessSlug: input.businessSlug,
            chatId: input.chatId,
            kind: "customer_reply",
            toJid: input.chatId,
            body: r.reply,
            dedupeKey: `${eventId}:customer_reply`,
          },
        ]
      : [];
  return { ...common, decision, reasons, outbox };
}

async function saveOrderRequest(
  input: BridgeMessageInput,
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
    whatsappMessageId: null,
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
