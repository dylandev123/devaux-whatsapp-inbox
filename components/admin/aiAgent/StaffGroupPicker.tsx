"use client";

import { useEffect, useState } from "react";
import { aiAgentApi, GroupSearchResponse } from "@/lib/aiAgent/client";
import { groupLabel, normalizeGroupJid } from "@/lib/aiAgent/chatDirectory";
import { useDebounced } from "@/components/admin/aiAgent/useDebounced";
import { formatWhen, inputClass, Notice, secondaryButton } from "@/components/admin/aiAgent/ui";

export interface StaffGroupValue {
  jid: string;
  name: string | null;
  manual: boolean;
}

interface Props {
  businessSlug: string;
  value: StaffGroupValue | null;
  onChange: (next: StaffGroupValue | null) => void;
}

// Searchable staff-group selector. Groups come from this business's own stored
// messages (server-side, /api/ai-agent/chats); the saved value is the exact
// …@g.us JID the bridge compares against.
export function StaffGroupPicker({ businessSlug, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [manualJid, setManualJid] = useState("");
  const [manualName, setManualName] = useState("");
  const [data, setData] = useState<GroupSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(query);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    aiAgentApi
      .searchGroups(businessSlug, debounced)
      .then((res) => !cancelled && (setData(res), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load groups"));
    return () => {
      cancelled = true;
    };
  }, [businessSlug, debounced, open]);

  const manualValid = normalizeGroupJid(manualJid);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm">
        {value ? (
          <span className="truncate">
            <span className="font-medium text-zinc-900">{groupLabel({ chatId: value.jid, name: value.name })}</span>
            <span className="ml-2 text-xs text-zinc-400">{value.jid}</span>
          </span>
        ) : (
          <span className="text-zinc-500">— None —</span>
        )}
        <span className="flex shrink-0 gap-1">
          <button type="button" className={secondaryButton} onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : value ? "Change" : "Choose group"}
          </button>
          {value && (
            <button type="button" className={secondaryButton} onClick={() => onChange(null)}>
              Clear
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search groups by name, sender or ID…" className={inputClass} autoFocus />
          {error && <Notice tone="error">{error}</Notice>}
          {data && !data.rpcAvailable && (
            <Notice tone="warn">
              The chat directory function (list_known_chats) isn&apos;t installed; only recently stored messages are searched.
            </Notice>
          )}
          {data && data.results.length > 0 && (
            <ul className="max-h-56 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
              {data.results.map((g) => (
                <li key={g.chatId}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50"
                    onClick={() => {
                      onChange({ jid: g.chatId, name: g.name, manual: false });
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">
                      <span className="font-medium">{g.label}</span>
                      {g.lastSender && <span className="ml-2 text-xs text-zinc-500">last from {g.lastSender}</span>}
                      {g.memberCount !== null && <span className="ml-2 text-xs text-zinc-500">{g.memberCount} members</span>}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">{formatWhen(g.lastMessageAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && data.results.length === 0 && (
            <Notice tone="info">
              {data.total === 0 && !query.trim()
                ? "No groups found for this business. A group appears here once the business WhatsApp number has a message in it that is still stored (messages are kept 7 days). Send any message in your staff group from the business number, reopen this list, or enter the group ID below."
                : "No groups match that search."}
            </Notice>
          )}
          <p className="text-xs text-zinc-400">
            WhatsApp group names aren&apos;t stored by the bridge, so groups show as &quot;Group …xxxxxx&quot; with the last sender. The name you save is kept for later.
          </p>

          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-zinc-500">Enter a group ID manually</summary>
            <div className="mt-2 flex flex-col gap-2">
              <input value={manualJid} onChange={(e) => setManualJid(e.target.value)} placeholder="120363012345678901@g.us" className={inputClass} />
              <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Label (e.g. Staff escalations)" className={inputClass} />
              {manualJid.trim() && !manualValid && <Notice tone="error">A group ID looks like 1203630…@g.us</Notice>}
              <button
                type="button"
                disabled={!manualValid}
                className={`${secondaryButton} self-start`}
                onClick={() => {
                  if (!manualValid) return;
                  onChange({ jid: manualValid, name: manualName.trim() || null, manual: true });
                  setOpen(false);
                  setManualJid("");
                  setManualName("");
                }}
              >
                Use this group
              </button>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
