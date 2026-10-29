// Server-only: the numbered lists behind "!order 2". Every !orders report and the morning summary stores which order each
// number meant when it was posted (ai_agent_order_lists, migration 20261110000000); a typed number is resolved against that
// stored list, scoped to the business and the group, and the order is then re-checked for changes (orderNumberTarget.ts).
// Pure rules (expiry, ambiguity): lib/aiAgent/orderNumbers.ts.

import type { TrackedOrder } from "@/lib/aiAgent/orders";
import { listKeyOf, type ListItem, type OrderList } from "@/lib/aiAgent/orderNumbers";
import { agentDb } from "@/lib/server/aiAgent/db";

const KEEP_DAYS = 7;

/** Records the numbering of a report that is about to be posted. Best effort: a failure here must never stop the report. */
export async function saveOrderList(args: {
  businessSlug: string;
  groupJid: string;
  viewKind: string;
  listKey: string;
  numbered: { n: number; order: Pick<TrackedOrder, "id" | "ref_code" | "version"> }[];
}): Promise<void> {
  try {
    const items: ListItem[] = args.numbered.map(({ n, order }) => ({ n, order_id: order.id, ref: order.ref_code, version: order.version }));
    const db = agentDb();
    const { error } = await db
      .from("ai_agent_order_lists")
      .upsert({ business_slug: args.businessSlug, group_jid: args.groupJid, view_kind: args.viewKind, list_key: args.listKey, items }, { onConflict: "business_slug,list_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    await db
      .from("ai_agent_order_lists")
      .delete()
      .eq("business_slug", args.businessSlug)
      .lt("created_at", new Date(Date.now() - KEEP_DAYS * 24 * 3_600_000).toISOString());
  } catch (err) {
    console.error("[aiAgent] order list not stored", err instanceof Error ? err.message : err);
  }
}

const LIST_COLUMNS = "id, view_kind, list_key, created_at, items";

export async function recentLists(businessSlug: string, groupJid: string, now: Date): Promise<OrderList[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_order_lists")
    .select(LIST_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("group_jid", groupJid)
    .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return (data ?? []) as OrderList[];
}

/** The list a quoted message belongs to: the quoted message must be one of THIS business's posts into THIS group. */
export async function quotedList(businessSlug: string, groupJid: string, quotedMessageId: string): Promise<OrderList | null> {
  const db = agentDb();
  const { data: row, error } = await db
    .from("ai_agent_outbox")
    .select("dedupe_key, to_jid")
    .eq("business_slug", businessSlug)
    .eq("whatsapp_message_id", quotedMessageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.to_jid !== groupJid) return null;
  const { data, error: listError } = await db
    .from("ai_agent_order_lists")
    .select(LIST_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("group_jid", groupJid)
    .eq("list_key", listKeyOf(row.dedupe_key))
    .maybeSingle();
  if (listError) throw new Error(listError.message);
  return (data as OrderList | null) ?? null;
}
