"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ANALYSIS_CATEGORIES,
  AnalysisCategory,
  AnalysisRange,
  ConversationAnalysis,
  fetchAnalysesForBusiness,
  RANGE_PRESETS,
  RangePreset,
  resolvePresetRange,
  runAnalysis,
  runBusinessAnalysis,
} from "@/lib/analysis";
import { fetchActiveBusinessesOrFallback, WhatsappBusinessRow } from "@/lib/businesses";
import { businessColor, setBusinessDirectory } from "@/lib/whatsapp";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { AnalysisDetailPanel } from "./AnalysisDetailPanel";
import { OrdersQueue } from "./OrdersQueue";

type CategoryFilter = "All" | AnalysisCategory;
type ViewMode = "overview" | "orders";

const RANGE_LABELS: Record<RangePreset, string> = {
  "1d": "1 day",
  "2d": "2 days",
  "7d": "7 days",
  "30d": "30 days",
  custom: "Custom",
};

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Short, single-line preview — the full text lives in AnalysisDetailPanel.
// A hard character cap (not just line-clamp) keeps the table's row height
// consistent even with very long summaries.
function previewText(value: string, max = 90): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
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
  const [view, setView] = useState<ViewMode>("overview");
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
  const [detailRow, setDetailRow] = useState<ConversationAnalysis | null>(null);

  // Which messages get analyzed — applies to both "Analyze new/updated" and
  // per-row "Re-analyze". Defaults to 7 days; custom reveals two date
  // inputs seeded to the same default window.
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const [customSince, setCustomSince] = useState(() => toDateInputValue(new Date(resolvePresetRange("7d").since)));
  const [customUntil, setCustomUntil] = useState(() => toDateInputValue(new Date()));

  const range: AnalysisRange | null = useMemo(() => {
    if (rangePreset !== "custom") return resolvePresetRange(rangePreset);
    const sinceMs = Date.parse(customSince);
    const untilMs = Date.parse(`${customUntil}T23:59:59.999`);
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs) || sinceMs >= untilMs) return null;
    return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
  }, [rangePreset, customSince, customUntil]);

  const loadBusinesses = useCallback(async () => {
    const { businesses: rows } = await fetchActiveBusinessesOrFallback();
    setBusinesses(rows);
    setBusinessDirectory(rows);
    setSelectedBusinessSlug((prev) => prev ?? rows[0]?.business_slug ?? null);
  }, []);

  const loadAnalyses = useCallback(async (businessSlug: string): Promise<ConversationAnalysis[]> => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchAnalysesForBusiness(businessSlug);
      setAnalyses(rows);
      return rows;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis results");
      return [];
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
    if (!selectedBusinessSlug || !range) return;
    setBulkRunning(true);
    setBulkMessage(null);
    setError(null);
    try {
      const result = await runBusinessAnalysis(selectedBusinessSlug, range);
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

  // Takes businessSlug explicitly rather than assuming the currently
  // selected Overview tab — the detail panel can be opened from the Orders
  // queue, whose rows may belong to a different business than whatever's
  // selected in Overview, and re-analyzing against the wrong business_slug
  // would silently hit the wrong (or a nonexistent) conversation.
  async function handleReanalyze(businessSlug: string, chatId: string) {
    if (!range) return;
    setReanalyzingChatId(chatId);
    setError(null);
    try {
      const result = await runAnalysis(businessSlug, chatId, range);
      if (result.skipped > 0 && result.message) {
        setBulkMessage(result.message);
      }
      // Only Overview's shared list needs reloading when the reanalyzed
      // conversation belongs to the business currently shown there — the
      // Orders queue manages its own data and has its own Refresh button.
      // Either way, fetch that business's rows so the open detail panel
      // (if any) can show the fresh result rather than stale pre-reanalysis
      // content.
      const refreshed =
        businessSlug === selectedBusinessSlug
          ? await loadAnalyses(businessSlug)
          : await fetchAnalysesForBusiness(businessSlug);
      setDetailRow((prev) => {
        if (!prev || prev.chat_id !== chatId) return prev;
        return refreshed.find((a) => a.chat_id === chatId) ?? prev;
      });
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
              Read-only, cached until you (re-)analyze. Click a customer to see the full analysis.
            </p>
          </div>
          <ProfileMenu />
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setView("overview")}
            aria-pressed={view === "overview"}
            className={`cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium ${
              view === "overview" ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setView("orders")}
            aria-pressed={view === "orders"}
            className={`cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium ${
              view === "orders" ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Orders
          </button>
        </div>

        {view === "orders" ? (
          <div className="mt-4">
            <OrdersQueue onOpenDetail={setDetailRow} />
          </div>
        ) : (
          <>
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

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-zinc-500">Analyze window:</span>
              {RANGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setRangePreset(preset)}
                  aria-pressed={rangePreset === preset}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                    rangePreset === preset ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  {RANGE_LABELS[preset]}
                </button>
              ))}
              {rangePreset === "custom" && (
                <span className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={customSince}
                    onChange={(e) => setCustomSince(e.target.value)}
                    max={customUntil}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-zinc-400">to</span>
                  <input
                    type="date"
                    value={customUntil}
                    onChange={(e) => setCustomUntil(e.target.value)}
                    min={customSince}
                    max={toDateInputValue(new Date())}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-500"
                  />
                </span>
              )}
              {!range && <span className="text-xs text-red-600">Invalid date range.</span>}
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
                disabled={bulkRunning || !selectedBusinessSlug || !range}
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
              <table className="w-full min-w-[1000px] table-fixed text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                    <th className="w-40 px-4 py-3 font-medium">Customer</th>
                    <th className="w-32 px-4 py-3 font-medium">Phone</th>
                    <th className="w-36 px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 font-medium">Summary</th>
                    <th className="w-20 px-4 py-3 font-medium">Urgency</th>
                    <th className="w-24 px-4 py-3 font-medium">Action</th>
                    <th className="w-20 px-4 py-3 font-medium">Confidence</th>
                    <th className="w-28 px-4 py-3 font-medium">Analyzed</th>
                    <th className="w-40 px-4 py-3 font-medium">Conversation</th>
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
                          <button
                            type="button"
                            onClick={() => setDetailRow(row)}
                            className="cursor-pointer truncate text-left font-medium text-zinc-900 hover:text-emerald-600 hover:underline"
                          >
                            {row.customer_name ?? "Unknown"}
                          </button>
                          {row.status === "error" && (
                            <p className="mt-0.5 text-xs text-red-600">Analysis failed</p>
                          )}
                        </td>
                        <td className="truncate px-4 py-3 text-zinc-600">{row.phone_display ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                            {row.category}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          <button
                            type="button"
                            onClick={() => setDetailRow(row)}
                            className="cursor-pointer text-left hover:text-emerald-600 hover:underline"
                          >
                            {previewText(row.summary)}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${urgencyBadge(row.urgency)}`}>
                            {row.urgency}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          {row.needs_action ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Yes
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">No</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">
                          {row.confidence !== null ? `${Math.round(row.confidence * 100)}%` : "—"}
                        </td>
                        <td className="px-4 py-3 text-zinc-500">{new Date(row.analyzed_at).toLocaleDateString([], { month: "short", day: "numeric" })}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/?business=${encodeURIComponent(row.business_slug)}&chat=${encodeURIComponent(row.chat_id)}`}
                              className="text-xs font-medium text-emerald-600 hover:underline"
                            >
                              Open ↗
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleReanalyze(row.business_slug, row.chat_id)}
                              disabled={reanalyzingChatId === row.chat_id}
                              className="cursor-pointer rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
                            >
                              {reanalyzingChatId === row.chat_id ? "…" : "Re-analyze"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {detailRow && (
        <AnalysisDetailPanel
          analysis={detailRow}
          onClose={() => setDetailRow(null)}
          onReanalyze={() => handleReanalyze(detailRow.business_slug, detailRow.chat_id)}
          reanalyzing={reanalyzingChatId === detailRow.chat_id}
        />
      )}
    </div>
  );
}
