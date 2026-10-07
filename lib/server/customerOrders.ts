// Server-only: persists a detected "Order placed" into the append-only
// customer_orders table (supabase/migrations/20261008000000_customer_orders.sql).
// Takes the service-role client from the analysis engine.
//
// Dedupe: one row per (business_slug, chat_id, order_seq). A run either
// UPDATES the conversation's newest order row or APPENDS seq+1 — and appends
// only when the model flagged a distinct new order AND the analysis has seen
// messages newer than those already synced into the newest row. Re-analyzing
// the same messages can't satisfy the second condition, so it never appends.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedDetails, OrderStatus } from "@/lib/analysis";

export interface LatestOrder {
  order_seq: number;
  summary: string;
  details: ExtractedDetails;
  source_message_at: string | null;
  source_last_message_at: string | null;
}

export async function fetchLatestOrder(
  supabase: SupabaseClient,
  businessSlug: string,
  chatId: string
): Promise<LatestOrder | null> {
  const { data, error } = await supabase
    .from("customer_orders")
    .select("order_seq, summary, details, source_message_at, source_last_message_at")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .order("order_seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LatestOrder | null) ?? null;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// A narrow re-analysis range may legitimately return nulls for details it
// didn't see again — don't let that erase what an earlier run captured.
function mergeDetails(prior: ExtractedDetails, next: ExtractedDetails): ExtractedDetails {
  const merged: Record<string, unknown> = { ...prior };
  for (const [key, value] of Object.entries(next)) {
    if (!isEmpty(value)) merged[key] = value;
  }
  return merged as ExtractedDetails;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface SyncOrderInput {
  businessSlug: string;
  chatId: string;
  contactNumber: string;
  customerName: string | null;
  analysisId?: string;
  summary: string;
  extracted: ExtractedDetails;
  confidence: number | null;
  initialStatus: OrderStatus;
  // Newest message covered by this analysis run.
  lastMessageAt: string;
  // The model's judgment: do the new messages place an additional order?
  modelSaysNewOrder: boolean;
  latest: LatestOrder | null;
}

// Returns whether a NEW order row was appended (as opposed to an in-place
// update), so the caller can reset the queue entry for the new order.
export async function syncCustomerOrder(
  supabase: SupabaseClient,
  input: SyncOrderInput
): Promise<{ createdNew: boolean }> {
  const { latest } = input;
  const lastSynced = latest?.source_last_message_at ?? latest?.source_message_at ?? null;
  const hasNewerMessages = !lastSynced || new Date(input.lastMessageAt).getTime() > new Date(lastSynced).getTime();
  const append = !latest || (input.modelSaysNewOrder && hasNewerMessages);

  if (append) {
    const { error } = await supabase.from("customer_orders").insert({
      business_slug: input.businessSlug,
      chat_id: input.chatId,
      contact_number: input.contactNumber,
      order_seq: (latest?.order_seq ?? 0) + 1,
      customer_name: input.customerName,
      summary: input.summary,
      details: input.extracted,
      delivery_address: text(input.extracted.address),
      payment_info: text(input.extracted.payment_info),
      order_status: input.initialStatus,
      confidence: input.confidence,
      source_analysis_id: input.analysisId ?? null,
      source_message_at: input.lastMessageAt,
      source_last_message_at: input.lastMessageAt,
    });
    if (!error) return { createdNew: true };
    // 23505 = a concurrent run already allocated this seq: fall through and
    // fold this result into that row instead of duplicating it.
    if (error.code !== "23505") throw new Error(error.message);
    const raced = await fetchLatestOrder(supabase, input.businessSlug, input.chatId);
    if (!raced) throw new Error(error.message);
    await updateOrder(supabase, input, raced);
    return { createdNew: false };
  }

  await updateOrder(supabase, input, latest!);
  return { createdNew: false };
}

async function updateOrder(supabase: SupabaseClient, input: SyncOrderInput, target: LatestOrder) {
  const details = mergeDetails(target.details ?? {}, input.extracted);
  const prevSynced = target.source_last_message_at ? new Date(target.source_last_message_at).getTime() : 0;
  const lastSynced =
    new Date(input.lastMessageAt).getTime() > prevSynced ? input.lastMessageAt : target.source_last_message_at;

  const { error } = await supabase
    .from("customer_orders")
    .update({
      customer_name: input.customerName,
      summary: input.summary,
      details,
      delivery_address: text(details.address),
      payment_info: text(details.payment_info),
      confidence: input.confidence,
      source_analysis_id: input.analysisId ?? null,
      source_last_message_at: lastSynced,
    })
    .eq("business_slug", input.businessSlug)
    .eq("chat_id", input.chatId)
    .eq("order_seq", target.order_seq);
  if (error) throw new Error(error.message);
}
