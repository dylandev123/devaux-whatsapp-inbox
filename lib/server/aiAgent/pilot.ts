// Server-only: Approval Pilot. The AI never messages a customer in this mode; it proposes DRAFT VERSIONS
// (ai_agent_pilot_drafts) and an explicitly authorized staff member's !approve / !send is the only way one
// reaches a customer. There is no second send path: every send goes through planCustomerSend()
// (lib/server/aiAgent/customerSend.ts) and becomes a staff_relay outbox row, exactly like Assisted's "!send".
//
// A draft version is immutable text. Approval is one atomic compare-and-set in SQL
// (approve_ai_agent_pilot_draft) bound to the draft's id AND text hash, which also creates the outbox row in
// the same transaction — so two approvals, a retried command, or an edit racing an approval can never send
// twice or send text the approver did not see.

import { createHash } from "crypto";
import { canSendApproved, outboxAllowed } from "@/lib/aiAgent/engine";
import type { AgentSettings } from "@/lib/aiAgent/engine";
import {
  assessDraftReadiness,
  buildPilotDraftPost,
  buildStatusLine,
  type DraftReadiness,
  inferVerdict,
  noteTexts,
  parseApproveArgs,
  parseEditArgs,
  parseRejectArgs,
  PILOT_REFUSAL_TEXT,
  type PilotRefusal,
} from "@/lib/aiAgent/pilot";
import { checkExactSendSafety, WITHHOLD_TEXT } from "@/lib/aiAgent/staffAnswers";
import type { SenderAuthorization } from "@/lib/aiAgent/identity";
import { agentDb, audit, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { customerWroteAfter, planCustomerSend } from "@/lib/server/aiAgent/customerSend";
import { type EscalationRow, markEscalationAnswered } from "@/lib/server/aiAgent/escalations";
import { type OutboxInsert, type OutboxRow, outboxRowById } from "@/lib/server/aiAgent/outbox";

export const PILOT_DRAFT_KEY_PREFIX = "pilotdraft:";

export interface PilotDraftRow {
  id: string;
  business_slug: string;
  escalation_id: string;
  chat_id: string;
  version: number;
  source: "ai" | "staff_edit" | "staff_answer";
  body: string;
  body_hash: string;
  ready: boolean;
  confirm_notes: string[];
  knowledge_ids: string[];
  knowledge_version: string | null;
  basis_at: string;
  valid_until: string | null;
  created_by: string | null;
  status: "current" | "approved" | "rejected" | "superseded";
  decided_by: string | null;
  decided_at: string | null;
  decision_message_id: string | null;
  final_text: string | null;
  approval_outbox_id: string | null;
  outcome: string | null;
  verdict: "correct" | "missing_information" | "factually_wrong" | null;
  verdict_source: "staff" | "inferred" | "admin" | null;
  verdict_note: string | null;
  created_at: string;
  /** Set once the 90-day retention policy blanked the wording; such a draft can never be approved. */
  content_purged_at: string | null;
}

export const PILOT_DRAFT_COLUMNS =
  "id, business_slug, escalation_id, chat_id, version, source, body, body_hash, ready, confirm_notes, knowledge_ids, knowledge_version, basis_at, valid_until, created_by, status, decided_by, decided_at, decision_message_id, final_text, approval_outbox_id, outcome, verdict, verdict_source, verdict_note, created_at, content_purged_at";

export const bodyHash = (body: string) => createHash("sha256").update(body.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 24);

// ── Draft store ──────────────────────────────────────────────────────────────

export async function currentDraft(businessSlug: string, escalationId: string): Promise<PilotDraftRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .select(PILOT_DRAFT_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("status", "current")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PilotDraftRow | null) ?? null;
}

export async function draftById(businessSlug: string, escalationId: string, id: string): Promise<PilotDraftRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .select(PILOT_DRAFT_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PilotDraftRow | null) ?? null;
}

export async function draftByVersion(businessSlug: string, escalationId: string, version: number): Promise<PilotDraftRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .select(PILOT_DRAFT_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .eq("version", version)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PilotDraftRow | null) ?? null;
}

async function nextVersion(businessSlug: string, escalationId: string): Promise<number> {
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .select("version")
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as { version: number } | undefined)?.version ?? 0;
}

/** The AI's own proposal for the turn, as stored on the escalation when it was opened (no model call). */
export interface DraftMeta {
  ready: boolean;
  notes: string[];
  knowledge_ids: string[];
  knowledge_version: string | null;
}

export function draftMetaFrom(readiness: DraftReadiness, knowledgeIds: string[], knowledgeVersion: string | null): DraftMeta {
  return { ready: readiness.ready, notes: readiness.notes, knowledge_ids: knowledgeIds, knowledge_version: knowledgeVersion };
}

export { assessDraftReadiness };

/**
 * Version 1: the AI's independent suggestion, created once when the first staff notice is posted. It is only
 * created while it still answers the customer's whole request (no follow-up message since the escalation
 * opened). Idempotent: a second call finds version 1 and creates nothing.
 */
export async function ensureAiDraft(e: EscalationRow): Promise<PilotDraftRow | null> {
  const body = e.proposed_reply?.trim();
  if (!body) return null;
  const updates = Array.isArray(e.context.updates) ? (e.context.updates as unknown[]) : [];
  if (updates.length > 0) return null;
  const existing = await draftByVersion(e.business_slug, e.id, 1);
  if (existing) return existing;
  const meta = (e.context.draft_meta ?? null) as Partial<DraftMeta> | null;
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .upsert(
      {
        business_slug: e.business_slug,
        escalation_id: e.id,
        chat_id: e.chat_id,
        version: 1,
        source: "ai",
        body: body.slice(0, 2000),
        body_hash: bodyHash(body),
        // No stored assessment (an older escalation) = not vouched for.
        ready: meta?.ready === true,
        confirm_notes: meta?.ready === true ? [] : (meta?.notes?.length ? meta.notes : ["The AI's draft was not checked against approved knowledge"]),
        knowledge_ids: meta?.knowledge_ids ?? [],
        knowledge_version: meta?.knowledge_version ?? null,
        basis_at: e.created_at,
        created_by: "ai",
      },
      { onConflict: "escalation_id,version", ignoreDuplicates: true }
    )
    .select(PILOT_DRAFT_COLUMNS);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as PilotDraftRow | undefined) ?? (await draftByVersion(e.business_slug, e.id, 1));
}

/**
 * The moment a follow-up draft's answer is based on: the newest customer event of the turn, or the follow-up recorded on
 * the escalation, whichever is later. Every inbound message the agent was handed is logged as an event when it arrives,
 * and every follow-up is stamped when it is recorded, so a draft based on this moment goes stale on ANY later customer
 * message (customerWroteAfter), including one that arrived while the AI was still thinking.
 */
export async function turnBasisAt(eventIds: string[], escalation: Pick<EscalationRow, "context">): Promise<string> {
  let latest = 0;
  const ids = eventIds.filter(Boolean);
  if (ids.length > 0) {
    const { data, error } = await agentDb().from("ai_agent_events").select("created_at").in("id", ids).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    latest = Date.parse((data ?? [])[0]?.created_at ?? "") || 0;
  }
  const updates = Array.isArray(escalation.context.updates) ? (escalation.context.updates as { at?: string }[]) : [];
  for (const u of updates) latest = Math.max(latest, Date.parse(u?.at ?? "") || 0);
  return new Date(latest || Date.now()).toISOString();
}

/**
 * Approval Pilot, multi-message conversations: the customer wrote again while staff had not acted yet. The AI has
 * answered the NEW state of the conversation, and that answer becomes the next draft version (the previous one is
 * superseded and kept as history, so Evaluation still shows what it first suggested). Never touches a draft that
 * was written after the customer's latest message (staff's own newer edit wins), and creates nothing twice for a
 * redelivered batch (same text and basis = the same draft).
 */
export async function createFollowUpAiDraft(args: {
  escalation: EscalationRow;
  reply: string | null;
  meta: DraftMeta | null;
  basisAt: string;
}): Promise<PilotDraftRow | null> {
  const body = args.reply?.trim();
  if (!body) return null;
  const e = args.escalation;
  const current = await currentDraft(e.business_slug, e.id);
  // Already based on the customer's latest message (a redelivered batch, or staff's own newer wording): leave it.
  if (current && Date.parse(current.basis_at) >= Date.parse(args.basisAt)) return current;
  const ready = args.meta?.ready === true;
  return createDraftVersion({
    escalation: e,
    source: "ai",
    body: body.slice(0, 2000),
    ready,
    notes: ready ? [] : args.meta?.notes?.length ? args.meta.notes : ["The AI's draft was not checked against approved knowledge"],
    createdBy: "ai",
    now: new Date(args.basisAt),
    knowledgeIds: args.meta?.knowledge_ids ?? [],
    knowledgeVersion: args.meta?.knowledge_version ?? null,
  });
}

/** The draft a staff notice showed: the newest draft that existed when the notice was posted (notices are posted right after their draft). */
export async function draftShownByNotice(businessSlug: string, escalationId: string, noticeAt: string | null): Promise<PilotDraftRow | null> {
  if (!noticeAt) return draftByVersion(businessSlug, escalationId, 1);
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .select(PILOT_DRAFT_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("escalation_id", escalationId)
    .lte("created_at", noticeAt)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as PilotDraftRow | undefined) ?? (await draftByVersion(businessSlug, escalationId, 1));
}

/**
 * A new draft version: replaces whatever was current. The replaced draft is kept, unchanged, with what
 * happened to it (an edit, or superseded) — history is never rewritten.
 */
export async function createDraftVersion(args: {
  escalation: EscalationRow;
  source: "ai" | "staff_edit" | "staff_answer";
  body: string;
  ready: boolean;
  notes: string[];
  createdBy: string | null;
  validUntil?: string | null;
  now?: Date;
  /** The AI's follow-up draft only: what it was written from (like version 1). */
  knowledgeIds?: string[];
  knowledgeVersion?: string | null;
}): Promise<PilotDraftRow> {
  const e = args.escalation;
  const db = agentDb();
  const hash = bodyHash(args.body);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await currentDraft(e.business_slug, e.id);
    if (prior) {
      // Closing the old version first lets the unique "one current draft" index admit the new one.
      const edited = args.source === "staff_edit";
      const verdict = edited && prior.source === "ai" && !prior.verdict ? inferVerdict(prior.body, args.body) : null;
      const { error } = await db
        .from("ai_agent_pilot_drafts")
        .update({
          status: "superseded",
          outcome: edited ? "edited" : "superseded",
          // A newer AI suggestion is not what reached the customer: only staff wording is a "final text".
          final_text: args.source === "ai" ? null : args.body,
          decided_by: args.createdBy,
          decided_at: new Date().toISOString(),
          ...(verdict ? { verdict, verdict_source: "inferred" } : {}),
        })
        .eq("id", prior.id)
        .eq("status", "current");
      if (error) throw new Error(error.message);
    }
    const version = (await nextVersion(e.business_slug, e.id)) + 1;
    const { data, error } = await db
      .from("ai_agent_pilot_drafts")
      .insert({
        business_slug: e.business_slug,
        escalation_id: e.id,
        chat_id: e.chat_id,
        version,
        source: args.source,
        body: args.body.slice(0, 2000),
        body_hash: hash,
        ready: args.ready,
        confirm_notes: args.ready ? [] : args.notes,
        ...(args.source === "ai" ? { knowledge_ids: args.knowledgeIds ?? [], knowledge_version: args.knowledgeVersion ?? null } : {}),
        basis_at: (args.now ?? new Date()).toISOString(),
        valid_until: args.validUntil ?? null,
        created_by: args.createdBy,
      })
      .select(PILOT_DRAFT_COLUMNS)
      .single();
    if (!error) return data as PilotDraftRow;
    // 23505: a concurrent edit took the version / the current slot. Re-read and try again.
    if (error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not create a draft version");
}

/** A staff member sent their own exact wording: the current draft is replaced by it (evaluation: replaced_by_staff_text). */
export async function recordStaffTextSent(e: EscalationRow, text: string, actorId: string | null): Promise<void> {
  const prior = await currentDraft(e.business_slug, e.id);
  if (!prior) return;
  const verdict = prior.source === "ai" && !prior.verdict ? inferVerdict(prior.body, text) : null;
  const { error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .update({
      status: "superseded",
      outcome: "replaced_by_staff_text",
      final_text: text.slice(0, 2000),
      decided_by: actorId,
      decided_at: new Date().toISOString(),
      ...(verdict ? { verdict, verdict_source: "inferred" } : {}),
    })
    .eq("id", prior.id)
    .eq("status", "current");
  if (error) throw new Error(error.message);
}

// ── The command context ──────────────────────────────────────────────────────

export interface PilotCtx {
  settings: AgentSettings;
  escalation: EscalationRow;
  senderJid: string | null;
  senderAuth: SenderAuthorization;
  eventId: string;
  whatsappMessageId: string;
  /** The staff message quoted a staff_draft we posted for a pilot draft: that draft's id. */
  quotedDraftId: string | null;
  /** The quoted message was one of our escalation notices: it shows the draft that existed when it was posted. */
  quotedNotice: boolean;
  /** When that notice was created (to find the draft it showed); null if unknown. */
  quotedNoticeAt?: string | null;
}

export interface PilotResult {
  outbox: OutboxInsert[];
  queued: OutboxRow[];
  outcome: string;
}

const label = (e: EscalationRow) => e.customer_name ?? e.contact_number ?? e.chat_id;

function feedback(ctx: PilotCtx, body: string): OutboxInsert {
  const e = ctx.escalation;
  return {
    businessSlug: e.business_slug,
    chatId: ctx.settings.staff_group_jid!,
    kind: "staff_feedback",
    toJid: ctx.settings.staff_group_jid!,
    body,
    dedupeKey: `${ctx.eventId}:staff_feedback`,
    eventId: ctx.eventId,
    escalationId: e.id,
  };
}

/** Pilot commands only speak where the business may send staff-group feedback (Approval Pilot and Assisted). */
function reply(ctx: PilotCtx, body: string, outcome: string): PilotResult {
  return { outbox: canSendApproved(ctx.settings) ? [feedback(ctx, body)] : [], queued: [], outcome };
}

function refuse(ctx: PilotCtx, why: PilotRefusal, extra?: string): PilotResult {
  return reply(ctx, PILOT_REFUSAL_TEXT[why](ctx.escalation.ref_code, extra), `pilot:refused_${why}`);
}

async function guard(ctx: PilotCtx, command: string, needsAuthorization: boolean): Promise<PilotResult | null> {
  if (ctx.settings.mode !== "approval_pilot") return refuse(ctx, "not_in_pilot");
  if (needsAuthorization && !ctx.senderAuth.authorized) {
    await audit(ctx.escalation.business_slug, "staff", ctx.senderJid, `pilot.${command}_refused`, { type: "escalation", id: ctx.escalation.id }, {
      ref_code: ctx.escalation.ref_code,
      reason: "sender_not_authorized",
      sender_id: ctx.senderAuth.senderId,
    });
    return refuse(ctx, "not_authorized");
  }
  return null;
}

type Target = { ok: true; draft: PilotDraftRow } | { ok: false; result: PilotResult };

/**
 * Which draft a command means — never a guess:
 *   a quoted DRAFT → exactly that version (if it is no longer current, refuse and say which is);
 *   a quoted NOTICE → the draft that notice showed (version 1 for the first notice, the AI's newer suggestion for an update);
 *   an explicit #E- code → the escalation's current draft;
 * and an explicit "v2" must match whatever the above resolved to.
 */
async function resolveTarget(ctx: PilotCtx, version: number | null): Promise<Target> {
  const e = ctx.escalation;
  const current = await currentDraft(e.business_slug, e.id);
  let draft: PilotDraftRow | null;
  if (ctx.quotedDraftId) {
    draft = await draftById(e.business_slug, e.id, ctx.quotedDraftId);
  } else if (ctx.quotedNotice) {
    draft = await draftShownByNotice(e.business_slug, e.id, ctx.quotedNoticeAt ?? null);
  } else {
    draft = current;
  }
  if (!draft) return { ok: false, result: refuse(ctx, current ? "draft_replaced" : "no_draft", current ? `v${current.version}` : undefined) };
  if (version !== null && version !== draft.version) {
    return { ok: false, result: refuse(ctx, "wrong_version", `that points at v${draft.version}, not v${version}${current ? ` (current is v${current.version})` : ""}`) };
  }
  if (draft.status === "approved") return { ok: false, result: refuse(ctx, "already_approved") };
  if (draft.status !== "current") return { ok: false, result: refuse(ctx, "draft_replaced", current ? `v${current.version}` : undefined) };
  return { ok: true, draft };
}

// ── !approve ─────────────────────────────────────────────────────────────────

/** True when a knowledge entry the draft cited is gone (archived/expired) or was edited after the draft was written. */
async function citedKnowledgeChanged(businessSlug: string, draft: PilotDraftRow): Promise<boolean> {
  if (draft.knowledge_ids.length === 0) return false;
  const active = new Map((await loadActiveKnowledge(businessSlug)).map((k) => [k.id, k.updated_at]));
  const wroteAt = Date.parse(draft.created_at);
  return draft.knowledge_ids.some((id) => {
    const updated = active.get(id);
    return !updated || (Number.isFinite(wroteAt) && Date.parse(updated) > wroteAt);
  });
}

export async function handleApprove(ctx: PilotCtx, body: string): Promise<PilotResult> {
  const { settings, escalation: e } = ctx;
  const denied = await guard(ctx, "approve", true);
  if (denied) return denied;
  const args = parseApproveArgs(body);
  if (!args.ok) return refuse(ctx, "bad_arguments");
  const target = await resolveTarget(ctx, args.version);
  if (!target.ok) return target.result;
  const draft = target.draft;

  if (draft.content_purged_at) return refuse(ctx, "draft_replaced", "no draft text is kept after the retention period");

  // A "customer-ready" draft is vouched for by the approved knowledge it cited. If any of that knowledge was
  // changed, archived or has expired since, the claim is no longer verified: staff must confirm it again.
  const knowledgeChanged = draft.ready && (await citedKnowledgeChanged(e.business_slug, draft));
  if (knowledgeChanged && !args.confirm) {
    return refuse(ctx, "needs_confirmation", "knowledge this draft relied on was changed or has expired since it was written");
  }
  if (!draft.ready && !args.confirm) return refuse(ctx, "needs_confirmation", draft.confirm_notes.join("; "));

  // The one central policy: business, contact permissions, takeover, recent human activity, staleness,
  // expiry, duplicates, unknown-send holds. Nothing here relaxes any of it.
  const plan = await planCustomerSend({
    settings,
    escalation: e,
    requester: { kind: "staff", senderAuthorized: ctx.senderAuth.authorized, senderId: ctx.senderAuth.senderId },
    text: draft.body,
    basedOn: draft.basis_at,
    validUntil: draft.valid_until,
    eventId: ctx.eventId,
  });
  if (!plan.decision.send || !plan.item) {
    const reason = plan.decision.send ? "other_restriction" : plan.decision.reason;
    await audit(e.business_slug, "staff", ctx.senderJid, "pilot.approve_withheld", { type: "escalation", id: e.id }, {
      ref_code: e.ref_code,
      draft_id: draft.id,
      version: draft.version,
      reason,
      sender_id: ctx.senderAuth.senderId,
    });
    return reply(ctx, `⚠️ #${e.ref_code}: draft v${draft.version} was NOT sent — ${WITHHOLD_TEXT[reason]}.`, `pilot:withheld_${reason}`);
  }
  // Same last line of defence as every item the live path enqueues.
  if (!outboxAllowed(settings, plan.item)) return refuse(ctx, "not_in_pilot");

  const outcome = draft.source === "staff_edit" ? "edited" : !draft.ready || knowledgeChanged ? "approved_after_confirm" : "approved_as_is";
  const { data, error } = await agentDb().rpc("approve_ai_agent_pilot_draft", {
    p_business_slug: e.business_slug,
    p_draft_id: draft.id,
    p_expected_hash: draft.body_hash,
    p_approver: ctx.senderAuth.senderId ?? ctx.senderJid,
    p_message_id: ctx.whatsappMessageId,
    p_outcome: outcome,
    p_chat_id: plan.item.chatId,
    p_to_jid: plan.item.toJid,
    p_body: plan.item.body,
    p_dedupe_key: plan.item.dedupeKey,
    p_event_id: ctx.eventId,
    p_status: "dispatched",
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { outbox_id: string | null; result: string } | undefined;
  switch (row?.result) {
    case "approved":
      break;
    case "already_approved":
      return refuse(ctx, "already_approved");
    case "changed":
      return refuse(ctx, "draft_changed");
    case "closed":
      return refuse(ctx, "closed");
    case "duplicate_send":
      return refuse(ctx, "duplicate_send");
    default:
      return refuse(ctx, "draft_replaced");
  }

  // The AI's draft went out unchanged (after the staff confirmed it if it needed that): it was right.
  // Only fills an empty verdict: an admin's override or a staff verdict is never overwritten.
  if (draft.source === "ai" && !draft.verdict && !knowledgeChanged) {
    await agentDb().from("ai_agent_pilot_drafts").update({ verdict: "correct", verdict_source: "inferred" }).eq("id", draft.id).is("verdict", null);
  }
  await markEscalationAnswered(e, { body: null, actorId: ctx.senderJid, via: "whatsapp", notRelayed: null });
  await audit(e.business_slug, "staff", ctx.senderJid, "pilot.approve", { type: "escalation", id: e.id }, {
    ref_code: e.ref_code,
    draft_id: draft.id,
    version: draft.version,
    body_hash: draft.body_hash,
    source: draft.source,
    outcome,
    confirmed_by_staff: !draft.ready || knowledgeChanged,
    knowledge_changed: knowledgeChanged,
    sender_id: ctx.senderAuth.senderId,
    outbox_id: row.outbox_id,
  });
  const queued = row.outbox_id ? [await outboxRowById(row.outbox_id)].filter((r): r is OutboxRow => Boolean(r)) : [];
  return {
    outbox: canSendApproved(settings) ? [feedback(ctx, `📤 #${e.ref_code}: draft v${draft.version} approved — sending to ${label(e)}.`)] : [],
    queued,
    outcome: "pilot:approved",
  };
}

// ── !edit ────────────────────────────────────────────────────────────────────

export async function handleEdit(ctx: PilotCtx, body: string): Promise<PilotResult> {
  const { escalation: e } = ctx;
  const denied = await guard(ctx, "edit", true);
  if (denied) return denied;
  const args = parseEditArgs(body);
  if (!args.text) return refuse(ctx, "empty_edit");
  if (checkExactSendSafety(args.text).length > 0) return refuse(ctx, "unsafe_edit");
  const current = await currentDraft(e.business_slug, e.id);
  if (args.version !== null && current && args.version !== current.version) {
    return refuse(ctx, "wrong_version", `the current draft is v${current.version}, not v${args.version}`);
  }
  if (current && current.body_hash === bodyHash(args.text)) {
    return reply(ctx, `ℹ️ #${e.ref_code}: that is already the current draft (v${current.version}). Reply !approve to send it.`, "pilot:edit_unchanged");
  }
  const prior = current;
  // The staff wrote this wording themselves: it is "ready", but still needs !approve.
  const draft = await createDraftVersion({
    escalation: e,
    source: "staff_edit",
    body: args.text,
    ready: true,
    notes: [],
    createdBy: ctx.senderAuth.senderId ?? ctx.senderJid,
  });
  const changedFacts = prior?.source === "ai" ? inferVerdict(prior.body, args.text) : null;
  await audit(e.business_slug, "staff", ctx.senderJid, "pilot.edit", { type: "escalation", id: e.id }, {
    ref_code: e.ref_code,
    draft_id: draft.id,
    version: draft.version,
    replaced_version: prior?.version ?? null,
    sender_id: ctx.senderAuth.senderId,
  });
  const post = buildPilotDraftPost({
    refCode: e.ref_code,
    customerLabel: label(e),
    version: draft.version,
    body: draft.body,
    ready: true,
    notes: [],
    learned:
      changedFacts === "factually_wrong" || changedFacts === "missing_information"
        ? ["💡 If this is a lasting fact, save it for next time with !teach <fact>."]
        : [],
  });
  return {
    outbox: canSendApproved(ctx.settings) ? [draftPostItem(ctx, draft, post)] : [],
    queued: [],
    outcome: "pilot:edited",
  };
}

/** A draft version posted in the staff group: quotable (its WhatsApp id is acked back), keyed by the draft's id. */
export function draftPostItem(ctx: Pick<PilotCtx, "settings" | "escalation" | "eventId" | "whatsappMessageId">, draft: PilotDraftRow, body: string): OutboxInsert {
  return {
    businessSlug: ctx.escalation.business_slug,
    chatId: ctx.escalation.chat_id,
    kind: "staff_draft",
    toJid: ctx.settings.staff_group_jid!,
    body,
    dedupeKey: `${PILOT_DRAFT_KEY_PREFIX}${draft.id}`,
    eventId: ctx.eventId,
    escalationId: ctx.escalation.id,
    replyToMessageId: ctx.whatsappMessageId,
  };
}

// ── !reject ──────────────────────────────────────────────────────────────────

export async function handleReject(ctx: PilotCtx, body: string): Promise<PilotResult> {
  const { escalation: e } = ctx;
  const denied = await guard(ctx, "reject", true);
  if (denied) return denied;
  const args = parseRejectArgs(body);
  const target = await resolveTarget(ctx, null);
  if (!target.ok) return target.result;
  const draft = target.draft;
  // Conditional on still being current: a draft approved a moment ago cannot be "rejected" after the fact.
  const { data, error } = await agentDb()
    .from("ai_agent_pilot_drafts")
    .update({
      status: "rejected",
      outcome: "rejected",
      decided_by: ctx.senderAuth.senderId ?? ctx.senderJid,
      decided_at: new Date().toISOString(),
      decision_message_id: ctx.whatsappMessageId,
      ...(args.verdict ? { verdict: args.verdict, verdict_source: "staff" } : {}),
      verdict_note: args.note,
    })
    .eq("id", draft.id)
    .eq("status", "current")
    .select("id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) return refuse(ctx, "draft_replaced");
  await audit(e.business_slug, "staff", ctx.senderJid, "pilot.reject", { type: "escalation", id: e.id }, {
    ref_code: e.ref_code,
    draft_id: draft.id,
    version: draft.version,
    verdict: args.verdict,
    sender_id: ctx.senderAuth.senderId,
  });
  return reply(
    ctx,
    `🗑️ #${e.ref_code}: draft v${draft.version} rejected — nothing was sent.${args.verdict ? ` Recorded as: ${args.verdict === "missing_information" ? "AI was missing information" : "AI was factually wrong"}.` : ""}\nReply with !edit <text> or !send <text>, or answer the request in your own words. Use !teach <fact> to save what the AI should have known.`,
    "pilot:rejected"
  );
}

// ── !status (an escalation) ──────────────────────────────────────────────────

export async function handleEscalationStatus(ctx: PilotCtx): Promise<PilotResult> {
  const e = ctx.escalation;
  const draft = (await currentDraft(e.business_slug, e.id)) ?? null;
  const stale = draft ? await customerWroteAfter(e, draft.basis_at) : false;
  const line = buildStatusLine({
    refCode: e.ref_code,
    customerLabel: label(e),
    status: e.status,
    draft: draft ? { version: draft.version, status: draft.status, ready: draft.ready, source: draft.source } : null,
    customerWroteSinceDraft: stale,
  });
  return reply(ctx, line, "pilot:status");
}

/** Business-level `!status`: the open requests and what each is waiting for. Read-only, anyone in the group. */
export async function businessStatusText(businessSlug: string): Promise<string> {
  const db = agentDb();
  const { data, error } = await db
    .from("ai_agent_escalations")
    .select("id, ref_code, customer_name, contact_number, chat_id, status, created_at")
    .eq("business_slug", businessSlug)
    .in("status", ["open", "notified", "answered"])
    .order("created_at", { ascending: false })
    .limit(6);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; ref_code: string; customer_name: string | null; contact_number: string | null; chat_id: string; status: string }[];
  if (rows.length === 0) return "✅ No open customer requests.";
  const { data: drafts } = await db
    .from("ai_agent_pilot_drafts")
    .select("escalation_id, version, ready")
    .eq("business_slug", businessSlug)
    .eq("status", "current")
    .in("escalation_id", rows.map((r) => r.id));
  const byEsc = new Map(((drafts ?? []) as { escalation_id: string; version: number; ready: boolean }[]).map((d) => [d.escalation_id, d]));
  const lines = rows.slice(0, 5).map((r) => {
    const d = byEsc.get(r.id);
    return `• #${r.ref_code} · ${(r.customer_name ?? r.contact_number ?? r.chat_id).slice(0, 30)} · ${r.status}${d ? ` · draft v${d.version}${d.ready ? "" : " (confirm)"}` : ""}`;
  });
  return [`Open requests (${rows.length > 5 ? "5 newest" : rows.length}):`, ...lines].join("\n");
}

// ── Retention ────────────────────────────────────────────────────────────────

/** Pilot draft wording is kept this long; afterwards only minimal audit metadata remains. */
export const PILOT_DRAFT_RETENTION_DAYS = 90;

/** Blanks the wording of drafts older than the retention period. Best effort; idempotent. Returns how many were purged. */
export async function purgePilotDrafts(retentionDays: number = PILOT_DRAFT_RETENTION_DAYS): Promise<number> {
  const { data, error } = await agentDb().rpc("purge_ai_agent_pilot_drafts", { p_older_than: `${retentionDays} days` });
  if (error) {
    console.error("[aiAgent] purge pilot drafts", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

// ── Evaluation verdict override ──────────────────────────────────────────────

export type OverrideResult = { ok: true; previous: string | null } | { ok: false; status: number; error: string };

/** An admin's manual verdict on the AI's draft for one request. Needs a reason; the change is kept in the history. */
export async function overridePilotVerdict(input: {
  businessSlug: string;
  escalationId: string;
  verdict: "correct" | "missing_information" | "factually_wrong";
  reason: string;
  adminId: string;
}): Promise<OverrideResult> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) return { ok: false, status: 400, error: "Give a reason of 3 to 500 characters." };
  const { data, error } = await agentDb().rpc("override_ai_agent_pilot_verdict", {
    p_business_slug: input.businessSlug,
    p_escalation_id: input.escalationId,
    p_verdict: input.verdict,
    p_reason: reason,
    p_admin: input.adminId,
  });
  if (error) return { ok: false, status: 500, error: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as { result: string; previous_verdict: string | null } | undefined;
  if (row?.result === "not_found") return { ok: false, status: 404, error: "No AI draft found for that request." };
  if (row?.result === "undecided") return { ok: false, status: 409, error: "Staff haven't decided on this draft yet. Override the verdict once it was approved, edited or rejected." };
  await audit(input.businessSlug, "admin", input.adminId, "evaluation.verdict_override", { type: "escalation", id: input.escalationId }, {
    previous: row?.previous_verdict ?? null,
    verdict: input.verdict,
    reason,
  });
  return { ok: true, previous: row?.previous_verdict ?? null };
}
