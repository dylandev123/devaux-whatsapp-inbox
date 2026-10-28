// Server-only: the READ-ONLY review of existing orders (lib/aiAgent/orderReview.ts). Loads each outstanding order's own
// conversation and any picture readings that were already made; makes no model call, writes nothing, never touches a customer.

import { reviewOrder, type OrderReview, type ReviewLine } from "@/lib/aiAgent/orderReview";
import type { PictureReading } from "@/lib/aiAgent/orderImages";
import { isOutbound } from "@/lib/whatsapp";
import { agentDb } from "@/lib/server/aiAgent/db";
import { QUOTE_COLUMNS, quotedIdOf } from "@/lib/server/aiAgent/context";
import { loadOutstandingOrders } from "@/lib/server/aiAgent/orders";

const MAX_ORDERS = 120;
const LOOKBACK_HOURS = 24;
const MAX_MESSAGES = 4000;

export interface OrderReviewResult {
  reviews: OrderReview[];
  /** Outstanding orders looked at, and how many were left out by the cap. */
  checked: number;
  skipped: number;
}

export async function loadOrderReviews(businessSlug: string, timezone: string): Promise<OrderReviewResult> {
  const all = await loadOutstandingOrders(businessSlug);
  const orders = [...all].sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at)).slice(0, MAX_ORDERS);
  if (orders.length === 0) return { reviews: [], checked: 0, skipped: 0 };
  const chats = [...new Set(orders.map((o) => o.chat_id))];
  const since = new Date(Math.min(...orders.map((o) => Date.parse(o.first_message_at))) - LOOKBACK_HOURS * 3_600_000).toISOString();
  const { data, error } = await agentDb()
    .from("whatsapp_messages")
    .select(`whatsapp_message_id, chat_id, direction, message_type, message_body, media_url, timestamp, ${QUOTE_COLUMNS}`)
    .eq("business_slug", businessSlug)
    .in("chat_id", chats)
    .gte("timestamp", since)
    .order("timestamp", { ascending: true })
    .limit(MAX_MESSAGES);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const byChat = new Map<string, ReviewLine[]>();
  for (const r of rows) {
    const media = typeof r.media_url === "string" && r.media_url ? String(r.message_type ?? "") : null;
    const body = typeof r.message_body === "string" ? r.message_body.trim() : "";
    if (!body && !media) continue;
    const line: ReviewLine = {
      who: isOutbound(String(r.direction)) ? "Staff" : "Customer",
      text: body.slice(0, 600),
      at: String(r.timestamp),
      id: String(r.whatsapp_message_id),
      quotedId: quotedIdOf(r),
      mediaKind: media,
      mediaUrl: media ? String(r.media_url) : null,
    };
    const list = byChat.get(String(r.chat_id)) ?? [];
    list.push(line);
    byChat.set(String(r.chat_id), list);
  }
  // Picture readings that already exist (made when a turn pointed at the picture). Reading them here costs nothing.
  const readings: Record<string, PictureReading> = {};
  const imageIds = [...byChat.values()].flat().filter((l) => l.mediaKind === "image" && l.id).map((l) => l.id!);
  if (imageIds.length > 0) {
    const { data: cached } = await agentDb().from("ai_agent_audit_log").select("target_id, details").eq("business_slug", businessSlug).eq("action", "orders.picture_read").in("target_id", imageIds.slice(0, 400));
    for (const c of (cached ?? []) as { target_id: string; details: { reading?: PictureReading } | null }[]) if (c.details?.reading) readings[c.target_id] = c.details.reading;
  }
  const reviews = orders
    .map((order) => reviewOrder({ order, lines: byChat.get(order.chat_id) ?? [], timezone, readings }))
    .filter((r) => r.findings.length > 0);
  return { reviews, checked: orders.length, skipped: Math.max(0, all.length - orders.length) };
}
