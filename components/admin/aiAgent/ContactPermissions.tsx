"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, ContactRuleView, ContactSearchResponse, SettingsResponse } from "@/lib/aiAgent/client";
import { ContactScope } from "@/lib/aiAgent/engine";
import { formatPhoneDisplay } from "@/lib/phone";
import { useDebounced } from "@/components/admin/aiAgent/useDebounced";
import { Card, inputClass, Notice, secondaryButton } from "@/components/admin/aiAgent/ui";

interface Props {
  businessSlug: string;
  scope: ContactScope;
  onScopeSaved: (next: SettingsResponse["settings"]) => void;
}

const SCOPE_LABELS: Record<ContactScope, string> = {
  none: "None — no customer gets AI replies",
  all: "All — every 1:1 customer except exclusions",
  selected: "Selected — only the contacts allowed below",
};

export function ContactPermissions({ businessSlug, scope, onScopeSaved }: Props) {
  const [rules, setRules] = useState<ContactRuleView[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules((await aiAgentApi.listContacts(businessSlug)).rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  const [search, setSearch] = useState<ContactSearchResponse | null>(null);
  const debounced = useDebounced(query);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    aiAgentApi
      .searchContacts(businessSlug, debounced)
      .then((res) => !cancelled && setSearch(res))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Search failed"));
    return () => {
      cancelled = true;
    };
  }, [businessSlug, debounced, refresh]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function changeScope(next: ContactScope) {
    if (next === "all" && !window.confirm("Allow AI replies to ALL customers of this business (except exclusions)?")) return;
    setBusy(true);
    setError(null);
    try {
      onScopeSaved((await aiAgentApi.saveSettings(businessSlug, { contactScope: next })).settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Contact permissions" subtitle="Groups never get AI replies. Exclusions always win.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          {(Object.keys(SCOPE_LABELS) as ContactScope[]).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="radio" name="contact-scope" checked={scope === value} disabled={busy} onChange={() => changeScope(value)} />
              {SCOPE_LABELS[value]}
            </label>
          ))}
        </div>

        <div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, phone number (any format, partial) or WhatsApp ID…" className={inputClass} />
          {search && search.results.length > 0 && (
            <ul className="mt-2 max-h-72 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
              {search.results.map((c) => (
                <li key={c.chatId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="truncate">
                    <RuleBadge rule={c.rule} />
                    {c.name || formatPhoneDisplay(c.number) || c.chatId}
                    <span className="ml-2 text-xs text-zinc-400">
                      {c.isLid && !c.number ? "WhatsApp privacy ID (no phone number)" : formatPhoneDisplay(c.number)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {(["allow", "exclude"] as const).map((r) => (
                      <button key={r} type="button" disabled={busy || c.rule === r} className={secondaryButton} onClick={() => run(() => aiAgentApi.setContact(businessSlug, c.chatId, c.name, r))}>
                        {r === "allow" ? "Allow" : "Exclude"}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {search && search.total > search.results.length && (
            <p className="mt-1 text-xs text-zinc-400">Showing {search.results.length} of {search.total} — keep typing to narrow down.</p>
          )}
          {search && search.results.length === 0 && !search.manual && (
            <p className="mt-2 text-xs text-zinc-500">
              {query.trim() ? "No known contact matches. Type a full number with country code to add it manually." : "No known contacts yet."}
            </p>
          )}
          {search && !search.rpcAvailable && (
            <p className="mt-1 text-xs text-amber-700">list_known_chats isn&apos;t installed — only recent stored messages are searched.</p>
          )}
          {search?.manual && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm">
              <span className="truncate">
                Not in chat history: <span className="font-medium">{formatPhoneDisplay(search.manual.chatId.split("@")[0])}</span>
                <RuleBadge rule={search.manual.rule} />
              </span>
              <span className="flex shrink-0 gap-1">
                {(["allow", "exclude"] as const).map((r) => (
                  <button key={r} type="button" disabled={busy || search.manual?.rule === r} className={secondaryButton} onClick={() => run(() => aiAgentApi.addContactByNumber(businessSlug, query, r))}>
                    {r === "allow" ? "Add & allow" : "Add & exclude"}
                  </button>
                ))}
              </span>
            </div>
          )}
          {query.trim() && search && !search.manual && search.results.length === 0 && /[0-9]/.test(query) && (
            <p className="mt-1 text-xs text-zinc-400">Numbers need a country code, e.g. +1 758 123 4567.</p>
          )}
        </div>

        {rules.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="truncate">
                  <RuleBadge rule={r.rule} />
                  {r.display_name || r.chat_id}
                  {r.display_name && <span className="ml-2 text-xs text-zinc-400">{r.chat_id}</span>}
                </span>
                <button type="button" disabled={busy} className="cursor-pointer text-xs text-zinc-500 hover:text-red-600" onClick={() => run(() => aiAgentApi.removeContact(businessSlug, r.chat_id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {scope === "selected" && !rules.some((r) => r.rule === "allow") && <Notice tone="info">No contacts allowed yet — nobody will get AI replies.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}

// Allowed / Excluded / Not selected — the same three states the gate uses.
function RuleBadge({ rule }: { rule: "allow" | "exclude" | null }) {
  const style =
    rule === "allow" ? "bg-emerald-50 text-emerald-700" : rule === "exclude" ? "bg-red-50 text-red-600" : "bg-zinc-100 text-zinc-500";
  return (
    <span className={`mr-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${style}`}>
      {rule === "allow" ? "Allowed" : rule === "exclude" ? "Excluded" : "Not selected"}
    </span>
  );
}
