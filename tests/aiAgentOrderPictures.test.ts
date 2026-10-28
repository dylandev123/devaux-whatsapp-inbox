// Customer photos in order conversations: when a picture is read, which media addresses may be fetched, and what a model's
// reading is allowed to put on an order. Pure rules (lib/aiAgent/orderImages.ts); no network, no model.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allowedPictureUrl, MAX_PICTURES_PER_TURN, type MediaLine, parsePictureReading, pictureNote, pictureWords, picturesToRead, pointsAtPicture } from "../lib/aiAgent/orderImages.ts";

const ORIGIN = "http://203.0.113.9:3030";
const url = (slug: string, file = "1793113229713-AC39EF485DC922CF4E49486250ADA921.jpg") => `${ORIGIN}/media/${slug}/${file}`;
const img = (id: string, at: string, text = "", extra: Partial<MediaLine> = {}): MediaLine => ({ id, who: "Customer", text, at, mediaKind: "image", mediaUrl: url("cool_pool", `${id}.jpg`), ...extra });
const say = (who: "Customer" | "Staff", text: string, at: string): MediaLine => ({ who, text, at });

describe("words that point at a picture", () => {
  test("'this one', 'the one in the photo' and 'same as the picture' point at it; a named product does not", () => {
    for (const t of ["This one 55lbs", "this one", "the one in the photo", "same as the picture", "like this", "see above"]) assert.ok(pointsAtPicture(t), t);
    for (const t of ["2 bags of Monello 15kg", "Hello", "Yes sure"]) assert.ok(!pointsAtPicture(t), t);
  });
});

describe("which pictures are read", () => {
  const now = "2026-10-27T15:00:30Z";
  test("#KBNYW: a photo captioned 'This one 55lbs' is read", () => {
    const lines = [img("AC39", "2026-10-27T15:00:00Z", "This one 55lbs"), say("Customer", "This one", "2026-10-27T15:00:20Z")];
    assert.deepEqual(picturesToRead(lines, ["This one"], now).map((l) => l.id), ["AC39"]);
  });
  test("a photo nobody points at is left alone: no fetch, no model call", () => {
    const lines = [img("AC39", "2026-10-27T14:59:00Z", ""), say("Customer", "Morning, 2 bags of Monello 15kg to Cap Estate please", "2026-10-27T15:00:00Z")];
    assert.deepEqual(picturesToRead(lines, ["Morning, 2 bags of Monello 15kg to Cap Estate please"], now), []);
  });
  test("a later 'this one' points back at the photo before it", () => {
    const lines = [img("AC39", "2026-10-27T14:59:00Z", ""), say("Customer", "this one please", "2026-10-27T15:00:00Z")];
    assert.equal(picturesToRead(lines, ["this one please"], now).length, 1);
  });
  test("staff photos, old photos and non-images are not read; at most two are, newest first", () => {
    const lines = [
      img("OLD", "2026-10-25T10:00:00Z", "this one"),
      img("STAFF", "2026-10-27T14:00:00Z", "this one", { who: "Staff" }),
      img("VID", "2026-10-27T14:10:00Z", "this one", { mediaKind: "video" }),
      img("A", "2026-10-27T14:20:00Z", "this one"),
      img("B", "2026-10-27T14:30:00Z", "this one"),
      img("C", "2026-10-27T14:40:00Z", "this one"),
    ];
    const picked = picturesToRead(lines, ["this one"], now).map((l) => l.id);
    assert.deepEqual(picked, ["C", "B"]);
    assert.equal(picked.length, MAX_PICTURES_PER_TURN);
  });
});

describe("media addresses that may be fetched", () => {
  test("only an image file in THIS business's folder on the configured media origin", () => {
    assert.ok(allowedPictureUrl(url("cool_pool"), "cool_pool", ORIGIN));
    assert.equal(allowedPictureUrl(url("by_sea"), "cool_pool", ORIGIN), null, "another business's folder");
    assert.equal(allowedPictureUrl("http://evil.example/media/cool_pool/x.jpg", "cool_pool", ORIGIN), null, "another host");
    assert.equal(allowedPictureUrl(`${ORIGIN}/media/cool_pool/../by_sea/x.jpg`, "cool_pool", ORIGIN), null, "path traversal");
    assert.equal(allowedPictureUrl(`${ORIGIN}/media/cool_pool/x.jpg?x=1`, "cool_pool", ORIGIN), null, "query string");
    assert.equal(allowedPictureUrl(`${ORIGIN}/media/cool_pool/sub/x.jpg`, "cool_pool", ORIGIN), null, "nested path");
    assert.equal(allowedPictureUrl(`${ORIGIN}/media/cool_pool/x.ogg`, "cool_pool", ORIGIN), null, "not an image");
    assert.equal(allowedPictureUrl(`http://user:pw@203.0.113.9:3030/media/cool_pool/x.jpg`, "cool_pool", ORIGIN), null, "credentials in the address");
    assert.equal(allowedPictureUrl(url("cool_pool"), "cool_pool", undefined), null, "media origin not configured");
    assert.equal(allowedPictureUrl(null, "cool_pool", ORIGIN), null);
    assert.equal(allowedPictureUrl("not a url", "cool_pool", ORIGIN), null);
  });
});

describe("what a reading may put on an order", () => {
  test("#KBNYW: a Bandit 25kg bag reads as Bandit with the size that is printed", () => {
    const reading = parsePictureReading(JSON.stringify({ kind: "product", visible_text: ["Bandit", "OMEGA 6", "25kg"], product: "Bandit", size: "25kg" }));
    assert.equal(reading.kind, "product");
    assert.equal(reading.product, "Bandit");
    assert.equal(reading.size, "25kg");
    assert.deepEqual(pictureWords(reading), ["Bandit", "OMEGA 6", "25kg"]);
    assert.match(pictureNote(reading), /label reads: “Bandit”, “OMEGA 6”, “25kg”; product: Bandit; size printed: 25kg/);
  });
  test("a product or size nobody can see on the label is dropped, never invented", () => {
    const invented = parsePictureReading(JSON.stringify({ kind: "product", visible_text: ["Bandit"], product: "Bandit Chicken", size: "25kg" }));
    assert.equal(invented.kind, "unreadable", "the product is not among the visible words, so nothing is taken");
    assert.equal(invented.product, null);
    const noSize = parsePictureReading(JSON.stringify({ kind: "product", visible_text: ["Bandit", "Omega 6"], product: "Bandit", size: "15kg" }));
    assert.equal(noSize.product, "Bandit");
    assert.equal(noSize.size, null, "an unprinted size is dropped");
  });
  test("a quantity is never read from a picture", () => {
    const reading = parsePictureReading(JSON.stringify({ kind: "product", visible_text: ["Bandit", "25kg"], product: "Bandit", size: "25kg", quantity: 12 }));
    assert.equal("quantity" in reading, false);
  });
  test("unclear, non-product and malformed readings give no product", () => {
    assert.equal(parsePictureReading(JSON.stringify({ kind: "unreadable", visible_text: [], product: "Bandit" })).product, null);
    assert.equal(parsePictureReading(JSON.stringify({ kind: "other", visible_text: ["Happy birthday"], product: "Happy birthday" })).product, null);
    assert.equal(parsePictureReading(JSON.stringify({ kind: "product", visible_text: [], product: "Bandit" })).kind, "unreadable");
    assert.equal(parsePictureReading("sorry I cannot see that").kind, "unreadable");
    assert.equal(parsePictureReading("").kind, "unreadable");
    assert.match(pictureNote(parsePictureReading("{}")), /could not be read/);
    assert.deepEqual(pictureWords(parsePictureReading("{}")), []);
  });
});
