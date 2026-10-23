import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { aliasChatIds, normalizeContactInput } from "@/lib/aiAgent/chatDirectory";
import { loadBusinessChats } from "@/lib/server/aiAgent/chats";
import { agentDb, audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only. Per-contact allow/exclude rules (see ai_agent_contact_rules).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

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
  const body = await readJson<{
    businessSlug?: unknown;
    chatId?: unknown;
    number?: unknown;
    displayName?: unknown;
    rule?: unknown;
  }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  if (body.rule !== "allow" && body.rule !== "exclude") return jsonError('rule must be "allow" or "exclude"', 400);

  // Either a known chat's exact chat_id (from the picker) or a typed number /
  // JID, which is normalized to the bridge's representation.
  const typed = typeof body.number === "string" ? body.number : typeof body.chatId === "string" ? body.chatId : "";
  if (!typed.trim()) return jsonError("chatId or number is required", 400);
  const target = normalizeContactInput(typed);
  if (!target.ok) return jsonError(target.error, 400);

  try {
    // Same person under another known JID (e.g. an @lid chat whose real
    // number matches exactly) gets the same rule, so it matches what the
    // bridge forwards. Known chats are this business's only.
    const known = typeof body.number === "string" ? (await loadBusinessChats(businessSlug)).contacts : [];
    const chatIds = target.kind === "phone" ? aliasChatIds(target.digits, known) : [target.chatId];
    if (typeof body.chatId === "string" && !chatIds.includes(target.chatId)) chatIds.push(target.chatId);

    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 200) : null;
    const { data, error } = await agentDb()
      .from("ai_agent_contact_rules")
      .upsert(
        chatIds.map((chatId) => ({
          business_slug: businessSlug,
          chat_id: chatId,
          display_name: displayName ?? known.find((c) => c.chatId === chatId)?.name ?? null,
          rule: body.rule,
          created_by: admin.userId,
        })),
        { onConflict: "business_slug,chat_id" }
      )
      .select("id, chat_id, display_name, rule, created_at");
    if (error) return jsonError(error.message, 500);
    for (const row of data ?? []) {
      await audit(businessSlug, "admin", admin.userId, `contact.${body.rule}`, { type: "contact", id: row.chat_id });
    }
    return NextResponse.json({ rule: data?.find((r) => r.chat_id === target.chatId) ?? data?.[0], rules: data ?? [] });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to save contact rule", 500);
  }
}

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
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
