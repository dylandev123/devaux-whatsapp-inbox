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
      await assert.rejects(c.batchUpdate("doc", []), (e: unknown) => e instanceof GoogleApiError && e.kind === kind, `${status} → ${kind}`);
    }
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await assert.rejects(docsClient("AT", down).findTags("doc", ["E-AAAAA"]), (e: unknown) => e instanceof GoogleApiError && e.kind === "network");
  });

  test("document calls: bearer token, id escaped, edit capability read from Drive metadata only, no revision guard on writes", async () => {
    const f = stub((c) => {
      if (c.url.includes("/drive/v3/files/")) return { json: { id: "d", name: "Orders", mimeType: "application/vnd.google-apps.document", capabilities: { canEdit: true } } };
      if (c.url.endsWith(":batchUpdate")) return { json: {} };
      return { json: {} };
    });
    const c = docsClient("AT", f.impl);
    assert.deepEqual(await c.getFile("d/../x"), { id: "d", name: "Orders", mimeType: "application/vnd.google-apps.document", trashed: false, canEdit: true });
    await c.batchUpdate("d", [{ insertText: { location: { index: 1 }, text: "x\n" } }]);
    assert.ok(f.calls.every((x) => x.headers.Authorization === "Bearer AT"));
    assert.ok(f.calls[0].url.includes("d%2F..%2Fx") && f.calls[0].url.includes("supportsAllDrives=true"));
    const fields = new URL(f.calls[0].url).searchParams.get("fields")!;
    assert.equal(fields, "id,name,mimeType,trashed,capabilities(canEdit)", "metadata only: no content, no export");
    assert.ok(f.calls[1].url.startsWith("https://docs.googleapis.com/v1/documents/d:batchUpdate"));
    assert.deepEqual(Object.keys(JSON.parse(f.calls[1].body!)), ["requests"], "no writeControl: an insert at index 1 does not depend on the document's revision");
  });

  test("the access test never downloads a document: the Docs API probe asks for an id that cannot exist and only needs a 'not found' answer", async () => {
    const f = stub(() => ({ status: 404, json: { error: { message: "Requested entity was not found.", status: "NOT_FOUND" } } }));
    await docsClient("AT", f.impl).probeDocsApi();
    assert.equal(f.calls.length, 1);
    const url = new URL(f.calls[0].url);
    assert.equal(url.host, "docs.googleapis.com");
    assert.match(url.pathname, /^\/v1\/documents\/devaux-docs-api-availability-check$/);
    assert.equal(url.searchParams.get("fields"), "documentId");
    assert.equal(f.calls[0].method, "GET");
  });

  test("the Docs API probe separates 'API off', 'missing permission scope', 'revoked' and 'Google down' from a healthy answer", async () => {
    const outcome = async (status: number, error: unknown) => (await docsClient("AT", stub(() => ({ status, json: { error } })).impl).probeDocsApi().then(() => "available", (e: GoogleApiError) => e.kind));
    assert.equal(await outcome(404, { message: "Requested entity was not found." }), "available");
    assert.equal(await outcome(403, { message: "The caller does not have permission", status: "PERMISSION_DENIED" }), "available");
    assert.equal(await outcome(400, { message: "Invalid document id" }), "available");
    assert.equal(await outcome(403, { message: "Google Docs API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] }), "api_disabled");
    assert.equal(await outcome(403, { message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }), "insufficient_scope");
    assert.equal(await outcome(401, { message: "Invalid Credentials" }), "invalid_grant");
    assert.equal(await outcome(503, { message: "backend" }), "server");
    assert.equal(await outcome(429, { message: "slow down" }), "rate_limited");
  });

  test("recovery reads text only: a field mask, the first tab (no includeTabsContent), and finds the asked tags", async () => {
    const f = stub(() => ({ json: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "Jane — x ⟨E-AAAAA⟩\n" } }] } }, { paragraph: { elements: [{ textRun: { content: "other\n" } }] } }] } } }));
    const found = await docsClient("AT", f.impl).findTags("doc1", ["E-AAAAA", "E-BBBBB"]);
    assert.deepEqual([...found], ["E-AAAAA"]);
    const url = new URL(f.calls[0].url);
    assert.equal(url.searchParams.get("fields"), "body(content(paragraph(elements(textRun(content)))))");
    assert.equal(url.searchParams.has("includeTabsContent"), false);
  });

  test("a lost write answer is flagged as outcome-unknown; a refusal is not", async () => {
    const kinds: [number, boolean][] = [[500, true], [503, true], [400, false], [403, false], [404, false], [429, false]];
    for (const [status, unknown] of kinds) {
      const err = await docsClient("AT", stub(() => ({ status, json: { error: { message: "x" } } })).impl).batchUpdate("d", []).catch((e) => e);
      assert.equal(err.outcomeUnknown, unknown, `${status}`);
      assert.equal(err.op, "Docs write");
    }
    const timeout = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    assert.equal(((await docsClient("AT", timeout).batchUpdate("d", []).catch((e) => e)) as GoogleApiError).outcomeUnknown, true);
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
    assert.equal(((await c.probeDocsApi().catch((e) => e)) as GoogleApiError).op, "Docs API check");
    assert.equal(((await c.batchUpdate("doc1", []).catch((e) => e)) as GoogleApiError).op, "Docs write");
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
