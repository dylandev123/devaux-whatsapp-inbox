import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { StaffCommand } from "@/lib/aiAgent/engine";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, loadSettings, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { outboxState } from "@/lib/aiAgent/outboxStatus";
import { sendAdminAnswer } from "@/lib/server/aiAgent/adminSend";
import { applyStaffAction, ESCALATION_COLUMNS, EscalationRow } from "@/lib/server/aiAgent/escalations";
import { enqueue } from "@/lib/server/aiAgent/outbox";
import { STAFF_ANSWER_COLUMNS } from "@/lib/server/aiAgent/staffKnowledge";

// Admin-only. Escalation history + answering from the admin UI. A customer send
// goes through sendAdminAnswer() → planCustomerSend(), the same policy as an
// authorized "!send" in the staff WhatsApp group; other actions go through
// applyStaffAction(). Anything to send is queued for the bridge to claim.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  let query = agentDb()
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("created_at", { ascending: false })
    .limit(100);
  if (params.get("status") === "open") query = query.in("status", ["open", "notified"]);
  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  // Delivery status of each escalation's staff notice / relay, derived the
  // same way as the Activity outbox (blocked vs failed vs unresolved).
  const rows = (data ?? []) as unknown as EscalationRow[];
  const ids = rows.map((r) => r.id);
  const deliveries = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const { data: outbox, error: outboxError } = await agentDb()
      .from("ai_agent_outbox")
      .select("id, escalation_id, kind, status, error, dispatched_at, created_at, sent_at")
      .eq("business_slug", businessSlug)
      .in("kind", ["staff_notice", "staff_relay"])
      .in("escalation_id", ids)
      .order("created_at", { ascending: false });
    if (outboxError) return jsonError(outboxError.message, 500);
    const now = new Date();
    for (const o of outbox ?? []) {
      const list = deliveries.get(o.escalation_id) ?? [];
      list.push({ id: o.id, kind: o.kind, state: outboxState(o, now), error: o.error, created_at: o.created_at, sent_at: o.sent_at });
      deliveries.set(o.escalation_id, list);
    }
  }

  // What staff said and what became of it: the draft, whether it was sent or
  // withheld (and why), and where each piece of information went.
  const answers = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const { data: answerRows, error: answerError } = await agentDb()
      .from("ai_agent_staff_answers")
      .select(STAFF_ANSWER_COLUMNS)
      .eq("business_slug", businessSlug)
      .in("escalation_id", ids)
      .order("created_at", { ascending: false })
      .limit(300);
    if (answerError) return jsonError(answerError.message, 500);
    for (const a of (answerRows ?? []) as { escalation_id: string }[]) {
      const list = answers.get(a.escalation_id) ?? [];
      if (list.length < 5) list.push(a);
      answers.set(a.escalation_id, list);
    }
  }
  return NextResponse.json({
    escalations: rows.map((r) => ({ ...r, deliveries: deliveries.get(r.id) ?? [], answers: answers.get(r.id) ?? [] })),
  });
}

const COMMANDS: StaffCommand[] = ["send", "note", "close", "takeover", "resume"];

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; id?: unknown; action?: unknown; body?: unknown; basedOn?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.id !== "string") return jsonError("businessSlug and id are required", 400);
  if (!COMMANDS.includes(body.action as StaffCommand)) return jsonError(`action must be one of ${COMMANDS.join(", ")}`, 400);
  const command = body.action as StaffCommand;
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 4000) : "";
  if ((command === "send" || command === "note") && !text) return jsonError("body is required", 400);
  const basedOn = typeof body.basedOn === "string" && !Number.isNaN(Date.parse(body.basedOn)) ? body.basedOn : null;
  if (command === "send" && !basedOn) return jsonError("basedOn (when you last viewed this escalation) is required to send", 400);

  try {
    const [settings, { data: escalation, error }] = await Promise.all([
      loadSettings(businessSlug),
      agentDb().from("ai_agent_escalations").select(ESCALATION_COLUMNS).eq("id", body.id).eq("business_slug", businessSlug).maybeSingle(),
    ]);
    if (error) throw new Error(error.message);
    if (!escalation) return jsonError("Escalation not found", 404);
    const row = escalation as EscalationRow;

    // Messaging a customer is decided by ONE policy shared with the WhatsApp staff group
    // (lib/server/aiAgent/customerSend.ts): mode, contact scope, takeover, recent human
    // activity, stale text, safety, duplicates and unknown-send holds all apply here too.
    if (command === "send") {
      const sent = await sendAdminAnswer({ settings, escalation: row, text, adminId: admin.userId, basedOn: basedOn! });
      if (!sent.ok) return jsonError(sent.message, sent.status);
      return NextResponse.json({ ok: true, message: sent.message, queued: sent.queued, sent: sent.sent });
    }

    const result = await applyStaffAction({
      escalation: row,
      command,
      body: text,
      settings,
      actorKind: "admin",
      actorId: admin.userId,
      via: "admin_ui",
      dedupeBase: `ui:${body.id}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    });
    await enqueue(result.outbox, false);
    return NextResponse.json({ ok: true, message: result.feedback, queued: result.outbox.length });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to update escalation", 500);
  }
}
