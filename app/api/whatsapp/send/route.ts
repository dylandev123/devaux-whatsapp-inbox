import { NextResponse } from "next/server";

interface SendPayload {
  businessSlug?: string;
  to?: string;
  body?: string;
}

export async function POST(request: Request) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const adminSecret = process.env.WHATSAPP_ADMIN_SECRET;

  if (!apiUrl || !adminSecret) {
    return NextResponse.json(
      { error: "WhatsApp API is not configured" },
      { status: 500 }
    );
  }

  let payload: SendPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { businessSlug, to, body } = payload;

  if (!businessSlug || !to || !body) {
    return NextResponse.json(
      { error: "businessSlug, to, and body are required" },
      { status: 400 }
    );
  }

  const upstream = await fetch(`${apiUrl}/api/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": adminSecret,
    },
    body: JSON.stringify({ businessSlug, to, body }),
  });

  const data = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    return NextResponse.json(
      { error: data?.error ?? "Failed to send message" },
      { status: upstream.status }
    );
  }

  return NextResponse.json(data ?? { ok: true });
}
