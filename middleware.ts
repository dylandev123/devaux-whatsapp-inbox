import { NextResponse, type NextRequest } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase/middleware";

// Single server-side auth/role gate for the whole app. Page routes redirect
// to /login (or / for an admin-only page hit by a non-admin); API routes get
// a JSON 401/403 instead, since they're called via fetch(), not navigation.
//
// /api/whatsapp/send is authenticated-only (any staff member sends
// messages from the inbox). Every other /api/whatsapp/* route — status, qr,
// restart, businesses/reload, session/*/start — is only ever called from the
// admin UI, so it requires the admin role too.
const ADMIN_API_PREFIXES = [
  "/api/whatsapp/status",
  "/api/whatsapp/qr",
  "/api/whatsapp/restart",
  "/api/whatsapp/businesses",
  "/api/whatsapp/session",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { supabase, response } = createMiddlewareClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isApi = pathname.startsWith("/api/");
  const needsAdmin =
    pathname.startsWith("/admin") || ADMIN_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!user) {
    if (isApi) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (needsAdmin) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") {
      if (isApi) {
        return NextResponse.json({ error: "Admin access required" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ["/", "/contacts", "/admin/:path*", "/api/whatsapp/:path*"],
};
