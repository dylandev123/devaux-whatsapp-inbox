// Simple order numbers ("!order 2 completed"): command parsing and the pure rules for what a number means.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderCommand } from "../lib/aiAgent/orderCommands.ts";
import { LIST_TTL_MS, listKeyOf, type OrderList, resolveOrderNumber } from "../lib/aiAgent/orderNumbers.ts";

const NOW = new Date("2026-10-29T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const list = (id: string, view_kind: string, minutes: number, orderIds: string[]): OrderList => ({
  id,
  view_kind,
  list_key: `ordersview:dog_food:${id}`,
  created_at: minutesAgo(minutes),
  items: orderIds.map((order_id, i) => ({ n: i + 1, order_id, ref: `O-${order_id.toUpperCase()}`, version: 1 })),
});

describe("order number commands: parsing", () => {
  test("a bare 1–3 digit number selects a list position, everywhere a #REF is accepted", () => {
    assert.deepEqual(parseOrderCommand("!order 2"), { kind: "info", selector: { type: "number", n: 2 } });
    assert.deepEqual(parseOrderCommand("!order 2 completed"), { kind: "update", selector: { type: "number", n: 2 }, action: { type: "complete" } });
    assert.deepEqual(parseOrderCommand("!order 12 cancelled"), { kind: "update", selector: { type: "number", n: 12 }, action: { type: "cancel" } });
    assert.deepEqual(parseOrderCommand("!order 3 confirmed"), { kind: "update", selector: { type: "number", n: 3 }, action: { type: "confirm" } });
    assert.deepEqual(parseOrderCommand("!order 2 reopen"), { kind: "update", selector: { type: "number", n: 2 }, action: { type: "reopen" } });
    assert.deepEqual(parseOrderCommand("!order 4 delivery tomorrow"), { kind: "update", selector: { type: "number", n: 4 }, action: { type: "delivery", when: "tomorrow" } });
    assert.deepEqual(parseOrderCommand("!order 2 teach Change the address to Cap Estate"), { kind: "teach", selector: { type: "number", n: 2 }, instruction: "Change the address to Cap Estate" });
    assert.deepEqual(parseOrderCommand("!moreinfo 2"), { kind: "info", selector: { type: "number", n: 2 } });
  });

  test("a number followed by a quantity is a quantity change on that number", () => {
    assert.deepEqual(parseOrderCommand("!order 2 3 bags"), { kind: "update", selector: { type: "number", n: 2 }, action: { type: "quantity", quantity: 3 } });
  });

  test("#REF commands are unchanged, and a phone number is still a phone number", () => {
    assert.deepEqual(parseOrderCommand("!order #QU6U9 completed"), { kind: "update", selector: { type: "ref", ref: "O-QU6U9" }, action: { type: "complete" } });
    assert.deepEqual(parseOrderCommand("!order 7585550102"), { kind: "search", query: "7585550102" });
    assert.deepEqual(parseOrderCommand("!order 0 completed"), { kind: "help", reason: "order" }, "there is no number 0");
    assert.equal(parseOrderCommand("!order 2 banana")?.kind, "help", "an action it does not know changes nothing");
  });

  test("a number is never taken from a longer digit string (4+ digits are not list positions)", () => {
    assert.deepEqual(parseOrderCommand("!order 1234 completed"), { kind: "help", reason: "order" });
  });
});

describe("what a number means", () => {
  const A = list("a", "default", 30, ["x1", "x2", "x3"]);

  test("the number means the order that position held when the list was posted", () => {
    const r = resolveOrderNumber({ n: 2, lists: [A], now: NOW });
    assert.equal(r.kind === "one" && r.item.order_id, "x2");
  });

  test("the stored order ids decide, never the current position: a re-sorted list changes nothing", () => {
    // A newer report of the same type replaces the older one as THE list; both are consulted only through their stored ids.
    const newer = list("b", "default", 1, ["x9", "x1", "x2", "x3"]);
    const r = resolveOrderNumber({ n: 2, lists: [A, newer], now: NOW });
    assert.equal(r.kind === "one" && r.item.order_id, "x1", "the newest report of that type is the one on screen");
    // Quoting the OLD report keeps its numbering.
    const quoted = resolveOrderNumber({ n: 2, lists: [A, newer], quoted: A, now: NOW });
    assert.equal(quoted.kind === "one" && quoted.item.order_id, "x2");
  });

  test("a number outside the list is refused", () => {
    assert.deepEqual(resolveOrderNumber({ n: 4, lists: [A], now: NOW }), { kind: "out_of_range", n: 4, max: 3 });
  });

  test("no list at all, and an expired list, are refused (and say which)", () => {
    assert.deepEqual(resolveOrderNumber({ n: 1, lists: [], now: NOW }), { kind: "no_list" });
    const old = list("o", "default", LIST_TTL_MS / 60_000 + 1, ["x1"]);
    assert.equal(resolveOrderNumber({ n: 1, lists: [old], now: NOW }).kind, "expired");
    assert.equal(resolveOrderNumber({ n: 1, lists: [], quoted: old, now: NOW }).kind, "expired");
    const justInside = list("i", "default", LIST_TTL_MS / 60_000 - 1, ["x1"]);
    assert.equal(resolveOrderNumber({ n: 1, lists: [justInside], now: NOW }).kind, "one");
  });

  test("an expired list of one type does not hide a live list of another", () => {
    const old = list("o", "all", LIST_TTL_MS / 60_000 + 60, ["x7"]);
    const r = resolveOrderNumber({ n: 1, lists: [old, A], now: NOW });
    assert.equal(r.kind === "one" && r.item.order_id, "x1");
  });

  test("two report types that disagree about a number are ambiguous; agreeing ones are not", () => {
    const overdue = list("c", "overdue", 5, ["y1", "y2"]);
    const r = resolveOrderNumber({ n: 1, lists: [A, overdue], now: NOW });
    assert.equal(r.kind, "ambiguous");
    assert.deepEqual(r.kind === "ambiguous" && r.choices.map((c) => c.item.order_id), ["y1", "x1"], "newest first");
    // Both reports put the same order at 1: no guessing is involved.
    const same = list("d", "today", 5, ["x1"]);
    assert.equal(resolveOrderNumber({ n: 1, lists: [A, same], now: NOW }).kind, "one");
    // Number 3 exists in only one of them: the other cannot contradict it.
    const r3 = resolveOrderNumber({ n: 3, lists: [A, same], now: NOW });
    assert.equal(r3.kind === "one" && r3.item.order_id, "x3");
  });

  test("a quoted report decides alone; a quote that is not a report cannot be guessed past", () => {
    const overdue = list("c", "overdue", 5, ["y1", "y2"]);
    assert.equal((resolveOrderNumber({ n: 1, lists: [A, overdue], quoted: A, now: NOW }) as { item: { order_id: string } }).item.order_id, "x1");
    assert.equal(resolveOrderNumber({ n: 1, lists: [A], quotedUnknown: true, now: NOW }).kind, "quoted_not_a_list");
  });

  test("report parts share one list key", () => {
    assert.equal(listKeyOf("ordersview:dog_food:GRP-4:p1"), "ordersview:dog_food:GRP-4");
    assert.equal(listKeyOf("ordersview:dog_food:GRP-4:p3"), "ordersview:dog_food:GRP-4");
    assert.equal(listKeyOf("ordersummary:scheduled:2026-10-29"), "ordersummary:scheduled:2026-10-29");
  });
});
