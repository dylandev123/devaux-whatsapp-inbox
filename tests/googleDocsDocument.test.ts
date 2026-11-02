// Google Docs sync: section creation, line insertion, ordering, rewrite/remove, and — above all — that everything already
// in a staff member's document survives byte-for-byte (text AND formatting). The requests the app builds are applied to an
// in-memory document that behaves like the real one (1-based UTF-16 indices, inherited styles, revision guard).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  endMarker,
  findSection,
  inspectLine,
  normalizeInsertion,
  paragraphsOf,
  planCreateSection,
  planInsertLine,
  planRemoveLine,
  planRewriteLine,
  resolvePosition,
  startMarker,
  type GoogleDocument,
  type Insertion,
} from "../lib/aiAgent/gdocDocument.ts";
import { sameText, splitTag } from "../lib/aiAgent/gdocFormat.ts";
import { FakeGoogleDoc } from "./helpers/fakeGoogleDoc.ts";

const SLUG = "dog_food";

function staffDoc() {
  return new FakeGoogleDoc("Orders & deliveries", [
    { text: "DAILY DELIVERIES", para: { namedStyleType: "HEADING_1" }, text_style: { bold: true, fontSize: { magnitude: 20, unit: "PT" } } },
    { text: "Call supplier on Monday — ask about 🐕 kibble", text_style: {} },
    { text: "Pool chemicals list", para: { namedStyleType: "HEADING_2" }, text_style: { italic: true } },
    { text: "Chlorine 25kg", para: { namedStyleType: "NORMAL_TEXT", bullet: { listId: "kix.1" } } },
    { text: "Ends here", text_style: { foregroundColor: { color: { rgbColor: { red: 1 } } } } },
  ]);
}

const snapshot = (d: FakeGoogleDoc) => JSON.parse(JSON.stringify(d.paragraphs()));

function createSection(d: FakeGoogleDoc, insertion: Insertion) {
  const pos = resolvePosition(d.toDocument(), insertion);
  assert.ok(pos.ok, pos.ok ? "" : pos.reason);
  d.applyBatch(planCreateSection(SLUG, pos).requests, d.toDocument().revisionId);
}

function insert(d: FakeGoogleDoc, text: string, ref: string) {
  const doc = d.toDocument();
  const section = findSection(doc, SLUG);
  assert.equal(section.kind, "found");
  if (section.kind !== "found") return;
  d.applyBatch(planInsertLine(section, text, ref), doc.revisionId);
}

/** The original paragraphs, in order, with text and formatting unchanged — whatever was added around them. */
function assertPreserved(before: ReturnType<typeof snapshot>, d: FakeGoogleDoc) {
  const after = snapshot(d) as typeof before;
  const kept = after.filter((p: any) => before.some((b: any) => b.text === p.text));
  const originals = before.map((b: any) => after.find((a: any) => a.text === b.text));
  originals.forEach((o: any, i: number) => {
    assert.ok(o, `paragraph ${JSON.stringify(before[i].text)} still present`);
    assert.deepEqual(o.para, before[i].para, `paragraph style of ${JSON.stringify(before[i].text)}`);
    assert.deepEqual(o.styles, before[i].styles, `character styles of ${JSON.stringify(before[i].text)}`);
  });
  // and in the same relative order
  const idx = before.map((b: any) => after.findIndex((a: any) => a.text === b.text));
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
  assert.ok(kept.length >= before.length);
}

describe("creating the AI-managed section in an existing document", () => {
  for (const [name, insertion] of [
    ["top", { kind: "top" }],
    ["end", { kind: "end" }],
    ["after a heading", { kind: "after_text", text: "pool chemicals" }],
  ] as [string, Insertion][]) {
    test(`${name}: markers added, every existing paragraph keeps its text and formatting`, () => {
      const d = staffDoc();
      const before = snapshot(d);
      createSection(d, insertion);
      const section = findSection(d.toDocument(), SLUG);
      assert.equal(section.kind, "found");
      assertPreserved(before, d);
      const lines = d.lines();
      assert.ok(lines.includes(startMarker(SLUG)) && lines.includes(endMarker(SLUG)));
      assert.ok(lines.indexOf(startMarker(SLUG)) < lines.indexOf(endMarker(SLUG)));
      // The markers are normal text (not the heading / list item they were inserted beside).
      for (const marker of [startMarker(SLUG), endMarker(SLUG)]) {
        const p = d.paragraphs().find((x) => x.text === marker)!;
        assert.equal(p.para.namedStyleType, "NORMAL_TEXT");
        assert.equal(p.para.bullet, undefined);
      }
      assert.equal(d.text().endsWith("\n"), true);
    });
  }

  test("position: top is above the first paragraph, end below the last, after-heading directly under that heading", () => {
    const top = staffDoc();
    createSection(top, { kind: "top" });
    assert.equal(top.lines()[0], startMarker(SLUG));
    assert.equal(top.lines().at(-1), "Ends here");

    const end = staffDoc();
    createSection(end, { kind: "end" });
    assert.equal(end.lines()[0], "DAILY DELIVERIES");
    assert.equal(end.lines().at(-1), endMarker(SLUG));

    const mid = staffDoc();
    createSection(mid, { kind: "after_text", text: "Pool chemicals" });
    const l = mid.lines();
    assert.equal(l[l.indexOf("Pool chemicals list") + 2], startMarker(SLUG));
    assert.equal(l[l.indexOf(endMarker(SLUG)) + 1], "Chlorine 25kg");
  });

  test("a position that cannot be resolved safely is refused with a reason", () => {
    const d = staffDoc();
    const missing = resolvePosition(d.toDocument(), { kind: "after_text", text: "no such heading" });
    assert.equal(missing.ok, false);
    const twice = new FakeGoogleDoc("x", [{ text: "Orders" }, { text: "More orders" }]);
    const amb = resolvePosition(twice.toDocument(), { kind: "after_text", text: "orders" });
    assert.equal(amb.ok, false);
    if (!amb.ok) assert.match(amb.reason, /2 paragraphs/);
    // A document that opens with a table cannot take text at the top.
    const withTable: GoogleDocument = {
      body: { content: [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 20, table: {} }, { startIndex: 20, endIndex: 22, paragraph: { elements: [{ textRun: { content: "x\n" } }] } }] },
    };
    assert.equal(resolvePosition(withTable, { kind: "top" }).ok, false);
    assert.equal(resolvePosition(withTable, { kind: "end" }).ok, true);
    // "after text" when the matched paragraph is the last one falls back to the end.
    const last = resolvePosition(d.toDocument(), { kind: "after_text", text: "Ends here" });
    assert.ok(last.ok && last.where === "end");
  });

  test("insertion settings from a browser are normalised", () => {
    assert.deepEqual(normalizeInsertion({ kind: "end" }), { kind: "end" });
    assert.deepEqual(normalizeInsertion({ kind: "after_text", text: "  Orders\n " }), { kind: "after_text", text: "Orders" });
    assert.deepEqual(normalizeInsertion({ kind: "after_text", text: "" }), { kind: "top" });
    assert.deepEqual(normalizeInsertion({ kind: "bogus" }), { kind: "top" });
    assert.deepEqual(normalizeInsertion(null), { kind: "top" });
  });

  test("damaged markers are detected and reported instead of guessed at", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    assert.equal(findSection(d.toDocument(), SLUG).kind, "found");
    d.deleteParagraph("END OF AI ORDERS");
    const broken = findSection(d.toDocument(), SLUG);
    assert.equal(broken.kind, "broken");
    // Another business's section in the same document is independent.
    assert.equal(findSection(d.toDocument(), "pool_shop").kind, "none");
  });
});

describe("order lines in the section", () => {
  test("newest order is first, every order is its own paragraph, and the rest of the document is untouched", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    const before = snapshot(d);
    insert(d, "Alice — first", "E-AAAAA");
    insert(d, "Bob — second", "E-BBBBB");
    insert(d, "Cara — third", "E-CCCCC");
    const l = d.lines();
    const s = l.indexOf(startMarker(SLUG));
    assert.deepEqual(l.slice(s + 1, s + 4), ["Cara — third ⟨E-CCCCC⟩", "Bob — second ⟨E-BBBBB⟩", "Alice — first ⟨E-AAAAA⟩"]);
    assert.equal(l[s + 4], endMarker(SLUG));
    assertPreserved(before, d);
  });

  test("a new line is plain body text even when inserted beside a heading, a list item or bold marker text", () => {
    const d = staffDoc();
    createSection(d, { kind: "after_text", text: "Pool chemicals" });
    insert(d, "Alice — Rodney Bay", "E-AAAAA");
    const p = d.paragraphs().find((x) => x.text.startsWith("Alice"))!;
    assert.equal(p.para.namedStyleType, "NORMAL_TEXT");
    assert.equal(p.para.bullet, undefined);
    // Character styles: nothing bold/italic/coloured/sized except the grey tag.
    const textLen = "Alice — Rodney Bay ".length;
    for (const style of p.styles.slice(0, textLen)) {
      assert.equal(style.bold, undefined);
      assert.equal(style.italic, undefined);
      assert.equal(style.foregroundColor, undefined);
      assert.equal(style.fontSize, undefined);
    }
    for (const style of p.styles.slice(textLen)) assert.ok(style.foregroundColor && style.fontSize);
  });

  test("indices stay right with emoji and other non-BMP characters (UTF-16 units)", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    insert(d, "Fido 🐕 — 2 × Kibble 🍗", "E-AAAAA");
    insert(d, "Léa — crème", "E-BBBBB");
    const doc = d.toDocument();
    const par = paragraphsOf(doc).find((p) => p.text.startsWith("Fido"))!;
    d.applyBatch(planRewriteLine(par, "Fido 🐕🐕 — 3 × Kibble 🍗", "E-AAAAA"), doc.revisionId);
    const l = d.lines();
    assert.ok(l.includes("Fido 🐕🐕 — 3 × Kibble 🍗 ⟨E-AAAAA⟩"));
    assert.ok(l.includes("Léa — crème ⟨E-BBBBB⟩"));
    assert.equal(l.at(-1), "Ends here");
  });

  test("rewriting one line changes only that line; marking crosses it out; the tag survives", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    insert(d, "Alice — old", "E-AAAAA");
    insert(d, "Bob — keep me", "E-BBBBB");
    const before = snapshot(d);
    const doc = d.toDocument();
    const par = paragraphsOf(doc).find((p) => p.text.startsWith("Alice"))!;
    d.applyBatch(planRewriteLine(par, "[COMPLETED] Alice — new", "E-AAAAA", { done: true }), doc.revisionId);
    const after = d.paragraphs();
    const alice = after.find((p) => p.text.startsWith("[COMPLETED] Alice"))!;
    assert.equal(alice.text, "[COMPLETED] Alice — new ⟨E-AAAAA⟩");
    assert.equal(alice.styles[0].strikethrough, true);
    assert.equal(alice.para.namedStyleType, "NORMAL_TEXT");
    assert.deepEqual(after.find((p) => p.text.startsWith("Bob")), before.find((p: any) => p.text.startsWith("Bob")));
    assertPreserved(before.filter((p: any) => !p.text.startsWith("Alice")), d);
    assert.equal(splitTag(alice.text).tag, "E-AAAAA");
  });

  test("removing a line deletes exactly that paragraph", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    insert(d, "Alice", "E-AAAAA");
    insert(d, "Bob", "E-BBBBB");
    const doc = d.toDocument();
    d.applyBatch(planRemoveLine(paragraphsOf(doc).find((p) => p.text.startsWith("Alice"))!), doc.revisionId);
    assert.ok(!d.lines().some((x) => x.includes("Alice")));
    assert.ok(d.lines().includes("Bob ⟨E-BBBBB⟩"));
    assert.equal(findSection(d.toDocument(), SLUG).kind, "found");
  });

  test("a write built from a stale read is rejected whole by Google's revision guard", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    const stale = d.toDocument();
    d.appendToParagraph("Chlorine", " (and 10kg)"); // a person types while we were planning
    const section = findSection(stale, SLUG);
    assert.equal(section.kind, "found");
    if (section.kind !== "found") return;
    const before = d.lines();
    assert.throws(() => d.applyBatch(planInsertLine(section, "Alice", "E-AAAAA"), stale.revisionId), /revision/);
    assert.deepEqual(d.lines(), before);
  });

  test("inspecting a line: clean, edited by a person, removed, or duplicated", () => {
    const d = staffDoc();
    createSection(d, { kind: "top" });
    insert(d, "Alice — Rodney Bay", "E-AAAAA");
    const expect = "Alice — Rodney Bay";
    assert.equal(inspectLine(d.toDocument(), "E-AAAAA", expect, sameText).state, "clean");
    d.appendToParagraph("Alice", " (she moved to Gros Islet)");
    const edited = inspectLine(d.toDocument(), "E-AAAAA", expect, sameText);
    assert.equal(edited.state, "edited");
    if (edited.state === "edited") assert.equal(edited.foundText, "Alice — Rodney Bay (she moved to Gros Islet)");
    d.insertParagraph("Alice copy ⟨E-AAAAA⟩", "Ends here");
    assert.equal(inspectLine(d.toDocument(), "E-AAAAA", expect, sameText).state, "ambiguous");
    d.deleteParagraph("Alice copy");
    d.deleteParagraph("Alice — Rodney");
    assert.equal(inspectLine(d.toDocument(), "E-AAAAA", expect, sameText).state, "absent");
  });
});
