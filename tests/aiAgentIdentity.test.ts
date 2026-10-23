// Contact identity (phone JID <-> @lid) and its use by the gate. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { combineRules, resolveChatIdentity, verifiedPhoneDigits } from "../lib/aiAgent/identity.ts";
import { aliasChatIds, chatPhoneDigits } from "../lib/aiAgent/chatDirectory.ts";
import { evaluateGate, type AgentSettings, type GateInput } from "../lib/aiAgent/engine.ts";
import { resolveDisplayPhone } from "../lib/phone.ts";

const PHONE = "17585551234";
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID = "98765432100@lid";
const NONE = { storedPhone: null, lidChats: [] };

const settings: AgentSettings = {
  business_slug: "cool_pool",
  enabled: true,
  mode: "observe",
  contact_scope: "selected",
  autonomy: 30,
  staff_group_jid: null,
  staff_group_name: null,
  auto_takeover_minutes: 0,
  max_auto_replies_per_hour: 5,
  send_holding_reply: true,
  staff_notices_enabled: false,
  batching_enabled: false,
  batch_quiet_seconds: 45,
  batch_max_wait_seconds: 180,
  customer_memory_enabled: false,
};
const gate = (over: Partial<GateInput>) =>
  evaluateGate({
    businessSlug: "cool_pool",
    chatId: PHONE_JID,
    fromMe: false,
    text: "hi",
    hasMedia: false,
    settings,
    contactRule: null,
    conversation: null,
    staffActiveAt: null,
    now: new Date(),
    ...over,
  });

test("verified phone: phone JIDs, and @lid only with a different plausible number", () => {
  assert.equal(verifiedPhoneDigits(PHONE_JID, null), PHONE);
  assert.equal(verifiedPhoneDigits(LID, PHONE), PHONE);
  assert.equal(verifiedPhoneDigits(LID, "98765432100"), null); // bridge fallback = the lid's own digits
  assert.equal(verifiedPhoneDigits(LID, "98765432100@lid"), null);
  assert.equal(verifiedPhoneDigits(LID, null), null);
  assert.equal(verifiedPhoneDigits(LID, "12345"), null); // implausible
});

test("known @lid with a verified phone resolves to both identities", () => {
  const id = resolveChatIdentity(LID, PHONE, NONE);
  assert.deepEqual(id.chatIds, [LID, PHONE_JID]);
  assert.equal(id.phone, PHONE);
  assert.equal(id.unresolvedLid, false);
});

test("@lid phone found in stored history is used when the payload has none", () => {
  const id = resolveChatIdentity(LID, "98765432100", { storedPhone: PHONE, lidChats: [] });
  assert.deepEqual(id.chatIds, [LID, PHONE_JID]);
});

test("a phone chat also covers the @lid chats WhatsApp linked to that phone", () => {
  const id = resolveChatIdentity(PHONE_JID, PHONE, { storedPhone: null, lidChats: [LID] });
  assert.deepEqual(id.chatIds, [PHONE_JID, LID]);
});

test("unresolved @lid never borrows another identity", () => {
  const id = resolveChatIdentity(LID, "98765432100", { storedPhone: null, lidChats: ["55500011122@lid"] });
  assert.deepEqual(id.chatIds, [LID]);
  assert.equal(id.unresolvedLid, true);
});

test("combineRules: exclude on any identity wins", () => {
  assert.equal(combineRules([]), null);
  assert.equal(combineRules([{ chat_id: "a", rule: "allow" }]), "allow");
  assert.equal(combineRules([{ chat_id: "a", rule: "allow" }, { chat_id: "b", rule: "exclude" }]), "exclude");
});

test("gate: allowed via either identity passes; excluded and unknown do not", () => {
  assert.ok(gate({ chatId: PHONE_JID, contactRule: "allow" }).pass);
  assert.ok(gate({ chatId: LID, contactRule: "allow" }).pass);
  const excluded = gate({ chatId: LID, contactRule: "exclude" });
  assert.ok(!excluded.pass && excluded.reasons[0] === "contact_excluded");
  const unknown = gate({ chatId: PHONE_JID, contactRule: null });
  assert.ok(!unknown.pass && unknown.reasons.join() === "contact_not_permitted");
});

test("gate: unresolved @lid is denied with a diagnostic reason, never allowed", () => {
  const r = gate({ chatId: LID, contactRule: null, unresolvedLid: true });
  assert.ok(!r.pass);
  assert.deepEqual(!r.pass && r.reasons, ["contact_not_permitted", "unresolved_lid_identity"]);
});

test("display + directory never present @lid digits as a phone number", () => {
  assert.deepEqual(resolveDisplayPhone("98765432100", LID), { phone: null, isLid: true });
  assert.deepEqual(resolveDisplayPhone(PHONE, LID), { phone: PHONE, isLid: false });
  assert.equal(chatPhoneDigits({ chatId: LID, number: "98765432100" }), "");
  assert.equal(chatPhoneDigits({ chatId: LID, number: PHONE }), PHONE);
  const known = [
    { chatId: LID, name: "A", number: PHONE, lastMessageAt: null },
    { chatId: "55500011122@lid", name: "B", number: "55500011122", lastMessageAt: null },
  ];
  assert.deepEqual(aliasChatIds(PHONE, known), [PHONE_JID, LID]);
  assert.deepEqual(aliasChatIds("55500011122", known), ["55500011122@s.whatsapp.net"]);
});

// ── Staff sender authorization ───────────────────────────────────────────────

import {
  authorizeStaffSender,
  isSenderIdAuthorized,
  normalizeAuthorizedSender,
  parseAuthorizedSenders,
  verifiedSenderKeys,
} from "../lib/aiAgent/identity.ts";

test("allow-list entries: phone numbers and exact @lid ids only; formatting is normalized, names are rejected", () => {
  assert.equal(normalizeAuthorizedSender("+1 (758) 555-0001"), "17585550001");
  assert.equal(normalizeAuthorizedSender("17585550001@s.whatsapp.net"), "17585550001");
  assert.equal(normalizeAuthorizedSender("17585550001:12@s.whatsapp.net"), "17585550001");
  assert.equal(normalizeAuthorizedSender("55512345678901@LID"), "55512345678901@lid");
  for (const bad of ["Jane", "Jane Smith", "12345", "1234567890123456789", "", "  ", null, undefined, 17585550001, "abc@lid", "120363000000000001@g.us"]) {
    assert.equal(normalizeAuthorizedSender(bad), null, String(bad));
  }
  assert.deepEqual(parseAuthorizedSenders("17585550001, 17585550002\n17585550001;55512345678901@lid"), {
    ok: true,
    senders: ["17585550001", "17585550002", "55512345678901@lid"],
  });
  assert.deepEqual(parseAuthorizedSenders(""), { ok: true, senders: [] });
  assert.equal(parseAuthorizedSenders("17585550001, Jane").ok, false);
  assert.equal(parseAuthorizedSenders(42).ok, false);
  assert.equal(parseAuthorizedSenders(Array.from({ length: 51 }, (_, i) => String(17585550000 + i))).ok, false);
});

test("sender identity: a phone JID proves its number; an @lid proves only itself plus a distinct reported phone", () => {
  assert.deepEqual(verifiedSenderKeys("17585550001@s.whatsapp.net", null), ["17585550001"]);
  assert.deepEqual(verifiedSenderKeys("17585550001:7@s.whatsapp.net", "99999999999"), ["17585550001"], "a reported phone never overrides a phone JID");
  assert.deepEqual(verifiedSenderKeys("99887766554433@lid", null), ["99887766554433@lid"]);
  assert.deepEqual(verifiedSenderKeys("99887766554433@lid", "17585550001"), ["17585550001", "99887766554433@lid"]);
  assert.deepEqual(verifiedSenderKeys("99887766554433@lid", "99887766554433"), ["99887766554433@lid"], "the @lid's own digits prove nothing");
  assert.deepEqual(verifiedSenderKeys("99887766554433@lid", "123"), ["99887766554433@lid"]);
  assert.deepEqual(verifiedSenderKeys(null, "17585550001"), []);
  assert.deepEqual(verifiedSenderKeys("", "17585550001"), []);
  assert.deepEqual(verifiedSenderKeys("120363000000000001@g.us", "17585550001"), []);
});

test("authorization: default-deny, exact verified match, never by LID digits or display text", () => {
  const list = ["17585550001", "55512345678901@lid"];
  assert.equal(authorizeStaffSender([], "17585550001@s.whatsapp.net", null).authorized, false);
  assert.equal(authorizeStaffSender(undefined, "17585550001@s.whatsapp.net", null).authorized, false);
  assert.equal(authorizeStaffSender(null, "17585550001@s.whatsapp.net", null).authorized, false);
  assert.deepEqual(authorizeStaffSender(list, "17585550001@s.whatsapp.net", null), { authorized: true, senderId: "17585550001" });
  assert.equal(authorizeStaffSender(list, "17585550002@s.whatsapp.net", null).authorized, false);
  // @lid digits that equal an authorized phone number do not match it.
  assert.equal(authorizeStaffSender(list, "17585550001@lid", null).authorized, false);
  assert.equal(authorizeStaffSender(list, "17585550001@lid", "17585550001").authorized, false);
  // A bridge-reported phone for an unrelated @lid does.
  assert.deepEqual(authorizeStaffSender(list, "42@lid", "17585550001"), { authorized: true, senderId: "17585550001" });
  assert.equal(authorizeStaffSender(list, "42@lid", "17585550009").authorized, false);
  // The exact @lid entry matches only that @lid.
  assert.equal(authorizeStaffSender(list, "55512345678901@lid", null).authorized, true);
  assert.equal(authorizeStaffSender(list, "55512345678902@lid", null).authorized, false);
  // No sender at all (e.g. an unattributed message) is nobody.
  assert.deepEqual(authorizeStaffSender(list, null, "17585550001"), { authorized: false, senderId: null });
  // A malformed stored entry never matches anything.
  assert.equal(authorizeStaffSender(["Jane"], "17585550001@s.whatsapp.net", null).authorized, false);
  // Re-checks use the recorded id against the CURRENT list.
  assert.equal(isSenderIdAuthorized(list, "17585550001"), true);
  assert.equal(isSenderIdAuthorized([], "17585550001"), false);
  assert.equal(isSenderIdAuthorized(list, null), false);
});
