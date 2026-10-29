import { NextResponse } from "next/server";
import { parseCallReport } from "@/lib/aiAgent/missedCalls";
import { jsonError, readJson, verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { audit, parseBusinessSlug } from "@/lib/server/aiAgent/db";
import { processCallReport } from "@/lib/server/aiAgent/missedCalls";

// Bridge → app (server-to-server): one finished WhatsApp call. Contract: docs/ai-agent-missed-calls.md.
// The bridge sends ONLY the outbox items returned with send: true (and acks them like any other). The missed-call rule is off
// until an admin turns it on; until then (and for anything not reliably a missed incoming call) the answer is "ignored".
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return jsonError("Invalid JSON body", 400);
  const businessSlug = parseBusinessSlug(body.businessSlug);
  const report = parseCallReport(body);
  if (!businessSlug || !report) return jsonError("businessSlug, callId, callerJid and finalStatus are required", 400);
  try {
    return NextResponse.json(await processCallReport(businessSlug, report));
  } catch (err) {
    console.error("[bridge/ai-agent/call]", err);
    await audit(businessSlug, "bridge", null, "bridge.call_failed", { type: "call", id: report.callId }, { error: (err instanceof Error ? err.message : "Unknown error").slice(0, 300) }).catch(() => {});
    // Fail closed: the bridge sends nothing on a non-2xx.
    return jsonError("Failed to process the call", 500);
  }
}
