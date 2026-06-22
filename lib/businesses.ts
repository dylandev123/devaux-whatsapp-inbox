import { supabase } from "@/lib/supabaseClient";
import { BUSINESS_LABELS } from "@/lib/whatsapp";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors whatsapp_businesses from
// supabase/migrations/20260623000300_business_management.sql.
export interface WhatsappBusinessRow {
  id: string;
  business_slug: string;
  display_name: string;
  colour: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const BUSINESS_COLUMNS =
  "id, business_slug, display_name, colour, is_active, sort_order, created_at, updated_at";

export async function fetchActiveBusinesses(): Promise<WhatsappBusinessRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_businesses")
    .select(BUSINESS_COLUMNS)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    throw new Error(logAndDescribeError("fetchActiveBusinesses", error));
  }
  return data ?? [];
}

// Synthetic rows built from the static BUSINESS_LABELS dictionary, used only
// when whatsapp_businesses can't be read (most likely because
// supabase/migrations/20260623000300_business_management.sql hasn't been run
// yet). This keeps the sidebar showing every known business and fully
// clickable instead of going blank.
function buildFallbackBusinesses(): WhatsappBusinessRow[] {
  return Object.keys(BUSINESS_LABELS).map((slug, index) => ({
    id: slug,
    business_slug: slug,
    display_name: BUSINESS_LABELS[slug],
    colour: null,
    is_active: true,
    sort_order: index,
    created_at: "",
    updated_at: "",
  }));
}

// Same as fetchActiveBusinesses(), but never throws — falls back to the
// static business list so the sidebar always has something to render.
export async function fetchActiveBusinessesOrFallback(): Promise<{
  businesses: WhatsappBusinessRow[];
  usedFallback: boolean;
}> {
  try {
    const businesses = await fetchActiveBusinesses();
    if (businesses.length === 0) {
      return { businesses: buildFallbackBusinesses(), usedFallback: true };
    }
    return { businesses, usedFallback: false };
  } catch (err) {
    console.error("[fetchActiveBusinessesOrFallback] falling back to static business list", err);
    return { businesses: buildFallbackBusinesses(), usedFallback: true };
  }
}

// For the admin management list. Note: the SELECT RLS policy only allows
// reading active rows (per the migration), so a deactivated business will
// disappear from this list too, immediately — there's currently no app-level
// way to see or reactivate it again.
export async function fetchManagedBusinesses(): Promise<WhatsappBusinessRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_businesses")
    .select(BUSINESS_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error) {
    throw new Error(logAndDescribeError("fetchManagedBusinesses", error));
  }
  return data ?? [];
}

export interface NewBusinessInput {
  business_slug: string;
  display_name: string;
  colour: string;
  sort_order?: number;
}

export async function createBusiness(input: NewBusinessInput): Promise<WhatsappBusinessRow> {
  const { data, error } = await supabase
    .from("whatsapp_businesses")
    .insert({ ...input, sort_order: input.sort_order ?? 0 })
    .select(BUSINESS_COLUMNS)
    .single();
  if (error) {
    throw new Error(logAndDescribeError("createBusiness", error));
  }
  return data;
}

export type BusinessUpdate = Partial<
  Pick<WhatsappBusinessRow, "display_name" | "colour" | "sort_order" | "is_active">
>;

export async function updateBusiness(id: string, patch: BusinessUpdate): Promise<WhatsappBusinessRow> {
  const { data, error } = await supabase
    .from("whatsapp_businesses")
    .update(patch)
    .eq("id", id)
    .select(BUSINESS_COLUMNS)
    .single();
  if (error) {
    throw new Error(logAndDescribeError("updateBusiness", error));
  }
  return data;
}
