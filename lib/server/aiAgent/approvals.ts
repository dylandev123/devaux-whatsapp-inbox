// Server-only: the dashboard's pending-approvals queue. It is a second VIEW of the same Approval Pilot, not a second
// send mechanism: Approve calls approveDraftCore() (pilot.ts), the very function the WhatsApp !approve uses, so the
// central customer-send policy, draft freshness, the atomic id+hash compare-and-set, duplicate prevention and the
// unknown-send holds all apply unchanged. Every function here takes one escalation at a time (no bulk actions) and
// reads and writes only rows of the given business.

import type { AgentSettings } from "@/lib/aiAgent/engine";
import { customerMessageSegments } from "@/lib/aiAgent/engine";
import { checkExactSendSafety, WITHHOLD_TEXT } from "@/lib/aiAgent/staffAnswers";
import { parseRejectArgs, type PilotRefusal } from "@/lib/aiAgent/pilot";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { customerWroteAfter } from "@/lib/server/aiAgent/customerSend";
import { ESCALATION_COLUMNS, type EscalationRow } from "@/lib/server/aiAgent/escalations";
import {
  approveDraftCore,
  bodyHash,
  createDraftVersion,
  currentDraft,
  draftById,
  loadMoreInfo,
  PILOT_DRAFT_COLUMNS,
  type PilotDraftRow,
  rejectDraft,
} from "@/lib/server/aiAgent/pilot";

export interface ApprovalQueueItem {
  escalationId: string;
  refCode: string;
  customerName: string | null;
  contactNumber: string | null;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** The customer's latest message on this request. */
  latestMessage: string;
  messageCount: number;
  draft: {
    id: string;
    version: number;
    body: string;
    ready: boolean;
    notes: string[];
    source: PilotDraftRow["source"];
    createdAt: string;
  } | null;
  /** The customer wrote after the draft was made: it can no longer be approved. */
  stale: boolean;
}

const QUEUE_LIMIT = 25;

/** Open requests of ONE business with their current draft. Empty outside Approval Pilot (no drafts exist there). */
export async function listPendingApprovals(settings: AgentSettings): Promise<ApprovalQueueItem[]> {
  if (settings.mode !== "approval_pilot") return [];
  const db = agentDb();
  const { data, error } = await db
    .from("ai_agent_escalations")
    .select(ESCALATION_COLUMNS)
    .eq("business_slug", settings.business_slug)
    .in("status", ["open", "notified"])
    .order("created_at", { ascending: false })
    .limit(QUEUE_LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as EscalationRow[];
  if (rows.length === 0) return [];
  const drafts = await db
    .from("ai_agent_pilot_drafts")
    .select(PILOT_DRAFT_COLUMNS)
    .eq("business_slug", settings.business_slug)
    .eq("status", "current")
    .in("escalation_id", rows.map((r) => r.id));
  if (drafts.error) throw new Error(drafts.error.message);
  const byEsc = new Map(((drafts.data ?? []) as unknown as PilotDraftRow[]).map((d) => [d.escalation_id, d]));
  return Promise.all(
    rows.map(async (e): Promise<ApprovalQueueItem> => {
      const d = byEsc.get(e.id) ?? null;
      const messages = customerMessageSegments(e.customer_message ?? "");
      return {
        escalationId: e.id,
        refCode: e.ref_code,
        customerName: e.customer_name,
        contactNumber: e.contact_number,
        priority: e.priority,
        status: e.status,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        latestMessage: messages[messages.length - 1] ?? "",
        messageCount: messages.length,
        draft: d && !d.content_purged_at ? { id: d.id, version: d.version, body: d.body, ready: d.ready, notes: d.confirm_notes, source: d.source, createdAt: d.created_at } : null,
        stale: d ? await customerWroteAfter(e, d.basis_at) : false,
      };
    })
  );
}

export type ApprovalActionResult =
  | { ok: true; message: string; draftId?: string; text?: string }
  | { ok: false; status: number; error: string };

const DASHBOARD_REFUSAL: Record<PilotRefusal, string> = {
  not_authorized: "You are not allowed to do that.",
  no_draft: "There is no draft to approve. Write one with Edit.",
  draft_replaced: "That draft was replaced by a newer one. Reload the queue and review the latest draft.",
  draft_changed: "That draft changed while you were approving it. Nothing was sent: review the latest draft.",
  wrong_version: "That is not the current draft. Reload the queue.",
  needs_confirmation: "This draft contains facts that are not backed by approved knowledge. Check them, then approve with “I've checked the facts”, or Edit the wording.",
  already_approved: "This draft was already approved. It will not be sent twice.",
  closed: "This request is closed. Nothing was sent.",
  bad_arguments: "That request was not understood.",
  no_target: "That request could not be matched.",
  ambiguous_quote: "That request matches more than one draft.",
  not_in_pilot: "Approvals only work while the business is in Approval Pilot mode.",
  loose_approval: "That is not an approval.",
  empty_edit: "Type the new wording first.",
  unsafe_edit: "That wording can't be used: it looks like it contains a secret or is too long.",
  duplicate_send: "This reply is already on its way. It will not be sent twice.",
  moreinfo_not_authorized: "You are not allowed to do that.",
};

async function loadEscalation(businessSlug: string, id: string): Promise<EscalationRow | null> {
  const { data, error } = await agentDb().from("ai_agent_escalations").select(ESCALATION_COLUMNS).eq("id", id).eq("business_slug", businessSlug).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as EscalationRow | null) ?? null;
}

export async function runApprovalAction(args: {
  settings: AgentSettings;
  escalationId: string;
  adminId: string;
  action: "approve" | "edit" | "reject" | "moreinfo";
  /** The draft the admin was looking at. Approve / reject refuse when it is no longer the current one. */
  draftId?: string | null;
  confirm?: boolean;
  text?: string | null;
  reason?: string | null;
}): Promise<ApprovalActionResult> {
  const { settings } = args;
  const e = await loadEscalation(settings.business_slug, args.escalationId);
  if (!e) return { ok: false, status: 404, error: "Request not found" };

  if (args.action === "moreinfo") {
    const info = await loadMoreInfo({ settings, escalation: e, quotedDraftId: args.draftId ?? null });
    await audit(e.business_slug, "admin", args.adminId, "pilot.moreinfo", { type: "escalation", id: e.id }, { ref_code: e.ref_code, version: info.version, stale: info.stale, via: "admin_ui" });
    return { ok: true, message: "ok", text: info.text };
  }

  if (settings.mode !== "approval_pilot") return { ok: false, status: 409, error: DASHBOARD_REFUSAL.not_in_pilot };
  if (e.status === "resolved" || e.status === "cancelled") return { ok: false, status: 409, error: DASHBOARD_REFUSAL.closed };

  if (args.action === "edit") {
    const text = (args.text ?? "").trim();
    if (!text) return { ok: false, status: 400, error: DASHBOARD_REFUSAL.empty_edit };
    if (checkExactSendSafety(text).length > 0) return { ok: false, status: 400, error: DASHBOARD_REFUSAL.unsafe_edit };
    const current = await currentDraft(e.business_slug, e.id);
    if (args.draftId && current && current.id !== args.draftId) return { ok: false, status: 409, error: DASHBOARD_REFUSAL.draft_replaced };
    if (current && current.body_hash === bodyHash(text)) return { ok: true, message: "That is already the current draft.", draftId: current.id };
    // The wording is a person's own: "ready", but it still has to be approved (a separate click).
    const draft = await createDraftVersion({ escalation: e, source: "staff_edit", body: text, ready: true, notes: [], createdBy: `admin:${args.adminId}` });
    await audit(e.business_slug, "admin", args.adminId, "pilot.edit", { type: "escalation", id: e.id }, { ref_code: e.ref_code, draft_id: draft.id, version: draft.version, replaced_version: current?.version ?? null, via: "admin_ui" });
    return { ok: true, message: `Saved as draft v${draft.version}. Approve it to send.`, draftId: draft.id };
  }

  const draft = args.draftId ? await draftById(e.business_slug, e.id, args.draftId) : await currentDraft(e.business_slug, e.id);
  if (!draft) return { ok: false, status: 409, error: DASHBOARD_REFUSAL.no_draft };
  if (draft.status !== "current") return { ok: false, status: 409, error: DASHBOARD_REFUSAL.draft_replaced };

  if (args.action === "reject") {
    const parsed = parseRejectArgs((args.reason ?? "").trim());
    const done = await rejectDraft({ draft, verdict: parsed.verdict, note: parsed.note, decidedBy: `admin:${args.adminId}`, messageId: `dashboard:${args.adminId}` });
    if (!done) return { ok: false, status: 409, error: DASHBOARD_REFUSAL.draft_replaced };
    await audit(e.business_slug, "admin", args.adminId, "pilot.reject", { type: "escalation", id: e.id }, { ref_code: e.ref_code, draft_id: draft.id, version: draft.version, verdict: parsed.verdict, via: "admin_ui" });
    return { ok: true, message: "Draft rejected. Nothing was sent." };
  }

  const result = await approveDraftCore({
    settings,
    escalation: e,
    draft,
    confirm: args.confirm === true,
    approver: {
      requester: { kind: "admin", adminId: args.adminId },
      approverId: `admin:${args.adminId}`,
      actorId: args.adminId,
      actorKind: "admin",
      messageId: `dashboard:${args.adminId}`,
      eventId: null,
      outboxStatus: "pending",
      via: "admin_ui",
    },
  });
  if (result.kind === "refused") return { ok: false, status: 409, error: result.why === "needs_confirmation" && result.extra ? `${DASHBOARD_REFUSAL.needs_confirmation} (${result.extra})` : DASHBOARD_REFUSAL[result.why] };
  if (result.kind === "withheld") return { ok: false, status: 409, error: `Not sent: ${WITHHOLD_TEXT[result.reason]}.` };
  return { ok: true, message: "Approved. The reply is being sent to the customer." };
}
