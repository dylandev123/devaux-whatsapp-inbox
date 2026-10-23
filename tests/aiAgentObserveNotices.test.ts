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
  batching_enabled: false,
  batch_quiet_seconds: 45,
  batch_max_wait_seconds: 180,
  customer_memory_enabled: false,
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
    assert.equal(m.command, "answer");
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
  assert.doesNotMatch(observe, /sent only when you reply "send"/);
  const assisted = buildStaffNotice(base);
  assert.match(assisted, /sent only when you reply "send"/);
  assert.doesNotMatch(assisted, /exact text to send the customer/);
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

// ── Staff notice content ────────────────────────────────────────────────────

import { appendCustomerMessage, categorizeRequest, customerMessageSegments } from "../lib/aiAgent/engine.ts";

const SEP = "\n---\n";
const notice = (over: Partial<Parameters<typeof buildStaffNotice>[0]> = {}) =>
  buildStaffNotice({
    refCode: "E-ZTK57",
    priority: "high",
    customerLabel: "Jane · 17585551234",
    reasons: ["order_approval"],
    customerMessage: "I want dog food",
    draftReply: null,
    orderRequest: null,
    followUp: false,
    observeOnly: true,
    ...over,
  });

test("notice: repeated customer messages are shown once", () => {
  const text = notice({ customerMessage: ["Hi", "I need 2 bags", "i need 2 bags!", "I need 2 bags", "Hello"].join(SEP) });
  assert.equal(text.match(/I need 2 bags/gi)?.length, 1);
  assert.doesNotMatch(text, /• Hi$/m);
  assert.doesNotMatch(text, /---/);
  assert.equal(appendCustomerMessage("I need 2 bags", "  i need 2 BAGS "), "I need 2 bags");
  assert.deepEqual(customerMessageSegments(["Hi", "Hi"].join(SEP)), ["Hi"]);
});

test("notice: several product enquiries become separate short points, capped", () => {
  const msgs = ["Price of puppy food?", "Do you have 15kg adult?", "Is the lamb one in stock?", "And the senior kind?", "What about treats?", "Thanks"];
  const text = notice({ reasons: ["unverified_answer"], customerMessage: msgs.join(SEP), intent: "question" });
  assert.match(text, /📦 Product enquiry/);
  assert.match(text, /• Price of puppy food\?/);
  assert.match(text, /• What about treats\?/);
  assert.match(text, /\+1 more message/);
  assert.doesNotMatch(text, /Do you have 15kg adult/); // omitted middle message
});

test("notice: the summary replaces the first message, later messages are kept", () => {
  const text = notice({
    summary: "Wants to order 3 bags of adult food",
    customerMessage: ["asdf long rambling first message", "Delivery on Friday please"].join(SEP),
  });
  assert.match(text, /• Wants to order 3 bags of adult food/);
  assert.match(text, /• Delivery on Friday please/);
  assert.doesNotMatch(text, /rambling/);
});

test("notice: incomplete order lists exactly what is missing and invents nothing", () => {
  const text = notice({
    customerMessage: "2 bags of adult 15kg",
    orderRequest: { items: [{ product: "Adult 15kg", quantity: null }], delivery_address: null, delivery_preference: "Friday", notes: null },
    reasons: ["collecting_order_details"],
  });
  assert.match(text, /🛒 New order/);
  assert.match(text, /Adult 15kg — qty not given/);
  assert.match(text, /Delivery: Friday/);
  assert.match(text, /Missing: Quantity for each product/);
  assert.match(text, /Missing: Delivery address/);
  assert.doesNotMatch(text, /Missing: Delivery day/);
  assert.match(text, /NOT confirmed/);
  assert.doesNotMatch(text, /Address:/);
  assert.doesNotMatch(text, /[$€]|EC\$|price:/i);
});

test("notice: complete order asks staff to confirm; no order data at all asks for everything", () => {
  const done = notice({
    orderRequest: { items: [{ product: "Adult 15kg", quantity: "2" }], delivery_address: "Castries", delivery_preference: "Sat", notes: null },
  });
  assert.match(done, /Check availability and price/);
  assert.doesNotMatch(done, /Missing:/);
  const none = notice({ intent: "order", customerMessage: "I'd like to order" });
  assert.match(none, /Order details were not captured/);
});

test("notice: a stale AI draft is dropped once the customer has written again", () => {
  const fresh = notice({ draftReply: "We have it for sure!", customerMessage: "Do you have lamb?", reasons: ["unverified_answer"] });
  assert.match(fresh, /AI draft \(NOT sent\): "We have it for sure!"/);
  const stale = notice({ draftReply: "We have it for sure!", customerMessage: ["Do you have lamb?", "Actually I want beef"].join(SEP) });
  assert.doesNotMatch(stale, /for sure/);
  assert.doesNotMatch(stale, /AI draft|Suggested reply/);
  const followUp = notice({ draftReply: "old", followUp: true, observeOnly: false });
  assert.doesNotMatch(followUp, /Suggested reply/);
});

test("notice: reason codes stay out of WhatsApp; category and ref are clear", () => {
  const text = notice({ reasons: ["complaint", "open_escalation", "low_confidence"], customerMessage: "Bag arrived torn" });
  assert.doesNotMatch(text, /Reason:|open_escalation|low_confidence|model_/);
  assert.match(text, /⚠️ Complaint/);
  assert.match(text, /AI escalation #E-ZTK57/);
  assert.match(text, /Jane · 17585551234/);
  assert.match(text, /Observe mode: nothing is sent to the customer/);
  assert.match(text, /Commands: !note/);
  assert.equal(categorizeRequest({ reasons: ["payment_claim"], orderRequest: null, messages: ["I paid"] }), "payment_issue");
  assert.equal(categorizeRequest({ reasons: ["model_escalated"], intent: "question", orderRequest: null, messages: ["Are you open Sunday?"] }), "unanswered_question");
  assert.equal(categorizeRequest({ reasons: ["discount"], orderRequest: null, messages: ["Any discount?"] }), "other");
});

test("notice: the ref in a generated notice still matches staff replies, and the notice itself is never an answer", () => {
  const text = notice();
  const escalations = [{ id: "1", ref_code: "E-ZTK57", notice_message_id: "N1", status: "notified" }];
  assert.deepEqual(matchStaffReply({ text, quotedMessageId: "N1" }, escalations), { kind: "unmatched" });
  const m = matchStaffReply({ text: "#E-ZTK57 we have it", quotedMessageId: null }, escalations);
  assert.equal(m.kind === "matched" && m.command, "answer");
});
