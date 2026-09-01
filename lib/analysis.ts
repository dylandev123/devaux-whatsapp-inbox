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

export interface ExtractedDetails {
  products_services?: string[] | null;
  quantity?: string | null;
  dates?: string[] | null;
  address?: string | null;
  payment_info?: string | null;
  booking_info?: string | null;
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
  analyzed_at: string;
  created_at: string;
}

const ANALYSIS_COLUMNS =
  "id, business_slug, chat_id, category, summary, extracted, urgency, needs_action, next_action, confidence, customer_name, phone_display, contact_number, message_count, last_message_at, model, status, error_message, analyzed_at, created_at";

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

export interface RunAnalysisResult {
  analyzed: number;
  skipped: number;
  failed: number;
}

// Single-conversation manual (re-)analysis — always runs, regardless of
// whether it's already up to date.
export async function runAnalysis(businessSlug: string, chatId: string): Promise<void> {
  const res = await fetch("/api/analysis/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessSlug, chatId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to analyze conversation (${res.status})`);
  }
}

// Bulk "analyze new/updated conversations" for a business — capped
// server-side per call (see app/api/analysis/run/route.ts) so this may need
// to be called more than once to fully catch up a business with a large
// backlog.
export async function runBusinessAnalysis(businessSlug: string): Promise<RunAnalysisResult> {
  const res = await fetch("/api/analysis/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessSlug }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to run analysis (${res.status})`);
  }
  return data as RunAnalysisResult;
}
