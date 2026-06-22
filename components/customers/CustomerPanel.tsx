"use client";

import { useEffect, useState } from "react";
import {
  Customer,
  CustomerBusinessStat,
  EditableCustomerFields,
  fetchCustomerBusinessStats,
  fetchCustomerByPhone,
  updateCustomer,
} from "@/lib/customers";
import { businessColor, businessLabel } from "@/lib/whatsapp";

interface CustomerPanelProps {
  phoneNumber: string;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function CustomerPanel({ phoneNumber, onClose }: CustomerPanelProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [stats, setStats] = useState<CustomerBusinessStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<EditableCustomerFields>({
    first_name: "",
    last_name: "",
    email: "",
    notes: "",
    tags: [],
  });
  const [tagsInput, setTagsInput] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([fetchCustomerByPhone(phoneNumber), fetchCustomerBusinessStats(phoneNumber)])
      .then(([fetchedCustomer, fetchedStats]) => {
        if (!active) return;
        setCustomer(fetchedCustomer);
        setStats(fetchedStats);
        setForm({
          first_name: fetchedCustomer?.first_name ?? "",
          last_name: fetchedCustomer?.last_name ?? "",
          email: fetchedCustomer?.email ?? "",
          notes: fetchedCustomer?.notes ?? "",
          tags: fetchedCustomer?.tags ?? [],
        });
        setTagsInput((fetchedCustomer?.tags ?? []).join(", "));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load customer");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [phoneNumber]);

  async function handleSave() {
    if (!customer) return;
    setSaving(true);
    setError(null);
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const updated = await updateCustomer(customer.id, { ...form, tags });
      setCustomer(updated);
      setForm({
        first_name: updated.first_name ?? "",
        last_name: updated.last_name ?? "",
        email: updated.email ?? "",
        notes: updated.notes ?? "",
        tags: updated.tags,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save customer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-white md:static md:inset-auto md:z-auto md:w-80 md:flex-shrink-0 md:border-l md:border-zinc-200">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">Customer profile</h2>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-900"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && <p className="text-sm text-zinc-500">Loading…</p>}
        {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {!loading && !customer && (
          <p className="text-sm text-zinc-500">
            No customer profile yet for this number. One is created automatically the next time
            they message.
          </p>
        )}

        {!loading && customer && (
          <div className="flex flex-col gap-6">
            <section>
              <p className="text-base font-semibold text-zinc-900">
                {customer.whatsapp_name || customer.phone_number}
              </p>
              <p className="text-sm text-zinc-500">{customer.phone_number}</p>
              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-xs text-zinc-500">
                <dt>Customer since</dt>
                <dd className="text-right text-zinc-700">{formatDate(customer.created_at)}</dd>
                <dt>Last message</dt>
                <dd className="text-right text-zinc-700">{formatDate(customer.last_message_at)}</dd>
              </dl>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Profile
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={form.first_name ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  placeholder="First name"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  value={form.last_name ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                  placeholder="Last name"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
              </div>
              <input
                type="email"
                value={form.email ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="Email"
                className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              <input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="Tags, comma separated"
                className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              {tagsInput.trim() && (
                <div className="flex flex-wrap gap-1.5">
                  {tagsInput
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                      >
                        {tag}
                      </span>
                    ))}
                </div>
              )}
              <textarea
                value={form.notes ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Notes"
                rows={3}
                className="resize-none rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Businesses contacted
              </h3>
              {stats.length === 0 && <p className="text-sm text-zinc-500">No history yet.</p>}
              {stats.map((stat) => {
                const color = businessColor(stat.businessSlug);
                return (
                  <div
                    key={stat.businessSlug}
                    className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${color.dot}`} aria-hidden />
                      <span className="text-sm font-medium text-zinc-800">
                        {businessLabel(stat.businessSlug)}
                      </span>
                    </div>
                    <div className="text-right text-xs text-zinc-500">
                      <p>First contact {formatDate(stat.firstContactAt)}</p>
                      <p>{stat.messageCount} messages</p>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="flex flex-col gap-2 opacity-50">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Coming soon
              </h3>
              <p className="text-sm text-zinc-500">Assigned to — unassigned</p>
              <p className="text-sm text-zinc-500">Status — none</p>
              <p className="text-sm text-zinc-500">Follow-up reminder — none</p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
