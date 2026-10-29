// Server-only: resolves "!order 2" to the order that number meant in the report staff are looking at.
// The stored lists: lib/server/aiAgent/orderLists.ts. Pure rules (expiry, ambiguity): lib/aiAgent/orderNumbers.ts.

import { displayRef } from "@/lib/aiAgent/orders";
import { listLabel, NUMBER_REPLY, resolveOrderNumber } from "@/lib/aiAgent/orderNumbers";
import { audit } from "@/lib/server/aiAgent/db";
import { quotedList, recentLists } from "@/lib/server/aiAgent/orderLists";
import { type CommandContext, groupReply, loadOrderById } from "@/lib/server/aiAgent/orders";

export type NumberedTarget = { ok: true; ref: string; version: number; listKind: string } | { ok: false; result: ReturnType<typeof groupReply> };

/**
 * Turns "number n" typed in `ctx.fromGroup` into the order reference of the order that number meant in the report staff
 * are looking at. Refuses (with a reply, changing nothing) when there is no report, it expired, the number is missing or means
 * different orders in different recent reports, or the order changed after the report was posted.
 * `mustBeUnchanged`: false for read-only lookups, which may show an order that changed since.
 */
export async function resolveNumberedTarget(ctx: CommandContext & { quotedMessageId?: string | null }, n: number, mustBeUnchanged: boolean, now: Date): Promise<NumberedTarget> {
  const { settings, fromGroup } = ctx;
  const slug = settings.business_slug;
  const refuse = async (reason: string, body: string): Promise<NumberedTarget> => {
    await audit(slug, "staff", ctx.senderAuth.senderId, "orders.command_rejected", { type: "chat", id: fromGroup }, { reason, number: n });
    return { ok: false, result: groupReply(settings, fromGroup, ctx.eventId, body, "staff_notice", `orders:cmd_${reason}`) };
  };

  const quoted = ctx.quotedMessageId ? await quotedList(slug, fromGroup, ctx.quotedMessageId) : null;
  const lists = quoted ? [] : await recentLists(slug, fromGroup, now);
  // A quote on a message that is not one of our reports (an order card, a customer message, chatter) cannot name a list.
  const resolution = resolveOrderNumber({ n, lists, quoted, quotedUnknown: Boolean(ctx.quotedMessageId) && !quoted, now });

  switch (resolution.kind) {
    case "no_list":
      return refuse("no_list", NUMBER_REPLY.noList);
    case "expired":
      return refuse("list_expired", NUMBER_REPLY.expired(resolution.newestAt, now));
    case "out_of_range":
      return refuse("number_out_of_range", NUMBER_REPLY.outOfRange(resolution.n, resolution.max));
    case "quoted_not_a_list":
      return refuse("quoted_not_a_list", NUMBER_REPLY.quotedNotList);
    case "ambiguous":
      return refuse(
        "number_ambiguous",
        NUMBER_REPLY.ambiguous(
          n,
          resolution.choices.map((c) => ({ label: listLabel(c.list.view_kind), ref: displayRef(c.item.ref) }))
        )
      );
    case "one": {
      const order = await loadOrderById(slug, resolution.item.order_id);
      if (!order) return refuse("order_gone", NUMBER_REPLY.gone);
      if (mustBeUnchanged && order.version !== resolution.item.version) return refuse("list_stale", NUMBER_REPLY.changed(displayRef(order.ref_code)));
      await audit(slug, "staff", ctx.senderAuth.senderId, "orders.number_resolved", { type: "order", id: order.id }, { number: n, list: resolution.list.list_key, view: resolution.list.view_kind, quoted: Boolean(quoted) });
      return { ok: true, ref: order.ref_code.toUpperCase(), version: resolution.item.version, listKind: resolution.list.view_kind };
    }
  }
}
