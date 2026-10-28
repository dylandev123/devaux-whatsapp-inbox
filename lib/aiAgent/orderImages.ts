// Customer photos in order conversations — pure rules, no I/O.
//
// "This one 55lbs" under a picture of a dog-food bag means nothing to a text-only reader. The Inbox reads the picture ONCE,
// only when the words point at it, and turns what is plainly visible on it into a short note beside the message ("photo:
// label reads Bandit, 25kg"). The note is evidence about the picture, never about the order: a quantity is never taken
// from a picture, a variant or size is only taken from text that is actually printed on the packaging, and an unclear
// picture yields no product at all.
//
// This file decides WHEN to read a picture, WHICH media addresses may be fetched, how to validate what the model says about
// it, and how the note reads. lib/server/aiAgent/orderImages.ts does the fetching and the one model call.

import { normalizeText } from "./escalationUpdates.ts";

/** Words that point at a picture: "this one", "the one in the photo", "same as the picture", "like this". */
const POINTS_AT_PICTURE =
  /\b(?:this|that|these|those)(?: one| ones| bag| bags| product| food| item| size| type| kind| flavou?r| brand)?\b|\b(?:the )?(?:one|ones) (?:in|on|from|i sent|i just sent)\b|\b(?:like|same as|as in|as on|as per|see|check) (?:the )?(?:this|that|pic|picture|photo|image|screenshot|attached|above)\b|\b(?:pic|pics|picture|pictures|photo|photos|image|screenshot|attached|above)\b/i;

/** True when words refer to something shown rather than named ("this one 55lbs"). */
export const pointsAtPicture = (text: string): boolean => POINTS_AT_PICTURE.test(text);

/** The most pictures read for one customer turn, and the biggest one fetched. */
export const MAX_PICTURES_PER_TURN = 2;
export const MAX_PICTURE_BYTES = 4_000_000;
/** A picture older than this (relative to the turn) is not what "this one" now refers to. */
export const PICTURE_WINDOW_HOURS = 24;
/** Model reads per business per hour, across every chat: a flood of photos cannot become a bill. */
export const PICTURE_READS_PER_BUSINESS_PER_HOUR = 40;
/** Fetch attempts per picture, ever: an expired or missing picture is not retried forever. */
export const PICTURE_MAX_ATTEMPTS = 2;

export interface MediaLine {
  id?: string | null;
  who: "Customer" | "Staff";
  text: string;
  at: string;
  /** "image" | "audio" | "video" | "document" | "sticker"… from message_type. */
  mediaKind?: string | null;
  mediaUrl?: string | null;
}

/**
 * The customer pictures worth reading for a turn, newest first: sent by the customer, in the window, and referred to by
 * their own caption, by something the customer wrote after it, or by this turn's words. A picture nobody points at is
 * left alone: no fetch, no model call.
 */
export function picturesToRead(lines: MediaLine[], turnTexts: string[], turnAt: string): MediaLine[] {
  const turn = Date.parse(turnAt);
  const turnPoints = turnTexts.some(pointsAtPicture);
  const ordered = [...lines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const picked: MediaLine[] = [];
  for (const [i, line] of ordered.entries()) {
    if (line.who !== "Customer" || line.mediaKind !== "image" || !line.mediaUrl) continue;
    const age = turn - Date.parse(line.at);
    if (!Number.isNaN(age) && (age > PICTURE_WINDOW_HOURS * 3_600_000 || age < -60_000)) continue;
    const later = ordered.slice(i + 1).filter((m) => m.who === "Customer" && m.text.trim());
    if (pointsAtPicture(line.text) || later.some((m) => pointsAtPicture(m.text)) || turnPoints) picked.push(line);
  }
  return picked.reverse().slice(0, MAX_PICTURES_PER_TURN);
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:jpe?g|png|webp)$/i;

/**
 * A media address the Inbox may fetch: on the configured media origin, under THIS business's folder, a plain image file.
 * Nothing else is ever requested, so a crafted address cannot reach another business's pictures or an internal service.
 */
export function allowedPictureUrl(url: string | null | undefined, businessSlug: string, mediaOrigin: string | undefined): URL | null {
  if (!url || !mediaOrigin) return null;
  let target: URL;
  let origin: URL;
  try {
    target = new URL(url);
    origin = new URL(mediaOrigin);
  } catch {
    return null;
  }
  if (target.origin !== origin.origin || target.username || target.password || target.search || target.hash) return null;
  const parts = target.pathname.split("/");
  // ["", "media", "<business>", "<file>"]
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "media" || parts[2] !== businessSlug || !SAFE_FILE.test(parts[3])) return null;
  return target;
}

export type PictureKind = "product" | "other" | "unreadable";

export interface PictureReading {
  kind: PictureKind;
  /** Text actually visible on the picture (labels, packaging, screenshot captions), as the model transcribed it. */
  visibleText: string[];
  /** The product named by the label, only when its words are among the visible text. */
  product: string | null;
  /** A bag size / weight, only when it is printed in the visible text. */
  size: string | null;
}

export const PICTURE_UNAVAILABLE: PictureReading = { kind: "unreadable", visibleText: [], product: null, size: null };

const words = (s: string) => normalizeText(s).split(" ").filter(Boolean);

/** Every word of `claim` appears among the visible words: the model may transcribe, never invent. */
const isVisible = (claim: string, visible: Set<string>) => {
  const w = words(claim);
  return w.length > 0 && w.every((x) => visible.has(x));
};

/**
 * Validates what the model said about a picture. Anything it names that is not backed by text it says is visible is dropped:
 * a product or size nobody can see on the label never reaches the order.
 */
export function parsePictureReading(raw: string): PictureReading {
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return PICTURE_UNAVAILABLE;
  }
  if (!data || typeof data !== "object") return PICTURE_UNAVAILABLE;
  const o = data as Record<string, unknown>;
  const visibleText = (Array.isArray(o.visible_text) ? o.visible_text : []).filter((t): t is string => typeof t === "string").map((t) => t.replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  const visible = new Set(visibleText.flatMap(words));
  const kind: PictureKind = o.kind === "product" && visibleText.length > 0 ? "product" : o.kind === "other" ? "other" : "unreadable";
  if (kind !== "product") return { kind, visibleText: kind === "other" ? visibleText : [], product: null, size: null };
  const product = typeof o.product === "string" && isVisible(o.product, visible) ? o.product.replace(/\s+/g, " ").trim().slice(0, 80) : null;
  const size = typeof o.size === "string" && isVisible(o.size, visible) ? o.size.replace(/\s+/g, " ").trim().slice(0, 20) : null;
  return { kind: product ? "product" : "unreadable", visibleText: product ? visibleText : [], product, size: product ? size : null };
}

/** The line shown beside the customer's picture, for the order reader and for staff. Never a quantity. */
export function pictureNote(reading: PictureReading | null | undefined): string {
  if (!reading || reading.kind === "unreadable") return "[photo — could not be read; no product taken from it]";
  if (reading.kind === "other") return "[photo — not a product label]";
  return `[photo — label reads: ${reading.visibleText.map((t) => `“${t}”`).join(", ")}${reading.product ? `; product: ${reading.product}` : ""}${reading.size ? `; size printed: ${reading.size}` : ""}]`;
}

/** The note for a media message that is not read. */
export function mediaPlaceholder(kind: string | null | undefined): string | null {
  switch (kind) {
    case "image":
      return "[photo — not read]";
    case "audio":
    case "ptt":
    case "voice":
      return "[voice message — not transcribed]";
    case "video":
      return "[video]";
    case "document":
      return "[document]";
    case "sticker":
      return null;
    default:
      return null;
  }
}

/** Words the picture's own label supplies, for checking the order reader's values: only for a picture the customer pointed at. */
export const pictureWords = (reading: PictureReading | null | undefined): string[] => (reading && reading.kind === "product" ? reading.visibleText : []);
