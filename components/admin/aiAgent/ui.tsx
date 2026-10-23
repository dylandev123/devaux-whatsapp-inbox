"use client";

// Small shared bits for the AI Agent admin panels — same zinc/emerald look as
// AiSettingsPanel and the schedules UI.

export const inputClass =
  "w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500";
export const primaryButton =
  "cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50";
export const secondaryButton =
  "cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50";
export const dangerButton =
  "cursor-pointer rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-default disabled:opacity-50";

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Notice({ tone, children }: { tone: "error" | "warn" | "ok" | "info"; children: React.ReactNode }) {
  const styles = {
    error: "bg-red-50 text-red-600",
    warn: "bg-amber-50 text-amber-800",
    ok: "bg-emerald-50 text-emerald-700",
    info: "bg-zinc-100 text-zinc-700",
  }[tone];
  return <p className={`rounded-md px-3 py-2 text-sm ${styles}`}>{children}</p>;
}

const DECISION_STYLES: Record<string, string> = {
  REPLY: "bg-emerald-50 text-emerald-700",
  ASK: "bg-blue-50 text-blue-700",
  ESCALATE: "bg-amber-50 text-amber-800",
  NO_REPLY: "bg-zinc-100 text-zinc-600",
  HUMAN: "bg-purple-50 text-purple-700",
  urgent: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-800",
  normal: "bg-zinc-100 text-zinc-700",
  low: "bg-zinc-50 text-zinc-500",
  // Outbox states (lib/aiAgent/outboxStatus.ts)
  sent: "bg-emerald-50 text-emerald-700",
  pending: "bg-blue-50 text-blue-700",
  dispatched: "bg-blue-50 text-blue-700",
  unresolved: "bg-amber-100 text-amber-800",
  blocked: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-50 text-red-700",
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${DECISION_STYLES[value] ?? "bg-zinc-100 text-zinc-600"}`}>
      {value}
    </span>
  );
}
