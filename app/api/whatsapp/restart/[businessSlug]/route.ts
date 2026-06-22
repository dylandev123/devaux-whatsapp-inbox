import { NextResponse } from "next/server";
import { callBridge, restartPath } from "@/lib/server/whatsappBridge";

// Mutating — restarts a live WhatsApp session on the bridge. Only ever
// called from the admin page's explicit "Restart" button (with a
// confirmation prompt), never automatically.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ businessSlug: string }> }
) {
  const { businessSlug } = await params;
  const result = await callBridge(restartPath(businessSlug), { method: "POST" });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data ?? { ok: true });
}
