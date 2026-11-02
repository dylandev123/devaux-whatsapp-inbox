// Google Docs sync: the OAuth request (minimum scopes, offline access, PKCE), token refresh / revocation handling and the
// Docs / Drive calls, against a scripted stand-in for fetch. No network; the real Google is never contacted.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthUrl, docsClient, exchangeCode, fetchAccountEmail, GOOGLE_SCOPES, GoogleApiError, refreshAccessToken, REQUIRED_SCOPES, revokeToken } from "../lib/server/aiAgent/googleDocs/google.ts";

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
