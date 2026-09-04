"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ConversationAnalysis } from "@/lib/analysis";
import { CustomerAiProfile, fetchProfileFor, hasProfileContent } from "@/lib/customerProfile";
import { businessLabel } from "@/lib/whatsapp";

interface AnalysisDetailPanelProps {
  analysis: ConversationAnalysis;
  onClose: () => void;
  onReanalyze?: () => void;
  reanalyzing?: boolean;
  onToggleWorkflow?: () => void;
  updatingWorkflow?: boolean;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

// Full-detail view for a single conversation's analysis — opened by
// clicking a customer/row in either the main table or the order queue.
// Everything here already exists on the ConversationAnalysis row except the
// customer AI profile, which is fetched on demand (see fetchProfileFor) so
// this component works the same regardless of which list opened it,
// without either caller needing to pre-load a whole business's profiles.
export function AnalysisDetailPanel({
  analysis,
  onClose,
  onReanalyze,
  reanalyzing,
  onToggleWorkflow,
  updatingWorkflow,
}: AnalysisDetailPanelProps) {
  const [profile, setProfile] = useState<CustomerAiProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setProfileLoading(true);
    setProfileError(null);
    fetchProfileFor(analysis.business_slug, analysis.contact_number)
      .then((p) => {
        if (active) setProfile(p);
      })
      .catch((err) => {
        if (active) setProfileError(err instanceof Error ? err.message : "Failed to load customer profile");
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [analysis.business_slug, analysis.contact_number]);

  const extracted = analysis.extracted;
  const hasExtracted =
    extracted.products_services?.length ||
    extracted.quantity ||
    extracted.dates?.length ||
    extracted.address ||
    extracted.payment_info ||
    extracted.booking_info;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {businessLabel(analysis.business_slug)}
            </p>
            <h2 className="text-base font-semibold text-zinc-900">{analysis.customer_name ?? "Unknown"}</h2>
            <p className="text-sm text-zinc-500">{analysis.phone_display ?? "No phone number on file"}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 cursor-pointer rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {analysis.status === "error" && (
            <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              Analysis failed: {analysis.error_message}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
              {analysis.category}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${urgencyBadge(analysis.urgency)}`}>
              {analysis.urgency} urgency
            </span>
            {analysis.needs_action && (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                Action needed
              </span>
            )}
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                analysis.workflow_status === "Done" ? "bg-zinc-100 text-zinc-600" : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {analysis.workflow_status}
            </span>
            {analysis.confidence !== null && (
              <span className="text-xs text-zinc-400">{Math.round(analysis.confidence * 100)}% confidence</span>
            )}
          </div>

          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Summary</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">{analysis.summary}</p>
          </section>

          {analysis.needs_action && analysis.next_action && (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Next action</h3>
              <p className="mt-1 text-sm text-zinc-700">{analysis.next_action}</p>
            </section>
          )}

          {hasExtracted && (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Extracted details</h3>
              <dl className="mt-1 space-y-1 text-sm text-zinc-700">
                {extracted.products_services?.length ? (
                  <p>Products/services: {extracted.products_services.join(", ")}</p>
                ) : null}
                {extracted.quantity && <p>Quantity: {extracted.quantity}</p>}
                {extracted.dates?.length ? <p>Dates: {extracted.dates.join(", ")}</p> : null}
                {extracted.address && <p>Address: {extracted.address}</p>}
                {extracted.payment_info && <p>Payment: {extracted.payment_info}</p>}
                {extracted.booking_info && <p>Booking: {extracted.booking_info}</p>}
              </dl>
            </section>
          )}

          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              AI customer profile
            </h3>
            {profileLoading && <p className="mt-1 text-sm text-zinc-400">Loading…</p>}
            {profileError && <p className="mt-1 text-sm text-red-600">{profileError}</p>}
            {!profileLoading && !profileError && !hasProfileContent(profile) && (
              <p className="mt-1 text-sm text-zinc-400">No profile learned yet for this customer.</p>
            )}
            {!profileLoading && !profileError && hasProfileContent(profile) && (
              <dl className="mt-1 space-y-1 text-sm text-zinc-700">
                {profile!.preferences && <p>Preferences: {profile!.preferences}</p>}
                {profile!.common_orders && <p>Usually orders: {profile!.common_orders}</p>}
                {profile!.addresses && <p>Address: {profile!.addresses}</p>}
                {profile!.payment_habits && <p>Payment habits: {profile!.payment_habits}</p>}
                {profile!.important_notes && <p>Notes: {profile!.important_notes}</p>}
                {profile!.last_known_intent && <p>Last known intent: {profile!.last_known_intent}</p>}
              </dl>
            )}
          </section>

          <p className="mt-4 text-xs text-zinc-400">Analyzed {formatDateTime(analysis.analyzed_at)}</p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-5 py-3">
          <Link
            href={`/?business=${encodeURIComponent(analysis.business_slug)}&chat=${encodeURIComponent(analysis.chat_id)}`}
            className="text-sm font-medium text-emerald-600 hover:underline"
          >
            Open conversation ↗
          </Link>
          <div className="flex items-center gap-2">
            {onToggleWorkflow && (
              <button
                type="button"
                onClick={onToggleWorkflow}
                disabled={updatingWorkflow}
                className="cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
              >
                {analysis.workflow_status === "Done" ? "Reopen" : "Mark done"}
              </button>
            )}
            {onReanalyze && (
              <button
                type="button"
                onClick={onReanalyze}
                disabled={reanalyzing}
                className="cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
              >
                {reanalyzing ? "Re-analyzing…" : "Re-analyze"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
