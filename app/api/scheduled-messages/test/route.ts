import { NextResponse } from "next/server";
import { normalizeBusinessSlug } from "@/lib/businessSlug";

// Admin-only (see middleware.ts). Proxies a single-recipient test to the
// bridge's POST /api/scheduled-messages/test, which uses the same send path as
// scheduled deliveries. Bridge status is passed through: 200 sent, 409 failed
// before sending, 502 unknown outcome, 400 invalid input.
interface TestPayload {
  businessSlug?: string;
  to?: string;
  body?: string;
  scheduleId?: string;
}

export async function POST(request: Request) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const adminSecret = process.env.WHATSAPP_ADMIN_SECRET;

  if (!apiUrl || !adminSecret) {
    return NextResponse.json({ error: "WhatsApp API is not configured" }, { status: 500 });
  }

  let payload: TestPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { businessSlug, to, body, scheduleId } = payload;
  if (!businessSlug || !to || !body) {
    return NextResponse.json({ error: "businessSlug, to, and body are required" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl}/api/scheduled-messages/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": adminSecret },
      body: JSON.stringify({
        businessSlug: normalizeBusinessSlug(businessSlug),
        to,
        body,
        ...(scheduleId ? { scheduleId } : {}),
      }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the WhatsApp backend" }, { status: 503 });
  }

  const data = await upstream.json().catch(() => null);
  return NextResponse.json(data ?? { error: `WhatsApp backend returned ${upstream.status}` }, {
    status: upstream.status,
  });
}
