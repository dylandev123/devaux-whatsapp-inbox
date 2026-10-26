// Server-only: the batched "AI MEMORY UPDATED" notification. Facts learned automatically are NOT announced one by
// one: each is a durable row in ai_agent_learning_events, and once DIGEST_THRESHOLD of them have gathered for a
// business, claim_ai_agent_learning_digest() turns them into ONE digest in a single transaction. The message is
// built from stored summaries (no model call), enqueued under the key learning_digest:<id> (the outbox's unique
// dedupe key makes a second attempt a no-op), and the digest row records that it was enqueued. A crash between
// the claim and the enqueue is repaired by the next flush, which re-enqueues the same digest under the same key.
//
// Whatever has not reached the threshold is announced ONCE as a weekly digest (trigger 'weekly', decided inside
// claim_ai_agent_learning_digest). The weekly check rides on the existing scheduler sweep (runDueLearningDigests),
// so it needs no new job. A digest is never empty: nothing waiting = nothing claimed, and facts forgotten between
// the claim and the send are left out (if none remain, nothing is sent).

import { canSendApproved, outboxAllowed } from "@/lib/aiAgent/engine";
import type { AgentSettings } from "@/lib/aiAgent/engine";
import { buildLearningDigest, DIGEST_THRESHOLD, WEEKLY_DIGEST_DAYS } from "@/lib/aiAgent/autoLearn";
import { agentDb, audit, loadSettings } from "@/lib/server/aiAgent/db";
import { enqueue, type OutboxInsert } from "@/lib/server/aiAgent/outbox";

interface DigestRow {
  id: string;
  fact_count: number;
  pending_count: number;
  trigger_kind?: string | null;
}

async function markEnqueued(digestId: string): Promise<void> {
  const { error } = await agentDb().from("ai_agent_learning_digests").update({ enqueued_at: new Date().toISOString() }).eq("id", digestId).is("enqueued_at", null);
  if (error) throw new Error(error.message);
}

async function enqueueDigest(settings: AgentSettings, digest: DigestRow): Promise<boolean> {
  const db = agentDb();
  const { data, error } = await db
    .from("ai_agent_learning_events")
    .select("summary, knowledge_id")
    .eq("business_slug", settings.business_slug)
    .eq("digest_id", digest.id)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const events = (data ?? []) as { summary: string; knowledge_id: string }[];
  // A fact forgotten after the claim is not announced. (Fixed at claim time otherwise.)
  const { data: live, error: liveError } = events.length
    ? await db.from("ai_agent_knowledge").select("id").eq("business_slug", settings.business_slug).eq("status", "approved").in("id", events.map((e) => e.knowledge_id))
    : { data: [], error: null };
  if (liveError) throw new Error(liveError.message);
  const activeIds = new Set(((live ?? []) as { id: string }[]).map((k) => k.id));
  const kept = events.filter((e) => activeIds.has(e.knowledge_id));
  if (kept.length === 0) {
    // Nothing left to announce: close the digest without sending an empty message.
    await markEnqueued(digest.id);
    return false;
  }
  const lines = kept.map((e) => e.summary);
  const item: OutboxInsert = {
    businessSlug: settings.business_slug,
    chatId: settings.staff_group_jid!,
    kind: "staff_feedback",
    toJid: settings.staff_group_jid!,
    body: buildLearningDigest({ factCount: kept.length, lines, pendingCount: digest.pending_count, weekly: digest.trigger_kind === "weekly" }),
    dedupeKey: `learning_digest:${digest.id}`,
    eventId: null,
  };
  // The same final gate every live item passes: a digest can only ever go to the staff group, in a mode that allows it.
  if (!outboxAllowed(settings, item)) return false;
  // Created 'pending': the bridge claims it like any dashboard-originated staff message. A repeat is skipped by the dedupe key.
  await enqueue([item], false);
  await markEnqueued(digest.id);
  return true;
}

/**
 * Sends any digest that is due. Staff-group feedback follows the same rule as every other plain staff message
 * (Approval Pilot and Assisted only; Observe stays silent), so when it is not allowed nothing is claimed and the
 * facts keep waiting — they are all in the dashboard meanwhile. Best effort: a failure never affects the message
 * that triggered it, and the next flush repairs it.
 */
export async function flushLearningDigests(settings: AgentSettings): Promise<number> {
  if (!canSendApproved(settings) || !settings.staff_group_jid) return 0;
  let sent = 0;
  try {
    const db = agentDb();
    // 1. A digest that was claimed but never made it into the outbox.
    const { data: open, error: openError } = await db
      .from("ai_agent_learning_digests")
      .select("id, fact_count, pending_count, trigger_kind")
      .eq("business_slug", settings.business_slug)
      .is("enqueued_at", null)
      .order("created_at", { ascending: true })
      .limit(5);
    if (openError) throw new Error(openError.message);
    for (const digest of (open ?? []) as DigestRow[]) if (await enqueueDigest(settings, digest)) sent += 1;

    // 2. A new one, if enough facts have gathered. The claim is atomic: two callers can never both get the same facts.
    const { data: claimed, error: claimError } = await db.rpc("claim_ai_agent_learning_digest", {
      p_business_slug: settings.business_slug,
      p_threshold: DIGEST_THRESHOLD,
      p_weekly_days: WEEKLY_DIGEST_DAYS,
    });
    if (claimError) throw new Error(claimError.message);
    const row = (Array.isArray(claimed) ? claimed[0] : claimed) as { digest_id: string; fact_count: number; pending_count: number; trigger_kind: string } | undefined;
    if (row?.digest_id) {
      await audit(settings.business_slug, "system", null, "learning.digest", { type: "digest", id: row.digest_id }, { fact_count: row.fact_count, pending_count: row.pending_count, trigger: row.trigger_kind });
      if (await enqueueDigest(settings, { id: row.digest_id, fact_count: row.fact_count, pending_count: row.pending_count, trigger_kind: row.trigger_kind })) sent += 1;
    }
  } catch (err) {
    console.error("[aiAgent] flushLearningDigests", err instanceof Error ? err.message : err);
  }
  return sent;
}

/**
 * The scheduled pass: every enabled business gets a flush, which sends a weekly digest when its leftover facts have waited
 * long enough (and repairs a claimed-but-unsent one). Idempotent and cheap — businesses with nothing waiting cost one
 * claim call. One business failing never stops the others.
 */
export async function runDueLearningDigests(): Promise<{ businesses: number; sent: number }> {
  const { data, error } = await agentDb().from("ai_agent_settings").select("business_slug").eq("enabled", true);
  if (error) throw new Error(error.message);
  let sent = 0;
  for (const row of (data ?? []) as { business_slug: string }[]) {
    try {
      const settings = await loadSettings(row.business_slug);
      if (settings) sent += await flushLearningDigests(settings);
    } catch (err) {
      console.error("[aiAgent] learning digest sweep", row.business_slug, err instanceof Error ? err.message : err);
    }
  }
  return { businesses: (data ?? []).length, sent };
}
