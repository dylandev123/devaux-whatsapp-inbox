"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchKnownChats, KnownChat } from "@/lib/knownChats";
import { isPlausiblePhoneNumber } from "@/lib/phone";
import { Recipient, recipientLabel } from "@/lib/scheduledMessages";

interface Props {
  businessSlug: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
}

function chatToRecipient(chat: KnownChat): Recipient {
  return {
    jid: chat.chatId,
    name: chat.contactName?.trim() || chat.contactNumber || null,
    kind: chat.isGroup ? "group" : "contact",
  };
}

// Picks individual contacts and real WhatsApp groups from the chats this
// business has actually had (list_known_chats), plus manual number entry.
export function RecipientPicker({ businessSlug, value, onChange }: Props) {
  const [chats, setChats] = useState<KnownChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(true);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    if (!businessSlug) return;
    let active = true;
    setLoading(true);
    fetchKnownChats(businessSlug, [])
      .then((result) => {
        if (!active) return;
        setChats(result.chats);
        setComplete(result.complete);
      })
      .catch(() => {
        if (active) setChats([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessSlug]);

  const selected = useMemo(() => new Set(value.map((r) => r.jid)), [value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chats.filter((c) => !selected.has(c.chatId));
    if (!q) return list.slice(0, 30);
    return list
      .filter(
        (c) =>
          (c.contactName ?? "").toLowerCase().includes(q) ||
          (c.contactNumber ?? "").toLowerCase().includes(q) ||
          c.chatId.toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [chats, query, selected]);

  function add(recipient: Recipient) {
    if (selected.has(recipient.jid)) return;
    onChange([...value, recipient]);
  }

  function addManual() {
    const digits = manual.replace(/[^0-9]/g, "");
    if (!isPlausiblePhoneNumber(digits)) {
      setManualError("Enter the full number with country code, e.g. 17581234567");
      return;
    }
    setManualError(null);
    add({ jid: `${digits}@s.whatsapp.net`, name: null, kind: "contact" });
    setManual("");
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((r) => (
            <span
              key={r.jid}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800"
            >
              {r.kind === "group" ? "👥 " : ""}
              {recipientLabel(r)}
              <button
                type="button"
                aria-label={`Remove ${recipientLabel(r)}`}
                onClick={() => onChange(value.filter((x) => x.jid !== r.jid))}
                className="cursor-pointer text-emerald-600 hover:text-emerald-900"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search contacts and WhatsApp groups…"
        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
      />
      <div className="max-h-44 overflow-y-auto rounded-md border border-zinc-200">
        {loading ? (
          <p className="px-3 py-2 text-xs text-zinc-500">Loading chats…</p>
        ) : matches.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">No matching chats.</p>
        ) : (
          matches.map((chat) => (
            <button
              key={chat.chatId}
              type="button"
              onClick={() => add(chatToRecipient(chat))}
              className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-zinc-50"
            >
              <span className="truncate text-zinc-800">
                {chat.isGroup ? "👥 " : ""}
                {chat.contactName || chat.contactNumber || chat.chatId}
              </span>
              <span className="shrink-0 text-xs text-zinc-400">{chat.isGroup ? "Group" : "Contact"}</span>
            </button>
          ))
        )}
      </div>
      {!complete && (
        <p className="text-xs text-amber-700">
          Only recent chats are listed (the chat directory function isn&apos;t available). Add others by number below.
        </p>
      )}

      <div className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManual();
            }
          }}
          placeholder="Add by phone number (e.g. 17581234567)"
          className="min-w-0 flex-1 rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addManual}
          className="cursor-pointer rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Add
        </button>
      </div>
      {manualError && <p className="text-xs text-red-600">{manualError}</p>}
    </div>
  );
}
