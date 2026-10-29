// Server-only: "!order #REF teach …" as a short conversation (migration 20261111000000), and the customer-preference proposals
// (P-CODE) it can end in. Pure rules: lib/aiAgent/orderTeachSession.ts.
//
// A session is bound to ONE order and ONE staff member in ONE group. A reply binds to it by
//   1. the message it quotes — our question's outbox row carries the session id in its dedupe key (teach:<id>:q<turn>) and the
//      bridge's acknowledgement stores the WhatsApp id, so only the exact question is meant; or
//   2. without a quote, the same verified sender having exactly one open session in the same group, and the model finding the
//      message to be about it (ordinary chatter is left alone).
// A session never applies anything. It ends in the existing proposals: a correction (C-CODE, applied by orderCorrections.ts) and,
// separately, a customer preference (P-CODE, applied here after !confirm). Nothing is saved without its own confirmation.

import { type CorrectionCommand } from "@/lib/aiAgent/orderCommands";
import { NUMBER_REPLY } from "@/lib/aiAgent/orderNumbers";
import { CORRECTION_REPLY, CORRECTION_TTL_MS, type CorrectionPlan } from "@/lib/aiAgent/orderTeach";
import {
  emptyState,
  FACT_LABEL,
  isCancelReply,
  type KnownProducts,
  MAX_SESSION_TURNS,
  parseTeachUnderstanding,
  type PreferenceFact,
  PREFERENCE_TTL_MS,
  planTeaching,
  SESSION_TTL_MS,
  TEACH_REPLY,
  type TeachPlan,
  type TeachState,
  type TeachTurn,
} from "@/lib/aiAgent/orderTeachSession";
import { reliableHistory } from "@/lib/aiAgent/orderHistory";
import { dayContext, dayLabel } from "@/lib/aiAgent/orderViews";
import { ORDER_REPLY } from "@/lib/aiAgent/orderCommands";
import { isOpenStatus, orderProductText, type OrderNames, type TrackedOrder } from "@/lib/aiAgent/orders";
import { agentDb, audit, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { customerKeys, loadStaffLocationSafe, loadStaffUsualProductSafe, saveStaffLocation, saveStaffUsualProduct } from "@/lib/server/aiAgent/customerStaffMemory";
import { proposeOrderCorrection } from "@/lib/server/aiAgent/model";
import { createProposal, move, type ProposalRow, proposalBySource, supersedePending } from "@/lib/server/aiAgent/orderProposals";
import {
  type CommandContext,
  groupReply,
  guardOrderCommand,
  loadCustomerHistory,
  loadOrderById,
  loadOrderByRef,
  loadOrderNames,
  tzOf,
  type UpdateCommandResult,
} from "@/lib/server/aiAgent/orders";

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** A table, column, function or constraint this code needs is not in the database yet (the migration was not run). */
export function isSchemaPending(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const m = (e?.message ?? (typeof err === "string" ? err : "")).toLowerCase();
  return (
    ["42P01", "42883", "PGRST205", "PGRST202"].includes(e?.code ?? "") ||
    m.includes("could not find the table") ||
    m.includes("could not find the function") ||
    m.includes("does not exist") ||
    m.includes("violates check constraint") ||
    m.includes("schema cache")
  );
}

export interface TeachContext extends CommandContext {
  whatsappMessageId: string;
  timestamp: string | null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  business_slug: string;
  group_jid: string;
  started_by: string;
  order_id: string;
  order_ref: string;
  order_version: number;
  source_message_id: string;
  status: "open" | "proposed" | "cancelled" | "expired" | "superseded" | "failed";
  turn: number;
  transcript: TeachTurn[];
  state: Partial<TeachState>;
  expires_at: string;
}

const SESSION_COLUMNS = "id, business_slug, group_jid, started_by, order_id, order_ref, order_version, source_message_id, status, turn, transcript, state, expires_at";

const questionKey = (sessionId: string, turn: number) => `teach:${sessionId}:q${turn}`;
const stateOf = (row: SessionRow): TeachState => ({ ...emptyState(), ...row.state });
const staffTurns = (transcript: TeachTurn[]) => transcript.filter((t) => t.by === "staff").map((t) => t.text);

async function sessionBySource(slug: string, messageId: string): Promise<SessionRow | null> {
  const { data, error } = await agentDb().from("ai_agent_teach_sessions").select(SESSION_COLUMNS).eq("business_slug", slug).eq("source_message_id", messageId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SessionRow | null) ?? null;
}

async function sessionById(slug: string, id: string): Promise<SessionRow | null> {
  const { data, error } = await agentDb().from("ai_agent_teach_sessions").select(SESSION_COLUMNS).eq("business_slug", slug).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SessionRow | null) ?? null;
}

async function openSessions(slug: string, group: string, startedBy: string, now: Date): Promise<SessionRow[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_teach_sessions")
    .select(SESSION_COLUMNS)
    .eq("business_slug", slug)
    .eq("group_jid", group)
    .eq("started_by", startedBy)
    .eq("status", "open")
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as SessionRow[];
}

/** A conditional change: true only when the session was still open at the turn this call read (two racing replies cannot both win). */
async function advance(row: SessionRow, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_teach_sessions")
    .update(patch)
    .eq("business_slug", row.business_slug)
    .eq("id", row.id)
    .eq("status", "open")
    .eq("turn", row.turn)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

const closeSession = (row: SessionRow, status: SessionRow["status"], now: Date) => advance(row, { status, resolved_at: now.toISOString() });

/** A new teach on an order replaces the same staff member's open conversation about it. Other staff and other orders are untouched. */
async function supersedeOpen(slug: string, group: string, startedBy: string, orderId: string, now: Date): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_teach_sessions")
    .update({ status: "superseded", resolved_at: now.toISOString() })
    .eq("business_slug", slug)
    .eq("group_jid", group)
    .eq("started_by", startedBy)
    .eq("order_id", orderId)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

// ── What the model and the plan need ─────────────────────────────────────────

async function productKnowledge(slug: string): Promise<{ title: string; content: string }[]> {
  try {
    return (await loadActiveKnowledge(slug))
      .filter((k) => ["product", "price", "delivery"].includes(k.kind))
      .slice(0, 60)
      .map((k) => ({ title: clip(k.title, 80), content: clip(k.content, 200) }));
  } catch {
    return [];
  }
}

/** Short, structured examples of what staff taught before. They steer wording only; their values are never reused. */
async function recentCorrections(slug: string): Promise<{ instruction: string; fields: string[] }[]> {
  try {
    const { data } = await agentDb().from("ai_agent_order_feedback").select("instruction, fields").eq("business_slug", slug).order("created_at", { ascending: false }).limit(5);
    return ((data ?? []) as { instruction: string; fields: string[] }[]).map((f) => ({ instruction: clip(f.instruction, 200), fields: f.fields }));
  } catch {
    return [];
  }
}

const orderForModel = (o: TrackedOrder) => ({
  ref: o.ref_code,
  status: o.status,
  customer_name: o.customer_name,
  items: o.items.map((i) => ({ product: i.product, quantity: i.quantity, variant: i.variant, size: i.size })),
  fulfilment_method: o.fulfilment_method ?? "delivery (default)",
  delivery_address: o.delivery_address,
  requested_for: o.requested_for,
  notes: o.notes,
});

const keysOf = (order: TrackedOrder) => customerKeys(order.chat_id, { phone: order.contact_number, chatIds: [order.chat_id] });

interface Records {
  known: KnownProducts;
  usualProduct: string | null;
  usualLocation: string | null;
}

/** Verified records only: the order, the customer's reliable earlier orders, approved product knowledge, staff-saved memory. */
async function loadRecords(slug: string, order: TrackedOrder, knowledge: { title: string }[]): Promise<Records> {
  const keys = keysOf(order).all;
  const [history, usual, location] = await Promise.all([
    loadCustomerHistory(slug, [order.chat_id], order.contact_number).catch(() => []),
    loadStaffUsualProductSafe(slug, keys),
    loadStaffLocationSafe(slug, keys),
  ]);
  const products: KnownProducts["products"] = [];
  const add = (text: string, source: KnownProducts["products"][number]["source"]) => {
    if (text && !products.some((p) => p.text.toLowerCase() === text.toLowerCase())) products.push({ text, source });
  };
  if (usual) add(usual.content, "saved");
  for (const i of order.items) add(orderProductText(i), "order");
  for (const o of reliableHistory(history, [order.id])) for (const i of o.items) add(orderProductText(i), "history");
  for (const k of knowledge) add(k.title, "knowledge");
  return { known: { products }, usualProduct: usual?.content ?? null, usualLocation: location?.content ?? null };
}

// ── Starting and continuing a conversation ───────────────────────────────────

type Say = (body: string, outcome: string, key?: string) => UpdateCommandResult;
type Reject = (reason: string, body: string, key?: string) => Promise<UpdateCommandResult>;
export interface TeachHandlers {
  say: Say;
  reject: Reject;
}

const merge = (...parts: UpdateCommandResult[]): UpdateCommandResult => ({ outbox: parts.flatMap((p) => p.outbox), queued: parts.flatMap((p) => p.queued), outcome: parts[0]?.outcome ?? "teach" });

interface Understood {
  plan: TeachPlan;
  /** false: the message is not about this conversation. */
  related: boolean;
}

async function understand(args: {
  slug: string;
  order: TrackedOrder;
  transcript: TeachTurn[];
  state: TeachState;
  names: OrderNames;
  at: Date;
  tz: string;
}): Promise<Understood | { error: "unavailable" | "unreadable"; detail: string | null }> {
  const { slug, order, transcript, state, names, at, tz } = args;
  const knowledge = await productKnowledge(slug);
  const records = await loadRecords(slug, order, knowledge.filter((k) => k.title));
  const today = dayContext(at, tz).today;
  const answer = await proposeOrderCorrection({
    businessSlug: slug,
    instruction: staffTurns(transcript).slice(-1)[0] ?? "",
    order: orderForModel(order),
    today: `${dayLabel(today)} (${today})`,
    knowledge,
    recentCorrections: await recentCorrections(slug),
    conversation: transcript.map((t) => ({ by: t.by, text: t.text })),
    customerRecords: { products: records.known.products.filter((p) => p.source !== "knowledge").map((p) => p.text).slice(0, 12), usualProduct: records.usualProduct, usualLocation: records.usualLocation },
  });
  const understanding = answer.text ? parseTeachUnderstanding(answer.text) : null;
  if (!understanding) return { error: answer.error ? "unavailable" : "unreadable", detail: answer.error };
  const customerName = names[order.id]?.name ?? order.customer_name;
  const plan = planTeaching({ order, understanding, turns: staffTurns(transcript), state, known: records.known, customerName, at, timezone: tz });
  return { plan, related: understanding.related };
}

/** The proposals a finished conversation ends in: a correction (C-CODE) and, separately, a customer preference (P-CODE). */
async function propose(args: {
  ctx: TeachContext & TeachHandlers;
  order: TrackedOrder;
  names: OrderNames;
  plan: TeachPlan;
  evidence: string;
  now: Date;
}): Promise<UpdateCommandResult> {
  const { ctx, order, names, plan, evidence, now } = args;
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const parts: UpdateCommandResult[] = [];
  let correctionCode: string | null = null;
  let prefNote = "";

  if (plan.correction && plan.correction.changes.length > 0) {
    const correction: CorrectionPlan = plan.correction;
    await supersedePending(slug, "correction", order.id);
    const created = await createProposal({
      slug,
      kind: "correction",
      groupJid: ctx.fromGroup,
      createdBy: senderAuth.senderId,
      messageId: ctx.whatsappMessageId,
      orderId: order.id,
      orderVersion: order.version,
      instruction: clip(evidence, 600),
      payload: (code) => ({
        ref: order.ref_code,
        patch: correction.patch,
        changes: correction.changes.map((c) => ({ field: c.field, label: c.label, before: c.before, after: c.after, beforeValue: c.beforeValue, afterValue: c.afterValue, wasLocked: c.wasLocked })),
        reusable: correction.reusable,
        preview: [CORRECTION_REPLY.preview(order, names, correction, code, evidence), ...plan.notes.map((n) => `ℹ️ ${n}`)].join("\n"),
      }),
      ttlMs: CORRECTION_TTL_MS,
      now,
    });
    correctionCode = created.row.code;
    if (!created.existing) await audit(slug, "staff", senderAuth.senderId, "orders.teach_proposed", { type: "order", id: order.id }, { code: created.row.code, fields: correction.changes.map((c) => c.field), version: order.version });
    parts.push(ctx.say(String(created.row.payload.preview), created.existing ? "teach_repeated" : "teach_proposed", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`));
  }

  if (plan.facts.length > 0) {
    try {
      await supersedePending(slug, "customer_preference", order.id);
      const keys = keysOf(order);
      const created = await createProposal({
        slug,
        kind: "customer_preference",
        groupJid: ctx.fromGroup,
        createdBy: senderAuth.senderId,
        messageId: ctx.whatsappMessageId,
        orderId: order.id,
        orderVersion: order.version,
        instruction: clip(evidence, 600),
        payload: (code) => ({
          ref: order.ref_code,
          facts: plan.facts,
          customer: { primary: keys.primary, keys: keys.all, chatId: order.chat_id, phone: order.contact_number, label: clip(names[order.id]?.name ?? order.customer_name ?? "customer", 80) },
          preview: TEACH_REPLY.preferencePreview(order, names, plan.facts, code, evidence, correctionCode),
        }),
        ttlMs: PREFERENCE_TTL_MS,
        now,
      });
      if (!created.existing) await audit(slug, "staff", senderAuth.senderId, "orders.preference_proposed", { type: "order", id: order.id }, { code: created.row.code, facts: plan.facts.map((f) => f.type) });
      parts.push(ctx.say(String(created.row.payload.preview), created.existing ? "preference_repeated" : "preference_proposed", `ordercorr:${slug}:${ctx.whatsappMessageId}:prefpreview`));
    } catch (err) {
      if (!isSchemaPending(err)) throw err;
      prefNote = TEACH_REPLY.preferencePending();
      parts.push(ctx.say(prefNote, "preference_pending", `ordercorr:${slug}:${ctx.whatsappMessageId}:prefpending`));
    }
  }
  return merge(...parts);
}

export async function startTeaching(ctx: TeachContext & TeachHandlers, command: Extract<CorrectionCommand, { kind: "teach" }>, writtenAt: Date): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const tz = tzOf(settings);
  const now = ctx.now ?? new Date();

  // The same WhatsApp message again: what it started is shown again, and the model is not asked twice.
  for (const kind of ["correction", "customer_preference"] as const) {
    const repeated = await proposalBySource(slug, ctx.whatsappMessageId, kind);
    if (!repeated) continue;
    const preview = typeof repeated.payload.preview === "string" ? repeated.payload.preview : null;
    return ctx.say(repeated.status === "pending" && preview ? preview : CORRECTION_REPLY.alreadyApplied(repeated.code), "teach_repeated", `ordercorr:${slug}:${ctx.whatsappMessageId}:${kind === "correction" ? "preview" : "prefpreview"}`);
  }
  const earlier = await sessionBySource(slug, ctx.whatsappMessageId).catch((err) => (isSchemaPending(err) ? null : Promise.reject(err)));
  if (earlier) {
    const q = earlier.state.questions ?? [];
    return ctx.say(q.length > 0 && earlier.status === "open" ? TEACH_REPLY.ask({ ref_code: earlier.order_ref } as TrackedOrder, undefined, q, []) : TEACH_REPLY.expired(earlier.order_ref), "teach_repeated", questionKey(earlier.id, 1));
  }

  const ref = command.selector.type === "ref" ? command.selector.ref : "";
  const order = await loadOrderByRef(slug, ref);
  if (!order) return ctx.reject("not_found", ORDER_REPLY.noRef(ref));
  if (!isOpenStatus(order.status)) return ctx.reject("closed", CORRECTION_REPLY.closed(order));
  if (ctx.requiredVersion !== undefined && order.version !== ctx.requiredVersion) return ctx.reject("list_stale", NUMBER_REPLY.changed(`#${order.ref_code.replace(/^O-/, "")}`));
  const names = await loadOrderNames(slug, [order]);

  const transcript: TeachTurn[] = [{ by: "staff", text: command.instruction, at: writtenAt.toISOString(), messageId: ctx.whatsappMessageId }];
  const result = await understand({ slug, order, transcript, state: emptyState(), names, at: writtenAt, tz });
  if ("error" in result) {
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_unreadable", { type: "order", id: order.id }, { error: result.detail ? clip(result.detail, 200) : "unparseable" });
    return ctx.reject(result.error === "unavailable" ? "model_unavailable" : "not_understood", result.error === "unavailable" ? CORRECTION_REPLY.unavailable() : CORRECTION_REPLY.ambiguous(order, names, ["I could not read that."]));
  }
  const { plan } = result;

  if (plan.kind === "nothing") return ctx.say(TEACH_REPLY.nothing(order, names, plan.notes), "teach_nothing", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);

  if (plan.kind === "propose") {
    const done = await propose({ ctx, order, names, plan, evidence: command.instruction, now });
    return done;
  }

  // Questions: open a conversation, if the database can hold one.
  const ask = TEACH_REPLY.ask(order, names, plan.questions, plan.notes);
  try {
    const replaced = await supersedeOpen(slug, ctx.fromGroup, senderAuth.senderId ?? "unknown", order.id, now);
    const withQuestion: TeachTurn[] = [...transcript, { by: "assistant", text: plan.questions.map((q) => q.text).join(" "), at: now.toISOString() }];
    const { data, error } = await agentDb()
      .from("ai_agent_teach_sessions")
      .insert({
        business_slug: slug,
        group_jid: ctx.fromGroup,
        started_by: senderAuth.senderId ?? "unknown",
        order_id: order.id,
        order_ref: order.ref_code,
        order_version: order.version,
        source_message_id: ctx.whatsappMessageId,
        turn: 1,
        transcript: withQuestion,
        state: plan.state,
        expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      })
      .select(SESSION_COLUMNS)
      .single();
    if (error?.code === "23505") {
      // The same WhatsApp message again: ask the same question again (same outbox key, so it is posted once).
      const same = await sessionBySource(slug, ctx.whatsappMessageId);
      if (same) return ctx.say(TEACH_REPLY.ask(order, names, same.state.questions ?? plan.questions, []), "teach_repeated", questionKey(same.id, 1));
    }
    if (error || !data) throw new Error(error?.message ?? "insert failed");
    const session = data as SessionRow;
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_asked", { type: "order", id: order.id }, { session: session.id, questions: plan.questions.map((q) => q.key), replaced });
    return ctx.say(replaced ? `${TEACH_REPLY.restarted(order)}\n${ask}` : ask, "teach_asked", questionKey(session.id, 1));
  } catch (err) {
    if (!isSchemaPending(err)) throw err;
    return ctx.say([TEACH_REPLY.sessionsPending(), ...plan.questions.map((q) => `• ${q.text}`)].join("\n"), "teach_needs_more", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);
  }
}

export interface TeachReplyArgs extends TeachContext {
  text: string;
}

/**
 * A staff message that may be the answer to one of our teaching questions. Returns null when it is not (the caller carries on as
 * usual), so ordinary chatter is never swallowed. Authorization and the group are checked before anything about a session is said.
 */
export async function maybeHandleTeachReply(args: TeachReplyArgs): Promise<UpdateCommandResult | null> {
  const { settings, fromGroup, senderAuth } = args;
  const text = args.text.trim();
  if (!text || text.startsWith("!")) return null;
  const slug = settings.business_slug;
  const now = args.now ?? new Date();
  const writtenAt = args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? new Date(args.timestamp) : now;

  let session: SessionRow | null = null;
  let viaQuote = false;
  try {
    if (args.quotedMessageId) {
      const { data, error } = await agentDb().from("ai_agent_outbox").select("dedupe_key, to_jid").eq("business_slug", slug).eq("whatsapp_message_id", args.quotedMessageId).maybeSingle();
      if (error) throw new Error(error.message);
      const m = data?.dedupe_key?.match(/^teach:([0-9a-f-]{36}):q\d+$/);
      if (!m || data?.to_jid !== fromGroup) return null;
      session = await sessionById(slug, m[1]);
      viaQuote = true;
      if (!session) return null;
    } else {
      if (!senderAuth.authorized || !senderAuth.senderId) return null;
      const open = await openSessions(slug, fromGroup, senderAuth.senderId, now);
      if (open.length === 0) return null;
      if (open.length > 1) {
        // Several conversations are waiting on this person: only a short, answer-like message gets the nudge; chatter is left alone.
        if (text.length > 80) return null;
        return groupReply(settings, fromGroup, args.eventId, TEACH_REPLY.pickOne(open.map((s) => s.order_ref)), "staff_notice", "orders:teach_pick_one", `teach:pick:${slug}:${args.whatsappMessageId}`);
      }
      session = open[0];
    }
  } catch (err) {
    if (isSchemaPending(err)) return null;
    throw err;
  }

  const outcome = (what: string) => `orders:${what}`;
  const say = (body: string, what: string, key = `teach:${session!.id}:r${args.whatsappMessageId}`) => groupReply(settings, fromGroup, args.eventId, body, "staff_notice", outcome(what), key);
  const reject = async (reason: string, body: string) => {
    await audit(slug, "staff", senderAuth.senderId, "orders.command_rejected", { type: "chat", id: fromGroup }, { reason, command: "teach_reply", session: session!.id });
    return say(body, `teach_${reason}`);
  };

  // Who may answer, and where, is decided before anything about the session is revealed.
  const refused = await guardOrderCommand(args);
  if (refused) return viaQuote ? refused : null;
  if (session.group_jid !== fromGroup) return null;
  if (session.started_by !== (senderAuth.senderId ?? "")) return viaQuote ? reject("not_yours", TEACH_REPLY.notYours(session.order_ref)) : null;
  if (session.transcript.some((t) => t.messageId === args.whatsappMessageId)) return { outbox: [], queued: [], outcome: outcome("teach_duplicate") };

  if (session.status !== "open") {
    return viaQuote ? reject(`closed_${session.status}`, session.status === "expired" ? TEACH_REPLY.expired(session.order_ref) : `ℹ️ That conversation about ${session.order_ref.replace(/^O-/, "#")} is closed (${session.status}). Nothing changed. Start again with !order ${session.order_ref.replace(/^O-/, "#")} teach …`) : null;
  }
  if (Date.parse(session.expires_at) <= now.getTime()) {
    await closeSession(session, "expired", now);
    return viaQuote ? reject("expired", TEACH_REPLY.expired(session.order_ref)) : null;
  }

  const order = await loadOrderById(slug, session.order_id);
  if (!order) {
    await closeSession(session, "failed", now);
    return reject("order_gone", ORDER_REPLY.noRef(session.order_ref));
  }
  if (isCancelReply(text)) {
    await closeSession(session, "cancelled", now);
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_cancelled", { type: "order", id: order.id }, { session: session.id });
    return say(TEACH_REPLY.cancelled(order), "teach_cancelled");
  }
  if (!isOpenStatus(order.status) || order.version !== session.order_version) {
    await closeSession(session, "failed", now);
    return reject("order_changed", TEACH_REPLY.orderChanged(order));
  }
  if (staffTurns(session.transcript).length >= MAX_SESSION_TURNS) {
    await closeSession(session, "failed", now);
    return reject("too_long", TEACH_REPLY.tooLong(order));
  }

  const names = await loadOrderNames(slug, [order]);
  const transcript: TeachTurn[] = [...session.transcript, { by: "staff", text: clip(text, 700), at: writtenAt.toISOString(), messageId: args.whatsappMessageId }];
  const result = await understand({ slug, order, transcript, state: stateOf(session), names, at: writtenAt, tz: tzOf(settings) });
  if ("error" in result) return reject(result.error === "unavailable" ? "model_unavailable" : "not_understood", result.error === "unavailable" ? CORRECTION_REPLY.unavailable() : TEACH_REPLY.unrelated(order));
  if (!result.related) return viaQuote ? reject("unrelated", TEACH_REPLY.unrelated(order)) : null;
  const { plan } = result;

  if (plan.kind === "ask") {
    const turn = session.turn + 1;
    const withQuestion: TeachTurn[] = [...transcript, { by: "assistant", text: plan.questions.map((q) => q.text).join(" "), at: now.toISOString() }];
    const moved = await advance(session, { turn, transcript: withQuestion, state: plan.state, expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString() });
    if (!moved) return say(CORRECTION_REPLY.busy(session.order_ref), "teach_busy");
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_asked", { type: "order", id: order.id }, { session: session.id, turn, questions: plan.questions.map((q) => q.key) });
    return say(TEACH_REPLY.ask(order, names, plan.questions, plan.notes), "teach_asked", questionKey(session.id, turn));
  }

  // Settled: close the conversation first (a conditional update), so a racing second reply cannot propose twice.
  const closed = await advance(session, { status: "proposed", turn: session.turn + 1, transcript, state: plan.state, resolved_at: now.toISOString() });
  if (!closed) return say(CORRECTION_REPLY.busy(session.order_ref), "teach_busy");
  const evidence = staffTurns(transcript).join(" ");
  if (plan.kind === "nothing") return say(TEACH_REPLY.nothing(order, names, plan.notes), "teach_nothing");
  const handlers: TeachHandlers = { say, reject };
  return propose({ ctx: { ...args, ...handlers }, order, names, plan, evidence, now });
}

// ── Applying a customer preference (!confirm P-CODE) ─────────────────────────

interface PreferencePayload {
  ref: string;
  facts: PreferenceFact[];
  customer: { primary: string; keys: string[]; chatId: string; phone: string | null; label: string };
}

async function setDisplayName(phone: string | null, name: string): Promise<{ before: string; changed: boolean }> {
  if (!phone) throw new Error("this order has no verified phone number, so there is no customer profile to name");
  const db = agentDb();
  const { data, error } = await db.from("customers").select("first_name, last_name").eq("phone_number", phone).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("no customer profile found for this phone number");
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.join(" ") || null;
  const before = [data.first_name, data.last_name].filter(Boolean).join(" ");
  if (data.first_name === first && (data.last_name ?? null) === last) return { before, changed: false };
  const { error: updateError } = await db.from("customers").update({ first_name: first, last_name: last }).eq("phone_number", phone);
  if (updateError) throw new Error(updateError.message);
  return { before, changed: true };
}

/** Applies a pending customer-preference proposal. The caller has already checked the sender, the group, the code and the expiry. */
export async function applyPreference(ctx: TeachContext & TeachHandlers, row: ProposalRow, speak: Say, stateReply: (row: ProposalRow) => string): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const now = ctx.now ?? new Date();
  const claimed = (await move(row, ["pending"], "applying", { claimed_at: now.toISOString() })) || (await move(row, ["partial"], "applying", { claimed_at: now.toISOString() }));
  if (!claimed) return speak(stateReply(row), "proposal_not_pending");

  const payload = row.payload as unknown as PreferencePayload;
  const order = row.order_id ? await loadOrderById(slug, row.order_id) : null;
  const lines: string[] = [];
  const failures: string[] = [];
  let schemaPending = false;
  for (const fact of payload.facts) {
    try {
      const keys = { primary: payload.customer.primary, all: payload.customer.keys };
      if (fact.type === "usual_product") {
        const r = await saveStaffUsualProduct({ businessSlug: slug, keys, product: fact.label, setBy: senderAuth.senderId, messageId: `pref:${row.id}:usual`, eventId: ctx.eventId, chatId: payload.customer.chatId, label: payload.customer.label });
        lines.push(`${FACT_LABEL.usual_product}: ${fact.label}${r.previous && r.result === "updated" ? ` (replaces ${clip(r.previous, 60)})` : r.result === "unchanged" ? " (already saved)" : ""}`);
      } else if (fact.type === "delivery_location") {
        const r = await saveStaffLocation({ businessSlug: slug, keys, location: fact.value, setBy: senderAuth.senderId, messageId: `pref:${row.id}:loc`, eventId: ctx.eventId, chatId: payload.customer.chatId, label: payload.customer.label });
        lines.push(`${FACT_LABEL.delivery_location}: ${fact.value}${r.previous && r.result === "updated" ? ` (replaces ${clip(r.previous, 60)})` : r.result === "unchanged" ? " (already saved)" : ""}`);
      } else {
        const r = await setDisplayName(payload.customer.phone, fact.value);
        lines.push(`${FACT_LABEL.display_name}: ${fact.value}${r.before && r.changed ? ` (was ${clip(r.before, 40)})` : r.changed ? "" : " (already set)"}`);
      }
      await audit(slug, "staff", senderAuth.senderId, "orders.preference_applied", { type: "order_proposal", id: row.id }, { code: row.code, fact: fact.type, value: clip(fact.label, 120), customer_key: payload.customer.primary, order: payload.ref });
    } catch (err) {
      schemaPending ||= isSchemaPending(err);
      failures.push(`${FACT_LABEL[fact.type]}: ${clip(err instanceof Error ? err.message : "failed", 100)}`);
    }
  }
  if (failures.length === 0) {
    await move(row, ["applying"], "applied", { resolved_at: now.toISOString(), resolved_by: senderAuth.senderId, result: { lines } });
    const names = order ? await loadOrderNames(slug, [order]) : undefined;
    return speak(order ? TEACH_REPLY.preferenceApplied(order, names, lines) : `✅ Saved:\n${lines.map((l) => `• ${l}`).join("\n")}`, "preference_applied");
  }
  if (lines.length === 0) {
    await move(row, ["applying"], "pending", { claimed_at: null });
    return speak(schemaPending ? TEACH_REPLY.preferencePending() : TEACH_REPLY.preferenceFailed(row.code, failures), "preference_failed");
  }
  await move(row, ["applying"], "partial", { resolved_by: senderAuth.senderId, result: { lines, failures }, expires_at: new Date(now.getTime() + PREFERENCE_TTL_MS).toISOString() });
  return speak(TEACH_REPLY.preferenceFailed(row.code, [...lines.map((l) => `saved: ${l}`), ...failures]), "preference_partial");
}
