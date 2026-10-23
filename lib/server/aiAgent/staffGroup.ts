// Server-only: everything that happens when someone writes in a business's
// staff group. A message is tied to ONE escalation — by a quoted reply to a
// message we posted for it, or by an explicit #E- reference — or it is ignored;
// it is never routed by recency or by the customer's name (matchStaffReply() in
// lib/aiAgent/engine.ts decides, this file loads the candidates and applies the
// result).
//
// A staff ANSWER is information. It is recorded, turned into a draft customer
// reply and a classification (staffKnowledge.ts), and the draft is posted back
// to the group — it never reaches the customer by itself. Only an explicit
// "!send" can, and only when every customer send policy also passes:
// decideCustomerSend() in lib/aiAgent/staffAnswers.ts. Staff-group posting and
// customer sending are separate permissions, checked separately (the staff
// message is gated by canSendStaffNotice via outboxAllowed(), the customer
// message by the central customer-send policy, planCustomerSend() in
// customerSend.ts — the same one the dashboard's "Send to customer" uses).
//
// Who may authorize: only a sender on the business's allow-list
// (staff_authorized_senders), identified by verified WhatsApp identifiers —
// authorizeStaffSender() in lib/aiAgent/identity.ts. Anyone in the group can
// still write an answer (it is information); nobody else can make it a message.

import {
  type AgentSettings,
  canSendToCustomers,
  extractRefCodes,
  type MatchableEscalation,
  matchStaffReply,
  outboxAllowed,
} from "@/lib/aiAgent/engine";
import { authorizeStaffSender, isSenderIdAuthorized, type SenderAuthorization } from "@/lib/aiAgent/identity";
import {
  buildProcessingFailureMessage,
  buildStaffDraftMessage,
  checkStaffDraftSafety,
  decideCustomerSend,
  decideRetry,
  RETRY_REFUSAL_TEXT,
  summarizeOutcomes,
  WITHHOLD_TEXT,
} from "@/lib/aiAgent/staffAnswers";
import { agentDb, audit, loadActiveKnowledge, loadSettings } from "@/lib/server/aiAgent/db";
import { customerGate, planCustomerSend, sha } from "@/lib/server/aiAgent/customerSend";
import {
  applyStaffAction,
  ESCALATION_COLUMNS,
  type EscalationRow,
  markEscalationAnswered,
} from "@/lib/server/aiAgent/escalations";
import { enqueue, OutboxInsert, outboxForEvent } from "@/lib/server/aiAgent/outbox";
import {
  analyzeAndStore,
  answerByDraftKey,
  answerById,
  claimAnswerRetry,
  draftAnswers,
  failStaffAnswer,
  finishStaffAnswer,
  openAnswersForEvent,
  type StaffAnswerRow,
  STAFF_ANSWER_COLUMNS,
  startStaffAnswer,
} from "@/lib/server/aiAgent/staffKnowledge";

/** A staff group never needs more than this many drafts for one escalation; further ones are recorded, not posted. */
const MAX_DRAFTS_PER_ESCALATION = 8;

export interface StaffGroupMessage {
  settings: AgentSettings;
  text: string;
  quotedMessageId: string | null;
  /** The group participant who wrote it, as WhatsApp reported it. */
  senderJid: string | null;
  /** The participant's phone number when the bridge could resolve one for an @lid sender (Baileys participantPn). */
  senderPhone?: string | null;
  eventId: string;
  /** The staff message's own WhatsApp id: the idempotency key of the answer. */
  whatsappMessageId: string;
  timestamp: string | null;
}

export interface StaffGroupResult {
  outbox: OutboxInsert[];
  outcome: string;
  escalationId: string | null;
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Our own staff-group messages that identify an escalation when a staff member quotes them. */
const QUOTABLE_KINDS = ["staff_notice", "staff_draft", "staff_feedback"];

/** What a quoted message was, when it was one of our staff_draft posts. */
interface QuotedDraft {
  /** The draft message's dedupe key, when exactly one staff_draft row carries the quoted WhatsApp id. */
  key: string | null;
}

async function matchCandidates(
  businessSlug: string,
  text: string,
  quotedMessageId: string | null
): Promise<{ candidates: MatchableEscalation[]; quotedDraft: QuotedDraft | null }> {
  const db = agentDb();
  const refs = extractRefCodes(text);
  const byId = new Map<string, MatchableEscalation>();
  let quotedDraft: QuotedDraft | null = null;

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
    // Any message we posted for an escalation (its notice, a follow-up, a draft,
    // a confirmation) identifies exactly that escalation — within this business.
    const { data: posted, error } = await db
      .from("ai_agent_outbox")
      .select("escalation_id, kind, dedupe_key")
      .eq("business_slug", businessSlug)
      .in("kind", QUOTABLE_KINDS)
      .eq("whatsapp_message_id", quotedMessageId);
    if (error) throw new Error(error.message);
    const rows = (posted ?? []).filter((n) => n.escalation_id);
    const ids = Array.from(new Set(rows.map((n) => n.escalation_id as string)));
    if (ids.length > 0) {
      const { data, error: escError } = await db
        .from("ai_agent_escalations")
        .select("id, ref_code, notice_message_id, status")
        .eq("business_slug", businessSlug)
        .in("id", ids);
      if (escError) throw new Error(escError.message);
      for (const row of data ?? []) byId.set(row.id, { ...(row as MatchableEscalation), notice_message_id: quotedMessageId });
    }
    // A quoted DRAFT must resolve to exactly that draft; it never falls back to "the newest one".
    const drafts = rows.filter((n) => n.kind === "staff_draft");
    if (drafts.length > 0) quotedDraft = { key: drafts.length === 1 ? (drafts[0].dedupe_key as string) : null };
  }
  return { candidates: Array.from(byId.values()), quotedDraft };
}

const customerLabel = (e: EscalationRow) => e.customer_name ?? e.contact_number ?? e.chat_id;

// ── Entry point ──────────────────────────────────────────────────────────────

export async function processStaffGroupMessage(input: StaffGroupMessage): Promise<StaffGroupResult> {
  const { settings } = input;
  const groupJid = settings.staff_group_jid!;
  const { candidates, quotedDraft } = await matchCandidates(settings.business_slug, input.text, input.quotedMessageId);
  const match = matchStaffReply({ text: input.text, quotedMessageId: input.quotedMessageId }, candidates);

  const feedback = (body: string, escalationId: string | null = null): OutboxInsert => ({
    businessSlug: settings.business_slug,
    chatId: groupJid,
    kind: "staff_feedback",
    toJid: groupJid,
    body,
    dedupeKey: `${input.eventId}:staff_feedback`,
    eventId: input.eventId,
    escalationId,
  });
  // Plain feedback only speaks in Assisted mode — Observe posts notices and drafts only.
  const speak = canSendToCustomers(settings);

  switch (match.kind) {
    case "unmatched":
      // No quote, no reference: ordinary staff chatter. Nothing happens, nothing is posted.
      return { outbox: [], outcome: "unmatched", escalationId: null };
    case "ambiguous":
      return {
        outbox: speak ? [feedback(`⚠️ Nothing sent: that message matches more than one escalation (${match.refCodes.map((r) => `#${r}`).join(", ")}). Reply to one escalation at a time.`)] : [],
        outcome: "ambiguous",
        escalationId: null,
      };
    case "unknown_ref":
      return {
        outbox: speak ? [feedback(`⚠️ Nothing sent: no escalation ${match.refCodes.map((r) => `#${r}`).join(", ")} found.`)] : [],
        outcome: "unknown_ref",
        escalationId: null,
      };
    case "closed":
      return {
        outbox: speak ? [feedback(`ℹ️ #${match.refCode} is already closed — nothing was sent.`, match.escalationId)] : [],
        outcome: "closed",
        escalationId: match.escalationId,
      };
    case "empty":
      return {
        outbox: speak ? [feedback(`⚠️ #${match.refCode}: no answer text found — nothing was sent.`, match.escalationId)] : [],
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
      const escalation = data as EscalationRow;
      const ctx: Ctx = {
        ...input,
        escalation,
        via: match.via,
        quotedDraft: match.via === "quote" ? quotedDraft : null,
        senderAuth: authorizeStaffSender(settings.staff_authorized_senders, input.senderJid, input.senderPhone),
      };

      if (match.command === "answer") return handleAnswer(ctx, match.body);
      if (match.command === "send") return handleSend(ctx, match.body);

      const result = await applyStaffAction({
        escalation,
        command: match.command,
        body: match.body,
        settings,
        actorKind: "staff",
        actorId: input.senderJid,
        via: "whatsapp",
        dedupeBase: input.eventId,
      });
      const outbox: OutboxInsert[] = result.outbox.map((o) => ({ ...o, eventId: input.eventId }));
      if (speak) outbox.push(feedback(result.feedback, escalation.id));
      return { outbox, outcome: `matched:${match.command}`, escalationId: escalation.id };
    }
  }
}

interface Ctx extends StaffGroupMessage {
  escalation: EscalationRow;
  via: "quote" | "ref";
  /** Set when the quoted message was one of our drafts. */
  quotedDraft: QuotedDraft | null;
  senderAuth: SenderAuthorization;
}

const feedbackItem = (ctx: Ctx, body: string): OutboxInsert => ({
  businessSlug: ctx.escalation.business_slug,
  chatId: ctx.settings.staff_group_jid!,
  kind: "staff_feedback",
  toJid: ctx.settings.staff_group_jid!,
  body,
  dedupeKey: `${ctx.eventId}:staff_feedback`,
  eventId: ctx.eventId,
  escalationId: ctx.escalation.id,
});

// ── A staff answer (information) ─────────────────────────────────────────────

async function handleAnswer(ctx: Ctx, body: string, resume?: StaffAnswerRow): Promise<StaffGroupResult> {
  const { settings, escalation: e } = ctx;
  const answer =
    resume ??
    (await startStaffAnswer({
      escalation: e,
      source: "whatsapp",
      sourceMessageId: ctx.whatsappMessageId,
      sourceEventId: ctx.eventId,
      senderJid: ctx.senderJid,
      senderId: ctx.senderAuth.senderId,
      senderAuthorized: ctx.senderAuth.authorized,
      matchedVia: ctx.via,
      command: "answer",
      body,
      staffMessageAt: ctx.timestamp,
    }));
  // The very same WhatsApp message again: already recorded, drafted and posted.
  if (!answer) return { outbox: [], outcome: "matched:answer_repeated", escalationId: e.id };

  try {
    const knowledge = await loadActiveKnowledge(e.business_slug);
    const analysis = await analyzeAndStore({ settings, escalation: e, answer, mode: "draft_and_classify", staffText: body, knowledge });
    const draft = analysis.draft?.trim() || null;
    const safety = draft ? checkStaffDraftSafety(draft, body, knowledge) : [];
    const gate = await customerGate(settings, e);
    // authorized: false — a plain reply is never permission to message the customer.
    const decision = decideCustomerSend({
      settings,
      authorized: false,
      gate,
      safetyCodes: safety,
      hasText: Boolean(draft),
      noText: analysis.error ? "draft_unavailable" : "nothing_to_tell",
    });
    const reason = decision.send ? "not_authorized" : decision.reason;

    await markEscalationAnswered(e, { body, actorId: ctx.senderJid, via: "whatsapp", notRelayed: reason });

    const message = buildStaffDraftMessage({
      refCode: e.ref_code,
      customerLabel: customerLabel(e),
      draft,
      decision: { send: false, reason },
      learned: summarizeOutcomes(analysis.outcomes),
    });
    const draftKey = `staffdraft:${e.id}:${sha(`${draft ?? ""}|${reason}`)}`;
    const post = await withinDraftCap(e);
    const outbox: OutboxInsert[] = post ? [staffDraftItem(ctx, message, draftKey)] : [];

    await finishStaffAnswer(answer, {
      state: "done",
      draft,
      draft_source: draft ? "model" : null,
      customer_action: "withheld",
      withheld_reason: reason,
      draft_dedupe_key: draft ? draftKey : null,
      items: analysis.outcomes,
      temporary_facts: analysis.temporaryFacts,
      valid_until: analysis.validUntil,
      model: analysis.model,
      error: analysis.error,
    });
    await audit(e.business_slug, "staff", ctx.senderJid, "escalation.answer", { type: "escalation", id: e.id }, {
      ref_code: e.ref_code,
      via: ctx.via,
      answer_id: answer.id,
      sender_id: ctx.senderAuth.senderId,
      customer_action: "withheld",
      reason,
    });
    return { outbox, outcome: "matched:answer", escalationId: e.id };
  } catch (err) {
    await failStaffAnswer(answer, err);
    throw err;
  }
}

// ── Explicit authorization ("!send") ─────────────────────────────────────────

type Approval = { ok: true; draft: StaffAnswerRow } | { ok: false; why: "none" | "unresolved" | "several" };

/**
 * The draft a bare "send" approves — never a guess across customers or drafts:
 *   - a quoted DRAFT → exactly that draft (not found → refuse, not "the newest");
 *   - otherwise (a quoted notice, or an explicit #E- reference) → this
 *     escalation's one unsent draft; two different unsent drafts → refuse.
 * Everything is scoped to this business and this escalation.
 */
async function resolveApproval(ctx: Ctx): Promise<Approval> {
  const { escalation: e } = ctx;
  if (ctx.quotedDraft) {
    const draft = ctx.quotedDraft.key ? await answerByDraftKey(e.business_slug, e.id, ctx.quotedDraft.key) : null;
    return draft?.draft ? { ok: true, draft } : { ok: false, why: "unresolved" };
  }
  const all = await draftAnswers(e.business_slug, e.id);
  if (all.length === 0) return { ok: false, why: "none" };
  const sentTexts = new Set(all.filter((a) => a.customer_action === "sent").map((a) => sha(a.draft!)));
  const unsent = new Map<string, StaffAnswerRow>();
  for (const a of all) {
    const key = sha(a.draft!);
    if (!sentTexts.has(key) && !unsent.has(key)) unsent.set(key, a);
  }
  if (unsent.size > 1) return { ok: false, why: "several" };
  // One unsent draft, or only already-sent ones (approving those is held as "already sent").
  return { ok: true, draft: [...unsent.values()][0] ?? all[0] };
}

const NO_DRAFT_TEXT: Record<"none" | "unresolved" | "several", (ref: string) => string> = {
  none: (ref) => `ℹ️ #${ref}: there is no draft to send yet. Reply with your answer first, or use !send followed by the exact text.`,
  unresolved: (ref) => `⚠️ #${ref}: I can't tell which draft you quoted, so nothing was sent. Quote the draft you mean and reply "send", or use !send followed by the exact text.`,
  several: (ref) => `⚠️ #${ref}: there is more than one unsent draft for this customer, so nothing was sent. Quote the one you mean and reply "send".`,
};

/**
 * "!send <text>" sends the staff's own wording; a bare "!send" (or a message
 * that is just "send it") approves a draft we posted (resolveApproval). In both
 * cases the customer is messaged only if the sender is on the business's
 * allow-list AND planCustomerSend() allows it.
 */
async function handleSend(ctx: Ctx, body: string, resume?: StaffAnswerRow): Promise<StaffGroupResult> {
  const { settings, escalation: e } = ctx;
  // A resumed answer keeps what it was: typed text, or the exact draft it approved.
  const exact = resume ? (resume.approves_answer_id ? "" : resume.body) : body.trim();

  let prior: StaffAnswerRow | null = null;
  let text: string;
  if (exact) {
    text = exact;
  } else {
    const approval = resume
      ? resume.approves_answer_id
        ? await answerById(e.business_slug, e.id, resume.approves_answer_id).then((d): Approval => (d?.draft ? { ok: true, draft: d } : { ok: false, why: "unresolved" }))
        : ({ ok: false, why: "unresolved" } as Approval)
      : await resolveApproval(ctx);
    if (!approval.ok) {
      if (resume) await failStaffAnswer(resume, new Error("The draft this approval referred to is no longer available"));
      return {
        outbox: canSendToCustomers(settings) ? [feedbackItem(ctx, NO_DRAFT_TEXT[approval.why](e.ref_code))] : [],
        outcome: approval.why === "none" ? "matched:send_without_draft" : "matched:send_draft_unresolved",
        escalationId: e.id,
      };
    }
    prior = approval.draft;
    text = prior.draft!;
  }

  const answer =
    resume ??
    (await startStaffAnswer({
      escalation: e,
      source: "whatsapp",
      sourceMessageId: ctx.whatsappMessageId,
      sourceEventId: ctx.eventId,
      senderJid: ctx.senderJid,
      senderId: ctx.senderAuth.senderId,
      senderAuthorized: ctx.senderAuth.authorized,
      matchedVia: ctx.via,
      command: "send",
      body: exact || "send",
      staffMessageAt: ctx.timestamp,
      approvesAnswerId: prior?.id ?? null,
    }));
  if (!answer) return { outbox: [], outcome: "matched:send_repeated", escalationId: e.id };

  try {
    // Words from someone who may not authorize sends are not learned from either.
    const analysis =
      exact && ctx.senderAuth.authorized
        ? await analyzeAndStore({ settings, escalation: e, answer, mode: "classify_only", staffText: exact })
        : null;

    const plan = await planCustomerSend({
      settings,
      escalation: e,
      requester: { kind: "staff", senderAuthorized: ctx.senderAuth.authorized, senderId: ctx.senderAuth.senderId },
      text,
      draft: prior ? { body: prior.body, created_at: prior.created_at, valid_until: prior.valid_until } : null,
      eventId: ctx.eventId,
    });
    const { decision } = plan;

    const outbox: OutboxInsert[] = plan.item ? [plan.item] : [];
    if ((exact && ctx.senderAuth.authorized) || decision.send) {
      await markEscalationAnswered(e, {
        body: exact || null,
        actorId: ctx.senderJid,
        via: "whatsapp",
        notRelayed: decision.send ? null : decision.reason,
      });
    }

    const message = buildStaffDraftMessage({
      refCode: e.ref_code,
      customerLabel: customerLabel(e),
      draft: text,
      decision,
      learned: summarizeOutcomes(analysis?.outcomes ?? []),
    });
    // Keyed by this message too: every "send" gets its own visible answer (it is a
    // response to an instruction), while a replay of the same message is still caught earlier.
    const draftKey = `staffdraft:${e.id}:${sha(`${text}|${decision.send ? "sent" : decision.reason}`)}:${ctx.whatsappMessageId}`;
    if (await withinDraftCap(e)) outbox.push(staffDraftItem(ctx, message, draftKey));

    await finishStaffAnswer(answer, {
      state: "done",
      draft: text,
      draft_source: exact ? "staff_text" : "stored_draft",
      customer_action: decision.send ? "sent" : "withheld",
      withheld_reason: decision.send ? null : decision.reason,
      draft_dedupe_key: draftKey,
      customer_dedupe_key: decision.send ? plan.relayKey : null,
      items: analysis?.outcomes ?? [],
      temporary_facts: analysis?.temporaryFacts ?? [],
      valid_until: analysis?.validUntil ?? null,
      model: analysis?.model ?? null,
      error: analysis?.error ?? null,
    });
    if (prior && decision.send) {
      await finishStaffAnswer(prior, { customer_action: "sent", customer_dedupe_key: plan.relayKey });
    }
    await audit(e.business_slug, "staff", ctx.senderJid, "escalation.send", { type: "escalation", id: e.id }, {
      ref_code: e.ref_code,
      via: ctx.via,
      answer_id: answer.id,
      approved_answer_id: prior?.id ?? null,
      sender_id: ctx.senderAuth.senderId,
      sender_authorized: ctx.senderAuth.authorized,
      exact_text: Boolean(exact),
      customer_action: decision.send ? "sent" : "withheld",
      reason: decision.send ? null : decision.reason,
      reason_text: decision.send ? null : WITHHOLD_TEXT[decision.reason],
    });
    return { outbox, outcome: `matched:send_${decision.send ? "sent" : "withheld"}`, escalationId: e.id };
  } catch (err) {
    await failStaffAnswer(answer, err);
    throw err;
  }
}

// ── Failures: visible, and retryable only when that cannot message a customer twice ──

/**
 * A staff message crashed part-way. Marks its unfinished answers failed (so the
 * dashboard lists them with a Retry), and tells the staff group — in plain words
 * and honestly about whether a customer message may already have gone out.
 * Best effort and never throws: it runs inside an error handler.
 */
export async function reportStaffFailure(args: { settings: AgentSettings; eventId: string; error: unknown }): Promise<void> {
  const { settings, eventId } = args;
  try {
    const open = await openAnswersForEvent(settings.business_slug, eventId);
    for (const a of open) if (a.state === "processing") await failStaffAnswer(a, args.error);
    // The customer-bound rows this very message created before it died: they exist, but the
    // bridge was never told to send them — an unknown outcome, never to be re-sent blindly.
    const created = await outboxForEvent(eventId);
    const mayHaveSent = created.some((r) => r.kind !== "staff_notice" && r.kind !== "staff_draft" && r.kind !== "staff_feedback");
    const first = open[0] ?? null;
    await audit(settings.business_slug, "system", null, "staff_answer.failed", { type: "event", id: eventId }, {
      answer_ids: open.map((a) => a.id),
      ref_code: first?.ref_code ?? null,
      customer_message_may_have_been_sent: mayHaveSent,
      error: (args.error instanceof Error ? args.error.message : String(args.error)).slice(0, 300),
    });
    if (!settings.staff_group_jid) return;
    const item: OutboxInsert = {
      businessSlug: settings.business_slug,
      chatId: settings.staff_group_jid,
      kind: "staff_feedback",
      toJid: settings.staff_group_jid,
      body: buildProcessingFailureMessage({ refCode: first?.ref_code ?? null, mayHaveSent }),
      dedupeKey: `${eventId}:staff_failed`,
      eventId,
      escalationId: first?.escalation_id ?? null,
    };
    // Staff-group posting is its own permission: Observe has no feedback kind (the dashboard shows the failure instead).
    if (outboxAllowed(settings, item)) await enqueue([item], false);
  } catch (err) {
    console.error("[aiAgent] reportStaffFailure", err instanceof Error ? err.message : err);
  }
}

export type RetryResult =
  | { ok: true; message: string; queued: number }
  | { ok: false; status: number; error: string };

/**
 * Admin retry of ONE failed WhatsApp staff answer. Refused unless it cannot
 * message a customer twice (decideRetry) — a customer message that is sent, in
 * flight, or of unknown outcome blocks it for good. The retry runs the same
 * handler with the same stored words, sender and approved draft, so every
 * policy (allow-list, Assisted mode, gate, staleness, duplicates) applies again
 * as of now.
 */
export async function retryStaffAnswer(args: { businessSlug: string; answerId: string; adminId: string | null }): Promise<RetryResult> {
  const { businessSlug } = args;
  const settings = await loadSettings(businessSlug);
  if (!settings?.enabled) return { ok: false, status: 409, error: "The AI agent is switched off for this business." };

  const { data: row, error } = await agentDb()
    .from("ai_agent_staff_answers")
    .select(STAFF_ANSWER_COLUMNS)
    .eq("id", args.answerId)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!row) return { ok: false, status: 404, error: "Staff answer not found" };
  const answer = row as StaffAnswerRow;
  if (answer.source !== "whatsapp" || !answer.source_event_id) {
    return { ok: false, status: 409, error: "Only answers received from the staff WhatsApp group can be retried." };
  }

  const { data: esc, error: escError } = await agentDb()
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("id", answer.escalation_id)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (escError) return { ok: false, status: 500, error: escError.message };
  if (!esc) return { ok: false, status: 404, error: "Escalation not found" };
  const escalation = esc as EscalationRow;

  // Everything this answer's own event queued for a customer, whatever happened to it since.
  const created = await outboxForEvent(answer.source_event_id);
  const relayRows = created.filter((r) => r.business_slug === businessSlug && r.kind !== "staff_notice" && r.kind !== "staff_draft" && r.kind !== "staff_feedback");
  const senderAuth: SenderAuthorization = {
    authorized: isSenderIdAuthorized(settings.staff_authorized_senders, answer.sender_id),
    senderId: answer.sender_id,
  };
  const verdict = decideRetry({
    state: answer.state,
    command: answer.command,
    escalationStatus: escalation.status,
    relayRows: relayRows.map((r) => ({ status: r.status, error: (r as { error?: string | null }).error ?? null })),
    senderStillAuthorized: senderAuth.authorized,
  });
  if (!verdict.ok) return { ok: false, status: 409, error: RETRY_REFUSAL_TEXT[verdict.reason] };

  // One retry wins; a second click (or admin) finds it already claimed.
  const claimed = await claimAnswerRetry(businessSlug, answer.id);
  if (!claimed) return { ok: false, status: 409, error: "This answer is already being retried." };

  const ctx: Ctx = {
    settings,
    text: claimed.body,
    quotedMessageId: null,
    senderJid: claimed.sender_jid,
    eventId: claimed.source_event_id!,
    whatsappMessageId: claimed.source_message_id,
    timestamp: claimed.staff_message_at,
    escalation,
    via: claimed.matched_via === "quote" ? "quote" : "ref",
    quotedDraft: null,
    senderAuth,
  };
  try {
    const result = claimed.command === "send" ? await handleSend(ctx, claimed.body, claimed) : await handleAnswer(ctx, claimed.body, claimed);
    const allowed = result.outbox.filter((o) => outboxAllowed(settings, o));
    const rows = await enqueue(allowed, false);
    await audit(businessSlug, "admin", args.adminId, "staff_answer.retry", { type: "staff_answer", id: claimed.id }, {
      ref_code: claimed.ref_code,
      outcome: result.outcome,
      queued: rows.map((r) => r.kind),
    });
    return { ok: true, message: `Retried #${claimed.ref_code}: ${result.outcome.replace("matched:", "").replace(/_/g, " ")}.`, queued: rows.length };
  } catch (err) {
    await failStaffAnswer(claimed, err);
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Retry failed" };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function staffDraftItem(ctx: Ctx, body: string, dedupeKey: string): OutboxInsert {
  const groupJid = ctx.settings.staff_group_jid!;
  return {
    businessSlug: ctx.escalation.business_slug,
    chatId: ctx.escalation.chat_id,
    kind: "staff_draft",
    toJid: groupJid,
    body,
    // Content-keyed: the identical draft for the same escalation is posted once.
    dedupeKey,
    eventId: ctx.eventId,
    escalationId: ctx.escalation.id,
    replyToMessageId: ctx.whatsappMessageId,
  };
}

/** Quiet by design: past a handful of drafts for one escalation the rest are recorded, not posted. */
async function withinDraftCap(e: EscalationRow): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_outbox")
    .select("id")
    .eq("business_slug", e.business_slug)
    .eq("escalation_id", e.id)
    .eq("kind", "staff_draft")
    .limit(MAX_DRAFTS_PER_ESCALATION);
  if (error) throw new Error(error.message);
  return (data ?? []).length < MAX_DRAFTS_PER_ESCALATION;
}
