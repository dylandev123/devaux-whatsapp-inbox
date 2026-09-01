import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors customer_ai_profile from
// supabase/migrations/20260901000400_customer_ai_profile.sql. Read-only from
// the client — every field here is an AI-inferred guess, kept separate from
// (and never written into) the verified fields on `customers`; see that
// migration's comment. Writes only ever happen server-side, from the
// analysis engine.
export interface CustomerAiProfile {
  business_slug: string;
  contact_number: string;
  preferences: string | null;
  common_orders: string | null;
  addresses: string | null;
  payment_habits: string | null;
  important_notes: string | null;
  last_known_intent: string | null;
  updated_at: string;
}

const PROFILE_COLUMNS =
  "business_slug, contact_number, preferences, common_orders, addresses, payment_habits, important_notes, last_known_intent, updated_at";

// On-demand single lookup — used by the analysis detail view, which only
// needs one customer's profile at a time regardless of which list (the
// per-business table or the cross-business order queue) it was opened from.
export async function fetchProfileFor(
  businessSlug: string,
  contactNumber: string | null
): Promise<CustomerAiProfile | null> {
  if (!contactNumber) return null;
  const { data, error } = await supabase
    .from("customer_ai_profile")
    .select(PROFILE_COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("contact_number", contactNumber)
    .maybeSingle();
  if (error) {
    throw new Error(logAndDescribeError("fetchProfileFor", error));
  }
  return data;
}

export function hasProfileContent(profile: CustomerAiProfile | null | undefined): boolean {
  if (!profile) return false;
  return Boolean(
    profile.preferences ||
      profile.common_orders ||
      profile.addresses ||
      profile.payment_habits ||
      profile.important_notes ||
      profile.last_known_intent
  );
}
