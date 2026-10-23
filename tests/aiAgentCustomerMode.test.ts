// Per-customer AI handling modes (lib/aiAgent/customerMode.ts) and how they sit under the business-wide
// rules in evaluateGate(): a customer's mode only ever NARROWS what the business allows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerModeAllowsKind,
  effectiveCustomerMode,
  FALLBACK_CUSTOMER_MODE,
  modeAdjustedDecision,
} from "../lib/aiAgent/customerMode.ts";
import { type AgentSettings, canSendToCustomers, evaluateGate, type GateInput, outboxAllowed } from "../lib/aiAgent/engine.ts";

const GROUP = "120363000000000001@g.us";
const CHAT = "17585550101@s.whatsapp.net";

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  business_slug: "dog_food",
  enabled: true,
  mode: "assisted",
  contact_scope: "all",
  autonomy: 30,
  staff_group_jid: GROUP,
  staff_group_name: null,
  auto_takeover_minutes: 120,
  max_auto_replies_per_hour: 6,
  send_holding_reply: true,
  staff_notices_enabled: true,
  batching_enabled: false,
  batch_quiet_seconds: 45,
  batch_max_wait_seconds: 180,
  customer_memory_enabled: false,
  ...over,
});

const gate = (over: Partial<GateInput> = {}) =>
  evaluateGate({
    businessSlug: "dog_food",
    chatId: CHAT,
    fromMe: false,
    text: "Do you have 15kg bags?",
    hasMedia: false,
    settings: settings(),
    contactRule: null,
    conversation: null,
    staffActiveAt: null,
    now: new Date("2026-10-23T12:00:00Z"),
    ...over,
  });

test("existing customers and businesses default to Staff First; nothing silently becomes Auto-Reply", () => {
  assert.equal(FALLBACK_CUSTOMER_MODE, "staff_first");
  assert.equal(effectiveCustomerMode(null, null), "staff_first");
  assert.equal(effectiveCustomerMode(settings(), null), "staff_first");
  assert.equal(effectiveCustomerMode(settings({ default_customer_mode: null }), { customer_mode: null }), "staff_first");
  // Garbage in storage fails to the safe mode, never to Auto-Reply.
  assert.equal(effectiveCustomerMode(settings({ default_customer_mode: "turbo" as never }), { customer_mode: "also-bad" }), "staff_first");
});

test("the customer's own mode beats the business default; the default applies otherwise", () => {
  const s = settings({ default_customer_mode: "manual_only" });
  assert.equal(effectiveCustomerMode(s, { customer_mode: "auto_reply" }), "auto_reply");
  assert.equal(effectiveCustomerMode(s, { customer_mode: null }), "manual_only");
  assert.equal(effectiveCustomerMode(settings({ default_customer_mode: "auto_reply" }), null), "auto_reply");
});

test("only the autonomous customer kinds depend on the mode", () => {
  for (const kind of ["customer_reply", "holding_reply"]) {
    assert.equal(customerModeAllowsKind("auto_reply", kind), true, kind);
    assert.equal(customerModeAllowsKind("staff_first", kind), false, kind);
    assert.equal(customerModeAllowsKind("manual_only", kind), false, kind);
  }
  // A person's explicit send and the staff-group kinds are governed elsewhere.
  for (const mode of ["auto_reply", "staff_first", "manual_only"] as const) {
    for (const kind of ["staff_relay", "staff_notice", "staff_draft", "staff_feedback"]) assert.equal(customerModeAllowsKind(mode, kind), true, `${mode}/${kind}`);
  }
});

test("Auto-Reply keeps the engine's decision; Staff First turns replies into escalations; Manual Only does nothing", () => {
  for (const d of ["REPLY", "ASK", "ESCALATE"] as const) assert.equal(modeAdjustedDecision("auto_reply", d, { noActionNeeded: false }), d);
  assert.equal(modeAdjustedDecision("staff_first", "REPLY", { noActionNeeded: false }), "ESCALATE");
  assert.equal(modeAdjustedDecision("staff_first", "ASK", { noActionNeeded: false }), "ESCALATE");
  assert.equal(modeAdjustedDecision("staff_first", "ESCALATE", { noActionNeeded: false }), "ESCALATE");
  // Small talk needs no staff action even in Staff First.
  assert.equal(modeAdjustedDecision("staff_first", "REPLY", { noActionNeeded: true }), "NO_REPLY");
  for (const d of ["REPLY", "ASK", "ESCALATE"] as const) assert.equal(modeAdjustedDecision("manual_only", d, { noActionNeeded: false }), "NO_REPLY");
});

// ── The gate: global rules first, the customer's mode last ──────────────────

test("Manual Only stops the message with no reply and no escalation", () => {
  const g = gate({ conversation: { control: "ai", human_until: null, customer_mode: "manual_only" } });
  assert.deepEqual(g, { pass: false, decision: "NO_REPLY", reasons: ["customer_mode_manual_only"] });
  // The business default counts the same.
  assert.equal(gate({ settings: settings({ default_customer_mode: "manual_only" }) }).pass, false);
  // Media-only messages too (they would otherwise escalate as unsupported media).
  assert.equal(gate({ text: "", hasMedia: true, conversation: { control: "ai", human_until: null, customer_mode: "manual_only" } }).pass, false);
});

test("Auto-Reply and Staff First pass the gate", () => {
  for (const customer_mode of ["auto_reply", "staff_first", null] as const) {
    assert.equal(gate({ conversation: { control: "ai", human_until: null, customer_mode } }).pass, true, String(customer_mode));
  }
});

test("global rules beat the customer's mode: kill switch, contact rules, takeover, recent staff activity", () => {
  const auto = { control: "ai" as const, human_until: null, customer_mode: "auto_reply" as const };
  assert.deepEqual(gate({ settings: settings({ enabled: false }), conversation: auto }), { pass: false, decision: "NO_REPLY", reasons: ["agent_disabled"] });
  assert.deepEqual(gate({ contactRule: "exclude", conversation: auto }), { pass: false, decision: "NO_REPLY", reasons: ["contact_excluded"] });
  assert.deepEqual(gate({ settings: settings({ contact_scope: "none" }), conversation: auto }), { pass: false, decision: "NO_REPLY", reasons: ["contact_not_permitted"] });
  assert.equal(gate({ settings: settings({ contact_scope: "selected" }), contactRule: null, conversation: auto }).pass, false);
  assert.deepEqual(gate({ conversation: { ...auto, control: "human" } }), { pass: false, decision: "HUMAN", reasons: ["human_takeover"] });
  assert.deepEqual(gate({ conversation: auto, staffActiveAt: "2026-10-23T11:30:00Z" }), { pass: false, decision: "HUMAN", reasons: ["staff_recently_active"] });
});

test("Observe mode prohibits customer-bound sends whatever the customer's mode", () => {
  const observe = settings({ mode: "observe" });
  assert.equal(canSendToCustomers(observe), false);
  for (const kind of ["customer_reply", "holding_reply", "staff_relay"]) {
    assert.equal(outboxAllowed(observe, { kind, toJid: CHAT }), false, kind);
  }
  // Auto-Reply passes the gate in Observe (decisions are recorded) but nothing it produces can be sent.
  assert.equal(gate({ settings: observe, conversation: { control: "ai", human_until: null, customer_mode: "auto_reply" } }).pass, true);
});

// ── Source-level guards (the orchestration needs a live database; these pin what must not regress) ──

import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(p, "utf8");

test("autonomous customer messages are only built behind BOTH the business and the customer mode", () => {
  const decide = read("lib/server/aiAgent/decide.ts");
  assert.match(decide, /const sendable = canSend\(settings\) && p\.customerMode === "auto_reply";/);
  assert.match(decide, /customerModeAllowsKind\(p\.customerMode, o\.kind\)/);
});

test("staff notices and updates have one writer, behind the mode gate and the atomic post", () => {
  const decide = read("lib/server/aiAgent/decide.ts");
  const fn = decide.slice(decide.indexOf("async function notifyStaff"), decide.indexOf("// ── Batching"));
  const gateAt = fn.indexOf("outboxAllowed(settings");
  const postAt = fn.indexOf("postEscalationNotice(");
  assert.ok(gateAt > 0 && postAt > gateAt, "outboxAllowed must run before the notice is posted");
  assert.equal(/kind: "staff_notice"/.test(decide.slice(0, decide.indexOf("async function notifyStaff"))), false, "no other code builds staff_notice items");
});

test("the update logic is timer-free and pure", () => {
  for (const f of ["lib/aiAgent/escalationUpdates.ts", "lib/aiAgent/customerMode.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /\bsetTimeout\s*\(|\bsetInterval\s*\(/, f);
    assert.doesNotMatch(src, /from "@\/lib\/server|supabase|fetch\(/, f);
  }
});
