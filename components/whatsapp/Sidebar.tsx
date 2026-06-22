"use client";

import { supabase } from "@/lib/supabaseClient";
import { BUSINESS_LABELS, businessColor, businessLabel, isSessionConnected, WhatsappSession } from "@/lib/whatsapp";

interface SidebarProps {
  sessions: WhatsappSession[];
  selectedBusinessSlug: string | null;
  onSelect: (slug: string) => void;
  onOpenCustomerSearch: () => void;
  unreadCounts: Record<string, number>;
  visible: boolean;
}

interface BusinessRow {
  business_slug: string;
  label: string;
  connected: boolean;
}

export function Sidebar({
  sessions,
  selectedBusinessSlug,
  onSelect,
  onOpenCustomerSearch,
  unreadCounts,
  visible,
}: SidebarProps) {
  const sessionBySlug = new Map(sessions.map((s) => [s.business_slug, s]));
  const slugs = Array.from(
    new Set([...Object.keys(BUSINESS_LABELS), ...sessions.map((s) => s.business_slug)])
  );
  const businesses: BusinessRow[] = slugs.map((slug) => ({
    business_slug: slug,
    label: businessLabel(slug),
    connected: isSessionConnected(sessionBySlug.get(slug)?.status),
  }));

  return (
    <aside
      className={`${visible ? "flex" : "hidden"} md:flex w-full md:w-72 flex-shrink-0 flex-col border-r border-zinc-200 bg-white`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-5 py-5">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">Devaux Communications</h1>
          <p className="text-xs text-zinc-500">WhatsApp inbox</p>
        </div>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-900"
        >
          Log out
        </button>
      </div>
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onOpenCustomerSearch}
          className="w-full cursor-pointer rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
        >
          Search customers…
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {businesses.map((business) => {
          const isSelected = selectedBusinessSlug === business.business_slug;
          const color = businessColor(business.business_slug);
          const unread = unreadCounts[business.business_slug] ?? 0;
          return (
            <button
              key={business.business_slug}
              type="button"
              onClick={() => {
                console.log("Selected business", business.business_slug);
                onSelect(business.business_slug);
              }}
              aria-pressed={isSelected}
              className={`flex w-full cursor-pointer items-center gap-3 border-l-[3px] px-4 py-3 text-left text-sm transition-colors hover:bg-zinc-50 ${
                isSelected ? `${color.border} ${color.bg} font-medium text-zinc-900` : "border-transparent text-zinc-700"
              }`}
            >
              <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${color.dot}`} aria-hidden />
              <span className={`flex-1 truncate ${unread > 0 ? "font-semibold" : ""}`}>
                {business.label}
              </span>
              {unread > 0 && (
                <span
                  className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white ${color.solid}`}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
              <span
                title={business.connected ? "Connected" : "Disconnected"}
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  business.connected ? "bg-emerald-500" : "bg-zinc-300"
                }`}
                aria-hidden
              />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
