import { NextResponse } from "next/server";
import { readJson, verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { pilotSlug } from "@/lib/server/aiAgent/db";
import { claimOutbox } from "@/lib/server/aiAgent/outbox";

// Bridge → app: claim outbox items queued outside a message request (admin UI
// answers to escalations). Each item is handed out once; ack every one.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const body = (await readJson<{ businessSlug?: unknown; limit?: unknown }>(request)) ?? {};
  const businessSlug = body.businessSlug === undefined ? null : pilotSlug(body.businessSlug);
  if (body.businessSlug !== undefined && !businessSlug) return NextResponse.json({ items: [] });
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 20;

  try {
    return NextResponse.json({ items: await claimOutbox(businessSlug, limit) });
  } catch (err) {
    console.error("[bridge/ai-agent/outbox/claim]", err);
    return NextResponse.json({ error: "Failed to claim outbox" }, { status: 500 });
  }
}
