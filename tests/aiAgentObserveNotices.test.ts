// Observe-mode staff notices: the send policy in lib/aiAgent/engine.ts.
// Observe may post staff_notice (only) to the staff group when the business
// has staff_notices_enabled; it never produces a customer-bound item. The
// DB-backed wiring in decide.ts routes every outbox item through
// outboxAllowed() and decides notices with staffNoticeSkipReason(), so these
// pure tests pin the rules both rely on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentSettings,
  buildStaffNotice,
  canSendStaffNotice,
  canSendToCustomers,
  isCustomerBoundKind,
  matchStaffReply,
  outboxAllowed,
  staffNoticeSkipReason,
} from "../lib/aiAgent/engine.ts";

const GROUP = "120363000000000001@g.us";
const OTHER_GROUP = "120363000000000002@g.us";
const CUSTOMER = "17585551234@s.whatsapp.net";

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  business_slug: "dog_food",
  enabled: true,
  mode: "observe",
  contact_scope: "all",
  autonomy: 30,
  staff_group_jid: GROUP,
  staff_group_name: null,
  auto_takeover_minutes: 120,
  max_auto_replies_per_hour: 6,
  send_holding_reply: true,
  staff_notices_enabled: true,
  ...over,
});

const ALL_KINDS = ["customer_reply", "holding_reply", "staff_relay", "staff_notice", "staff_feedback", "something_new"];

// ── Observe-mode staff notices ──────────────────────────────────────────────

test("Observe + staff notices on + group: a first notice is allowed", () => {
  assert.equal(canSendStaffNotice(settings()), true);
  assert.equal(staffNoticeSkipReason(settings(), false), null);
  assert.equal(outboxAllowed(settings(), { kind: "staff_notice", toJid: GROUP }), true);
});

test("staff notices default OFF: Observe sends nothing until enabled", () => {
  const off = settings({ staff_notices_enabled: false });
  assert.equal(canSendStaffNotice(off), false);
  assert.equal(staffNoticeSkipReason(off, false), "staff_notices_disabled");
  assert.equal(outboxAllowed(off, { kind: "staff_notice", toJid: GROUP }), false);
});

test("no staff group: escalation is recorded, no WhatsApp send is attempted", () => {
  const none = settings({ staff_group_jid: null });
  assert.equal(canSendStaffNotice(none), false);
  assert.equal(staffNoticeSkipReason(none, false), "no_staff_group");
  assert.equal(outboxAllowed(none, { kind: "staff_notice", toJid: GROUP }), false);
});

test("a disabled business sends nothing in any mode", () => {
  for (const mode of ["observe", "assisted"] as const) {
    const off = settings({ enabled: false, mode });
    assert.equal(canSendStaffNotice(off), false);
    for (const kind of ALL_KINDS) assert.equal(outboxAllowed(off, { kind, toJid: GROUP }), false, `${mode}/${kind}`);
  }
  assert.equal(outboxAllowed(null, { kind: "staff_notice", toJid: GROUP }), false);
});

// ── Customer-send prohibition ───────────────────────────────────────────────

test("Observe never allows a customer-bound item, whatever the flags", () => {
  const s = settings();
  assert.equal(canSendToCustomers(s), false);
  for (const kind of ALL_KINDS.filter((k) => k !== "staff_notice")) {
    assert.equal(outboxAllowed(s, { kind, toJid: CUSTOMER }), false, `${kind} → customer`);
    assert.equal(outboxAllowed(s, { kind, toJid: GROUP }), false, `${kind} → group`);
  }
  // A staff_notice addressed to a customer chat is refused too.
  assert.equal(outboxAllowed(s, { kind: "staff_notice", toJid: CUSTOMER }), false);
});

test("staff_notice and staff_feedback are staff-group kinds; everything else is customer-bound", () => {
  assert.equal(isCustomerBoundKind("staff_notice"), false);
  assert.equal(isCustomerBoundKind("staff_feedback"), false);
  for (const k of ["customer_reply", "holding_reply", "staff_relay", "something_new"]) assert.equal(isCustomerBoundKind(k), true, k);
});

test("Assisted mode is unchanged: every kind allowed, notices need only a group", () => {
  const a = settings({ mode: "assisted", staff_notices_enabled: false });
  assert.equal(canSendToCustomers(a), true);
  assert.equal(canSendStaffNotice(a), true);
  for (const kind of ALL_KINDS) assert.equal(outboxAllowed(a, { kind, toJid: CUSTOMER }), true, kind);
});

// ── Duplicate prevention ────────────────────────────────────────────────────

test("Observe: a follow-up on an open escalation never posts a second notice", () => {
  assert.equal(staffNoticeSkipReason(settings(), true), "notice_already_open");
});

test("Assisted keeps its follow-up notices", () => {
  assert.equal(staffNoticeSkipReason(settings({ mode: "assisted" }), true), null);
});

// ── Cross-business isolation ────────────────────────────────────────────────

test("a notice may only go to this business's own staff group", () => {
  const dog = settings({ business_slug: "dog_food", staff_group_jid: GROUP });
  assert.equal(outboxAllowed(dog, { kind: "staff_notice", toJid: OTHER_GROUP }), false);
  const bySea = settings({ business_slug: "by_sea", staff_group_jid: OTHER_GROUP, staff_notices_enabled: false });
  // by_sea's flag is off even though dog_food's is on.
  assert.equal(canSendStaffNotice(bySea), false);
  assert.equal(outboxAllowed(bySea, { kind: "staff_notice", toJid: OTHER_GROUP }), false);
  assert.equal(canSendStaffNotice(dog), true);
});

test("a staff reply quoting another business's escalation is not matched", () => {
  // matchCandidates() loads candidates per business, so another business's
  // notice id never appears in the candidate list: the reply is unmatched.
  const mine: { id: string; ref_code: string; notice_message_id: string | null; status: "notified" }[] = [
    { id: "e1", ref_code: "AAAAA", notice_message_id: "WA-1", status: "notified" },
  ];
  assert.equal(matchStaffReply({ text: "Yes, Tuesday", quotedMessageId: "WA-OTHER-BUSINESS" }, mine).kind, "unmatched");
  // Another business's #code finds no candidate in this business at all.
  assert.equal(matchStaffReply({ text: "Yes #E-7K3QX", quotedMessageId: null }, []).kind, "unknown_ref");
});

// ── Staff replies ───────────────────────────────────────────────────────────

test("a quoted staff reply to an Observe notice is matched as an answer to record", () => {
  const cands = [{ id: "e1", ref_code: "AAAAA", notice_message_id: "WA-1", status: "notified" as const }];
  const m = matchStaffReply({ text: "We deliver Tuesdays", quotedMessageId: "WA-1" }, cands);
  assert.equal(m.kind, "matched");
  if (m.kind === "matched") {
    assert.equal(m.command, "send");
    assert.equal(m.body, "We deliver Tuesdays");
  }
  // Recording only: in Observe, applyStaffAction() queues no staff_relay
  // (canSendToCustomers is false) and outboxAllowed() would drop one anyway.
  assert.equal(outboxAllowed(settings(), { kind: "staff_relay", toJid: CUSTOMER }), false);
  // Staff-group chatter is not answered either (staff_feedback is Assisted-only).
  assert.equal(outboxAllowed(settings(), { kind: "staff_feedback", toJid: GROUP }), false);
});

// ── Notice wording ──────────────────────────────────────────────────────────

test("the Observe notice says nothing is sent to the customer", () => {
  const base = {
    refCode: "AAAAA",
    priority: "high" as const,
    customerLabel: "Jane · 17585551234",
    reasons: ["complaint"],
    customerMessage: "The bag arrived torn",
    draftReply: "So sorry!",
    orderRequest: null,
    followUp: false,
  };
  const observe = buildStaffNotice({ ...base, observeOnly: true });
  assert.match(observe, /Observe mode: nothing is sent to the customer/);
  assert.match(observe, /AI draft \(NOT sent\)/);
  assert.doesNotMatch(observe, /exact text to send the customer/);
  const assisted = buildStaffNotice(base);
  assert.match(assisted, /exact text to send the customer/);
});
