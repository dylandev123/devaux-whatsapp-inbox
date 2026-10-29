// Rules & Routing: which group hears about what, and who may act in it. Pure rules.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type AgentSettings, outboxAllowed } from "../lib/aiAgent/engine.ts";
import {
  categoryForEscalation,
  isRoutedGroup,
  noticeGroup,
  parseRoutingRules,
  routedGroup,
  routedGroups,
  settingsForRoutedGroup,
  validateRoutingRules,
} from "../lib/aiAgent/routing.ts";

const STAFF = "120363000000000001@g.us";
const COMPLAINTS = "120363000000000011@g.us";
const URGENT = "120363000000000012@g.us";
const APPROVALS = "120363000000000013@g.us";
const ORDERS = "120363000000000003@g.us";

const rules = (over: Record<string, unknown> = {}) => ({
  complaints: { enabled: true, group_jid: COMPLAINTS, group_name: "Complaints" },
  urgent: { enabled: true, group_jid: URGENT, group_name: null },
  approvals: { enabled: true, group_jid: APPROVALS, group_name: null },
  ...over,
});
const settings = (over: Partial<AgentSettings> = {}): AgentSettings =>
  ({
    business_slug: "dog_food", enabled: true, mode: "approval_pilot", contact_scope: "all", autonomy: 50, staff_group_jid: STAFF, staff_group_name: null,
    auto_takeover_minutes: 0, max_auto_replies_per_hour: 10, send_holding_reply: false, staff_notices_enabled: true, batching_enabled: false,
    batch_quiet_seconds: 0, batch_max_wait_seconds: 0, customer_memory_enabled: false, routing_rules: rules(), ...over,
  }) as AgentSettings;

describe("routing: categories and destinations", () => {
  test("urgent beats complaints beats approvals; anything else is unclassified", () => {
    assert.equal(categoryForEscalation({ priority: "urgent", reasonCodes: ["complaint"], mode: "approval_pilot" }), "urgent");
    assert.equal(categoryForEscalation({ priority: "high", reasonCodes: ["complaint"], mode: "approval_pilot" }), "complaints");
    assert.equal(categoryForEscalation({ priority: "normal", reasonCodes: ["refund"], mode: "assisted" }), "complaints");
    assert.equal(categoryForEscalation({ priority: "normal", reasonCodes: ["payment_claim"], mode: "assisted" }), "complaints");
    assert.equal(categoryForEscalation({ priority: "normal", reasonCodes: ["low_confidence"], mode: "approval_pilot" }), "approvals", "in Approval Pilot a notice is an approval request");
    assert.equal(categoryForEscalation({ priority: "normal", reasonCodes: ["low_confidence"], mode: "assisted" }), null);
  });

  test("the routed group is used when its rule is on; otherwise the staff group is the fallback", () => {
    assert.equal(noticeGroup(settings(), "complaints"), COMPLAINTS);
    assert.equal(noticeGroup(settings(), null), STAFF, "unclassified → fallback");
    assert.equal(noticeGroup(settings({ routing_rules: rules({ complaints: { enabled: false, group_jid: COMPLAINTS } }) }), "complaints"), STAFF, "a disabled rule routes nothing");
    assert.equal(noticeGroup(settings({ routing_rules: {} }), "urgent"), STAFF, "no rules → exactly today's behaviour");
    assert.equal(noticeGroup(settings({ routing_rules: undefined }), "urgent"), STAFF);
  });

  test("a rule that names the staff group is no routing, and rules wait for a staff group", () => {
    assert.equal(routedGroup(settings({ routing_rules: rules({ urgent: { enabled: true, group_jid: STAFF } }) }), "urgent"), null);
    assert.equal(noticeGroup(settings({ staff_group_jid: null }), "urgent"), null);
    assert.deepEqual(routedGroups(settings({ staff_group_jid: null })), []);
  });

  test("malformed stored rules are dropped, never trusted", () => {
    assert.deepEqual(parseRoutingRules("nope"), {});
    assert.deepEqual(parseRoutingRules([1]), {});
    const parsed = parseRoutingRules({ urgent: { enabled: true, group_jid: "17585550001@s.whatsapp.net" }, bogus: { enabled: true, group_jid: URGENT }, complaints: { enabled: "yes", group_jid: COMPLAINTS } });
    assert.equal(parsed.urgent?.enabled, false, "a customer chat is not a group");
    assert.equal(parsed.complaints?.enabled, false, "enabled must be literally true");
    assert.equal((parsed as Record<string, unknown>).bogus, undefined);
  });

  test("each notice has exactly one destination", () => {
    const s = settings();
    for (const category of ["urgent", "complaints", "approvals", null] as const) {
      assert.equal(typeof noticeGroup(s, category), "string");
    }
    assert.deepEqual(routedGroups(s).sort(), [COMPLAINTS, URGENT, APPROVALS].sort());
    assert.ok(!routedGroups(s).includes(STAFF));
  });
});

describe("routing: who may post and be heard", () => {
  test("a routed group takes staff-group kinds in the modes the staff group does, and never customer-bound kinds", () => {
    const s = settings();
    for (const kind of ["staff_notice", "staff_draft", "staff_feedback"]) assert.equal(outboxAllowed(s, { kind, toJid: COMPLAINTS }), true, kind);
    assert.equal(outboxAllowed(s, { kind: "customer_reply", toJid: COMPLAINTS }), false);
    assert.equal(outboxAllowed(s, { kind: "staff_relay", toJid: COMPLAINTS }), false, "a relay is for a customer");
    assert.equal(outboxAllowed(s, { kind: "staff_notice", toJid: "120363999999999999@g.us" }), false, "an unconfigured group gets nothing");
    // A disabled rule is not a group the agent may post to.
    const off = settings({ routing_rules: rules({ complaints: { enabled: false, group_jid: COMPLAINTS } }) });
    assert.equal(outboxAllowed(off, { kind: "staff_notice", toJid: COMPLAINTS }), false);
  });

  test("Observe: notices and drafts only, and only when notices are enabled", () => {
    assert.equal(outboxAllowed(settings({ mode: "observe" }), { kind: "staff_notice", toJid: URGENT }), true);
    assert.equal(outboxAllowed(settings({ mode: "observe" }), { kind: "staff_feedback", toJid: URGENT }), false);
    assert.equal(outboxAllowed(settings({ mode: "observe", staff_notices_enabled: false }), { kind: "staff_notice", toJid: URGENT }), false);
  });

  test("the staff group and orders group rules are unchanged", () => {
    const s = settings({ orders_group_jid: ORDERS, orders_summary_enabled: true });
    assert.equal(outboxAllowed(s, { kind: "staff_draft", toJid: STAFF }), true);
    assert.equal(outboxAllowed(s, { kind: "staff_notice", toJid: ORDERS }), true);
    assert.equal(outboxAllowed(s, { kind: "staff_draft", toJid: ORDERS }), false, "the orders group takes no drafts");
    assert.equal(outboxAllowed(s, { kind: "customer_reply", toJid: "17585550001@s.whatsapp.net" }), false, "Approval Pilot never sends an AI reply");
    assert.equal(outboxAllowed(s, { kind: "staff_relay", toJid: "17585550001@s.whatsapp.net" }), true);
  });

  test("a routed group is a staff group for replies, but order commands stay with the orders group", () => {
    const s = settings({ orders_group_jid: null });
    const eff = settingsForRoutedGroup(s, COMPLAINTS);
    assert.equal(eff.staff_group_jid, COMPLAINTS, "replies go back to the group the staff member wrote in");
    assert.equal(eff.orders_group_jid, STAFF, "order commands are still pinned to where they were allowed");
    assert.ok(isRoutedGroup(s, COMPLAINTS));
    assert.ok(!isRoutedGroup(s, STAFF));
    assert.ok(!isRoutedGroup(s, "17585550001@s.whatsapp.net"));
    const withOrders = settingsForRoutedGroup(settings({ orders_group_jid: ORDERS }), URGENT);
    assert.equal(withOrders.orders_group_jid, ORDERS);
  });
});

describe("routing: validating what an admin saves", () => {
  test("rules need a group and a staff group; unknown categories and bad JIDs are refused", () => {
    assert.equal(validateRoutingRules({ urgent: { enabled: true, groupJid: URGENT } }, STAFF).ok, true);
    assert.deepEqual(validateRoutingRules({ urgent: { enabled: true, groupJid: null } }, STAFF), { ok: false, error: "urgent: choose a group before turning the rule on" });
    assert.equal(validateRoutingRules({ urgent: { enabled: true, groupJid: URGENT } }, null).ok, false);
    assert.equal(validateRoutingRules({ orders: { enabled: true, groupJid: URGENT } }, STAFF).ok, false, "orders is not a routed category");
    assert.equal(validateRoutingRules({ urgent: { enabled: true, groupJid: "17585550001@s.whatsapp.net" } }, STAFF).ok, false);
    assert.equal(validateRoutingRules({ urgent: { enabled: "yes", groupJid: URGENT } }, STAFF).ok, false);
    assert.equal(validateRoutingRules("x", STAFF).ok, false);
    const off = validateRoutingRules({ urgent: { enabled: false, groupJid: null } }, null);
    assert.equal(off.ok, true, "turning a rule off never needs anything");
  });
});
