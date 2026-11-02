// Server-only: the few Google REST calls the order sync needs, over plain fetch (no SDK). Everything the sync does to a
// document goes through DocsClient, so tests substitute an in-memory document and the real Google is never touched.
//
// The documents involved can be hundreds of pages, so the normal path NEVER downloads a document:
//   access test   Drive files.get (id, name, mimeType, trashed, capabilities.canEdit) + a Docs API availability probe that
//                 asks for a document id that cannot exist (Google answers "not found" when the API is on, "disabled" when it
//                 is off, "insufficient scope" when the token lacks it) — no document body is involved
//   insert        documents.batchUpdate insertText at index 1 of the first tab — no read, no revision guard needed
//   recovery      documents.get with a field mask for text only, and only to settle an insert whose outcome is unknown
//
// Scopes (the minimum that works for an EXISTING document the admin did not create with this app):
//   documents                    insert text into the document
//   drive.metadata.readonly      read the document's title and whether the account may edit it (capabilities.canEdit);
//                                no file content is read through Drive
//   openid email                 show which Google account is connected
// No timers are used: every request is bounded by AbortSignal.timeout.

import { tagsPresent, type DocRequest, type TextRunDocument } from "../../../aiAgent/gdocInsert.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;
export const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.metadata.readonly"] as const;

export type GoogleErrorKind = "invalid_grant" | "forbidden" | "insufficient_scope" | "api_disabled" | "not_found" | "precondition" | "rate_limited" | "server" | "network" | "timeout" | "bad_request";

export class GoogleApiError extends Error {
  kind: GoogleErrorKind;
  status: number;
  /** Google's machine-readable reason(s), e.g. "SERVICE_DISABLED" — for logs and diagnosis. Never contains credentials. */
  reasons: string[];
  /** Which Google call failed ("token refresh", "Drive metadata", "Docs write", ...). */
  op?: string;
  constructor(kind: GoogleErrorKind, status: number, message: string, reasons: string[] = [], op?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.reasons = reasons;
    this.op = op;
  }
  /**
   * True when a WRITE that failed this way may nevertheless have been applied by Google (the answer was lost, or Google failed
   * after starting). Every other failure is an explicit refusal, so the document is known to be unchanged.
   */
  get outcomeUnknown(): boolean {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server";
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
  /** Drive metadata only (title, type, trashed, edit permission). Never the document body. */
  getFile(documentId: string): Promise<DriveFile>;
  /** Resolves when the Docs API answers normally for this account; throws api_disabled / insufficient_scope / invalid_grant / timeout / ... */
  probeDocsApi(): Promise<void>;
  /** One atomic batchUpdate on the document. Used only to insert at the start of the first tab; never reads the document. */
  batchUpdate(documentId: string, requests: DocRequest[], timeoutMs?: number): Promise<void>;
  /** Which of these order tags are in the first tab's text. A text-only, bounded read, used only to settle an unknown insert outcome. */
  findTags(documentId: string, refCodes: string[], timeoutMs?: number): Promise<Set<string>>;
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

// Per attempt. Worst case for the access test is the token refresh plus the (parallel) Drive and Docs probe, i.e. 2 x
// TIMEOUT_MS, well inside the 60 s function limit (maxDuration on the google-docs route).
export const TIMEOUT_MS = 20_000;
// An insert of one paragraph is quick even in a very large document; a longer wait only delays a retry.
export const WRITE_TIMEOUT_MS = 25_000;
// The recovery read downloads the first tab's text (megabytes for hundreds of pages), so it gets longer — and only runs from
// the background sync, never from a dashboard click.
export const VERIFY_TIMEOUT_MS = 40_000;
// A document id Google cannot have issued: used to learn whether the Docs API is reachable without touching any real document.
const PROBE_DOCUMENT_ID = "devaux-docs-api-availability-check";
const DOC_MIME = "application/vnd.google-apps.document";

// Google reports the cause of a 403 in several places: error.errors[].reason (Drive v3), error.details[].reason (ErrorInfo,
// e.g. SERVICE_DISABLED / ACCESS_TOKEN_SCOPE_INSUFFICIENT) and error.status. A 403 is NOT always "no permission on the file".
function errorReasons(err: unknown): string[] {
  const e = err as { status?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } | null;
  if (!e || typeof e !== "object") return [];
  const out = [e.status, ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : []), ...(Array.isArray(e.details) ? e.details.map((x) => x?.reason) : [])];
  return out.filter((r): r is string => typeof r === "string" && r !== "");
}

export function classify(status: number, body: unknown): GoogleApiError {
  const err = (body as { error?: unknown } | null)?.error;
  const message =
    typeof err === "string" ? err : typeof (err as { message?: unknown } | undefined)?.message === "string" ? ((err as { message: string }).message) : `Google returned ${status}`;
  const reasons = errorReasons(err);
  const has = (re: RegExp) => reasons.some((r) => re.test(r));
  const make = (kind: GoogleErrorKind) => new GoogleApiError(kind, status, message, reasons);
  if (status === 400 && has(/FAILED_PRECONDITION/i)) return make("precondition");
  if (status === 400 && err === "invalid_grant") return new GoogleApiError("invalid_grant", status, "Google access was revoked or expired", reasons);
  if (status === 401) return make("invalid_grant");
  if (status === 403) {
    if (has(/^(SERVICE_DISABLED|accessNotConfigured)$/)) return make("api_disabled");
    if (has(/^ACCESS_TOKEN_SCOPE_INSUFFICIENT$/) || /insufficient authentication scopes/i.test(message)) return make("insufficient_scope");
    if (has(/^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED)$/) || /rate limit|quota/i.test(message)) return make("rate_limited");
    return make("forbidden");
  }
  if (status === 404) return make("not_found");
  if (status === 429) return make("rate_limited");
  if (status >= 500) return make("server");
  return make("bad_request");
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** One bounded request. Logs only the operation label, host, status and duration — never a URL path (document id), token or body. */
async function call(fetchImpl: typeof fetch, url: string, init: RequestInit, op = "request", timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const host = new URL(url).host;
  // Only idempotent reads are retried, and only after a FAST connection failure; a timeout is never retried (it would
  // double the wait and could exceed the function limit).
  const retriable = (init.method ?? "GET") === "GET" || op === "token refresh";
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    } catch (err) {
      const ms = Date.now() - started;
      if (isTimeout(err)) {
        console.error("[google-docs call]", `op=${op} host=${host} outcome=timeout after_ms=${ms} limit_ms=${timeoutMs} attempt=${attempt}`);
        throw new GoogleApiError("timeout", 0, `Google did not answer the ${op} request within ${Math.round(timeoutMs / 1000)} seconds`, [], op);
      }
      console.error("[google-docs call]", `op=${op} host=${host} outcome=network after_ms=${ms} attempt=${attempt}`);
      if (retriable && attempt < 2) continue;
      throw new GoogleApiError("network", 0, err instanceof Error ? err.message : "Could not reach Google", [], op);
    }
    const body = await res.json().catch(() => null);
    console.info("[google-docs call]", `op=${op} host=${host} status=${res.status} ms=${Date.now() - started}`);
    if (!res.ok) {
      const err = classify(res.status, body);
      err.op = op;
      throw err;
    }
    return body;
  }
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
  }, "code exchange")) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!body.access_token) throw new GoogleApiError("bad_request", 400, "Google did not return an access token");
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, scopes: (body.scope ?? "").split(/\s+/).filter(Boolean) };
}

export async function refreshAccessToken(cfg: GoogleOAuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = (await call(fetchImpl, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody(cfg, { refresh_token: refreshToken, grant_type: "refresh_token" }),
  }, "token refresh")) as { access_token?: string };
  if (!body.access_token) throw new GoogleApiError("invalid_grant", 400, "Google did not return an access token");
  return body.access_token;
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await call(fetchImpl, "https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }, "token revoke");
}

export async function fetchAccountEmail(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = (await call(fetchImpl, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } }, "account lookup")) as { email?: string };
  if (!body.email) throw new GoogleApiError("bad_request", 400, "Google did not share the account email");
  return body.email;
}

// ── Docs / Drive ─────────────────────────────────────────────────────────────
export function docsClient(accessToken: string, fetchImpl: typeof fetch = fetch): DocsClient {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const id = (documentId: string) => encodeURIComponent(documentId);
  return {
    async getFile(documentId) {
      const f = (await call(fetchImpl, `https://www.googleapis.com/drive/v3/files/${id(documentId)}?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,trashed,capabilities(canEdit)")}`, { headers: auth }, "Drive metadata")) as {
        id: string;
        name: string;
        mimeType: string;
        trashed?: boolean;
        capabilities?: { canEdit?: boolean };
      };
      return { id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed === true, canEdit: f.capabilities?.canEdit === true };
    },
    async probeDocsApi() {
      try {
        await call(fetchImpl, `https://docs.googleapis.com/v1/documents/${id(PROBE_DOCUMENT_ID)}?fields=documentId`, { headers: auth }, "Docs API check");
      } catch (err) {
        // "Not found" (or a refusal for a document that does not exist) is the healthy answer: the API is on and the token works.
        if (err instanceof GoogleApiError && (err.kind === "not_found" || err.kind === "forbidden" || err.kind === "bad_request")) return;
        throw err;
      }
    },
    async batchUpdate(documentId, requests, timeoutMs = WRITE_TIMEOUT_MS) {
      await call(fetchImpl, `https://docs.googleapis.com/v1/documents/${id(documentId)}:batchUpdate`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }, "Docs write", timeoutMs);
    },
    async findTags(documentId, refCodes, timeoutMs = VERIFY_TIMEOUT_MS) {
      // No includeTabsContent: the response's top-level `body` is the first tab, the only tab the app writes to.
      const fields = encodeURIComponent("body(content(paragraph(elements(textRun(content)))))");
      const doc = (await call(fetchImpl, `https://docs.googleapis.com/v1/documents/${id(documentId)}?fields=${fields}`, { headers: auth }, "Docs verify", timeoutMs)) as TextRunDocument;
      return tagsPresent(doc, refCodes);
    },
  };
}

export const isGoogleDocFile = (f: DriveFile): boolean => f.mimeType === DOC_MIME;
