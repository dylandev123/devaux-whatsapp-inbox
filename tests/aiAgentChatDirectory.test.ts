// Unit tests for the contact / staff-group picker logic
// (lib/aiAgent/chatDirectory.ts + chatSources.ts). Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aliasChatIds,
  type DirectoryChat,
  groupLabel,
  matchesChatSearch,
  normalizeContactInput,
  normalizeGroupJid,
} from "../lib/aiAgent/chatDirectory.ts";
import { type ChatSourceDb, loadBusinessChats } from "../lib/aiAgent/chatSources.ts";
import { evaluateGate, type AgentSettings } from "../lib/aiAgent/engine.ts";

const chat = (chatId: string, name: string | null, number: string | null): DirectoryChat => ({
  chatId,
  name,
  number,
  lastMessageAt: "2026-10-22T10:00:00Z",
});

const JANE = chat("17585551234@s.whatsapp.net", "Jane Doe", "17585551234");
const LID = chat("98765432100@lid", "Marcus", "17585559999");
const LID_NO_NUMBER = chat("55500011122@lid", "Privacy Pat", null);

test("partial phone searches ignore formatting and country code", () => {
  for (const q of ["758", "555 1234", "(758) 555-1234", "+1 758 555 1234", "1758555", "001758555 1234", "5551234"]) {
    assert.ok(matchesChatSearch(JANE, q), q);
  }
  assert.ok(!matchesChatSearch(JANE, "758 555 9999"));
  assert.ok(!matchesChatSearch(JANE, "12")); // too short to be meaningful digits
});

test("search by name and by JID", () => {
  assert.ok(matchesChatSearch(JANE, "jane"));
  assert.ok(matchesChatSearch(JANE, "DOE"));
  assert.ok(matchesChatSearch(JANE, "17585551234@s.whatsapp.net"));
  assert.ok(matchesChatSearch(LID, "98765432100@lid"));
  assert.ok(!matchesChatSearch(JANE, "marcus"));
});

test("@lid digits are opaque: matched by real number, never as a phone", () => {
  assert.ok(matchesChatSearch(LID, "758 555 9999"));
  assert.ok(!matchesChatSearch(LID, "987654")); // lid digits aren't phone digits
  assert.ok(!matchesChatSearch(LID_NO_NUMBER, "555000"));
  assert.ok(matchesChatSearch(LID_NO_NUMBER, "privacy"));
});

test("normalizeContactInput builds the bridge's JID", () => {
  const ok = (raw: string) => {
    const r = normalizeContactInput(raw);
    assert.ok(r.ok, raw);
    return r.ok ? r.chatId : "";
  };
  assert.equal(ok("+1 (758) 555-1234"), "17585551234@s.whatsapp.net");
  assert.equal(ok("758-555-1234"), "17585551234@s.whatsapp.net");
  assert.equal(ok("17585551234"), "17585551234@s.whatsapp.net");
  assert.equal(ok("0017585551234"), "17585551234@s.whatsapp.net");
  assert.equal(ok("17585551234@c.us"), "17585551234@s.whatsapp.net");
  assert.equal(ok("17585551234:12@s.whatsapp.net"), "17585551234@s.whatsapp.net");
  assert.equal(ok("98765432100@LID"), "98765432100@lid");
  assert.equal(ok("+44 7700 900123"), "447700900123@s.whatsapp.net");
});

test("normalizeContactInput rejects ambiguous or invalid input instead of guessing", () => {
  for (const bad of ["", "   ", "555-1234", "12345", "abc", "758-CALL-NOW", "120363012345@g.us", "foo@example.com", "+123", "+1234567890123456"]) {
    assert.equal(normalizeContactInput(bad).ok, false, bad);
  }
});

test("normalizeGroupJid accepts only @g.us ids", () => {
  assert.equal(normalizeGroupJid("  120363012345678901@G.US "), "120363012345678901@g.us");
  assert.equal(normalizeGroupJid("12036-3012@g.us"), "12036-3012@g.us");
  assert.equal(normalizeGroupJid("17585551234@s.whatsapp.net"), null);
  assert.equal(normalizeGroupJid("not a jid"), null);
});

test("groupLabel falls back to a short id suffix, not the raw JID", () => {
  assert.equal(groupLabel({ chatId: "120363012345678901@g.us", name: null }), "Group …678901");
  assert.equal(groupLabel({ chatId: "120363012345678901@g.us", name: " Staff " }), "Staff");
});

test("manual add aliases only exact-number matches", () => {
  const known = [JANE, LID, LID_NO_NUMBER, chat("17585559998@s.whatsapp.net", "Close but no", "17585559998")];
  assert.deepEqual(aliasChatIds("17585559999", known).sort(), ["17585559999@s.whatsapp.net", "98765432100@lid"].sort());
  assert.deepEqual(aliasChatIds("1758555", known), ["1758555@s.whatsapp.net"]); // prefix never aliases
  assert.deepEqual(aliasChatIds("17585550000", known), ["17585550000@s.whatsapp.net"]);
});

// ── Business isolation + saved selections (fake Supabase) ──────────────────

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, listKnownChats: ((slug: string) => Row[]) | null): ChatSourceDb {
  const query = (rows: Row[]) => {
    let result = rows;
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => ((result = result.filter((r) => r[col] === val)), q),
      not: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: result, error: null }),
    };
    return q;
  };
  return {
    from: (t: string) => query(tables[t] ?? []),
    rpc: async (_fn: string, args: Record<string, unknown>) =>
      listKnownChats
        ? { data: listKnownChats(String(args.p_business_slug)), error: null }
        : { data: null, error: { message: "function not found" } },
  };
}

const MESSAGE_ROWS = [
  { business_slug: "dog_food", chat_id: "120363000000000001@g.us", contact_name: "Sam", contact_number: "17585550001", direction: "inbound", timestamp: "2026-10-22T09:00:00Z" },
  { business_slug: "dog_food", chat_id: "17585551234@s.whatsapp.net", contact_name: "Jane Doe", contact_number: "17585551234", direction: "inbound", timestamp: "2026-10-22T10:00:00Z" },
  { business_slug: "dog_food", chat_id: "status@broadcast", contact_name: null, contact_number: null, direction: "inbound", timestamp: "2026-10-22T10:00:00Z" },
  { business_slug: "by_sea", chat_id: "120363000000000002@g.us", contact_name: "Other", contact_number: "1", direction: "inbound", timestamp: "2026-10-22T11:00:00Z" },
  { business_slug: "by_sea", chat_id: "17585557777@s.whatsapp.net", contact_name: "Other Biz Customer", contact_number: "17585557777", direction: "inbound", timestamp: "2026-10-22T11:00:00Z" },
];

const rpcFor = (slug: string): Row[] =>
  MESSAGE_ROWS.filter((r) => r.business_slug === slug).map((r) => ({ ...r, last_message_at: r.timestamp }));

test("group discovery returns only the selected business's groups (RPC path)", async () => {
  const db = fakeDb({ whatsapp_messages: MESSAGE_ROWS }, rpcFor);
  const dog = await loadBusinessChats(db, "dog_food");
  assert.deepEqual(dog.groups.map((g) => g.chatId), ["120363000000000001@g.us"]);
  assert.equal(dog.groups[0].lastSender, "Sam");
  assert.equal(dog.rpcAvailable, true);
  assert.ok(!dog.contacts.some((c) => c.chatId === "status@broadcast"));
  const sea = await loadBusinessChats(db, "by_sea");
  assert.deepEqual(sea.groups.map((g) => g.chatId), ["120363000000000002@g.us"]);
});

test("business isolation holds on the RPC-missing fallback too", async () => {
  const db = fakeDb({ whatsapp_messages: MESSAGE_ROWS }, null);
  const dog = await loadBusinessChats(db, "dog_food");
  assert.equal(dog.rpcAvailable, false);
  assert.deepEqual(dog.groups.map((g) => g.chatId), ["120363000000000001@g.us"]);
  assert.deepEqual(dog.contacts.map((c) => c.chatId), ["17585551234@s.whatsapp.net"]);
});

test("contacts older than the 7-day purge stay searchable via orders and saved rules", async () => {
  const db = fakeDb(
    {
      whatsapp_messages: [],
      customer_orders: [
        { business_slug: "dog_food", chat_id: "98765432100@lid", contact_number: "17585559999", customer_name: "Marcus" },
        { business_slug: "by_sea", chat_id: "17585557777@s.whatsapp.net", contact_number: "17585557777", customer_name: "Nope" },
      ],
      ai_agent_contact_rules: [
        { business_slug: "dog_food", chat_id: "17585550000@s.whatsapp.net", display_name: "Saved Sue", rule: "allow" },
      ],
    },
    () => []
  );
  const { contacts } = await loadBusinessChats(db, "dog_food");
  assert.deepEqual(contacts.map((c) => c.chatId).sort(), ["17585550000@s.whatsapp.net", "98765432100@lid"]);
  assert.ok(contacts.some((c) => matchesChatSearch(c, "555 9999")));
  assert.ok(contacts.some((c) => matchesChatSearch(c, "saved sue")));
});

// ── Saved selections must match what the bridge forwards ────────────────────

const SETTINGS: AgentSettings = {
  business_slug: "dog_food",
  enabled: true,
  mode: "assisted",
  contact_scope: "selected",
  autonomy: 30,
  staff_group_jid: "120363000000000001@g.us",
  staff_group_name: null,
  auto_takeover_minutes: 120,
  max_auto_replies_per_hour: 6,
  send_holding_reply: true,
  staff_notices_enabled: false,
};
const gate = (chatId: string, contactRule: "allow" | "exclude" | null) =>
  evaluateGate({
    businessSlug: "dog_food",
    chatId,
    fromMe: false,
    text: "hi",
    hasMedia: false,
    settings: SETTINGS,
    contactRule,
    conversation: null,
    staffActiveAt: null,
    now: new Date("2026-10-22T12:00:00Z"),
  });

test("a manually added number produces the exact JID the gate is keyed on", () => {
  const n = normalizeContactInput("+1 758 555 1234");
  assert.ok(n.ok);
  // The rule table is looked up by exact chat_id: the typed number's JID is
  // what the bridge sends for that customer, so the allow rule applies…
  assert.equal(n.chatId, JANE.chatId);
  assert.equal(gate(n.chatId, "allow").pass, true);
  // …and a different contact (no rule row under its own JID) stays blocked,
  // even one whose digits merely contain the allowed number.
  assert.equal(gate("917585551234@s.whatsapp.net", null).pass, false);
  assert.equal(gate("98765432100@lid", null).pass, false);
});
