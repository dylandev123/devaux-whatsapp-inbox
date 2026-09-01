"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ANALYSIS_CATEGORIES,
  AnalysisCategory,
  ConversationAnalysis,
  fetchAnalysesForBusiness,
  runAnalysis,
  runBusinessAnalysis,
} from "@/lib/analysis";
import { fetchActiveBusinessesOrFallback, WhatsappBusinessRow } from "@/lib/businesses";
import { businessColor, setBusinessDirectory } from "@/lib/whatsapp";
import { ProfileMenu } from "@/components/auth/ProfileMenu";

type CategoryFilter = "All" | AnalysisCategory;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function urgencyBadge(urgency: ConversationAnalysis["urgency"]) {
  switch (urgency) {
    case "high":
      return "bg-red-50 text-red-700";
    case "medium":
      return "bg-amber-50 text-amber-700";
    default:
      return "bg-zinc-100 text-zinc-600";
  }
}

export function AnalysisDashboard() {
  const [businesses, setBusinesses] = useState<WhatsappBusinessRow[]>([]);
  const [selectedBusinessSlug, setSelectedBusinessSlug] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<ConversationAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("All");
  const [needsActionOnly, setNeedsActionOnly] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [reanalyzingChatId, setReanalyzingChatId] = useState<string | null>(null);

  const loadBusinesses = useCallback(async () => {
    const { businesses: rows } = await fetchActiveBusinessesOrFallback();
    setBusinesses(rows);
    setBusinessDirectory(rows);
    setSelectedBusinessSlug((prev) => prev ?? rows[0]?.business_slug ?? null);
  }, []);

  const loadAnalyses = useCallback(async (businessSlug: string) => {
    setLoading(true);
    setError(null);
    try {
      setAnalyses(await fetchAnalysesForBusiness(businessSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis results");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBusinesses();
  }, [loadBusinesses]);

  useEffect(() => {
    if (!selectedBusinessSlug) return;
    setCategoryFilter("All");
    setNeedsActionOnly(false);
    setBulkMessage(null);
    loadAnalyses(selectedBusinessSlug);
  }, [selectedBusinessSlug, loadAnalyses]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<AnalysisCategory, number>();
    for (const row of analyses) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
    return counts;
  }, [analyses]);

  const filteredRows = useMemo(() => {
    return analyses.filter((row) => {
      if (categoryFilter !== "All" && row.category !== categoryFilter) return false;
      if (needsActionOnly && !row.needs_action) return false;
      return true;
    });
  }, [analyses, categoryFilter, needsActionOnly]);

  async function handleBulkRun() {
    if (!selectedBusinessSlug) return;
    setBulkRunning(true);
    setBulkMessage(null);
    setError(null);
    try {
      const result = await runBusinessAnalysis(selectedBusinessSlug);
      const parts = [`Analyzed ${result.analyzed}`];
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      if (result.skipped > 0) parts.push(`${result.skipped} more remaining — click again to continue`);
      setBulkMessage(parts.join(", "));
      await loadAnalyses(selectedBusinessSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run analysis");
    } finally {
      setBulkRunning(false);
    }
  }

  async function handleReanalyze(chatId: string) {
    if (!selectedBusinessSlug) return;
    setReanalyzingChatId(chatId);
    setError(null);
    try {
      await runAnalysis(selectedBusinessSlug, chatId);
      await loadAnalyses(selectedBusinessSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-analyze conversation");
    } finally {
      setReanalyzingChatId(null);
    }
  }

  return (
    <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">AI conversation analysis</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Category, summary, and extracted details for each conversation — read-only, cached
              until you (re-)analyze.
            </p>
          </div>
          <ProfileMenu />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {businesses.map((b) => {
            const color = businessColor(b.business_slug);
            const selected = b.business_slug === selectedBusinessSlug;
            return (
              <button
                key={b.business_slug}
                type="button"
                onClick={() => setSelectedBusinessSlug(b.business_slug)}
                aria-pressed={selected}
                className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                  selected ? `${color.border} ${color.bg} font-medium text-zinc-900` : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${color.dot}`} aria-hidden />
                {b.display_name}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCategoryFilter("All")}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                categoryFilter === "All" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
              }`}
            >
              All ({analyses.length})
            </button>
            {ANALYSIS_CATEGORIES.map((category) => {
              const count = categoryCounts.get(category) ?? 0;
              if (count === 0) return null;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setCategoryFilter(category)}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                    categoryFilter === category ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  {category} ({count})
                </button>
              );
            })}
            <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs font-medium text-zinc-600">
              <input
                type="checkbox"
                checked={needsActionOnly}
                onChange={(e) => setNeedsActionOnly(e.target.checked)}
              />
              Needs action only
            </label>
          </div>

          <button
            type="button"
            onClick={handleBulkRun}
            disabled={bulkRunning || !selectedBusinessSlug}
            className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50"
          >
            {bulkRunning ? "Analyzing…" : "Analyze new/updated"}
          </button>
        </div>

        {bulkMessage && (
          <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{bulkMessage}</p>
        )}
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Summary</th>
                <th className="px-4 py-3 font-medium">Urgency</th>
                <th className="px-4 py-3 font-medium">Action needed</th>
                <th className="px-4 py-3 font-medium">Confidence</th>
                <th className="px-4 py-3 font-medium">Analyzed</th>
                <th className="px-4 py-3 font-medium">Conversation</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-zinc-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-zinc-500">
                    {analyses.length === 0
                      ? "No conversations analyzed yet for this business — click \"Analyze new/updated\" to get started."
                      : "No conversations match this filter."}
                  </td>
                </tr>
              )}
              {!loading &&
                filteredRows.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-100 align-top last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-zinc-900">{row.customer_name ?? "Unknown"}</p>
                      {row.status === "error" && (
                        <p className="mt-0.5 text-xs text-red-600" title={row.error_message ?? ""}>
                          Analysis failed
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">{row.phone_display ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                        {row.category}
                      </span>
                    </td>
                    <td className="max-w-sm px-4 py-3 text-zinc-600">
                      <p className="line-clamp-2">{row.summary}</p>
                      {(row.extracted.products_services?.length ||
                        row.extracted.quantity ||
                        row.extracted.dates?.length ||
                        row.extracted.address ||
                        row.extracted.payment_info ||
                        row.extracted.booking_info) && (
                        <dl className="mt-1 space-y-0.5 text-xs text-zinc-400">
                          {row.extracted.products_services?.length ? (
                            <p>Products/services: {row.extracted.products_services.join(", ")}</p>
                          ) : null}
                          {row.extracted.quantity && <p>Qty: {row.extracted.quantity}</p>}
                          {row.extracted.dates?.length ? <p>Dates: {row.extracted.dates.join(", ")}</p> : null}
                          {row.extracted.address && <p>Address: {row.extracted.address}</p>}
                          {row.extracted.payment_info && <p>Payment: {row.extracted.payment_info}</p>}
                          {row.extracted.booking_info && <p>Booking: {row.extracted.booking_info}</p>}
                        </dl>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${urgencyBadge(row.urgency)}`}>
                        {row.urgency}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {row.needs_action ? (
                        <div>
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                            Yes
                          </span>
                          {row.next_action && <p className="mt-1 text-xs text-zinc-500">{row.next_action}</p>}
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400">No</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {row.confidence !== null ? `${Math.round(row.confidence * 100)}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">{formatDateTime(row.analyzed_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1.5">
                        <Link
                          href={`/?business=${encodeURIComponent(row.business_slug)}&chat=${encodeURIComponent(row.chat_id)}`}
                          className="text-xs font-medium text-emerald-600 hover:underline"
                        >
                          Open conversation ↗
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleReanalyze(row.chat_id)}
                          disabled={reanalyzingChatId === row.chat_id}
                          className="cursor-pointer rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
                        >
                          {reanalyzingChatId === row.chat_id ? "Re-analyzing…" : "Re-analyze"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
