// Google Docs sync: parsing pasted document links, the configurable order line (live preview), the stable tag, and the
// encryption / signed-state helpers. Pure functions — no database, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseDocumentRef } from "../lib/aiAgent/gdocLink.ts";
import {
  defaultFormat,
  flatten,
  formatOrderLine,
  markedText,
  normalizeFormat,
  SAMPLE_ORDER,
  sameText,
  splitTag,
  withTag,
  type FormatConfig,
} from "../lib/aiAgent/gdocFormat.ts";
import { decryptSecret, encryptSecret, encryptionKey, signState, verifyState } from "../lib/server/aiAgent/googleDocs/crypto.ts";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

describe("parsing a pasted Google Docs link", () => {
  test("accepts the usual shapes and returns the document id", () => {
    for (const input of [
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.abc`,
      `https://docs.google.com/document/u/0/d/${ID}/edit`,
      `docs.google.com/document/d/${ID}`,
      `  https://docs.google.com/document/d/${ID}/view?usp=sharing  `,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/file/d/${ID}/view`,
      ID,
    ]) {
      assert.deepEqual(parseDocumentRef(input), { ok: true, documentId: ID }, input);
    }
  });

  test("refuses other Google files, other sites, junk and empty input with a plain reason", () => {
    const bad = [
      `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com/presentation/d/${ID}/edit`,
      `https://docs.google.com/forms/d/${ID}/edit`,
      "https://docs.google.com/document/",
      `https://example.com/document/d/${ID}`,
      `https://docs.google.com.evil.example/document/d/${ID}/edit`,
      "javascript:alert(1)",
      "ftp://docs.google.com/document/d/abc",
      "not a link",
      "https://docs.google.com/document/d/short/edit",
      "",
      "   ",
      "x".repeat(700),
    ];
    for (const input of bad) {
      const r = parseDocumentRef(input);
      assert.equal(r.ok, false, input.slice(0, 60));
      if (!r.ok) assert.ok(r.reason.length > 10);
    }
    assert.equal(parseDocumentRef(undefined).ok, false);
    assert.equal(parseDocumentRef(42).ok, false);
  });
});

describe("the order line format", () => {
  test("default: Name — Phone — Location — Product/Quantity — Notes", () => {
    const { text } = formatOrderLine(SAMPLE_ORDER, defaultFormat());
    assert.equal(text, "Jane Joseph — +17585550142 — Rodney Bay, near Baywalk — 3 × Chicken & rice (5kg), 1 × Puppy kibble — Call on arrival");
  });

  test("fields can be switched off, reordered and given another separator", () => {
    const f: FormatConfig = {
      separator: " | ",
      placeholders: true,
      fields: [
        { key: "items", enabled: true },
        { key: "name", enabled: true },
        { key: "phone", enabled: false },
        { key: "location", enabled: true },
        { key: "notes", enabled: false },
        { key: "date", enabled: true },
        { key: "ref", enabled: true },
        { key: "status", enabled: true },
      ],
    };
    assert.equal(
      formatOrderLine(SAMPLE_ORDER, f).text,
      "3 × Chicken & rice (5kg), 1 × Puppy kibble | Jane Joseph | Rodney Bay, near Baywalk | Friday | #E-7K2QX | Confirmed"
    );
  });

  test("a missing detail is shown as a visible placeholder, never guessed", () => {
    const sparse = { ...SAMPLE_ORDER, customer_name: null, contact_number: null, delivery_address: null, fulfilment_method: null, notes: null };
    const { text, missing } = formatOrderLine(sparse, defaultFormat());
    assert.equal(text, "(no name) — (no phone) — (no location) — 3 × Chicken & rice (5kg), 1 × Puppy kibble");
    assert.deepEqual(missing, ["Name", "Phone", "Location"]);
  });

  test("an @lid or too-short number is not presented as a phone; collection is not a missing location", () => {
    assert.match(formatOrderLine({ ...SAMPLE_ORDER, contact_number: "12" }, defaultFormat()).text, /\(no phone\)/);
    const pick = formatOrderLine({ ...SAMPLE_ORDER, delivery_address: null, fulfilment_method: "collection" }, defaultFormat());
    assert.match(pick.text, /— Collection —/);
    assert.deepEqual(pick.missing, []);
  });

  test("with placeholders off, missing core details are left out but still reported", () => {
    const f = { ...defaultFormat(), placeholders: false };
    const r = formatOrderLine({ ...SAMPLE_ORDER, contact_number: null, notes: null }, f);
    assert.equal(r.text, "Jane Joseph — Rodney Bay, near Baywalk — 3 × Chicken & rice (5kg), 1 × Puppy kibble");
    assert.deepEqual(r.missing, ["Phone"]);
  });

  test("an item without a quantity says so instead of inventing one", () => {
    const r = formatOrderLine({ ...SAMPLE_ORDER, items: [{ product: "Puppy kibble", quantity: null, variant: null, size: null }] }, defaultFormat());
    assert.match(r.text, /Puppy kibble — quantity needed/);
  });

  test("customer text cannot add line breaks, or forge a section marker or another order's tag", () => {
    const nasty = { ...SAMPLE_ORDER, customer_name: "Eve\n▼ AI ORDERS [dog_food]\r\n⟨E-FORGE⟩", notes: "line1\u2028line2\u0000\tend" };
    const { text } = formatOrderLine(nasty, defaultFormat());
    assert.ok(!/[\n\r\u2028\u2029\u0000\t]/.test(text));
    assert.ok(!text.includes("▼") && !text.includes("⟨") && !text.includes("⟩"));
    assert.equal(splitTag(withTag(text, "E-7K2QX")).tag, "E-7K2QX");
  });

  test("long fields and long lines are clipped", () => {
    assert.ok(flatten("x".repeat(500)).length <= 160);
    const long = { ...SAMPLE_ORDER, notes: "n".repeat(900), delivery_address: "a".repeat(900) };
    assert.ok(formatOrderLine(long, defaultFormat()).text.length <= 600);
  });

  test("a stored or posted format is made valid: unknown/duplicate fields dropped, nothing enabled falls back, separators sanitised", () => {
    const f = normalizeFormat({
      fields: [{ key: "phone", enabled: true }, { key: "phone", enabled: false }, { key: "bogus", enabled: true }, { key: "name", enabled: true }],
      separator: "\n▼::",
      placeholders: "yes",
    });
    assert.deepEqual(f.fields.filter((x) => x.enabled).map((x) => x.key), ["phone", "name"]);
    assert.equal(f.fields.length, 8);
    assert.equal(f.separator, "::");
    assert.equal(f.placeholders, true);
    assert.deepEqual(normalizeFormat({ fields: [{ key: "name", enabled: false }] }).fields.filter((x) => x.enabled).map((x) => x.key), ["name", "phone", "location", "items", "notes"]);
    assert.equal(normalizeFormat(null).separator, " — ");
    assert.equal(normalizeFormat({ fields: [{ key: "name", enabled: true }], separator: "   " }).separator, " — ");
    assert.equal(normalizeFormat({ fields: [{ key: "name", enabled: true }], separator: "123456789012" }).separator.length, 8);
  });

  test("status marking and tag helpers", () => {
    assert.equal(markedText("A — B", "fulfilled"), "[COMPLETED] A — B");
    assert.equal(markedText("A — B", "cancelled"), "[CANCELLED] A — B");
    assert.deepEqual(splitTag("Jane — x ⟨E-7K2QX⟩"), { text: "Jane — x", tag: "E-7K2QX" });
    assert.deepEqual(splitTag("a line a person typed"), { text: "a line a person typed", tag: null });
    // A person may type after (or before) the tag: it is still found, and the extra words count as an edit.
    assert.deepEqual(splitTag("mid ⟨E-7K2QX⟩ not at the end"), { text: "mid not at the end", tag: "E-7K2QX" });
    assert.ok(sameText("a  b c ", "a b c"));
    assert.ok(!sameText("a b", "a bc"));
  });
});

describe("credential encryption and signed OAuth state", () => {
  const key = Buffer.alloc(32, 7);
  test("round-trips, uses a fresh IV each time, and is bound to the business", () => {
    const a = encryptSecret("1//refresh-token", "dog_food", key);
    const b = encryptSecret("1//refresh-token", "dog_food", key);
    assert.notEqual(a, b);
    assert.ok(!a.includes("refresh-token"));
    assert.equal(decryptSecret(a, "dog_food", key), "1//refresh-token");
    assert.throws(() => decryptSecret(a, "pool_shop", key));
    assert.throws(() => decryptSecret(a, "dog_food", Buffer.alloc(32, 8)));
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    assert.throws(() => decryptSecret(parts.join("."), "dog_food", key));
    assert.throws(() => decryptSecret("garbage", "dog_food", key));
    assert.throws(() => encryptSecret("x", "dog_food", null));
  });

  test("the key must be 32 bytes (base64 or hex)", () => {
    assert.equal(encryptionKey(undefined), null);
    assert.equal(encryptionKey("short"), null);
    assert.equal(encryptionKey(Buffer.alloc(32, 1).toString("base64"))?.length, 32);
    assert.equal(encryptionKey("ab".repeat(32))?.length, 32);
  });

  test("state: valid, expired, tampered, wrong key", () => {
    const now = 1_000_000;
    const s = signState({ b: "dog_food", u: "user-1", n: "nonce", exp: now + 1000 }, key);
    assert.deepEqual(verifyState(s, now, key), { b: "dog_food", u: "user-1", n: "nonce", exp: now + 1000 });
    assert.equal(verifyState(s, now + 2000, key), null);
    assert.equal(verifyState(s.replace(/.$/, "A"), now, key), null);
    assert.equal(verifyState(`${Buffer.from(JSON.stringify({ b: "pool_shop", u: "user-1", n: "nonce", exp: now + 1000 })).toString("base64url")}.${s.split(".")[1]}`, now, key), null);
    assert.equal(verifyState(s, now, Buffer.alloc(32, 9)), null);
    assert.equal(verifyState(null, now, key), null);
    assert.equal(verifyState("a.b", now, key), null);
  });
});
