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
