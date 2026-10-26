// Server-only: the OPT-IN recovery of orders from the last 24-72 hours of stored messages that the old rules never
// analysed (customers not on the AI allow-list, Manual Only, excluded, staff takeover…). Nothing here runs by itself:
// an admin starts a run from the dashboard and keeps stepping it until it finishes.
//
//   bounded      at most BACKFILL_CHAT_CAP conversations per run, a few small model calls per conversation, a hard
//                time budget per step; what was left out is reported on the run, never dropped silently
//   idempotent   every write is keyed `backfill:<run>:<chat>:<chunk>`; repeating a step (a double click, a retried
//                request) changes nothing, and merging an order that already exists is a no-op
//   audited      the run row records who started it, the window, progress and failures; each model call is in the
//                audit log; every order change is in that order's own history
//   safe         it reads stored messages only. It never sends anything, never records a customer's "yes" (a yes in
//                the past answers nothing staff just wrote), and staff-written lines only give context
//
// The plan covers only conversations with at least one customer message the live path never read (messageWasAnalysed),
// and skips conversations an earlier finished run already covered.

import type { AgentSettings } from "@/lib/aiAgent/engine";
import {
  BACKFILL_CHAT_CAP,
  BACKFILL_CHUNK_SIZE,
  BACKFILL_MAX_CHUNKS_PER_CHAT,
  chunkBy,
  historyLine,
  messageWasAnalysed,
  monitorEligibleChat,
  monitorPrefilter,
  validBackfillHours,
} from "@/lib/aiAgent/orderMonitor";
import { isOutbound } from "@/lib/whatsapp";
import { loadCustomerDisplayName } from "@/lib/server/aiAgent/context";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import { proposeOrderUpdate } from "@/lib/server/aiAgent/model";
import { alreadyApplied } from "@/lib/server/aiAgent/orderMonitor";
import { loadOpenOrders, ordersForModel, trackOrders } from "@/lib/server/aiAgent/orders";

export interface BackfillRun {
  id: string;
  business_slug: string;
  status: "running" | "done" | "failed" | "cancelled";
  hours: number;
  window_start: string;
  window_end: string;
  chat_ids: string[];
  done_chat_ids: string[];
  chats_total: number;
  chats_done: number;
  messages_analysed: number;
  orders_touched: number;
  failures: number;
  note: string | null;
  started_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const RUN_COLUMNS =
  "id, business_slug, status, hours, window_start, window_end, chat_ids, done_chat_ids, chats_total, chats_done, messages_analysed, orders_touched, failures, note, started_by, created_at, updated_at, finished_at";
const STEP_BUDGET_MS = 45_000;
const MESSAGE_READ_LIMIT = 8000;

export type BackfillResult = { ok: true; run: BackfillRun } | { ok: false; status: number; error: string };

/** The run as the dashboard shows it: no conversation ids (they identify customers); counts only. */
export function publicRun(run: BackfillRun) {
  const { chat_ids: _planned, done_chat_ids: _done, business_slug: _slug, ...rest } = run;
  return rest;
}

export async function listBackfillRuns(businessSlug: string, limit = 5): Promise<BackfillRun[]> {
  const { data, error } = await agentDb().from("ai_agent_order_backfill_runs").select(RUN_COLUMNS).eq("business_slug", businessSlug).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as BackfillRun[];
}

async function loadRun(businessSlug: string, runId: string): Promise<BackfillRun | null> {
  const { data, error } = await agentDb().from("ai_agent_order_backfill_runs").select(RUN_COLUMNS).eq("id", runId).eq("business_slug", businessSlug).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as BackfillRun | null) ?? null;
}

/** The conversations with a customer message nobody read for orders, newest activity first. */
async function planChats(businessSlug: string, windowStart: string, windowEnd: string): Promise<{ chats: string[]; total: number }> {
  const db = agentDb();
  const [messages, events, earlier] = await Promise.all([
    db.from("whatsapp_messages").select("whatsapp_message_id, chat_id, direction, message_body, timestamp").eq("business_slug", businessSlug).gte("timestamp", windowStart).lte("timestamp", windowEnd).limit(MESSAGE_READ_LIMIT),
    db.from("ai_agent_events").select("whatsapp_message_id, status, reason_codes").eq("business_slug", businessSlug).gte("created_at", new Date(Date.parse(windowStart) - 3_600_000).toISOString()).limit(MESSAGE_READ_LIMIT),
    db.from("ai_agent_order_backfill_runs").select("done_chat_ids, window_end").eq("business_slug", businessSlug).eq("status", "done").gte("created_at", new Date(Date.parse(windowEnd) - 8 * 24 * 3_600_000).toISOString()),
  ]);
  if (messages.error) throw new Error(messages.error.message);
  if (events.error) throw new Error(events.error.message);
  if (earlier.error) throw new Error(earlier.error.message);

  const byMessage = new Map((events.data ?? []).map((e) => [e.whatsapp_message_id as string, { status: e.status as string, reason_codes: (e.reason_codes as string[] | null) ?? [] }]));
  const latestMissed = new Map<string, number>();
  for (const m of messages.data ?? []) {
    const chatId = m.chat_id as string;
    if (isOutbound(m.direction as string) || !monitorEligibleChat(chatId) || !(m.message_body as string | null)?.trim()) continue;
    if (messageWasAnalysed(byMessage.get(m.whatsapp_message_id as string))) continue;
    latestMissed.set(chatId, Math.max(latestMissed.get(chatId) ?? 0, Date.parse(m.timestamp as string) || 0));
  }
  // A conversation an earlier finished run covered is skipped unless the customer wrote again after that run.
  for (const run of earlier.data ?? []) {
    const covered = Date.parse(run.window_end as string);
    for (const chat of (run.done_chat_ids as string[]) ?? []) {
      if ((latestMissed.get(chat) ?? 0) <= covered) latestMissed.delete(chat);
    }
  }
  const ordered = [...latestMissed.entries()].sort((a, b) => b[1] - a[1]).map(([chat]) => chat);
  return { chats: ordered.slice(0, BACKFILL_CHAT_CAP), total: ordered.length };
}

/** Starts a run, or returns the one already running for this business (one at a time). */
export async function startBackfill(args: { settings: AgentSettings; adminId: string; hours: unknown; now?: Date }): Promise<BackfillResult> {
  const { settings } = args;
  if (!validBackfillHours(args.hours)) return { ok: false, status: 400, error: "Choose a window of 1 to 72 hours." };
  if (!settings.enabled || settings.orders_tracking_enabled !== true) return { ok: false, status: 409, error: "Switch the AI agent and order tracking on for this business first." };
  const running = (await listBackfillRuns(settings.business_slug, 1))[0];
  if (running?.status === "running") return { ok: true, run: running };

  const end = args.now ?? new Date();
  const start = new Date(end.getTime() - args.hours * 3_600_000);
  const plan = await planChats(settings.business_slug, start.toISOString(), end.toISOString());
  const { data, error } = await agentDb()
    .from("ai_agent_order_backfill_runs")
    .insert({
      business_slug: settings.business_slug,
      status: plan.chats.length === 0 ? "done" : "running",
      hours: args.hours,
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      chat_ids: plan.chats,
      chats_total: plan.chats.length,
      note: plan.total > plan.chats.length ? `${plan.total - plan.chats.length} older conversations were left out (limit ${BACKFILL_CHAT_CAP} per run). Run it again to cover them.` : plan.chats.length === 0 ? "Nothing was missed in this window." : null,
      started_by: args.adminId,
      ...(plan.chats.length === 0 ? { finished_at: end.toISOString() } : {}),
    })
    .select(RUN_COLUMNS)
    .single();
  if (error) {
    // 23505: another admin started one a moment ago: resume that one.
    if (error.code === "23505") {
      const again = (await listBackfillRuns(settings.business_slug, 1))[0];
      if (again) return { ok: true, run: again };
    }
    throw new Error(error.message);
  }
  await audit(settings.business_slug, "admin", args.adminId, "orders.backfill_started", { type: "backfill", id: (data as { id: string }).id }, { hours: args.hours, chats: plan.chats.length, left_out: plan.total - plan.chats.length });
  return { ok: true, run: data as unknown as BackfillRun };
}

async function backfillChat(settings: AgentSettings, run: BackfillRun, chatId: string): Promise<{ analysed: number; touched: number; failures: number }> {
  const slug = settings.business_slug;
  const { data, error } = await agentDb()
    .from("whatsapp_messages")
    .select("whatsapp_message_id, contact_number, direction, message_body, timestamp")
    .eq("business_slug", slug)
    .eq("chat_id", chatId)
    .gte("timestamp", run.window_start)
    .lte("timestamp", run.window_end)
    .order("timestamp", { ascending: true })
    .limit(BACKFILL_CHUNK_SIZE * BACKFILL_MAX_CHUNKS_PER_CHAT);
  if (error) throw new Error(error.message);
  const messages = (data ?? []).filter((m) => (m.message_body as string | null)?.trim());
  const out = { analysed: 0, touched: 0, failures: 0 };
  if (messages.length === 0) return out;

  const contactNumber = [...messages].reverse().map((m) => m.contact_number as string | null).find(Boolean) ?? null;
  const identity = await loadIdentity(slug, chatId, contactNumber);
  const customerName = await loadCustomerDisplayName(identity, contactNumber, chatId);
  const seenCustomerWords: string[] = [];

  for (const [index, chunk] of chunkBy(messages, BACKFILL_CHUNK_SIZE).entries()) {
    const rows = chunk.map((m) => ({ id: m.whatsapp_message_id as string, outbound: isOutbound(m.direction as string), text: (m.message_body as string).trim(), at: m.timestamp as string }));
    const customer = rows.filter((r) => !r.outbound);
    seenCustomerWords.push(...customer.map((r) => r.text));
    if (customer.length === 0) continue;
    const key = `backfill:${run.id}:${chatId}:${index}`;
    if (await alreadyApplied(key)) continue;
    const open = await loadOpenOrders(slug, chatId);
    const plan = monitorPrefilter({ author: "customer", segments: customer.map((r) => r.text), hasMedia: false, openOrders: open.length });
    // A bare "yes" in the past answers nothing staff wrote just now, so it is never recorded.
    if (plan.action === "skip" || plan.reason === "orders_monitor_confirmation") continue;

    let proposal: Parameters<typeof trackOrders>[0]["proposal"] = null;
    let intent: string | null = null;
    if (plan.action === "analyse") {
      await audit(slug, "system", null, "orders.backfill_call", { type: "backfill", id: run.id }, {});
      const res = await proposeOrderUpdate({
        businessSlug: slug,
        customerName,
        openOrders: ordersForModel(open),
        transcript: [],
        newMessages: rows.map(historyLine).join("\n"),
        author: "history",
      });
      if (!res.proposal) {
        out.failures += 1;
        continue;
      }
      proposal = { order_request: res.proposal.order_request, order_target: res.proposal.order_target ?? null, other_orders: res.proposal.other_orders };
      intent = res.proposal.intent;
    }
    out.analysed += customer.length;
    const tracked = await trackOrders({
      settings,
      businessSlug: slug,
      chatId,
      phone: identity.phone,
      customerName,
      intent,
      proposal,
      segments: customer.map((r) => r.text),
      customerWords: seenCustomerWords.slice(-60),
      messageIds: customer.map((r) => r.id),
      segmentTimes: customer.map((r) => r.at),
      firstAt: customer[0].at,
      lastAt: customer[customer.length - 1].at,
      dedupeBase: key,
      allowConfirmation: false,
      // Replaying a past window: today's records must not answer "same as last time" for a message from before them.
      useHistory: false,
      now: new Date(run.window_end),
    });
    out.touched += tracked.applied;
  }
  return out;
}

/** Works through the planned conversations until the time budget is used; each finished conversation is saved at once. */
export async function stepBackfill(args: { settings: AgentSettings; runId: string; budgetMs?: number }): Promise<BackfillResult> {
  const { settings } = args;
  let run = await loadRun(settings.business_slug, args.runId);
  if (!run) return { ok: false, status: 404, error: "Backfill not found" };
  if (run.status !== "running") return { ok: true, run };
  if (!settings.enabled || settings.orders_tracking_enabled !== true) return { ok: false, status: 409, error: "Order tracking is switched off for this business." };

  const deadline = Date.now() + (args.budgetMs ?? STEP_BUDGET_MS);
  const done = new Set(run.done_chat_ids);
  for (const chatId of run.chat_ids) {
    if (done.has(chatId)) continue;
    if (Date.now() >= deadline) break;
    let result = { analysed: 0, touched: 0, failures: 0 };
    try {
      result = await backfillChat(settings, run, chatId);
    } catch (err) {
      console.error("[aiAgent] backfill chat", err instanceof Error ? err.message : err);
      result.failures += 1;
    }
    done.add(chatId);
    run = {
      ...run,
      done_chat_ids: [...done],
      chats_done: done.size,
      messages_analysed: run.messages_analysed + result.analysed,
      orders_touched: run.orders_touched + result.touched,
      failures: run.failures + result.failures,
    };
    const { error } = await agentDb()
      .from("ai_agent_order_backfill_runs")
      .update({ done_chat_ids: run.done_chat_ids, chats_done: run.chats_done, messages_analysed: run.messages_analysed, orders_touched: run.orders_touched, failures: run.failures })
      .eq("id", run.id)
      .eq("status", "running");
    if (error) throw new Error(error.message);
  }
  if (done.size >= run.chat_ids.length) {
    const finishedAt = new Date().toISOString();
    const { error } = await agentDb().from("ai_agent_order_backfill_runs").update({ status: "done", finished_at: finishedAt }).eq("id", run.id).eq("status", "running");
    if (error) throw new Error(error.message);
    run = { ...run, status: "done", finished_at: finishedAt };
    await audit(settings.business_slug, "system", null, "orders.backfill_finished", { type: "backfill", id: run.id }, { chats: run.chats_done, messages: run.messages_analysed, orders_touched: run.orders_touched, failures: run.failures });
  }
  return { ok: true, run };
}

export async function cancelBackfill(args: { settings: AgentSettings; runId: string; adminId: string }): Promise<BackfillResult> {
  const run = await loadRun(args.settings.business_slug, args.runId);
  if (!run) return { ok: false, status: 404, error: "Backfill not found" };
  if (run.status !== "running") return { ok: true, run };
  const finishedAt = new Date().toISOString();
  const { error } = await agentDb().from("ai_agent_order_backfill_runs").update({ status: "cancelled", finished_at: finishedAt }).eq("id", run.id).eq("status", "running");
  if (error) throw new Error(error.message);
  await audit(args.settings.business_slug, "admin", args.adminId, "orders.backfill_cancelled", { type: "backfill", id: run.id }, { chats_done: run.chats_done, of: run.chats_total });
  return { ok: true, run: { ...run, status: "cancelled", finished_at: finishedAt } };
}
