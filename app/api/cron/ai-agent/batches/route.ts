import { NextResponse } from "next/server";
import { verifySchedulerSecret } from "@/lib/server/aiAgent/auth";
import { processDueBatches } from "@/lib/server/aiAgent/decide";
import { runDueLearningDigests } from "@/lib/server/aiAgent/learningDigest";

// Scheduler entry point: processes every batch whose quiet period or maximum
// wait has elapsed, plus batches whose worker died (expired lease). Idempotent
// and safe to call from several places at once. Not behind the admin
// middleware: it authenticates with AI_AGENT_BRIDGE_SECRET (x-ai-agent-secret)
// or Vercel Cron's CRON_SECRET bearer token.
//   GET   Vercel Cron (cron jobs issue GET)
//   POST  bridge / pg_cron + pg_net / any external scheduler
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  const denied = verifySchedulerSecret(request);
  if (denied) return denied;
  try {
    const batches = await processDueBatches({ budgetMs: 45_000 });
    // The weekly AI-memory digest rides the same tick (idempotent; never affects the batches above).
    const learning = await runDueLearningDigests().catch((err) => {
      console.error("[cron/ai-agent/batches] learning digests", err);
      return null;
    });
    return NextResponse.json({ ok: true, ...batches, learningDigests: learning });
  } catch (err) {
    console.error("[cron/ai-agent/batches]", err);
    return NextResponse.json({ error: "Failed to process batches" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
