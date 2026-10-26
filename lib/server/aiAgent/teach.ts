// Server-only: business learning from WhatsApp. Three ways a fact reaches the learning candidates, and ONE
// way it becomes knowledge:
//
//   !teach <fact>          an authorized staff member proposes a fact       → candidate (pending)
//   passive extraction     a fact stated by authorized staff in the staff   → candidate (pending, silent)
//                          group, or by the business itself in a customer
//                          chat, when the admin enabled that scope
//   admin dashboard        (unchanged) staff-answer candidates              → candidate (pending)
//
//   !confirm K-XXXX        approveCandidate() (lib/server/aiAgent/learning.ts) — the SAME approval the
//                          dashboard uses: duplicates dropped, conflicts need an explicit replace/keep,
//                          temporary facts expire. Confirming from WhatsApp is its own opt-in setting.
//
// Nothing a customer writes ever reaches here (customer messages never go through the staff paths), a
// candidate is never knowledge until confirmed, and a candidate lapses if nobody confirms it. Customer
// confirmation of a DRAFT (!approve) is a different permission and a different flow (pilot.ts).

import { randomBytes } from "crypto";
import { canSendApproved, looksLikeAgentMessage, type AgentSettings } from "@/lib/aiAgent/engine";
import type { SenderAuthorization } from "@/lib/aiAgent/identity";
import {
  generateKnowledgeCode,
  parseConfirmArgs,
  parseTeach,
  passiveScopeAllows,
  PASSIVE_CALLS_PER_HOUR,
  passiveWorthLooking,
  PROPOSAL_TTL_DAYS,
  suggestKind,
  suggestTitle,
} from "@/lib/aiAgent/pilot";
import { assessKnowledgeCandidate, candidateFingerprint, type KnowledgeConflict, statesTemporaryCondition, validateStaffItems } from "@/lib/aiAgent/staffAnswers";
import { agentDb, audit, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { loadGateData } from "@/lib/server/aiAgent/gateData";
import { approvedKnowledgeLite, approveCandidate } from "@/lib/server/aiAgent/learning";
import type { OutboxInsert } from "@/lib/server/aiAgent/outbox";
import { analyze } from "@/lib/server/aiAgent/staffKnowledge";

export interface TeachResult {
  outbox: OutboxInsert[];
  outcome: string;
}

export type CandidateSource = "whatsapp_teach" | "passive_staff_group" | "passive_staff_chat" | "auto_staff_chat";

export interface CandidateRowLite {
  id: string;
  short_code: string | null;
  staff_answer: string;
  suggested_kind: string | null;
  suggested_title: string | null;
  status: string;
  source: string;
  fact_expires_at: string | null;
  proposal_expires_at: string | null;
  conflicts: KnowledgeConflict[];
}

const CANDIDATE_LITE = "id, short_code, staff_answer, suggested_kind, suggested_title, status, source, fact_expires_at, proposal_expires_at, conflicts";

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function expiryText(iso: string | null): string {
  if (!iso) return "permanent";
  return `until ${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A fact that carries a phone number, e-mail or link is about a person or a page, not the business. */
export function looksPrivate(fact: string): boolean {
  return /\d{9,}/.test(fact.replace(/[\s-]/g, "")) || /@\w+\.\w+|https?:\/\/|\bwww\./i.test(fact);
}

function feedbackItem(settings: AgentSettings, businessSlug: string, eventId: string, body: string, escalationId: string | null = null, suffix = "staff_feedback"): OutboxInsert {
  return {
    businessSlug,
    chatId: settings.staff_group_jid!,
    kind: "staff_feedback",
    toJid: settings.staff_group_jid!,
    body,
    dedupeKey: `${eventId}:${suffix}`,
    eventId,
    escalationId,
  };
}

/** Speaks in the staff group only where staff-group feedback is permitted (Approval Pilot, Assisted); Observe stays silent. */
function say(settings: AgentSettings, eventId: string, body: string, outcome: string, escalationId: string | null = null): TeachResult {
  return { outbox: canSendApproved(settings) && settings.staff_group_jid ? [feedbackItem(settings, settings.business_slug, eventId, body, escalationId)] : [], outcome };
}

async function expireLapsed(businessSlug: string): Promise<void> {
  const { error } = await agentDb()
    .from("ai_agent_learning_candidates")
    .update({ status: "expired" })
    .eq("business_slug", businessSlug)
    .eq("status", "pending")
    .not("proposal_expires_at", "is", null)
    .lte("proposal_expires_at", new Date().toISOString());
  if (error) console.error("[aiAgent] expireLapsed", error.message);
}

/** Stores one candidate, assessed against today's approved knowledge. Returns null when it is already known or already proposed. */
export async function storeCandidate(args: {
  settings: AgentSettings;
  source: CandidateSource;
  fact: string;
  kind: string;
  title: string;
  expiresAt: string | null;
  confidence: number;
  proposedBy: string | null;
  /** false = taken from the business account's own messages: no individual sender identity. */
  senderVerified?: boolean;
  escalation: { id: string; ref_code: string } | null;
  sourceMessageId: string;
  sourceMessageAt: string | null;
  /** The staff's own words; only stored for an explicit !teach (never for passive extraction). */
  sourceText: string | null;
  /** Automatic learning: why a person must decide (REVIEW_REASON_TEXT key), and the fact's identity (product + figures). */
  reviewReason?: string | null;
  fingerprint?: string;
  now?: Date;
}): Promise<{ row: CandidateRowLite; conflicts: KnowledgeConflict[] } | { known: string } | { proposed: CandidateRowLite }> {
  const now = args.now ?? new Date();
  const businessSlug = args.settings.business_slug;
  const approved = await approvedKnowledgeLite(businessSlug);
  const assessment = assessKnowledgeCandidate({ kind: args.kind, title: args.title, content: args.fact }, approved);
  if (assessment.duplicateOf) return { known: assessment.duplicateOf.title };
  // A temporary fact expires on its own; it is not compared against permanent rules.
  const conflicts = args.expiresAt ? [] : assessment.conflicts;
  const fingerprint = args.fingerprint ?? candidateFingerprint(args.fact);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await agentDb()
      .from("ai_agent_learning_candidates")
      .insert({
        business_slug: businessSlug,
        escalation_id: args.escalation?.id ?? null,
        question: null,
        staff_answer: args.fact,
        category: "durable",
        suggested_kind: args.kind,
        suggested_title: args.title,
        source_message: args.sourceText ? args.sourceText.slice(0, 2000) : null,
        source_message_at: args.sourceMessageAt,
        source_message_id: args.sourceMessageId,
        ref_code: args.escalation?.ref_code ?? null,
        fingerprint,
        conflicts,
        source: args.source,
        proposed_by: args.proposedBy,
        sender_verified: args.senderVerified !== false,
        confidence: args.confidence,
        proposal_expires_at: new Date(now.getTime() + PROPOSAL_TTL_DAYS * 86_400_000).toISOString(),
        fact_expires_at: args.expiresAt,
        review_reason: args.reviewReason ?? null,
        short_code: generateKnowledgeCode(randomBytes(4)),
      })
      .select(CANDIDATE_LITE)
      .single();
    if (!error) return { row: data as CandidateRowLite, conflicts };
    if (error.code !== "23505") throw new Error(error.message);
    // Unique violation: either the same fact is already pending, or the short code collided.
    const { data: existing } = await agentDb()
      .from("ai_agent_learning_candidates")
      .select(CANDIDATE_LITE)
      .eq("business_slug", businessSlug)
      .eq("fingerprint", fingerprint)
      .eq("status", "pending")
      .limit(1);
    const hit = ((existing ?? []) as CandidateRowLite[])[0];
    if (hit) return { proposed: hit };
  }
  throw new Error("Could not allocate a knowledge code");
}

// ── !teach ───────────────────────────────────────────────────────────────────

export async function handleTeach(args: {
  settings: AgentSettings;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  body: string;
  escalation: { id: string; ref_code: string } | null;
  eventId: string;
  whatsappMessageId: string;
  timestamp: string | null;
}): Promise<TeachResult> {
  const { settings, senderAuth } = args;
  const say_ = (text: string, outcome: string) => say(settings, args.eventId, text, outcome, args.escalation?.id ?? null);
  if (!senderAuth.authorized) {
    await audit(settings.business_slug, "staff", args.senderJid, "teach.refused", { type: "learning" }, { reason: "sender_not_authorized", sender_id: senderAuth.senderId });
    return say_("⚠️ You're not on this business's list of people who can teach the AI from WhatsApp — nothing was saved. Ask an admin to add you.", "teach:not_authorized");
  }
  const parsed = parseTeach(args.body);
  if (!parsed.ok) {
    const why = { too_short: "That's too short to be a fact.", too_long: "That's too long — keep it to one or two sentences.", unsafe: "That can't be saved." }[parsed.reason];
    return say_(`⚠️ ${why} Nothing was saved. Example: “!teach We deliver to Gros Islet on Tuesdays.”`, `teach:${parsed.reason}`);
  }
  if (looksPrivate(parsed.fact)) {
    return say_("⚠️ That contains a phone number, e-mail or link, so it was not saved as business knowledge. Nothing was saved.", "teach:private");
  }

  await expireLapsed(settings.business_slug);
  const kind = suggestKind(parsed.fact);
  const stored = await storeCandidate({
    settings,
    source: "whatsapp_teach",
    fact: parsed.fact,
    kind,
    title: suggestTitle(parsed.fact),
    expiresAt: parsed.expiresAt,
    confidence: 1,
    proposedBy: senderAuth.senderId,
    escalation: args.escalation,
    sourceMessageId: args.whatsappMessageId,
    sourceMessageAt: args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? new Date(args.timestamp).toISOString() : null,
    sourceText: args.body,
  });
  if ("known" in stored) return say_(`ℹ️ Already in the knowledge base as “${clip(stored.known, 60)}” — nothing changed.`, "teach:already_known");
  if ("proposed" in stored) {
    return say_(`ℹ️ Already proposed as ${stored.proposed.short_code}: “${clip(stored.proposed.staff_answer, 120)}”. Reply !confirm ${stored.proposed.short_code} or !discard ${stored.proposed.short_code}.`, "teach:already_proposed");
  }
  const { row, conflicts } = stored;
  await audit(settings.business_slug, "staff", args.senderJid, "teach.propose", { type: "learning", id: row.id }, {
    code: row.short_code,
    sender_id: senderAuth.senderId,
    escalation: args.escalation?.ref_code ?? null,
    expires_at: parsed.expiresAt,
    conflicts: conflicts.map((c) => c.id),
  });
  return say_(candidateMessage(settings, row, conflicts), "teach:proposed");
}

function candidateMessage(settings: AgentSettings, row: CandidateRowLite, conflicts: KnowledgeConflict[]): string {
  const code = row.short_code!;
  const lines = [`📚 Proposed fact ${code} (${row.suggested_kind ?? "faq"} · ${expiryText(row.fact_expires_at)}):`, `“${clip(row.staff_answer, 300)}”`];
  const hard = conflicts.find((c) => c.severity === "conflict");
  if (conflicts.length > 0) {
    lines.push(`⚠️ ${hard ? "Differs from" : "Overlaps"} what's on file: “${clip(conflicts[0].title, 50)}” — ${clip(conflicts[0].reason, 120)}.`);
  }
  if (settings.knowledge_confirm_via_whatsapp === true) {
    lines.push(
      conflicts.length > 0
        ? `It is NOT used yet. Reply !confirm ${code} replace (archives the old entry) or !confirm ${code} keep (keeps both), or !discard ${code}.`
        : `It is NOT used yet. Reply !confirm ${code} to add it, or !discard ${code}.`
    );
  } else {
    lines.push("It is NOT used yet — an admin approves it in the dashboard (AI Agent → Review).");
  }
  return lines.join("\n");
}

// ── !confirm / !discard ──────────────────────────────────────────────────────

async function loadByCode(businessSlug: string, code: string): Promise<CandidateRowLite | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_learning_candidates")
    .select(CANDIDATE_LITE)
    .eq("business_slug", businessSlug)
    .eq("short_code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CandidateRowLite | null) ?? null;
}

export async function handleConfirm(args: {
  settings: AgentSettings;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  body: string;
  eventId: string;
}): Promise<TeachResult> {
  const { settings, senderAuth } = args;
  const say_ = (text: string, outcome: string) => say(settings, args.eventId, text, outcome);
  if (settings.knowledge_confirm_via_whatsapp !== true) {
    return say_("ℹ️ Confirming knowledge from WhatsApp is switched off for this business — an admin approves it in the dashboard. Nothing was changed.", "confirm:disabled");
  }
  if (!senderAuth.authorized) {
    await audit(settings.business_slug, "staff", args.senderJid, "confirm.refused", { type: "learning" }, { reason: "sender_not_authorized", sender_id: senderAuth.senderId });
    return say_("⚠️ You're not on this business's list of people who can confirm knowledge — nothing was changed.", "confirm:not_authorized");
  }
  const parsed = parseConfirmArgs(args.body);
  if (!parsed.ok) {
    const why = { no_code: "Which fact? Include its code, e.g. “!confirm K-AB3D”.", several_codes: "Confirm one fact at a time.", bad_option: "Use “!confirm K-XXXX”, “!confirm K-XXXX replace” or “!confirm K-XXXX keep”." }[parsed.reason];
    return say_(`⚠️ ${why} Nothing was changed.`, `confirm:${parsed.reason}`);
  }
  await expireLapsed(settings.business_slug);
  const row = await loadByCode(settings.business_slug, parsed.code);
  if (!row) return say_(`⚠️ I don't have a fact ${parsed.code} for this business. Nothing was changed.`, "confirm:unknown_code");
  if (row.status === "expired") return say_(`⚠️ ${parsed.code} expired before it was confirmed. Teach it again if it's still true.`, "confirm:expired");
  if (row.status !== "pending") return say_(`ℹ️ ${parsed.code} was already ${row.status}.`, "confirm:already_reviewed");

  // Replacing is explicit and exact: only the single entry the comparison found, only when asked.
  let replaceKnowledgeId: string | null = null;
  if (parsed.resolution === "replace") {
    const approved = await approvedKnowledgeLite(settings.business_slug);
    const found = assessKnowledgeCandidate(
      { kind: row.suggested_kind ?? "faq", title: row.suggested_title ?? "", content: row.staff_answer },
      approved
    ).conflicts;
    if (found.length !== 1) {
      return say_(
        found.length === 0
          ? `⚠️ ${parsed.code} doesn't overlap anything on file, so there is nothing to replace. Reply !confirm ${parsed.code}.`
          : `⚠️ ${parsed.code} overlaps ${found.length} entries, so I won't guess which to replace — use the dashboard (AI Agent → Review). Nothing was changed.`,
        "confirm:replace_ambiguous"
      );
    }
    replaceKnowledgeId = found[0].id;
  }
  const result = await approveCandidate({
    businessSlug: settings.business_slug,
    candidateId: row.id,
    adminId: null,
    via: "whatsapp",
    senderId: senderAuth.senderId,
    kind: row.suggested_kind ?? "faq",
    title: row.suggested_title ?? suggestTitle(row.staff_answer),
    content: row.staff_answer,
    resolution: parsed.resolution,
    replaceKnowledgeId,
  });
  if (!result.ok) {
    const overlap = result.conflicts?.[0];
    return say_(
      overlap
        ? `⚠️ ${parsed.code} overlaps “${clip(overlap.title, 50)}” (${clip(overlap.reason, 100)}). Reply !confirm ${parsed.code} replace or !confirm ${parsed.code} keep. Nothing was changed.`
        : `⚠️ ${clip(result.error, 200)} Nothing was changed.`,
      "confirm:refused"
    );
  }
  return say_(
    `✅ ${parsed.code} added to the knowledge base (${expiryText(row.fact_expires_at)}).${result.archivedId ? " The old entry was archived." : ""} The AI can use it from the next customer message.`,
    "confirm:approved"
  );
}

export async function handleDiscard(args: {
  settings: AgentSettings;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  body: string;
  eventId: string;
}): Promise<TeachResult> {
  const { settings, senderAuth } = args;
  const say_ = (text: string, outcome: string) => say(settings, args.eventId, text, outcome);
  if (!senderAuth.authorized) return say_("⚠️ You're not on this business's list of people who can manage knowledge — nothing was changed.", "discard:not_authorized");
  const parsed = parseConfirmArgs(args.body);
  if (!parsed.ok || parsed.resolution !== "none") return say_("⚠️ Use “!discard K-XXXX” with one fact's code. Nothing was changed.", "discard:bad_arguments");
  const { data, error } = await agentDb()
    .from("ai_agent_learning_candidates")
    .update({ status: "rejected", reviewed_at: new Date().toISOString(), approved_by_sender: senderAuth.senderId, approved_via: "whatsapp" })
    .eq("business_slug", settings.business_slug)
    .eq("short_code", parsed.code)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) return say_(`ℹ️ ${parsed.code} isn't waiting for a decision (unknown, already decided, or expired).`, "discard:nothing");
  await audit(settings.business_slug, "staff", args.senderJid, "learning.reject", { type: "learning", id: (data as { id: string }[])[0].id }, { via: "whatsapp", code: parsed.code, sender_id: senderAuth.senderId });
  return say_(`🗑️ ${parsed.code} discarded — it will not be used.`, "discard:rejected");
}

// ── Passive extraction ───────────────────────────────────────────────────────

async function passiveCallsLastHour(businessSlug: string): Promise<number> {
  const { count, error } = await agentDb()
    .from("ai_agent_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("business_slug", businessSlug)
    .eq("action", "learning.passive_scan")
    .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Looks at ONE staff message for reusable business facts and stores any it finds as PENDING candidates. It
 * never approves anything, never reads a customer's message, and stores only the extracted fact (no chat text,
 * no chat id). Costs at most one model call, only for a message that passes the free pre-filter, and at most
 * PASSIVE_CALLS_PER_HOUR per business per hour. Best effort: errors are logged and never affect the message.
 *
 *   staff_group: a message in the business's staff group from an authorized sender
 *   staff_chat:  a message the business itself sent in a customer's chat (the linked phone / the inbox)
 */
export async function maybeExtractPassive(args: {
  settings: AgentSettings;
  source: "staff_group" | "staff_chat";
  text: string;
  senderAuth: SenderAuthorization | null;
  /** A staff-group message sent from the business account itself: its author cannot be verified. */
  unverifiedSender?: boolean;
  senderJid: string | null;
  /** staff_chat only: the customer chat (used for the contact-exclusion check, never stored). */
  chatId?: string | null;
  contactNumber?: string | null;
  eventId: string;
  whatsappMessageId: string;
  timestamp: string | null;
  now?: Date;
}): Promise<TeachResult> {
  const none: TeachResult = { outbox: [], outcome: "passive:skipped" };
  const { settings } = args;
  try {
    // The business account's own messages (customer chats, or the linked phone in the staff group) never prove WHO
    // said something. They are only ever unverified suggestions, and only when the admin chose the widest scope.
    const unverified = args.source === "staff_chat" || args.unverifiedSender === true;
    if (!settings.enabled || !passiveScopeAllows(settings.passive_learning_scope, unverified ? "staff_chat" : args.source)) return none;
    if (!unverified && !args.senderAuth?.authorized) return none;
    if (looksLikeAgentMessage(args.text) || !passiveWorthLooking(args.text)) return none;
    if (args.source === "staff_chat") {
      if (!args.chatId || args.chatId.endsWith("@g.us")) return none;
      const gate = await loadGateData(settings.business_slug, args.chatId, args.contactNumber ?? null, settings);
      if (gate.contactRule === "exclude") return none;
    }
    if ((await passiveCallsLastHour(settings.business_slug)) >= PASSIVE_CALLS_PER_HOUR) return { outbox: [], outcome: "passive:budget" };

    const now = args.now ?? new Date();
    // Counted before the call, so a failing model cannot be hammered.
    await audit(settings.business_slug, "system", null, "learning.passive_scan", { type: "message", id: args.whatsappMessageId }, { source: args.source, sender_verified: !unverified });
    const knowledge = await loadActiveKnowledge(settings.business_slug);
    const result = await analyze({
      businessSlug: settings.business_slug,
      mode: "classify_only",
      staffText: args.text,
      customerName: "the customer",
      customerMessages: "",
      transcript: [],
      knowledge,
      liveFacts: [],
    });
    if (!result.analysis) return { outbox: [], outcome: "passive:no_analysis" };
    const { accepted } = validateStaffItems(result.analysis.items, args.text, now, null);

    const source: CandidateSource = args.source === "staff_group" ? "passive_staff_group" : "passive_staff_chat";
    const stored: { code: string; text: string }[] = [];
    for (const item of accepted) {
      // Only reusable BUSINESS facts: never a customer's, a one-off deal, or a temporary fact meant for one conversation.
      const durable = item.category === "durable";
      const businessTemporary = item.category === "temporary" && item.scope === "business" && Boolean(item.validUntil);
      if (!durable && !businessTemporary) continue;
      if (looksPrivate(item.content)) continue;
      const expiresAt = businessTemporary ? item.validUntil! : null;
      if (durable && statesTemporaryCondition(item.content)) continue; // a "today" fact the model called durable: not permanent knowledge
      const out = await storeCandidate({
        settings,
        source,
        fact: item.content,
        kind: item.kind ?? suggestKind(item.content),
        title: item.title || suggestTitle(item.content),
        expiresAt,
        confidence: unverified ? 0.3 : 0.5,
        proposedBy: unverified ? null : (args.senderAuth?.senderId ?? null),
        senderVerified: !unverified,
        escalation: null,
        sourceMessageId: args.whatsappMessageId,
        sourceMessageAt: args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? new Date(args.timestamp).toISOString() : null,
        sourceText: null,
        now,
      });
      if ("row" in out) stored.push({ code: out.row.short_code!, text: out.row.staff_answer });
    }
    if (stored.length === 0) return { outbox: [], outcome: "passive:nothing" };
    await audit(settings.business_slug, "system", null, "learning.passive", { type: "message", id: args.whatsappMessageId }, {
      source: args.source,
      codes: stored.map((s) => s.code),
      sender_id: unverified ? null : (args.senderAuth?.senderId ?? null),
      sender_verified: !unverified,
      auto_approved: false,
    });
    // Routine suggestions never post to the staff group one by one: they wait in the dashboard (AI Agent → Review) and
    // the next learning digest carries their count. Only an explicit !teach is answered in the group.
    return { outbox: [], outcome: "passive:proposed" };
  } catch (err) {
    console.error("[aiAgent] maybeExtractPassive", err instanceof Error ? err.message : err);
    return none;
  }
}
