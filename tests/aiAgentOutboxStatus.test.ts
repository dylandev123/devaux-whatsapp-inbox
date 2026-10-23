// Unit tests for how the admin UI classifies ai_agent_outbox rows
// (lib/aiAgent/outboxStatus.ts). Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLOCK_REASONS,
  failureReason,
  outboxState,
  UNRESOLVED_AFTER_MS,
} from "../lib/aiAgent/outboxStatus.ts";

const NOW = new Date("2026-10-22T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const row = (status: string, fields: { error?: string | null; dispatched_at?: string | null; created_at?: string } = {}) => ({
  status,
  error: fields.error ?? null,
  dispatched_at: fields.dispatched_at ?? null,
  created_at: fields.created_at ?? ago(60_000),
});

test("pending and sent pass through unchanged", () => {
  assert.equal(outboxState(row("pending", { created_at: ago(86_400_000) }), NOW), "pending");
  assert.equal(outboxState(row("sent"), NOW), "sent");
});

test("policy reason codes are blocked, not failed", () => {
  for (const code of ["observe_mode", "bridge_send_disabled", "agent_disabled", "human_takeover", "superseded_by_newer_message", "chat_rate_limited"]) {
    assert.equal(outboxState(row("failed", { error: code }), NOW), "blocked", code);
  }
});

test("real send failures stay failed", () => {
  for (const error of ["not_sent: WhatsApp session dog_food is not connected", "session_disconnected", "bridge_config_unavailable", "invalid_body", "not_staff_group", "invalid_recipient", "invalid_outbox_item"]) {
    assert.equal(outboxState(row("failed", { error }), NOW), "failed", error);
  }
});

test("unknown, empty or free-text errors are never hidden as blocked", () => {
  assert.equal(outboxState(row("failed", { error: null }), NOW), "failed");
  assert.equal(outboxState(row("failed", { error: "" }), NOW), "failed");
  assert.equal(outboxState(row("failed", { error: "some_new_bridge_code" }), NOW), "failed");
  assert.equal(outboxState(row("failed", { error: "Error: observe_mode" }), NOW), "failed");
});

test("a recent dispatched item is in flight; an old one is unresolved", () => {
  assert.equal(outboxState(row("dispatched", { dispatched_at: ago(30_000) }), NOW), "dispatched");
  assert.equal(outboxState(row("dispatched", { dispatched_at: ago(UNRESOLVED_AFTER_MS - 1) }), NOW), "dispatched");
  assert.equal(outboxState(row("dispatched", { dispatched_at: ago(UNRESOLVED_AFTER_MS) }), NOW), "unresolved");
});

test("dispatched falls back to created_at, and an unparseable time is unresolved", () => {
  assert.equal(outboxState(row("dispatched", { created_at: ago(UNRESOLVED_AFTER_MS * 2) }), NOW), "unresolved");
  assert.equal(outboxState(row("dispatched", { dispatched_at: "not a date" }), NOW), "unresolved");
});

test("a status outside the contract is shown as unresolved", () => {
  assert.equal(outboxState(row("unknown"), NOW), "unresolved");
});

test("failureReason takes the code before the first colon", () => {
  assert.equal(failureReason("not_sent: socket closed"), "not_sent");
  assert.equal(failureReason("observe_mode"), "observe_mode");
  assert.equal(failureReason("  "), null);
  assert.equal(failureReason(null), null);
});

test("every blocked reason is documented in the bridge contract", () => {
  const contract = readFileSync(new URL("../docs/ai-agent-bridge-contract.md", import.meta.url), "utf8");
  for (const code of BLOCK_REASONS) assert.ok(contract.includes(`\`${code}\``), `${code} missing from the contract`);
});
