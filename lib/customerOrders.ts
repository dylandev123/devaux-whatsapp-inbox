import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";
import type { ExtractedDetails, OrderStatus } from "@/lib/analysis";

// Mirrors customer_orders from
// supabase/migrations/20261008000000_customer_orders.sql — permanent,
// append-only order history that outlives whatsapp_messages retention.
// Read-only from the client; written only by the analysis engine.
export interface CustomerOrder {
  id: string;
  business_slug: string;
  chat_id: string;
  contact_number: string;
  order_seq: number;
  summary: string;
  details: ExtractedDetails;
  delivery_address: string | null;
  payment_info: string | null;
  order_status: OrderStatus | null;
  source_message_at: string | null;
  detected_at: string;
}

const ORDER_COLUMNS =
  "id, business_slug, chat_id, contact_number, order_seq, summary, details, delivery_address, payment_info, order_status, source_message_at, detected_at";

// Newest first, scoped to one customer within one business (businesses are
// kept strictly separate, same as customer_ai_profile).
export async function fetchOrdersForCustomer(
  businessSlug: string,
  contactNumber: string
): Promise<CustomerOrder[]> {
  const { data, error } = await supabase
    .from("customer_orders")
    .select(ORDER_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("contact_number", contactNumber)
    .order("source_message_at", { ascending: false, nullsFirst: false })
    .order("order_seq", { ascending: false });
  if (error) {
    throw new Error(logAndDescribeError("fetchOrdersForCustomer", error));
  }
  return (data ?? []) as CustomerOrder[];
}
