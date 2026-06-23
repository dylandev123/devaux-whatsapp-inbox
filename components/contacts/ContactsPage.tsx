"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Customer,
  fetchAllCustomers,
  fetchBusinessesContactedByPhone,
} from "@/lib/customers";
import { fetchActiveBusinessesOrFallback, WhatsappBusinessRow } from "@/lib/businesses";
import { resolveContactName } from "@/lib/contactName";
import { businessColor, businessLabel, setBusinessDirectory } from "@/lib/whatsapp";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function matchesQuery(customer: Customer, displayName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (displayName.toLowerCase().includes(q)) return true;
  if (customer.phone_number.toLowerCase().includes(q)) return true;
  if (customer.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

export function ContactsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [businessesContacted, setBusinessesContacted] = useState<Map<string, string[]>>(new Map());
  const [businesses, setBusinesses] = useState<WhatsappBusinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [businessFilter, setBusinessFilter] = useState<string>("All");

  const load = useCallback(async () => {
    try {
      const [fetchedCustomers, fetchedBusinessMap, { businesses: fetchedBusinesses }] = await Promise.all([
        fetchAllCustomers(),
        fetchBusinessesContactedByPhone(),
        fetchActiveBusinessesOrFallback(),
      ]);
      setCustomers(fetchedCustomers);
      setBusinessesContacted(fetchedBusinessMap);
      setBusinesses(fetchedBusinesses);
      setBusinessDirectory(fetchedBusinesses);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    return customers
      .map((customer) => {
        const displayName = resolveContactName({
          firstName: customer.first_name,
          lastName: customer.last_name,
          whatsappName: customer.whatsapp_name,
          phoneNumber: customer.phone_number,
        });
        const contactedSlugs = businessesContacted.get(customer.phone_number) ?? [];
        return { customer, displayName, contactedSlugs };
      })
      .filter(({ customer, displayName, contactedSlugs }) => {
        if (!matchesQuery(customer, displayName, query)) return false;
        if (businessFilter !== "All" && !contactedSlugs.includes(businessFilter)) return false;
        return true;
      });
  }, [customers, businessesContacted, query, businessFilter]);

  return (
    <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-xl font-semibold text-zinc-900">Contacts</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every customer who has messaged any business, across all conversations.
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, phone, or tag…"
            className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          <select
            value={businessFilter}
            onChange={(e) => setBusinessFilter(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
          >
            <option value="All">All businesses</option>
            {businesses.map((b) => (
              <option key={b.business_slug} value={b.business_slug}>
                {b.display_name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone number</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Businesses contacted</th>
                <th className="px-4 py-3 font-medium">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-zinc-500">
                    Loading contacts…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-zinc-500">
                    No contacts found.
                  </td>
                </tr>
              )}
              {rows.map(({ customer, displayName, contactedSlugs }) => (
                <tr key={customer.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-zinc-900">{displayName}</td>
                  <td className="px-4 py-3 text-zinc-600">{customer.phone_number}</td>
                  <td className="px-4 py-3">
                    {customer.stage ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                        {customer.stage}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {customer.tags.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {customer.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {contactedSlugs.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {contactedSlugs.map((slug) => {
                          const color = businessColor(slug);
                          return (
                            <span
                              key={slug}
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color.bg} ${color.text}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${color.dot}`} aria-hidden />
                              {businessLabel(slug)}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{formatDate(customer.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
