import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { effectiveCustomerMode, isCustomerMode } from "@/lib/aiAgent/customerMode";
import { agentDb, loadSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { findOpenEscalation, setConversationControl, setCustomerMode } from "@/lib/server/aiAgent/escalations";

// Admin-only. Human takeover / resume per conversation.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const chatId = new URL(request.url).searchParams.get("chatId")?.trim();
  if (chatId) {
    // One customer's state for the Inbox: takeover, handling mode (own and effective) and any open escalation.
    try {
      const [settings, row, open] = await Promise.all([
        loadSettings(businessSlug),
        agentDb()
          .from("ai_agent_conversations")
          .select("chat_id, control, human_until, customer_mode")
          .eq("business_slug", businessSlug)
          .eq("chat_id", chatId)
          .maybeSingle(),
        findOpenEscalation(businessSlug, chatId),
      ]);
      if (row.error) throw new Error(row.error.message);
      const conversation = row.data as { control: "ai" | "human"; human_until: string | null; customer_mode: string | null } | null;
      return NextResponse.json({
        agentEnabled: Boolean(settings?.enabled),
        agentMode: settings?.mode ?? "observe",
        customerMode: effectiveCustomerMode(settings, conversation),
        ownMode: isCustomerMode(conversation?.customer_mode) ? conversation?.customer_mode : null,
        defaultMode: effectiveCustomerMode(settings, null),
        control: conversation?.control ?? "ai",
        humanUntil: conversation?.human_until ?? null,
        openEscalation: open ? { refCode: open.ref_code, priority: open.priority } : null,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Failed to load conversation", 500);
    }
  }

  const { data, error } = await agentDb()
    .from("ai_agent_conversations")
    .select("chat_id, contact_number, control, human_until, control_reason, control_changed_at, last_decision, last_event_at, customer_mode")
    .eq("business_slug", businessSlug)
    .order("last_event_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ conversations: data ?? [] });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; chatId?: unknown; action?: unknown; minutes?: unknown; mode?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.chatId !== "string" || !body.chatId.trim()) {
    return jsonError("businessSlug and chatId are required", 400);
  }
  if (body.action === "set_mode") {
    // `mode: null` returns the customer to the business default.
    if (body.mode !== null && !isCustomerMode(body.mode)) return jsonError("mode must be auto_reply, staff_first, manual_only or null", 400);
    try {
      await setCustomerMode({ businessSlug, chatId: body.chatId.trim(), mode: body.mode, actorKind: "admin", actorId: admin.userId });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Failed to set the customer mode", 500);
    }
  }
  if (body.action !== "takeover" && body.action !== "resume") return jsonError('action must be "takeover", "resume" or "set_mode"', 400);
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
