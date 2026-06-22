import { supabase } from "@/lib/supabaseClient";

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
  if (error) throw error;
  return data ?? [];
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
  if (error) throw error;
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
  if (error) throw error;
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
  if (error) throw error;
  return data;
}
