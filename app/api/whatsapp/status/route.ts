import { NextResponse } from "next/server";
import { callBridge, statusPath } from "@/lib/server/whatsappBridge";

export async function GET() {
  const result = await callBridge(statusPath());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data);
}
