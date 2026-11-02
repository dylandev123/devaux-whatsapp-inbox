// Server-only: the few Google REST calls the order sync needs, over plain fetch (no SDK). Everything the sync does to a
// document goes through DocsClient, so tests substitute an in-memory document and the real Google is never touched.
//
// Scopes (the minimum that works for an EXISTING document the admin did not create with this app):
//   documents                    read the document and insert/replace/delete text in it
//   drive.metadata.readonly      read the document's title and whether the account may edit it (capabilities.canEdit);
//                                no file content is read through Drive
//   openid email                 show which Google account is connected
// No timers are used: every request is bounded by AbortSignal.timeout.

import type { GoogleDocument, DocRequest } from "@/lib/aiAgent/gdocDocument";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;
export const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.metadata.readonly"] as const;

export type GoogleErrorKind = "invalid_grant" | "forbidden" | "not_found" | "precondition" | "rate_limited" | "server" | "network" | "bad_request";

export class GoogleApiError extends Error {
  kind: GoogleErrorKind;
  status: number;
  constructor(kind: GoogleErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  canEdit: boolean;
}

export interface DocsClient {
  getFile(documentId: string): Promise<DriveFile>;
  getDocument(documentId: string): Promise<GoogleDocument>;
  /** One atomic batch. With requiredRevisionId Google rejects it (kind "precondition") if the document changed since that revision. */
  batchUpdate(documentId: string, requests: DocRequest[], requiredRevisionId?: string): Promise<void>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function oauthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const TIMEOUT_MS = 12_000;
const DOC_MIME = "application/vnd.google-apps.document";

function classify(status: number, body: unknown): GoogleApiError {
  const err = (body as { error?: unknown } | null)?.error;
  const message =
    typeof err === "string" ? err : typeof (err as { message?: unknown } | undefined)?.message === "string" ? ((err as { message: string }).message) : `Google returned ${status}`;
  const reason = String((err as { status?: unknown } | undefined)?.status ?? "");
  if (status === 400 && /FAILED_PRECONDITION/i.test(reason)) return new GoogleApiError("precondition", status, message);
  if (status === 400 && err === "invalid_grant") return new GoogleApiError("invalid_grant", status, "Google access was revoked or expired");
  if (status === 401) return new GoogleApiError("invalid_grant", status, "Google rejected the credentials");
  if (status === 403) return new GoogleApiError(/rate|quota/i.test(message) ? "rate_limited" : "forbidden", status, message);
  if (status === 404) return new GoogleApiError("not_found", status, message);
  if (status === 429) return new GoogleApiError("rate_limited", status, message);
  if (status >= 500) return new GoogleApiError("server", status, message);
  return new GoogleApiError("bad_request", status, message);
}

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (err) {
    throw new GoogleApiError("network", 0, err instanceof Error ? err.message : "Could not reach Google");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw classify(res.status, body);
  return body;
}

// ── OAuth ────────────────────────────────────────────────────────────────────
export function buildAuthUrl(cfg: GoogleOAuthConfig, redirectUri: string, state: string, codeChallenge: string, loginHint?: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  // Always show consent: Google only returns a refresh token on the first grant otherwise.
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

const tokenBody = (cfg: GoogleOAuthConfig, extra: Record<string, string>) => new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...extra });

export async function exchangeCode(cfg: GoogleOAuthConfig, code: string, redirectUri: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const body = (await call(fetchImpl, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody(cfg, { code, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
  })) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!body.access_token) throw new GoogleApiError("bad_request", 400, "Google did not return an access token");
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, scopes: (body.scope ?? "").split(/\s+/).filter(Boolean) };
}

export async function refreshAccessToken(cfg: GoogleOAuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = (await call(fetchImpl, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody(cfg, { refresh_token: refreshToken, grant_type: "refresh_token" }),
  })) as { access_token?: string };
  if (!body.access_token) throw new GoogleApiError("invalid_grant", 400, "Google did not return an access token");
  return body.access_token;
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await call(fetchImpl, "https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

export async function fetchAccountEmail(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = (await call(fetchImpl, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } })) as { email?: string };
  if (!body.email) throw new GoogleApiError("bad_request", 400, "Google did not share the account email");
  return body.email;
}

// ── Docs / Drive ─────────────────────────────────────────────────────────────
export function docsClient(accessToken: string, fetchImpl: typeof fetch = fetch): DocsClient {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const id = (documentId: string) => encodeURIComponent(documentId);
  return {
    async getFile(documentId) {
      const f = (await call(fetchImpl, `https://www.googleapis.com/drive/v3/files/${id(documentId)}?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,trashed,capabilities(canEdit)")}`, { headers: auth })) as {
        id: string;
        name: string;
        mimeType: string;
        trashed?: boolean;
        capabilities?: { canEdit?: boolean };
      };
      return { id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed === true, canEdit: f.capabilities?.canEdit === true };
    },
    async getDocument(documentId) {
      return (await call(fetchImpl, `https://docs.googleapis.com/v1/documents/${id(documentId)}`, { headers: auth })) as GoogleDocument;
    },
    async batchUpdate(documentId, requests, requiredRevisionId) {
      await call(fetchImpl, `https://docs.googleapis.com/v1/documents/${id(documentId)}:batchUpdate`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) }),
      });
    },
  };
}

export const isGoogleDocFile = (f: DriveFile): boolean => f.mimeType === DOC_MIME;
