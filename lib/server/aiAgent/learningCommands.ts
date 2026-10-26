// Server-only: the staff-group commands about what the AI has learned.
//
//   !memory         recent learned facts (each with its source chat and time) and pending reviews (read-only; like
//                   !status, any member of the staff group)
//   !memory K-XXXX  where one fact came from, including the business's original message read from the inbox just now
//                   (authorized senders only: the knowledge itself never stores chat text)
//   !forget K-XXXX  deactivates a learned fact. Authorized senders only (the same allow-list as !teach / !discard).
//
// Nothing here deletes anything: a forgotten fact is ARCHIVED (status 'archived', reason 'forgotten') with its
// source, timestamps and price history intact, and the same fact is not relearned from a repeat for a while.
// (!confirm and !discard live in teach.ts and are unchanged.)

import {
  buildMemoryDetail,
  buildMemoryList,
  formatSourceTime,
  maskChat,
  MEMORY_PENDING_SHOWN,
  MEMORY_RECENT_SHOWN,
  REVIEW_REASON_TEXT,
  type ReviewReason,
} from "@/lib/aiAgent/autoLearn";
import { DEFAULT_ORDERS_TIMEZONE } from "@/lib/aiAgent/orders";
import { canSendApproved, type AgentSettings } from "@/lib/aiAgent/engine";
import type { SenderAuthorization } from "@/lib/aiAgent/identity";
import { parseConfirmArgs } from "@/lib/aiAgent/pilot";
import { candidateFingerprint } from "@/lib/aiAgent/staffAnswers";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { loadSources } from "@/lib/server/aiAgent/learningSources";
import type { OutboxInsert } from "@/lib/server/aiAgent/outbox";

interface Result {
  outbox: OutboxInsert[];
  outcome: string;
}

/** Speaks in the staff group only where staff-group feedback is permitted (Approval Pilot, Assisted); Observe stays silent. */
function say(settings: AgentSettings, eventId: string, body: string, outcome: string): Result {
  return {
    outbox:
      canSendApproved(settings) && settings.staff_group_jid
        ? [{ businessSlug: settings.business_slug, chatId: settings.staff_group_jid, kind: "staff_feedback", toJid: settings.staff_group_jid, body, dedupeKey: `${eventId}:staff_feedback`, eventId }]
        : [],
    outcome,
  };
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

interface KnowledgeLite {
  id: string;
  title: string;
  content: string;
  status: string;
  short_code: string | null;
  fingerprint: string | null;
  supersedes_id: string | null;
  created_at: string;
  archived_reason: string | null;
  learned_message_id: string | null;
  learned_message_at: string | null;
  learned_chat_id: string | null;
}
const KNOWLEDGE_LITE = "id, title, content, status, short_code, fingerprint, supersedes_id, created_at, archived_reason, learned_message_id, learned_message_at, learned_chat_id";

const timeZoneOf = (settings: AgentSettings) => settings.orders_timezone || DEFAULT_ORDERS_TIMEZONE;

/** The knowledge row a staff code points at: its own code, or the code of the suggestion it was approved from. Never another business's. */
async function findByCode(slug: string, code: string): Promise<{ row: KnowledgeLite | null; pendingCandidate: boolean }> {
  const db = agentDb();
  const { data, error } = await db.from("ai_agent_knowledge").select(KNOWLEDGE_LITE).eq("business_slug", slug).eq("short_code", code).limit(1);
  if (error) throw new Error(error.message);
  let row = ((data ?? []) as KnowledgeLite[])[0] ?? null;
  if (row) return { row, pendingCandidate: false };
  const { data: cand, error: candError } = await db.from("ai_agent_learning_candidates").select("knowledge_id, status").eq("business_slug", slug).eq("short_code", code).limit(1);
  if (candError) throw new Error(candError.message);
  const c = ((cand ?? []) as { knowledge_id: string | null; status: string }[])[0];
  if (c?.status === "pending") return { row: null, pendingCandidate: true };
  if (c?.knowledge_id) {
    const { data: byId, error: byIdError } = await db.from("ai_agent_knowledge").select(KNOWLEDGE_LITE).eq("business_slug", slug).eq("id", c.knowledge_id).limit(1);
    if (byIdError) throw new Error(byIdError.message);
    row = ((byId ?? []) as KnowledgeLite[])[0] ?? null;
  }
  return { row, pendingCandidate: false };
}

const stateOf = (r: KnowledgeLite) => (r.status === "approved" ? "active" : r.status === "archived" ? (r.archived_reason === "forgotten" ? "removed" : r.archived_reason === "superseded" ? "replaced by a newer fact" : "archived") : r.status);

export async function handleMemory(args: { settings: AgentSettings; senderAuth: SenderAuthorization; body: string; eventId: string }): Promise<Result> {
  const { settings } = args;
  if (args.body.trim()) return handleMemoryDetail(args);
  const db = agentDb();
  const slug = settings.business_slug;
  const nowIso = new Date().toISOString();
  const [recentRes, pendingRes, pendingCount] = await Promise.all([
    db.from("ai_agent_knowledge").select(KNOWLEDGE_LITE).eq("business_slug", slug).eq("status", "approved").in("source", ["auto", "whatsapp"]).order("created_at", { ascending: false }).limit(MEMORY_RECENT_SHOWN),
    db.from("ai_agent_learning_candidates").select("short_code, staff_answer, review_reason").eq("business_slug", slug).eq("status", "pending").or(`proposal_expires_at.is.null,proposal_expires_at.gt.${nowIso}`).order("created_at", { ascending: false }).limit(MEMORY_PENDING_SHOWN),
    db.from("ai_agent_learning_candidates").select("id", { count: "exact", head: true }).eq("business_slug", slug).eq("status", "pending").or(`proposal_expires_at.is.null,proposal_expires_at.gt.${nowIso}`),
  ]);
  if (recentRes.error) throw new Error(recentRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  if (pendingCount.error) throw new Error(pendingCount.error.message);
  const recent = (recentRes.data ?? []) as KnowledgeLite[];
  const codes = await codesFor(slug, recent);
  const ids = recent.map((r) => r.id);
  const summaries = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await db.from("ai_agent_learning_events").select("knowledge_id, summary").eq("business_slug", slug).in("knowledge_id", ids);
    for (const e of (data ?? []) as { knowledge_id: string; summary: string }[]) summaries.set(e.knowledge_id, e.summary);
  }
  // Time and chat only — never the chat text (that is shown on request, to authorized senders: !memory K-XXXXX).
  const sources = await loadSources(slug, recent, { withText: false });
  const tz = timeZoneOf(settings);
  const text = buildMemoryList({
    recent: recent.map((r) => {
      const src = sources.get(r.id);
      const when = formatSourceTime(src?.at ?? r.learned_message_at, tz);
      const chat = maskChat(src?.chatId ?? r.learned_chat_id);
      return {
        code: codes.get(r.id) ?? null,
        summary: summaries.get(r.id) ?? r.title,
        learnedAt: r.created_at,
        updated: r.supersedes_id !== null,
        source: [when, chat].filter(Boolean).join(" · ") || null,
      };
    }),
    pending: ((pendingRes.data ?? []) as { short_code: string | null; staff_answer: string; review_reason: string | null }[]).map((p) => ({
      code: p.short_code,
      text: p.staff_answer,
      reason: p.review_reason && p.review_reason in REVIEW_REASON_TEXT ? REVIEW_REASON_TEXT[p.review_reason as ReviewReason] : null,
    })),
    pendingTotal: pendingCount.count ?? 0,
    confirmViaWhatsapp: settings.knowledge_confirm_via_whatsapp === true,
  });
  return say(settings, args.eventId, text, "memory:listed");
}

async function handleMemoryDetail(args: { settings: AgentSettings; senderAuth: SenderAuthorization; body: string; eventId: string }): Promise<Result> {
  const { settings, senderAuth } = args;
  const say_ = (text: string, outcome: string) => say(settings, args.eventId, text, outcome);
  const parsed = parseConfirmArgs(args.body);
  if (!parsed.ok || parsed.resolution !== "none") return say_("⚠️ Use “!memory” for the list or “!memory K-XXXXX” for one fact's source.", "memory:bad_arguments");
  const slug = settings.business_slug;
  const { row, pendingCandidate } = await findByCode(slug, parsed.code);
  if (pendingCandidate) return say_(`ℹ️ ${parsed.code} hasn't been added yet — it's waiting for review in the dashboard.`, "memory:pending");
  if (!row) return say_(`⚠️ I don't have a learned fact ${parsed.code} for this business.`, "memory:unknown_code");
  const sources = await loadSources(slug, [row], { withText: senderAuth.authorized });
  const src = sources.get(row.id);
  const text = buildMemoryDetail({
    code: parsed.code,
    summary: row.title,
    state: stateOf(row),
    learnedAt: row.created_at,
    chatId: src?.chatId ?? row.learned_chat_id,
    messageAt: src?.at ?? row.learned_message_at,
    original: src?.original ?? null,
    mayShowOriginal: senderAuth.authorized,
    timeZone: timeZoneOf(settings),
  });
  return say_(text, "memory:detail");
}

/** The code staff type for each knowledge row: its own, or the code of the suggestion it was approved from. */
async function codesFor(businessSlug: string, rows: KnowledgeLite[]): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  const missing: string[] = [];
  for (const r of rows) (r.short_code ? codes.set(r.id, r.short_code) : missing.push(r.id));
  if (missing.length > 0) {
    const { data } = await agentDb().from("ai_agent_learning_candidates").select("knowledge_id, short_code").eq("business_slug", businessSlug).in("knowledge_id", missing);
    for (const c of (data ?? []) as { knowledge_id: string; short_code: string | null }[]) if (c.short_code) codes.set(c.knowledge_id, c.short_code);
  }
  return codes;
}

export async function handleForget(args: {
  settings: AgentSettings;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  body: string;
  eventId: string;
}): Promise<Result> {
  const { settings, senderAuth } = args;
  const say_ = (text: string, outcome: string) => say(settings, args.eventId, text, outcome);
  const slug = settings.business_slug;
  if (!senderAuth.authorized) {
    await audit(slug, "staff", args.senderJid, "forget.refused", { type: "knowledge" }, { reason: "sender_not_authorized", sender_id: senderAuth.senderId });
    return say_("⚠️ You're not on this business's list of people who can manage knowledge — nothing was changed.", "forget:not_authorized");
  }
  const parsed = parseConfirmArgs(args.body);
  if (!parsed.ok || parsed.resolution !== "none") return say_("⚠️ Use “!forget K-XXXXX” with one fact's code (see !memory). Nothing was changed.", "forget:bad_arguments");

  const db = agentDb();
  const { row, pendingCandidate } = await findByCode(slug, parsed.code);
  if (pendingCandidate) return say_(`ℹ️ ${parsed.code} hasn't been added yet — it's waiting for review. Use !discard ${parsed.code} to reject it.`, "forget:pending");
  if (!row) return say_(`⚠️ I don't have a learned fact ${parsed.code} for this business. Nothing was changed.`, "forget:unknown_code");
  if (row.status !== "approved") return say_(`ℹ️ ${parsed.code} is already off (${row.status}).`, "forget:already_off");

  // Archived, never deleted. Conditional on still being approved, so a repeat is a no-op.
  const { data: updated, error: updateError } = await db
    .from("ai_agent_knowledge")
    .update({
      status: "archived",
      archived_reason: "forgotten",
      archived_at: new Date().toISOString(),
      archived_by: senderAuth.senderId,
      fingerprint: row.fingerprint ?? candidateFingerprint(row.content),
    })
    .eq("id", row.id)
    .eq("business_slug", slug)
    .eq("status", "approved")
    .select("id");
  if (updateError) throw new Error(updateError.message);
  if ((updated ?? []).length === 0) return say_(`ℹ️ ${parsed.code} is already off.`, "forget:already_off");
  await audit(slug, "staff", args.senderJid, "knowledge.forget", { type: "knowledge", id: row.id }, { code: parsed.code, via: "whatsapp", sender_id: senderAuth.senderId, title: clip(row.title, 120) });
  return say_(`🗑️ ${parsed.code} removed — the AI will no longer use “${clip(row.title, 60)}”. It stays in the dashboard history.`, "forget:archived");
}
