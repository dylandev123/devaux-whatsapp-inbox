import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { encryptionKey, signState } from "@/lib/server/aiAgent/googleDocs/crypto";
import { buildAuthUrl, oauthConfig } from "@/lib/server/aiAgent/googleDocs/google";
import { OAUTH_COOKIE, redirectUriFor } from "@/lib/server/aiAgent/googleDocs/oauthCookie";

// Starts "Connect Google Account": a browser navigation (not fetch) from the AI Agent page. Admin-only. The state is signed and
// bound to this admin and this business; the nonce and PKCE verifier live in an httpOnly cookie that only this browser sends back.
export const dynamic = "force-dynamic";


export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  const cfg = oauthConfig();
  const key = encryptionKey();
  if (!cfg || !key) return jsonError("Google is not configured on the server yet (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY).", 503);

  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const state = signState({ b: businessSlug, u: admin.userId, n: nonce, exp: Date.now() + 10 * 60_000 }, key);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const response = NextResponse.redirect(buildAuthUrl(cfg, redirectUriFor(request), state, challenge));
  response.cookies.set(OAUTH_COOKIE, `${nonce}.${verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/ai-agent/google-docs",
    maxAge: 600,
  });
  return response;
}
