// Server-only auth for the AI agent routes.
//
// requireAdmin(): defense in depth on top of middleware.ts (which already
// gates /api/ai-agent/* to admins) and the source of the actor id written to
// the audit log.
//
// verifyBridgeSecret(): the bridge routes (/api/bridge/ai-agent/*) are called
// server-to-server by WhatsappOperation, never by a browser, so they sit
// outside the middleware matcher and authenticate with a dedicated shared
// secret instead. Unset secret = routes disabled (503), never open.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

export async function requireAdmin(): Promise<{ userId: string } | NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // Route handlers only read the session here; middleware.ts refreshes it.
        setAll() {},
      },
    }
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return { userId: user.id };
}

export const BRIDGE_SECRET_HEADER = "x-ai-agent-secret";

export function verifyBridgeSecret(request: Request): NextResponse | null {
  const expected = process.env.AI_AGENT_BRIDGE_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "AI agent bridge is not configured" }, { status: 503 });
  }
  const provided = request.headers.get(BRIDGE_SECRET_HEADER) ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Scheduler endpoints (due-batch processing). Accepts the bridge secret
 * (x-ai-agent-secret) or, for Vercel Cron, `Authorization: Bearer $CRON_SECRET`.
 * With neither secret configured the endpoint is disabled (503), never open.
 */
export function verifySchedulerSecret(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const bearer = request.headers.get("authorization") ?? "";
  if (cronSecret && bearer.startsWith("Bearer ")) {
    const a = Buffer.from(bearer.slice(7));
    const b = Buffer.from(cronSecret);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  if (!process.env.AI_AGENT_BRIDGE_SECRET && !cronSecret) {
    return NextResponse.json({ error: "Scheduler is not configured" }, { status: 503 });
  }
  if (process.env.AI_AGENT_BRIDGE_SECRET && request.headers.has(BRIDGE_SECRET_HEADER)) return verifyBridgeSecret(request);
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
