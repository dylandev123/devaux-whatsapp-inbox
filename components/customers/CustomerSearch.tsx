"use client";

import { useEffect, useState } from "react";
import { CustomerSearchResult, searchCustomers } from "@/lib/customers";
import { businessColor, businessLabel } from "@/lib/whatsapp";

interface CustomerSearchProps {
  onClose: () => void;
  onSelectConversation: (businessSlug: string, chatId: string) => void;
}

export function CustomerSearch({ onClose, onSelectConversation }: CustomerSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    const timeout = setTimeout(() => {
      searchCustomers(q)
        .then((r) => {
          if (active) setResults(r);
        })
        .catch((err) => {
          if (active) setError(err instanceof Error ? err.message : "Search failed");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 px-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 p-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers by name, phone, email, or tag…"
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
        </div>
        <div className="max-h-96 overflow-y-auto p-2">
          {loading && <p className="px-3 py-4 text-sm text-zinc-500">Searching…</p>}
          {error && <p className="px-3 py-4 text-sm text-red-600">{error}</p>}
          {!loading && query.trim() && results.length === 0 && !error && (
            <p className="px-3 py-4 text-sm text-zinc-500">No customers found.</p>
          )}
          {results.map((customer) => {
            const color = businessColor(customer.latestBusinessSlug ?? "");
            const canJump = Boolean(customer.latestBusinessSlug && customer.latestChatId);
            return (
              <button
                key={customer.id}
                type="button"
                disabled={!canJump}
                onClick={() =>
                  customer.latestBusinessSlug &&
                  customer.latestChatId &&
                  onSelectConversation(customer.latestBusinessSlug, customer.latestChatId)
                }
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {customer.whatsapp_name || customer.first_name || customer.phone_number}
                  </p>
                  <p className="truncate text-xs text-zinc-500">{customer.phone_number}</p>
                </div>
                {customer.latestBusinessSlug && (
                  <span
                    className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${color.bg} ${color.text}`}
                  >
                    {businessLabel(customer.latestBusinessSlug)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
