"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createBusiness,
  fetchManagedBusinesses,
  updateBusiness,
  WhatsappBusinessRow,
} from "@/lib/businesses";
import { reloadBusinesses, startSession } from "@/lib/admin/whatsappAdmin";
import { COLOR_PALETTE } from "@/lib/whatsapp";

const POLL_INTERVAL_MS = 5000;
const COLOR_NAMES = Object.keys(COLOR_PALETTE);

function isMissingBusinessesTable(err: unknown): boolean {
  return err instanceof Error && /PGRST205|Could not find the table/i.test(err.message);
}

interface Draft {
  display_name: string;
  colour: string;
  sort_order: string;
}

function ColorDot({ name }: { name: string }) {
  const color = COLOR_PALETTE[name] ?? COLOR_PALETTE.slate;
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color.dot}`} aria-hidden />;
}

export function BusinessManagementPanel() {
  const [businesses, setBusinesses] = useState<WhatsappBusinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [addSlug, setAddSlug] = useState("");
  const [addName, setAddName] = useState("");
  const [addColour, setAddColour] = useState("slate");
  const [addSortOrder, setAddSortOrder] = useState("0");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);

  const loadBusinesses = useCallback(async () => {
    try {
      const rows = await fetchManagedBusinesses();
      setBusinesses(rows);
      setError(null);
      setMigrationMissing(false);
    } catch (err) {
      if (isMissingBusinessesTable(err)) {
        setMigrationMissing(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load businesses");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBusinesses();
    const interval = setInterval(loadBusinesses, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadBusinesses]);

  // Seed a draft for any newly-seen row, but never clobber an in-progress edit.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const b of businesses) {
        if (!next[b.id]) {
          next[b.id] = {
            display_name: b.display_name,
            colour: b.colour ?? "slate",
            sort_order: String(b.sort_order),
          };
        }
      }
      return next;
    });
  }, [businesses]);

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSaveRow(business: WhatsappBusinessRow) {
    const draft = drafts[business.id];
    if (!draft) return;
    setSavingId(business.id);
    setError(null);
    try {
      await updateBusiness(business.id, {
        display_name: draft.display_name.trim(),
        colour: draft.colour,
        sort_order: Number(draft.sort_order) || 0,
      });
      await loadBusinesses();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save business");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeactivate(business: WhatsappBusinessRow) {
    const confirmed = window.confirm(
      `Deactivate ${business.display_name}?\n\nIt will disappear from the sidebar — and from this admin list, since the current SELECT policy only allows reading active rows.`
    );
    if (!confirmed) return;
    setSavingId(business.id);
    setError(null);
    try {
      await updateBusiness(business.id, { is_active: false });
      await loadBusinesses();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate business");
    } finally {
      setSavingId(null);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddSubmitting(true);
    setAddError(null);
    setFlowMessage(null);
    try {
      const created = await createBusiness({
        business_slug: addSlug.trim(),
        display_name: addName.trim(),
        colour: addColour,
        sort_order: Number(addSortOrder) || 0,
      });
      setAddSlug("");
      setAddName("");
      setAddColour("slate");
      setAddSortOrder("0");
      setAdding(false);
      await loadBusinesses();

      setFlowMessage(`Saved "${created.display_name}". Asking the WhatsApp backend to reload and start this session…`);
      try {
        await reloadBusinesses();
        await startSession(created.business_slug);
        setFlowMessage(
          `"${created.display_name}" saved, and reload/start requests were sent to the backend. Open the sessions table below and click "View QR" once it appears there.`
        );
      } catch (bridgeErr) {
        setFlowMessage(
          `"${created.display_name}" was saved to Supabase, but the backend didn't accept the reload/start request (${
            bridgeErr instanceof Error ? bridgeErr.message : "unknown error"
          }). That's expected until the backend's dynamic-business support is deployed — see the delivery notes for the endpoints it still needs.`
        );
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add business");
    } finally {
      setAddSubmitting(false);
    }
  }

  if (migrationMissing) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-900">Manage businesses</h2>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">Adding/editing businesses from this page isn&apos;t set up yet.</p>
          <p className="mt-1">
            The <code className="rounded bg-amber-100 px-1 py-0.5">whatsapp_businesses</code> table
            doesn&apos;t exist in Supabase yet — someone needs to run{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5">
              supabase/migrations/20260623000300_business_management.sql
            </code>{" "}
            in the Supabase SQL editor first.
          </p>
          <p className="mt-2 font-medium">What works right now, below:</p>
          <ul className="mt-1 list-inside list-disc">
            <li>Viewing the status of the 5 existing WhatsApp sessions</li>
            <li>Viewing/scanning QR codes for sessions awaiting a scan</li>
            <li>Restarting an existing session</li>
          </ul>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Manage businesses</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Adds/edits go straight to Supabase. Backend reload/start happen automatically when you
            add a business, but only work once the backend supports them.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex-shrink-0 cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
        >
          {adding ? "Cancel" : "Add business"}
        </button>
      </div>

      {error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {flowMessage && (
        <p className="mt-4 rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-700">{flowMessage}</p>
      )}

      {adding && (
        <form
          onSubmit={handleAdd}
          className="mt-4 grid grid-cols-1 gap-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2"
        >
          {addError && (
            <p className="sm:col-span-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {addError}
            </p>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Business slug</label>
            <input
              required
              value={addSlug}
              onChange={(e) => setAddSlug(e.target.value)}
              placeholder="e.g. sunset_cafe"
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Display name</label>
            <input
              required
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="e.g. Sunset Café"
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Colour</label>
            <select
              value={addColour}
              onChange={(e) => setAddColour(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            >
              {COLOR_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Sort order</label>
            <input
              type="number"
              value={addSortOrder}
              onChange={(e) => setAddSortOrder(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={addSubmitting}
              className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {addSubmitting ? "Saving…" : "Save business"}
            </button>
          </div>
        </form>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400">
              <th className="px-4 py-3 font-medium">Slug</th>
              <th className="px-4 py-3 font-medium">Display name</th>
              <th className="px-4 py-3 font-medium">Colour</th>
              <th className="px-4 py-3 font-medium">Sort order</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500">
                  Loading businesses…
                </td>
              </tr>
            )}
            {!loading && businesses.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500">
                  No active businesses.
                </td>
              </tr>
            )}
            {businesses.map((business) => {
              const draft = drafts[business.id] ?? {
                display_name: business.display_name,
                colour: business.colour ?? "slate",
                sort_order: String(business.sort_order),
              };
              const isSaving = savingId === business.id;
              return (
                <tr key={business.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-500">{business.business_slug}</td>
                  <td className="px-4 py-2.5">
                    <input
                      value={draft.display_name}
                      onChange={(e) => updateDraft(business.id, { display_name: e.target.value })}
                      className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <ColorDot name={draft.colour} />
                      <select
                        value={draft.colour}
                        onChange={(e) => updateDraft(business.id, { colour: e.target.value })}
                        className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                      >
                        {COLOR_NAMES.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="number"
                      value={draft.sort_order}
                      onChange={(e) => updateDraft(business.id, { sort_order: e.target.value })}
                      className="w-20 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSaveRow(business)}
                        disabled={isSaving}
                        className="cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40"
                      >
                        {isSaving ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeactivate(business)}
                        disabled={isSaving}
                        className="cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:cursor-default disabled:opacity-40"
                      >
                        Deactivate
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
