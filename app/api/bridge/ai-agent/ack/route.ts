import { NextResponse } from "next/server";
import { jsonError, readJson, verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { ackOutbox } from "@/lib/server/aiAgent/outbox";

// Bridge → app: the outcome of sending one outbox item. Idempotent.
export const dynamic = "force-dynamic";

interface Payload {
  outboxId?: unknown;
  status?: unknown;
  whatsappMessageId?: unknown;
  error?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const body = await readJson<Payload>(request);
  if (!body) return jsonError("Invalid JSON body", 400);
  if (typeof body.outboxId !== "string" || !UUID.test(body.outboxId)) return jsonError("outboxId must be a uuid", 400);
  if (body.status !== "sent" && body.status !== "failed") return jsonError('status must be "sent" or "failed"', 400);

  try {
    const result = await ackOutbox({
      outboxId: body.outboxId,
      status: body.status,
      whatsappMessageId: typeof body.whatsappMessageId === "string" ? body.whatsappMessageId.slice(0, 200) : null,
      error: typeof body.error === "string" ? body.error : null,
    });
    if (result === "not_found") return jsonError("Outbox item not found", 404);
    if (result === "conflict") return jsonError("Outbox item is not awaiting an ack", 409);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bridge/ai-agent/ack]", err);
    return jsonError("Failed to record ack", 500);
  }
}
