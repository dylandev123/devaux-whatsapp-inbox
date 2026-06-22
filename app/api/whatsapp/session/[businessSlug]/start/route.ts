import { NextResponse } from "next/server";
import { callBridge, startPath } from "@/lib/server/whatsappBridge";

// Mutating — asks the bridge to start a session for a business it doesn't
// yet have running (e.g. right after it's added in the admin page). Backend
// support for this is not confirmed to exist yet; see lib/server/whatsappBridge.ts.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ businessSlug: string }> }
) {
  const { businessSlug } = await params;
  const result = await callBridge(startPath(businessSlug), { method: "POST" });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data ?? { ok: true });
}
