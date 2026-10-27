// Server-only: daily order tracking. The database (ai_agent_orders, written only through apply_ai_agent_order) is
// the single source of truth; every report is rebuilt from it at send time, never from stored AI text.
//
//   * trackOrders()        folds one customer turn's model draft into the orders (no extra model call).
//   * updateOrderManually  staff corrections, confirmation, fulfilment, cancellation (audited).
//   * runDueOrderSummaries the 8 AM job (idempotent per business per local day; safe to call from anywhere).
//   * handleUpdateCommand  "!update" in the orders group.
//
// Nothing here ever creates a customer-bound message: the only outbox rows are order summaries and refusals
// addressed to the orders / staff group.

import { randomBytes } from "crypto";
import {
  AgentSettings,
  canPostOrderSummary,
  type OrderItem,
  generateRefCode,
  hasSeparateOrdersGroup,
  ordersGroupJid,
  OrderRequestDraft,
  outboxAllowed,
} from "@/lib/aiAgent/engine";
import { groundOrderDraft, quantityStated } from "@/lib/aiAgent/escalationUpdates";
import { SenderAuthorization } from "@/lib/aiAgent/identity";
import {
  moreInfoReply,
  type OrderCommand,
  ORDER_HELP,
  ORDER_REPLY,
  resolveSelector,
  searchOrders,
  searchReply,
} from "@/lib/aiAgent/orderCommands";
import {
  acceptModelHistoryLine,
  cueActive,
  detectHistoryCue,
  type HistoryFill,
  type HistoryOrder,
  HISTORY_LOAD_LIMIT,
  reliableHistory,
  resolveFromHistory,
  upgradeGenericLines,
} from "@/lib/aiAgent/orderHistory";
import { loadStaffLocationSafe } from "@/lib/server/aiAgent/customerStaffMemory";
import { anchorRequestedFor, applyQuantityAdjustments, guardRemovedItems, messageTimeFor, quantityAdjustments, refineOrderDraft, statedThisTurn } from "@/lib/aiAgent/orderText";
import {
  buildOrderSummary,
  type Coverage,
  computeMissing,
  DEFAULT_ORDERS_TIMEZONE,
  DEFAULT_SUMMARY_HOUR,
  EDITABLE_ORDER_FIELDS,
  EditableOrderField,
  FieldChange,
  type FieldConflicts,
  fulfilmentMethod,
  groundDeliveryPreference,
  isComplete,
  isOpenStatus,
  isWholeOrderCancellation,
  localParts,
  mergeDraft,
  MISSING_TEXT,
  OPEN_ORDER_STATUSES,
  type OrderNames,
  OrderFields,
  OrderLine,
  OrderStatus,
  pickCustomerName,
  planOrderUpdate,
  resolveOrderTarget,
  sameLineProduct,
  scheduleState,
  toLine,
  TrackedOrder,
  turnDrafts,
  turnIsConfirmation,
} from "@/lib/aiAgent/orders";
import { MONITOR_BUDGET_REASON, MONITOR_FAILED_REASONS, MONITOR_FILTERED_PREFIX, MONITOR_GATE_REASONS, monitorEligibleChat, type StaffAction, staffFlagFor } from "@/lib/aiAgent/orderMonitor";
import { BLOCK_REASONS, failureReason, outboxState } from "@/lib/aiAgent/outboxStatus";
import { agentDb, audit, loadSettings } from "@/lib/server/aiAgent/db";
import { enqueue, OutboxInsert, OutboxRow } from "@/lib/server/aiAgent/outbox";
import { businessLabel, isOutbound } from "@/lib/whatsapp";

export const ORDER_COLUMNS =
  "id, ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_preference, delivery_address, requested_for, notes, missing_fields, attention, source_message_ids, first_message_at, last_message_at, awaiting_since, manual_locked_fields, field_conflicts, confirmed_by, confirmed_at, customer_confirmed_at, cancelled_at, cancel_reason, fulfilled_at, version, created_at, updated_at";

const MAX_SOURCE_IDS = 50;
const MAX_ATTEMPTS = 3;
const RESUME_AFTER_MS = 2 * 60_000;
const MANUAL_COOLDOWN_MS = 30_000;

// ── Reading ──────────────────────────────────────────────────────────────────

export async function loadOpenOrders(businessSlug: string, chatId: string): Promise<TrackedOrder[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_orders")
    .select(ORDER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .in("status", [...OPEN_ORDER_STATUSES])
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as TrackedOrder[];
}

/** What !moreinfo and the dashboard show about a chat's orders: the open ones plus anything cancelled in the last week. */
export async function loadChatOrdersForInfo(businessSlug: string, chatId: string, now: Date = new Date()): Promise<{ orders: TrackedOrder[]; events: { order_id: string; kind: string; actor_kind: string; changes: Record<string, { before?: unknown; after?: unknown }>; created_at: string }[] }> {
  const db = agentDb();
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  const [open, cancelled] = await Promise.all([
    db.from("ai_agent_orders").select(ORDER_COLUMNS).eq("business_slug", businessSlug).eq("chat_id", chatId).in("status", [...OPEN_ORDER_STATUSES]).order("created_at").limit(10),
    db.from("ai_agent_orders").select(ORDER_COLUMNS).eq("business_slug", businessSlug).eq("chat_id", chatId).eq("status", "cancelled").gte("updated_at", since).order("created_at").limit(5),
  ]);
  if (open.error) throw new Error(open.error.message);
  if (cancelled.error) throw new Error(cancelled.error.message);
  const orders = [...((open.data ?? []) as TrackedOrder[]), ...((cancelled.data ?? []) as TrackedOrder[])];
  if (orders.length === 0) return { orders, events: [] };
  const ev = await db
    .from("ai_agent_order_events")
    .select("order_id, kind, actor_kind, changes, created_at")
    .eq("business_slug", businessSlug)
    .in("order_id", orders.map((o) => o.id))
    .order("created_at", { ascending: false })
    .limit(12);
  if (ev.error) throw new Error(ev.error.message);
  return { orders, events: (ev.data ?? []) as never };
}

/** Every outstanding order of ONE business. The slug filter is the isolation boundary. */
export async function loadOutstandingOrders(businessSlug: string): Promise<TrackedOrder[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_orders")
    .select(ORDER_COLUMNS)
    .eq("business_slug", businessSlug)
    .in("status", [...OPEN_ORDER_STATUSES])
    .order("first_message_at")
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as TrackedOrder[];
}

/**
 * The customer's own earlier orders, newest first, bounded: the business's rows for this chat, its known @lid/phone chats
 * and (only when verified) this phone number. The business filter is the isolation boundary; a customer is never matched
 * by name, and an unverified @lid only ever matches its own chat.
 */
export async function loadCustomerHistory(businessSlug: string, chatIds: string[], phone: string | null): Promise<HistoryOrder[]> {
  const columns = "id, ref_code, status, items, fulfilment_method, delivery_address, manual_locked_fields, last_message_at";
  const base = () =>
    agentDb().from("ai_agent_orders").select(columns).eq("business_slug", businessSlug).neq("status", "cancelled").order("last_message_at", { ascending: false }).limit(HISTORY_LOAD_LIMIT);
  const [byChat, byPhone] = await Promise.all([
    chatIds.length > 0 ? base().in("chat_id", chatIds.slice(0, 10)) : Promise.resolve({ data: [], error: null }),
    phone ? base().eq("contact_number", phone) : Promise.resolve({ data: [], error: null }),
  ]);
  if (byChat.error) throw new Error(byChat.error.message);
  if (byPhone.error) throw new Error(byPhone.error.message);
  const rows = new Map<string, HistoryOrder>();
  for (const r of [...(byChat.data ?? []), ...(byPhone.data ?? [])] as unknown as HistoryOrder[]) rows.set(r.id, r);
  return [...rows.values()].sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at)).slice(0, HISTORY_LOAD_LIMIT);
}

/** What the model sees of the customer's open orders. */
export function ordersForModel(orders: TrackedOrder[]): unknown[] {
  return orders.map((o) => ({
    ref: o.ref_code,
    status: o.status,
    items: o.items.map((i) => ({ product: i.product, quantity: i.quantity, variant: i.variant, size: i.size })),
    delivery_preference: o.delivery_preference ?? o.fulfilment_method,
    delivery_address: o.delivery_address,
    requested_for: o.requested_for,
    notes: o.notes,
  }));
}

export interface OrderFilter {
  status?: "open" | "all" | OrderStatus;
  q?: string;
  limit?: number;
}

export async function listOrders(businessSlug: string, filter: OrderFilter = {}): Promise<TrackedOrder[]> {
  let query = agentDb().from("ai_agent_orders").select(ORDER_COLUMNS).eq("business_slug", businessSlug);
  const status = filter.status ?? "open";
  if (status === "open") query = query.in("status", [...OPEN_ORDER_STATUSES]);
  else if (status !== "all") query = query.eq("status", status);
  const q = (filter.q ?? "").trim().replace(/[%,()*]/g, " ").slice(0, 80);
  if (q) {
    const like = `%${q}%`;
    query = query.or(`customer_name.ilike.${like},contact_number.ilike.${like},ref_code.ilike.${like},notes.ilike.${like},delivery_address.ilike.${like},chat_id.ilike.${like}`);
  }
  const { data, error } = await query.order("updated_at", { ascending: false }).limit(Math.min(filter.limit ?? 200, 500));
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as TrackedOrder[];
  // Product names live inside the items JSON: filter them here (the page is already business-scoped and capped).
  if (q) {
    const needle = q.toLowerCase();
    const inItems = await agentDb()
      .from("ai_agent_orders")
      .select(ORDER_COLUMNS)
      .eq("business_slug", businessSlug)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (!inItems.error) {
      const extra = ((inItems.data ?? []) as TrackedOrder[]).filter(
        (o) =>
          (status === "all" || (status === "open" ? isOpenStatus(o.status) : o.status === status)) &&
          o.items.some((i) => `${i.product} ${i.variant ?? ""} ${i.size ?? ""}`.toLowerCase().includes(needle)) &&
          !rows.some((r) => r.id === o.id)
      );
      rows = [...rows, ...extra];
    }
  }
  return rows;
}

export async function listOrderEvents(businessSlug: string, orderId: string) {
  const { data, error } = await agentDb()
    .from("ai_agent_order_events")
    .select("id, kind, actor_kind, actor_id, changes, whatsapp_message_ids, created_at")
    .eq("business_slug", businessSlug)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ── Customer names ───────────────────────────────────────────────────────────

/**
 * The best name for each order, read fresh from what the bridge and the Inbox already store (no copy to go stale):
 * a name staff entered (on the order, or on the customer's profile) first, then the name saved for the contact on the
 * business phone (customers / whatsapp_messages.business_contact_name), then the customer's own WhatsApp profile name
 * (pushName). Unreliable values (numbers, JIDs, placeholders, symbols only) never win; the phone is the fallback.
 * One query per source for the whole list, all scoped to the business.
 */
export async function loadOrderNames(businessSlug: string, orders: TrackedOrder[]): Promise<OrderNames> {
  const names: OrderNames = {};
  if (orders.length === 0) return names;
  const db = agentDb();
  const phones = unique(orders.map((o) => o.contact_number).filter((p): p is string => Boolean(p)));
  const chats = unique(orders.map((o) => o.chat_id));
  const recent = (column: "business_contact_name" | "contact_name") =>
    db
      .from("whatsapp_messages")
      .select(`chat_id, ${column}, timestamp`)
      .eq("business_slug", businessSlug)
      .in("chat_id", chats)
      .not(column, "is", null)
      .order("timestamp", { ascending: false })
      .limit(1000);
  const [customers, savedRows, profileRows] = await Promise.all([
    phones.length > 0
      ? db.from("customers").select("phone_number, first_name, last_name, whatsapp_name, business_contact_name").in("phone_number", phones)
      : Promise.resolve({ data: [] as never[], error: null }),
    recent("business_contact_name"),
    recent("contact_name"),
  ]);
  // A missing table or a failed lookup degrades to "no name known", never to a failed report.
  const byPhone = new Map<string, { crm: string; saved: string | null; profile: string | null }>();
  for (const c of customers.error ? [] : (customers.data ?? [])) {
    byPhone.set(c.phone_number as string, {
      crm: [c.first_name, c.last_name].filter(Boolean).join(" "),
      saved: (c.business_contact_name as string | null) ?? null,
      profile: (c.whatsapp_name as string | null) ?? null,
    });
  }
  const savedByChat = new Map<string, string>();
  const profileByChat = new Map<string, string>();
  for (const m of savedRows.error ? [] : (savedRows.data ?? [])) {
    const row = m as unknown as { chat_id: string; business_contact_name: string };
    if (!savedByChat.has(row.chat_id)) savedByChat.set(row.chat_id, row.business_contact_name);
  }
  for (const m of profileRows.error ? [] : (profileRows.data ?? [])) {
    const row = m as unknown as { chat_id: string; contact_name: string };
    if (!profileByChat.has(row.chat_id)) profileByChat.set(row.chat_id, row.contact_name);
  }
  for (const o of orders) {
    const c = o.contact_number ? byPhone.get(o.contact_number) : undefined;
    names[o.id] = pickCustomerName({
      orderNameLocked: o.manual_locked_fields.includes("customer_name") ? o.customer_name : null,
      crmName: c?.crm,
      savedName: c?.saved ?? savedByChat.get(o.chat_id),
      profileName: c?.profile ?? profileByChat.get(o.chat_id),
      orderName: o.customer_name,
    });
  }
  return names;
}

// ── Writing ──────────────────────────────────────────────────────────────────

const fieldsOf = (o: TrackedOrder): OrderFields => ({
  customer_name: o.customer_name,
  items: o.items,
  fulfilment_method: o.fulfilment_method,
  delivery_preference: o.delivery_preference,
  delivery_address: o.delivery_address,
  requested_for: o.requested_for,
  notes: o.notes,
});

const asDraft = (o: TrackedOrder): OrderRequestDraft => ({
  items: o.items.map((i) => ({
    product: i.product,
    quantity: i.quantity,
    ...(i.variant ? { variant: i.variant } : {}),
    ...(i.size ? { size: i.size } : {}),
  })),
  delivery_address: o.delivery_address,
  delivery_preference: o.delivery_preference ?? o.fulfilment_method,
  notes: o.notes,
  ...(o.requested_for ? { requested_for: o.requested_for } : {}),
});

type OrderRow = Omit<TrackedOrder, "id" | "business_slug" | "version" | "created_at" | "updated_at">;

interface ApplyArgs {
  businessSlug: string;
  key: string | null;
  existing: TrackedOrder | null;
  row: OrderRow;
  event: string;
  actorKind: "ai" | "customer" | "admin" | "staff" | "system";
  actorId: string | null;
  changes: Record<string, unknown>;
  messageIds: string[];
}

type ApplyResult = { result: "applied" | "duplicate" | "conflict" | "not_found"; orderId: string | null };

async function applyOrder(a: ApplyArgs): Promise<ApplyResult> {
  const { data, error } = await agentDb().rpc("apply_ai_agent_order", {
    p_key: a.key,
    p_business_slug: a.businessSlug,
    p_order_id: a.existing?.id ?? null,
    p_expected_version: a.existing?.version ?? 0,
    p_row: a.row,
    p_event_kind: a.event,
    p_actor_kind: a.actorKind,
    p_actor_id: a.actorId,
    p_changes: a.changes,
    p_message_ids: a.messageIds,
  });
  if (error) {
    // A concurrent writer took the same idempotency key between our check and insert: that is a duplicate.
    if (error.code === "23505" && a.key && (await keyExists(a.key))) return { result: "duplicate", orderId: null };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  const row = (Array.isArray(data) ? data[0] : data) as { result: ApplyResult["result"]; order_id: string | null } | undefined;
  if (!row) throw new Error("apply_ai_agent_order returned nothing");
  return { result: row.result, orderId: row.order_id };
}

async function keyExists(key: string): Promise<boolean> {
  const { data } = await agentDb().from("ai_agent_order_events").select("id").eq("idempotency_key", key).limit(1);
  return (data ?? []).length > 0;
}

const newRef = () => generateRefCode(randomBytes(5)).replace(/^E-/, "O-");

/** Creates with a fresh reference, retrying the (rare) reference collision. */
async function createOrder(a: Omit<ApplyArgs, "existing">): Promise<ApplyResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await applyOrder({ ...a, existing: null, row: { ...a.row, ref_code: newRef() } });
    } catch (err) {
      if ((err as { code?: string }).code === "23505" && !(a.key && (await keyExists(a.key)))) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate an order reference");
}

const unique = (list: string[]) => [...new Set(list)];

function rowFrom(
  existing: TrackedOrder | null,
  fields: OrderFields,
  plan: ReturnType<typeof planOrderUpdate>,
  ctx: { chatId: string; phone: string | null; messageIds: string[]; firstAt: string; lastAt: string; locked?: string[]; conflicts?: FieldConflicts }
): OrderRow {
  const confirmed = plan.status === "confirmed";
  return {
    ref_code: existing?.ref_code ?? "",
    chat_id: ctx.chatId,
    contact_number: ctx.phone ?? existing?.contact_number ?? null,
    customer_name: fields.customer_name,
    status: plan.status,
    items: fields.items,
    fulfilment_method: fields.fulfilment_method,
    delivery_preference: fields.delivery_preference,
    delivery_address: fields.delivery_address,
    requested_for: fields.requested_for,
    notes: fields.notes,
    missing_fields: plan.missing,
    attention: plan.attention,
    source_message_ids: unique([...(existing?.source_message_ids ?? []), ...ctx.messageIds]).slice(-MAX_SOURCE_IDS),
    first_message_at: existing?.first_message_at ?? ctx.firstAt,
    last_message_at: ctx.lastAt,
    awaiting_since: plan.awaitingSince,
    manual_locked_fields: ctx.locked ?? existing?.manual_locked_fields ?? [],
    field_conflicts: ctx.conflicts ?? existing?.field_conflicts ?? {},
    confirmed_by: confirmed ? (plan.confirmedByCustomer ? "customer" : (existing?.confirmed_by ?? null)) : null,
    confirmed_at: confirmed ? (plan.confirmedByCustomer ? ctx.lastAt : (existing?.confirmed_at ?? null)) : null,
    customer_confirmed_at: plan.customerConfirmedAt,
    cancelled_at: plan.status === "cancelled" ? ctx.lastAt : null,
    cancel_reason: plan.status === "cancelled" ? "customer_request" : null,
    fulfilled_at: null,
  };
}

const diff = (changes: FieldChange[]) => Object.fromEntries(changes.map((c) => [c.field, { before: c.before, after: c.after }]));

/**
 * Something was sent to the customer, by a PERSON, after the order became complete: so there was something for
 * the customer to say yes to. The agent's own automatic replies do not count.
 */
async function personWroteSince(businessSlug: string, chatId: string, awaitingSince: string | null, now: Date): Promise<boolean> {
  if (!awaitingSince) return false;
  // Only a recent message can be what the customer is answering.
  const sinceIso = new Date(Math.max(Date.parse(awaitingSince), now.getTime() - 48 * 3_600_000)).toISOString();
  const db = agentDb();
  const [msgs, aiSends, relays] = await Promise.all([
    db
      .from("whatsapp_messages")
      .select("whatsapp_message_id, message_body")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .ilike("direction", "%out%")
      .gt("timestamp", sinceIso)
      .limit(30),
    db
      .from("ai_agent_outbox")
      .select("whatsapp_message_id, body")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .in("kind", ["customer_reply", "holding_reply"])
      .gte("created_at", new Date(Date.parse(sinceIso) - 60 * 60_000).toISOString()),
    db
      .from("ai_agent_outbox")
      .select("id")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .eq("kind", "staff_relay")
      .eq("status", "sent")
      .gt("created_at", sinceIso)
      .limit(1),
  ]);
  if (msgs.error) throw new Error(msgs.error.message);
  if ((relays.data ?? []).length > 0) return true;
  const aiIds = new Set((aiSends.data ?? []).map((o) => o.whatsapp_message_id).filter(Boolean));
  const aiBodies = new Set((aiSends.data ?? []).map((o) => (o.body as string).trim()));
  return (msgs.data ?? []).some((m) => !aiIds.has(m.whatsapp_message_id) && !aiBodies.has(((m.message_body as string) ?? "").trim()));
}

export interface TrackArgs {
  settings: AgentSettings;
  businessSlug: string;
  chatId: string;
  /** Verified phone digits (never an @lid's digits) or null. */
  phone: string | null;
  customerName: string | null;
  intent: string | null;
  /** The model's raw drafts for this turn (before the legacy request grounding). */
  proposal: Parameters<typeof turnDrafts>[0] | null;
  /** The customer's messages in this turn, verbatim. */
  segments: string[];
  /** When each of `segments` was written (same order). Relative dates ("tomorrow") count from these, not from "now". */
  segmentTimes?: string[];
  /** The customer's recent words, for grounding. */
  customerWords: string[];
  messageIds: string[];
  firstAt: string;
  lastAt: string;
  /** Prefix of the idempotency keys: the batch or event id. A retried turn reuses it. */
  dedupeBase: string;
  /** False when replaying history (backfill): a "yes" then is not an answer to anything staff just wrote, so it records nothing. Default true. */
  allowConfirmation?: boolean;
  /** Every chat id known to be this customer (ChatIdentity.chatIds), for the order memory. Defaults to this chat. */
  chatIds?: string[];
  /** The customer's earlier orders (loadCustomerHistory), when the caller already loaded them for the model. null/undefined = load only if the customer points back at one. */
  history?: HistoryOrder[] | null;
  /** False when replaying (backfill): history from "now" must not leak into a past turn. Default true. */
  useHistory?: boolean;
  now?: Date;
}

export interface TrackResult {
  applied: number;
  reasons: string[];
}

const cleanName = (name: string | null, chatId: string) => {
  const n = (name ?? "").trim();
  return n && n !== chatId && !/^\+?[\d\s@.:a-z-]*@(s\.whatsapp\.net|lid|c\.us)$/i.test(n) && !/^\+?[\d\s()-]{7,}$/.test(n) ? n.slice(0, 120) : null;
};

/**
 * Folds one customer turn into the customer's orders. Idempotent per `dedupeBase`: running the same turn twice
 * (a batch retry) changes nothing the second time. Confirmation comes only from the customer's own unambiguous
 * words (see planOrderUpdate); the model's text never confirms anything.
 */
export async function trackOrders(args: TrackArgs): Promise<TrackResult> {
  const now = args.now ?? new Date();
  const result: TrackResult = { applied: 0, reasons: [] };
  const { businessSlug, chatId, segments } = args;
  const name = cleanName(args.customerName, chatId);
  const drafts = args.proposal ? turnDrafts(args.proposal) : [];
  const ctx = { chatId, phone: args.phone, messageIds: args.messageIds, firstAt: args.firstAt, lastAt: args.lastAt };
  const tz = tzOf(args.settings);

  const write = async (key: string, existing: TrackedOrder | null, build: (current: TrackedOrder | null) => { row: OrderRow; event: string; actorKind: "ai" | "customer"; changes: Record<string, unknown> } | null) => {
    let current = existing;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const built = build(current);
      if (!built) return;
      const common = { businessSlug, key, event: built.event, actorKind: built.actorKind, actorId: null, changes: built.changes, messageIds: args.messageIds };
      const res = current ? await applyOrder({ ...common, existing: current, row: built.row }) : await createOrder({ ...common, row: built.row });
      if (res.result === "applied") {
        result.applied += 1;
        return;
      }
      if (res.result === "duplicate" || res.result === "not_found") return;
      // conflict: someone else (staff) changed the order meanwhile. Re-read and merge again.
      current = (await loadOpenOrders(businessSlug, chatId)).find((o) => o.id === current!.id) ?? null;
      if (!current) return;
    }
    result.reasons.push("order_write_conflict");
  };

  let open = await loadOpenOrders(businessSlug, chatId);

  // 1. A customer's yes. It is attributed to an order only when there is exactly ONE open order in the chat and it
  //    is complete and awaiting confirmation: with anything else open, "yes" could mean any of them, so nothing
  //    changes (the model's guess at which order is meant is deliberately not trusted for this). It needs a
  //    person's message to the customer after the order became complete, within the last 48 hours. And unless the
  //    business has switched on customer confirmation, the yes is only RECORDED for staff to verify.
  if (turnIsConfirmation(segments)) {
    if (args.allowConfirmation === false) {
      result.reasons.push("order_confirmation_not_accepted");
      return result;
    }
    const target = open.length === 1 && open[0].status === "awaiting_confirmation" && isComplete(open[0].missing_fields) ? open[0] : null;
    if (!target) {
      result.reasons.push(open.length > 1 ? "order_confirmation_ambiguous" : "order_confirmation_not_accepted");
      return result;
    }
    const outbound = await personWroteSince(businessSlug, chatId, target.awaiting_since, now);
    const mayConfirm = args.settings.orders_customer_confirms === true;
    const plan = planOrderUpdate({ existing: target, fields: fieldsOf(target), contentChanged: false, customerTexts: segments, outboundSinceAwaiting: outbound, customerMayConfirm: mayConfirm, now });
    if (plan.event !== "customer_confirmed" && plan.event !== "customer_replied_yes") {
      result.reasons.push("order_confirmation_not_accepted");
      return result;
    }
    await write(`${args.dedupeBase}:confirm`, target, (cur) =>
      cur && cur.status === "awaiting_confirmation"
        ? {
            row: rowFrom(cur, fieldsOf(cur), { ...plan, missing: computeMissing(fieldsOf(cur)) }, ctx),
            event: plan.event,
            actorKind: "customer",
            changes: { status: { before: cur.status, after: plan.status }, customer_confirmed_at: { before: cur.customer_confirmed_at, after: plan.customerConfirmedAt } },
          }
        : null
    );
    if (result.applied) result.reasons.push(mayConfirm ? "order_confirmed_by_customer" : "order_customer_replied_yes");
    return result;
  }

  // 2. Orders the customer is building. A question about products is not an order unless one is already open.
  let withItems = drafts.filter((d) => d.draft.items.length > 0 && (args.intent === "order" || open.length > 0));

  // Customer order memory: "same as last time", "the usual", "same location" point at the customer's own earlier orders.
  // A question ("is it the usual price?") never edits an order: the model must call the turn an order, or say nothing and ask nothing.
  const asks = segments.some((t) => t.includes("?"));
  const intentOk = args.intent === "order" || (args.intent == null && !asks);
  const cue = args.useHistory === false || !intentOk ? detectHistoryCue([]) : detectHistoryCue(segments);
  const pointsBack = cueActive(cue);
  let history: HistoryOrder[] = args.useHistory === false ? [] : (args.history ?? []);
  if (args.useHistory !== false && args.history === undefined && pointsBack) {
    history = await loadCustomerHistory(businessSlug, args.chatIds ?? [chatId], args.phone).catch(() => []);
  }
  // The staff-saved default delivery location answers "same place" / "usual location" before any earlier order does.
  // Read-only here: nothing in the order flow can change it (only the staff !location command does).
  const savedLocation = cue.sameLocation ? await loadStaffLocationSafe(businessSlug, [...(args.phone ? [args.phone] : []), ...(args.chatIds ?? [chatId]).map((id) => `chat:${id}`)]) : null;

  // A turn that only points back ("same as last time") or only adjusts a quantity ("another bag") has no draft of its own:
  // it still updates the order, from the customer's records and words.
  if (withItems.length === 0 && !segments.some(isWholeOrderCancellation) && (pointsBack || (!asks && quantityAdjustments(segments).length > 0 && open.length > 0))) {
    withItems = [{ target: args.proposal?.order_target ?? null, draft: { items: [], delivery_address: null, delivery_preference: null, notes: null } }];
  }
  if (withItems.length === 0) {
    // 3. No products this turn: a cancellation can still arrive ("cancel my order").
    if (!segments.some((t) => /\bcancel\w*\b/i.test(t))) return result;
    const named = args.proposal?.order_target ? open.find((o) => o.ref_code.toLowerCase() === args.proposal!.order_target!.toLowerCase()) : undefined;
    const target = named ?? (open.length === 1 ? open[0] : null);
    if (!target) {
      result.reasons.push("order_cancellation_ambiguous");
      return result;
    }
    await write(`${args.dedupeBase}:cancel`, target, (cur) => {
      if (!cur || !isOpenStatus(cur.status)) return null;
      const plan = planOrderUpdate({ existing: cur, fields: fieldsOf(cur), contentChanged: false, customerTexts: segments, outboundSinceAwaiting: false, now });
      if (plan.event === "no_change") return null;
      return {
        row: rowFrom(cur, fieldsOf(cur), plan, ctx),
        event: plan.event,
        actorKind: plan.event === "customer_cancelled" ? "customer" : "ai",
        changes: { status: { before: cur.status, after: plan.status }, attention: { before: cur.attention, after: plan.attention } },
      };
    });
    if (result.applied) result.reasons.push("order_cancellation_recorded");
    return result;
  }

  for (const [index, { target, draft }] of withItems.entries()) {
    const resolved = resolveOrderTarget(open, target, draft);
    const existing = resolved.kind === "merge" ? resolved.order : null;
    // The customer's records, used only where their words leave a gap and only from reliable orders.
    const pool = reliableHistory(history, existing ? [existing.id] : []);
    // A history line the model nominated for a generic phrase is judged against those records, not the customer's words. One that
    // fails the check is just what the model said: it stays only if the customer's own words ground it.
    const inferredLines: OrderItem[] = [];
    const nominatedRefs: string[] = [];
    const plainItems: OrderItem[] = [];
    for (const item of draft.items) {
      if (!item.from_history) {
        plainItems.push(item);
        continue;
      }
      const { from_history: _unused, ...rest } = item;
      void _unused;
      const ok = acceptModelHistoryLine(item, pool);
      const held = [...(existing?.items ?? []), ...inferredLines.map(toLine)];
      if (!ok) plainItems.push(rest);
      else if (!held.some((h) => sameLineProduct(h, ok.line))) {
        const quantity = item.quantity && quantityStated(item.quantity, args.customerWords) ? item.quantity : null;
        inferredLines.push({ product: ok.line.product, quantity, ...(ok.line.variant ? { variant: ok.line.variant } : {}), ...(ok.line.size ? { size: ok.line.size } : {}) });
        nominatedRefs.push(ok.ref);
      }
    }
    // The model may only restate what the customer wrote: ground against the order it targets, not another.
    const grounded = groundOrderDraft({ ...draft, items: plainItems }, existing ? asDraft(existing) : null, args.customerWords);
    if (!grounded) continue;
    // The customer's own delivery/collection words win, so "I'll collect instead" can replace "delivery".
    grounded.delivery_preference = groundDeliveryPreference(draft.delivery_preference, args.customerWords) ?? grounded.delivery_preference;
    // A whole-order cancellation in the same breath as a (re-stated) order must not create a new one.
    if (!existing && segments.some(isWholeOrderCancellation)) continue;

    const upgraded = upgradeGenericLines(grounded.items.map(toLine), pool, existing?.items ?? []);
    const upgradedRefs = upgraded.sources.map((x) => x.ref);
    grounded.items = [
      ...upgraded.lines
        .map((l) => ({ product: l.product, quantity: l.quantity, ...(l.variant ? { variant: l.variant } : {}), ...(l.size ? { size: l.size } : {}) }))
        .filter((l) => !inferredLines.some((i) => sameLineProduct(toLine(i), toLine(l)))),
      ...inferredLines,
    ];
    // Plainly stated quantities and delivery/collection are recorded even when the model left them out.
    const refined = refineOrderDraft(grounded, segments, args.customerWords);

    const fillFor = (cur: TrackedOrder | null): HistoryFill =>
      pointsBack
        ? resolveFromHistory(history, cue, segments, {
            current: cur ? { id: cur.id, items: cur.items, delivery_address: cur.delivery_address, fulfilment_method: cur.fulfilment_method } : null,
            draftItems: refined.items.map(toLine),
            draftAddress: refined.delivery_address,
            defaultLocation: savedLocation?.content ?? null,
          })
        : { items: [], address: null, setDelivery: false, clearAddress: false, sources: {}, unresolved: [] };
    const planned = fillFor(existing);
    const hasContent = refined.items.length > 0 || planned.items.length > 0 || Boolean(existing);
    const noteOnly = !hasContent && cue.repeat !== null && planned.unresolved.length > 0;
    // Nothing the customer said or their records can answer, and nothing to attach it to: no order is invented.
    if (!hasContent && !noteOnly) {
      if (pointsBack) result.reasons.push("order_history_unresolved");
      continue;
    }

    await write(`${args.dedupeBase}:${index}`, existing, (cur) => {
      // "Tomorrow" counts from when the customer WROTE it, in the business's timezone: a later retry or backfill cannot move it.
      const when = refined.requested_for ? anchorRequestedFor(refined.requested_for, cur?.requested_for, messageTimeFor(refined.requested_for, segments, args.segmentTimes, args.lastAt), tz) : null;
      // A turn without lines of its own starts from what the order already says.
      const baseDraft: OrderRequestDraft = refined.items.length === 0 && cur ? { ...refined, items: asDraft(cur).items } : refined;
      // "Another bag", "2 more", "make that 3": numbers the words give but the model's draft could not be grounded on.
      const adjusted = applyQuantityAdjustments(cur?.items ?? [], baseDraft, segments);
      // A product the model left out is dropped only if the customer withdrew it ("just the Monello bags").
      const removal = cur ? guardRemovedItems<OrderItem>(cur.items, adjusted.items, segments) : null;
      if (removal && removal.restored.length > 0 && !result.reasons.includes("order_item_removal_unconfirmed")) result.reasons.push("order_item_removal_unconfirmed");
      const fill = fillFor(cur);
      const kept = removal ? removal.items : adjusted.items;
      const fillItems: OrderItem[] = fill.items
        .filter((l) => !kept.some((i) => sameLineProduct(toLine(i), l)) && !(cur?.items ?? []).some((i) => sameLineProduct(i, l)))
        .map((l) => ({ product: l.product, quantity: l.quantity, ...(l.variant ? { variant: l.variant } : {}), ...(l.size ? { size: l.size } : {}) }));
      const historyAddress = fill.address && !adjusted.delivery_address && !cur?.delivery_address ? fill.address : null;
      const noMethod = !fulfilmentMethod(adjusted.delivery_preference) && !cur?.fulfilment_method;
      const forMerge: OrderRequestDraft = {
        ...adjusted,
        ...(when ? { requested_for: when } : {}),
        items: [...kept, ...fillItems],
        ...(historyAddress ? { delivery_address: historyAddress } : {}),
        ...(historyAddress && fill.setDelivery && noMethod ? { delivery_preference: "delivery" } : {}),
        ...(noteOnly && !cur ? { notes: segments.join(" ").replace(/\s+/g, " ").trim().slice(0, 160) } : {}),
      };
      const merged = mergeDraft(cur ? fieldsOf(cur) : null, forMerge, cur?.manual_locked_fields ?? [], name, (field, proposed) => statedThisTurn(field, proposed, segments, cur?.items ?? []));
      // "Deliver somewhere else": the address on the order is no longer right; the customer will give the new one.
      if (cur && fill.clearAddress && merged.fields.delivery_address) {
        if (cur.manual_locked_fields.includes("delivery_address")) merged.conflicts.push({ field: "delivery_address", before: cur.delivery_address, after: null });
        else {
          merged.changes.push({ field: "delivery_address", before: merged.fields.delivery_address, after: null });
          merged.fields.delivery_address = null;
        }
      }
      const fields = merged.fields;
      const changed = cur ? merged.changes.length > 0 : true;
      // A customer contradicting a staff-locked field: the staff value stays, the proposal is recorded for a person.
      const conflicts: FieldConflicts = { ...(cur?.field_conflicts ?? {}) };
      for (const c of merged.conflicts) conflicts[c.field] = { proposed: c.after, current: c.before, at: args.lastAt };
      const conflictsChanged = merged.conflicts.some((c) => JSON.stringify(cur?.field_conflicts?.[c.field]?.proposed ?? null) !== JSON.stringify(c.after));
      const plan = planOrderUpdate({ existing: cur, fields, contentChanged: changed, customerTexts: segments, outboundSinceAwaiting: false, now });
      // Pointing at an earlier order that could not be matched safely is for a person to look at; never guessed.
      const unresolvedFlag = fill.unresolved.length > 0 && !plan.attention ? "history_unresolved" : null;
      const attention = !cur && resolved.kind === "create" && resolved.flag ? resolved.flag : (unresolvedFlag ?? plan.attention);
      const flagged = Boolean(cur) && unresolvedFlag !== null;
      if (cur && plan.event === "no_change" && !changed && !conflictsChanged && !flagged) return null;
      const finalPlan = { ...plan, attention };
      const itemsChanged = merged.changes.some((c) => c.field === "items");
      const inferredItems = [...(fillItems.length > 0 && fill.sources.items ? [fill.sources.items] : []), ...nominatedRefs, ...upgradedRefs];
      const inferred = {
        ...(itemsChanged && inferredItems.length > 0 ? { items: [...new Set(inferredItems)] } : {}),
        ...(historyAddress && fill.sources.delivery_address && merged.changes.some((c) => c.field === "delivery_address") ? { delivery_address: fill.sources.delivery_address } : {}),
        ...(fill.unresolved.length > 0 ? { unresolved: fill.unresolved } : {}),
      };
      if (Object.keys(inferred).length > 0) {
        const code = fill.unresolved.length > 0 ? "order_history_unresolved" : "order_history_used";
        if (!result.reasons.includes(code)) result.reasons.push(code);
      }
      return {
        row: rowFrom(cur, fields, finalPlan, { ...ctx, conflicts }),
        event: cur && !changed && conflictsChanged && finalPlan.event === "no_change" ? "locked_field_conflict" : cur && !changed && flagged && finalPlan.event === "no_change" ? "attention_flagged" : finalPlan.event,
        actorKind: finalPlan.event === "customer_cancelled" ? "customer" : "ai",
        changes: {
          ...diff(merged.changes),
          ...(conflictsChanged ? { field_conflicts: { before: cur?.field_conflicts ?? {}, after: conflicts } } : {}),
          ...(removal && removal.removed.length > 0 && merged.changes.some((c) => c.field === "items") ? { removed_items: { before: removal.removed.map((i) => i.product), after: null } } : {}),
          ...(cur && cur.status !== finalPlan.status ? { status: { before: cur.status, after: finalPlan.status } } : {}),
          ...(Object.keys(inferred).length > 0 ? { inferred: { before: null, after: inferred } } : {}),
        },
      };
    });
    open = await loadOpenOrders(businessSlug, chatId);
  }
  if (result.applied) result.reasons.push("orders_tracked");
  return result;
}

// ── Staff messages in the chat ───────────────────────────────────────────────

export interface StaffFlagArgs {
  businessSlug: string;
  chatId: string;
  /** The reference the model named, or null. With several open orders and no valid reference nothing is guessed. */
  target: string | null;
  action: StaffAction;
  /** What staff wrote (kept, clipped, only in the order's history). */
  text: string;
  messageId: string;
  key: string;
}

/**
 * A message the business wrote in the chat (business phone or inbox) can only RAISE A FLAG on an existing open order,
 * for a person to verify: "staff wrote a confirmation / cancellation / change". It never changes the order's content or
 * status (WhatsApp cannot say which person wrote from the business phone, and staff verification is the rule), never
 * creates an order, and does not count as customer activity.
 */
export async function flagOrderFromStaff(args: StaffFlagArgs): Promise<{ applied: boolean; reason: string }> {
  const { businessSlug, chatId } = args;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await loadOpenOrders(businessSlug, chatId);
    const named = args.target ? open.find((o) => o.ref_code.toLowerCase() === args.target!.toLowerCase()) : undefined;
    const order = named ?? (open.length === 1 ? open[0] : null);
    if (!order) return { applied: false, reason: open.length === 0 ? "orders_monitor_skipped_no_open_order" : "orders_monitor_staff_ambiguous" };
    const flag = staffFlagFor(args.action, order.attention);
    if (!flag) return { applied: false, reason: "orders_monitor_staff_no_change" };
    const plan = {
      status: order.status,
      attention: flag,
      awaitingSince: order.awaiting_since,
      missing: order.missing_fields,
      event: "attention_flagged" as const,
      confirmedByCustomer: false,
      customerConfirmedAt: order.customer_confirmed_at,
    };
    const ctx = { chatId, phone: order.contact_number, messageIds: [args.messageId], firstAt: order.first_message_at, lastAt: order.last_message_at };
    const res = await applyOrder({
      businessSlug,
      key: args.key,
      existing: order,
      row: rowFrom(order, fieldsOf(order), plan, ctx),
      event: "staff_noted_in_chat",
      actorKind: "staff",
      actorId: null,
      changes: { attention: { before: order.attention, after: flag }, staff_message: { before: null, after: args.text.replace(/\s+/g, " ").trim().slice(0, 200) } },
      messageIds: [args.messageId],
    });
    if (res.result === "applied") return { applied: true, reason: `orders_monitor_staff_${args.action}` };
    if (res.result === "duplicate" || res.result === "not_found") return { applied: false, reason: "orders_monitor_already_applied" };
    // conflict: someone changed the order meanwhile; re-read and decide again.
  }
  return { applied: false, reason: "order_write_conflict" };
}

// ── Manual corrections (dashboard) ───────────────────────────────────────────

/** "keep" = staff keep their value for the fields the customer contradicted (`conflictFields`, default all). */
export type ManualAction = "edit" | "confirm" | "cancel" | "fulfil" | "keep";
/** "reopen" (undo a completion) is only reachable from the WhatsApp order command, not the dashboard route. */
type ManualActionInternal = ManualAction | "reopen";

export interface ManualInput {
  businessSlug: string;
  orderId: string;
  /** Who made the change: an admin's user id (dashboard) or a staff member's verified WhatsApp id (order command). */
  adminId: string;
  /** "staff" = an authorized sender in the staff group; same rules as the dashboard, recorded as such. Default "admin". */
  actor?: "admin" | "staff";
  /** Makes the change idempotent: the same key applied twice changes nothing the second time. */
  idempotencyKey?: string | null;
  /** WhatsApp commands: refuse when a customer/AI/dashboard change landed after the command was written. */
  notChangedSince?: string | null;
  action: ManualActionInternal;
  expectedVersion?: number | null;
  patch?: Partial<Record<EditableOrderField, unknown>>;
  conflictFields?: string[];
  reason?: string | null;
}

export type ManualFailure = "not_found" | "closed" | "conflict" | "stale" | "incomplete" | "invalid";

export type ManualResult =
  | { ok: true; order: TrackedOrder; duplicate?: boolean }
  | { ok: false; status: number; error: string; code: ManualFailure };

/** A change by one of these staff commands never makes a later command "stale": two commands typed seconds apart both apply. */
const STAFF_COMMAND_EVENT = "staff_whatsapp_%";
/** Clock difference tolerated between WhatsApp's message time and the database. */
const STALE_TOLERANCE_MS = 5_000;

/** True when something other than a staff command changed the order after `since` (the command was written before it). */
async function changedSince(orderId: string, since: string): Promise<boolean> {
  const cutoff = new Date(Date.parse(since) + STALE_TOLERANCE_MS).toISOString();
  const { data, error } = await agentDb()
    .from("ai_agent_order_events")
    .select("id")
    .eq("order_id", orderId)
    .gt("created_at", cutoff)
    .not("kind", "like", STAFF_COMMAND_EVENT)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

const trimmed = (v: unknown, max: number): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t || null;
};

/** Validates an edit; returns the cleaned fields or an error. */
export function validatePatch(patch: Partial<Record<EditableOrderField, unknown>>): { ok: true; fields: Partial<OrderFields> } | { ok: false; error: string } {
  const out: Partial<OrderFields> = {};
  for (const key of Object.keys(patch)) {
    if (!(EDITABLE_ORDER_FIELDS as readonly string[]).includes(key)) return { ok: false, error: `${key} cannot be edited` };
  }
  const text = (field: "customer_name" | "delivery_address" | "requested_for" | "notes", max: number) => {
    if (patch[field] === undefined) return null;
    const v = trimmed(patch[field], max);
    if (v === undefined) return `${field} must be text`;
    out[field] = v;
    return null;
  };
  for (const [field, max] of [["customer_name", 120], ["delivery_address", 500], ["requested_for", 200], ["notes", 1000]] as const) {
    const err = text(field, max);
    if (err) return { ok: false, error: err };
  }
  if (patch.fulfilment_method !== undefined) {
    if (patch.fulfilment_method !== null && patch.fulfilment_method !== "delivery" && patch.fulfilment_method !== "collection") {
      return { ok: false, error: "fulfilment_method must be delivery, collection or null" };
    }
    out.fulfilment_method = patch.fulfilment_method as OrderFields["fulfilment_method"];
  }
  if (patch.items !== undefined) {
    if (!Array.isArray(patch.items) || patch.items.length > 20) return { ok: false, error: "items must be a list of at most 20 products" };
    const items: OrderLine[] = [];
    for (const raw of patch.items as Record<string, unknown>[]) {
      const product = trimmed(raw?.product, 200);
      if (!product) return { ok: false, error: "every item needs a product" };
      items.push({ product, quantity: trimmed(raw.quantity, 50) ?? null, variant: trimmed(raw.variant, 100) ?? null, size: trimmed(raw.size, 50) ?? null });
    }
    out.items = items;
  }
  return { ok: true, fields: out };
}

export async function updateOrderManually(input: ManualInput): Promise<ManualResult> {
  const { businessSlug, orderId, action } = input;
  const db = agentDb();
  const { data, error } = await db.from("ai_agent_orders").select(ORDER_COLUMNS).eq("id", orderId).eq("business_slug", businessSlug).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message, code: "invalid" };
  const order = data as TrackedOrder | null;
  if (!order) return { ok: false, status: 404, error: "Order not found", code: "not_found" };
  const actor = input.actor ?? "admin";
  const fail = (status: number, message: string, code: ManualFailure): ManualResult => ({ ok: false, status, error: message, code });
  // Already applied (a redelivered command): report success without touching anything.
  if (input.idempotencyKey) {
    const { data: done } = await db.from("ai_agent_order_events").select("id").eq("idempotency_key", input.idempotencyKey).limit(1);
    if ((done ?? []).length > 0) return { ok: true, order, duplicate: true };
  }
  if (input.expectedVersion != null && input.expectedVersion !== order.version) {
    return fail(409, "This order changed since you opened it — reload and try again", "conflict");
  }
  if (action === "reopen" ? order.status !== "fulfilled" : !isOpenStatus(order.status)) return fail(409, `The order is already ${order.status}`, "closed");
  if (input.notChangedSince && (await changedSince(order.id, input.notChangedSince))) {
    return fail(409, "This order changed after the command was written", "stale");
  }

  const now = new Date().toISOString();
  let fields = fieldsOf(order);
  let locked = order.manual_locked_fields;
  // A person editing a field settles whatever the customer proposed for it; "keep" settles it without an edit.
  const conflicts: FieldConflicts = { ...(order.field_conflicts ?? {}) };
  const settle = (list: readonly string[]) => {
    const cleared = list.filter((f) => f in conflicts);
    for (const f of cleared) delete conflicts[f as EditableOrderField];
    if (cleared.length > 0) changes.field_conflicts = { before: order.field_conflicts, after: { ...conflicts } };
    return cleared.length;
  };
  let status: OrderStatus = order.status;
  let attention = order.attention;
  let awaitingSince = order.awaiting_since;
  let confirmedBy = order.confirmed_by;
  let confirmedAt = order.confirmed_at;
  let customerConfirmedAt = order.customer_confirmed_at;
  let cancelledAt: string | null = null;
  let cancelReason: string | null = null;
  let fulfilledAt: string | null = null;
  const changes: Record<string, unknown> = {};

  if (action === "edit") {
    const checked = validatePatch(input.patch ?? {});
    if (!checked.ok) return fail(400, checked.error, "invalid");
    const changedFields = Object.keys(checked.fields) as EditableOrderField[];
    if (changedFields.length === 0) return fail(400, "Nothing to change", "invalid");
    fields = { ...fields, ...checked.fields };
    // Choosing the method by hand also fixes the free-text preference so the two cannot disagree.
    if (checked.fields.fulfilment_method !== undefined) fields.delivery_preference = checked.fields.fulfilment_method;
    for (const f of changedFields) changes[f] = { before: order[f], after: fields[f] };
    locked = unique([...locked, ...changedFields]);
    settle(changedFields);
    if (order.status === "possible" && isComplete(computeMissing(fields))) {
      status = "awaiting_confirmation";
      awaitingSince = now;
      changes.status = { before: order.status, after: status };
    }
    if (order.attention === "check_if_duplicate" || order.attention === "cancellation_requested" || order.attention?.startsWith("staff_")) attention = null;
    // The customer said yes to the order as it was; a staff change to its content voids that.
    if (changedFields.some((f) => f !== "customer_name")) {
      customerConfirmedAt = null;
      if (attention === "customer_replied_yes") attention = null;
    }
  } else if (action === "confirm") {
    const missing = computeMissing(fields);
    if (!isComplete(missing)) return fail(409, "Add the missing details before confirming (products, quantity, delivery or collection, address)", "incomplete");
    status = "confirmed";
    attention = null;
    confirmedBy = `${actor}:${input.adminId}`;
    confirmedAt = now;
    changes.status = { before: order.status, after: status };
  } else if (action === "cancel") {
    status = "cancelled";
    cancelledAt = now;
    cancelReason = (input.reason ?? "").trim().slice(0, 300) || "cancelled by staff";
    changes.status = { before: order.status, after: status, reason: cancelReason };
  } else if (action === "reopen") {
    // Back to where completion found it: confirmed if a person had confirmed it, else by what the order still lacks.
    status = order.confirmed_at ? "confirmed" : isComplete(computeMissing(fields)) ? "awaiting_confirmation" : "possible";
    changes.status = { before: order.status, after: status };
    changes.fulfilled_at = { before: order.fulfilled_at, after: null };
  } else if (action === "keep") {
    if (settle(input.conflictFields ?? Object.keys(conflicts)) === 0) return fail(400, "Nothing to keep", "invalid");
  } else {
    status = "fulfilled";
    fulfilledAt = now;
    changes.status = { before: order.status, after: status };
    changes.fulfilled_at = { before: null, after: now };
  }

  const row: OrderRow = {
    ...rowFrom(order, fields, { status, attention, awaitingSince, missing: computeMissing(fields), event: "no_change", confirmedByCustomer: false, customerConfirmedAt }, {
      chatId: order.chat_id,
      phone: null,
      messageIds: [],
      firstAt: order.first_message_at,
      lastAt: order.last_message_at,
      locked,
      conflicts,
    }),
    confirmed_by: status === "confirmed" || status === "fulfilled" ? confirmedBy : null,
    confirmed_at: status === "confirmed" || status === "fulfilled" ? confirmedAt : null,
    cancelled_at: cancelledAt,
    cancel_reason: cancelReason,
    fulfilled_at: fulfilledAt,
  };
  const res = await applyOrder({
    businessSlug,
    key: input.idempotencyKey ?? null,
    existing: order,
    row,
    event: actor === "staff" ? `staff_whatsapp_${action}` : `manual_${action}`,
    actorKind: actor,
    actorId: input.adminId,
    changes,
    messageIds: [],
  });
  if (res.result === "conflict") return fail(409, "This order changed since you opened it — reload and try again", "conflict");
  if (res.result === "duplicate") return { ok: true, order, duplicate: true };
  if (res.result !== "applied") return fail(404, "Order not found", "not_found");
  await audit(businessSlug, actor, input.adminId, `order.${action}`, { type: "order", id: orderId }, { ref: order.ref_code, changes, ...(actor === "staff" ? { via: "whatsapp" } : {}) });
  const { data: fresh } = await db.from("ai_agent_orders").select(ORDER_COLUMNS).eq("id", orderId).eq("business_slug", businessSlug).maybeSingle();
  return { ok: true, order: (fresh as TrackedOrder | null) ?? order };
}

// ── The summary ──────────────────────────────────────────────────────────────

export interface SummaryRun {
  id: string;
  business_slug: string;
  trigger: "scheduled" | "manual";
  local_date: string;
  status: "claimed" | "queued" | "missed" | "skipped";
  skip_reason: string | null;
  requested_by: string | null;
  outbox_id: string | null;
  group_jid: string | null;
  attempts: number;
  confirmed_count: number | null;
  attention_count: number | null;
  carried_count: number | null;
  created_at: string;
  updated_at: string;
}

const RUN_COLUMNS =
  "id, business_slug, trigger, local_date, status, skip_reason, requested_by, outbox_id, group_jid, attempts, confirmed_count, attention_count, carried_count, created_at, updated_at";

const tzOf = (s: AgentSettings) => s.orders_timezone || DEFAULT_ORDERS_TIMEZONE;
const hourOf = (s: AgentSettings) => s.orders_summary_hour ?? DEFAULT_SUMMARY_HOUR;

const COVERAGE_WINDOW_HOURS = 36;
/** A message stored this recently may simply not have been forwarded yet. */
const FORWARD_GRACE_MS = 10 * 60_000;

/**
 * What the report may honestly claim. Counts conversations (and, for the bridge gap, messages) from the last 36 hours
 * that were not analysed, from the agent's own event log, batch queue and the stored messages, so nothing extra is stored.
 *
 *   failed        the monitoring / tracking / model step errored (orders there may be missing)
 *   skipped       a message the old rules stopped before any order reading and monitoring did not pick up
 *   budget        not analysed because the hourly monitoring budget was used up
 *   filtered      read by the free pre-filter only (pleasantries, no order wording): dashboard information
 *   notForwarded  customer messages the bridge stored but never forwarded to the agent
 */
export async function loadCoverage(settings: AgentSettings, now: Date): Promise<Coverage> {
  const slug = settings.business_slug;
  const windowStart = now.getTime() - COVERAGE_WINDOW_HOURS * 3_600_000;
  // Nothing before tracking was switched on can be a gap.
  const trackedFrom = settings.orders_tracking_since ? Date.parse(settings.orders_tracking_since) : Number.NaN;
  const since = new Date(Number.isFinite(trackedFrom) ? Math.max(windowStart, trackedFrom) : windowStart).toISOString();
  const db = agentDb();
  const [events, batches, stored] = await Promise.all([
    db.from("ai_agent_events").select("chat_id, status, reason_codes, whatsapp_message_id, kind").eq("business_slug", slug).in("kind", ["customer_inbound", "staff_outbound", "ignored"]).gte("created_at", since).limit(6000),
    db.from("ai_agent_batches").select("chat_id, status, updated_at").eq("business_slug", slug).in("status", ["failed", "collecting", "processing"]).gte("last_message_at", since).limit(1000),
    db.from("whatsapp_messages").select("whatsapp_message_id, chat_id, direction, message_body").eq("business_slug", slug).gte("timestamp", since).lte("timestamp", new Date(now.getTime() - FORWARD_GRACE_MS).toISOString()).limit(6000),
  ]);
  if (events.error) throw new Error(events.error.message);
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const budget = new Set<string>();
  const seenIds = new Set<string>();
  let filtered = 0;
  for (const e of events.data ?? []) {
    if (e.whatsapp_message_id) seenIds.add(e.whatsapp_message_id as string);
    if (e.kind === "ignored") continue;
    const codes = (e.reason_codes as string[] | null) ?? [];
    if (e.status === "error" || codes.some((c) => MONITOR_FAILED_REASONS.has(c))) failed.add(e.chat_id as string);
    else if (codes.includes(MONITOR_BUDGET_REASON)) budget.add(e.chat_id as string);
    else if (settings.orders_tracking_enabled && e.kind === "customer_inbound" && codes.some((c) => MONITOR_GATE_REASONS.has(c)) && !codes.some((c) => c.startsWith("orders_monitor") || c.startsWith("order_"))) skipped.add(e.chat_id as string);
    if (codes.some((c) => c.startsWith(MONITOR_FILTERED_PREFIX) && c !== "orders_monitor_already_applied")) filtered += 1;
  }
  for (const b of batches.data ?? []) {
    // A batch that failed, or has been waiting far longer than any quiet period, was not analysed (yet).
    const stuck = b.status !== "failed" && now.getTime() - Date.parse(b.updated_at as string) > 30 * 60_000;
    if (b.status === "failed" || stuck) failed.add(b.chat_id as string);
  }
  for (const c of failed) {
    skipped.delete(c);
    budget.delete(c);
  }
  // A customer message the bridge stored but the agent never saw (bridge forwarding off, offline, or dropped it).
  let notForwarded = 0;
  if (!stored.error) {
    for (const m of stored.data ?? []) {
      if (isOutbound(m.direction as string) || !monitorEligibleChat(m.chat_id as string) || !(m.message_body as string | null)?.trim()) continue;
      if (!seenIds.has(m.whatsapp_message_id as string)) notForwarded += 1;
    }
  }
  return {
    trackingOn: settings.orders_tracking_enabled === true,
    trackingSince: settings.orders_tracking_since ?? null,
    contactScope: settings.contact_scope,
    failedChats: failed.size,
    skippedChats: skipped.size,
    budgetChats: budget.size,
    filteredMessages: filtered,
    notForwardedMessages: notForwarded,
    windowHours: COVERAGE_WINDOW_HOURS,
  };
}

/** The report as of right now, from the database (orders and coverage are both read fresh). */
export async function buildSummaryNow(settings: AgentSettings, trigger: "scheduled" | "manual", now: Date) {
  const [orders, coverage] = await Promise.all([loadOutstandingOrders(settings.business_slug), loadCoverage(settings, now)]);
  const names = await loadOrderNames(settings.business_slug, orders);
  return buildOrderSummary({ businessLabel: businessLabel(settings.business_slug), timezone: tzOf(settings), now, orders, names, trigger, coverage });
}

function summaryItem(settings: AgentSettings, body: string, dedupeKey: string, eventId: string | null): OutboxInsert {
  const group = ordersGroupJid(settings)!;
  return { businessSlug: settings.business_slug, chatId: group, kind: "staff_notice", toJid: group, body, dedupeKey, eventId };
}

/** Part 1 keeps the run's own dedupe key (so a resumed run finds it); later parts are keyed `<key>:p<n>`. */
const partKey = (dedupeKey: string, index: number) => (index === 0 ? dedupeKey : `${dedupeKey}:p${index + 1}`);

/** Builds the report from the database and queues it (one outbox row per numbered part). Returns the rows created, or null when the final gate refused. */
async function queueSummary(
  settings: AgentSettings,
  run: { id: string; trigger: "scheduled" | "manual"; dedupeKey: string; eventId?: string | null },
  now: Date,
  dispatchNow: boolean
): Promise<OutboxRow[] | null> {
  const summary = await buildSummaryNow(settings, run.trigger, now);
  const items = summary.parts.map((part, i) => summaryItem(settings, part, partKey(run.dedupeKey, i), run.eventId ?? null));
  if (!outboxAllowed(settings, items[0])) {
    await agentDb().from("ai_agent_order_summary_runs").update({ status: "skipped", skip_reason: "send_not_permitted" }).eq("id", run.id);
    return null;
  }
  // One at a time, so the parts reach the group in order (rows created together share a timestamp).
  const created: OutboxRow[] = [];
  let first: OutboxRow | null = null;
  for (const [i, item] of items.entries()) {
    const made = await enqueue([item], dispatchNow);
    created.push(...made);
    if (i === 0) first = made[0] ?? null;
  }
  // An existing row for this dedupe key (a resumed run) is the same send: never a second one.
  const outboxRow =
    first ??
    ((await agentDb().from("ai_agent_outbox").select("id, business_slug, kind, to_jid, body, status, reply_to_message_id, error").eq("dedupe_key", run.dedupeKey).maybeSingle()).data as OutboxRow | null);
  await agentDb()
    .from("ai_agent_order_summary_runs")
    .update({
      status: "queued",
      outbox_id: outboxRow?.id ?? null,
      group_jid: items[0].toJid,
      confirmed_count: summary.confirmed,
      attention_count: summary.attention,
      carried_count: summary.carriedForward,
    })
    .eq("id", run.id);
  return created;
}

async function loadRun(key: string): Promise<SummaryRun | null> {
  const { data, error } = await agentDb().from("ai_agent_order_summary_runs").select(RUN_COLUMNS).eq("scheduled_key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SummaryRun | null) ?? null;
}

/** True when the bridge provably did not send the summary (so one more attempt cannot duplicate it). */
function provablyUnsent(row: { status: string; error: string | null }): boolean {
  if (row.status !== "failed") return false;
  const code = failureReason(row.error);
  return Boolean(code) && code !== "held_after_unknown_send" && (code === "not_sent" || BLOCK_REASONS.has(code!));
}

export type ScheduledOutcome =
  | "not_yet"
  | "sent"
  | "already_done"
  | "resumed"
  | "retried"
  | "missed"
  | "uncertain_not_resent"
  | "skipped"
  | "claimed_elsewhere";

/**
 * One business, one tick of the 8 AM job. Safe to run any number of times, from any number of instances:
 * the unique scheduled_key lets exactly one caller create the day's run, and the outbox dedupe key makes the
 * send itself idempotent. A send that may have reached WhatsApp (no ack, or an ambiguous failure) is NEVER
 * repeated automatically; only a provable "not sent" earns another attempt (at most MAX_ATTEMPTS, same day).
 */
export async function runScheduledSummary(settings: AgentSettings, now: Date = new Date()): Promise<ScheduledOutcome> {
  const slug = settings.business_slug;
  if (!settings.enabled || !settings.orders_summary_enabled) return "skipped";
  const { dateKey } = localParts(now, tzOf(settings));
  const key = `${slug}:${dateKey}`;
  const existing = await loadRun(key);
  const state = scheduleState({ now, timezone: tzOf(settings), hour: hourOf(settings), lastRunDate: existing ? dateKey : null });

  if (state.state === "not_yet") return "not_yet";

  if (state.state === "done" && existing) {
    if (existing.status === "claimed" && Date.now() - Date.parse(existing.updated_at) > RESUME_AFTER_MS) {
      // The worker that claimed the day died before queueing. The dedupe key keeps this from doubling up.
      if (!canPostOrderSummary(settings)) return "skipped";
      await queueSummary(settings, { id: existing.id, trigger: "scheduled", dedupeKey: `ordersummary:${key}:${existing.attempts}` }, now, false);
      await audit(slug, "system", null, "orders.summary_resumed", { type: "order_summary_run", id: existing.id });
      return "resumed";
    }
    if (existing.status === "queued" && existing.outbox_id && existing.attempts < MAX_ATTEMPTS) {
      const { data } = await agentDb().from("ai_agent_outbox").select("status, error, dispatched_at, created_at").eq("id", existing.outbox_id).maybeSingle();
      if (data && provablyUnsent(data)) {
        const bumped = await agentDb()
          .from("ai_agent_order_summary_runs")
          .update({ attempts: existing.attempts + 1, status: "claimed" })
          .eq("id", existing.id)
          .eq("attempts", existing.attempts)
          .select("id")
          .maybeSingle();
        if (!bumped.data) return "claimed_elsewhere";
        await queueSummary(settings, { id: existing.id, trigger: "scheduled", dedupeKey: `ordersummary:${key}:${existing.attempts + 1}` }, now, false);
        await audit(slug, "system", null, "orders.summary_retried", { type: "order_summary_run", id: existing.id }, { attempt: existing.attempts + 1, previous_error: data.error });
        return "retried";
      }
      if (data && outboxState({ status: data.status, error: data.error, dispatched_at: data.dispatched_at, created_at: data.created_at }, now) === "unresolved") {
        return "uncertain_not_resent";
      }
    }
    return "already_done";
  }

  if (state.state === "missed") {
    const { data } = await agentDb()
      .from("ai_agent_order_summary_runs")
      .upsert({ business_slug: slug, trigger: "scheduled", local_date: dateKey, scheduled_key: key, status: "missed", skip_reason: "outside_catch_up_window" }, { onConflict: "scheduled_key", ignoreDuplicates: true })
      .select("id");
    if ((data ?? []).length > 0) await audit(slug, "system", null, "orders.summary_missed", { type: "order_summary_run", id: data![0].id }, { local_date: dateKey });
    return "missed";
  }

  // due: claim the day. Whoever inserts the row owns it.
  if (!canPostOrderSummary(settings)) {
    const { data } = await agentDb()
      .from("ai_agent_order_summary_runs")
      .upsert({ business_slug: slug, trigger: "scheduled", local_date: dateKey, scheduled_key: key, status: "skipped", skip_reason: "cannot_post_in_current_mode_or_no_group" }, { onConflict: "scheduled_key", ignoreDuplicates: true })
      .select("id");
    if ((data ?? []).length > 0) await audit(slug, "system", null, "orders.summary_skipped", { type: "order_summary_run", id: data![0].id }, { local_date: dateKey });
    return "skipped";
  }
  const { data: claimed, error } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .upsert({ business_slug: slug, trigger: "scheduled", local_date: dateKey, scheduled_key: key, status: "claimed", group_jid: ordersGroupJid(settings) }, { onConflict: "scheduled_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  if ((claimed ?? []).length === 0) return "claimed_elsewhere";
  const runId = claimed![0].id as string;
  await queueSummary(settings, { id: runId, trigger: "scheduled", dedupeKey: `ordersummary:${key}:1` }, now, false);
  await audit(slug, "system", null, "orders.summary_queued", { type: "order_summary_run", id: runId }, { local_date: dateKey });
  return "sent";
}

export interface DueSummariesResult {
  businesses: number;
  outcomes: Record<string, number>;
}

/** The scheduler's unit of work: every business with the summary on. */
export async function runDueOrderSummaries(now: Date = new Date()): Promise<DueSummariesResult> {
  const { data, error } = await agentDb().from("ai_agent_settings").select("business_slug").eq("enabled", true).eq("orders_summary_enabled", true);
  if (error) throw new Error(error.message);
  const outcomes: Record<string, number> = {};
  for (const row of data ?? []) {
    try {
      const settings = await loadSettings(row.business_slug as string);
      if (!settings) continue;
      const outcome = await runScheduledSummary(settings, now);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    } catch (err) {
      // One business failing must not stop the others; the next tick retries it.
      console.error("[orders] scheduled summary failed", row.business_slug, err instanceof Error ? err.message : err);
      outcomes.error = (outcomes.error ?? 0) + 1;
    }
  }
  return { businesses: (data ?? []).length, outcomes };
}

/** Recent runs with the delivery state of each, for the dashboard. */
export async function listSummaryRuns(businessSlug: string, limit = 14) {
  const { data, error } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .select(RUN_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as SummaryRun[];
  const ids = runs.map((r) => r.outbox_id).filter((id): id is string => Boolean(id));
  const outbox = ids.length
    ? ((await agentDb().from("ai_agent_outbox").select("id, status, error, dispatched_at, created_at, sent_at").in("id", ids)).data ?? [])
    : [];
  const now = new Date();
  return runs.map((r) => {
    const o = outbox.find((x) => x.id === r.outbox_id);
    return { ...r, delivery: o ? outboxState({ status: o.status, error: o.error, dispatched_at: o.dispatched_at, created_at: o.created_at }, now) : null, sent_at: o?.sent_at ?? null };
  });
}

/** Dashboard "Send summary now": a manual run, same path as !update. */
export async function sendSummaryNow(settings: AgentSettings, requestedBy: string, kind: "admin" | "staff", now: Date = new Date()) {
  if (!canPostOrderSummary(settings)) return { ok: false as const, error: "The summary cannot be posted right now (turn it on, set a group, and check the agent mode)" };
  const recent = await recentManualRun(settings.business_slug, now);
  if (recent) return { ok: false as const, error: "A summary was just posted — wait a few seconds" };
  const { dateKey } = localParts(now, tzOf(settings));
  const { data, error } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .insert({ business_slug: settings.business_slug, trigger: "manual", local_date: dateKey, status: "claimed", requested_by: requestedBy, group_jid: ordersGroupJid(settings) })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const rows = await queueSummary(settings, { id: data.id, trigger: "manual", dedupeKey: `ordersummary:manual:${data.id}` }, now, false);
  await audit(settings.business_slug, kind, requestedBy, "orders.summary_manual", { type: "order_summary_run", id: data.id });
  return rows && rows.length > 0 ? { ok: true as const } : { ok: false as const, error: "The summary could not be posted in the current mode" };
}

async function recentManualRun(businessSlug: string, now: Date): Promise<boolean> {
  const { data } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .select("id")
    .eq("business_slug", businessSlug)
    .eq("trigger", "manual")
    .gte("created_at", new Date(now.getTime() - MANUAL_COOLDOWN_MS).toISOString())
    .limit(1);
  return (data ?? []).length > 0;
}

// ── "!update" ────────────────────────────────────────────────────────────────

export const UPDATE_REFUSAL = {
  unauthorized: "⛔ Only authorized staff can request an order update.",
  disabled: "ℹ️ The order summary is not switched on for this business.",
  other_group: "ℹ️ Order updates are posted in the Orders group.",
  cooldown: "ℹ️ An order update was just posted.",
  blocked: "⚠️ The order update could not be posted in the current mode.",
} as const;

export interface UpdateCommandResult {
  outbox: OutboxInsert[];
  queued: OutboxRow[];
  outcome: string;
}

export interface CommandContext {
  settings: AgentSettings;
  fromGroup: string;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  eventId: string;
  now?: Date;
}

/** A reply to the group the command came from. Always a group JID: order commands have no customer-bound output at all. */
function groupReply(settings: AgentSettings, fromGroup: string, eventId: string, body: string, kind: "staff_notice" | "staff_feedback", outcome: string, dedupeKey = `${eventId}:orders_update_refusal`): UpdateCommandResult {
  return {
    outbox: [{ businessSlug: settings.business_slug, chatId: fromGroup, kind, toJid: fromGroup, body: body.slice(0, 3800), dedupeKey, eventId }],
    queued: [],
    outcome,
  };
}

/**
 * The checks every order command passes first, in the same order and with the same rules as "!update": the feature is
 * on, the message is in the configured orders group, the sender is on the verified allow-list, and the agent may post
 * there in its current mode. Returns the refusal to post (or a silent no-op), or null when the command may proceed.
 */
async function guardOrderCommand(ctx: CommandContext, mode: "update" | "command"): Promise<UpdateCommandResult | null> {
  const { settings, fromGroup, senderAuth } = ctx;
  const slug = settings.business_slug;
  const target = ordersGroupJid(settings);
  const rejected = mode === "update" ? "orders.update_rejected" : "orders.command_rejected";
  const outcome = (what: string) => `orders:${mode}_${what}`;
  // "!update" keeps its established refusal kind (feedback in the staff group); other commands answer with a notice, which
  // every mode that can post to the group accepts.
  const refuse = (text: string, what: string) => groupReply(settings, fromGroup, ctx.eventId, text, mode === "update" && fromGroup === settings.staff_group_jid ? "staff_feedback" : "staff_notice", outcome(what));

  if (!settings.orders_summary_enabled) return refuse(UPDATE_REFUSAL.disabled, "disabled");
  if (!target || fromGroup !== target) {
    await audit(slug, "staff", ctx.senderJid, rejected, { type: "chat", id: fromGroup }, { reason: "wrong_group" });
    return hasSeparateOrdersGroup(settings) && fromGroup === settings.staff_group_jid
      ? refuse(mode === "update" ? UPDATE_REFUSAL.other_group : "ℹ️ Order commands are used in the Orders group.", "wrong_group")
      : { outbox: [], queued: [], outcome: outcome("wrong_group") };
  }
  if (!senderAuth.authorized) {
    await audit(slug, "staff", ctx.senderJid, rejected, { type: "chat", id: fromGroup }, { reason: "unauthorized", sender: senderAuth.senderId });
    return refuse(mode === "update" ? UPDATE_REFUSAL.unauthorized : "⛔ Only authorized staff can use order commands.", "unauthorized");
  }
  if (!canPostOrderSummary(settings)) return refuse(mode === "update" ? UPDATE_REFUSAL.blocked : "⚠️ Order commands can't be answered in the current mode, so nothing was changed.", "blocked");
  return null;
}

export async function handleUpdateCommand(args: {
  settings: AgentSettings;
  fromGroup: string;
  senderAuth: SenderAuthorization;
  senderJid: string | null;
  eventId: string;
  now?: Date;
}): Promise<UpdateCommandResult> {
  const { settings, fromGroup, senderAuth } = args;
  const slug = settings.business_slug;
  const now = args.now ?? new Date();
  const target = ordersGroupJid(settings);
  const refused = await guardOrderCommand(args, "update");
  if (refused) return refused;
  if (await recentManualRun(slug, now)) return groupReply(settings, fromGroup, args.eventId, UPDATE_REFUSAL.cooldown, fromGroup === settings.staff_group_jid ? "staff_feedback" : "staff_notice", "orders:update_cooldown");

  const { dateKey } = localParts(now, tzOf(settings));
  const { data, error } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .insert({ business_slug: slug, trigger: "manual", local_date: dateKey, status: "claimed", requested_by: senderAuth.senderId, event_id: args.eventId, group_jid: target })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  // Dispatched in this very response: the person who typed !update is waiting for it.
  const rows = await queueSummary(settings, { id: data.id, trigger: "manual", dedupeKey: `ordersummary:manual:${args.eventId}`, eventId: args.eventId }, now, true);
  await audit(slug, "staff", senderAuth.senderId, "orders.update_requested", { type: "order_summary_run", id: data.id });
  return { outbox: [], queued: rows ?? [], outcome: rows && rows.length > 0 ? "orders:update_sent" : "orders:update_blocked" };
}

// ── Order commands (!update #REF …, !order, !moreinfo #REF) ──────────────────

/** A command written longer ago than this (an offline catch-up) is not applied: send it again. */
const MAX_COMMAND_AGE_MS = 2 * 3_600_000;

async function loadOrderByRef(businessSlug: string, refCode: string): Promise<TrackedOrder | null> {
  const { data, error } = await agentDb().from("ai_agent_orders").select(ORDER_COLUMNS).eq("business_slug", businessSlug).eq("ref_code", refCode).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TrackedOrder | null) ?? null;
}

const selectorText = (s: Extract<OrderCommand, { kind: "update" }>["selector"]) => (s.type === "ref" ? `#${s.ref.replace(/^O-/, "")}` : s.type === "phone" ? s.digits : s.text);

export interface OrderCommandArgs extends CommandContext {
  command: OrderCommand;
  whatsappMessageId: string;
  /** When the staff member wrote the command (WhatsApp's own timestamp). */
  timestamp: string | null;
}

/**
 * The staff commands for orders. Everything is deterministic (no model call), resolved server-side inside the business,
 * and shares the Orders dashboard's mutation (updateOrderManually → apply_ai_agent_order: version-checked, locked
 * fields recorded, full history and audit). The only output is a short reply to the group the command came from; no
 * code path here can address a customer.
 *
 *   * a selector must identify exactly ONE active order, otherwise nothing changes and the candidates are listed;
 *   * the same WhatsApp message applied twice changes nothing the second time (idempotency key);
 *   * a command is refused when the order changed (customer, AI or dashboard) after it was written, or when it is
 *     more than two hours old, or when someone changed the order while it was being applied.
 */
export async function handleOrderCommand(args: OrderCommandArgs): Promise<UpdateCommandResult> {
  const { settings, fromGroup, command, senderAuth } = args;
  const slug = settings.business_slug;
  const now = args.now ?? new Date();
  if (command.kind === "report") return handleUpdateCommand(args);
  const refused = await guardOrderCommand(args, "command");
  if (refused) return refused;

  const reply = (body: string, outcome: string) => groupReply(settings, fromGroup, args.eventId, body, "staff_notice", `orders:${outcome}`);
  const reject = async (reason: string, body: string) => {
    await audit(slug, "staff", senderAuth.senderId, "orders.command_rejected", { type: "chat", id: fromGroup }, { reason, command: command.kind });
    return reply(body, `cmd_${reason}`);
  };
  if (command.kind === "help") return reply(ORDER_HELP, "cmd_help");

  const tz = tzOf(settings);
  const active = await loadOutstandingOrders(slug);

  if (command.kind === "search") {
    const everyone = await loadOrderNames(slug, active);
    const matches = searchOrders(command.query, active, everyone);
    await audit(slug, "staff", senderAuth.senderId, "orders.lookup", { type: "chat", id: fromGroup }, { command: "search", matches: matches.length });
    return reply(searchReply(command.query, matches, everyone), "cmd_search");
  }

  const selector = command.selector;
  let pool = active;
  if (selector.type === "ref" && !active.some((o) => o.ref_code.toUpperCase() === selector.ref)) {
    const closed = await loadOrderByRef(slug, selector.ref);
    if (closed) pool = [...active, closed];
  }
  const names = await loadOrderNames(slug, pool);
  const found = resolveSelector(selector, pool, names);
  if (found.kind === "none") return reject("not_found", selector.type === "ref" ? ORDER_REPLY.noRef(selector.ref) : ORDER_REPLY.none(selectorText(selector)));
  if (found.kind === "many") return reject("ambiguous", ORDER_REPLY.many(selectorText(selector), found.orders, names));
  const order = found.order;

  if (command.kind === "info") {
    const events = (await listOrderEvents(slug, order.id)) as never[];
    await audit(slug, "staff", senderAuth.senderId, "orders.lookup", { type: "order", id: order.id }, { command: "info" });
    return reply(moreInfoReply({ order, name: names[order.id], events, timezone: tz }), "cmd_info");
  }

  // ── a change ──
  const action = command.action;
  // A redelivery of a message that already completed/reopened the order falls through to its idempotent path below.
  const redelivered = (action.type === "complete" || action.type === "reopen") && (await keyExists(`wa:${slug}:${args.whatsappMessageId}`));
  if (!redelivered) {
    if (action.type === "complete" && order.status === "fulfilled") return reject("no_change", ORDER_REPLY.alreadyCompleted(order));
    if (action.type === "reopen" && order.status !== "fulfilled") return reject("no_change", ORDER_REPLY.notCompleted(order));
    if (action.type !== "reopen" && !isOpenStatus(order.status)) return reject("closed", ORDER_REPLY.closed(order));
  }
  const writtenAt = args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? args.timestamp : null;
  if (writtenAt && now.getTime() - Date.parse(writtenAt) > MAX_COMMAND_AGE_MS) {
    return reject("too_old", `⚠️ That command was written more than 2 hours ago, so it was not applied to ${displayRefText(order)}. Send it again if it is still right.`);
  }
  const base = {
    businessSlug: slug,
    orderId: order.id,
    adminId: senderAuth.senderId ?? "unknown",
    actor: "staff" as const,
    idempotencyKey: `wa:${slug}:${args.whatsappMessageId}`,
    notChangedSince: writtenAt,
    expectedVersion: order.version,
  };
  let run: Promise<ManualResult>;
  let success: (fresh: TrackedOrder) => string;
  switch (action.type) {
    case "confirm": {
      if (order.status === "confirmed") return reject("no_change", ORDER_REPLY.alreadyConfirmed(order, names));
      const missing = computeMissing(fieldsOf(order)).filter((m) => m !== "requested_for");
      if (missing.length > 0) return reject("incomplete", ORDER_REPLY.incomplete(order, missing.map((m) => MISSING_TEXT[m] ?? m).join(", ")));
      run = updateOrderManually({ ...base, action: "confirm" });
      success = (o) => ORDER_REPLY.confirmed(o, order.status, names);
      break;
    }
    case "complete":
      run = updateOrderManually({ ...base, action: "fulfil" });
      success = (o) => ORDER_REPLY.completed(o, names);
      break;
    case "reopen":
      run = updateOrderManually({ ...base, action: "reopen" });
      success = (o) => ORDER_REPLY.reopened(o, names);
      break;
    case "cancel":
      run = updateOrderManually({ ...base, action: "cancel", reason: "cancelled by staff via WhatsApp" });
      success = (o) => ORDER_REPLY.cancelled(o, order.status, names);
      break;
    case "quantity": {
      if (order.items.length !== 1) return reject("several_products", ORDER_REPLY.severalProducts(order));
      const before = order.items[0].quantity;
      if (before !== null && before.trim() === String(action.quantity)) return reject("no_change", ORDER_REPLY.sameQuantity(order, action.quantity));
      run = updateOrderManually({ ...base, action: "edit", patch: { items: [{ ...order.items[0], quantity: String(action.quantity) }] } });
      success = (o) => ORDER_REPLY.quantity(o, before, action.quantity, names);
      break;
    }
    case "delivery": {
      // "tomorrow" counts from when the staff member wrote it.
      const at = writtenAt ? new Date(writtenAt) : now;
      const when = anchorRequestedFor(action.when, order.requested_for, at, tz) ?? action.when;
      if (when === order.requested_for) return reject("no_change", ORDER_REPLY.sameDelivery(order));
      run = updateOrderManually({ ...base, action: "edit", patch: { requested_for: when } });
      success = (o) => ORDER_REPLY.delivery(o, when, names);
      break;
    }
  }
  const result = await run;
  // One success notice per WhatsApp message, however many times it is delivered (the key is the message, not the event);
  // a retry after a crash that lost the first notice still gets one, because nothing was queued yet.
  if (result.ok) return groupReply(settings, fromGroup, args.eventId, success(result.order), "staff_notice", `orders:cmd_${action.type}_${result.duplicate ? "repeated" : "applied"}`, `ordercmd:${slug}:${args.whatsappMessageId}:ack`);
  switch (result.code) {
    case "stale":
      return reject("stale", ORDER_REPLY.stale(order));
    case "conflict":
      return reject("conflict", ORDER_REPLY.conflict(order));
    case "closed":
      return reject("closed", ORDER_REPLY.closed(order));
    case "incomplete":
      return reject("incomplete", ORDER_REPLY.incomplete(order, "required details"));
    default:
      return reject("failed", ORDER_REPLY.failed());
  }
}

const displayRefText = (o: TrackedOrder) => `#${o.ref_code.replace(/^O-/, "")}`;
