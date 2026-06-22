// Server-only helper for talking to the WhatsApp bridge backend
// (WHATSAPP_API_URL). Never import this from a client component — it reads
// WHATSAPP_ADMIN_SECRET, which must never reach the browser.

// Confirmed against the live backend: GET /api/status returns
// { sessions: [{ businessSlug, status, hasQr }] }.
const STATUS_PATH = process.env.WHATSAPP_STATUS_PATH ?? "/api/status";

// NOT YET IMPLEMENTED on the backend (it currently only knows the static
// BUSINESSES env var). These are the paths specified for the "dynamic
// business management" backend work — wired up here so the frontend needs no
// further changes once that ships. Override via env without a code change if
// the real backend ends up using different paths.
const QR_PATH_TEMPLATE = process.env.WHATSAPP_QR_PATH_TEMPLATE ?? "/api/session/{slug}/qr";
const RESTART_PATH_TEMPLATE =
  process.env.WHATSAPP_RESTART_PATH_TEMPLATE ?? "/api/session/{slug}/restart";
const START_PATH_TEMPLATE = process.env.WHATSAPP_START_PATH_TEMPLATE ?? "/api/session/{slug}/start";
const RELOAD_BUSINESSES_PATH =
  process.env.WHATSAPP_RELOAD_BUSINESSES_PATH ?? "/api/businesses/reload";

export interface BridgeResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export function qrPath(businessSlug: string): string {
  return QR_PATH_TEMPLATE.replace("{slug}", encodeURIComponent(businessSlug));
}

export function restartPath(businessSlug: string): string {
  return RESTART_PATH_TEMPLATE.replace("{slug}", encodeURIComponent(businessSlug));
}

export function startPath(businessSlug: string): string {
  return START_PATH_TEMPLATE.replace("{slug}", encodeURIComponent(businessSlug));
}

export function reloadBusinessesPath(): string {
  return RELOAD_BUSINESSES_PATH;
}

export function statusPath(): string {
  return STATUS_PATH;
}

export async function callBridge<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<BridgeResult<T>> {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const adminSecret = process.env.WHATSAPP_ADMIN_SECRET;

  if (!apiUrl || !adminSecret) {
    return { ok: false, status: 500, data: null, error: "WhatsApp API is not configured" };
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "x-admin-secret": adminSecret,
      },
    });
  } catch {
    return { ok: false, status: 502, data: null, error: "Could not reach the WhatsApp backend" };
  }

  const data = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      data: null,
      error:
        (data && typeof data === "object" && "error" in data && String(data.error)) ||
        `WhatsApp backend returned ${upstream.status} for ${path}`,
    };
  }

  return { ok: true, status: upstream.status, data: data as T, error: null };
}
