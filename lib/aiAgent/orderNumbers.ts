// Simple order numbers: "!order 2 completed" means the order shown as 2 in a report the group was actually given.
// Pure (no I/O), unit-tested in tests/aiAgentOrderNumbers.test.ts. The server side (lib/server/aiAgent/orderLists.ts)
// stores each report's numbering when it is posted; this file decides what a typed number means against those stored lists.
//
// The rules that keep it from ever touching the wrong order:
//   * a number is resolved ONLY against the list that was posted (its stored order ids), never against a fresh, re-sorted query;
//   * a quoted report message names its list outright;
//   * without a quote, the newest list of each report type is a candidate; the number must mean the SAME order in every
//     candidate, otherwise nothing happens and staff are told to quote the report or use the #REF;
//   * a list older than LIST_TTL_MS is expired: nothing happens and staff are told to ask for the report again;
//   * the order must not have changed since the list was posted (its version is stored): a changed order is refused.

export const LIST_TTL_MS = 6 * 3_600_000;

export interface ListItem {
  n: number;
  order_id: string;
  ref: string;
  version: number;
}

export interface OrderList {
  id: string;
  view_kind: string;
  list_key: string;
  created_at: string;
  items: ListItem[];
}

export type NumberResolution =
  | { kind: "one"; item: ListItem; list: OrderList }
  /** No report was posted in this group (or none still stored). */
  | { kind: "no_list" }
  /** Every report that could be meant is older than the time limit. */
  | { kind: "expired"; newestAt: string }
  /** The number is not in the list(s) (they have `max` orders at most). */
  | { kind: "out_of_range"; n: number; max: number }
  /** The number means different orders in different recent reports. */
  | { kind: "ambiguous"; choices: { list: OrderList; item: ListItem }[] }
  /** A quoted message was not one of this group's reports. */
  | { kind: "quoted_not_a_list" };

/** Display name for a report type in a reply ("!orders overdue"). */
export function listLabel(viewKind: string): string {
  return viewKind === "default" ? "!orders" : viewKind.startsWith("day:") ? `!orders ${viewKind.slice(4)}` : `!orders ${viewKind}`;
}

const age = (list: OrderList, now: Date) => now.getTime() - Date.parse(list.created_at);

/**
 * Resolves number `n`.
 * `lists` are this business's lists for this group, in any order; `quoted` is the list a quoted report message belongs to
 * (null = no quote; undefined is the same). `quotedUnknown` is true when the staff member quoted a message that is not a report.
 */
export function resolveOrderNumber(args: {
  n: number;
  lists: OrderList[];
  quoted?: OrderList | null;
  quotedUnknown?: boolean;
  now: Date;
}): NumberResolution {
  const { n, now } = args;
  const pick = (list: OrderList) => list.items.find((i) => i.n === n) ?? null;

  if (args.quoted) {
    if (age(args.quoted, now) > LIST_TTL_MS) return { kind: "expired", newestAt: args.quoted.created_at };
    const item = pick(args.quoted);
    return item ? { kind: "one", item, list: args.quoted } : { kind: "out_of_range", n, max: args.quoted.items.length };
  }
  // A quote that is not a report cannot name one; falling back to "the latest list" would guess.
  if (args.quotedUnknown) return { kind: "quoted_not_a_list" };

  if (args.lists.length === 0) return { kind: "no_list" };
  // Newest of each report type.
  const newestByKind = new Map<string, OrderList>();
  for (const list of [...args.lists].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (!newestByKind.has(list.view_kind)) newestByKind.set(list.view_kind, list);
  }
  const live = [...newestByKind.values()].filter((l) => age(l, now) <= LIST_TTL_MS);
  if (live.length === 0) {
    return { kind: "expired", newestAt: args.lists.map((l) => l.created_at).sort().at(-1)! };
  }
  const hits = live.flatMap((list) => {
    const item = pick(list);
    return item ? [{ list, item }] : [];
  });
  if (hits.length === 0) return { kind: "out_of_range", n, max: Math.max(...live.map((l) => l.items.length)) };
  // Reports that all mean the same order agree; anything else is a guess we refuse to make.
  if (new Set(hits.map((h) => h.item.order_id)).size > 1) {
    return { kind: "ambiguous", choices: hits.sort((a, b) => Date.parse(b.list.created_at) - Date.parse(a.list.created_at)) };
  }
  // The newest report that contains it; a report in which the number does not exist cannot contradict it.
  const best = hits.sort((a, b) => Date.parse(b.list.created_at) - Date.parse(a.list.created_at))[0];
  return { kind: "one", item: best.item, list: best.list };
}

/** The list key of a report part's outbox dedupe key: "<key>", "<key>:p2", "<key>:p3" … → "<key>". */
export function listKeyOf(dedupeKey: string): string {
  return dedupeKey.replace(/:p\d+$/, "");
}

export const NUMBER_REPLY = {
  noList: "⚠️ I have no order list to read that number from. Send !orders first, then use the number shown (or use the order #REF). Nothing changed.",
  expired: (newestAt: string, now: Date) => {
    const hours = Math.max(1, Math.round((now.getTime() - Date.parse(newestAt)) / 3_600_000));
    return `⚠️ That list was posted about ${hours} hour${hours === 1 ? "" : "s"} ago and has expired, so its numbers may no longer match. Send !orders again, or use the order #REF. Nothing changed.`;
  },
  outOfRange: (n: number, max: number) => `⚠️ There is no number ${n} in that list${max > 0 ? ` (it has 1–${max})` : ""}. Nothing changed.`,
  quotedNotList: "⚠️ The message you replied to is not an order list, so I can't tell which number you mean. Reply to the list itself, or use the order #REF. Nothing changed.",
  changed: (ref: string) => `⚠️ ${ref} changed after that list was posted, so I did not apply the command to it. Send !orders again for the current numbers, or use its #REF. Nothing changed.`,
  gone: "⚠️ That order is no longer in this business. Nothing changed.",
  ambiguous: (n: number, choices: { label: string; ref: string }[]) =>
    [
      `⚠️ Number ${n} means different orders in your recent lists — nothing changed:`,
      ...choices.slice(0, 4).map((c) => `• ${c.label}: ${c.ref}`),
      "Reply to the list you mean with the same command, or use the order #REF.",
    ].join("\n"),
};
