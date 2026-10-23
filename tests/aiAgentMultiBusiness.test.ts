// Multi-business behaviour of the AI agent's pure layers: per-business
// gating, default-OFF, exact-JID permissions, cross-business escalation
// protection and the business selector's data. DB-backed isolation (the
// business_slug filters) is covered for the pickers in
// tests/aiAgentChatDirectory.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentSettings,
  DEFAULT_AGENT_SETTINGS,
  evaluateGate,
  type GateInput,
  isValidBusinessSlug,
  matchStaffReply,
  type MatchableEscalation,
} from "../lib/aiAgent/engine.ts";
import { buildBusinessList, connectionOf } from "../lib/aiAgent/businessList.ts";

const NOW = new Date("2026-10-23T12:00:00Z");
const settingsFor = (slug: string, over: Partial<AgentSettings> = {}): AgentSettings => ({
  business_slug: slug,
  enabled: true,
  mode: "assisted",
  contact_scope: "selected",
  autonomy: 30,
  staff_group_jid: "120363000000000000@g.us",
  staff_group_name: null,
  auto_takeover_minutes: 120,
  max_auto_replies_per_hour: 6,
  send_holding_reply: true,
  ...over,
});
const gate = (slug: string, settings: AgentSettings | null, over: Partial<GateInput> = {}) =>
  evaluateGate({
    businessSlug: slug,
    chatId: "17585551234@s.whatsapp.net",
    fromMe: false,
    text: "hi",
    hasMedia: false,
    settings,
    contactRule: "allow",
    conversation: null,
    staffActiveAt: null,
    now: NOW,
    ...over,
  });

// ── No restriction to Dog Food; default OFF ─────────────────────────────────

test("any well-formed business can run the agent once explicitly enabled", () => {
  for (const slug of ["dog_food", "by_sea", "cool_pool", "candock", "supplify", "new_biz_2"]) {
    assert.equal(gate(slug, settingsFor(slug)).pass, true, slug);
  }
});

test("a business with no settings row, or the column defaults, never replies", () => {
  assert.deepEqual(DEFAULT_AGENT_SETTINGS, { enabled: false, mode: "observe", contact_scope: "none" });
  assert.deepEqual(gate("by_sea", null), { pass: false, decision: "NO_REPLY", reasons: ["agent_disabled"] });
  const fresh = settingsFor("by_sea", { ...DEFAULT_AGENT_SETTINGS });
  assert.deepEqual(gate("by_sea", fresh), { pass: false, decision: "NO_REPLY", reasons: ["agent_disabled"] });
  // Even if someone flips only the master switch, scope none still blocks every contact.
  const onlyEnabled = settingsFor("by_sea", { ...DEFAULT_AGENT_SETTINGS, enabled: true });
  assert.deepEqual(gate("by_sea", onlyEnabled), { pass: false, decision: "NO_REPLY", reasons: ["contact_not_permitted"] });
});

test("enabling one business does not enable another", () => {
  const dog = settingsFor("dog_food");
  assert.equal(gate("dog_food", dog).pass, true);
  // The by_sea message arrives while only dog_food has an enabled row loaded.
  assert.equal(gate("by_sea", dog).pass, false);
  assert.deepEqual(gate("by_sea", dog), { pass: false, decision: "NO_REPLY", reasons: ["business_mismatch"] });
  assert.equal(gate("by_sea", settingsFor("by_sea", { enabled: false })).pass, false);
});

test("slug validation", () => {
  assert.ok(isValidBusinessSlug("by_sea"));
  assert.ok(isValidBusinessSlug("biz_9"));
  for (const bad of ["", "By Sea", "by-sea", "by_sea ", "a/b", "x".repeat(65)]) assert.ok(!isValidBusinessSlug(bad), bad);
});

test("disabled business gate result is independent of its contact scope or takeover state", () => {
  const off = settingsFor("candock", { enabled: false, contact_scope: "all" });
  assert.deepEqual(gate("candock", off, { contactRule: null }), { pass: false, decision: "NO_REPLY", reasons: ["agent_disabled"] });
});

// ── Exact-JID permissions ───────────────────────────────────────────────────

test("selected scope: an allow rule applies to its exact JID only", () => {
  const s = settingsFor("by_sea");
  // The rule table is keyed by exact chat_id; the route looks up (business, chatId)
  // and passes the matching rule — a different JID arrives with no rule.
  assert.equal(gate("by_sea", s, { chatId: "17585551234@s.whatsapp.net", contactRule: "allow" }).pass, true);
  assert.equal(gate("by_sea", s, { chatId: "917585551234@s.whatsapp.net", contactRule: null }).pass, false);
  assert.equal(gate("by_sea", s, { chatId: "98765432100@lid", contactRule: null }).pass, false);
});

test("an exclude rule beats scope all; groups and broadcasts never pass", () => {
  const s = settingsFor("by_sea", { contact_scope: "all" });
  assert.equal(gate("by_sea", s, { contactRule: null }).pass, true);
  assert.equal(gate("by_sea", s, { contactRule: "exclude" }).pass, false);
  assert.equal(gate("by_sea", s, { chatId: "120363000000000009@g.us", contactRule: null }).pass, false);
  assert.equal(gate("by_sea", s, { chatId: "status@broadcast", contactRule: null }).pass, false);
});

test("safeguards persist per business: human takeover and fromMe still stop the agent", () => {
  const s = settingsFor("by_sea");
  const held = gate("by_sea", s, { conversation: { control: "human", human_until: null } });
  assert.equal(held.pass, false);
  assert.equal(gate("by_sea", s, { fromMe: true }).pass, false);
});

// ── Cross-business escalation protection ────────────────────────────────────

test("a ref code from another business is not among this business's candidates and relays nothing", () => {
  // Candidates are loaded with .eq(business_slug); a #E- code that exists only
  // in another business therefore never appears here.
  const seaCandidates: MatchableEscalation[] = [];
  const result = matchStaffReply({ text: "#E-7K3QX yes we deliver", quotedMessageId: null }, seaCandidates);
  assert.equal(result.kind, "unknown_ref");
});

test("a quoted notice from another business does not match this business's escalation", () => {
  const dogEscalation: MatchableEscalation = { id: "1", ref_code: "E-AAAA1", notice_message_id: "NOTICE-DOG", status: "notified" };
  // by_sea's candidate list excludes dog_food's escalation, so the quote matches nothing.
  assert.equal(matchStaffReply({ text: "Sure", quotedMessageId: "NOTICE-DOG" }, []).kind, "unmatched");
  // Sanity: with the right business's candidates the same quote does match.
  assert.equal(matchStaffReply({ text: "Sure", quotedMessageId: "NOTICE-DOG" }, [dogEscalation]).kind, "matched");
});

// ── Business selector data ──────────────────────────────────────────────────

const BUSINESSES = [
  { business_slug: "dog_food", display_name: "Dog Food St. Lucia" },
  { business_slug: "by_sea", display_name: "By Sea Tours" },
  { business_slug: "cool_pool", display_name: "Cool & Pool Products" },
];

test("selector lists connected accounts with ON/OFF; unconfigured ones read OFF/observe/none", () => {
  const list = buildBusinessList(
    BUSINESSES,
    [
      { businessSlug: "dog_food", status: "open" },
      { businessSlug: "by_sea", status: "qr" },
    ],
    [{ business_slug: "dog_food", enabled: true, mode: "observe", contact_scope: "selected" }]
  );
  assert.deepEqual(list.map((b) => b.businessSlug), ["by_sea", "dog_food"]); // cool_pool: no session, no settings
  const dog = list.find((b) => b.businessSlug === "dog_food")!;
  assert.deepEqual([dog.connection, dog.enabled, dog.mode, dog.contactScope], ["connected", true, "observe", "selected"]);
  const sea = list.find((b) => b.businessSlug === "by_sea")!;
  assert.deepEqual([sea.connection, sea.enabled, sea.mode, sea.contactScope, sea.configured], ["disconnected", false, "observe", "none", false]);
});

test("selector keeps a configured business listed even when its session is gone; unknown sessions list everyone", () => {
  const cfg = [{ business_slug: "cool_pool", enabled: false, mode: "observe" as const, contact_scope: "none" as const }];
  assert.ok(buildBusinessList(BUSINESSES, [], cfg).some((b) => b.businessSlug === "cool_pool"));
  const unknown = buildBusinessList(BUSINESSES, null, []);
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((b) => b.connection === "unknown" && !b.enabled));
});

test("connectionOf", () => {
  assert.equal(connectionOf("open"), "connected");
  assert.equal(connectionOf("CONNECTED"), "connected");
  assert.equal(connectionOf("qr"), "disconnected");
  assert.equal(connectionOf(null), "disconnected");
});
