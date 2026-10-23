import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { setConversationControl } from "@/lib/server/aiAgent/escalations";

// Admin-only. Human takeover / resume per conversation.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_conversations")
    .select("chat_id, contact_number, control, human_until, control_reason, control_changed_at, last_decision, last_event_at")
    .eq("business_slug", businessSlug)
    .order("last_event_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ conversations: data ?? [] });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; chatId?: unknown; action?: unknown; minutes?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.chatId !== "string" || !body.chatId.trim()) {
    return jsonError("businessSlug and chatId are required", 400);
  }
  if (body.action !== "takeover" && body.action !== "resume") return jsonError('action must be "takeover" or "resume"', 400);
  const minutes =
    typeof body.minutes === "number" && Number.isInteger(body.minutes) && body.minutes > 0 && body.minutes <= 10080
      ? body.minutes
      : null;

  try {
    await setConversationControl({
      businessSlug,
      chatId: body.chatId.trim(),
      control: body.action === "takeover" ? "human" : "ai",
      minutes: body.action === "takeover" ? minutes : null,
      reason: "admin_ui",
      actorKind: "admin",
      actorId: admin.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to update conversation", 500);
  }
}
