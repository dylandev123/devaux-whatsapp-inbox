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
  analyzed_at: string;
  created_at: string;
}

const ANALYSIS_COLUMNS =
  "id, business_slug, chat_id, category, summary, extracted, urgency, needs_action, next_action, confidence, customer_name, phone_display, contact_number, message_count, last_message_at, model, status, error_message, order_status, analyzed_at, created_at";

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
