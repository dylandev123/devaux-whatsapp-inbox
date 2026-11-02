// Google Docs sync: what the planner decides for each order against the CURRENT document — new lines, duplicate prevention,
// manual-edit conflicts, deleted lines, completed / cancelled / corrected handling, and which orders are never listed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findSection, paragraphsOf, planInsertLine, planRewriteLine } from "../lib/aiAgent/gdocDocument.ts";
import { defaultFormat, SAMPLE_ORDER } from "../lib/aiAgent/gdocFormat.ts";
import { MAX_AUTO_ATTEMPTS, planSync, type LineRecord, type SyncOrder, type SyncPolicy } from "../lib/aiAgent/gdocPlan.ts";
import { ORDER_REVIEW_ATTENTION } from "../lib/aiAgent/orders.ts";
import { FakeGoogleDoc } from "./helpers/fakeGoogleDoc.ts";
import { planCreateSection, resolvePosition } from "../lib/aiAgent/gdocDocument.ts";

const SLUG = "dog_food";
const SINCE = "2026-11-01T00:00:00.000Z";

const policy = (over: Partial<SyncPolicy> = {}): SyncPolicy => ({
  format: defaultFormat(), onCompleted: "mark", onCancelled: "mark", onCorrected: "update", includeIncomplete: true, syncSince: SINCE, ...over,
});
let n = 0;
const order = (over: Partial<SyncOrder> = {}): SyncOrder => {
  n += 1;
  return { ...SAMPLE_ORDER, id: `o${n}`, ref_code: `E-T${String(n).padStart(4, "0")}`, version: 1, attention: null, created_at: `2026-11-02T10:${String(n % 60).padStart(2, "0")}:00.000Z`, status: "confirmed", ...over };
};
const rec = (o: SyncOrder, over: Partial<LineRecord> = {}): LineRecord => ({
  order_id: o.id, tag: o.ref_code, state: "synced", last_text: null, synced_version: o.version, synced_status: o.status, attempts: 0, ...over,
});

function freshDoc() {
  const d = new FakeGoogleDoc("Deliveries", [{ text: "Staff notes" }, { text: "Gate code 1234" }]);
  const pos = resolvePosition(d.toDocument(), { kind: "top" });
  assert.ok(pos.ok);
  if (pos.ok) d.applyBatch(planCreateSection(SLUG, pos).requests);
  return d;
}
/** Puts the order's line in the document as the sync would, and returns its record. */
function listed(d: FakeGoogleDoc, o: SyncOrder, text = "Jane — line"): LineRecord {
  const doc = d.toDocument();
  const s = findSection(doc, SLUG);
  assert.equal(s.kind, "found");
  if (s.kind === "found") d.applyBatch(planInsertLine(s, text, o.ref_code));
  return rec(o, { last_text: text });
}
const run = (d: FakeGoogleDoc, orders: SyncOrder[], records: LineRecord[], over: Partial<SyncPolicy> = {}, extra: { mode?: "auto" | "import"; force?: boolean } = {}) =>
  planSync({ orders, records: new Map(records.map((r) => [r.order_id, r])), doc: d.toDocument(), policy: policy(over), mode: extra.mode ?? "auto", force: extra.force });

describe("which orders are listed", () => {
  test("a new actionable order gets one new line; ambiguous / empty / old / closed orders are never listed", () => {
    const d = freshDoc();
    const ok = order();
    const review = order({ attention: ORDER_REVIEW_ATTENTION });
    const noItems = order({ items: [] });
    const old = order({ created_at: "2026-10-01T00:00:00.000Z" });
    const done = order({ status: "fulfilled" });
    const plan = run(d, [ok, review, noItems, old, done], []);
    assert.deepEqual(plan.actions.map((a) => [a.order.id, a.write?.type]), [[ok.id, "insert"]]);
    assert.equal(plan.skipped.length, 4);
    assert.match(plan.skipped.find((s) => s.order.id === review.id)!.reason, /might not be an order/);
    assert.match(plan.skipped.find((s) => s.order.id === old.id)!.reason, /before sync was enabled/);
  });

  test("nothing syncs automatically until sync has been enabled", () => {
    assert.equal(run(freshDoc(), [order()], [], { syncSince: null }).actions.length, 0);
  });

  test("incomplete orders are listed with their gaps visible, unless that setting is off", () => {
    const gappy = order({ status: "possible", contact_number: null, delivery_address: null, fulfilment_method: null });
    const on = run(freshDoc(), [gappy], []);
    assert.equal(on.actions.length, 1);
    assert.match((on.actions[0].write as { text: string }).text, /\(no phone\).*\(no location\)/);
    assert.equal(run(freshDoc(), [gappy], [], { includeIncomplete: false }).actions.length, 0);
  });

  test("the explicit import lists outstanding orders regardless of when they were created", () => {
    const old = order({ created_at: "2026-10-01T00:00:00.000Z" });
    assert.equal(run(freshDoc(), [old], [], {}, { mode: "import" }).actions.length, 1);
    assert.equal(run(freshDoc(), [order({ status: "cancelled" })], [], {}, { mode: "import" }).actions.length, 0);
  });

  test("oldest first, so that inserting each at the top leaves the newest order on top", () => {
    const a = order({ created_at: "2026-11-02T09:00:00.000Z" });
    const b = order({ created_at: "2026-11-02T11:00:00.000Z" });
    const c = order({ created_at: "2026-11-02T10:00:00.000Z" });
    assert.deepEqual(run(freshDoc(), [b, c, a], []).actions.map((x) => x.order.id), [a.id, c.id, b.id]);
  });
});

describe("duplicate prevention", () => {
  test("an order already synced and unchanged is left alone", () => {
    const d = freshDoc();
    const o = order();
    assert.equal(run(d, [o], [listed(d, o)]).actions.length, 0);
  });

  test("a line already in the document but missing from our records (crash after the write, reconnect) is adopted, never added twice", () => {
    const d = freshDoc();
    const o = order();
    const doc = d.toDocument();
    const s = findSection(doc, SLUG);
    if (s.kind !== "found") throw new Error("section");
    const text = run(freshDoc(), [o], []).actions[0].write as { text: string };
    d.applyBatch(planInsertLine(s, text.text, o.ref_code));
    const plan = run(d, [o], []);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "synced");
    assert.equal(plan.actions[0].patch.last_text, text.text);
  });

  test("a document line for the order that reads differently is held as a conflict, not duplicated or overwritten", () => {
    const d = freshDoc();
    const o = order();
    listed(d, o, "Something else entirely");
    const plan = run(d, [o], []);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "conflict");
    assert.equal(plan.actions[0].patch.found_text, "Something else entirely");
  });

  test("the same tag twice in the document is a conflict (never guess which copy is real)", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o);
    d.insertParagraph(`copy ⟨${o.ref_code}⟩`, "Gate code");
    const plan = run(d, [{ ...o, version: 2 }], [r]);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "conflict");
    assert.match(plan.actions[0].patch.pending_reason!, /2 times/);
  });

  test("a failed insert that never reached the document is retried; after too many attempts it waits for a person", () => {
    const d = freshDoc();
    const o = order();
    const failed = rec(o, { state: "failed", last_text: null, synced_version: null, synced_status: null, attempts: 2 });
    assert.equal(run(d, [o], [failed]).actions[0].write?.type, "insert");
    const tired = { ...failed, attempts: MAX_AUTO_ATTEMPTS };
    assert.equal(run(d, [o], [tired]).actions.length, 0);
    assert.equal(run(d, [o], [tired], {}, { force: true }).actions[0].write?.type, "insert");
  });
});

describe("corrections and manual edits", () => {
  test("a corrected order rewrites its own unedited line in place", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — old address");
    const plan = run(d, [{ ...o, version: 2, delivery_address: "Gros Islet" }], [r]);
    assert.equal(plan.actions[0].write?.type, "rewrite");
    assert.match((plan.actions[0].write as { text: string }).text, /Gros Islet/);
  });

  test("corrections can be held for approval instead", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — old address");
    const plan = run(d, [{ ...o, version: 2, delivery_address: "Gros Islet" }], [r], { onCorrected: "review" });
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "pending_review");
    assert.match(plan.actions[0].patch.pending_text!, /Gros Islet/);
  });

  test("a line a person edited is NOT overwritten: the change is held with both versions", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — old address");
    d.appendToParagraph("Jane — old address", " ** gate is blue **");
    const plan = run(d, [{ ...o, version: 2, delivery_address: "Gros Islet" }], [r]);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "conflict");
    assert.match(plan.actions[0].patch.found_text!, /gate is blue/);
    assert.match(plan.actions[0].patch.pending_text!, /Gros Islet/);
  });

  test("a held conflict stays held (and keeps the latest wanted text) until a person resolves it", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — old");
    d.appendToParagraph("Jane — old", " edited");
    const first = run(d, [{ ...o, version: 2, notes: "v2" }], [r]);
    const held = rec(o, { state: "conflict", last_text: r.last_text, synced_version: 2, synced_status: o.status });
    assert.equal(first.actions[0].patch.state, "conflict");
    assert.equal(run(d, [{ ...o, version: 2, notes: "v2" }], [held]).actions.length, 0);
    const again = run(d, [{ ...o, version: 3, notes: "v3" }], [held]);
    assert.equal(again.actions[0].write, null);
    assert.match(again.actions[0].patch.pending_text!, /v3/);
  });

  test("a line a person deleted is not put back; the order is flagged as missing", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o);
    d.deleteParagraph(o.ref_code);
    const plan = run(d, [{ ...o, version: 2, notes: "changed" }], [r]);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "missing");
    const later = run(d, [{ ...o, version: 3 }], [{ ...r, state: "missing" }]);
    assert.equal(later.actions.length, 0);
    assert.match(later.skipped[0].reason, /removed/);
  });

  test("a person moving a line elsewhere in the document does not matter: it is found by its tag", () => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — old");
    const text = d.lines().find((l) => l.includes(o.ref_code))!;
    d.deleteParagraph(o.ref_code);
    d.insertParagraph(text, null);
    const plan = run(d, [{ ...o, version: 2, notes: "n2" }], [r]);
    assert.equal(plan.actions[0].write?.type, "rewrite");
  });

  test("an order change that does not change the line text writes nothing", () => {
    const d = freshDoc();
    const o = order();
    const text = (run(freshDoc(), [o], []).actions[0].write as { text: string }).text;
    const r = listed(d, o, text);
    const plan = run(d, [{ ...o, version: 2, attention: "check_if_duplicate" }], [r]);
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "synced");
    assert.equal(plan.actions[0].patch.synced_version, 2);
  });
});

describe("completed and cancelled orders", () => {
  const closed = (status: "fulfilled" | "cancelled") => {
    const d = freshDoc();
    const o = order();
    const r = listed(d, o, "Jane — line");
    return { d, o, r, closed: { ...o, version: 2, status } as SyncOrder };
  };

  test("mark: the line is kept, labelled and crossed out", () => {
    const x = closed("fulfilled");
    const w = run(x.d, [x.closed], [x.r]).actions[0].write as { type: string; text: string; done: boolean };
    assert.equal(w.type, "rewrite");
    assert.match(w.text, /^\[COMPLETED\] /);
    assert.equal(w.done, true);
    const c = closed("cancelled");
    assert.match((run(c.d, [c.closed], [c.r]).actions[0].write as { text: string }).text, /^\[CANCELLED\] /);
  });

  test("leave: the line is left exactly as it is", () => {
    const x = closed("fulfilled");
    const plan = run(x.d, [x.closed], [x.r], { onCompleted: "leave" });
    assert.equal(plan.actions[0].write, null);
    assert.equal(plan.actions[0].patch.state, "synced");
    assert.equal(plan.actions[0].patch.last_text, "Jane — line");
  });

  test("remove: the line is deleted — but only when nobody edited it", () => {
    const x = closed("cancelled");
    assert.equal(run(x.d, [x.closed], [x.r], { onCancelled: "remove" }).actions[0].write?.type, "remove");
    x.d.appendToParagraph("Jane — line", " (edited)");
    const held = run(x.d, [x.closed], [x.r], { onCancelled: "remove" }).actions[0];
    assert.equal(held.write, null);
    assert.equal(held.patch.state, "conflict");
    assert.equal(held.patch.pending_action, "remove");
  });

  test("a closed order that was never listed is not added", () => {
    const o = order({ status: "fulfilled" });
    assert.equal(run(freshDoc(), [o], []).actions.length, 0);
  });

  test("corrections held for review do not hold back closing an order", () => {
    const x = closed("fulfilled");
    assert.equal(run(x.d, [x.closed], [x.r], { onCorrected: "review" }).actions[0].write?.type, "rewrite");
  });
});

describe("the planner never builds a write outside the one line it owns", () => {
  test("a rewrite covers only that paragraph's text, not its line break", () => {
    const d = freshDoc();
    const o = order();
    listed(d, o, "Jane — line");
    const par = paragraphsOf(d.toDocument()).find((p) => p.text.includes(o.ref_code))!;
    const reqs = planRewriteLine(par, "new", o.ref_code) as any[];
    const del = reqs.find((r) => r.deleteContentRange)?.deleteContentRange.range;
    assert.deepEqual(del, { startIndex: par.start, endIndex: par.end - 1 });
  });
});
