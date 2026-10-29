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
  type PlannedChange,
  type ProposalKind,
  type ReusableSuggestion,
} from "@/lib/aiAgent/orderTeach";
import { dayContext } from "@/lib/aiAgent/orderViews";
import { ORDER_REPLY } from "@/lib/aiAgent/orderCommands";
import { NUMBER_REPLY } from "@/lib/aiAgent/orderNumbers";
import { isOpenStatus, type TrackedOrder } from "@/lib/aiAgent/orders";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { createProposal, move, type ProposalRow, proposalByCode, proposalBySource, supersedePending } from "@/lib/server/aiAgent/orderProposals";
import { resolveNumberedTarget } from "@/lib/server/aiAgent/orderNumberTarget";
import { applyPreference, isSchemaPending, startTeaching } from "@/lib/server/aiAgent/teachSessions";
import {
  type CommandContext,
  groupReply,
  guardOrderCommand,
  handleOrderCommand,
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
    let target: Awaited<ReturnType<typeof resolveNumberedTarget>>;
    try {
      target = await resolveNumberedTarget(args, command.selector.n, command.kind !== "info", args.now ?? new Date());
    } catch (err) {
      // The stored reports could not be read (typically: migration 20261110000000 was never run). Say so, and change nothing:
      // a number is never guessed against a fresh list.
      const detail = err instanceof Error ? err.message : "unknown error";
      console.error("[aiAgent] order number lookup failed", detail);
      await audit(args.settings.business_slug, "staff", args.senderAuth.senderId, "orders.command_rejected", { type: "chat", id: args.fromGroup }, { reason: "number_lookup_failed", error: clip(detail, 200), number: command.selector.n });
      return groupReply(args.settings, args.fromGroup, args.eventId, isSchemaPending(err) ? NUMBER_REPLY.setupPending : NUMBER_REPLY.lookupFailed, "staff_notice", "orders:cmd_number_lookup_failed");
    }
    if (!target.ok) return target.result;
    command = { ...command, selector: { type: "ref", ref: target.ref } } as OrderCommand;
    if (command.kind !== "info") requiredVersion = target.version;
  }
  const next = { ...args, requiredVersion };
  return isCorrectionCommand(command) ? handleCorrectionCommand({ ...next, command }) : handleOrderCommand({ ...next, command });
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

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
    return command.kind === "teach" ? await startTeaching(ctx, command, writtenAt ?? now) : await handleBulk(ctx, now);
  } catch (err) {
    console.error("[aiAgent] order correction", err instanceof Error ? err.message : err);
    return reject("failed", ORDER_REPLY.failed());
  }
}

type Ctx = CorrectionCommandArgs & { say: (body: string, outcome: string, key?: string) => UpdateCommandResult; reject: (reason: string, body: string, key?: string) => Promise<UpdateCommandResult> };

// ── !order #REF teach ────────────────────────────────────────────────────────
// The conversation itself lives in teachSessions.ts.

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
        await audit(slug, "staff", senderAuth.senderId, `orders.${row.kind === "correction" ? "teach" : row.kind === "customer_preference" ? "preference" : "bulk_complete"}_discarded`, { type: "order_proposal", id: row.id }, { code: row.code });
      }
      return speak(row.kind === "correction" ? CORRECTION_REPLY.discarded(row.code) : row.kind === "customer_preference" ? `🗑 ${row.code} discarded. Nothing was saved about the customer.` : BULK_REPLY.discarded(row.code), "proposal_discarded");
    }
    return speak(row.status === "discarded" ? CORRECTION_REPLY.alreadyDiscarded(row.code) : `ℹ️ ${row.code} is already ${row.status === "applied" || row.status === "partial" ? "applied — use !order #REF reopen to undo" : row.status}. Nothing to discard.`, "proposal_discard_noop");
  }

  // Confirm: a pending proposal that has run out of time can never be applied, even if nobody has marked it expired yet.
  if (row.status === "pending" && Date.parse(row.expires_at) <= now.getTime()) {
    await move(row, ["pending"], "expired", { resolved_at: now.toISOString() });
    return speak(row.kind === "bulk_complete" ? BULK_STATE_REPLY.expired(row.code) : CORRECTION_REPLY.expired(row.code), "proposal_expired");
  }
  if (row.kind === "customer_preference") return applyPreference(ctx, row, speak, (r) => STORED_STATUS_REPLY(r, null));
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
