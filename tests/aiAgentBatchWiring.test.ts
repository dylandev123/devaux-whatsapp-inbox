// Source-level guards for the batch path. The orchestration in
// lib/server/aiAgent/decide.ts needs a live Supabase, so these pin the
// properties that must never regress: no in-memory timers, Observe-mode
// filtering on the batch path, customer-bound items only behind canSend, and
// batch results delivered through the mode-checked outbox claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const decide = read("lib/server/aiAgent/decide.ts");

function body(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? undefined : end);
}

test("no in-memory timers anywhere in the scheduling or decision code", () => {
  const files = [
    "lib/aiAgent/batching.ts",
    "lib/aiAgent/memory.ts",
    "lib/server/aiAgent/batches.ts",
    "lib/server/aiAgent/decide.ts",
    "lib/server/aiAgent/scheduler.ts",
    "app/api/cron/ai-agent/batches/route.ts",
    ...readdirSync(join(process.cwd(), "lib/server/aiAgent")).map((f) => `lib/server/aiAgent/${f}`),
  ];
  for (const f of new Set(files)) assert.doesNotMatch(read(f), /\bsetTimeout\s*\(|\bsetInterval\s*\(/, `${f} must not use timers`);
});

test("the batch worker filters its outbox through outboxAllowed and enqueues as pending", () => {
  const worker = body(decide, "async function processClaimedBatch", "export interface BatchRunSummary");
  const filterAt = worker.indexOf("outboxAllowed(settings");
  const enqueueAt = worker.indexOf("await enqueue(");
  assert.ok(filterAt > 0 && enqueueAt > filterAt, "outboxAllowed must run before enqueue");
  assert.match(worker, /await enqueue\([\s\S]*?, false\)/, "batch results are 'pending', never handed out inline");
});

test("settings are re-read when a batch is processed, so a switched-off business sends nothing", () => {
  const worker = body(decide, "async function processClaimedBatch", "export interface BatchRunSummary");
  assert.match(worker, /await loadSettings\(batch\.business_slug\)/);
  assert.match(worker, /!settings\?\.enabled/);
});

test("customer-bound outbox items are only created behind canSend (Assisted mode)", () => {
  const turn = body(decide, "async function handleCustomerTurn", "// ── Batching");
  for (const kind of ["holding_reply", "customer_reply"]) {
    const at = turn.indexOf(`kind: "${kind}"`);
    assert.ok(at > 0, kind);
    const guardAt = Math.max(turn.lastIndexOf("sendable", at));
    assert.ok(guardAt > 0 && at - guardAt < 600, `${kind} must sit behind the sendable check`);
  }
});

test("the live path batches only when batching is active, and queued messages return nothing to send", () => {
  assert.match(decide, /else if \(batchingActive\(settings\)\)/);
  assert.match(decide, /if \(outcome\.batched\) \{\s*return \{ eventId, status: "done", decision: null, reasons: outcome\.reasons, outbox: \[\] \}/);
});

test("a manual staff message is handled immediately, never queued behind a batch", () => {
  const live = body(decide, "export async function processBridgeMessage", "// An enabled business's message");
  const staffAt = live.indexOf("handleManualStaffMessage(input, settings, eventId)");
  const batchAt = live.indexOf("handleBatchedCustomerMessage");
  assert.ok(staffAt > 0 && batchAt > staffAt, "the fromMe branch is decided before the customer batching branch");
});

test("the outbox claim re-checks the mode in SQL and the scheduler piggybacks on the bridge poll", () => {
  const sql = read("supabase/migrations/20261024000000_ai_agent_observe_staff_notices.sql");
  assert.match(sql, /p\.kind = 'staff_notice' and p\.to_jid = s\.staff_group_jid/);
  assert.match(read("app/api/bridge/ai-agent/outbox/claim/route.ts"), /sweepBatchesAfterResponse\(\)/);
  assert.match(read("app/api/cron/ai-agent/batches/route.ts"), /processDueBatches/);
});

test("batching defaults are safe: off, with 45 s quiet and 180 s maximum", () => {
  const sql = read("supabase/migrations/20261025000000_ai_agent_batching_memory.sql");
  assert.match(sql, /batching_enabled boolean not null default false/);
  assert.match(sql, /batch_quiet_seconds integer not null default 45/);
  assert.match(sql, /batch_max_wait_seconds integer not null default 180/);
  assert.match(sql, /customer_memory_enabled boolean not null default false/);
});
