// Server-only: the staff-group commands "!rules" / "!help", "!customer", "!location" (show / save / clear) and "!remember".
//
// Only messages that arrive in the business's STAFF GROUP reach this file (processBridgeMessage routes by group), so a
// customer's chat can never run one: a customer who types "!location Cap Estate" is just a customer message.
//
// Who the customer is comes from exactly two places, both resolved inside this business and never by name:
//   - the message the staff member REPLIED to (a notice/draft/feedback the agent posted for one escalation), or
//   - a reference typed in the command (a #E- request code, an order code, or a phone number).
// If both are given they must be the same customer; if neither is, or the quote is about several customers, or the
// reference is unknown, nothing is read or changed and the reply says so. Reads and writes of memory require the sender to
// be on the business's verified allow-list (authorizeStaffSender). "!rules" / "!help" are read-only and need no customer
// or quote, but are for authorized staff too: nobody else in the group gets the command list.

import { buildRulesMessages } from "@/lib/aiAgent/commandRegistry";
import {
  CUSTOMER_REPLY,
  type CustomerCard,
  type CustomerCommand,
  type CustomerRef,
  formatCustomerCard,
  formatLocationCleared,
  formatLocationReply,
  formatLocationSaved,
  looksLikeLocationFact,
  MAX_NOTES_PER_CUSTOMER,
  PROPOSAL_TTL_DAYS,
  REJECTION_TEXT,
  USAGE,
  validateLocation,
  validateNote,
} from "@/lib/aiAgent/customerCommands";
import type { AgentSettings } from "@/lib/aiAgent/engine";
import { type ChatIdentity, phoneJidFor, type SenderAuthorization } from "@/lib/aiAgent/identity";
import { describeOrder, isVerifiedOrder } from "@/lib/aiAgent/memory";
import { DEFAULT_ORDERS_TIMEZONE, formatPhone } from "@/lib/aiAgent/orders";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import { loadFacts, loadOrders, loadProfile } from "@/lib/server/aiAgent/memory";
import type { OutboxInsert } from "@/lib/server/aiAgent/outbox";
import {
  clearStaffLocation,
  type CustomerKeys,
  customerKeys,
  expireStaleProposals,
  findNoteByCode,
  loadStaffLocation,
  loadStaffNotes,
  proposeStaffNote,
  saveStaffLocation,
  transitionNote,
} from "@/lib/server/aiAgent/customerStaffMemory";

export interface CustomerCommandInput {
  settings: AgentSettings;
  command: CustomerCommand;
  /** The WhatsApp id of the staff message this one replies to, if any. */
  quotedMessageId: string | null;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  eventId: string;
  whatsappMessageId: string;
}

export interface CustomerCommandResult {
  outbox: OutboxInsert[];
  outcome: string;
}

/** Our own posts that identify one escalation (and so one customer) when a staff member replies to them. */
const QUOTABLE_KINDS = ["staff_notice", "staff_draft", "staff_feedback"];

interface Source {
  chatId: string;
  contactNumber: string | null;
  name: string | null;
}

interface ResolvedCustomer {
  chatId: string;
  identity: ChatIdentity;
  keys: CustomerKeys;
  name: string | null;
  label: string;
  phone: string | null;
}

type Resolution =
  | { kind: "one"; customer: ResolvedCustomer }
  | { kind: "no_target" }
  | { kind: "unknown"; label: string }
  | { kind: "mismatch" }
  | { kind: "ambiguous" };

const refLabel = (ref: CustomerRef) => (ref.type === "phone" ? ref.digits : ref.type === "order" ? `#${ref.refCode.replace(/^O-/, "")}` : `#${ref.refCode}`);

/** Escalations the quoted message belongs to — never more than the quote's own, never by recency. */
async function sourcesFromQuote(slug: string, quotedMessageId: string): Promise<Source[]> {
  const db = agentDb();
  const { data: posted, error } = await db
    .from("ai_agent_outbox")
    .select("escalation_id")
    .eq("business_slug", slug)
    .in("kind", QUOTABLE_KINDS)
    .eq("whatsapp_message_id", quotedMessageId);
  if (error) throw new Error(error.message);
  const ids = [...new Set((posted ?? []).map((r) => r.escalation_id as string | null).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return [];
  const { data, error: escError } = await db.from("ai_agent_escalations").select("chat_id, contact_number, customer_name").eq("business_slug", slug).in("id", ids);
  if (escError) throw new Error(escError.message);
  return (data ?? []).map((e) => ({ chatId: e.chat_id as string, contactNumber: (e.contact_number as string | null) ?? null, name: (e.customer_name as string | null) ?? null }));
}

async function sourcesFromRef(slug: string, ref: CustomerRef): Promise<Source[]> {
  const db = agentDb();
  if (ref.type === "escalation") {
    const { data, error } = await db.from("ai_agent_escalations").select("chat_id, contact_number, customer_name").eq("business_slug", slug).eq("ref_code", ref.refCode).limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).map((e) => ({ chatId: e.chat_id as string, contactNumber: (e.contact_number as string | null) ?? null, name: (e.customer_name as string | null) ?? null }));
  }
  if (ref.type === "order") {
    const { data, error } = await db.from("ai_agent_orders").select("chat_id, contact_number, customer_name").eq("business_slug", slug).eq("ref_code", ref.refCode).limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).map((e) => ({ chatId: e.chat_id as string, contactNumber: (e.contact_number as string | null) ?? null, name: (e.customer_name as string | null) ?? null }));
  }
  // A phone number must be one this business has actually dealt with: a typo never creates memory for a stranger.
  const jid = phoneJidFor(ref.digits);
  const known = await Promise.all([
    db.from("ai_agent_escalations").select("id").eq("business_slug", slug).eq("contact_number", ref.digits).limit(1),
    db.from("ai_agent_orders").select("id").eq("business_slug", slug).eq("contact_number", ref.digits).limit(1),
    db.from("customer_orders").select("id").eq("business_slug", slug).eq("contact_number", ref.digits).limit(1),
    db.from("whatsapp_messages").select("id").eq("business_slug", slug).eq("chat_id", jid).limit(1),
    db.from("whatsapp_messages").select("id").eq("business_slug", slug).eq("contact_number", ref.digits).limit(1),
    db.from("ai_agent_customer_staff_memory").select("id").eq("business_slug", slug).eq("customer_key", ref.digits).limit(1),
  ]);
  for (const k of known) if (k.error) throw new Error(k.error.message);
  if (!known.some((k) => (k.data ?? []).length > 0)) return [];
  return [{ chatId: jid, contactNumber: ref.digits, name: null }];
}

/** A display name for a verified phone, from the business's own escalation records (display only; never used to match). */
async function knownName(slug: string, phone: string): Promise<string | null> {
  const { data } = await agentDb().from("ai_agent_escalations").select("customer_name").eq("business_slug", slug).eq("contact_number", phone).not("customer_name", "is", null).order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0]?.customer_name as string | undefined) ?? null;
}

async function toCustomer(slug: string, s: Source): Promise<ResolvedCustomer> {
  const identity = await loadIdentity(slug, s.chatId, s.contactNumber);
  const phone = identity.phone;
  const shown = phone ? formatPhone(phone) : null;
  const name = s.name ?? (phone ? await knownName(slug, phone) : null);
  const label = [name, shown].filter(Boolean).join(" · ") || "this customer (no verified phone)";
  return { chatId: s.chatId, identity, keys: customerKeys(s.chatId, identity), name, label, phone: shown };
}

const sameCustomer = (a: ResolvedCustomer, b: ResolvedCustomer) => a.keys.all.some((k) => b.keys.all.includes(k));

/** Distinct customers among resolved sources (two escalations of one customer are one customer). */
function distinct(customers: ResolvedCustomer[]): ResolvedCustomer[] {
  const out: ResolvedCustomer[] = [];
  for (const c of customers) if (!out.some((o) => sameCustomer(o, c))) out.push(c);
  return out;
}

export async function resolveCustomer(slug: string, quotedMessageId: string | null, ref: CustomerRef | null): Promise<Resolution> {
  const quoted = quotedMessageId ? distinct(await Promise.all((await sourcesFromQuote(slug, quotedMessageId)).map((s) => toCustomer(slug, s)))) : [];
  if (quoted.length > 1) return { kind: "ambiguous" };
  if (!ref) return quoted.length === 1 ? { kind: "one", customer: quoted[0] } : { kind: "no_target" };
  const named = distinct(await Promise.all((await sourcesFromRef(slug, ref)).map((s) => toCustomer(slug, s))));
  if (named.length === 0) return { kind: "unknown", label: refLabel(ref) };
  if (named.length > 1) return { kind: "ambiguous" };
  if (quoted.length === 1 && !sameCustomer(quoted[0], named[0])) return { kind: "mismatch" };
  return { kind: "one", customer: named[0] };
}

// ── Replies ──────────────────────────────────────────────────────────────────

function reply(input: CustomerCommandInput, body: string, outcome: string, part = 0): CustomerCommandResult {
  return { outbox: [message(input, body, part)], outcome };
}

/** A staff_notice in the staff group: the kind every mode that can post to the group accepts (read-only help works in Observe too). */
function message(input: CustomerCommandInput, body: string, part = 0): OutboxInsert {
  const group = input.settings.staff_group_jid!;
  return {
    businessSlug: input.settings.business_slug,
    chatId: group,
    kind: "staff_notice",
    toJid: group,
    body: body.slice(0, 3800),
    dedupeKey: part === 0 ? `${input.eventId}:customer_command` : `${input.eventId}:customer_command:${part}`,
    eventId: input.eventId,
  };
}

const senderTail = (id: string | null) => (id ? `…${id.split("@")[0].slice(-4)}` : null);
const timeZoneOf = (s: AgentSettings) => s.orders_timezone || DEFAULT_ORDERS_TIMEZONE;

// ── Entry point ──────────────────────────────────────────────────────────────

export async function handleCustomerCommand(input: CustomerCommandInput): Promise<CustomerCommandResult> {
  const { command, settings, senderAuth } = input;
  const slug = settings.business_slug;
  if (!settings.staff_group_jid) return { outbox: [], outcome: "customer:no_group" };

  // "!rules" / "!help": read-only, no customer, no quote — but authorized staff only. Changes nothing.
  if (command.kind === "rules") {
    if (!senderAuth.authorized) {
      await audit(slug, "staff", input.senderJid, "customer_command.refused", { type: "customer" }, { command: "rules", reason: "sender_not_authorized", sender_id: senderAuth.senderId });
      return reply(input, CUSTOMER_REPLY.notAuthorized, "customer:rules_not_authorized");
    }
    const parts = buildRulesMessages();
    return { outbox: parts.map((body, i) => message(input, body, i)), outcome: "customer:rules" };
  }

  if (command.kind === "help") return reply(input, USAGE[command.command], `customer:${command.command}_usage`);

  const name = command.kind === "remember_review" ? "remember" : command.kind === "unknown_ref" ? command.command : command.kind === "location_clear" ? "location" : command.kind;
  const sensitive = command.kind !== "unknown_ref";
  // Everything below reads or writes a customer's data: verified, allow-listed staff only.
  if (!senderAuth.authorized && sensitive) {
    await audit(slug, "staff", input.senderJid, "customer_command.refused", { type: "customer" }, { command: name, reason: "sender_not_authorized", sender_id: senderAuth.senderId });
    return reply(input, CUSTOMER_REPLY.notAuthorized, `customer:${name}_not_authorized`);
  }

  if (command.kind === "unknown_ref") return reply(input, CUSTOMER_REPLY.unknownRef(command.token), `customer:${name}_unknown_ref`);
  if (command.kind === "remember_review") return reviewNote(input, command);

  const found = await resolveCustomer(slug, input.quotedMessageId, command.ref);
  switch (found.kind) {
    case "no_target":
      return reply(input, CUSTOMER_REPLY.noCustomer(name as "location" | "customer" | "remember"), `customer:${name}_no_customer`);
    case "unknown":
      return reply(input, CUSTOMER_REPLY.unknownRef(found.label), `customer:${name}_unknown_customer`);
    case "mismatch":
      return reply(input, CUSTOMER_REPLY.mismatch, `customer:${name}_mismatch`);
    case "ambiguous":
      return reply(input, CUSTOMER_REPLY.ambiguousQuote, `customer:${name}_ambiguous`);
  }
  const customer = found.customer;

  switch (command.kind) {
    case "customer":
      return showCustomer(input, customer);
    case "location":
      return command.value === null ? showLocation(input, customer) : setLocation(input, customer, command.value);
    case "location_clear":
      return clearLocation(input, customer);
    case "remember":
      return proposeNote(input, customer, command.fact);
  }
}

// ── !location ────────────────────────────────────────────────────────────────

async function showLocation(input: CustomerCommandInput, c: ResolvedCustomer): Promise<CustomerCommandResult> {
  const row = await loadStaffLocation(input.settings.business_slug, c.keys.all);
  const text = formatLocationReply(
    { label: c.label, location: row?.content ?? null, setAt: row?.created_at ?? null, setBy: row?.set_by ?? null, source: row ? `set by staff on WhatsApp${senderTail(row.set_by) ? ` (${senderTail(row.set_by)})` : ""}` : null },
    timeZoneOf(input.settings)
  );
  return reply(input, text, "customer:location_viewed");
}

async function setLocation(input: CustomerCommandInput, c: ResolvedCustomer, raw: string): Promise<CustomerCommandResult> {
  const slug = input.settings.business_slug;
  const checked = validateLocation(raw);
  if (!checked.ok) return reply(input, CUSTOMER_REPLY.rejected(USAGE.location, REJECTION_TEXT[checked.reason]("location")), `customer:location_${checked.reason}`);
  const change = await saveStaffLocation({
    businessSlug: slug,
    keys: c.keys,
    location: checked.value,
    setBy: input.senderAuth.senderId,
    messageId: input.whatsappMessageId,
    eventId: input.eventId,
    chatId: c.chatId,
    label: c.label,
  });
  if (change.result === "replayed") return { outbox: [], outcome: "customer:location_replayed" };
  if (change.result === "unchanged") return reply(input, `ℹ️ ${c.label}: *${checked.value}* is already the default delivery location. Nothing changed.`, "customer:location_unchanged");
  await audit(slug, "staff", input.senderJid, "customer_location.set", { type: "customer", id: c.keys.primary }, {
    result: change.result,
    previous: change.previous,
    location: checked.value,
    sender_id: input.senderAuth.senderId,
    message_id: input.whatsappMessageId,
    chat_id: c.chatId,
    memory_id: change.id,
  });
  return reply(input, formatLocationSaved({ label: c.label, location: checked.value, previous: change.previous }), `customer:location_${change.result}`);
}

async function clearLocation(input: CustomerCommandInput, c: ResolvedCustomer): Promise<CustomerCommandResult> {
  const slug = input.settings.business_slug;
  const change = await clearStaffLocation({ businessSlug: slug, keys: c.keys, clearedBy: input.senderAuth.senderId, messageId: input.whatsappMessageId });
  if (change.result === "replayed") return { outbox: [], outcome: "customer:location_clear_replayed" };
  if (change.result === "none") return reply(input, `ℹ️ ${c.label}: no default delivery location is saved. Nothing changed.`, "customer:location_clear_none");
  await audit(slug, "staff", input.senderJid, "customer_location.cleared", { type: "customer", id: c.keys.primary }, {
    previous: change.previous,
    sender_id: input.senderAuth.senderId,
    message_id: input.whatsappMessageId,
    chat_id: c.chatId,
    memory_id: change.id,
  });
  return reply(input, formatLocationCleared({ label: c.label, previous: change.previous }), "customer:location_cleared");
}

// ── !customer ────────────────────────────────────────────────────────────────

async function showCustomer(input: CustomerCommandInput, c: ResolvedCustomer): Promise<CustomerCommandResult> {
  const slug = input.settings.business_slug;
  await expireStale(input);
  const [location, notes, proposed, orders, facts, profile] = await Promise.all([
    loadStaffLocation(slug, c.keys.all),
    loadStaffNotes(slug, c.keys.all, ["active"]),
    loadStaffNotes(slug, c.keys.all, ["proposed"]),
    loadOrders(slug, c.identity, 5).catch(() => []),
    loadFacts(slug, c.identity).catch(() => []),
    loadProfile(slug, c.identity).catch(() => ({})),
  ]);
  const now = Date.now();
  const live = facts.filter((f) => !f.expires_at || Date.parse(f.expires_at) > now);
  const verified = orders.filter((o) => !o.excluded && isVerifiedOrder(o)).slice(0, 3);
  const card: CustomerCard = {
    label: c.name ?? "Customer",
    phone: c.phone,
    location: location ? { value: location.content, at: location.created_at, source: "set by staff" } : null,
    notes: [
      ...notes.map((n) => ({ code: n.short_code, content: n.content, at: n.created_at })),
      ...live.filter((f) => f.kind === "note").map((f) => ({ code: null, content: f.content, at: f.updated_at })),
    ],
    proposed: proposed.map((n) => ({ code: n.short_code, content: n.content })),
    customerSaid: live.filter((f) => f.source === "customer_stated" && (f.kind === "preference" || f.kind === "delivery_preference")).map((f) => f.content),
    resolvedIssues: live.filter((f) => f.kind === "resolved_issue").map((f) => f.content),
    recentOrders: verified.map(describeOrder),
    recentAddresses: [...new Set(verified.map((o) => o.address).filter((a): a is string => Boolean(a)))].slice(0, 3),
    inferences: Object.entries(profile).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
    timeZone: timeZoneOf(input.settings),
  };
  await audit(slug, "staff", input.senderJid, "customer.viewed", { type: "customer", id: c.keys.primary }, { sender_id: input.senderAuth.senderId });
  return reply(input, formatCustomerCard(card), "customer:viewed");
}

// ── !remember ────────────────────────────────────────────────────────────────

/** Expires unconfirmed proposals past the TTL (so they cannot be confirmed, listed, or block a new proposal) and audits each. */
async function expireStale(input: CustomerCommandInput): Promise<void> {
  const slug = input.settings.business_slug;
  for (const n of await expireStaleProposals(slug)) {
    await audit(slug, "system", null, "customer_note.expired", { type: "customer", id: n.customer_key }, { code: n.short_code, ttl_days: PROPOSAL_TTL_DAYS });
  }
}

async function proposeNote(input: CustomerCommandInput, c: ResolvedCustomer, raw: string): Promise<CustomerCommandResult> {
  const slug = input.settings.business_slug;
  await expireStale(input);
  const checked = validateNote(raw);
  if (!checked.ok) return reply(input, CUSTOMER_REPLY.rejected(USAGE.remember, REJECTION_TEXT[checked.reason]("note")), `customer:remember_${checked.reason}`);
  if (looksLikeLocationFact(checked.value)) {
    return reply(input, `⚠️ That sounds like a delivery location. Use !location so the customer has one default, not two:\n!location <customer> <place>\nNothing was saved.`, "customer:remember_use_location");
  }
  const result = await proposeStaffNote({
    businessSlug: slug,
    keys: c.keys,
    content: checked.value,
    setBy: input.senderAuth.senderId,
    messageId: input.whatsappMessageId,
    eventId: input.eventId,
    chatId: c.chatId,
    label: c.label,
    limit: MAX_NOTES_PER_CUSTOMER,
  });
  switch (result.result) {
    case "replayed":
      return { outbox: [], outcome: "customer:remember_replayed" };
    case "limit":
      return reply(input, `⚠️ ${c.label} already has ${MAX_NOTES_PER_CUSTOMER} notes saved or waiting. Remove one first (!remember remove M-CODE — see !customer). Nothing was saved.`, "customer:remember_limit");
    case "duplicate":
      return reply(input, result.status === "active" ? `ℹ️ ${c.label}: that note is already saved${result.code ? ` (${result.code})` : ""}. Nothing changed.` : `ℹ️ ${c.label}: that note is already waiting for you${result.code ? `: !remember confirm ${result.code}` : ""}.`, "customer:remember_duplicate");
  }
  const saved = await loadStaffNotes(slug, c.keys.all, ["active"]);
  await audit(slug, "staff", input.senderJid, "customer_note.proposed", { type: "customer", id: c.keys.primary }, { code: result.code, sender_id: input.senderAuth.senderId, message_id: input.whatsappMessageId, chat_id: c.chatId });
  const lines = [
    `📝 Proposed note for *${c.label}*:`,
    `“${checked.value}”`,
    ...(saved.length > 0 ? ["", "Already saved for them (check it doesn't contradict):", ...saved.slice(0, 3).map((n) => `• ${n.content}`)] : []),
    "",
    `Save it: !remember confirm ${result.code}`,
    `Cancel: !remember discard ${result.code}`,
    `Nothing is saved until you confirm. This proposal expires in ${PROPOSAL_TTL_DAYS} days.`,
  ];
  return reply(input, lines.join("\n"), "customer:remember_proposed");
}

async function reviewNote(input: CustomerCommandInput, command: Extract<CustomerCommand, { kind: "remember_review" }>): Promise<CustomerCommandResult> {
  const slug = input.settings.business_slug;
  const say = (body: string, outcome: string) => reply(input, body, `customer:remember_${outcome}`);
  await expireStale(input);
  const note = await findNoteByCode(slug, command.code);
  // Codes are per business: another business's note is simply "not found" here.
  if (!note) return say(`⚠️ I don't have a note ${command.code} for this business. Nothing changed.`, "unknown_code");
  const who = note.customer_label ?? "this customer";
  const from = command.action === "remove" ? "active" : "proposed";
  const to = command.action === "confirm" ? "active" : command.action === "discard" ? "discarded" : "removed";
  if (note.status !== from) {
    if (note.status === "expired") return say(`⌛ ${command.code} (${who}) expired — it was proposed more than ${PROPOSAL_TTL_DAYS} days ago and was never saved. Propose it again with !remember <customer> <fact>.`, "expired");
    const state = note.status === "active" ? "already saved" : note.status === "proposed" ? "still waiting (use confirm or discard)" : `already ${note.status}`;
    return say(`ℹ️ ${command.code} (${who}) is ${state}. Nothing changed.`, `already_${note.status}`);
  }
  const changed = await transitionNote({ businessSlug: slug, id: note.id, from, to, by: input.senderAuth.senderId });
  if (!changed) return say(`ℹ️ ${command.code} (${who}) was already changed, expired, or an identical note is already saved. Nothing changed.`, "no_change");
  await audit(slug, "staff", input.senderJid, `customer_note.${command.action}`, { type: "customer", id: note.customer_key }, { code: command.code, sender_id: input.senderAuth.senderId, message_id: input.whatsappMessageId });
  const text =
    command.action === "confirm"
      ? `✅ Saved for *${who}*: “${note.content}” (${command.code}). The AI will use it from now on.`
      : command.action === "discard"
        ? `🗑️ Not saved: ${command.code} for ${who} was discarded.`
        : `🗑️ Removed ${command.code} for ${who}: the AI will no longer use “${note.content}”. It stays in the history.`;
  return say(text, command.action === "confirm" ? "confirmed" : command.action === "discard" ? "discarded" : "removed");
}
