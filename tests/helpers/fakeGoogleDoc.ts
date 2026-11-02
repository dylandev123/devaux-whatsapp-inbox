// An in-memory Google Doc that applies documents.batchUpdate requests the way the real API does for the request types the
// sync uses (insertText, deleteContentRange, updateTextStyle, updateParagraphStyle, deleteParagraphBullets), including the
// parts that make index arithmetic matter: UTF-16 indices that start at 1, text styles inherited from the preceding
// character, a paragraph's style living on its closing line break, the undeletable final line break, and document tabs
// (an insert without a tabId lands in the FIRST tab; a document that starts with a table refuses text at index 1).
// Tests drive the app's real sync code against it; the real Google is never touched.

import type { DocRequest, TextRunDocument } from "../../lib/aiAgent/gdocInsert.ts";

type Style = Record<string, unknown>;
interface Ch {
  ch: string;
  text: Style;
  /** Only on "\n": the style of the paragraph it closes. */
  para?: Style;
}

export class FakeApiError extends Error {
  kind: string;
  status: number;
  constructor(kind: string, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface SeedParagraph {
  text: string;
  /** e.g. { namedStyleType: "HEADING_1" } */
  para?: Style;
  /** e.g. { bold: true } for every character */
  text_style?: Style;
}

export class FakeGoogleDoc {
  chars: Ch[] = [];
  revision = 1;
  title: string;
  canEdit = true;
  mimeType = "application/vnd.google-apps.document";
  trashed = false;
  /** Every batchUpdate that reached "Google", for assertions. */
  batches: DocRequest[][] = [];
  /** The next batch is refused before anything is applied (an explicit Google error). */
  failNextBatch: FakeApiError | null = null;
  /** The next batch IS applied, then the answer is lost / errors (timeout, 5xx): the outcome is unknown to the caller. */
  applyThenFail: FakeApiError | null = null;
  /** Body downloads (text reads of the first tab). The normal sync path must keep this at 0. */
  textReads = 0;
  /** Reads of more than this many characters time out, like a document too large to download in time. null = no limit. */
  maxReadableChars: number | null = null;
  /** The first tab's id; other tabs are never touched by an insert that carries no tabId. */
  firstTabId = "t.0";
  otherTabs: { id: string; paragraphs: string[] }[] = [];
  /** The first body element is a table: Google refuses text at index 1. */
  startsWithTable = false;

  constructor(title: string, paragraphs: SeedParagraph[]) {
    this.title = title;
    for (const p of paragraphs) this.pushParagraph(p);
    if (this.chars.length === 0) this.pushParagraph({ text: "" });
  }

  private pushParagraph(p: SeedParagraph) {
    for (const ch of p.text) this.chars.push({ ch, text: { ...(p.text_style ?? {}) } });
    // `for..of` walks code points; the API counts UTF-16 units, so astral characters need a second slot.
    this.chars.push({ ch: "\n", text: { ...(p.text_style ?? {}) }, para: { namedStyleType: "NORMAL_TEXT", ...(p.para ?? {}) } });
  }

  // ── Reading ────────────────────────────────────────────────────────────────
  /** Document indices are 1-based; one slot per UTF-16 unit. */
  private slots(): Ch[] {
    const out: Ch[] = [];
    for (const c of this.chars) for (let i = 0; i < c.ch.length; i += 1) out.push(i === 0 ? c : { ...c, ch: "" });
    return out;
  }

  text(): string {
    return this.chars.map((c) => c.ch).join("");
  }

  paragraphs(): { text: string; para: Style; styles: Style[] }[] {
    const out: { text: string; para: Style; styles: Style[] }[] = [];
    let cur = "";
    let styles: Style[] = [];
    for (const c of this.chars) {
      if (c.ch === "\n") {
        out.push({ text: cur, para: c.para ?? {}, styles });
        cur = "";
        styles = [];
      } else {
        cur += c.ch;
        styles.push(c.text);
      }
    }
    return out;
  }

  lines(): string[] {
    return this.paragraphs().map((p) => p.text);
  }

  /** What documents.get returns for the first tab with the text-only field mask the app uses. Counts as a body download. */
  readText(): TextRunDocument {
    this.textReads += 1;
    if (this.maxReadableChars !== null && this.chars.length > this.maxReadableChars) throw new FakeApiError("timeout", 0, "reading the document took too long");
    const content: NonNullable<TextRunDocument["body"]>["content"] = [];
    let cur = "";
    for (const c of this.chars) {
      cur += c.ch;
      if (c.ch === "\n") {
        content!.push({ paragraph: { elements: [{ textRun: { content: cur } }] } });
        cur = "";
      }
    }
    return { body: { content } };
  }

  // ── Writing (what the sync sends) ──────────────────────────────────────────
  applyBatch(requests: DocRequest[]): void {
    if (this.failNextBatch) {
      const err = this.failNextBatch;
      this.failNextBatch = null;
      throw err;
    }
    // A batch is atomic: apply to a copy and swap only if every request is valid.
    const before = this.chars.map((c) => ({ ...c, text: { ...c.text }, ...(c.para ? { para: { ...c.para } } : {}) }));
    try {
      for (const r of requests) this.applyOne(r);
    } catch (err) {
      this.chars = before;
      throw err;
    }
    this.batches.push(requests);
    this.revision += 1;
    if (this.applyThenFail) {
      const err = this.applyThenFail;
      this.applyThenFail = null;
      throw err;
    }
  }

  private applyOne(r: DocRequest) {
    const [name] = Object.keys(r);
    const body = r[name] as Record<string, any>;
    switch (name) {
      case "insertText": {
        const index: number = body.location.index;
        const text: string = body.text;
        const tabId: string | undefined = body.location.tabId;
        if (tabId !== undefined && tabId !== this.firstTabId) throw new FakeApiError("bad_request", 400, `This request targets tab ${tabId}, which is not the first tab`);
        if (this.startsWithTable && index <= 1) throw new FakeApiError("bad_request", 400, `Invalid requests[0].insertText: Index ${index} is not inside a paragraph (the document starts with a table).`);
        const total = this.slots().length;
        if (!Number.isInteger(index) || index < 1 || index > total) throw new FakeApiError("bad_request", 400, `Index ${index} must be within the bounds of an existing paragraph (1..${total})`);
        const at = this.charIndexAt(index);
        const prev = at > 0 ? this.chars[at - 1] : this.chars[0];
        const textStyle = { ...(prev?.text ?? {}) };
        // A new line break copies the style of the paragraph it splits (the one containing `index`).
        const containing = this.chars.slice(at).find((c) => c.ch === "\n");
        const inserted: Ch[] = [];
        for (const ch of text) inserted.push(ch === "\n" ? { ch, text: { ...textStyle }, para: { ...(containing?.para ?? { namedStyleType: "NORMAL_TEXT" }) } } : { ch, text: { ...textStyle } });
        this.chars.splice(at, 0, ...inserted);
        return;
      }
      case "deleteContentRange": {
        const { startIndex, endIndex } = body.range;
        const total = this.slots().length;
        if (startIndex < 1 || endIndex > total + 1 || startIndex >= endIndex) throw new FakeApiError("bad_request", 400, "Invalid range");
        if (endIndex === total + 1) throw new FakeApiError("bad_request", 400, "The final newline of the document cannot be deleted");
        const s = this.charIndexAt(startIndex);
        const e = this.charIndexAt(endIndex);
        this.chars.splice(s, e - s);
        return;
      }
      case "updateTextStyle": {
        const fields: string[] = String(body.fields).split(",");
        for (const c of this.inRange(body.range.startIndex, body.range.endIndex)) {
          if (c.ch === "\n") continue;
          for (const f of fields) {
            if (f in (body.textStyle ?? {})) c.text[f] = body.textStyle[f];
            else delete c.text[f];
          }
        }
        return;
      }
      case "updateParagraphStyle": {
        const fields: string[] = String(body.fields).split(",");
        for (const c of this.paragraphEnds(body.range.startIndex, body.range.endIndex)) {
          c.para ??= {};
          for (const f of fields) {
            if (f in (body.paragraphStyle ?? {})) c.para[f] = body.paragraphStyle[f];
            else delete c.para[f];
          }
        }
        return;
      }
      case "deleteParagraphBullets": {
        for (const c of this.paragraphEnds(body.range.startIndex, body.range.endIndex)) delete c.para?.bullet;
        return;
      }
      default:
        throw new FakeApiError("bad_request", 400, `Unsupported request ${name}`);
    }
  }

  /** Position in `chars` of the character that starts at document index `index`. */
  private charIndexAt(index: number): number {
    let i = 1;
    for (let k = 0; k < this.chars.length; k += 1) {
      if (i >= index) return k;
      i += this.chars[k].ch.length;
    }
    return this.chars.length;
  }

  private inRange(start: number, end: number): Ch[] {
    return this.chars.slice(this.charIndexAt(start), this.charIndexAt(end));
  }

  /** The line break of every paragraph that overlaps [start, end). */
  private paragraphEnds(start: number, end: number): Ch[] {
    const out: Ch[] = [];
    let i = 1;
    let paragraphStart = 1;
    for (const c of this.chars) {
      const next = i + c.ch.length;
      if (c.ch === "\n") {
        if (paragraphStart < end && next > start) out.push(c);
        paragraphStart = next;
      }
      i = next;
    }
    return out;
  }

  // ── What a person does in the browser ──────────────────────────────────────
  private personEdit(fn: () => void) {
    fn();
    this.revision += 1;
  }

  /** Types `text` at the end of the first paragraph containing `needle`. */
  appendToParagraph(needle: string, text: string) {
    this.personEdit(() => {
      let at = 0;
      for (let k = 0; k < this.chars.length; k += 1) {
        if (this.chars[k].ch === "\n") {
          const line = this.chars.slice(at, k).map((c) => c.ch).join("");
          if (line.includes(needle)) {
            this.chars.splice(k, 0, ...[...text].map((ch) => ({ ch, text: { ...(this.chars[k - 1]?.text ?? {}) } })));
            return;
          }
          at = k + 1;
        }
      }
      throw new Error(`no paragraph contains ${needle}`);
    });
  }

  /** Replaces the first paragraph containing `needle` with `text` (keeps its line break). */
  replaceParagraph(needle: string, text: string) {
    this.personEdit(() => {
      let at = 0;
      for (let k = 0; k < this.chars.length; k += 1) {
        if (this.chars[k].ch === "\n") {
          const line = this.chars.slice(at, k).map((c) => c.ch).join("");
          if (line.includes(needle)) {
            const style = { ...(this.chars[at]?.text ?? {}) };
            this.chars.splice(at, k - at, ...[...text].map((ch) => ({ ch, text: { ...style } })));
            return;
          }
          at = k + 1;
        }
      }
      throw new Error(`no paragraph contains ${needle}`);
    });
  }

  deleteParagraph(needle: string) {
    this.personEdit(() => {
      let at = 0;
      for (let k = 0; k < this.chars.length; k += 1) {
        if (this.chars[k].ch === "\n") {
          const line = this.chars.slice(at, k).map((c) => c.ch).join("");
          if (line.includes(needle)) {
            this.chars.splice(at, k - at + 1);
            return;
          }
          at = k + 1;
        }
      }
      throw new Error(`no paragraph contains ${needle}`);
    });
  }

  /** Inserts a paragraph before the paragraph containing `needle` (or at the end when null). */
  insertParagraph(text: string, before: string | null) {
    this.personEdit(() => {
      if (before === null) {
        this.pushParagraph({ text });
        return;
      }
      let at = 0;
      for (let k = 0; k < this.chars.length; k += 1) {
        if (this.chars[k].ch === "\n") {
          const line = this.chars.slice(at, k).map((c) => c.ch).join("");
          if (line.includes(before)) {
            this.chars.splice(at, 0, ...[...text, "\n"].map((ch) => (ch === "\n" ? { ch, text: {}, para: { namedStyleType: "NORMAL_TEXT" } } : { ch, text: {} })));
            return;
          }
          at = k + 1;
        }
      }
      throw new Error(`no paragraph contains ${before}`);
    });
  }
}
