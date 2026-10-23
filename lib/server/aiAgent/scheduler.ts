// Server-only: the opportunistic triggers for due batches. The durable
// guarantee comes from Postgres (claim_ai_agent_batches) plus a periodic caller
// (POST /api/cron/ai-agent/batches); these helpers only make batches process
// sooner by piggy-backing on traffic the app already receives (the bridge's
// outbox poll, forwarded messages). The throttle is a per-instance
// optimisation, never a correctness mechanism: a skipped run is picked up by
// the next trigger, and concurrent runs are safe.

import { after } from "next/server";
import { processDueBatches } from "@/lib/server/aiAgent/decide";

const MIN_GAP_MS = 5_000;
let lastRunAt = 0;

/** Schedules a due-batch sweep to run after the response has been sent. */
export function sweepBatchesAfterResponse(): void {
  const now = Date.now();
  if (now - lastRunAt < MIN_GAP_MS) return;
  lastRunAt = now;
  after(async () => {
    try {
      await processDueBatches();
    } catch (err) {
      console.error("[aiAgent] due-batch sweep failed", err instanceof Error ? err.message : err);
    }
  });
}
