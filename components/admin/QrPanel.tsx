"use client";

import { businessColor, businessLabel } from "@/lib/whatsapp";

interface QrPanelProps {
  businessSlug: string;
  connected: boolean;
  qrSrc: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

export function QrPanel({ businessSlug, connected, qrSrc, loading, error, onClose }: QrPanelProps) {
  const color = businessColor(businessSlug);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">
            {businessLabel(businessSlug)} — Link device
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-900"
          >
            Close
          </button>
        </div>

        {connected && (
          <p className={`rounded-md px-3 py-2 text-sm ${color.bg} ${color.text}`}>
            ✅ Connected — this session is now linked.
          </p>
        )}

        {!connected && (
          <>
            <div className="flex aspect-square w-full items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              {loading && !qrSrc && <p className="text-sm text-zinc-500">Loading QR…</p>}
              {error && <p className="px-4 text-center text-sm text-red-600">{error}</p>}
              {!error && qrSrc && (
                // eslint-disable-next-line @next/next/no-img-element -- remote bridge-provided image/data URL
                <img src={qrSrc} alt="WhatsApp link QR code" className="h-full w-full object-contain p-2" />
              )}
              {!error && !loading && !qrSrc && (
                <p className="px-4 text-center text-sm text-zinc-500">No QR available right now.</p>
              )}
            </div>
            <p className="mt-3 text-center text-xs text-zinc-500">
              Open WhatsApp on the business phone → Linked Devices → Link a Device → Scan this QR
            </p>
          </>
        )}
      </div>
    </div>
  );
}
