// Server-only: shared by the connect and callback routes (a Next route file may only export handlers and route config).
export const OAUTH_COOKIE = "gdocs_oauth";

export const redirectUriFor = (request: Request): string =>
  process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || new URL("/api/ai-agent/google-docs/callback", request.url).toString();
