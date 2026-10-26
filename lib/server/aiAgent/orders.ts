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
  generateRefCode,
  hasSeparateOrdersGroup,
  ordersGroupJid,
  OrderRequestDraft,
  outboxAllowed,
} from "@/lib/aiAgent/engine";
import { groundOrderDraft } from "@/lib/aiAgent/escalationUpdates";
import { SenderAuthorization } from "@/lib/aiAgent/identity";
import {
  buildOrderSummary,
  type Coverage,
  computeMissing,
  DEFAULT_ORDERS_TIMEZONE,
  DEFAULT_SUMMARY_HOUR,
  EDITABLE_ORDER_FIELDS,
  EditableOrderField,
  FieldChange,
  groundDeliveryPreference,
  isComplete,
  isOpenStatus,
  isWholeOrderCancellation,
  localParts,
  mergeDraft,
  OPEN_ORDER_STATUSES,
  OrderFields,
  OrderLine,
  OrderStatus,
  planOrderUpdate,
  resolveOrderTarget,
  scheduleState,
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
  "id, ref_code, business_slug, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_preference, delivery_address, requested_for, notes, missing_fields, attention, source_message_ids, first_message_at, last_message_at, awaiting_since, manual_locked_fields, confirmed_by, confirmed_at, customer_confirmed_at, cancelled_at, cancel_reason, fulfilled_at, version, created_at, updated_at";

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
  ctx: { chatId: string; phone: string | null; messageIds: string[]; firstAt: string; lastAt: string; locked?: string[] }
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
  /** The customer's recent words, for grounding. */
  customerWords: string[];
  messageIds: string[];
  firstAt: string;
  lastAt: string;
  /** Prefix of the idempotency keys: the batch or event id. A retried turn reuses it. */
  dedupeBase: string;
  /** False when replaying history (backfill): a "yes" then is not an answer to anything staff just wrote, so it records nothing. Default true. */
  allowConfirmation?: boolean;
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
  const withItems = drafts.filter((d) => d.draft.items.length > 0 && (args.intent === "order" || open.length > 0));
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
    // The model may only restate what the customer wrote: ground against the order it targets, not another.
    const grounded = groundOrderDraft(draft, existing ? asDraft(existing) : null, args.customerWords);
    if (!grounded || (grounded.items.length === 0 && !existing)) continue;
    // The customer's own delivery/collection words win, so "I'll collect instead" can replace "delivery".
    grounded.delivery_preference = groundDeliveryPreference(draft.delivery_preference, args.customerWords) ?? grounded.delivery_preference;
    // A whole-order cancellation in the same breath as a (re-stated) order must not create a new one.
    if (!existing && segments.some(isWholeOrderCancellation)) continue;

    await write(`${args.dedupeBase}:${index}`, existing, (cur) => {
      const merged = mergeDraft(cur ? fieldsOf(cur) : null, grounded, cur?.manual_locked_fields ?? [], name);
      const fields = merged.fields;
      const changed = cur ? merged.changes.length > 0 : true;
      const plan = planOrderUpdate({ existing: cur, fields, contentChanged: changed, customerTexts: segments, outboundSinceAwaiting: false, now });
      const attention = !cur && resolved.kind === "create" && resolved.flag ? resolved.flag : plan.attention;
      if (cur && plan.event === "no_change" && !changed) return null;
      const finalPlan = { ...plan, attention };
      return {
        row: rowFrom(cur, fields, finalPlan, ctx),
        event: finalPlan.event,
        actorKind: finalPlan.event === "customer_cancelled" ? "customer" : "ai",
        changes: { ...diff(merged.changes), ...(cur && cur.status !== finalPlan.status ? { status: { before: cur.status, after: finalPlan.status } } : {}) },
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

export type ManualAction = "edit" | "confirm" | "cancel" | "fulfil";

export interface ManualInput {
  businessSlug: string;
  orderId: string;
  adminId: string;
  action: ManualAction;
  expectedVersion?: number | null;
  patch?: Partial<Record<EditableOrderField, unknown>>;
  reason?: string | null;
}

export type ManualResult =
  | { ok: true; order: TrackedOrder }
  | { ok: false; status: number; error: string };

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
  if (error) return { ok: false, status: 500, error: error.message };
  const order = data as TrackedOrder | null;
  if (!order) return { ok: false, status: 404, error: "Order not found" };
  if (input.expectedVersion != null && input.expectedVersion !== order.version) {
    return { ok: false, status: 409, error: "This order changed since you opened it — reload and try again" };
  }
  if (!isOpenStatus(order.status)) return { ok: false, status: 409, error: `The order is already ${order.status}` };

  const now = new Date().toISOString();
  let fields = fieldsOf(order);
  let locked = order.manual_locked_fields;
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
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    const changedFields = Object.keys(checked.fields) as EditableOrderField[];
    if (changedFields.length === 0) return { ok: false, status: 400, error: "Nothing to change" };
    fields = { ...fields, ...checked.fields };
    // Choosing the method by hand also fixes the free-text preference so the two cannot disagree.
    if (checked.fields.fulfilment_method !== undefined) fields.delivery_preference = checked.fields.fulfilment_method;
    for (const f of changedFields) changes[f] = { before: order[f], after: fields[f] };
    locked = unique([...locked, ...changedFields]);
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
    if (!isComplete(missing)) return { ok: false, status: 409, error: "Add the missing details before confirming (products, quantity, delivery or collection, address)" };
    status = "confirmed";
    attention = null;
    confirmedBy = `admin:${input.adminId}`;
    confirmedAt = now;
    changes.status = { before: order.status, after: status };
  } else if (action === "cancel") {
    status = "cancelled";
    cancelledAt = now;
    cancelReason = (input.reason ?? "").trim().slice(0, 300) || "cancelled by staff";
    changes.status = { before: order.status, after: status, reason: cancelReason };
  } else {
    status = "fulfilled";
    fulfilledAt = now;
    changes.status = { before: order.status, after: status };
  }

  const row: OrderRow = {
    ...rowFrom(order, fields, { status, attention, awaitingSince, missing: computeMissing(fields), event: "no_change", confirmedByCustomer: false, customerConfirmedAt }, {
      chatId: order.chat_id,
      phone: null,
      messageIds: [],
      firstAt: order.first_message_at,
      lastAt: order.last_message_at,
      locked,
    }),
    confirmed_by: status === "confirmed" || status === "fulfilled" ? confirmedBy : null,
    confirmed_at: status === "confirmed" || status === "fulfilled" ? confirmedAt : null,
    cancelled_at: cancelledAt,
    cancel_reason: cancelReason,
    fulfilled_at: fulfilledAt,
  };
  const res = await applyOrder({
    businessSlug,
    key: null,
    existing: order,
    row,
    event: `manual_${action}`,
    actorKind: "admin",
    actorId: input.adminId,
    changes,
    messageIds: [],
  });
  if (res.result === "conflict") return { ok: false, status: 409, error: "This order changed since you opened it — reload and try again" };
  if (res.result !== "applied") return { ok: false, status: 404, error: "Order not found" };
  await audit(businessSlug, "admin", input.adminId, `order.${action}`, { type: "order", id: orderId }, { ref: order.ref_code, changes });
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
  return buildOrderSummary({ businessLabel: businessLabel(settings.business_slug), timezone: tzOf(settings), now, orders, trigger, coverage });
}

function summaryItem(settings: AgentSettings, body: string, dedupeKey: string, eventId: string | null): OutboxInsert {
  const group = ordersGroupJid(settings)!;
  return { businessSlug: settings.business_slug, chatId: group, kind: "staff_notice", toJid: group, body, dedupeKey, eventId };
}

/** Builds the report from the database and queues it. Returns the outbox row, or null when the final gate refused. */
async function queueSummary(
  settings: AgentSettings,
  run: { id: string; trigger: "scheduled" | "manual"; dedupeKey: string; eventId?: string | null },
  now: Date,
  dispatchNow: boolean
): Promise<OutboxRow | null> {
  const summary = await buildSummaryNow(settings, run.trigger, now);
  const item = summaryItem(settings, summary.text, run.dedupeKey, run.eventId ?? null);
  if (!outboxAllowed(settings, item)) {
    await agentDb().from("ai_agent_order_summary_runs").update({ status: "skipped", skip_reason: "send_not_permitted" }).eq("id", run.id);
    return null;
  }
  const rows = await enqueue([item], dispatchNow);
  // An existing row for this dedupe key (a resumed run) is the same send: never a second one.
  const outboxRow =
    rows[0] ??
    ((await agentDb().from("ai_agent_outbox").select("id, business_slug, kind, to_jid, body, status, reply_to_message_id, error").eq("dedupe_key", run.dedupeKey).maybeSingle()).data as OutboxRow | null);
  await agentDb()
    .from("ai_agent_order_summary_runs")
    .update({
      status: "queued",
      outbox_id: outboxRow?.id ?? null,
      group_jid: item.toJid,
      confirmed_count: summary.confirmed,
      attention_count: summary.attention,
      carried_count: summary.carriedForward,
    })
    .eq("id", run.id);
  return rows[0] ?? null;
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
  const row = await queueSummary(settings, { id: data.id, trigger: "manual", dedupeKey: `ordersummary:manual:${data.id}` }, now, false);
  await audit(settings.business_slug, kind, requestedBy, "orders.summary_manual", { type: "order_summary_run", id: data.id });
  return row ? { ok: true as const } : { ok: false as const, error: "The summary could not be posted in the current mode" };
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

/**
 * "!update" from a group message. `fromGroup` is the chat it came from. Authorization is the same verified
 * allow-list as "!send". The report is rebuilt from the database right now, with no model call.
 */
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
  const refuse = (text: string, outcome: string): UpdateCommandResult => {
    // A refusal goes back to the group the command came from, as that group's own kind.
    const kind = fromGroup === settings.staff_group_jid ? "staff_feedback" : "staff_notice";
    return { outbox: [{ businessSlug: slug, chatId: fromGroup, kind, toJid: fromGroup, body: text, dedupeKey: `${args.eventId}:orders_update_refusal`, eventId: args.eventId }], queued: [], outcome };
  };

  if (!settings.orders_summary_enabled) return refuse(UPDATE_REFUSAL.disabled, "orders:update_disabled");
  if (!target || fromGroup !== target) {
    await audit(slug, "staff", args.senderJid, "orders.update_rejected", { type: "chat", id: fromGroup }, { reason: "wrong_group" });
    return hasSeparateOrdersGroup(settings) && fromGroup === settings.staff_group_jid
      ? refuse(UPDATE_REFUSAL.other_group, "orders:update_wrong_group")
      : { outbox: [], queued: [], outcome: "orders:update_wrong_group" };
  }
  if (!senderAuth.authorized) {
    await audit(slug, "staff", args.senderJid, "orders.update_rejected", { type: "chat", id: fromGroup }, { reason: "unauthorized", sender: senderAuth.senderId });
    return refuse(UPDATE_REFUSAL.unauthorized, "orders:update_unauthorized");
  }
  if (!canPostOrderSummary(settings)) return refuse(UPDATE_REFUSAL.blocked, "orders:update_blocked");
  if (await recentManualRun(slug, now)) return refuse(UPDATE_REFUSAL.cooldown, "orders:update_cooldown");

  const { dateKey } = localParts(now, tzOf(settings));
  const { data, error } = await agentDb()
    .from("ai_agent_order_summary_runs")
    .insert({ business_slug: slug, trigger: "manual", local_date: dateKey, status: "claimed", requested_by: senderAuth.senderId, event_id: args.eventId, group_jid: target })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  // Dispatched in this very response: the person who typed !update is waiting for it.
  const row = await queueSummary(settings, { id: data.id, trigger: "manual", dedupeKey: `ordersummary:manual:${args.eventId}`, eventId: args.eventId }, now, true);
  await audit(slug, "staff", senderAuth.senderId, "orders.update_requested", { type: "order_summary_run", id: data.id });
  return { outbox: [], queued: row ? [row] : [], outcome: row ? "orders:update_sent" : "orders:update_blocked" };
}
