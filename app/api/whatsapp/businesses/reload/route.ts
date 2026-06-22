import { NextResponse } from "next/server";
import { callBridge, reloadBusinessesPath } from "@/lib/server/whatsappBridge";

// Mutating — asks the bridge to re-read its business list from Supabase.
// Backend support for this is not confirmed to exist yet; see
// lib/server/whatsappBridge.ts.
export async function POST() {
  const result = await callBridge(reloadBusinessesPath(), { method: "POST" });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data ?? { ok: true });
}
