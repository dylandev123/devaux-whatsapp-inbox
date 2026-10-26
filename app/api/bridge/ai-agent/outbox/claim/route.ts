import { NextResponse } from "next/server";
import { readJson, verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { parseBusinessSlug } from "@/lib/server/aiAgent/db";
import { claimOutbox } from "@/lib/server/aiAgent/outbox";
import { sweepBatchesAfterResponse, sweepOrderSummariesAfterResponse } from "@/lib/server/aiAgent/scheduler";

// Bridge → app: claim outbox items queued outside a message request (admin UI
// answers to escalations). Each item is handed out once; ack every one.
export const dynamic = "force-dynamic";
// The due-batch sweep below runs after the response and may call the model.
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const body = (await readJson<{ businessSlug?: unknown; limit?: unknown }>(request)) ?? {};
  const businessSlug = body.businessSlug === undefined ? null : parseBusinessSlug(body.businessSlug);
  if (body.businessSlug !== undefined && !businessSlug) return NextResponse.json({ items: [] });
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 20;

  try {
    const items = await claimOutbox(businessSlug, limit);
    // The bridge polls this endpoint every few seconds, which makes it a free,
    // reliable clock: batches whose quiet period ended are processed now (after
    // this response is sent, so the poll never waits on a model call) and their
    // outbox items are handed out by the next poll.
    sweepBatchesAfterResponse();
    // ... and the 8 AM order summary (idempotent per business per day; see runScheduledSummary).
    sweepOrderSummariesAfterResponse();
    return NextResponse.json({ items });
  } catch (err) {
    console.error("[bridge/ai-agent/outbox/claim]", err);
    return NextResponse.json({ error: "Failed to claim outbox" }, { status: 500 });
  }
}
