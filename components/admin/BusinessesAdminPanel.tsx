"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { businessColor, businessLabel, isSessionConnected, WhatsappSession } from "@/lib/whatsapp";
import {
  BridgeSession,
  extractQrImageSrc,
  fetchBridgeStatus,
  fetchQr,
  restartSession,
} from "@/lib/admin/whatsappAdmin";
import { QrPanel } from "./QrPanel";

const POLL_INTERVAL_MS = 5000;
const QR_POLL_INTERVAL_MS = 4000;

interface BusinessRow {
  businessSlug: string;
  label: string;
  status: string;
  hasQr: boolean;
  lastConnectedAt: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status: string) {
  const normalized = status.toLowerCase();
  if (isSessionConnected(normalized)) {
    return { label: "Connected", className: "bg-emerald-50 text-emerald-700" };
  }
  if (normalized === "qr") {
    return { label: "Awaiting scan", className: "bg-amber-50 text-amber-700" };
  }
  return { label: status || "Unknown", className: "bg-zinc-100 text-zinc-600" };
}

export function BusinessesAdminPanel() {
  const [bridgeSessions, setBridgeSessions] = useState<BridgeSession[]>([]);
  const [supabaseSessions, setSupabaseSessions] = useState<WhatsappSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qrTarget, setQrTarget] = useState<string | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  const [restartingSlug, setRestartingSlug] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const sessions = await fetchBridgeStatus();
      setBridgeSessions(sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load WhatsApp status");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSupabaseSessions = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("whatsapp_sessions")
      .select("business_slug, status, updated_at, last_connected_at");
    if (!fetchError) setSupabaseSessions(data ?? []);
  }, []);

  useEffect(() => {
    loadStatus();
    loadSupabaseSessions();
    const interval = setInterval(() => {
      loadStatus();
      loadSupabaseSessions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadStatus, loadSupabaseSessions]);

  const rows: BusinessRow[] = useMemo(() => {
    const supabaseBySlug = new Map(supabaseSessions.map((s) => [s.business_slug, s]));
    return bridgeSessions
      .map((session) => ({
        businessSlug: session.businessSlug,
        label: businessLabel(session.businessSlug),
        status: session.status,
        hasQr: session.hasQr,
        lastConnectedAt: supabaseBySlug.get(session.businessSlug)?.last_connected_at ?? null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [bridgeSessions, supabaseSessions]);

  const qrTargetRow = rows.find((r) => r.businessSlug === qrTarget) ?? null;
  const qrTargetConnected = qrTargetRow ? isSessionConnected(qrTargetRow.status) : false;

  const loadQr = useCallback(async (slug: string) => {
    setQrLoading(true);
    setQrError(null);
    try {
      const data = await fetchQr(slug);
      const src = extractQrImageSrc(data);
      setQrSrc(src);
      if (!src) {
        setQrError("Backend responded but no QR image was found in the response shape.");
      }
    } catch (err) {
      setQrError(err instanceof Error ? err.message : "Failed to load QR code");
    } finally {
      setQrLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!qrTarget || qrTargetConnected) return;
    loadQr(qrTarget);
    const interval = setInterval(() => loadQr(qrTarget), QR_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [qrTarget, qrTargetConnected, loadQr]);

  function handleOpenQr(slug: string) {
    setQrTarget(slug);
    setQrSrc(null);
    setQrError(null);
  }

  function handleCloseQr() {
    setQrTarget(null);
    setQrSrc(null);
    setQrError(null);
  }

  async function handleRestart(slug: string, label: string) {
    const confirmed = window.confirm(
      `Restart the WhatsApp session for ${label}?\n\nThis will interrupt the current connection if it's connected, and may require scanning a new QR code.`
    );
    if (!confirmed) return;
    setRestartingSlug(slug);
    setRestartError(null);
    try {
      await restartSession(slug);
      await loadStatus();
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : "Failed to restart session");
    } finally {
      setRestartingSlug(null);
    }
  }

  return (
    <section>
      <h1 className="text-lg font-semibold text-zinc-900">WhatsApp business sessions</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Live sessions reported by the WhatsApp backend. A business added above will only appear
        here once the backend actually starts a session for it.
      </p>

      {error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {restartError && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{restartError}</p>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
              <th className="px-4 py-3 font-medium">Business</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">QR available</th>
              <th className="px-4 py-3 font-medium">Last connected</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500">
                  Loading sessions…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500">
                  No sessions reported by the backend.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const color = businessColor(row.businessSlug);
              const badge = statusBadge(row.status);
              const isRestarting = restartingSlug === row.businessSlug;
              return (
                <tr key={row.businessSlug} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color.dot}`} aria-hidden />
                      <div>
                        <p className="font-medium text-zinc-900">{row.label}</p>
                        <p className="text-xs text-zinc-400">{row.businessSlug}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{row.hasQr ? "Yes" : "No"}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatDate(row.lastConnectedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenQr(row.businessSlug)}
                        disabled={!row.hasQr && !isSessionConnected(row.status)}
                        className="cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40"
                      >
                        View QR
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestart(row.businessSlug, row.label)}
                        disabled={isRestarting}
                        className="cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40"
                      >
                        {isRestarting ? "Restarting…" : "Restart"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {qrTarget && (
        <QrPanel
          businessSlug={qrTarget}
          connected={qrTargetConnected}
          qrSrc={qrSrc}
          loading={qrLoading}
          error={qrError}
          onClose={handleCloseQr}
        />
      )}
    </section>
  );
}
