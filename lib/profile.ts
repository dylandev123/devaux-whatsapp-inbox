import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors `profiles` from supabase/migrations/20260623000800_admin_roles.sql.
export type Role = "staff" | "admin";

export interface CurrentProfile {
  email: string | null;
  role: Role;
}

export async function fetchCurrentProfile(): Promise<CurrentProfile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (error) {
    throw new Error(logAndDescribeError("fetchCurrentProfile", error));
  }
  return { email: user.email ?? null, role: (data?.role as Role) ?? "staff" };
}
