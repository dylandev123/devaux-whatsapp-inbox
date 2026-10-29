// Server-only: long-term customer memory, built on the tables that already
// exist rather than a parallel store —
//   customer_orders         verified purchases (permanent, survives the 7-day purge)
//   customer_ai_profile     AI inferences (always labelled unverified)
//   ai_agent_customer_memory  customer-stated preferences + staff-confirmed
//                           resolved issues (the only new table)
// Every query is scoped to one business_slug and to identities the contact
// resolver proved (lib/aiAgent/identity.ts). The rules about what may be
// remembered and how it is labelled live in lib/aiAgent/memory.ts.

import { ChatIdentity } from "@/lib/aiAgent/identity";
import {
  buildMemoryBrief,
  CandidateFact,
  defaultExpiry,
  fingerprintOf,
  MemoryBrief,
  MemoryFactKind,
  MemoryFactRow,
  MemoryFactSource,
  memoryKeysFor,
  OrderRecord,
  orderRecordFromRow,
  primaryMemoryKey,
} from "@/lib/aiAgent/memory";
import { agentDb } from "@/lib/server/aiAgent/db";
import { loadStaffLocationSafe, loadStaffNotesSafe, loadStaffUsualProductSafe } from "@/lib/server/aiAgent/customerStaffMemory";

const ORDER_COLUMNS =
  "id, order_seq, chat_id, summary, order_status, source_message_at, details, delivery_address, ai_memory_excluded";
const FACT_COLUMNS = "id, kind, source, content, evidence, expires_at, last_confirmed_at, updated_at, customer_key";
const PROFILE_COLUMNS = "preferences, common_orders, addresses, payment_habits, important_notes, last_known_intent";

/**
 * Orders for this contact: rows recorded under the contact's VERIFIED phone, or
 * for one of its own chats. Never matched by name, and never by lid digits.
 */
export async function loadOrders(businessSlug: string, identity: ChatIdentity, limit = 12): Promise<OrderRecord[]> {
  const db = agentDb();
  const [byChat, byPhone] = await Promise.all([
    db
      .from("customer_orders")
      .select(ORDER_COLUMNS)
      .eq("business_slug", businessSlug)
      .in("chat_id", identity.chatIds)
      .order("source_message_at", { ascending: false, nullsFirst: false })
      .limit(limit),
    identity.phone
      ? db
          .from("customer_orders")
          .select(ORDER_COLUMNS)
          .eq("business_slug", businessSlug)
          .eq("contact_number", identity.phone)
          .order("source_message_at", { ascending: false, nullsFirst: false })
          .limit(limit)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  // A missing table / column (migration not yet run) degrades to "nothing known".
  const rows = new Map<string, Parameters<typeof orderRecordFromRow>[0]>();
  for (const r of [...(byChat.data ?? []), ...(byPhone.data ?? [])] as Parameters<typeof orderRecordFromRow>[0][]) rows.set(r.id, r);
  return [...rows.values()].map(orderRecordFromRow);
}

export async function loadFacts(businessSlug: string, identity: ChatIdentity): Promise<MemoryFactRow[]> {
  const keys = memoryKeysFor(identity);
  if (keys.length === 0) return [];
  const { data } = await agentDb()
    .from("ai_agent_customer_memory")
    .select(FACT_COLUMNS)
    .eq("business_slug", businessSlug)
    .in("customer_key", keys)
    .order("updated_at", { ascending: false })
    .limit(60);
  return (data ?? []) as MemoryFactRow[];
}

/** The AI-inferred profile. Only looked up for a VERIFIED phone: it is keyed by number alone. */
export async function loadProfile(businessSlug: string, identity: ChatIdentity): Promise<Record<string, string>> {
  if (!identity.phone) return {};
  const { data } = await agentDb()
    .from("customer_ai_profile")
    .select(PROFILE_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("contact_number", identity.phone)
    .maybeSingle();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** The concise, labelled memory for one turn — never whole conversations. */
export async function loadMemoryBrief(businessSlug: string, identity: ChatIdentity, messageText: string): Promise<MemoryBrief> {
  const keys = memoryKeysFor(identity);
  // Staff-saved memory (!location, !remember) is READ whatever customer_memory_enabled says: that switch only gates
  // what the AI captures by itself. A missing table (migration not yet run) is "nothing saved".
  const [orders, facts, profile, staffLocation, staffNotes, staffUsual] = await Promise.all([
    loadOrders(businessSlug, identity),
    loadFacts(businessSlug, identity),
    loadProfile(businessSlug, identity),
    loadStaffLocationSafe(businessSlug, keys),
    loadStaffNotesSafe(businessSlug, keys),
    loadStaffUsualProductSafe(businessSlug, keys),
  ]);
  // Even with nothing on record "same as last time" is resolved, so an empty
  // history escalates instead of being guessed.
  return buildMemoryBrief({
    orders,
    facts,
    profile,
    messageText,
    now: new Date(),
    staffMemory: { location: staffLocation ? { value: staffLocation.content, setAt: staffLocation.created_at } : null, notes: staffNotes.map((n) => n.content), usualProduct: staffUsual?.content ?? null },
  });
}

/** Stores validated customer-stated facts. A fact that already exists is left exactly as it is. */
export async function saveCustomerFacts(input: {
  businessSlug: string;
  chatId: string;
  identity: ChatIdentity;
  messageId: string | null;
  facts: CandidateFact[];
}): Promise<number> {
  if (input.facts.length === 0) return 0;
  const customerKey = primaryMemoryKey(input.chatId, input.identity);
  const expires = defaultExpiry(new Date());
  const { data, error } = await agentDb()
    .from("ai_agent_customer_memory")
    .upsert(
      input.facts.map((f) => ({
        business_slug: input.businessSlug,
        customer_key: customerKey,
        kind: f.kind,
        source: "customer_stated",
        content: f.content.slice(0, 300),
        evidence: f.evidence.slice(0, 500),
        fingerprint: fingerprintOf(f.content),
        source_chat_id: input.chatId,
        source_message_id: input.messageId,
        expires_at: expires,
      })),
      { onConflict: "business_slug,customer_key,kind,fingerprint", ignoreDuplicates: true }
    )
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/** A staff-closed escalation becomes a short "resolved earlier" note about that customer. */
export async function recordResolvedIssue(input: {
  businessSlug: string;
  chatId: string;
  identity: ChatIdentity;
  escalationId: string;
  refCode: string;
  text: string;
}): Promise<void> {
  const content = input.text.replace(/\s+/g, " ").trim().slice(0, 280);
  if (!content) return;
  const { error } = await agentDb()
    .from("ai_agent_customer_memory")
    .upsert(
      {
        business_slug: input.businessSlug,
        customer_key: primaryMemoryKey(input.chatId, input.identity),
        kind: "resolved_issue",
        source: "staff_confirmed",
        content: `#${input.refCode}: ${content}`.slice(0, 300),
        fingerprint: `escalation:${input.escalationId}`,
        source_chat_id: input.chatId,
        source_escalation_id: input.escalationId,
        expires_at: defaultExpiry(new Date()),
      },
      { onConflict: "business_slug,customer_key,kind,fingerprint", ignoreDuplicates: true }
    );
  if (error) console.error("[aiAgent] recordResolvedIssue", error.message);
}

/**
 * A customer-specific fact staff supplied in the staff group (a verified
 * purchase, a confirmed preference, a delivery instruction). Staff-confirmed by
 * definition, stored under THIS customer's key only, and shown to the model as
 * a "Staff note". Returns false when it was already on record.
 */
export async function recordStaffCustomerFact(input: {
  businessSlug: string;
  chatId: string;
  identity: ChatIdentity;
  escalationId: string;
  refCode: string;
  content: string;
  evidence: string;
}): Promise<boolean> {
  const content = input.content.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!content) return false;
  const { data, error } = await agentDb()
    .from("ai_agent_customer_memory")
    .upsert(
      {
        business_slug: input.businessSlug,
        customer_key: primaryMemoryKey(input.chatId, input.identity),
        kind: "note",
        source: "staff_confirmed" satisfies MemoryFactSource,
        content,
        evidence: input.evidence.slice(0, 500),
        fingerprint: fingerprintOf(content),
        source_chat_id: input.chatId,
        source_escalation_id: input.escalationId,
        expires_at: defaultExpiry(new Date()),
      },
      { onConflict: "business_slug,customer_key,kind,fingerprint", ignoreDuplicates: true }
    )
    .select("id");
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

// ── Admin: inspect, correct, delete ──────────────────────────────────────────

export interface CustomerMemoryView {
  identity: { chatId: string; phone: string | null; chatIds: string[]; unresolvedLid: boolean };
  customerKey: string;
  orders: (OrderRecord & { verified: boolean })[];
  facts: (MemoryFactRow & { customer_key: string })[];
  inferences: Record<string, string>;
  openOrderRequests: { id: string; status: string; items: unknown; updated_at: string }[];
}

export async function loadCustomerMemoryView(businessSlug: string, chatId: string, identity: ChatIdentity): Promise<CustomerMemoryView> {
  const [orders, facts, inferences, requests] = await Promise.all([
    loadOrders(businessSlug, identity, 30),
    loadFacts(businessSlug, identity),
    loadProfile(businessSlug, identity),
    agentDb()
      .from("ai_agent_order_requests")
      .select("id, status, items, updated_at")
      .eq("business_slug", businessSlug)
      .in("chat_id", identity.chatIds)
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);
  return {
    identity: { chatId, phone: identity.phone, chatIds: identity.chatIds, unresolvedLid: identity.unresolvedLid },
    customerKey: primaryMemoryKey(chatId, identity),
    orders: orders
      .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0))
      .map((o) => ({ ...o, verified: o.status === "Added" || o.status === "Completed" })),
    facts: facts as (MemoryFactRow & { customer_key: string })[],
    inferences,
    openOrderRequests: (requests.data ?? []) as CustomerMemoryView["openOrderRequests"],
  };
}

/** Facts and order exclusions are only ever touched through keys/chats the contact resolver proved. */
export function ownsKey(identity: ChatIdentity, key: string): boolean {
  return memoryKeysFor(identity).includes(key);
}

export async function addAdminFact(input: {
  businessSlug: string;
  customerKey: string;
  kind: MemoryFactKind;
  content: string;
  chatId: string;
  adminId: string;
  expiresAt: string | null;
}): Promise<MemoryFactRow> {
  const { data, error } = await agentDb()
    .from("ai_agent_customer_memory")
    .insert({
      business_slug: input.businessSlug,
      customer_key: input.customerKey,
      kind: input.kind,
      source: "admin" satisfies MemoryFactSource,
      content: input.content,
      fingerprint: fingerprintOf(input.content),
      source_chat_id: input.chatId,
      expires_at: input.expiresAt,
      created_by: input.adminId,
    })
    .select(FACT_COLUMNS)
    .single();
  if (error) throw new Error(error.code === "23505" ? "That fact is already recorded" : error.message);
  return data as MemoryFactRow;
}

export async function updateFact(businessSlug: string, id: string, content: string, adminId: string): Promise<MemoryFactRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_customer_memory")
    .update({
      content,
      fingerprint: fingerprintOf(content),
      // A corrected fact is now the admin's word, not the customer's quote.
      source: "admin",
      evidence: null,
      last_confirmed_at: new Date().toISOString(),
      created_by: adminId,
    })
    .eq("id", id)
    .eq("business_slug", businessSlug)
    .select(FACT_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.code === "23505" ? "That fact is already recorded" : error.message);
  return (data as MemoryFactRow | null) ?? null;
}

export async function deleteFact(businessSlug: string, id: string): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_customer_memory")
    .delete()
    .eq("id", id)
    .eq("business_slug", businessSlug)
    .select("id");
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

export async function setOrderExcluded(businessSlug: string, orderId: string, chatIds: string[], phone: string | null, excluded: boolean): Promise<boolean> {
  // The order must belong to this business AND to this contact's own chats / verified phone.
  const db = agentDb();
  const { data: row, error } = await db
    .from("customer_orders")
    .select("id, chat_id, contact_number")
    .eq("id", orderId)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return false;
  const mine = chatIds.includes(row.chat_id) || (phone !== null && row.contact_number === phone);
  if (!mine) return false;
  const { error: updateError } = await db
    .from("customer_orders")
    .update({ ai_memory_excluded: excluded })
    .eq("id", orderId)
    .eq("business_slug", businessSlug);
  if (updateError) throw new Error(updateError.message);
  return true;
}

export async function clearInferences(businessSlug: string, identity: ChatIdentity, fields: string[]): Promise<boolean> {
  if (!identity.phone) return false;
  const allowed = ["preferences", "common_orders", "addresses", "payment_habits", "important_notes", "last_known_intent"];
  const patch: Record<string, null> = {};
  for (const f of fields) if (allowed.includes(f)) patch[f] = null;
  if (Object.keys(patch).length === 0) return false;
  const { error } = await agentDb()
    .from("customer_ai_profile")
    .update(patch)
    .eq("business_slug", businessSlug)
    .eq("contact_number", identity.phone);
  if (error) throw new Error(error.message);
  return true;
}

export interface ForgetResult {
  memory: number;
  profile: number;
  batches: number;
  orders: number;
  logs: number;
}

/** Customer data deletion: one transaction in SQL, scoped to this business and this contact. */
export async function forgetCustomer(
  businessSlug: string,
  identity: ChatIdentity,
  options: { includeOrders: boolean; includeLogs: boolean }
): Promise<ForgetResult> {
  const { data, error } = await agentDb().rpc("forget_ai_agent_customer", {
    p_business_slug: businessSlug,
    p_chat_ids: identity.chatIds,
    p_phone: identity.phone,
    p_include_orders: options.includeOrders,
    p_include_logs: options.includeLogs,
  });
  if (error) throw new Error(error.message);
  return data as ForgetResult;
}
