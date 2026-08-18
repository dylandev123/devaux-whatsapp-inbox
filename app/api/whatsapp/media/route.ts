import { NextRequest, NextResponse } from "next/server";

// Proxies WhatsApp media through our own (HTTPS) origin. The bridge that
// writes whatsapp_messages.media_url serves it over plain HTTP from a raw IP
// with no TLS listener at all — loading that URL directly as an <img src>
// from this app (served over HTTPS) is blocked/failed by the browser's
// mixed-content policy, so the image never actually loads no matter what the
// frontend does. Fetching it server-side (no mixed-content restriction
// between servers) and streaming the bytes back over our own HTTPS origin is
// the standard fix for this.
//
// WHATSAPP_MEDIA_ORIGIN allow-lists exactly which origin this route will
// fetch from — required so this can't become an open SSRF proxy for
// whatever URL an authenticated caller passes in `?url=`. Only paths under
// /media/ on that origin are allowed, matching what the bridge actually
// serves; this route intentionally does not require the admin role (regular
// staff need to see inbox images), so it's scoped tighter than the
// admin-only bridge routes in lib/server/whatsappBridge.ts.
export async function GET(request: NextRequest) {
  const mediaOrigin = process.env.WHATSAPP_MEDIA_ORIGIN;
  if (!mediaOrigin) {
    return NextResponse.json({ error: "WhatsApp media proxy is not configured" }, { status: 500 });
  }

  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (target.origin !== mediaOrigin || !target.pathname.startsWith("/media/")) {
    return NextResponse.json({ error: "URL is not an allowed media URL" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString());
  } catch {
    return NextResponse.json({ error: "Could not reach the media host" }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Media host returned ${upstream.status}` },
      { status: upstream.status || 502 }
    );
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set("Cache-Control", "private, max-age=86400, immutable");

  return new NextResponse(upstream.body, { status: 200, headers });
}
