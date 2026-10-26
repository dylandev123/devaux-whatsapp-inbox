// Natural-language order phrases (lib/aiAgent/orderText.ts): quantities, delivery vs collection, relative dates in the
// business's timezone from the message's own timestamp, and items a customer withdrew. Pure rules, no I/O.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrderRequestDraft } from "../lib/aiAgent/engine.ts";
import { groundOrderDraft } from "../lib/aiAgent/escalationUpdates.ts";
import {
  anchorRequestedFor,
  detectFulfilment,
  fillStatedQuantities,
  guardRemovedItems,
  messageTimeFor,
  quantityPhrases,
  refineOrderDraft,
  resolveRelativeDay,
  sameRequestedFor,
} from "../lib/aiAgent/orderText.ts";

const TZ = "America/St_Lucia"; // UTC-4, no daylight saving
const draftOf = (items: OrderRequestDraft["items"], over: Partial<OrderRequestDraft> = {}): OrderRequestDraft => ({
  items,
  delivery_address: null,
  delivery_preference: null,
  notes: null,
  ...over,
});
const qty = (d: OrderRequestDraft) => d.items.map((i) => i.quantity);

describe("quantities the customer states in plain words", () => {
  test("'a bag of Monello' and 'one bag' are 1; 'two bags' is 2", () => {
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["Hi, a bag of Monello please"])), ["1"]);
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["one bag"])), ["1"]);
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["two bags of Monello"])), ["2"]);
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["a 25kg bag of Monello"])), ["1"]);
  });
  test("'a couple of bags' is 2 only when the order has one product, or the phrase names the product", () => {
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["a couple of bags"])), ["2"]);
    const two = draftOf([{ product: "Monello", quantity: null }, { product: "Pedigree", quantity: null }]);
    assert.deepEqual(qty(fillStatedQuantities(two, ["a couple of bags"])), [null, null], "two products and no product named: nothing is guessed");
    assert.deepEqual(qty(fillStatedQuantities(two, ["a couple of bags of Monello"])), ["2", null]);
  });
  test("each product gets the quantity that names it; an unmatched phrase is never spread over several products", () => {
    const two = draftOf([{ product: "Monello", quantity: null }, { product: "Pedigree", quantity: null }]);
    assert.deepEqual(qty(fillStatedQuantities(two, ["a bag of Monello and two bags of Pedigree"])), ["1", "2"]);
    assert.deepEqual(qty(fillStatedQuantities(two, ["two bags please"])), [null, null]);
  });
  test("a quantity the model already gave is never overwritten, and no phrase means no quantity", () => {
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: "3" }]), ["a bag of Monello"])), ["3"]);
    assert.deepEqual(qty(fillStatedQuantities(draftOf([{ product: "Monello", quantity: null }]), ["some Monello please"])), [null]);
  });
  test("phrases are read from the customer's words only", () => {
    assert.deepEqual(quantityPhrases(["2 bags of Monello and 1 box of treats"]).map((p) => p.quantity), ["2", "1"]);
    assert.deepEqual(quantityPhrases(["do you have bags?"]), []);
  });
  test("grounding: 'a couple of' is not accepted as the customer saying 2 until the rules above place it", () => {
    const grounded = groundOrderDraft(draftOf([{ product: "Monello", quantity: "2" }]), null, ["a couple of bags of Monello"]);
    assert.equal(grounded!.items[0].quantity, null, "the model's 2 is dropped as ungrounded");
    assert.deepEqual(qty(refineOrderDraft(grounded!, ["a couple of bags of Monello"], ["a couple of bags of Monello"])), ["2"], "then filled deterministically");
  });
});

describe("delivery versus collection", () => {
  test("delivery wording is recorded as delivery", () => {
    for (const t of ["Bring it to Cap", "Deliver tomorrow", "can you drop it off at Rodney Bay", "please send them to Gros Islet", "delivery please", "I need it delivered"]) {
      assert.equal(detectFulfilment([t]), "delivery", t);
    }
  });
  test("collection wording is recorded as collection", () => {
    for (const t of ["I'll collect", "I will pick it up tomorrow", "coming to collect at 3", "I'll come and get it", "pickup at 5"]) {
      assert.equal(detectFulfilment([t]), "collection", t);
    }
  });
  test("the latest statement wins; negated, enquiring and 'either/or' wording records nothing", () => {
    assert.equal(detectFulfilment(["deliver it to Cap", "actually I'll collect"]), "collection");
    assert.equal(detectFulfilment(["I'll collect", "no wait, deliver it to Cap please"]), "delivery");
    assert.equal(detectFulfilment(["cancel the delivery, I'll collect"]), "collection");
    assert.equal(detectFulfilment(["Do you deliver?"]), null);
    assert.equal(detectFulfilment(["how much is delivery to Cap?"]), null);
    assert.equal(detectFulfilment(["can you deliver or should I collect?"]), null);
    assert.equal(detectFulfilment(["don't deliver it, I have no one home"]), null);
    assert.equal(detectFulfilment(["a bag of Monello"]), null);
  });
  test("a clear request is recorded even when the model leaves it out, so the customer is never asked again", () => {
    const refined = refineOrderDraft(draftOf([{ product: "Monello", quantity: "1" }]), ["Bring it to Cap"], ["a bag of Monello", "Bring it to Cap"]);
    assert.equal(refined.delivery_preference, "delivery");
    const collect = refineOrderDraft(draftOf([{ product: "Monello", quantity: "1" }], { delivery_preference: "delivery" }), ["I'll collect instead"], ["Bring it to Cap", "I'll collect instead"]);
    assert.equal(collect.delivery_preference, "collection", "this turn's statement beats an older delivery");
  });
  test("the model's own richer wording is kept when it agrees; an older single method fills a gap", () => {
    const kept = refineOrderDraft(draftOf([{ product: "Monello", quantity: "1" }], { delivery_preference: "delivery to Cap Estate" }), ["Bring it to Cap"], ["Bring it to Cap"]);
    assert.equal(kept.delivery_preference, "delivery to Cap Estate");
    const older = refineOrderDraft(draftOf([{ product: "Monello", quantity: "1" }]), ["2 bags"], ["deliver to Cap please", "2 bags"]);
    assert.equal(older.delivery_preference, "delivery");
    const mixed = refineOrderDraft(draftOf([{ product: "Monello", quantity: "1" }]), ["ok"], ["deliver to Cap", "no I'll collect", "ok"]);
    assert.equal(mixed.delivery_preference, null, "history that disagrees with itself decides nothing; only this turn's own words can");
  });
});

describe("relative dates count from when the customer wrote them, in America/St_Lucia", () => {
  // Mon 26 Oct 2026, 10:00 in St Lucia
  const MON = new Date("2026-10-26T14:00:00Z");
  test("today, tonight, tomorrow, the day after", () => {
    assert.deepEqual(resolveRelativeDay("today", MON, TZ), { date: "2026-10-26", label: "Mon 26 Oct" });
    assert.deepEqual(resolveRelativeDay("tonight", MON, TZ), { date: "2026-10-26", label: "Mon 26 Oct" });
    assert.deepEqual(resolveRelativeDay("tomorrow morning", MON, TZ), { date: "2026-10-27", label: "Tue 27 Oct" });
    assert.deepEqual(resolveRelativeDay("day after tomorrow", MON, TZ), { date: "2026-10-28", label: "Wed 28 Oct" });
  });
  test("weekday names are the coming one; a name that could mean two days is left alone", () => {
    assert.equal(resolveRelativeDay("Friday morning", MON, TZ)?.label, "Fri 30 Oct");
    assert.equal(resolveRelativeDay("on Sunday", MON, TZ)?.label, "Sun 1 Nov");
    assert.equal(resolveRelativeDay("Monday", MON, TZ), null, "a Monday said on a Monday: today or next week?");
    assert.equal(resolveRelativeDay("next Friday", MON, TZ), null);
    assert.equal(resolveRelativeDay("tomorrow or Friday", MON, TZ), null);
    assert.equal(resolveRelativeDay("sometime soon", MON, TZ), null);
  });
  test("the local date decides, not UTC: 10pm in St Lucia is already tomorrow in UTC", () => {
    const lateEvening = new Date("2026-10-27T02:30:00Z"); // 22:30 Mon 26 Oct in St Lucia
    assert.equal(resolveRelativeDay("today", lateEvening, TZ)?.label, "Mon 26 Oct");
    assert.equal(resolveRelativeDay("tomorrow", lateEvening, TZ)?.label, "Tue 27 Oct");
    const earlyMorning = new Date("2026-10-26T03:30:00Z"); // 23:30 Sun 25 Oct in St Lucia
    assert.equal(resolveRelativeDay("tomorrow", earlyMorning, TZ)?.label, "Mon 26 Oct");
  });
  test("month and year boundaries", () => {
    assert.equal(resolveRelativeDay("tomorrow", new Date("2026-10-31T15:00:00Z"), TZ)?.label, "Sun 1 Nov");
    assert.equal(resolveRelativeDay("tomorrow", new Date("2026-12-31T15:00:00Z"), TZ)?.label, "Fri 1 Jan");
  });
  test("the stored form keeps the customer's words and is stable when the model repeats them later", () => {
    const stored = anchorRequestedFor("tomorrow morning", null, MON, TZ);
    assert.equal(stored, "Tue 27 Oct (tomorrow morning)");
    // A later reprocessing on Wednesday, with the model still saying "tomorrow morning", must not move the date.
    const WED = new Date("2026-10-28T14:00:00Z");
    assert.equal(anchorRequestedFor("tomorrow morning", stored, WED, TZ), stored);
    assert.equal(sameRequestedFor(stored, "Tomorrow Morning"), true);
    assert.equal(sameRequestedFor(stored, "Friday"), false);
    // A genuinely new wish is resolved from ITS message time.
    assert.equal(anchorRequestedFor("Friday", stored, WED, TZ), "Fri 30 Oct (Friday)");
    assert.equal(anchorRequestedFor("sometime next week", null, MON, TZ), "sometime next week");
    assert.equal(anchorRequestedFor("", "Tue 27 Oct (tomorrow)", MON, TZ), "Tue 27 Oct (tomorrow)");
  });
  test("the time comes from the message that held the phrase, not from the newest message of the turn", () => {
    const segments = ["deliver tomorrow please", "thanks"];
    const times = ["2026-10-26T14:00:00Z", "2026-10-28T14:00:00Z"];
    const at = messageTimeFor("tomorrow", segments, times, times[1]);
    assert.equal(at.getTime(), Date.parse(times[0]));
    assert.equal(anchorRequestedFor("tomorrow", null, at, TZ), "Tue 27 Oct (tomorrow)");
    assert.equal(messageTimeFor("tomorrow", segments, undefined, times[1]).getTime(), Date.parse(times[1]), "no per-message times: the turn's last time");
  });
});

describe("items the customer withdrew", () => {
  const prior = [
    { product: "Monello Chicken", quantity: "2" },
    { product: "Dog Treats", quantity: "1" },
  ];
  test("'just the Monello bags' keeps Monello and reports the treats as removed", () => {
    const r = guardRemovedItems(prior, [{ product: "Monello Chicken", quantity: "2" }], ["Just the Monello bags"]);
    assert.deepEqual(r.items.map((i) => i.product), ["Monello Chicken"]);
    assert.deepEqual(r.removed.map((i) => i.product), ["Dog Treats"]);
    assert.deepEqual(r.restored, []);
  });
  test("a product the model drops without the customer withdrawing it is restored", () => {
    const r = guardRemovedItems(prior, [{ product: "Monello Chicken", quantity: "3" }], ["make the Monello 3 bags"]);
    assert.deepEqual(r.items.map((i) => i.product), ["Monello Chicken", "Dog Treats"]);
    assert.deepEqual(r.restored.map((i) => i.product), ["Dog Treats"]);
    assert.deepEqual(r.removed, []);
  });
  test("nothing missing, nothing to check", () => {
    const r = guardRemovedItems(prior, prior, ["thanks"]);
    assert.deepEqual([r.removed.length, r.restored.length], [0, 0]);
  });
});
