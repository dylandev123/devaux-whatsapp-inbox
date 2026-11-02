// Google Docs order sync (append-only at the top), end to end: the app's REAL server code (admin actions → sync engine →
// store) against the REAL migrations in a throwaway Postgres, with an in-memory Google Doc standing in for Google. Proves:
// nothing is written while disabled, the access test and normal sync never download the document, enabling lists only NEW
// orders, existing content and later order changes are never touched, retries / concurrency / lost answers / crashes never
// duplicate a line, Google failures are reported and retried, revoked access blocks cleanly, businesses are isolated, historical
// orders are never modified, and no WhatsApp message is ever queued. Skips itself when no Postgres binaries are installed.

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

function snapshotDoc(doc: FakeGoogleDoc) {
  return JSON.parse(JSON.stringify(doc.paragraphs())) as ReturnType<FakeGoogleDoc["paragraphs"]>;
}

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
/** Make the in-flight attempts old enough to be judged (the settle period is two minutes). */
const ageAttempts = () => pg.run(`update public.ai_agent_gdoc_lines set attempt_started_at = now() - interval '10 minutes', last_verify_at = null;`);
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

  test("the migrations are idempotent, keep credentials away from dashboard roles, and the claim function is service-role only", async () => {
    for (const f of ["20261112000000_ai_agent_google_docs_sync.sql", "20261113000000_ai_agent_gdocs_append_only.sql"]) {
      const sql = readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
      await pg.run(sql);
      await pg.run(sql);
    }
    assert.equal(await pg.run(`select has_table_privilege('authenticated', 'public.ai_agent_google_connections', 'select');`), "f");
    assert.equal(await pg.run(`select has_table_privilege('anon', 'public.ai_agent_gdoc_lines', 'select');`), "f");
    assert.equal(await pg.run(`select has_table_privilege('authenticated', 'public.ai_agent_gdoc_settings', 'select');`), "t");
    assert.equal(await pg.run(`select has_function_privilege('authenticated', 'public.claim_gdoc_sync(text,text,integer)', 'execute');`), "f");
    assert.equal(await pg.run(`select has_function_privilege('authenticated', 'public.claim_gdoc_line(text,text,uuid,text,uuid)', 'execute');`), "f");
    assert.equal(await pg.run(`select has_function_privilege('service_role', 'public.claim_gdoc_line(text,text,uuid,text,uuid)', 'execute');`), "t");
    // The new states are accepted, an invented one is not.
    await pg.run(`insert into public.ai_agent_gdoc_settings (business_slug) values ('x') on conflict do nothing;`);
    await assert.rejects(pg.run(`insert into public.ai_agent_gdoc_lines (business_slug, document_id, order_id, tag, state) values ('x','d','${"0".repeat(8)}-0000-0000-0000-000000000001','E-X','bogus');`));
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

  test("the access test uses Drive metadata and an API probe only: it never downloads the document, even one too large to download", async () => {
    docs[DOC_A] = new FakeGoogleDoc("Orders book", Array.from({ length: 4000 }, (_, i) => ({ text: `Order ${i} ${"x".repeat(60)}` })));
    docs[DOC_A].maxReadableChars = 1000; // any body download would time out
    const report = await admin.setDocument(A, LINK_A, USER);
    assert.deepEqual([report.title, report.canEdit, report.account, report.docsApi], ["Orders book", true, "staff@example.com", true]);
    assert.deepEqual([...new Set(client.calls.map((c) => c.split(":")[0]))].sort(), ["getFile", "probeDocsApi"]);
    assert.equal(docs[DOC_A].textReads, 0);
    assert.equal(docs[DOC_A].batches.length, 0, "no write");
    const again = await admin.testStoredDocument(A);
    assert.equal(again.account, "staff@example.com");
    assert.equal(docs[DOC_A].textReads, 0);
    assert.equal((await settingsRow()).enabled, false);
  });

  test("access test failures are told apart: timeout (504), network, Docs API off, missing scope, not found, no edit access, not a Doc", async () => {
    const withFailure = (patch: Record<string, unknown>) => (client = { ...fakeClient(docs), ...patch } as never);
    withFailure({ getFile: async () => { throw new GoogleApiError("timeout", 0, "x", [], "Drive metadata"); } });
    const t = await admin.setDocument(A, LINK_A, USER).catch((e: any) => e);
    assert.equal(t.status, 504);
    assert.match(t.message, /too long.*Drive metadata timed out.*try again/i);
    withFailure({ getFile: async () => { throw new GoogleApiError("network", 0, "x", [], "Drive metadata"); } });
    const n = await admin.setDocument(A, LINK_A, USER).catch((e: any) => e);
    assert.equal(n.status, 400);
    assert.match(n.message, /Could not reach Google.*Drive metadata/);
    withFailure({ probeDocsApi: async () => { throw new GoogleApiError("api_disabled", 403, "off", ["SERVICE_DISABLED"], "Docs API check"); } });
    assert.match((await admin.setDocument(A, LINK_A, USER).catch((e: any) => e)).message, /Docs or Google Drive API is not enabled/);
    withFailure({ probeDocsApi: async () => { throw new GoogleApiError("insufficient_scope", 403, "scope", [], "Docs API check"); } });
    assert.match((await admin.setDocument(A, LINK_A, USER).catch((e: any) => e)).message, /missing a required permission/);
    withFailure({ probeDocsApi: async () => { throw new GoogleApiError("timeout", 0, "x", [], "Docs API check"); } });
    assert.match((await admin.setDocument(A, LINK_A, USER).catch((e: any) => e)).message, /Docs API check timed out/);
    client = fakeClient(docs);
    await assert.rejects(admin.setDocument(A, `https://docs.google.com/document/d/${"z".repeat(30)}/edit`, USER), /cannot find this document/);
    await assert.rejects(admin.setDocument(A, "https://example.com/x", USER), /Only docs\.google\.com/);
    docs[DOC_A].mimeType = "application/vnd.google-apps.spreadsheet";
    await assert.rejects(admin.setDocument(A, LINK_A, USER), /not a Google Docs document/);
    docs[DOC_A].mimeType = "application/vnd.google-apps.document";
    docs[DOC_A].trashed = true;
    await assert.rejects(admin.setDocument(A, LINK_A, USER), /in the trash/);
    docs[DOC_A].trashed = false;
    assert.equal((await settingsRow())?.document_id ?? null, null, "a failed test saves no document");
    docs[DOC_A].canEdit = false;
    await admin.setDocument(A, LINK_A, USER);
    await assert.rejects(admin.setEnabled(A, true, USER), /only view/);
    assert.equal((await settingsRow()).enabled, false);
    await noWhatsapp();
  });

  test("enabling lists only NEW orders: the existing outstanding ones wait for the explicit import, and enabling writes nothing", async () => {
    const old = await addOrder(A, { ref: "E-OLD01", at: new Date(Date.now() - 3 * 86400_000).toISOString() });
    await admin.setDocument(A, LINK_A, USER);
    const before = snapshotDoc(docs[DOC_A]);
    await admin.setEnabled(A, true, USER);
    assert.equal(docs[DOC_A].batches.length, 0, "enabling does not write by itself");
    const fresh = await addOrder(A, { ref: "E-NEW01", name: "Jane" });

    const r = await sync.runSync(A);
    assert.equal(r.status, "ok");
    assert.equal(r.inserted, 1);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`⟨${fresh}⟩`) && !lines.some((l) => l.includes(old)));
    assert.match(lines[0], /^Jane — \+1758555\d+ — Rodney Bay — 2 × Chicken ⟨E-NEW01⟩$/);
    assert.equal(docs[DOC_A].lines()[0], lines[0], "the new line is the very first paragraph of the document");
    assert.deepEqual(docs[DOC_A].paragraphs().slice(1), before, "every existing paragraph is still there, in order, with its styles");
    assert.equal(docs[DOC_A].textReads, 0, "no document download on the normal path");
    assert.deepEqual([...new Set(client.calls.map((c) => c.split(":")[0]))].sort(), ["batchUpdate", "getFile", "probeDocsApi"]);
    assert.equal((await store.loadGdocSettings(A))?.health, "ok");
    await noWhatsapp();
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
    assert.equal(docs[DOC_A].lines()[3], "DELIVERIES");

    const batches = docs[DOC_A].batches.length;
    const again = await sync.runSync(A);
    assert.deepEqual([again.inserted, again.confirmed, again.unconfirmed, again.failed], [0, 0, 0, 0]);
    assert.equal(docs[DOC_A].batches.length, batches, "no document write on a no-op run");
    assert.equal((await lineRows()).length, 3);
    assert.ok((await lineRows()).every((l) => l.state === "synced" && l.attempts === 1));
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

  test("append-only: later order changes, completion, cancellation and staff edits or deletions never touch an inserted line", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice", address: "Rodney Bay" });
    const b = await addOrder(A, { name: "Bob" });
    const c = await addOrder(A, { name: "Cara" });
    const d = await addOrder(A, { name: "Dina" });
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 4);

    docs[DOC_A].appendToParagraph(a, " — gate is BLUE, call first");
    docs[DOC_A].deleteParagraph(d);
    const staffView = docs[DOC_A].lines();
    const batches = docs[DOC_A].batches.length;

    await changeOrder(a, "delivery_address = 'Gros Islet', notes = 'changed'");
    await changeOrder(b, "status = 'fulfilled'");
    await changeOrder(c, "status = 'cancelled'");
    for (let i = 0; i < 3; i += 1) assert.equal((await sync.runSync(A)).inserted, 0);
    assert.deepEqual(docs[DOC_A].lines(), staffView, "the document is exactly as staff left it");
    assert.equal(docs[DOC_A].batches.length, batches, "no write at all");
    assert.equal(docs[DOC_A].textReads, 0, "and the document was never read");
    assert.ok((await lineRows()).every((l) => l.state === "synced"), "a deleted line is not re-added, nothing is flagged");
    await noWhatsapp();
  });

  test("a format change affects lines added from now on only", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    const first = docs[DOC_A].lines()[0];
    await admin.saveConfig(A, { format: { fields: [{ key: "name", enabled: true }, { key: "items", enabled: true }], separator: " | ", placeholders: true } }, USER);
    await addOrder(A, { name: "Bob" });
    await sync.runSync(A);
    assert.match(docs[DOC_A].lines()[0], /^Bob \| 2 × Chicken ⟨E-/);
    assert.equal(docs[DOC_A].lines()[1], first, "the earlier line is untouched");
  });

  test("historical orders are never modified by sync, and only orders created after activation are inserted", async () => {
    const day = 86400_000;
    for (let i = 0; i < 5; i += 1) await addOrder(A, { at: new Date(Date.now() - (i + 2) * day).toISOString(), status: i % 2 ? "fulfilled" : "confirmed" });
    const digest = () => pg.run(`select md5(coalesce(json_agg(o order by id)::text, '')) from public.ai_agent_orders o;`);
    const before = await digest();
    await setUp();
    await sync.runSync(A);
    await sync.runDueGoogleDocSyncs();
    await sync.triggerOrderSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    assert.equal(await digest(), before, "not a single order column changed");
    assert.equal((await lineRows()).length, 0);
    // Off and on again: orders created while it was off are history too.
    await admin.setEnabled(A, false, USER);
    await addOrder(A, { name: "WhileOff" });
    await new Promise((r) => r(null));
    await admin.setEnabled(A, true, USER);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 0, "an order created while sync was off needs the explicit import");
    const live = await addOrder(A, { name: "Live", at: new Date(Date.now() + 5000).toISOString() });
    await sync.runSync(A);
    assert.ok(linesOf(docs[DOC_A]).length === 1 && linesOf(docs[DOC_A])[0].includes(live));
  });

  test("concurrent runs (message trigger + cron + button) add each order exactly once", async () => {
    await setUp();
    for (let i = 0; i < 4; i += 1) await addOrder(A, { name: `Customer ${i}` });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => (i % 2 ? sync.runSync(A) : sync.triggerOrderSync(A).then(() => sync.runSync(A)))));
    assert.ok(results.some((r) => r.status === "busy") || results.filter((r) => r.inserted > 0).length === 1);
    await sync.runSync(A);
    const lines = linesOf(docs[DOC_A]);
    assert.equal(lines.length, 4);
    assert.equal(new Set(lines.map((l) => l.match(/⟨(E-[A-Z0-9]+)⟩/)![1])).size, 4);
    assert.equal((await lineRows()).length, 4);
  });

  test("even with no lease at all, the database lets only ONE caller start an insert for an order", async () => {
    await setUp();
    const ref = await addOrder(A, { name: "Alice" });
    const [order] = await sync.ordersByIds(A, (await rows<{ id: string }>(`select id from public.ai_agent_orders where ref_code = ${lit(ref)}`)).map((r) => r.id));
    const claims = await Promise.all(Array.from({ length: 12 }, () => store.claimLine(A, DOC_A, order, crypto.randomUUID())));
    assert.equal(claims.filter(Boolean).length, 1, "exactly one winner");
    assert.equal((await lineRows()).length, 1);
    assert.equal((await lineRows())[0].state, "inserting");
    // While that attempt is open nobody can claim it again, and a run (which does not hold that attempt) writes nothing.
    assert.equal(await store.claimLine(A, DOC_A, order, crypto.randomUUID()), false);
    const r = await sync.runSync(A);
    assert.equal(r.inserted, 0);
    assert.equal(linesOf(docs[DOC_A]).length, 0);
  });

  test("two real runs racing on the same order (lease bypassed) still write it once", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    await pg.run(`update public.ai_agent_gdoc_settings set lock_until = null;`);
    // Make the first writer slow so the second reaches the claim while the first is mid-write.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = client.batchUpdate;
    let first = true;
    client.batchUpdate = async (...args) => {
      if (first) {
        first = false;
        await gate;
      }
      return real.apply(client, args);
    };
    const slow = sync.runSync(A);
    await new Promise((r) => setImmediate(r));
    await pg.run(`update public.ai_agent_gdoc_settings set lock_until = null, lock_token = null;`); // a second run gets in
    const fast = await sync.runSync(A);
    assert.equal(fast.inserted, 0, "the second run does not write the order the first one owns");
    release();
    const done = await slow;
    client.batchUpdate = real;
    assert.equal(done.inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
  });

  test("Google refuses the write (403): nothing changes, the failure is shown, the backoff holds automatic retries, and a later run adds the line once", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    docs[DOC_A].failNextBatch = new FakeApiError("forbidden", 403, "The caller does not have permission");
    const failed = await sync.runSync(A);
    assert.equal(failed.status, "error");
    assert.equal(failed.health, "no_access");
    assert.equal(failed.failed, 1);
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    assert.equal((await settingsRow()).health, "no_access");
    const [row] = await lineRows();
    assert.equal(row.state, "failed", "a refusal proves the document is unchanged → safe to retry");
    assert.match(row.last_error, /permission/);
    const dash = await admin.getDashboard(A);
    assert.ok(!dash.setupPending && dash.problems.length === 1 && dash.problems[0].state === "failed" && dash.problems[0].ref === a);

    // The cron tick and order triggers wait out the backoff after a failure …
    assert.equal((await sync.runSync(A, { backoff: true })).status, "waiting");
    assert.equal(docs[DOC_A].batches.length, 0);
    // … and a retry once the backoff has passed (or a person pressing the button) puts it in exactly once.
    await pg.run(`update public.ai_agent_gdoc_settings set last_attempt_at = now() - interval '10 minutes';`);
    const retry = await sync.runSync(A, { backoff: true });
    assert.equal(retry.status, "ok");
    assert.equal(retry.inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    const [after] = await lineRows();
    assert.deepEqual([after.state, after.attempts], ["synced", 2]);
    assert.equal((await settingsRow()).health, "ok");
    assert.equal((await settingsRow()).last_error, null);
  });

  test("Google fails with a 5xx BEFORE applying: the outcome is unknown, so the order is not re-sent blindly; after the settle period it is checked, found absent, and added once", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    docs[DOC_A].failNextBatch = new FakeApiError("server", 503, "backend error");
    const r = await sync.runSync(A);
    assert.equal(r.status, "error");
    assert.equal(r.unconfirmed, 1);
    assert.equal((await lineRows())[0].state, "unconfirmed");
    // Immediately afterwards (inside the settle period) nothing is re-sent and the document is not even read.
    const again = await sync.runSync(A);
    assert.equal(again.inserted, 0);
    assert.equal(docs[DOC_A].batches.length, 0);
    assert.equal(docs[DOC_A].textReads, 0, "no verification read inside the settle period");
    // After the settle period the app looks for the order's tag; it is absent, so the attempt is declared failed and retried.
    await ageAttempts();
    const fixed = await sync.runSync(A);
    assert.equal(docs[DOC_A].textReads, 1, "one text-only verification read");
    assert.equal(fixed.status, "ok");
    assert.equal(fixed.inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    assert.equal((await lineRows())[0].state, "synced");
  });

  test("the answer to a write is LOST after Google applied it (timeout): the order is never added twice — the tag is found and it is simply marked done", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    docs[DOC_A].applyThenFail = new FakeApiError("timeout", 0, "the answer never arrived");
    const lost = await sync.runSync(A);
    assert.equal(lost.status, "error");
    assert.match(lost.message!, /took too long/);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1, "Google did apply it");
    assert.equal((await lineRows())[0].state, "unconfirmed");
    // Retrying inside the settle period does nothing.
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);

    await ageAttempts();
    const settled = await sync.runSync(A);
    assert.equal(settled.confirmed, 1);
    assert.equal(settled.inserted, 0);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1, "still exactly one line");
    assert.equal((await lineRows())[0].state, "synced");
    assert.equal((await settingsRow()).health, "ok");
    for (let i = 0; i < 3; i += 1) await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
  });

  test("when the document is too large to verify, an unknown line is never guessed: it stays for a person, who picks 'it is there', 'add it again' or 'leave it out'", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    const b = await addOrder(A, { name: "Bob", at: new Date(Date.now() + 1000).toISOString() });
    const c = await addOrder(A, { name: "Cara", at: new Date(Date.now() + 2000).toISOString() });
    docs[DOC_A].applyThenFail = new FakeApiError("timeout", 0, "lost");
    await sync.runSync(A); // Alice is written but unrecorded; the run stops there
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    docs[DOC_A].maxReadableChars = 10; // verification reads now time out
    await ageAttempts();
    const stuck = await sync.runSync(A);
    assert.equal(stuck.unconfirmed, 1);
    assert.equal(stuck.inserted, 2, "the other orders are not held up");
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1, "Alice is not added again");
    const [stuckRow] = (await lineRows()).filter((l) => l.tag === a);
    assert.equal([stuckRow.state, stuckRow.verify_attempts].join(), "unconfirmed,1");

    const dash = await admin.getDashboard(A);
    assert.ok(!dash.setupPending && dash.problems.length === 1 && dash.problems[0].state === "unconfirmed" && dash.problems[0].ref === a);
    assert.match(dash.problems[0].reason, /may or may not/);

    // The automatic cooldown holds further downloads …
    const reads = docs[DOC_A].textReads;
    await sync.runSync(A);
    assert.equal(docs[DOC_A].textReads, reads);
    // … and a person settles it. "It is there":
    await admin.resolveLine(A, stuckRow.id, "present", USER);
    assert.equal((await lineRows()).find((l) => l.tag === a)!.state, "synced");
    assert.equal(linesOf(docs[DOC_A]).length, 3);

    // "Add it again" (the person checked and it is not there): written once, then settled.
    docs[DOC_A].deleteParagraph(b);
    await pg.run(`update public.ai_agent_gdoc_lines set state = 'unconfirmed' where tag = ${lit(b)};`);
    const rowB = (await lineRows()).find((l) => l.tag === b)!;
    const res = (await admin.resolveLine(A, rowB.id, "again", USER)) as { inserted: number };
    assert.equal(res.inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
    assert.equal((await lineRows()).find((l) => l.tag === b)!.state, "synced");

    // "Leave it out".
    await pg.run(`update public.ai_agent_gdoc_lines set state = 'unconfirmed' where tag = ${lit(c)};`);
    await admin.resolveLine(A, (await lineRows()).find((l) => l.tag === c)!.id, "skip", USER);
    assert.equal((await lineRows()).find((l) => l.tag === c)!.state, "skipped");
    const lengthNow = linesOf(docs[DOC_A]).length;
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, lengthNow);
    await assert.rejects(admin.resolveLine(A, (await lineRows()).find((l) => l.tag === a)!.id, "skip", USER), /already settled/);
  });

  test("a verification that cannot reach the document counts its tries and is left to a person after the limit", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    docs[DOC_A].applyThenFail = new FakeApiError("timeout", 0, "lost");
    await sync.runSync(A);
    docs[DOC_A].maxReadableChars = 10;
    for (let i = 0; i < 9; i += 1) {
      await ageAttempts();
      await sync.runSync(A);
    }
    const [row] = await lineRows();
    assert.equal(row.state, "unconfirmed");
    assert.equal(row.verify_attempts, sync.MAX_VERIFY_ATTEMPTS, "stops downloading the document after the limit");
    assert.equal(docs[DOC_A].textReads, sync.MAX_VERIFY_ATTEMPTS);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    // The "Retry now" button still tries once more.
    docs[DOC_A].maxReadableChars = null;
    await ageAttempts();
    const manual = await admin.retryNow(A);
    assert.equal(manual.confirmed, 1);
    assert.equal((await lineRows())[0].state, "synced");
  });

  test("CRASH after Google applied the write but before the database recorded it: the next run finds the tag and does not add a second line", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    // What a process death at that instant leaves behind: the line is in the document, the row still says 'inserting'.
    await pg.run(`update public.ai_agent_gdoc_lines set state = 'inserting', last_text = null, last_synced_at = null;`);
    await ageAttempts();
    const next = await sync.runSync(A);
    assert.equal(next.confirmed, 1);
    assert.equal(next.inserted, 0);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    assert.equal((await lineRows())[0].state, "synced");
    // Until it is old enough to judge, the row is left alone (it may be a live run's attempt).
    await pg.run(`update public.ai_agent_gdoc_lines set state = 'inserting', attempt_started_at = now();`);
    assert.equal((await sync.runSync(A)).confirmed, 0);
    assert.equal(docs[DOC_A].textReads, 1);
  });

  test("CRASH after claiming but before the write reached Google: the next run finds no tag and writes the line once", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    const [order] = await sync.ordersByIds(A, (await rows<{ id: string }>(`select id from public.ai_agent_orders where ref_code = ${lit(a)}`)).map((r) => r.id));
    assert.equal(await store.claimLine(A, DOC_A, order, crypto.randomUUID()), true); // the dying run's claim
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    assert.equal((await sync.runSync(A)).inserted, 0, "inside the settle period it stays untouched");
    await ageAttempts();
    const r = await sync.runSync(A);
    assert.equal(r.inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(a)).length, 1);
    const [row] = await lineRows();
    assert.equal([row.state, row.attempts].join(), "synced,2");
  });

  test("the database blips right after Google's write: recording is retried at once; if it keeps failing the line is still found later, never duplicated", async () => {
    await setUp();
    const real = pgSupabase(pg);
    let failSyncedUpdates = 0;
    const failing: any = new Proxy({}, { get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "db down" } }) : () => failing) });
    dbmod.setAgentDbForTests({
      ...real,
      from: (table: string) => {
        const q: any = (real as any).from(table);
        if (table !== "ai_agent_gdoc_lines") return q;
        const update = q.update.bind(q);
        q.update = (patch: Record<string, unknown>) => (patch.state === "synced" && failSyncedUpdates > 0 ? (failSyncedUpdates--, failing) : update(patch));
        return q;
      },
      rpc: (...args: unknown[]) => (real as any).rpc(...args),
    } as never);
    try {
      // Two failed attempts are absorbed by the immediate retries.
      const a = await addOrder(A, { name: "Alice", at: new Date(Date.now() + 1000).toISOString() });
      failSyncedUpdates = 2;
      const ok = await sync.runSync(A);
      assert.equal(ok.inserted, 1);
      assert.equal((await lineRows()).find((l) => l.tag === a)!.state, "synced");

      // Three failures: the write happened, the record did not. The run reports it; nothing else is written.
      const b = await addOrder(A, { name: "Bob", at: new Date(Date.now() + 2000).toISOString() });
      failSyncedUpdates = 3;
      const bad = await sync.runSync(A);
      assert.equal(bad.status, "error");
      assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
      assert.equal((await lineRows()).find((l) => l.tag === b)!.state, "inserting");
      await sync.runSync(A);
      assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1, "not re-sent");
      await ageAttempts();
      const healed = await sync.runSync(A);
      assert.equal(healed.confirmed, 1);
      assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
      assert.equal((await lineRows()).find((l) => l.tag === b)!.state, "synced");
    } finally {
      dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    }
  });

  test("if Google refuses the styling requests the bare line is still inserted; a document that cannot take text at the top is reported, not worked around", async () => {
    await setUp();
    const a = await addOrder(A, { name: "Alice" });
    const real = client.batchUpdate;
    let seen = 0;
    client.batchUpdate = async (id, requests, t) => {
      seen += 1;
      if (requests.length > 1) throw new GoogleApiError("bad_request", 400, "Invalid requests[3].updateTextStyle", [], "Docs write");
      return real.call(client, id, requests, t);
    };
    assert.equal((await sync.runSync(A)).inserted, 1);
    assert.equal(seen, 2, "styled attempt, then the bare insert");
    assert.equal(docs[DOC_A].lines()[0].includes(a), true);
    client.batchUpdate = real;

    const b = await addOrder(A, { name: "Bob", at: new Date(Date.now() + 1000).toISOString() });
    docs[DOC_A].startsWithTable = true;
    const refused = await sync.runSync(A);
    assert.equal(refused.status, "error");
    assert.equal(refused.health, "document_problem");
    assert.match(refused.message!, /very start of the first tab.*table.*empty paragraph/);
    assert.equal((await lineRows()).find((l) => l.tag === b)!.state, "failed");
    docs[DOC_A].startsWithTable = false; // staff fix the top of the document
    await pg.run(`update public.ai_agent_gdoc_settings set last_attempt_at = now() - interval '10 minutes';`);
    assert.equal((await sync.runSync(A, { backoff: true })).inserted, 1);
    assert.equal(linesOf(docs[DOC_A]).filter((l) => l.includes(b)).length, 1);
  });

  test("Google calls stay out of the order flow: orders.ts never awaits the sync, and a down Google never breaks it", async () => {
    const source = readFileSync(join(process.cwd(), "lib/server/aiAgent/orders.ts"), "utf8");
    assert.doesNotMatch(source, /await\s+triggerOrderSync/);
    assert.equal((source.match(/void triggerOrderSync\(/g) ?? []).length, 2);
    await setUp();
    await addOrder(A, { name: "Alice" });
    await sync.triggerOrderSync(A);
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    blocked = new Error("network down");
    await addOrder(A, { name: "Bob" });
    await assert.doesNotReject(sync.triggerOrderSync(A));
    assert.equal(linesOf(docs[DOC_A]).length, 1);
    // The cron tick is the retry mechanism: once Google is back (and the backoff has passed) the order goes in.
    blocked = null;
    await pg.run(`update public.ai_agent_gdoc_settings set last_attempt_at = now() - interval '10 minutes';`);
    const due = await sync.runDueGoogleDocSyncs();
    assert.deepEqual(due.results, { [A]: "ok" });
    assert.equal(linesOf(docs[DOC_A]).length, 2);
    const slow = await sync.runDueGoogleDocSyncs(10, 1_000);
    assert.equal(slow.businesses, 0, "no time left in the cron function → Google is not started");
  });

  test("revoked or expired Google access blocks sync clearly, writes nothing, and recovers after reconnecting", async () => {
    await setUp();
    await addOrder(A, { name: "Alice" });
    blocked = new sync.SyncBlocked("needs_reconnect", "Google access was revoked or expired. Reconnect the Google account.");
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

  test("the real credential path: stored token is encrypted, a revoked grant marks the connection and blocks sync, a refreshed token is used, and no document is downloaded", async () => {
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
      const seen: { url: string; method: string }[] = [];
      let grant: "revoked" | "ok" = "revoked";
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        seen.push({ url: u, method: init?.method ?? "GET" });
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u === "https://oauth2.googleapis.com/token") return grant === "revoked" ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "AT-FRESH" });
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer AT-FRESH");
        const id = decodeURIComponent(u.match(/(?:files|documents)\/([^/?:]+)/)![1]);
        if (u.includes("/drive/v3/")) return json(200, await client.getFile(id).then((f) => ({ ...f, capabilities: { canEdit: f.canEdit } })));
        if (id === "devaux-docs-api-availability-check") return json(404, { error: { message: "Requested entity was not found.", status: "NOT_FOUND" } });
        if (u.includes(":batchUpdate")) {
          await client.batchUpdate(id, JSON.parse(String(init!.body)).requests);
          return json(200, {});
        }
        throw new Error(`unexpected Google call ${u}`);
      }) as typeof fetch;

      const revoked = await sync.runSync(A);
      assert.equal(revoked.status, "blocked");
      assert.equal(revoked.health, "needs_reconnect");
      assert.equal((await store.loadConnection(A))?.status, "revoked");
      assert.equal(docs[DOC_A].batches.length, 0);
      const tokenCalls = seen.length;
      assert.equal((await sync.runSync(A)).health, "needs_reconnect");
      assert.equal(seen.length, tokenCalls, "no further token calls until the admin reconnects");

      await store.saveConnection({ business_slug: A, account_email: "staff@example.com", refresh_token_enc: crypto.encryptSecret("1//REFRESH2", A), scopes: [], connected_by: USER });
      grant = "ok";
      const ok = await sync.runSync(A);
      assert.equal(ok.status, "ok");
      assert.equal(linesOf(docs[DOC_A]).length, 1);
      assert.ok(seen.some((c) => c.url.includes(":batchUpdate") && c.method === "POST"));
      assert.ok(!seen.some((c) => c.url.includes("docs.googleapis.com") && c.method === "GET"), "a normal sync makes no Docs GET");
      const access = await admin.testStoredDocument(A);
      assert.equal(access.docsApi, true);
      assert.ok(seen.filter((c) => c.url.includes("docs.googleapis.com") && c.method === "GET").every((c) => c.url.includes("devaux-docs-api-availability-check")), "the only Docs GET is the availability probe");

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
    const a = await addOrder(A);
    docs[DOC_A].canEdit = false; // permission removed after enabling
    const r = await sync.runSync(A);
    assert.equal(r.status, "error");
    assert.equal(r.health, "no_access");
    assert.equal(linesOf(docs[DOC_A]).length, 0);
    assert.equal((await lineRows()).find((l) => l.tag === a)!.state, "failed");
    delete docs[DOC_A];
    const gone = await sync.runSync(A);
    assert.equal(gone.health, "doc_not_found");
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
    assert.equal(s.sync_since, null);
    assert.equal((await sync.runSync(A)).status, "disabled");
    assert.deepEqual(linesOf(docs[DOC_A]), oldLines);
    await admin.setEnabled(A, true, USER);
    await sync.runSync(A);
    assert.equal(linesOf(docs[DOC_B]).length, 0, "the new document starts empty: earlier orders only come in through the explicit import");
    const later = await addOrder(A, { name: "Later", at: new Date(Date.now() + 5000).toISOString() });
    await sync.runSync(A);
    assert.ok(linesOf(docs[DOC_B]).length === 1 && linesOf(docs[DOC_B])[0].includes(later));
  });

  test("the one-time import previews first (no write, no read), then adds only the chosen orders, oldest first so the newest ends on top", async () => {
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
    assert.equal(docs[DOC_A].textReads, 0);
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
    assert.deepEqual((await admin.importPreview(A)).items.map((i) => i.ref), [o2]);
    await assert.rejects(admin.importCommit(A, ids, USER), /None of the selected/);
    assert.equal(linesOf(docs[DOC_A]).length, 2);
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
