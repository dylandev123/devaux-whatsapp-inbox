// Google Docs link parsing — pure, no I/O. Staff paste whatever they have in the address bar or a bare document id;
// this returns the document id, or a plain reason the text is not a Google Doc we can use.

export type DocRefResult = { ok: true; documentId: string } | { ok: false; reason: string };

// Google document ids are 25+ characters of letters, digits, "-" and "_" (typically 44).
const ID = /^[A-Za-z0-9_-]{25,100}$/;

export function parseDocumentRef(input: unknown): DocRefResult {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { ok: false, reason: "Paste the link to your Google Doc." };
  if (text.length > 600) return { ok: false, reason: "That is too long to be a Google Docs link." };

  if (ID.test(text)) return { ok: true, documentId: text };
  if (/\s/.test(text)) return { ok: false, reason: "That does not look like a single Google Docs link or document id." };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "That is not a valid link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "That is not a web link." };

  const host = url.hostname.toLowerCase();
  if (host === "docs.google.com") {
    // /document/d/<id>/edit, /document/u/0/d/<id>/edit, /document/d/<id>/edit?tab=t.0
    const doc = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    if (doc) return ID.test(doc[1]) ? { ok: true, documentId: doc[1] } : { ok: false, reason: "That document id looks incomplete — copy the whole link from the address bar." };
    if (/^\/(spreadsheets|presentation|forms|drawings)\b/.test(url.pathname)) {
      return { ok: false, reason: "That link is not a Google Doc (it is a Sheet, Slides, Form or Drawing). Paste the link of a Google Docs document." };
    }
    return { ok: false, reason: "That Google link is not a document link. Open the document and copy the link from the address bar." };
  }
  if (host === "drive.google.com") {
    const file = /^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    const id = file?.[1] ?? url.searchParams.get("id");
    if (id && ID.test(id)) return { ok: true, documentId: id };
    return { ok: false, reason: "That Drive link is not a single document. Open the Google Doc and copy its link." };
  }
  return { ok: false, reason: "Only docs.google.com document links (or a document id) are supported." };
}
