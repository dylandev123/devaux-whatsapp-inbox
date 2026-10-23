// Server-only: the facts evaluateGate() needs about one conversation — who the
// contact is, their allow/exclude rule, human-takeover state, and whether a
// human recently wrote in the chat. Shared by the decision pipeline (decide.ts)
// and the staff-answer flow (staffGroup.ts) so a customer message can never be
// judged by two different sets of rules.

import type { AgentSettings, ContactRule, ConversationControl } from "@/lib/aiAgent/engine";
import { combineRules } from "@/lib/aiAgent/identity";
import { latestManualStaffMessageAt } from "@/lib/server/aiAgent/context";
import { agentDb } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";

export async function loadGateData(businessSlug: string, chatId: string, contactNumber: string | null, settings: AgentSettings | null) {
  const db = agentDb();
  const identity = await loadIdentity(businessSlug, chatId, contactNumber);
  const [rules, conversation, staffActiveAt] = await Promise.all([
    db.from("ai_agent_contact_rules").select("chat_id, rule").eq("business_slug", businessSlug).in("chat_id", identity.chatIds),
    db
      .from("ai_agent_conversations")
      .select("control, human_until")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .maybeSingle(),
    latestManualStaffMessageAt(businessSlug, chatId, settings?.auto_takeover_minutes ?? 0),
  ]);
  const matched = (rules.data ?? []) as { chat_id: string; rule: ContactRule }[];
  const contactRule = combineRules(matched);
  return {
    identity,
    contactRule,
    unresolvedLid: identity.unresolvedLid,
    // Rule found only under another identity of the same contact (phone <-> @lid).
    matchedViaAlias: contactRule !== null && !matched.some((r) => r.chat_id === chatId && r.rule === contactRule),
    conversation: (conversation.data as ConversationControl | null) ?? null,
    staffActiveAt,
  };
}
