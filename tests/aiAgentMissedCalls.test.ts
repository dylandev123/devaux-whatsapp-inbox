// Missed-call rule: which call reports count as RELIABLY missed. Pure rules; the SQL side is tests/aiAgentRoutingCallsSql.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type AgentSettings, outboxAllowed } from "../lib/aiAgent/engine.ts";
import { classifyCall, type CallReport, DEFAULT_MISSED_CALL_MESSAGE, MISSED_CALL_MAX_AGE_MS, parseCallReport, validateMissedCallConfig } from "../lib/aiAgent/missedCalls.ts";

const NOW = new Date("2026-10-29T15:00:00Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const missed = (over: Partial<CallReport> = {}): CallReport => ({
  callId: "CALL-1", callerJid: "17585550102@s.whatsapp.net", outgoing: false, isGroup: false, isVideo: false, offline: false,
  sawOffer: true, sawAccept: false, sawReject: false, finalStatus: "timeout", offerAt: iso(-30_000), endedAt: iso(-1_000), ...over,
});
const reason = (r: CallReport) => {
  const v = classifyCall(r, NOW);
  return v.missed ? "missed" : v.reason;
};

describe("which calls are reliably missed", () => {
  test("an incoming one-to-one call that rang out unanswered is missed", () => {
    assert.equal(reason(missed()), "missed");
    assert.equal(reason(missed({ isVideo: true })), "missed");
    assert.equal(reason(missed({ callerJid: "99887766@lid" })), "missed");
  });

  test("outgoing, group, answered, declined and uncertain calls are never missed", () => {
    assert.equal(reason(missed({ outgoing: true })), "outgoing");
    assert.equal(reason(missed({ isGroup: true })), "group_call");
    assert.equal(reason(missed({ sawAccept: true })), "answered");
    assert.equal(reason(missed({ finalStatus: "accept" })), "answered");
    assert.equal(reason(missed({ sawReject: true })), "declined");
    assert.equal(reason(missed({ finalStatus: "reject" })), "declined");
    // The caller hanging up, or an answer on another device, is a plain "terminate": the event cannot tell which.
    assert.equal(reason(missed({ finalStatus: "terminate" })), "uncertain_ended");
    assert.equal(reason(missed({ finalStatus: "ringing" })), "uncertain_ended");
    assert.equal(reason(missed({ offline: true })), "uncertain_offline");
    assert.equal(reason(missed({ sawOffer: false })), "uncertain_no_offer");
    assert.equal(reason(missed({ offerAt: null })), "uncertain_no_offer");
  });

  test("a group JID, a status broadcast or garbage is not a caller", () => {
    assert.equal(reason(missed({ callerJid: "120363000000000001@g.us" })), "invalid_caller");
    assert.equal(reason(missed({ callerJid: "status@broadcast" })), "invalid_caller");
    assert.equal(reason(missed({ callerJid: "nobody" })), "invalid_caller");
  });

  test("a stale or inconsistent timing is not answered", () => {
    assert.equal(reason(missed({ offerAt: iso(-MISSED_CALL_MAX_AGE_MS - 31_000), endedAt: iso(-MISSED_CALL_MAX_AGE_MS - 1000) })), "stale");
    assert.equal(reason(missed({ endedAt: iso(MISSED_CALL_MAX_AGE_MS + 1000) })), "stale");
    assert.equal(reason(missed({ offerAt: iso(-1_000), endedAt: iso(-20_000) })), "uncertain_times");
  });
});

describe("what the bridge says is read cautiously", () => {
  const wire = { businessSlug: "dog_food", callId: "C1", callerJid: "17585550102@s.whatsapp.net", finalStatus: "timeout", outgoing: false, isGroup: false, offline: false, sawOffer: true, sawAccept: false, sawReject: false, isVideo: false, offerAt: iso(-5000), endedAt: iso(-1000) };

  test("a complete report parses to a missed call", () => {
    const r = parseCallReport(wire)!;
    assert.equal(classifyCall(r, NOW).missed, true);
  });

  test("any flag the bridge leaves out counts AGAINST replying", () => {
    for (const key of ["outgoing", "isGroup", "offline", "sawAccept", "sawReject"]) {
      const partial: Record<string, unknown> = { ...wire };
      delete partial[key];
      assert.equal(classifyCall(parseCallReport(partial)!, NOW).missed, false, `missing ${key}`);
    }
    const noOffer: Record<string, unknown> = { ...wire };
    delete noOffer.sawOffer;
    assert.equal(classifyCall(parseCallReport(noOffer)!, NOW).missed, false);
    const loose = { ...wire, outgoing: "false", sawOffer: "true" };
    assert.equal(classifyCall(parseCallReport(loose)!, NOW).missed, false, "only literal booleans count");
  });

  test("unusable reports are rejected outright", () => {
    assert.equal(parseCallReport(null), null);
    assert.equal(parseCallReport({ ...wire, callId: "" }), null);
    assert.equal(parseCallReport({ ...wire, finalStatus: "exploded" }), null);
    assert.equal(parseCallReport({ ...wire, callerJid: undefined }), null);
  });
});

describe("the rule's configuration", () => {
  test("the default text is the one the business asked for", () => {
    assert.equal(DEFAULT_MISSED_CALL_MESSAGE, "Thanks for reaching out! Sorry we missed your call. We're unable to answer at the moment, but how can we help you?");
  });

  test("message and cooldown are validated", () => {
    assert.deepEqual(validateMissedCallConfig({ message: "  Hi  ", cooldownMinutes: 30 }), { ok: true, message: "Hi", cooldownMinutes: 30 });
    assert.equal(validateMissedCallConfig({ message: "   " }).ok, false);
    assert.equal(validateMissedCallConfig({ message: "x".repeat(501) }).ok, false);
    assert.equal(validateMissedCallConfig({ cooldownMinutes: 4 }).ok, false);
    assert.equal(validateMissedCallConfig({ cooldownMinutes: 10081 }).ok, false);
    assert.equal(validateMissedCallConfig({ cooldownMinutes: 1.5 }).ok, false);
    assert.deepEqual(validateMissedCallConfig({}), { ok: true });
  });

  test("the reply may leave only when the rule is on, in a mode that writes to customers, to a person", () => {
    const base = { business_slug: "dog_food", enabled: true, mode: "assisted", staff_group_jid: null } as AgentSettings;
    const reply = { kind: "missed_call_reply", toJid: "17585550102@s.whatsapp.net" };
    assert.equal(outboxAllowed({ ...base, missed_call_enabled: false }, reply), false, "off by default");
    assert.equal(outboxAllowed(base, reply), false, "absent means off");
    assert.equal(outboxAllowed({ ...base, missed_call_enabled: true }, reply), true);
    assert.equal(outboxAllowed({ ...base, mode: "approval_pilot", missed_call_enabled: true }, reply), true);
    assert.equal(outboxAllowed({ ...base, mode: "observe", missed_call_enabled: true, staff_notices_enabled: true }, reply), false, "Observe never writes to a customer");
    assert.equal(outboxAllowed({ ...base, missed_call_enabled: true }, { kind: "missed_call_reply", toJid: "120363000000000001@g.us" }), false, "never into a group");
    assert.equal(outboxAllowed({ ...base, enabled: false, missed_call_enabled: true }, reply), false);
  });

  test("Approval Pilot still sends no ordinary AI customer message", () => {
    const pilot = { business_slug: "dog_food", enabled: true, mode: "approval_pilot", staff_group_jid: "120363000000000001@g.us", missed_call_enabled: true } as AgentSettings;
    for (const kind of ["customer_reply", "holding_reply"]) assert.equal(outboxAllowed(pilot, { kind, toJid: "17585550102@s.whatsapp.net" }), false, kind);
  });
});
