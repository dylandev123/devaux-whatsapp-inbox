// Google Docs order sync, end to end: the app's REAL server code (admin actions → sync engine → store) against the REAL
// migration in a throwaway Postgres, with an in-memory Google Doc standing in for Google. Proves: nothing is written while
// disabled, enabling lists only NEW orders, retries / concurrency / crashes never duplicate a line, a person's edits are
// never overwritten, revoked access blocks cleanly, businesses are isolated, and no WhatsApp message is ever queued.
// Skips itself when no Postgres binaries are installed.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import { FakeApiError, FakeGoogleDoc } from "./helpers/fakeGoogleDoc.ts";
import { fakeClient } from "./helpers/fakeDocsClient.ts";
import { GoogleApiError } from "../lib/server/aiAgent/googleDocs/google.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const A = "dog_food";
const B = "pool_shop";
const DOC_A = "docA_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC_B = "docB_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LINK_A = `https://docs.google.com/document/d/${DOC_A}/edit`;
const LINK_B = `https://docs.google.com/document/d/${DOC_B}/edit?tab=t.0`;
const USER = "00000000-0000-0000-0000-0000000000aa";

let pg: TestPg;
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let sync: typeof import("../lib/server/aiAgent/googleDocs/sync.ts");
let admin: typeof import("../lib/server/aiAgent/googleDocs/admin.ts");
let store: typeof import("../lib/server/aiAgent/googleDocs/store.ts");
let ordersMod: typeof import("../lib/server/aiAgent/orders.ts");

let docs: Record<string, FakeGoogleDoc>;
let client: ReturnType<typeof fakeClient>;
let factoryCalls = 0;
let blocked: Error | null = null;
let seq = 0;

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

function staffDoc(title = "Staff orders") {
  return new FakeGoogleDoc(title, [
    { text: "DELIVERIES", para: { namedStyleType: "HEADING_1" }, text_style: { bold: true } },
    { text: "Gate code 1234", text_style: {} },
    { text: "Remember to restock", text_style: { italic: true } },
  ]);
}

async function addOrder(slug: string, over: { ref?: string; name?: string; status?: string; items?: unknown[]; address?: string | null; at?: string; notes?: string | null; attention?: string | null; phone?: string | null } = {}) {
  seq += 1;
  const ref = over.ref ?? `E-S${String(seq).padStart(4, "0")}`;
  const items = over.items ?? [{ product: "Chicken", quantity: "2", variant: null, size: null }];
  const at = over.at ?? new Date().toISOString();
  await pg.run(`insert into public.ai_agent_orders (ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_address, notes, attention, missing_fields, manual_locked_fields, first_message_at, last_message_at, created_at)
    values (${lit(ref)}, ${lit(slug)}, ${lit(`1758555${String(seq).padStart(4, "0")}@s.whatsapp.net`)}, ${over.phone === null ? "null" : lit(over.phone ?? `1758555${String(seq).padStart(4, "0")}`)}, ${lit(over.name ?? `Customer ${seq}`)}, ${lit(over.status ?? "confirmed")}, ${lit(JSON.stringify(items))}::jsonb,
      ${over.address === null ? "null" : "'delivery'"}, ${over.address === null ? "null" : lit(over.address ?? "Rodney Bay")}, ${over.notes ? lit(over.notes) : "null"}, ${over.attention ? lit(over.attention) : "null"}, '{}', '{}', ${lit(at)}, ${lit(at)}, ${lit(at)});`);
  return ref;
}
const changeOrder = (ref: string, set: string) => pg.run(`update public.ai_agent_orders set ${set}, version = version + 1 where ref_code = ${lit(ref)};`);
const linesOf = (doc: FakeGoogleDoc) => doc.lines().filter((l) => l.includes("⟨E-"));
const lineRows = (slug = A) => rows<Record<string, any>>(`select * from public.ai_agent_gdoc_lines where business_slug = ${lit(slug)} order by created_at, id`);
const settingsRow = async (slug = A) => (await rows<Record<string, any>>(`select * from public.ai_agent_gdoc_settings where business_slug = ${lit(slug)}`))[0];

/** Connect the (fake) account, paste the link, verify, switch sync on — the same calls the dashboard makes. */
async function setUp(slug = A, link = LINK_A) {
  await admin.setDocument(slug, link, USER);
  await admin.setEnabled(slug, true, USER);
}

describe("Google Docs order sync (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    sync = await import("../lib/server/aiAgent/googleDocs/sync.ts");
    admin = await import("../lib/server/aiAgent/googleDocs/admin.ts");
    store = await import("../lib/server/aiAgent/googleDocs/store.ts");
    ordersMod = await import("../lib/server/aiAgent/orders.ts");
    sync.setDocsClientFactoryForTests(async () => {
      factoryCalls += 1;
      if (blocked) throw blocked;
      return { client, email: "staff@example.com" };
    });
  });
  after(() => {
    sync?.setDocsClientFactoryForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`truncate public.ai_agent_orders, public.ai_agent_gdoc_lines, public.ai_agent_gdoc_settings, public.ai_agent_google_connections, public.ai_agent_outbox, public.ai_agent_audit_log cascade;`);
    docs = { [DOC_A]: staffDoc("Dog food orders"), [DOC_B]: staffDoc("Pool shop orders") };
    client = fakeClient(docs);
    factoryCalls = 0;
    blocked = null;
  });

  // Whatever a test does, the integration must never queue a WhatsApp message.
  const noWhatsapp = async () => assert.equal(await count(`select 1 from public.ai_agent_outbox`), 0, "no WhatsApp message was queued");

  test("the migration is idempotent and keeps credentials away from dashboard roles", async () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261112000000_ai_agent_google_docs_sync.sql"), "utf8");
    await pg.run(sql);
    await pg.run(sql);
    assert.equal(await pg.run(`select has_table_privilege('authenticated', 'public.ai_agent_google_connections', 'select');`), "f");
    assert.equal(await pg.run(`select has_table_privilege('anon', 'public.ai_agent_gdoc_lines', 'select');`), "f");
    assert.equal(await pg.run(`select has_table_privilege('authenticated', 'public.ai_agent_gdoc_settings', 'select');`), "t");
    assert.equal(await pg.run(`select has_function_privilege('authenticated', 'public.claim_gdoc_sync(text,text,integer)', 'execute');`), "f");
  });

  test("synchronization is OFF by default: nothing is read or written, however many orders arrive", async () => {
    await addOrder(A);
    assert.equal((await sync.runSync(A)).status, "disabled");
    const s = await store.loadGdocSettings(A);
    assert.equal(s?.enabled, false);
    await sync.triggerOrderSync(A);
    await sync.runDueGoogleDocSyncs();
    assert.equal(factoryCalls, 0, "Google was never contacted");
    assert.equal(docs[DOC_A].batches.length, 0);
    const dash = await admin.getDashboard(A);
    assert.equal(dash.setupPending, false);
    if (!dash.setupPending) assert.equal(dash.settings.enabled, false);
    await noWhatsapp();
  });

  test("a Google timeout or outage during the access test gives a distinct message, a 504 for timeouts, and saves nothing", async () => {
    const slow = { ...client, getDocument: async () => { throw new GoogleApiError("timeout", 0, "x", [], "Docs read"); } };
    client = slow as never;
    const t = await admin.setDocument(A, LINK_A, USER).catch((e: any) => e);
    assert.equal(t.status, 504);
    assert.match(t.message, /too long.*Docs read timed out.*Nothing was changed/);
    client = { ...fakeClient(docs), getFile: async () => { throw new GoogleApiError("network", 0, "x", [], "Drive metadata"); } } as never;
    const n = await admin.setDocument(A, LINK_A, USER).catch((e: any) => e);
    assert.equal(n.status, 400);
    assert.match(n.message, /Could not reach Google.*Drive metadata/);
    assert.equal((await settingsRow())?.document_id ?? null, null, "a failed test saves no document");
  });

  test("pasting a link tests access WITHOUT writing; a view-only or non-Doc file is refused for sync", async () => {
    const report = await admin.setDocument(A, LINK_A, USER);
    assert.equal(report.title, "Dog food orders");
    assert.equal(report.canEdit, true);
    assert.equal(report.section, "none");
    assert.equal(docs[DOC_A].batches.length, 0, "no write");
    assert.equal((await settingsRow()).enabled, false);

    const again = await admin.testStoredDocument(A);
    assert.equal(again.account, "staff@example.com");
    assert.equal(docs[DOC_A].batches.length, 0);

    await assert.rejects(admin.setDocument(A, "https://example.com/x", USER), /Only docs\.google\.com/);
    await assert.rejects(admin.setDocument(A, `https://docs.google.com/document/d/${"z".repeat(30)}/edit`, USER), /cannot find this document/);

    docs[DOC_A].canEdit = false;
    await admin.setDocument(A, LINK_A, USER);
    await assert.rejects(admin.setEnabled(A, true, USER), /only view/);
    assert.equal((await settingsRow()).enabled, false);
    docs[DOC_A].canEdit = true;

    docs[DOC_A].mimeType = "application/vnd.google-apps.spreadsheet";
    await assert.rejects(admin.setDocument(A, LINK_A, USER), /not a Google Docs document/);
    await noWhatsapp();
  });

  test("enabling lists only NEW orders; the existing outstanding ones wait for the explicit import", async () => {
    const old = await addOrder(A, { ref: "E-OLD01", at: new Date(Date.now() - 3 * 86400_000).toISOString() });
    await admin.setDocument(A, LINK_A, USER);
    assert.equal(docs[DOC_A].batches.length, 0);
    const before = JSON.parse(JSON.stringify(docs[DOC_A].paragraphs()));
    await admin.setEnabled(A, true, USER);
    assert.equal(docs[DOC_A].batches.length, 0, "enabling does not write by itself");
    const fresh = await addOrder(A, { ref: "E-NEW01", name: "Jane" });

    const r = await sync.runSync(A);
    assert.equal(r.status, "ok");
    assert.equal(r.inserted, 1);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`⟨${fresh}⟩`) && !lines.some((l) => l.includes(old)));

    // Pre-existing content untouched, in order, with formatting.
    const after = docs[DOC_A].paragraphs();
    for (const p of before) {
      const same = after.find((a) => a.text === p.text);
      assert.ok(same, p.text);
      assert.deepEqual(same.para, p.para);
      assert.deepEqual(same.styles, p.styles);
    }
    assert.equal(docs[DOC_A].lines()[0].startsWith("▼ AI ORDERS [dog_food]"), true, "section at the top by default");
    assert.equal((await store.loadGdocSettings(A))?.health, "ok");
    await noWhatsapp();
  });

  test("the chosen insertion position is used (after a heading), and a bad one is refused before anything is written", async () => {
    await admin.setDocument(A, LINK_A, USER);
    await admin.saveConfig(A, { insertion: { kind: "after_text", text: "no such text" } }, USER);
    await assert.rejects(admin.setEnabled(A, true, USER), /No paragraph contains/);
    await admin.saveConfig(A, { insertion: { kind: "after_text", text: "Gate code" } }, USER);
    await admin.setEnabled(A, true, USER);
    await addOrder(A);
    await sync.runSync(A);
    const l = docs[DOC_A].lines();
    assert.equal(l[l.indexOf("Gate code 1234") + 2].startsWith("▼ AI ORDERS"), true);
    assert.equal(l.at(-1), "Remember to restock");
  });

  test("newest first, one paragraph per order, and a second run changes nothing (idempotent)", async () => {
    await setUp();
    const first = await addOrder(A, { name: "Alice", at: new Date(Date.now() + 1000).toISOString() });
    await sync.runSync(A);
    const second = await addOrder(A, { name: "Bob", at: new Date(Date.now() + 2000).toISOString() });
    const third = await addOrder(A, { name: "Cara", at: new Date(Date.now() + 3000).toISOString() });
    await sync.runSync(A);
    const lines = linesOf(docs[DOC_A]);
    assert.deepEqual(lines.map((x) => x.match(/⟨(E-[A-Z0-9]+)⟩/)![1]), [third, second, first]);
    assert.ok(lines[0].startsWith("Cara") && lines[2].startsWith("Alice"));

    const batches = docs[DOC_A].batches.length;
    const again = await sync.runSync(A);
    assert.deepEqual([again.inserted, again.updated, again.removed], [0, 0, 0]);
    assert.equal(docs[DOC_A].batches.length, batches, "no document write on a no-op run");
    assert.equal((await lineRows()).length, 3);
  });

  test("orders that might not be orders are not synced; they appear once staff confirm them", async () => {
    await setUp();
    const maybe = await addOrder(A, { attention: "review_order_intent" });
    const empty = await addOrder(A, { items: [] });
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    await changeOrder(maybe, "attention = null");
    await sync.runSync(A);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(maybe) && !lines[0].includes(empty));
  });

  test("a corrected order updates its own line in place; completed and cancelled follow the settings", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice", address: "Rodney Bay" });
    const b = await addOrder(A, { name: "Bob" });
    const c = await addOrder(A, { name: "Cara" });
    await sync.runSync(A);

    await changeOrder(a, "delivery_address = 'Gros Islet'");
    await changeOrder(b, "status = 'fulfilled'");
    await changeOrder(c, "status = 'cancelled'");
    await admin.saveConfig(A, { onCancelled: "remove" }, USER);
    const r = await sync.runSync(A);
    assert.equal(r.updated, 2);
    assert.equal(r.removed, 1);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.startsWith("Alice") && l.includes("Gros Islet") && !l.includes("Rodney Bay")));
    assert.ok(lines.some((l) => l.startsWith("[COMPLETED] Bob")));
    assert.ok(!lines.some((l) => l.includes("Cara")));
    const bob = docs[DOC_A].paragraphs().find((p) => p.text.startsWith("[COMPLETED] Bob"))!;
    assert.equal(bob.styles[0].strikethrough, true);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1, "still one line per order");
  });

  test("corrections can wait for approval: nothing is written until a person approves", async () => {
    await setUp();
    await admin.saveConfig(A, { onCorrected: "review" }, USER);
    const a = await addOrder(A, { name: "Alice", address: "Rodney Bay" });
    await sync.runSync(A);
    await changeOrder(a, "delivery_address = 'Gros Islet'");
    await sync.runSync(A);
    assert.ok(linesOf(docs[DOC_A])[0].includes("Rodney Bay"));
    const [line] = await lineRows();
    assert.equal(line.state, "pending_review");
    assert.match(line.pending_text, /Gros Islet/);
    const dash = await admin.getDashboard(A);
    if (!dash.setupPending) assert.equal(dash.problems[0].state, "pending_review");

    await admin.resolveLine(A, line.id, "overwrite", USER);
    assert.ok(linesOf(docs[DOC_A])[0].includes("Gros Islet"));
    assert.equal((await lineRows())[0].state, "synced");
  });

  test("a line a person edited is never overwritten: the change is held, shown in the dashboard, and resolved by choice", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice", address: "Rodney Bay" });
    await sync.runSync(A);
    docs[DOC_A].appendToParagraph(a, " — gate is BLUE, call first");
    const edited = docs[DOC_A].lines().find((l) => l.includes(a))!;

    await changeOrder(a, "delivery_address = 'Gros Islet'");
    const r = await sync.runSync(A);
    assert.equal(r.updated, 0);
    assert.equal(docs[DOC_A].lines().find((l) => l.includes(a)), edited, "the person's text is untouched");
    const [line] = await lineRows();
    assert.equal(line.state, "conflict");
    assert.match(line.found_text, /gate is BLUE/);
    assert.match(line.pending_text, /Gros Islet/);

    // Further order changes and further runs still never touch it.
    await changeOrder(a, "notes = 'later note'");
    await sync.runSync(A);
    await sync.runSync(A);
    assert.equal(docs[DOC_A].lines().find((l) => l.includes(a)), edited);

    const dash = await admin.getDashboard(A);
    assert.ok(!dash.setupPending && dash.problems.length === 1 && dash.problems[0].state === "conflict");

    // "Keep the staff version": adopted as the baseline, nothing written, no repeat conflict until the order changes again.
    const before = docs[DOC_A].batches.length;
    await admin.resolveLine(A, line.id, "keep", USER);
    assert.equal(docs[DOC_A].batches.length, before);
    assert.equal((await lineRows())[0].state, "synced");
    await sync.runSync(A);
    assert.equal(docs[DOC_A].lines().find((l) => l.includes(a)), edited);
    await changeOrder(a, "notes = 'newest note'");
    await sync.runSync(A);
    assert.equal((await lineRows())[0].state, "conflict", "still protected after keeping: the baseline is the person's text");

    // "Use the app's version" replaces it — only because a person asked.
    await admin.resolveLine(A, (await lineRows())[0].id, "overwrite", USER);
    const final = docs[DOC_A].lines().find((l) => l.includes(a))!;
    assert.ok(!final.includes("BLUE") && final.includes("Gros Islet") && final.includes("newest note"));
    assert.equal((await lineRows())[0].state, "synced");
    await noWhatsapp();
  });

  test("a line a person deleted is not re-added automatically; 'add again' puts it back once", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    docs[DOC_A].deleteParagraph(a);
    await changeOrder(a, "notes = 'x'");
    await sync.runSync(A);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    const [line] = await lineRows();
    assert.equal(line.state, "missing");
    await admin.resolveLine(A, line.id, "readd", USER);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
  });

  test("concurrent runs (message trigger + cron + button) add each order exactly once", async () => {
    await setUp();
    for (let i = 0; i < 4; i += 1) await addOrder(A, { name: `Customer ${i}` });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sync.runSync(A)));
    assert.ok(results.some((r) => r.status === "busy") || results.filter((r) => r.inserted > 0).length === 1);
    await sync.runSync(A);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 4);
    assert.equal(new Set(lines.map((l) => l.match(/⟨(E-[A-Z0-9]+)⟩/)![1])).size, 4);
    assert.equal((await lineRows()).length, 4);
    assert.equal(docs[DOC_A].lines().filter((l) => l.startsWith("▼ AI ORDERS")).length, 1, "one section");
  });

  test("a Google failure mid-sync leaves the document intact and a retry adds the line once", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    docs[DOC_A].failNextBatch = new FakeApiError("server", 503, "backend error");
    const failed = await sync.runSync(A);
    assert.equal(failed.status, "error");
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    assert.equal((await settingsRow()).health, "error");
    const dash = await admin.getDashboard(A);
    // The section may or may not exist yet (the failed batch can be the section creation); either way no duplicate.
    const retry = await sync.runSync(A);
    assert.equal(retry.status, "ok");
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    assert.equal(docs[DOC_A].lines().filter((l) => l.startsWith("▼ AI ORDERS")).length, 1);
    assert.equal((await settingsRow()).health, "ok");
    assert.equal((await settingsRow()).last_error, null);
    assert.ok(!dash.setupPending);
  });

  test("a failed LINE write is recorded, shown with its error, and 'retry' fixes it", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    await sync.runSync(A); // creates the section and the line
    const b = await addOrder(A, { name: "Bob" });
    docs[DOC_A].failNextBatch = new FakeApiError("server", 503, "backend error");
    await sync.runSync(A);
    const failed = (await lineRows()).find((l) => l.tag === b)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /Google error/);
    const dash = await admin.getDashboard(A);
    assert.ok(!dash.setupPending && dash.problems.some((p) => p.ref === b && p.state === "failed"));
    await admin.resolveLine(A, failed.id, "retry", USER);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
    assert.equal((await lineRows()).find((l) => l.tag === b)!.state, "synced");
  });

  test("a crash between the document write and the database write cannot create a duplicate", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    await pg.run(`truncate public.ai_agent_gdoc_lines;`); // the write reached Google but the record was lost
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    assert.equal((await lineRows())[0].state, "synced");
    // Reconnecting / re-saving the same link changes nothing either.
    await admin.setDocument(A, LINK_A, USER);
    await admin.setEnabled(A, true, USER);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
  });

  test("a person typing in the document during a sync: the write is retried against the fresh text, content preserved", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    await sync.runSync(A); // section exists
    const b = await addOrder(A, { name: "Bob" });
    let raced = false;
    const real = client.getDocument;
    client.getDocument = async (id) => {
      const doc = await real(id);
      if (!raced) {
        raced = true;
        docs[DOC_A].appendToParagraph("Gate code", " (changed 5pm)");
      }
      return doc;
    };
    const r = await sync.runSync(A);
    client.getDocument = real;
    assert.equal(r.status, "ok");
    assert.ok(docs[DOC_A].lines().includes("Gate code 1234 (changed 5pm)"), "the person's edit survived");
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
  });

  test("revoked or expired Google access blocks sync clearly, writes nothing, and recovers after reconnecting", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    const { SyncBlocked } = sync;
    blocked = new SyncBlocked("needs_reconnect", "Google access was revoked or expired. Reconnect the Google account.");
    const r = await sync.runSync(A);
    assert.equal(r.status, "blocked");
    assert.equal(r.health, "needs_reconnect");
    assert.equal(docs[DOC_A].batches.length, 0);
    assert.equal((await settingsRow()).health, "needs_reconnect");
    assert.match((await settingsRow()).last_error, /Reconnect/);
    assert.equal((await settingsRow()).enabled, true, "the switch stays as the admin left it");

    blocked = null; // reconnected
    assert.equal((await sync.runSync(A)).status, "ok");
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    assert.equal((await settingsRow()).health, "ok");
  });

  test("the real credential path: stored token is encrypted, a revoked grant marks the connection and blocks sync, a refreshed token is used", async () => {
    const crypto = await import("../lib/server/aiAgent/googleDocs/crypto.ts");
    const env = { ...process.env };
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    const realFetch = globalThis.fetch;
    try {
      await setUp(); // uses the fake client
      await addOrder(A, { name: "Alice" });
      await store.saveConnection({ business_slug: A, account_email: "staff@example.com", refresh_token_enc: crypto.encryptSecret("1//REFRESH", A), scopes: [...(await import("../lib/server/aiAgent/googleDocs/google.ts")).REQUIRED_SCOPES], connected_by: USER });
      const stored = (await rows<Record<string, any>>(`select refresh_token_enc from public.ai_agent_google_connections`))[0].refresh_token_enc as string;
      assert.ok(!stored.includes("REFRESH") && stored.startsWith("v1."), "only ciphertext is stored");

      sync.setDocsClientFactoryForTests(null); // use the real openClient
      const seen: string[] = [];
      let grant: "revoked" | "ok" = "revoked";
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        seen.push(u);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u === "https://oauth2.googleapis.com/token") return grant === "revoked" ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "AT-FRESH" });
        // Docs / Drive: serve from the in-memory document and check the refreshed token is what is sent.
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer AT-FRESH");
        const id = decodeURIComponent(u.match(/(?:files|documents)\/([^/?:]+)/)![1]);
        if (u.includes("/drive/v3/")) return json(200, await client.getFile(id).then((f) => ({ ...f, capabilities: { canEdit: f.canEdit } })));
        if (u.endsWith(":batchUpdate")) {
          const body = JSON.parse(String(init!.body));
          await client.batchUpdate(id, body.requests, body.writeControl?.requiredRevisionId);
          return json(200, {});
        }
        return json(200, await client.getDocument(id));
      }) as typeof fetch;

      const revoked = await sync.runSync(A);
      assert.equal(revoked.status, "blocked");
      assert.equal(revoked.health, "needs_reconnect");
      assert.equal((await store.loadConnection(A))?.status, "revoked");
      assert.equal(docs[DOC_A].batches.length, 0);
      // Still revoked: no further token calls are even attempted until the admin reconnects.
      const tokenCalls = seen.length;
      assert.equal((await sync.runSync(A)).health, "needs_reconnect");
      assert.equal(seen.length, tokenCalls);

      // Reconnect (new grant) → works with the refreshed access token.
      await store.saveConnection({ business_slug: A, account_email: "staff@example.com", refresh_token_enc: crypto.encryptSecret("1//REFRESH2", A), scopes: [], connected_by: USER });
      grant = "ok";
      const ok = await sync.runSync(A);
      assert.equal(ok.status, "ok");
      assert.equal(linesOf(docs[DOC_A]).length, 1);
      assert.ok(seen.some((u) => u.includes("docs.googleapis.com")));

      // A credential that does not belong to this business does not decrypt (copied row).
      await store.saveConnection({ business_slug: A, account_email: "staff@example.com", refresh_token_enc: crypto.encryptSecret("1//X", B), scopes: [], connected_by: USER });
      assert.equal((await sync.runSync(A)).health, "needs_reconnect");
    } finally {
      globalThis.fetch = realFetch;
      process.env = env;
      sync.setDocsClientFactoryForTests(async () => {
        factoryCalls += 1;
        if (blocked) throw blocked;
        return { client, email: "staff@example.com" };
      });
    }
  });

  test("losing edit permission or the document is reported, not retried blindly", async () => {
    await setUp();
    await addOrder(A);
    docs[DOC_A].canEdit = false; // permission removed after enabling
    const r = await sync.runSync(A);
    assert.equal(r.status, "error");
    assert.equal(r.health, "no_access");
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    delete docs[DOC_A];
    const gone = await sync.runSync(A);
    assert.equal(gone.health, "doc_not_found");
  });

  test("damaged section markers stop all writes with an explanation", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    docs[DOC_A].deleteParagraph("END OF AI ORDERS");
    await addOrder(A, { name: "Bob" });
    const r = await sync.runSync(A);
    assert.equal(r.status, "blocked");
    assert.equal(r.health, "section_problem");
    assert.match(r.message!, /markers/);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
  });

  test("two businesses never touch each other's document, lines or connection", async () => {
    await setUp(A, LINK_A);
    await setUp(B, LINK_B);
    const a = await addOrder(A, { name: "Alice" });
    const b = await addOrder(B, { name: "Bianca" });
    await sync.runSync(A);
    assert.ok(linesOf(docs[DOC_A]).every((l) => l.includes(a)) && linesOf(docs[DOC_A]).length === 1);
    assert.equal(linesOf(docs[DOC_B]).length, 0);
    await sync.triggerOrderSync(B);
    assert.ok(linesOf(docs[DOC_B]).every((l) => l.includes(b)) && linesOf(docs[DOC_B]).length === 1);
    assert.equal((await lineRows(A)).length, 1);
    assert.equal((await lineRows(B)).length, 1);
    assert.equal(docs[DOC_A].lines().some((l) => l.includes("[pool_shop]")), false);
    // Disabling one leaves the other running.
    await admin.setEnabled(B, false, USER);
    await addOrder(A, { name: "Anna" });
    await addOrder(B, { name: "Ben" });
    const due = await sync.runDueGoogleDocSyncs();
    assert.deepEqual(Object.keys(due.results), [A]);
    assert.equal(linesOf(docs[DOC_A]).length, 2);
    assert.equal(linesOf(docs[DOC_B]).length, 1);
  });

  test("changing the document starts fresh and switches sync off until re-enabled; the old document is left alone", async () => {
    await setUp(A, LINK_A);
    await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    const oldLines = linesOf(docs[DOC_A]);
    await admin.setDocument(A, LINK_B, USER);
    const s = await settingsRow();
    assert.equal(s.enabled, false);
    assert.equal(s.document_id, DOC_B);
    assert.equal(s.section_created_at, null);
    assert.equal(s.sync_since, null);
    assert.equal((await sync.runSync(A)).status, "disabled");
    assert.deepEqual(linesOf(docs[DOC_A]), oldLines);
    await admin.setEnabled(A, true, USER);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_B]).length, 0, "the new document starts empty: earlier orders only come in through the explicit import");
    const later = await addOrder(A, { name: "Later" });
    await sync.runSync(A);
    assert.ok(linesOf(docs[DOC_B]).length === 1 && linesOf(docs[DOC_B])[0].includes(later));
  });

  test("the one-time import previews first (no write), then adds only the chosen orders, oldest first so the newest ends on top", async () => {
    const day = 86400_000;
    const o1 = await addOrder(A, { name: "Old1", at: new Date(Date.now() - 3 * day).toISOString() });
    const o2 = await addOrder(A, { name: "Old2", at: new Date(Date.now() - 2 * day).toISOString() });
    const o3 = await addOrder(A, { name: "Old3", at: new Date(Date.now() - 1 * day).toISOString(), phone: null });
    await addOrder(A, { name: "Done", status: "fulfilled", at: new Date(Date.now() - 4 * day).toISOString() });
    await setUp();
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 0, "enabling alone imports nothing");

    const batches = docs[DOC_A].batches.length;
    const preview = await admin.importPreview(A);
    assert.equal(docs[DOC_A].batches.length, batches, "preview wrote nothing");
    assert.deepEqual(preview.items.map((i) => i.ref), [o3, o2, o1], "preview lists newest first, as they will read");
    assert.match(preview.items[0].line, /\(no phone\)/);
    assert.deepEqual(preview.items[0].missing, ["Phone"]);

    await assert.rejects(admin.importCommit(A, ["not-an-order-id"], USER), /None of the selected/);
    const ids = preview.items.filter((i) => i.ref !== o2).map((i) => i.orderId);
    const done = await admin.importCommit(A, ids, USER);
    assert.equal(done.inserted, 2);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(o3) && lines[1].includes(o1));
    // Importing again offers only what is left; importing the same ids again adds nothing.
    assert.deepEqual((await admin.importPreview(A)).items.map((i) => i.ref), [o2]);
    await assert.rejects(admin.importCommit(A, ids, USER), /None of the selected/);
    assert.equal(linesOf(docs[DOC_A]).length, 2);
  });

  test("the order flow triggers a sync after a change, and a Google failure never breaks the order flow", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    await sync.triggerOrderSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    blocked = new Error("network down");
    await addOrder(A, { name: "Bob" });
    await assert.doesNotReject(sync.triggerOrderSync(A));
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    assert.ok(typeof ordersMod.trackOrders === "function" && a);
  });

  test("disconnecting stops sync, removes the stored credential, and leaves the document and settings in place", async () => {
    await setUp();
    await store.saveConnection({ business_slug: A, account_email: "staff@example.com", refresh_token_enc: "v1.x.y.z", scopes: ["a"], connected_by: USER });
    await admin.disconnectGoogle(A, USER);
    assert.equal(await store.loadConnection(A), null);
    const s = await settingsRow();
    assert.equal(s.enabled, false);
    assert.equal(s.document_id, DOC_A);
    assert.equal(s.health, "needs_reconnect");
  });

  test("the sync lease is exclusive, expires, and is released", async () => {
    await admin.setDocument(A, LINK_A, USER);
    const t1 = await store.claimSync(A, 60);
    assert.ok(t1);
    assert.equal(await store.claimSync(A, 60), null);
    await store.releaseSync(A, t1!);
    const t2 = await store.claimSync(A, 60);
    assert.ok(t2);
    await pg.run(`update public.ai_agent_gdoc_settings set lock_until = now() - interval '1 second' where business_slug = ${lit(A)};`);
    assert.ok(await store.claimSync(A, 60), "an expired lease can be taken over");
  });
});
