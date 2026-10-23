import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, pilotSlug } from "@/lib/server/aiAgent/db";

// Admin-only. Per-contact allow/exclude rules (see ai_agent_contact_rules).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = pilotSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("businessSlug must be a pilot business", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_contact_rules")
    .select("id, chat_id, display_name, rule, created_at")
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ rules: data ?? [] });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; chatId?: unknown; displayName?: unknown; rule?: unknown }>(request);
  const businessSlug = pilotSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("businessSlug must be a pilot business", 400);
  if (typeof body.chatId !== "string" || !body.chatId.trim()) return jsonError("chatId is required", 400);
  if (body.chatId.endsWith("@g.us")) return jsonError("The agent never replies in groups", 400);
  if (body.rule !== "allow" && body.rule !== "exclude") return jsonError('rule must be "allow" or "exclude"', 400);

  const { data, error } = await agentDb()
    .from("ai_agent_contact_rules")
    .upsert(
      {
        business_slug: businessSlug,
        chat_id: body.chatId.trim(),
        display_name: typeof body.displayName === "string" ? body.displayName.slice(0, 200) : null,
        rule: body.rule,
        created_by: admin.userId,
      },
      { onConflict: "business_slug,chat_id" }
    )
    .select("id, chat_id, display_name, rule, created_at")
    .single();
  if (error) return jsonError(error.message, 500);
  await audit(businessSlug, "admin", admin.userId, `contact.${body.rule}`, { type: "contact", id: data.chat_id });
  return NextResponse.json({ rule: data });
}

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = pilotSlug(params.get("businessSlug"));
  const chatId = params.get("chatId");
  if (!businessSlug || !chatId) return jsonError("businessSlug and chatId are required", 400);

  const { error } = await agentDb()
    .from("ai_agent_contact_rules")
    .delete()
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId);
  if (error) return jsonError(error.message, 500);
  await audit(businessSlug, "admin", admin.userId, "contact.remove_rule", { type: "contact", id: chatId });
  return NextResponse.json({ ok: true });
}
