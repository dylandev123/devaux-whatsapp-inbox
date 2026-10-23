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
  needsFirstNotice,
  priorNoticeHold,
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

test("Observe: a follow-up with unknown notice history stays suppressed", () => {
  assert.equal(staffNoticeSkipReason(settings(), true), "notice_already_open");
});

test("Observe: a follow-up never posts a second notice once one was delivered", () => {
  const prior = [{ status: "sent", error: null }];
  assert.equal(staffNoticeSkipReason(settings(), true, prior), "notice_already_sent");
  assert.equal(needsFirstNotice(true, prior), false);
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

// ── Regression: escalation opened while notices were off ────────────────────
//
// Order message escalates with staff_notices_enabled=false (no notice row at
// all). Notices are then enabled; the next message is a follow-up on the open
// escalation and must send the escalation's first notice.

test("regression: notices enabled after an escalation opened → next message sends its first notice", () => {
  const off = settings({ staff_notices_enabled: false });
  assert.equal(staffNoticeSkipReason(off, false, []), "staff_notices_disabled"); // first message
  const on = settings();
  assert.equal(staffNoticeSkipReason(on, true, []), null);
  assert.equal(needsFirstNotice(true, []), true);
  // Rendered as the original escalation (same ref), not a "Follow-up".
  const text = buildStaffNotice({
    refCode: "AAAAA",
    priority: "high",
    customerLabel: "Jane",
    reasons: ["order_request"],
    customerMessage: "I want 2 bags",
    draftReply: null,
    orderRequest: null,
    followUp: !needsFirstNotice(true, []),
    observeOnly: true,
  });
  assert.match(text, /AI escalation #AAAAA/);
  assert.doesNotMatch(text, /Follow-up/);
  assert.match(text, /nothing is sent to the customer/);
});

test("regression: that first notice goes only to the staff group, never the customer", () => {
  const on = settings();
  assert.equal(outboxAllowed(on, { kind: "staff_notice", toJid: GROUP }), true);
  assert.equal(outboxAllowed(on, { kind: "staff_notice", toJid: CUSTOMER }), false);
  assert.equal(outboxAllowed(on, { kind: "holding_reply", toJid: CUSTOMER }), false);
  assert.equal(outboxAllowed(on, { kind: "customer_reply", toJid: CUSTOMER }), false);
});

test("once that notice is pending or in flight, the next message does not queue another", () => {
  for (const status of ["pending", "dispatched"]) {
    assert.equal(staffNoticeSkipReason(settings(), true, [{ status, error: null }]), "notice_in_flight", status);
  }
});

test("provably-unsent prior notices may be re-sent; ambiguous or unknown ones never", () => {
  const ok = ["staff_notices_disabled", "observe_mode", "bridge_send_disabled", "agent_disabled", "not_sent: socket closed"];
  for (const error of ok) {
    assert.equal(priorNoticeHold([{ status: "failed", error }]), null, error);
  }
  const held = ["held_after_unknown_send", "session_disconnected", "something_new: ???", ""];
  for (const error of held) {
    assert.equal(priorNoticeHold([{ status: "failed", error }]), "notice_send_unconfirmed", error);
  }
  assert.equal(priorNoticeHold([{ status: "failed", error: null }]), "notice_send_unconfirmed");
  assert.equal(priorNoticeHold([{ status: "mystery", error: null }]), "notice_send_unconfirmed");
  // A delivered notice wins over any earlier blocked one.
  assert.equal(
    priorNoticeHold([{ status: "failed", error: "observe_mode" }, { status: "sent", error: null }]),
    "notice_already_sent"
  );
});

test("a failed-then-blocked notice does not stop the first notice after notices are enabled", () => {
  const prior = [{ status: "failed", error: "staff_notices_disabled" }];
  assert.equal(staffNoticeSkipReason(settings(), true, prior), null);
});

test("Assisted follow-ups are unchanged", () => {
  assert.equal(staffNoticeSkipReason(settings({ mode: "assisted" }), true, [{ status: "sent", error: null }]), null);
});
