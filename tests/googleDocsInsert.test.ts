// Append-only insertion at the top of an existing Google Doc: the exact requests built, how they behave against a document
// that opens with a heading / list / bold text / emoji / a table, document tabs, very large documents, and which orders
// are eligible. The document is an in-memory stand-in; the real Google is never contacted.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, formatOrderLine, tagFor } from "../lib/aiAgent/gdocFormat.ts";
import { eligibleForNewLine, INSERT_INDEX, insertLineRequests, lineParagraph, planInsertions, tagsPresent, type SyncOrder } from "../lib/aiAgent/gdocInsert.ts";
import { FakeApiError, FakeGoogleDoc } from "./helpers/fakeGoogleDoc.ts";

const format = defaultFormat();
const order = (over: Partial<SyncOrder> = {}): SyncOrder => ({
  id: over.id ?? "o1",
  ref_code: over.ref_code ?? "E-AAAAA",
  customer_name: "Jane Joseph",
  contact_number: "17585550142",
  items: [{ product: "Chicken", quantity: "3", variant: null, size: null }],
  fulfilment_method: "delivery",
  delivery_address: "Rodney Bay",
  requested_for: null,
  notes: null,
  status: "confirmed",
  attention: null,
  created_at: over.created_at ?? "2026-11-02T10:00:00.000Z",
  ...over,
});

const insertOne = (doc: FakeGoogleDoc, text: string, ref: string, styled = true) => doc.applyBatch(insertLineRequests(text, ref, { styled }));
const snapshot = (doc: FakeGoogleDoc) => JSON.parse(JSON.stringify(doc.paragraphs())) as ReturnType<FakeGoogleDoc["paragraphs"]>;

describe("the insert request", () => {
  test("is one insertText at index 1 of the first tab: no tabId, no revision guard, no read", () => {
    const requests = insertLineRequests("Jane — +1758 — Rodney Bay — Chicken x3", "E-7K2QX");
    const insert = (requests[0] as { insertText: { location: Record<string, unknown>; text: string } }).insertText;
    assert.equal(INSERT_INDEX, 1, "index 0 is the document's section break and can never take text");
    assert.deepEqual(insert.location, { index: 1 });
    assert.ok(!("tabId" in insert.location), "omitting tabId targets the first tab without looking it up");
    assert.equal(insert.text, "Jane — +1758 — Rodney Bay — Chicken x3 ⟨E-7K2QX⟩\n");
    assert.equal(insert.text, lineParagraph("Jane — +1758 — Rodney Bay — Chicken x3", "E-7K2QX"));
    // Only the NEW paragraph is ever styled; no request deletes, replaces or touches anything else.
    const names = requests.map((r) => Object.keys(r)[0]);
    assert.deepEqual(names, ["insertText", "updateParagraphStyle", "deleteParagraphBullets", "updateTextStyle", "updateTextStyle"]);
    assert.ok(!names.some((n) => n.startsWith("delete") && n !== "deleteParagraphBullets"), "no deleteContentRange / replace");
    for (const r of requests.slice(1)) {
      const range = (Object.values(r)[0] as { range: { startIndex: number; endIndex: number } }).range;
      assert.ok(range.startIndex >= 1 && range.endIndex <= 1 + insert.text.length, "styling stays inside the inserted paragraph");
    }
  });

  test("the unstyled form is the bare insert (the fallback when Google refuses styling)", () => {
    assert.equal(insertLineRequests("x", "E-1AAAA", { styled: false }).length, 1);
  });

  test("the line is the configured format with the small tag, and indices count UTF-16 units (emoji)", () => {
    const o = order({ customer_name: "Zoë 🐶 Smith", notes: "gate 🔒" });
    const text = formatOrderLine(o, format).text;
    assert.equal(text, "Rodney Bay — Zoë 🐶 Smith — +1 (758) 555-0142 — 3 × Chicken — gate 🔒 — #E-AAAAA");
    const doc = new FakeGoogleDoc("d", [{ text: "Existing 🎉 notes" }]);
    insertOne(doc, text, o.ref_code);
    const [first, second] = doc.paragraphs();
    assert.equal(first.text, `${text} ${tagFor(o.ref_code)}`);
    assert.equal(second.text, "Existing 🎉 notes");
    // The grey tag styling lands exactly on the tag even though the text holds astral characters.
    const tagStart = [...first.text].findIndex((ch) => ch === "⟨");
    assert.equal(first.styles[tagStart]?.fontSize !== undefined, true);
    assert.equal(first.styles[0]?.fontSize, undefined);
  });
});

describe("inserting into documents that start in different ways", () => {
  const seeds: [string, ConstructorParameters<typeof FakeGoogleDoc>[1]][] = [
    ["a Title", [{ text: "Orders book", para: { namedStyleType: "TITLE" }, text_style: { bold: true, fontSize: { magnitude: 26, unit: "PT" } } }, { text: "Monday" }]],
    ["a heading", [{ text: "DELIVERIES", para: { namedStyleType: "HEADING_1" }, text_style: { bold: true } }, { text: "Gate code 1234" }]],
    ["a bulleted item", [{ text: "Call suppliers", para: { namedStyleType: "NORMAL_TEXT", bullet: { listId: "L1" }, indentStart: { magnitude: 36, unit: "PT" } } }, { text: "Done" }]],
    ["bold red text", [{ text: "URGENT", text_style: { bold: true, foregroundColor: { color: { rgbColor: { red: 1 } } } } }]],
    ["an empty document", []],
  ];

  for (const [name, paragraphs] of seeds) {
    test(`a document starting with ${name}: the new line is plain body text above it and everything else is untouched`, () => {
      const doc = new FakeGoogleDoc("d", paragraphs);
      const before = snapshot(doc);
      insertOne(doc, "Jane — +1758 — Bay — Chicken x3", "E-AAAAA");
      const after = doc.paragraphs();
      assert.equal(after.length, before.length + 1);
      assert.equal(after[0].text, "Jane — +1758 — Bay — Chicken x3 ⟨E-AAAAA⟩");
      assert.equal(after[0].para.namedStyleType, "NORMAL_TEXT");
      assert.equal(after[0].para.bullet, undefined, "not a list item");
      assert.equal(after[0].styles[0]?.bold, undefined, "no bold / colour inherited");
      assert.equal(after[0].styles[0]?.foregroundColor, undefined);
      // Every pre-existing paragraph is still there, in order, with its own paragraph style and character styles.
      assert.deepEqual(after.slice(1), before);
    });
  }

  test("an unstyled insert still puts the line first and keeps the document", () => {
    const doc = new FakeGoogleDoc("d", [{ text: "Existing", para: { namedStyleType: "HEADING_2" } }]);
    insertOne(doc, "Line", "E-AAAAA", false);
    assert.deepEqual(doc.lines(), ["Line ⟨E-AAAAA⟩", "Existing"]);
  });

  test("a document that opens with a table is refused by Google (400), is left unchanged, and the error is a plain bad_request", () => {
    const doc = new FakeGoogleDoc("d", [{ text: "cell" }]);
    doc.startsWithTable = true;
    const before = doc.text();
    assert.throws(() => insertOne(doc, "Line", "E-AAAAA"), (e: unknown) => e instanceof FakeApiError && e.status === 400);
    assert.equal(doc.text(), before);
    assert.equal(doc.batches.length, 0);
  });
});

describe("document tabs", () => {
  test("the line goes into the FIRST tab; other tabs are never touched", () => {
    const doc = new FakeGoogleDoc("d", [{ text: "Tab one" }]);
    doc.otherTabs = [{ id: "t.1", paragraphs: ["Tab two"] }, { id: "t.2", paragraphs: ["Tab three"] }];
    insertOne(doc, "Line", "E-AAAAA");
    assert.deepEqual(doc.lines(), ["Line ⟨E-AAAAA⟩", "Tab one"]);
    assert.deepEqual(doc.otherTabs, [{ id: "t.1", paragraphs: ["Tab two"] }, { id: "t.2", paragraphs: ["Tab three"] }]);
  });

  test("a request aimed at a different tab is rejected, so a wrong tab id could never silently write elsewhere", () => {
    const doc = new FakeGoogleDoc("d", [{ text: "Tab one" }]);
    assert.throws(() => doc.applyBatch([{ insertText: { location: { index: 1, tabId: "t.9" }, text: "x\n" } }]), /not the first tab/);
  });
});

describe("a very large document", () => {
  function bigDoc(paragraphs = 6000) {
    return new FakeGoogleDoc("Orders book", Array.from({ length: paragraphs }, (_, i) => ({ text: `Order ${i} — Customer ${i} — +1758555${String(i).padStart(4, "0")} — Gros Islet — Dog food ×${(i % 5) + 1}`, para: i % 400 === 0 ? { namedStyleType: "HEADING_1" } : {} })));
  }

  test("an insert sends a small constant request, needs no read, and shifts all existing content down intact", () => {
    const doc = bigDoc();
    const before = doc.paragraphs();
    insertOne(doc, "Jane — +17585550142 — Bay — Chicken x3", "E-AAAAA");
    const bytes = JSON.stringify(doc.batches[0]).length;
    assert.ok(bytes < 1500, `request body stays small whatever the document size (${bytes} bytes)`);
    assert.equal(doc.textReads, 0, "no body download");
    const after = doc.paragraphs();
    assert.equal(after.length, before.length + 1);
    assert.equal(after[0].text, "Jane — +17585550142 — Bay — Chicken x3 ⟨E-AAAAA⟩");
    assert.deepEqual(after.slice(1), before, "all 6,000 existing paragraphs preserved, in order, with their styles");
  });

  test("a full download would time out, yet inserting still works (it never needs one)", () => {
    const doc = bigDoc(3000);
    doc.maxReadableChars = 10_000;
    assert.throws(() => doc.readText(), (e: unknown) => e instanceof FakeApiError && e.kind === "timeout");
    insertOne(doc, "Line", "E-AAAAA");
    assert.equal(doc.lines()[0], "Line ⟨E-AAAAA⟩");
  });

  test("successive inserts stack newest on top", () => {
    const doc = bigDoc(50);
    for (const [ref, name] of [["E-AAAA1", "first"], ["E-AAAA2", "second"], ["E-AAAA3", "third"]]) insertOne(doc, name, ref);
    assert.deepEqual(doc.lines().slice(0, 4), ["third ⟨E-AAAA3⟩", "second ⟨E-AAAA2⟩", "first ⟨E-AAAA1⟩", doc.lines()[3]]);
    assert.ok(doc.lines()[3].startsWith("Order 0"));
  });
});

describe("recognising our own line", () => {
  test("tagsPresent finds only the asked tags, in any paragraph, and ignores look-alikes", () => {
    const doc = new FakeGoogleDoc("d", [{ text: "x" }]);
    insertOne(doc, "A", "E-AAAAA");
    insertOne(doc, "B", "E-BBBBB");
    doc.insertParagraph("typed by hand E-CCCCC without brackets", null);
    const found = tagsPresent(doc.readText(), ["E-AAAAA", "E-CCCCC", "E-ZZZZZ"]);
    assert.deepEqual([...found], ["E-AAAAA"]);
  });
});

describe("which orders get a line", () => {
  const policy = { format, includeIncomplete: true, syncSince: "2026-11-02T09:00:00.000Z" };

  test("a new actionable order is listed; closed, under-review, product-less and pre-activation orders are not", () => {
    assert.equal(eligibleForNewLine(order(), policy, "auto").ok, true);
    assert.equal(eligibleForNewLine(order({ status: "fulfilled" }), policy, "auto").ok, false);
    assert.equal(eligibleForNewLine(order({ status: "cancelled" }), policy, "auto").ok, false);
    assert.equal(eligibleForNewLine(order({ items: [] }), policy, "auto").ok, false);
    assert.equal(eligibleForNewLine(order({ attention: "review_order_intent" }), policy, "auto").ok, false);
    const old = order({ created_at: "2026-11-01T10:00:00.000Z" });
    assert.deepEqual(eligibleForNewLine(old, policy, "auto"), { ok: false, reason: "created before sync was enabled" });
    assert.equal(eligibleForNewLine(old, policy, "import").ok, true, "only the explicit import may list history");
  });

  test("nothing syncs automatically until sync has been enabled", () => {
    assert.equal(eligibleForNewLine(order(), { ...policy, syncSince: null }, "auto").ok, false);
  });

  test("incomplete orders are listed with their gaps visible unless that setting is off", () => {
    const gap = order({ contact_number: null });
    assert.equal(eligibleForNewLine(gap, policy, "auto").ok, true);
    assert.equal(eligibleForNewLine(gap, { ...policy, includeIncomplete: false }, "auto").ok, false);
    assert.equal(eligibleForNewLine(order({ status: "possible" }), { ...policy, includeIncomplete: false }, "auto").ok, false);
    assert.equal(eligibleForNewLine(order(), { ...policy, includeIncomplete: false }, "auto").ok, true);
  });

  test("oldest first, so inserting each at the top leaves the newest on top", () => {
    const a = order({ id: "a", ref_code: "E-AAAAA", created_at: "2026-11-02T10:00:00.000Z" });
    const b = order({ id: "b", ref_code: "E-BBBBB", created_at: "2026-11-02T11:00:00.000Z" });
    const c = order({ id: "c", ref_code: "E-CCCCC", created_at: "2026-11-02T10:30:00.000Z" });
    assert.deepEqual(planInsertions([b, c, a], new Map(), policy, "auto").insert.map((o) => o.id), ["a", "c", "b"]);
  });

  test("an order with ANY existing line state except 'failed' is never inserted again", () => {
    const o = order();
    for (const state of ["synced", "inserting", "unconfirmed", "skipped", "conflict", "missing", "pending_review"]) {
      assert.deepEqual(planInsertions([o], new Map([[o.id, state]]), policy, "auto").insert, [], state);
    }
    assert.equal(planInsertions([o], new Map([[o.id, "failed"]]), policy, "auto").insert.length, 1, "a definite failure is retried");
  });
});
