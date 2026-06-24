import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// createBrowserClient (not createClient) so the session lives in cookies
// instead of localStorage — middleware.ts can only see a logged-in user if
// the session is in a cookie. Same exported shape as before, so every
// existing `import { supabase } from "@/lib/supabaseClient"` call site is
// unaffected.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
