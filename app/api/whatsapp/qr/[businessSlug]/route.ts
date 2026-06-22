import { NextResponse } from "next/server";
import { callBridge, qrPath } from "@/lib/server/whatsappBridge";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ businessSlug: string }> }
) {
  const { businessSlug } = await params;
  const result = await callBridge(qrPath(businessSlug));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.data);
}
