// The Google Docs side of the order sync — pure, no I/O. Reads a Docs API document (documents.get JSON), finds the
// AI-managed section and an order's line by its stable tag, and builds the documents.batchUpdate requests that add,
// rewrite or remove ONE line or create the section. It never builds a request that touches a paragraph outside the
// section it manages: every range comes from a paragraph this module located, and a rewrite only ever covers the text of
// one line (never its paragraph break), so the rest of the document (content, styles, lists, tables) is left alone.
//
// Indices are UTF-16 code units, exactly what String.length counts and what the Docs API uses.

import { flatten, splitTag, tagFor, tagsIn } from "./gdocFormat.ts";

// ── Documents API shapes (only what is read) ─────────────────────────────────
export interface DocTextRun {
  content?: string;
}
export interface DocElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: { startIndex?: number; endIndex?: number; textRun?: DocTextRun }[] };
  table?: unknown;
  sectionBreak?: unknown;
  tableOfContents?: unknown;
}
export interface GoogleDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocElement[] };
}

export interface DocParagraph {
  /** Index of its first character. */
  start: number;
  /** Index just after its closing line break. */
  end: number;
  /** The text without the line break. */
  text: string;
  /** Position in body.content (to tell what follows it). */
  at: number;
}

/** The top-level paragraphs, in order. Tables and their cells are not scanned: the section never lives in one. */
export function paragraphsOf(doc: GoogleDocument): DocParagraph[] {
  const out: DocParagraph[] = [];
  const content = doc.body?.content ?? [];
  content.forEach((el, at) => {
    if (!el.paragraph || typeof el.startIndex !== "number" || typeof el.endIndex !== "number") return;
    const raw = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
    out.push({ start: el.startIndex, end: el.endIndex, text: raw.replace(/\n$/, "").replace(/\u000b/g, " "), at });
  });
  return out;
}

// ── Section markers ──────────────────────────────────────────────────────────
// A business's section is bracketed by two marker paragraphs that carry the business slug, so two businesses can share a
// document and a staff member can read what the section is. Detection is by prefix, so a staff member may append words.
export const startMarker = (slug: string): string => `▼ AI ORDERS [${slug}] — managed by Devaux Inbox · newest first ▼`;
export const endMarker = (slug: string): string => `▲ END OF AI ORDERS [${slug}] ▲`;
const startPrefix = (slug: string): string => `▼ AI ORDERS [${slug}]`;
const endPrefix = (slug: string): string => `▲ END OF AI ORDERS [${slug}]`;

export type SectionState =
  | { kind: "none" }
  | { kind: "found"; start: DocParagraph; end: DocParagraph; lines: DocParagraph[] }
  /** A marker is missing, duplicated or out of order: nothing is written until a person fixes it. */
  | { kind: "broken"; reason: string };

export function findSection(doc: GoogleDocument, slug: string): SectionState {
  const ps = paragraphsOf(doc);
  const starts = ps.filter((p) => p.text.startsWith(startPrefix(slug)));
  const ends = ps.filter((p) => p.text.startsWith(endPrefix(slug)));
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  if (starts.length !== 1 || ends.length !== 1) {
    return { kind: "broken", reason: `The AI section markers are not intact (found ${starts.length} start and ${ends.length} end marker lines). Restore them or remove the section's markers, then test again.` };
  }
  const [start] = starts;
  const [end] = ends;
  if (end.start <= start.start) return { kind: "broken", reason: "The AI section's end marker is above its start marker. Restore their order, then test again." };
  return { kind: "found", start, end, lines: ps.filter((p) => p.start > start.start && p.start < end.start) };
}

/** Every top-level paragraph whose trailing tag is `refCode`, wherever it now is in the document. */
export function paragraphsWithTag(doc: GoogleDocument, refCode: string): DocParagraph[] {
  return paragraphsOf(doc).filter((p) => tagsIn(p.text).includes(refCode));
}

// ── Insertion position for a new section ─────────────────────────────────────
export type Insertion = { kind: "top" } | { kind: "end" } | { kind: "after_text"; text: string };

export function normalizeInsertion(raw: unknown): Insertion {
  const r = (raw ?? {}) as { kind?: unknown; text?: unknown };
  if (r.kind === "end") return { kind: "end" };
  if (r.kind === "after_text") {
    const text = flatten(typeof r.text === "string" ? r.text : "", 120);
    if (text) return { kind: "after_text", text };
  }
  return { kind: "top" };
}

export type Position = { ok: true; index: number; where: "top" | "end" | "after"; after?: DocParagraph } | { ok: false; reason: string };

/** Where the section would go in this document, or why that position cannot be used safely. Reads only. */
export function resolvePosition(doc: GoogleDocument, insertion: Insertion): Position {
  const content = doc.body?.content ?? [];
  const body = content.filter((el) => !el.sectionBreak);
  const last = body[body.length - 1];
  if (!last || !last.paragraph || typeof last.endIndex !== "number") return { ok: false, reason: "The document has no editable paragraph to place the section next to." };
  const endIndex = last.endIndex - 1;

  if (insertion.kind === "top") {
    const first = body[0];
    if (!first?.paragraph || typeof first.startIndex !== "number") return { ok: false, reason: "The document starts with a table, so the section cannot go at the top. Choose the end of the document or a position after a heading." };
    return { ok: true, index: first.startIndex, where: "top" };
  }
  if (insertion.kind === "end") return { ok: true, index: endIndex, where: "end" };

  const needle = insertion.text.toLowerCase();
  const matches = paragraphsOf(doc).filter((p) => flatten(p.text, 400).toLowerCase().includes(needle));
  if (matches.length === 0) return { ok: false, reason: `No paragraph contains “${insertion.text}”. Check the spelling, or choose the top or the end of the document.` };
  if (matches.length > 1) return { ok: false, reason: `“${insertion.text}” appears in ${matches.length} paragraphs. Use a more specific heading so the position is unambiguous.` };
  const [after] = matches;
  const next = content[after.at + 1];
  if (!next || next.paragraph === undefined) {
    // The matched paragraph is the last one, or a table follows it: only the very end is safe.
    if (!next) return { ok: true, index: endIndex, where: "end", after };
    return { ok: false, reason: "A table follows that paragraph, so the section cannot be placed directly after it. Choose a paragraph that is followed by text." };
  }
  return { ok: true, index: after.end, where: "after", after };
}

// ── Request builders ─────────────────────────────────────────────────────────
export type DocRequest = Record<string, unknown>;

const GREY = { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } };
const RESET_TEXT_FIELDS = "bold,italic,underline,strikethrough,smallCaps,foregroundColor,backgroundColor,fontSize,baselineOffset";
const RESET_PARAGRAPH_FIELDS = "namedStyleType,alignment,indentStart,indentFirstLine,direction";

const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex });

/** Plain body text: normal paragraph, no bullet, no character styling inherited from the paragraph we were inserted beside. */
function plainStyle(start: number, end: number): DocRequest[] {
  return [
    { updateParagraphStyle: { range: range(start, end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: RESET_PARAGRAPH_FIELDS } },
    { deleteParagraphBullets: { range: range(start, end) } },
  ];
}
const resetText = (start: number, end: number): DocRequest => ({ updateTextStyle: { range: range(start, end), textStyle: {}, fields: RESET_TEXT_FIELDS } });
const markerText = (start: number, end: number): DocRequest => ({
  updateTextStyle: { range: range(start, end), textStyle: { bold: true, foregroundColor: GREY, fontSize: { magnitude: 9, unit: "PT" } }, fields: "bold,foregroundColor,fontSize" },
});
const tagText = (start: number, end: number): DocRequest => ({
  updateTextStyle: { range: range(start, end), textStyle: { foregroundColor: GREY, fontSize: { magnitude: 8, unit: "PT" } }, fields: "foregroundColor,fontSize" },
});

export interface SectionPlan {
  requests: DocRequest[];
}

/** Creates the AI-managed section at a resolved position. Existing content is only ever pushed down, never changed. */
export function planCreateSection(slug: string, position: Extract<Position, { ok: true }>): SectionPlan {
  const s = startMarker(slug);
  const e = endMarker(slug);
  const lead = position.where === "top" ? "" : position.where === "end" ? "\n\n" : "\n";
  const text = `${lead}${s}\n${e}${position.where === "end" ? "" : "\n"}${position.where === "top" ? "\n" : ""}`;
  const sStart = position.index + lead.length;
  const eStart = sStart + s.length + 1;
  // The end marker's line break: ours, except at the very end of the document where it is the document's own final one.
  const eEnd = eStart + e.length + 1;
  const styledEnd = position.where === "top" ? eEnd + 1 : eEnd;
  // At the end the first inserted line break closes the document's existing last paragraph: that paragraph is not ours to restyle.
  const styledStart = position.where === "end" ? position.index + 1 : position.index;
  return {
    requests: [
      { insertText: { location: { index: position.index }, text } },
      ...plainStyle(styledStart, styledEnd),
      resetText(styledStart, styledEnd),
      markerText(sStart, sStart + s.length),
      markerText(eStart, eStart + e.length),
    ],
  };
}

/** Adds one order line directly under the start marker (so the newest order is first). */
export function planInsertLine(section: Extract<SectionState, { kind: "found" }>, text: string, refCode: string): DocRequest[] {
  const index = section.start.end;
  const tag = tagFor(refCode);
  const body = `${text} ${tag}`;
  const end = index + body.length + 1;
  return [
    { insertText: { location: { index }, text: `${body}\n` } },
    ...plainStyle(index, end),
    resetText(index, end - 1),
    tagText(index + text.length + 1, end - 1),
  ];
}

export interface RewriteOptions {
  /** Cross the line out and grey it: a completed or cancelled order kept in the list. */
  done?: boolean;
}

/** Replaces the text of ONE line (never its line break) and restyles it. */
export function planRewriteLine(par: DocParagraph, text: string, refCode: string, options: RewriteOptions = {}): DocRequest[] {
  const tag = tagFor(refCode);
  const body = `${text} ${tag}`;
  const textEnd = par.start + body.length;
  const requests: DocRequest[] = [];
  if (par.end - 1 > par.start) requests.push({ deleteContentRange: { range: range(par.start, par.end - 1) } });
  requests.push({ insertText: { location: { index: par.start }, text: body } });
  requests.push(resetText(par.start, textEnd));
  if (options.done) {
    requests.push({
      updateTextStyle: { range: range(par.start, par.start + text.length), textStyle: { strikethrough: true, foregroundColor: GREY }, fields: "strikethrough,foregroundColor" },
    });
  }
  requests.push(tagText(par.start + text.length + 1, textEnd));
  return requests;
}

/** Deletes one whole line, including its line break. Only ever called for a paragraph inside the managed section. */
export function planRemoveLine(par: DocParagraph): DocRequest[] {
  return [{ deleteContentRange: { range: range(par.start, par.end) } }];
}

// ── Reading a line back ──────────────────────────────────────────────────────
export type LineInspection =
  | { state: "absent" }
  | { state: "ambiguous"; count: number }
  | { state: "clean"; paragraph: DocParagraph }
  | { state: "edited"; paragraph: DocParagraph; foundText: string };

/** Is the line for this order still exactly what the app wrote? `expected` is the text last written (without its tag). */
export function inspectLine(doc: GoogleDocument, refCode: string, expected: string | null, same: (a: string, b: string) => boolean): LineInspection {
  const found = paragraphsWithTag(doc, refCode);
  if (found.length === 0) return { state: "absent" };
  if (found.length > 1) return { state: "ambiguous", count: found.length };
  const [paragraph] = found;
  const foundText = splitTag(paragraph.text).text;
  if (expected !== null && same(foundText, expected)) return { state: "clean", paragraph };
  return { state: "edited", paragraph, foundText };
}
