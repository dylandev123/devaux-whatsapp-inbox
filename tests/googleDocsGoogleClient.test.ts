// Google Docs sync: the OAuth request (minimum scopes, offline access, PKCE), token refresh / revocation handling and the
// Docs / Drive calls, against a scripted stand-in for fetch. No network; the real Google is never contacted.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classify, buildAuthUrl, docsClient, exchangeCode, fetchAccountEmail, GOOGLE_SCOPES, GoogleApiError, refreshAccessToken, REQUIRED_SCOPES, revokeToken } from "../lib/server/aiAgent/googleDocs/google.ts";

const cfg = { clientId: "client-id.apps.googleusercontent.com", clientSecret: "shh" };
type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

function stub(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? String(init.body) : null };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("Google OAuth and API calls", () => {
  test("the consent request asks for the minimum scopes, offline access and PKCE — and no secret", () => {
    const url = new URL(buildAuthUrl(cfg, "https://app.example/api/ai-agent/google-docs/callback", "STATE", "CHALLENGE", "me@example.com"));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
    assert.equal(url.searchParams.get("state"), "STATE");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(!url.toString().includes("shh"), "the client secret never appears in a browser URL");
    assert.deepEqual(url.searchParams.get("scope")!.split(" ").sort(), [...GOOGLE_SCOPES].sort());
    for (const s of GOOGLE_SCOPES) assert.ok(!/drive$|drive\.file|spreadsheets|gmail|calendar/.test(s) || s.endsWith("drive.metadata.readonly"), `no broad scope: ${s}`);
    assert.ok(REQUIRED_SCOPES.every((s) => (GOOGLE_SCOPES as readonly string[]).includes(s)));
  });

  test("code exchange sends the PKCE verifier and returns the granted scopes", async () => {
    const f = stub(() => ({ json: { access_token: "AT", refresh_token: "RT", scope: "openid email https://www.googleapis.com/auth/documents" } }));
    const t = await exchangeCode(cfg, "CODE", "https://app/cb", "VERIFIER", f.impl);
    assert.deepEqual(t, { accessToken: "AT", refreshToken: "RT", scopes: ["openid", "email", "https://www.googleapis.com/auth/documents"] });
    const body = new URLSearchParams(f.calls[0].body!);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code_verifier"), "VERIFIER");
    assert.equal(body.get("client_secret"), "shh");
  });

  test("a revoked or expired refresh token is reported as invalid_grant (so the app asks to reconnect)", async () => {
    const f = stub(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await assert.rejects(refreshAccessToken(cfg, "RT", f.impl), (e: unknown) => e instanceof GoogleApiError && e.kind === "invalid_grant");
    const ok = stub(() => ({ json: { access_token: "AT2" } }));
    assert.equal(await refreshAccessToken(cfg, "RT", ok.impl), "AT2");
    assert.equal(new URLSearchParams(ok.calls[0].body!).get("grant_type"), "refresh_token");
  });

  test("errors are classified: forbidden, not found, precondition (document changed), rate limit, server, network", async () => {
    const kinds: [number, unknown, string][] = [
      [403, { error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, "forbidden"],
      [404, { error: { message: "Requested entity was not found." } }, "not_found"],
      [400, { error: { message: "revision mismatch", status: "FAILED_PRECONDITION" } }, "precondition"],
      [429, { error: { message: "slow down" } }, "rate_limited"],
      [403, { error: { message: "Rate Limit Exceeded" } }, "rate_limited"],
      [503, { error: { message: "backend" } }, "server"],
      [401, { error: { message: "Invalid Credentials" } }, "invalid_grant"],
    ];
    for (const [status, json, kind] of kinds) {
      const c = docsClient("AT", stub(() => ({ status, json })).impl);
      await assert.rejects(c.getDocument("doc"), (e: unknown) => e instanceof GoogleApiError && e.kind === kind, `${status} → ${kind}`);
    }
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await assert.rejects(docsClient("AT", down).getDocument("doc"), (e: unknown) => e instanceof GoogleApiError && e.kind === "network");
  });

  test("document calls: bearer token, id escaped, revision guard sent, edit capability read from Drive", async () => {
    const f = stub((c) => {
      if (c.url.includes("/drive/v3/files/")) return { json: { id: "d", name: "Orders", mimeType: "application/vnd.google-apps.document", capabilities: { canEdit: true } } };
      if (c.url.endsWith(":batchUpdate")) return { json: {} };
      return { json: { documentId: "d", title: "Orders", revisionId: "r1", body: { content: [] } } };
    });
    const c = docsClient("AT", f.impl);
    assert.deepEqual(await c.getFile("d/../x"), { id: "d", name: "Orders", mimeType: "application/vnd.google-apps.document", trashed: false, canEdit: true });
    assert.equal((await c.getDocument("d")).revisionId, "r1");
    await c.batchUpdate("d", [{ insertText: { location: { index: 1 }, text: "x" } }], "r1");
    await c.batchUpdate("d", [], undefined);
    assert.ok(f.calls.every((x) => x.headers.Authorization === "Bearer AT"));
    assert.ok(f.calls[0].url.includes("d%2F..%2Fx") && f.calls[0].url.includes("supportsAllDrives=true"));
    assert.deepEqual(JSON.parse(f.calls[2].body!).writeControl, { requiredRevisionId: "r1" });
    assert.equal(JSON.parse(f.calls[3].body!).writeControl, undefined);
    assert.ok(f.calls[2].url.startsWith("https://docs.googleapis.com/v1/documents/d:batchUpdate"));
  });

  test("account email and revocation", async () => {
    assert.equal(await fetchAccountEmail("AT", stub(() => ({ json: { email: "staff@example.com" } })).impl), "staff@example.com");
    await assert.rejects(fetchAccountEmail("AT", stub(() => ({ json: {} })).impl));
    const f = stub(() => ({ json: {} }));
    await revokeToken("RT", f.impl);
    assert.equal(f.calls[0].url, "https://oauth2.googleapis.com/revoke");
    assert.equal(new URLSearchParams(f.calls[0].body!).get("token"), "RT");
  });
});

describe("403 causes are told apart (permission, scope, disabled API)", () => {
  const k = (status: number, error: unknown) => classify(status, { error }).kind;
  test("genuine file permission denial stays forbidden", () => {
    assert.equal(k(403, { message: "The caller does not have permission", status: "PERMISSION_DENIED" }), "forbidden");
    assert.equal(k(403, { message: "The user does not have sufficient permissions for this file.", errors: [{ reason: "insufficientFilePermissions" }] }), "forbidden");
  });
  test("an insufficient OAuth scope is its own kind", () => {
    assert.equal(k(403, { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }), "insufficient_scope");
    assert.equal(k(403, { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] }), "insufficient_scope");
  });
  test("a disabled Google API is not reported as a permission problem", () => {
    assert.equal(k(403, { message: "Google Drive API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] }), "api_disabled");
    assert.equal(k(403, { message: "Drive API disabled", errors: [{ reason: "accessNotConfigured" }] }), "api_disabled");
  });
  test("rate limits by reason, and 404 / 5xx unchanged", () => {
    assert.equal(k(403, { message: "x", errors: [{ reason: "userRateLimitExceeded" }] }), "rate_limited");
    assert.equal(k(404, { message: "File not found" }), "not_found");
    assert.equal(k(500, { message: "x" }), "server");
  });
});

describe("Google call timeouts and network failures", () => {
  const timeoutErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  test("a timeout is its own error kind, names the operation and is not retried", async () => {
    let n = 0;
    const impl = (async () => { n++; throw timeoutErr(); }) as unknown as typeof fetch;
    const err = await refreshAccessToken(cfg, "RT", impl).catch((e) => e);
    assert.ok(err instanceof GoogleApiError);
    assert.equal(err.kind, "timeout");
    assert.equal(err.op, "token refresh");
    assert.equal(n, 1);
    assert.ok(!err.message.includes("RT") && !err.message.includes("shh"));
  });

  test("Drive and Docs timeouts are told apart", async () => {
    const impl = (async () => { throw timeoutErr(); }) as unknown as typeof fetch;
    const c = docsClient("AT", impl);
    assert.equal(((await c.getFile("doc1").catch((e) => e)) as GoogleApiError).op, "Drive metadata");
    assert.equal(((await c.getDocument("doc1").catch((e) => e)) as GoogleApiError).op, "Docs read");
  });

  test("a fast connection failure on a read is retried once; a write never is", async () => {
    let n = 0;
    const flaky = (async () => { n++; if (n === 1) throw new TypeError("fetch failed"); return new Response(JSON.stringify({ access_token: "AT" }), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await refreshAccessToken(cfg, "RT", flaky), "AT");
    assert.equal(n, 2);
    let w = 0;
    const down = (async () => { w++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const err = await docsClient("AT", down).batchUpdate("doc1", []).catch((e) => e);
    assert.equal(err.kind, "network");
    assert.equal(w, 1);
  });

});
