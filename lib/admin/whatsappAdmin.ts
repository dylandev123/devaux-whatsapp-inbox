// Client-side wrappers around our own /api/whatsapp/* proxy routes. These
// never talk to WHATSAPP_API_URL directly and never see WHATSAPP_ADMIN_SECRET
// — that stays server-side in lib/server/whatsappBridge.ts.

export interface BridgeSession {
  businessSlug: string;
  status: string;
  hasQr: boolean;
}

export async function fetchBridgeStatus(): Promise<BridgeSession[]> {
  const res = await fetch("/api/whatsapp/status", { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to load WhatsApp status (${res.status})`);
  }
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function fetchQr(businessSlug: string): Promise<unknown> {
  const res = await fetch(`/api/whatsapp/qr/${encodeURIComponent(businessSlug)}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to load QR code (${res.status})`);
  }
  return data;
}

export async function restartSession(businessSlug: string): Promise<void> {
  const res = await fetch(`/api/whatsapp/restart/${encodeURIComponent(businessSlug)}`, {
    method: "POST",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to restart session (${res.status})`);
  }
}

// Not confirmed to exist on the backend yet — see lib/server/whatsappBridge.ts.
export async function reloadBusinesses(): Promise<void> {
  const res = await fetch("/api/whatsapp/businesses/reload", { method: "POST" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to reload businesses (${res.status})`);
  }
}

// Not confirmed to exist on the backend yet — see lib/server/whatsappBridge.ts.
export async function startSession(businessSlug: string): Promise<void> {
  const res = await fetch(`/api/whatsapp/session/${encodeURIComponent(businessSlug)}/start`, {
    method: "POST",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to start session (${res.status})`);
  }
}

// The real QR response shape isn't confirmed yet (see lib/server/whatsappBridge.ts),
// so this tries the field names/formats most bridges use rather than assuming one.
export function extractQrImageSrc(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = ["qr", "qrCode", "qrImage", "image", "dataUrl", "base64"];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.startsWith("data:image")) return value;
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    if (/^[A-Za-z0-9+/=]+$/.test(value.slice(0, 32))) {
      return `data:image/png;base64,${value}`;
    }
  }
  return null;
}
