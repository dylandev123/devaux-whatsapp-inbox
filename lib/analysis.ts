import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors conversation_analysis from
// supabase/migrations/20260901000200_conversation_analysis.sql.
export const ANALYSIS_CATEGORIES = [
  "Order placed",
  "Order inquiry",
  "Booking inquiry",
  "Payment",
  "Complaint/concern",
  "Follow-up needed",
  "General question",
  "Positive feedback",
  "Cancellation/change",
  "Other",
] as const;

export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];
export type AnalysisUrgency = "low" | "medium" | "high";

// Manual order-workflow tracking — see
// supabase/migrations/20260901000500_order_status.sql. Set once by the
// analysis engine the first time a conversation becomes "Order placed" and
// never touched by it again; every later transition is a staff action via
// updateOrderStatus() below. Null for every conversation that was never (or
// isn't currently) an order.
export const ORDER_STATUSES = ["Needs adding", "Added", "Completed"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Manual Done/Active workflow — see
// supabase/migrations/20260902010000_conversation_workflow_status.sql.
// Applies to every analyzed conversation, unlike order_status (only ever
// set for "Order placed" rows). Set by staff (markDone/markActive below) or
// by resurfaceDoneWithNewActivity() when a Done conversation gets new
// messages — never by the analysis engine itself.
export const WORKFLOW_STATUSES = ["Active", "Done"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export interface ExtractedDetails {
  products_services?: string[] | null;
  quantity?: string | null;
  dates?: string[] | null;
  address?: string | null;
  payment_info?: string | null;
  booking_info?: string | null;
}

// Which messages get fed to the model for a given analysis run — see
// lib/server/analysisEngine.ts. `until` is always sent explicitly (never
// left to default to "now" server-side) so a custom range in the past
// behaves identically on every run.
export interface AnalysisRange {
  since: string;
  until: string;
}

export const RANGE_PRESETS = ["1d", "2d", "7d", "30d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const PRESET_DAYS: Record<Exclude<RangePreset, "custom">, number> = {
  "1d": 1,
  "2d": 2,
  "7d": 7,
  "30d": 30,
};

export function resolvePresetRange(preset: Exclude<RangePreset, "custom">): AnalysisRange {
  const until = new Date();
  const since = new Date(until.getTime() - PRESET_DAYS[preset] * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString() };
}

export interface ConversationAnalysis {
  id: string;
  business_slug: string;
  chat_id: string;
  category: AnalysisCategory;
  summary: string;
  extracted: ExtractedDetails;
  urgency: AnalysisUrgency;
  needs_action: boolean;
  next_action: string | null;
  confidence: number | null;
  customer_name: string | null;
  phone_display: string | null;
  contact_number: string | null;
  message_count: number;
  last_message_at: string | null;
  model: string | null;
  status: "ok" | "error";
  error_message: string | null;
  order_status: OrderStatus | null;
  workflow_status: WorkflowStatus;
  analyzed_at: string;
  created_at: string;
}

const ANALYSIS_COLUMNS =
  "id, business_slug, chat_id, category, summary, extracted, urgency, needs_action, next_action, confidence, customer_name, phone_display, contact_number, message_count, last_message_at, model, status, error_message, order_status, workflow_status, analyzed_at, created_at";

export async function fetchAnalysesForBusiness(businessSlug: string): Promise<ConversationAnalysis[]> {
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select(ANALYSIS_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("analyzed_at", { ascending: false });
  if (error) {
    throw new Error(logAndDescribeError("fetchAnalysesForBusiness", error));
  }
  return data ?? [];
}

// Cross-business order queue — every conversation currently classified
// "Order placed", across every business, so nothing gets missed by staff
// only checking one business tab. Each row still carries its own
// business_slug for a "source business" label; this never mixes data
// *between* businesses, it just lists already-separately-analyzed rows
// together for visibility.
export async function fetchOrderPlacedAnalyses(): Promise<ConversationAnalysis[]> {
  const { data, error } = await supabase
    .from("conversation_analysis")
    .select(ANALYSIS_COLUMNS)
    .eq("category", "Order placed")
    .order("analyzed_at", { ascending: false });
  if (error) {
    throw new Error(logAndDescribeError("fetchOrderPlacedAnalyses", error));
  }
  return data ?? [];
}

// Staff-only manual workflow transition — the AI never calls this. Writes
// directly via RLS (conversation_analysis's existing "authenticated can
// update" policy), same pattern as conversation status / customer field
// edits elsewhere in this app.
export async function updateOrderStatus(id: string, orderStatus: OrderStatus): Promise<void> {
  const { error } = await supabase.from("conversation_analysis").update({ order_status: orderStatus }).eq("id", id);
  if (error) {
    throw new Error(logAndDescribeError("updateOrderStatus", error));
  }
}

// Manual Done/Active toggle — any category, not just orders. Staff-only,
// same direct-write-via-RLS pattern as updateOrderStatus above.
export async function updateWorkflowStatus(id: string, workflowStatus: WorkflowStatus): Promise<void> {
  const { error } = await supabase
    .from("conversation_analysis")
    .update({ workflow_status: workflowStatus })
    .eq("id", id);
  if (error) {
    throw new Error(logAndDescribeError("updateWorkflowStatus", error));
  }
}

// Orders queue's quick tick-off: "delivery added/noted" for an order is
// both order_status='Completed' (the existing order-entry pipeline) and
// workflow_status='Done' (leaves the active queue) — one staff click, one
// write, both columns, so they can never disagree with each other.
export async function markOrderDelivered(id: string): Promise<void> {
  const { error } = await supabase
    .from("conversation_analysis")
    .update({ order_status: "Completed" satisfies OrderStatus, workflow_status: "Done" satisfies WorkflowStatus })
    .eq("id", id);
  if (error) {
    throw new Error(logAndDescribeError("markOrderDelivered", error));
  }
}

// Latest message timestamp per conversation, straight from whatsapp_messages
// — used only to detect whether a Done conversation has new messages since
// it was last analyzed (see resurfaceDoneWithNewActivity below). Grouped by
// business_slug into one query per business (chat_id alone isn't
// necessarily unique across businesses), same "select two light columns,
// reduce to latest-per-chat in JS" approach as listConversations() in
// lib/server/analysisEngine.ts. Map keys are `${businessSlug}::${chatId}`.
export async function fetchLatestMessageTimestamps(
  targets: { businessSlug: string; chatId: string }[]
): Promise<Map<string, string>> {
  const chatIdsByBusiness = new Map<string, string[]>();
  for (const t of targets) {
    const list = chatIdsByBusiness.get(t.businessSlug) ?? [];
    list.push(t.chatId);
    chatIdsByBusiness.set(t.businessSlug, list);
  }

  const result = new Map<string, string>();
  await Promise.all(
    Array.from(chatIdsByBusiness.entries()).map(async ([businessSlug, chatIds]) => {
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("chat_id, timestamp")
        .eq("business_slug", businessSlug)
        .in("chat_id", chatIds)
        .order("timestamp", { ascending: false });
      if (error) {
        throw new Error(logAndDescribeError("fetchLatestMessageTimestamps", error));
      }
      for (const row of data ?? []) {
        const key = `${businessSlug}::${row.chat_id}`;
        if (!result.has(key)) result.set(key, row.timestamp);
      }
    })
  );
  return result;
}

export interface ResurfaceResult {
  updated: ConversationAnalysis[];
  newActivityIds: Set<string>;
}

// Auto-resurface: any Done conversation whose real last message (fetched
// above) is newer than what its cached analysis row still shows gets moved
// back to Active — same staleness signal (`last_message_at` drift) already
// used server-side to pick which conversations "Analyze new/updated" should
// re-run (see app/api/analysis/run/route.ts), just applied client-side to
// Done rows only. No cron/trigger: this only ever runs when a dashboard
// view loads its list, per this table's "no auto-run" design (see
// conversation_analysis's migration comment) — call it right after fetching
// rows and merge `updated` into local state so the row visibly moves out of
// Done immediately, and use `newActivityIds` to badge it as "New activity"
// for this load.
export async function resurfaceDoneWithNewActivity(
  rows: ConversationAnalysis[]
): Promise<ResurfaceResult> {
  const doneRows = rows.filter((r) => r.workflow_status === "Done");
  if (doneRows.length === 0) {
    return { updated: [], newActivityIds: new Set() };
  }

  const latest = await fetchLatestMessageTimestamps(
    doneRows.map((r) => ({ businessSlug: r.business_slug, chatId: r.chat_id }))
  );

  const toResurface = doneRows.filter((r) => {
    const liveTimestamp = latest.get(`${r.business_slug}::${r.chat_id}`);
    if (!liveTimestamp) return false;
    if (!r.last_message_at) return true;
    return new Date(liveTimestamp).getTime() > new Date(r.last_message_at).getTime();
  });
  if (toResurface.length === 0) {
    return { updated: [], newActivityIds: new Set() };
  }

  await Promise.all(toResurface.map((r) => updateWorkflowStatus(r.id, "Active")));

  return {
    updated: toResurface.map((r) => ({ ...r, workflow_status: "Active" as WorkflowStatus })),
    newActivityIds: new Set(toResurface.map((r) => r.id)),
  };
}

export interface RunAnalysisResult {
  analyzed: number;
  skipped: number;
  failed: number;
  message?: string;
}

// Single-conversation manual (re-)analysis — always runs (regardless of
// whether it's already up to date) against whatever messages fall in
// `range`. Existing conversation_analysis/customer_ai_profile rows are sent
// along server-side as context — see lib/server/analysisEngine.ts — so a
// narrow range doesn't mean the model loses everything learned before it.
export async function runAnalysis(
  businessSlug: string,
  chatId: string,
  range: AnalysisRange
): Promise<RunAnalysisResult> {
  const res = await fetch("/api/analysis/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessSlug, chatId, ...range }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to analyze conversation (${res.status})`);
  }
  return data as RunAnalysisResult;
}

// Bulk "analyze new/updated conversations" for a business — only considers
// conversations with at least one message in `range`, capped server-side
// per call (see app/api/analysis/run/route.ts) so this may need to be
// called more than once to fully catch up a business with a large backlog.
export async function runBusinessAnalysis(
  businessSlug: string,
  range: AnalysisRange
): Promise<RunAnalysisResult> {
  const res = await fetch("/api/analysis/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessSlug, ...range }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to run analysis (${res.status})`);
  }
  return data as RunAnalysisResult;
}
