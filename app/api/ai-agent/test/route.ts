import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { pilotSlug } from "@/lib/server/aiAgent/db";
import { simulateMessage } from "@/lib/server/aiAgent/decide";

// Admin-only test console. Runs the real decision pipeline as a dry run:
// nothing is written, nothing is sent, regardless of settings.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; chatId?: unknown; text?: unknown }>(request);
  const businessSlug = pilotSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("businessSlug must be a pilot business", 400);
  if (typeof body.text !== "string" || !body.text.trim()) return jsonError("text is required", 400);

  try {
    const result = await simulateMessage({
      businessSlug,
      chatId: typeof body.chatId === "string" && body.chatId.trim() ? body.chatId.trim() : null,
      text: body.text.slice(0, 2000),
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Simulation failed", 500);
  }
}
