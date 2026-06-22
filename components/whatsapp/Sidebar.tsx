"use client";

import { supabase } from "@/lib/supabaseClient";
import { BUSINESS_LABELS, businessLabel, isSessionConnected, WhatsappSession } from "@/lib/whatsapp";

interface SidebarProps {
  sessions: WhatsappSession[];
  selectedBusinessSlug: string | null;
  onSelect: (slug: string) => void;
  visible: boolean;
}

interface BusinessRow {
  business_slug: string;
  label: string;
  connected: boolean;
}

export function Sidebar({ sessions, selectedBusinessSlug, onSelect, visible }: SidebarProps) {
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
      className={`${visible ? "flex" : "hidden"} md:flex w-full md:w-64 flex-shrink-0 flex-col border-r border-zinc-200 bg-white`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-4">
        <h1 className="text-lg font-semibold text-zinc-900">WhatsApp Inbox</h1>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-900"
        >
          Log out
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto">
        {businesses.map((business) => {
          const isSelected = selectedBusinessSlug === business.business_slug;
          return (
            <button
              key={business.business_slug}
              type="button"
              onClick={() => {
                console.log("Selected business", business.business_slug);
                onSelect(business.business_slug);
              }}
              aria-pressed={isSelected}
              className={`flex w-full cursor-pointer items-center gap-2 border-l-4 px-4 py-3 text-left text-sm hover:bg-zinc-100 ${
                isSelected
                  ? "border-emerald-600 bg-emerald-50 font-medium text-emerald-700"
                  : "border-transparent text-zinc-700"
              }`}
            >
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${
                  business.connected ? "bg-emerald-500" : "bg-zinc-300"
                }`}
                aria-hidden
              />
              <span className="truncate">{business.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
