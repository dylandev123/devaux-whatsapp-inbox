import { NextResponse } from "next/server";
import { jsonError, readJson, verifyBridgeSecret } from "@/lib/server/aiAgent/auth";
import { audit, parseBusinessSlug } from "@/lib/server/aiAgent/db";
import { processBridgeMessage } from "@/lib/server/aiAgent/decide";
import { sweepBatchesAfterResponse } from "@/lib/server/aiAgent/scheduler";

// Bridge → app (server-to-server). Contract: docs/ai-agent-bridge-contract.md.
// The bridge forwards each stored message here and sends ONLY the returned
// outbox items with send: true, then acks each via /api/bridge/ai-agent/ack.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Payload {
  businessSlug?: unknown;
  whatsappMessageId?: unknown;
  chatId?: unknown;
  contactNumber?: unknown;
  fromMe?: unknown;
  text?: unknown;
  hasMedia?: unknown;
  quotedMessageId?: unknown;
  senderJid?: unknown;
  senderPhone?: unknown;
  timestamp?: unknown;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export async function POST(request: Request) {
  const denied = verifyBridgeSecret(request);
  if (denied) return denied;

  const body = await readJson<Payload>(request);
  if (!body) return jsonError("Invalid JSON body", 400);

  const businessSlug = str(body.businessSlug, 100);
  const whatsappMessageId = str(body.whatsappMessageId, 200);
  const chatId = str(body.chatId, 200);
  if (!businessSlug || !whatsappMessageId || !chatId) {
    return jsonError("businessSlug, whatsappMessageId and chatId are required", 400);
  }
  if (typeof body.fromMe !== "boolean") return jsonError("fromMe must be a boolean", 400);

  try {
    const result = await processBridgeMessage({
      businessSlug,
      whatsappMessageId,
      chatId,
      contactNumber: str(body.contactNumber, 200),
      fromMe: body.fromMe,
      text: typeof body.text === "string" ? body.text.slice(0, 8000) : "",
      hasMedia: body.hasMedia === true,
      quotedMessageId: str(body.quotedMessageId, 200),
      senderJid: str(body.senderJid, 200),
      senderPhone: str(body.senderPhone, 40),
      timestamp: str(body.timestamp, 64),
    });
    // Any forwarded message is also a chance to process OTHER chats' due batches.
    sweepBatchesAfterResponse();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[bridge/ai-agent/message]", err);
    // Failures before an event row exists would otherwise leave Activity empty.
    // Ids and the error text only: no message body, no credentials.
    const slug = parseBusinessSlug(businessSlug);
    if (slug) {
      await audit(slug, "bridge", null, "bridge.message_failed", { type: "message", id: whatsappMessageId }, {
        chat_id: chatId,
        error: (err instanceof Error ? err.message : "Unknown error").slice(0, 300),
      }).catch(() => {});
    }
    // Fail closed — the bridge sends nothing on a non-2xx.
    return jsonError("AI agent failed to process the message", 500);
  }
}
