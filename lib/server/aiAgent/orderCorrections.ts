// Server-only: "!order #REF teach <words>" (a natural-language order correction) and "!orders complete all" (bulk completion),
// and the "!confirm C-CODE" / "!discard C-CODE" (also B-CODE) that settle them. Pure rules: lib/aiAgent/orderTeach.ts.
//
// Both commands are TWO steps. The first never changes an order: it stores a proposal (migration 20261109000000) and posts a
// preview with a one-time code. Only a confirmation applies it, and only if
//   * the sender is an authorized staff member writing in the configured Orders group of the SAME business (guardOrderCommand,
//     the checks every order command passes) and the proposal was made in that group;
//   * the proposal is still pending and unexpired, and was not replaced by a newer one;
//   * the order is exactly as it was previewed (same version, still open; for a bulk completion: same day and version per order).
// A proposal moves pending → applying → applied by conditional updates, so a repeated or racing confirm is a no-op.
//
// What an applied correction is: the Orders dashboard's own edit (updateOrderManually → apply_ai_agent_order), so it is
// version-checked, recorded in the order's history and the audit log, and marks the fields staff-locked: a later customer
// message can only raise a conflict for staff to settle, never overwrite them. An applied bulk completion is the same
// "fulfil" action per order, with one idempotency key per order.
//
// Neither command can address a customer: every output is a reply to the group the command came from. No customer memory,
// saved location or knowledge is written; an approved correction is only recorded as feedback (ai_agent_order_feedback), and
// a reusable fact is offered as a command for staff to run themselves (!remember / !teach), never saved here.

import { randomBytes } from "node:crypto";
import { generateRefCode } from "@/lib/aiAgent/engine";
import { type CorrectionCommand, isCorrectionCommand, type OrderCommand } from "@/lib/aiAgent/orderCommands";
import {
  BULK_REPLY,
  BULK_STATE_REPLY,
  BULK_TTL_MS,
  type BulkLine,
  type BulkPayload,
  bulkResultText,
  bulkScope,
  CLAIM_RETRY_MS,
  CORRECTION_REPLY,
  CORRECTION_TTL_MS,
  type CorrectionPlan,
  orderDay,
  parseCorrectionProposal,
  type PlannedChange,
  planCorrection,
  type ProposalKind,
  type ReusableSuggestion,
} from "@/lib/aiAgent/orderTeach";
import { NUMBER_REPLY } from "@/lib/aiAgent/orderNumbers";
import { dayContext, dayLabel } from "@/lib/aiAgent/orderViews";
import { ORDER_REPLY } from "@/lib/aiAgent/orderCommands";
import { isOpenStatus, type TrackedOrder } from "@/lib/aiAgent/orders";
import { agentDb, audit, loadActiveKnowledge } from "@/lib/server/aiAgent/db";
import { proposeOrderCorrection } from "@/lib/server/aiAgent/model";
import { resolveNumberedTarget } from "@/lib/server/aiAgent/orderNumberTarget";
import {
  type CommandContext,
  groupReply,
  guardOrderCommand,
  handleOrderCommand,
  loadOrderByRef,
  loadOrderNames,
  loadOutstandingOrders,
  MAX_COMMAND_AGE_MS,
  ORDER_COLUMNS,
  tzOf,
  type UpdateCommandResult,
  updateOrderManually,
} from "@/lib/server/aiAgent/orders";

export interface CorrectionCommandArgs extends CommandContext {
  command: CorrectionCommand;
  whatsappMessageId: string;
  /** When the staff member wrote the command (WhatsApp's own timestamp). */
  timestamp: string | null;
}

/**
 * Every order command, wherever it was typed (the staff group or the separate Orders group): proposals go to this file, the rest to
 * orders.ts. A command that names its order by a report number ("!order 2 completed") is first turned into the order reference
 * that number meant in the stored report (orderNumberTarget.ts); after that it is an ordinary #REF command.
 */
export async function runOrderCommand(args: Omit<CorrectionCommandArgs, "command"> & { command: OrderCommand }): Promise<UpdateCommandResult> {
  let command = args.command;
  let requiredVersion = args.requiredVersion;
  if ((command.kind === "update" || command.kind === "info" || command.kind === "teach") && command.selector.type === "number") {
    // Who may use commands, and where, is decided before anything about a list is revealed or looked up.
    const refused = await guardOrderCommand(args);
    if (refused) return refused;
    const target = await resolveNumberedTarget(args, command.selector.n, command.kind !== "info", args.now ?? new Date());
    if (!target.ok) return target.result;
    command = { ...command, selector: { type: "ref", ref: target.ref } } as OrderCommand;
    if (command.kind !== "info") requiredVersion = target.version;
  }
  const next = { ...args, requiredVersion };
  return isCorrectionCommand(command) ? handleCorrectionCommand({ ...next, command }) : handleOrderCommand({ ...next, command });
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

// ── Proposals ────────────────────────────────────────────────────────────────

type Status = "pending" | "applying" | "applied" | "partial" | "discarded" | "expired" | "superseded" | "stale" | "failed";

interface ProposalRow {
  id: string;
  business_slug: string;
  kind: ProposalKind;
  code: string;
  status: Status;
  group_jid: string;
  created_by: string | null;
  source_message_id: string;
  order_id: string | null;
  order_version: number | null;
  instruction: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  expires_at: string;
  claimed_at: string | null;
}

const PROPOSAL_COLUMNS = "id, business_slug, kind, code, status, group_jid, created_by, source_message_id, order_id, order_version, instruction, payload, result, expires_at, claimed_at";

async function proposalBySource(slug: string, messageId: string, kind: ProposalKind): Promise<ProposalRow | null> {
  const { data, error } = await agentDb().from("ai_agent_order_proposals").select(PROPOSAL_COLUMNS).eq("business_slug", slug).eq("source_message_id", messageId).eq("kind", kind).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProposalRow | null) ?? null;
}

/** Always filtered by business: another business's code is "unknown", never "somebody else's". */
async function proposalByCode(slug: string, code: string): Promise<ProposalRow | null> {
  const { data, error } = await agentDb().from("ai_agent_order_proposals").select(PROPOSAL_COLUMNS).eq("business_slug", slug).eq("code", code).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProposalRow | null) ?? null;
}

/** Conditional status change: true only when this call made it (the row was in one of `from`). */
async function move(row: ProposalRow, from: Status[], to: Status, patch: Record<string, unknown> = {}): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_order_proposals")
    .update({ status: to, ...patch })
    .eq("business_slug", row.business_slug)
    .eq("id", row.id)
    .in("status", from)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** A new proposal replaces any still-pending one it makes obsolete, so only the newest code can be confirmed. */
async function supersedePending(slug: string, kind: ProposalKind, orderId: string | null): Promise<void> {
  let q = agentDb().from("ai_agent_order_proposals").update({ status: "superseded", resolved_at: new Date().toISOString() }).eq("business_slug", slug).eq("kind", kind).eq("status", "pending");
  if (orderId) q = q.eq("order_id", orderId);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

const newCode = (kind: ProposalKind) => generateRefCode(randomBytes(8)).replace(/^E-/, kind === "correction" ? "C-" : "B-");

async function createProposal(args: {
  slug: string;
  kind: ProposalKind;
  groupJid: string;
  createdBy: string | null;
  messageId: string;
  orderId: string | null;
  orderVersion: number | null;
  instruction: string | null;
  payload: (code: string) => Record<string, unknown>;
  ttlMs: number;
  now: Date;
}): Promise<{ row: ProposalRow; existing: boolean }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode(args.kind);
    const { data, error } = await agentDb()
      .from("ai_agent_order_proposals")
      .insert({
        business_slug: args.slug,
        kind: args.kind,
        code,
        group_jid: args.groupJid,
        created_by: args.createdBy,
        source_message_id: args.messageId,
        order_id: args.orderId,
        order_version: args.orderVersion,
        instruction: args.instruction,
        payload: args.payload(code),
        expires_at: new Date(args.now.getTime() + args.ttlMs).toISOString(),
      })
      .select(PROPOSAL_COLUMNS)
      .single();
    if (!error && data) return { row: data as ProposalRow, existing: false };
    if (error?.code !== "23505") throw new Error(error?.message ?? "insert failed");
    // A unique violation is the same WhatsApp message arriving twice at once, or (rarely) a code collision.
    const same = await proposalBySource(args.slug, args.messageId, args.kind);
    if (same) return { row: same, existing: true };
  }
  throw new Error("Could not allocate a proposal code");
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function handleCorrectionCommand(args: CorrectionCommandArgs): Promise<UpdateCommandResult> {
  const { settings, fromGroup, command, senderAuth } = args;
  const slug = settings.business_slug;
  const refused = await guardOrderCommand(args);
  if (refused) return refused;

  const say = (body: string, outcome: string, key = `ordercorr:${slug}:${args.whatsappMessageId}:reply`) => groupReply(settings, fromGroup, args.eventId, body, "staff_notice", `orders:${outcome}`, key);
  const reject = async (reason: string, body: string, key?: string) => {
    await audit(slug, "staff", senderAuth.senderId, "orders.command_rejected", { type: "chat", id: fromGroup }, { reason, command: command.kind });
    return say(body, `cmd_${reason}`, key);
  };
  const ctx = { ...args, say, reject };
  try {
    if (command.kind === "proposal") return await handleReview(ctx, command);
    const now = args.now ?? new Date();
    const writtenAt = args.timestamp && !Number.isNaN(Date.parse(args.timestamp)) ? new Date(args.timestamp) : null;
    // A command written long ago (an offline catch-up) never starts a proposal: send it again.
    if (writtenAt && now.getTime() - writtenAt.getTime() > MAX_COMMAND_AGE_MS) {
      return reject("too_old", "⚠️ That command was written more than 2 hours ago, so nothing was started. Send it again if it is still right.");
    }
    return command.kind === "teach" ? await handleTeach(ctx, command, writtenAt ?? now) : await handleBulk(ctx, now);
  } catch (err) {
    console.error("[aiAgent] order correction", err instanceof Error ? err.message : err);
    return reject("failed", ORDER_REPLY.failed());
  }
}

type Ctx = CorrectionCommandArgs & { say: (body: string, outcome: string, key?: string) => UpdateCommandResult; reject: (reason: string, body: string, key?: string) => Promise<UpdateCommandResult> };

// ── !order #REF teach ────────────────────────────────────────────────────────

/** Short, structured examples of what staff taught before. They steer wording only; their values are never reused. */
async function recentCorrections(slug: string): Promise<{ instruction: string; fields: string[] }[]> {
  try {
    const { data } = await agentDb().from("ai_agent_order_feedback").select("instruction, fields").eq("business_slug", slug).order("created_at", { ascending: false }).limit(5);
    return ((data ?? []) as { instruction: string; fields: string[] }[]).map((f) => ({ instruction: clip(f.instruction, 200), fields: f.fields }));
  } catch {
    return [];
  }
}

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

const STORED_STATUS_REPLY = (row: ProposalRow, order: TrackedOrder | null): string => {
  switch (row.status) {
    case "applied":
    case "partial":
      return CORRECTION_REPLY.alreadyApplied(row.code);
    case "discarded":
      return CORRECTION_REPLY.alreadyDiscarded(row.code);
    case "superseded":
      return CORRECTION_REPLY.superseded(row.code);
    case "stale":
      return order ? CORRECTION_REPLY.stale(row.code, order) : CORRECTION_REPLY.unknown(row.code);
    case "expired":
      return CORRECTION_REPLY.expired(row.code);
    default:
      return CORRECTION_REPLY.busy(row.code);
  }
};

async function handleTeach(ctx: Ctx, command: Extract<CorrectionCommand, { kind: "teach" }>, writtenAt: Date): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const tz = tzOf(settings);

  // The same WhatsApp message again: the proposal it made is shown again, and the model is not asked twice.
  const repeated = await proposalBySource(slug, ctx.whatsappMessageId, "correction");
  if (repeated) {
    const preview = typeof repeated.payload.preview === "string" ? repeated.payload.preview : null;
    return ctx.say(repeated.status === "pending" && preview ? preview : STORED_STATUS_REPLY(repeated, null), "teach_repeated", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);
  }

  const order = await loadOrderByRef(slug, command.selector.type === "ref" ? command.selector.ref : "");
  if (!order) return ctx.reject("not_found", ORDER_REPLY.noRef(command.selector.type === "ref" ? command.selector.ref : ""));
  if (!isOpenStatus(order.status)) return ctx.reject("closed", CORRECTION_REPLY.closed(order));
  // Named by a report number: only if the order is exactly as that report showed it.
  if (ctx.requiredVersion !== undefined && order.version !== ctx.requiredVersion) return ctx.reject("list_stale", NUMBER_REPLY.changed(`#${order.ref_code.replace(/^O-/, "")}`));
  const names = await loadOrderNames(slug, [order]);

  const today = dayContext(writtenAt, tz).today;
  const answer = await proposeOrderCorrection({
    businessSlug: slug,
    instruction: command.instruction,
    order: orderForModel(order),
    today: `${dayLabel(today)} (${today})`,
    knowledge: await productKnowledge(slug),
    recentCorrections: await recentCorrections(slug),
  });
  const proposal = answer.text ? parseCorrectionProposal(answer.text) : null;
  if (!proposal) {
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_unreadable", { type: "order", id: order.id }, { error: answer.error ? clip(answer.error, 200) : "unparseable" });
    return ctx.reject(answer.error ? "model_unavailable" : "not_understood", answer.error ? CORRECTION_REPLY.unavailable() : CORRECTION_REPLY.ambiguous(order, names, ["I could not read that."]));
  }

  const plan: CorrectionPlan = planCorrection(order, proposal, { instruction: command.instruction, at: writtenAt, timezone: tz });
  if (plan.ambiguities.length > 0) {
    await audit(slug, "staff", senderAuth.senderId, "orders.teach_unclear", { type: "order", id: order.id }, { ambiguities: plan.ambiguities });
    return ctx.reject("ambiguous", CORRECTION_REPLY.ambiguous(order, names, plan.ambiguities));
  }
  if (plan.changes.length === 0) return ctx.reject("no_change", CORRECTION_REPLY.nothing(order, names));

  await supersedePending(slug, "correction", order.id);
  const created = await createProposal({
    slug,
    kind: "correction",
    groupJid: ctx.fromGroup,
    createdBy: senderAuth.senderId,
    messageId: ctx.whatsappMessageId,
    orderId: order.id,
    orderVersion: order.version,
    instruction: command.instruction,
    payload: (code) => ({
      ref: order.ref_code,
      patch: plan.patch,
      changes: plan.changes.map((c) => ({ field: c.field, label: c.label, before: c.before, after: c.after, beforeValue: c.beforeValue, afterValue: c.afterValue, wasLocked: c.wasLocked })),
      reusable: plan.reusable,
      preview: CORRECTION_REPLY.preview(order, names, plan, code, command.instruction),
    }),
    ttlMs: CORRECTION_TTL_MS,
    now: ctx.now ?? new Date(),
  });
  if (!created.existing) await audit(slug, "staff", senderAuth.senderId, "orders.teach_proposed", { type: "order", id: order.id }, { code: created.row.code, fields: plan.changes.map((c) => c.field), version: order.version });
  return ctx.say(String(created.row.payload.preview), created.existing ? "teach_repeated" : "teach_proposed", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);
}

// ── !order … / !orders complete all ──────────────────────────────────────────

async function handleBulk(ctx: Ctx, now: Date): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const tz = tzOf(settings);

  const repeated = await proposalBySource(slug, ctx.whatsappMessageId, "bulk_complete");
  if (repeated) {
    const preview = typeof repeated.payload.preview === "string" ? repeated.payload.preview : null;
    return ctx.say(repeated.status === "pending" && preview ? preview : STORED_STATUS_REPLY(repeated, null), "bulk_repeated", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);
  }

  const open = await loadOutstandingOrders(slug);
  const day = dayContext(now, tz);
  const scope = bulkScope(open, day);
  if (scope.today.length === 0) {
    await audit(slug, "staff", senderAuth.senderId, "orders.bulk_complete_empty", { type: "chat", id: ctx.fromGroup }, { date: day.today });
    return ctx.say(BULK_REPLY.none(day.today, scope.excluded), "bulk_none");
  }
  const names = await loadOrderNames(slug, scope.today);
  await supersedePending(slug, "bulk_complete", null);
  const payload: BulkPayload = { date: day.today, orders: scope.today.map((o) => ({ id: o.id, ref: o.ref_code, version: o.version })) };
  const created = await createProposal({
    slug,
    kind: "bulk_complete",
    groupJid: ctx.fromGroup,
    createdBy: senderAuth.senderId,
    messageId: ctx.whatsappMessageId,
    orderId: null,
    orderVersion: null,
    instruction: null,
    payload: (code) => ({ ...payload, preview: BULK_REPLY.preview({ code, dateKey: day.today, scope, names }) }),
    ttlMs: BULK_TTL_MS,
    now,
  });
  if (!created.existing) await audit(slug, "staff", senderAuth.senderId, "orders.bulk_complete_proposed", { type: "order_proposal", id: created.row.id }, { code: created.row.code, date: day.today, orders: scope.today.length });
  return ctx.say(String(created.row.payload.preview), created.existing ? "bulk_repeated" : "bulk_proposed", `ordercorr:${slug}:${ctx.whatsappMessageId}:preview`);
}

// ── !confirm / !discard ──────────────────────────────────────────────────────

async function handleReview(ctx: Ctx, command: Extract<CorrectionCommand, { kind: "proposal" }>): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const now = ctx.now ?? new Date();
  const row = await proposalByCode(slug, command.code);
  if (!row) return ctx.reject("unknown_code", CORRECTION_REPLY.unknown(command.code));
  if (row.group_jid !== ctx.fromGroup) return ctx.reject("wrong_group", CORRECTION_REPLY.wrongGroup(command.code));
  const ack = `ordercorr:${slug}:${ctx.whatsappMessageId}:ack`;
  const speak = (body: string, outcome: string) => ctx.say(body, outcome, ack);

  if (command.action === "discard") {
    if (row.status === "pending") {
      if (await move(row, ["pending"], "discarded", { resolved_at: now.toISOString(), resolved_by: senderAuth.senderId })) {
        await audit(slug, "staff", senderAuth.senderId, `orders.${row.kind === "correction" ? "teach" : "bulk_complete"}_discarded`, { type: "order_proposal", id: row.id }, { code: row.code });
      }
      return speak(row.kind === "correction" ? CORRECTION_REPLY.discarded(row.code) : BULK_REPLY.discarded(row.code), "proposal_discarded");
    }
    return speak(row.status === "discarded" ? CORRECTION_REPLY.alreadyDiscarded(row.code) : `ℹ️ ${row.code} is already ${row.status === "applied" || row.status === "partial" ? "applied — use !order #REF reopen to undo" : row.status}. Nothing to discard.`, "proposal_discard_noop");
  }

  // Confirm: a pending proposal that has run out of time can never be applied, even if nobody has marked it expired yet.
  if (row.status === "pending" && Date.parse(row.expires_at) <= now.getTime()) {
    await move(row, ["pending"], "expired", { resolved_at: now.toISOString() });
    return speak(row.kind === "correction" ? CORRECTION_REPLY.expired(row.code) : BULK_STATE_REPLY.expired(row.code), "proposal_expired");
  }
  return row.kind === "correction" ? applyCorrection(ctx, row, speak) : applyBulk(ctx, row, speak);
}

type Speak = (body: string, outcome: string) => UpdateCommandResult;

async function loadOrder(slug: string, id: string): Promise<TrackedOrder | null> {
  const { data, error } = await agentDb().from("ai_agent_orders").select(ORDER_COLUMNS).eq("business_slug", slug).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TrackedOrder | null) ?? null;
}

async function applyCorrection(ctx: Ctx, row: ProposalRow, speak: Speak): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const now = ctx.now ?? new Date();
  if (!(await move(row, ["pending"], "applying", { claimed_at: now.toISOString() }))) {
    const current = (await proposalByCode(slug, row.code)) ?? row;
    const order = current.order_id ? await loadOrder(slug, current.order_id) : null;
    return speak(STORED_STATUS_REPLY(current, order), `proposal_${current.status}`);
  }
  const revert = () => move(row, ["applying"], "pending", { claimed_at: null }).catch(() => false);
  try {
    const order = row.order_id ? await loadOrder(slug, row.order_id) : null;
    if (!order) {
      await move(row, ["applying"], "stale", { resolved_at: now.toISOString() });
      return speak(CORRECTION_REPLY.unknown(row.code), "proposal_stale");
    }
    if (order.version !== row.order_version || !isOpenStatus(order.status)) {
      await move(row, ["applying"], "stale", { resolved_at: now.toISOString() });
      await audit(slug, "staff", senderAuth.senderId, "orders.teach_stale", { type: "order", id: order.id }, { code: row.code, proposed_version: row.order_version, current_version: order.version, status: order.status });
      return speak(CORRECTION_REPLY.stale(row.code, order), "proposal_stale");
    }
    const changes = row.payload.changes as PlannedChange[];
    const result = await updateOrderManually({
      businessSlug: slug,
      orderId: order.id,
      adminId: senderAuth.senderId ?? "unknown",
      actor: "staff",
      idempotencyKey: `teach:${row.id}`,
      expectedVersion: row.order_version,
      action: "edit",
      patch: row.payload.patch as never,
      extraChanges: { correction: { before: null, after: { code: row.code, instruction: clip(row.instruction ?? "", 300) } } },
    });
    if (!result.ok) {
      if (result.code === "conflict" || result.code === "stale" || result.code === "closed") {
        await move(row, ["applying"], "stale", { resolved_at: now.toISOString() });
        return speak(CORRECTION_REPLY.stale(row.code, order), "proposal_stale");
      }
      await revert();
      return speak(CORRECTION_REPLY.failed(), "proposal_failed");
    }
    // Structured feedback about what extraction got wrong, one row per approved correction. Not knowledge: nothing reads it as a fact.
    const { error: feedbackError } = await agentDb().from("ai_agent_order_feedback").insert({
      business_slug: slug,
      order_id: order.id,
      proposal_id: row.id,
      instruction: clip(row.instruction ?? "", 600),
      fields: changes.map((c) => c.field),
      before: Object.fromEntries(changes.map((c) => [c.field, c.beforeValue ?? null])),
      after: Object.fromEntries(changes.map((c) => [c.field, c.afterValue ?? null])),
      created_by: senderAuth.senderId,
    });
    if (feedbackError && feedbackError.code !== "23505") console.error("[aiAgent] order feedback", feedbackError.message);
    await move(row, ["applying"], "applied", { resolved_at: now.toISOString(), resolved_by: senderAuth.senderId });
    if (!result.duplicate) await audit(slug, "staff", senderAuth.senderId, "orders.teach_applied", { type: "order", id: order.id }, { code: row.code, fields: changes.map((c) => c.field) });
    const names = await loadOrderNames(slug, [result.order]);
    return speak(CORRECTION_REPLY.applied(result.order, names, changes, (row.payload.reusable as ReusableSuggestion[]) ?? []), result.duplicate ? "teach_repeated" : "teach_applied");
  } catch (err) {
    await revert();
    throw err;
  }
}

async function applyBulk(ctx: Ctx, row: ProposalRow, speak: Speak): Promise<UpdateCommandResult> {
  const { settings, senderAuth } = ctx;
  const slug = settings.business_slug;
  const now = ctx.now ?? new Date();
  // pending → applying; a partly failed run may be retried (only its failed orders); a run that died mid-way after CLAIM_RETRY_MS.
  const stamp = { claimed_at: now.toISOString() };
  const claimed =
    (await move(row, ["pending"], "applying", stamp)) ||
    (await move(row, ["partial"], "applying", stamp)) ||
    (await (async () => {
      const { data } = await agentDb()
        .from("ai_agent_order_proposals")
        .update({ claimed_at: now.toISOString() })
        .eq("business_slug", slug)
        .eq("id", row.id)
        .eq("status", "applying")
        .lt("claimed_at", new Date(now.getTime() - CLAIM_RETRY_MS).toISOString())
        .select("id");
      return (data ?? []).length > 0;
    })());
  if (!claimed) {
    const current = (await proposalByCode(slug, row.code)) ?? row;
    return speak(
      current.status === "applied" ? BULK_STATE_REPLY.alreadyApplied(row.code) : current.status === "superseded" ? BULK_STATE_REPLY.superseded(row.code) : current.status === "expired" ? BULK_STATE_REPLY.expired(row.code) : current.status === "discarded" ? CORRECTION_REPLY.alreadyDiscarded(row.code) : CORRECTION_REPLY.busy(row.code),
      `proposal_${current.status}`
    );
  }

  const payload = row.payload as unknown as BulkPayload;
  const tz = tzOf(settings);
  const before = ((row.result?.lines as BulkLine[] | undefined) ?? []).filter((l) => l.outcome === "completed" || l.outcome === "already_completed" || l.outcome === "skipped");
  const lines: BulkLine[] = [...before];
  const settled = new Set(before.map((l) => l.ref));
  for (const target of payload.orders) {
    if (settled.has(target.ref)) continue;
    const line = async (): Promise<BulkLine> => {
      try {
        const order = await loadOrder(slug, target.id);
        if (!order) return { ref: target.ref, outcome: "skipped", reason: "no longer exists" };
        if (order.status === "fulfilled") return { ref: target.ref, outcome: "already_completed" };
        if (!isOpenStatus(order.status)) return { ref: target.ref, outcome: "skipped", reason: `now ${order.status}` };
        if (order.version !== target.version) return { ref: target.ref, outcome: "skipped", reason: "changed after the preview" };
        if (orderDay(order, tz) !== payload.date) return { ref: target.ref, outcome: "skipped", reason: "its day changed" };
        const done = await updateOrderManually({
          businessSlug: slug,
          orderId: order.id,
          adminId: senderAuth.senderId ?? "unknown",
          actor: "staff",
          idempotencyKey: `bulk:${row.id}:${order.id}`,
          expectedVersion: target.version,
          action: "fulfil",
          extraChanges: { completion_batch: { before: null, after: { code: row.code } } },
        });
        if (done.ok) return { ref: target.ref, outcome: done.duplicate ? "already_completed" : "completed" };
        return done.code === "conflict" || done.code === "stale" || done.code === "closed" ? { ref: target.ref, outcome: "skipped", reason: "changed while completing" } : { ref: target.ref, outcome: "failed", reason: clip(done.error, 80) };
      } catch (err) {
        return { ref: target.ref, outcome: "failed", reason: clip(err instanceof Error ? err.message : "error", 80) };
      }
    };
    lines.push(await line());
  }

  const failed = lines.some((l) => l.outcome === "failed");
  await move(row, ["applying"], failed ? "partial" : "applied", {
    result: { lines },
    resolved_at: failed ? null : now.toISOString(),
    resolved_by: senderAuth.senderId,
    // A partly failed run stays confirmable for a little longer, so the failed orders can be retried.
    ...(failed ? { expires_at: new Date(now.getTime() + BULK_TTL_MS).toISOString() } : {}),
  });
  const count = (o: BulkLine["outcome"]) => lines.filter((l) => l.outcome === o).length;
  await audit(slug, "staff", senderAuth.senderId, "orders.bulk_complete_applied", { type: "order_proposal", id: row.id }, { code: row.code, date: payload.date, completed: count("completed"), already: count("already_completed"), skipped: count("skipped"), failed: count("failed") });
  return speak(bulkResultText(row.code, lines, payload.date), failed ? "bulk_partial" : "bulk_applied");
}
