"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { aiAgentApi, ContactRuleView, SettingsResponse } from "@/lib/aiAgent/client";
import { ContactScope } from "@/lib/aiAgent/engine";
import { KnownChat } from "@/lib/knownChats";
import { Card, inputClass, Notice, secondaryButton } from "@/components/admin/aiAgent/ui";

interface Props {
  businessSlug: string;
  scope: ContactScope;
  chats: KnownChat[];
  onScopeSaved: (next: SettingsResponse["settings"]) => void;
}

const SCOPE_LABELS: Record<ContactScope, string> = {
  none: "None — no customer gets AI replies",
  all: "All — every 1:1 customer except exclusions",
  selected: "Selected — only the contacts allowed below",
};

export function ContactPermissions({ businessSlug, scope, chats, onScopeSaved }: Props) {
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

  const byChat = useMemo(() => new Map(rules.map((r) => [r.chat_id, r])), [rules]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const direct = chats.filter((c) => !c.isGroup && !byChat.has(c.chatId));
    const list = q
      ? direct.filter(
          (c) =>
            (c.contactName ?? "").toLowerCase().includes(q) ||
            (c.contactNumber ?? "").toLowerCase().includes(q) ||
            c.chatId.toLowerCase().includes(q)
        )
      : direct;
    return list.slice(0, 20);
  }, [chats, query, byChat]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts by name or number…" className={inputClass} />
          {matches.length > 0 && (
            <ul className="mt-2 max-h-56 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
              {matches.map((c) => (
                <li key={c.chatId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="truncate">
                    {c.contactName || c.contactNumber || c.chatId}
                    <span className="ml-2 text-xs text-zinc-400">{c.contactNumber}</span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button type="button" disabled={busy} className={secondaryButton} onClick={() => run(() => aiAgentApi.setContact(businessSlug, c.chatId, c.contactName, "allow"))}>
                      Allow
                    </button>
                    <button type="button" disabled={busy} className={secondaryButton} onClick={() => run(() => aiAgentApi.setContact(businessSlug, c.chatId, c.contactName, "exclude"))}>
                      Exclude
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {rules.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="truncate">
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${r.rule === "allow" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
                    {r.rule === "allow" ? "Allowed" : "Excluded"}
                  </span>
                  {r.display_name || r.chat_id}
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
