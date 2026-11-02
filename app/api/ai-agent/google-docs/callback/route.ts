import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/aiAgent/auth";
import { audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { encryptSecret, encryptionKey, verifyState } from "@/lib/server/aiAgent/googleDocs/crypto";
import { exchangeCode, fetchAccountEmail, GoogleApiError, oauthConfig, REQUIRED_SCOPES } from "@/lib/server/aiAgent/googleDocs/google";
import { loadConnection, loadGdocSettings, saveConnection, saveGdocSettings } from "@/lib/server/aiAgent/googleDocs/store";
import { OAUTH_COOKIE, redirectUriFor } from "@/lib/server/aiAgent/googleDocs/oauthCookie";

// Google redirects the admin's browser here. Nothing is trusted from the URL except the one-time code, and only after the
// signed state, the cookie nonce, the logged-in admin and the business all agree.
export const dynamic = "force-dynamic";

function back(request: Request, businessSlug: string | null, result: string, detail?: string): NextResponse {
  const url = new URL("/admin/ai-agent", request.url);
  url.searchParams.set("gdocs", result);
  if (businessSlug) url.searchParams.set("business", businessSlug);
  if (detail) url.searchParams.set("detail", detail.slice(0, 160));
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_COOKIE, "", { path: "/api/ai-agent/google-docs", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const state = verifyState(params.get("state"));
  const cookie = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${OAUTH_COOKIE}=`))?.slice(OAUTH_COOKIE.length + 1) ?? "";
  const [nonce, verifier] = decodeURIComponent(cookie).split(".");
  if (!state || !nonce || !verifier || state.n !== nonce || state.u !== admin.userId) return back(request, null, "error", "The sign-in link expired or did not match. Start again.");
  const businessSlug = await resolveBusinessSlug(state.b);
  if (!businessSlug) return back(request, null, "error", "Unknown business.");
  if (params.get("error")) return back(request, businessSlug, "error", params.get("error") === "access_denied" ? "Google access was not granted." : "Google reported an error.");
  const code = params.get("code");
  const cfg = oauthConfig();
  if (!code || !cfg || !encryptionKey()) return back(request, businessSlug, "error", "Google is not configured on the server.");

  try {
    const tokens = await exchangeCode(cfg, code, redirectUriFor(request), verifier);
    const missing = REQUIRED_SCOPES.filter((s) => !tokens.scopes.includes(s));
    if (missing.length > 0) return back(request, businessSlug, "error", "Please allow every requested permission — the sync needs to read and edit the document.");
    if (!tokens.refreshToken) return back(request, businessSlug, "error", "Google did not return a long-lived sign-in. Remove this app at myaccount.google.com/permissions and connect again.");
    const email = await fetchAccountEmail(tokens.accessToken);

    const previous = await loadConnection(businessSlug);
    await saveConnection({
      business_slug: businessSlug,
      account_email: email,
      refresh_token_enc: encryptSecret(tokens.refreshToken, businessSlug),
      scopes: tokens.scopes,
      connected_by: admin.userId,
    });
    const settings = await loadGdocSettings(businessSlug);
    if (settings) {
      // Reconnecting the same account keeps the document and the on/off choice and clears a "reconnect" warning. A different
      // account may not have access to the document, so sync stops until the access test is run again.
      const sameAccount = !previous || previous.account_email.toLowerCase() === email.toLowerCase();
      await saveGdocSettings(businessSlug, sameAccount ? { health: "ok", last_error: null } : { enabled: false, can_edit: false, access_verified_at: null, health: "ok", last_error: null }, admin.userId);
    }
    await audit(businessSlug, "admin", admin.userId, "gdocs.connect", { type: "google_connection" }, { account: email });
    return back(request, businessSlug, "connected");
  } catch (err) {
    console.error("[google-docs callback]", err instanceof GoogleApiError ? `${err.kind} ${err.message}` : err instanceof Error ? err.message : err);
    return back(request, businessSlug, "error", "Could not finish connecting Google. Try again.");
  }
}
