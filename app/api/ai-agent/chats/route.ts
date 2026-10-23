import { NextResponse } from "next/server";
import { groupLabel, matchesChatSearch, normalizeContactInput, sortByRecent } from "@/lib/aiAgent/chatDirectory";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { loadBusinessChats } from "@/lib/server/aiAgent/chats";
import { agentDb, resolveBusinessSlug } from "@/lib/server/aiAgent/db";

// Admin-only. Server-side search over ONE business's known chats, for the
// contact-permission and staff-group pickers on /admin/ai-agent.
//   GET ?businessSlug=…&kind=contact|group&q=…
export const dynamic = "force-dynamic";

const LIMIT = 25;

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  const kind = params.get("kind");
  if (kind !== "contact" && kind !== "group") return jsonError('kind must be "contact" or "group"', 400);
  const query = (params.get("q") ?? "").slice(0, 100);

  try {
    const chats = await loadBusinessChats(businessSlug);

    if (kind === "group") {
      const { data: settings } = await agentDb()
        .from("ai_agent_settings")
        .select("staff_group_jid, staff_group_name")
        .eq("business_slug", businessSlug)
        .maybeSingle();
      const savedName = (jid: string) => (settings?.staff_group_jid === jid ? settings.staff_group_name : null);
      const groups = sortByRecent(
        chats.groups.map((g) => {
          const name = savedName(g.chatId);
          return {
            chatId: g.chatId,
            name: name ?? null,
            label: groupLabel({ chatId: g.chatId, name }),
            lastSender: g.lastSender,
            lastMessageAt: g.lastMessageAt,
            memberCount: null as number | null,
          };
        })
      ).filter((g) => matchesChatSearch({ chatId: g.chatId, name: `${g.name ?? ""} ${g.lastSender ?? ""}`.trim() || null, number: null, lastMessageAt: null }, query));
      return NextResponse.json({ results: groups.slice(0, LIMIT), total: groups.length, rpcAvailable: chats.rpcAvailable });
    }

    const { data: rules, error } = await agentDb()
      .from("ai_agent_contact_rules")
      .select("chat_id, rule")
      .eq("business_slug", businessSlug);
    if (error) throw new Error(error.message);
    const ruleByChat = new Map((rules ?? []).map((r) => [r.chat_id as string, r.rule as "allow" | "exclude"]));

    const matched = sortByRecent(chats.contacts.filter((c) => matchesChatSearch(c, query)));
    const results = matched.slice(0, LIMIT).map((c) => ({
      chatId: c.chatId,
      name: c.name,
      number: c.chatId.endsWith("@lid") ? c.number : c.number ?? c.chatId.split("@")[0],
      isLid: c.chatId.toLowerCase().endsWith("@lid"),
      lastMessageAt: c.lastMessageAt,
      rule: ruleByChat.get(c.chatId) ?? null,
    }));

    // A typed number that isn't in the results can be added manually.
    let manual: { chatId: string; rule: "allow" | "exclude" | null } | null = null;
    const normalized = query.trim() ? normalizeContactInput(query) : null;
    if (normalized?.ok && !results.some((r) => r.chatId === normalized.chatId)) {
      manual = { chatId: normalized.chatId, rule: ruleByChat.get(normalized.chatId) ?? null };
    }
    return NextResponse.json({ results, total: matched.length, manual, rpcAvailable: chats.rpcAvailable });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to search chats", 500);
  }
}
