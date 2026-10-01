"use client";

import { useEffect, useMemo, useState } from "react";
import { businessColor, Conversation, isOutbound, resolveRecipientNumber } from "@/lib/whatsapp";
import { ContactNameInfo, resolveContactName } from "@/lib/contactName";
import { formatPhoneDisplay, resolveDisplayPhone } from "@/lib/phone";
import { fetchKnownChats, KnownChat } from "@/lib/knownChats";

type ManageChatsFilter = "All" | "Customers" | "Groups" | "Hidden";
const MANAGE_CHATS_FILTERS: ManageChatsFilter[] = ["All", "Customers", "Groups", "Hidden"];

interface ManageChatsProps {
  businessSlug: string;
  businessLabel: string;
  // The inbox's already-loaded conversations — only used as a fallback list
  // if the list_known_chats RPC migration hasn't been run yet.
  loadedConversations: Conversation[];
  // Live On/Off state: conversation_status.hidden, owned and polled by Inbox.
  hiddenChatIds: Set<string>;
  contactDirectory: Map<string, ContactNameInfo>;
  onToggleHidden: (chatId: string, hidden: boolean) => void;
  onClose: () => void;
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function displayNameFor(chat: KnownChat, contactDirectory: Map<string, ContactNameInfo>): string {
  if (chat.isGroup) return chat.contactName?.trim() || "Unnamed group";
  const phoneNumber = resolveRecipientNumber(chat.contactNumber, chat.chatId);
  const directoryEntry = contactDirectory.get(phoneNumber);
  return resolveContactName({
    ...directoryEntry,
    whatsappName: directoryEntry?.whatsappName ?? chat.contactName,
    phoneNumber,
  });
}

// Website-only visibility for every known chat. Off = conversation_status.hidden
// = true: the chat is just left out of the inbox list. Never deletes messages,
// never touches the WhatsApp bridge or WhatsApp itself, and can be switched
// back On at any time.
export function ManageChats({
  businessSlug,
  businessLabel,
  loadedConversations,
  hiddenChatIds,
  contactDirectory,
  onToggleHidden,
  onClose,
}: ManageChatsProps) {
  const [chats, setChats] = useState<KnownChat[]>([]);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ManageChatsFilter>("All");
  const color = businessColor(businessSlug);

  // Loaded once per open (not polled). loadedConversations is deliberately
  // read only at open time — it's just the fallback source.
  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchKnownChats(businessSlug, loadedConversations)
      .then((result) => {
        if (!active) return;
        setChats(result.chats);
        setComplete(result.complete);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessSlug]);

  const rows = useMemo(
    () =>
      chats.map((chat) => ({
        chat,
        name: displayNameFor(chat, contactDirectory),
        phone: chat.isGroup ? null : formatPhoneDisplay(resolveDisplayPhone(chat.contactNumber, chat.chatId).phone),
        hidden: hiddenChatIds.has(chat.chatId),
      })),
    [chats, contactDirectory, hiddenChatIds]
  );

  const counts = useMemo(
    () => ({
      All: rows.length,
      Customers: rows.filter((r) => !r.chat.isGroup).length,
      Groups: rows.filter((r) => r.chat.isGroup).length,
      Hidden: rows.filter((r) => r.hidden).length,
    }),
    [rows]
  );

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "Customers" && r.chat.isGroup) return false;
      if (filter === "Groups" && !r.chat.isGroup) return false;
      if (filter === "Hidden" && !r.hidden) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q) ||
        (r.chat.contactNumber ?? "").toLowerCase().includes(q) ||
        r.chat.chatId.toLowerCase().includes(q) ||
        (r.chat.lastMessageBody ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search]);

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 px-4 pt-12 sm:pt-24" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Manage chats"
        className="flex max-h-[80dvh] w-full max-w-xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-900">Manage chats · {businessLabel}</h2>
            <p className="text-xs text-zinc-500">
              Off hides a chat from this website only. Messages are kept and WhatsApp is not affected.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 cursor-pointer rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100"
          >
            Close
          </button>
        </div>
        <div className="flex flex-col gap-2 border-b border-zinc-200 p-3">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, or last message"
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          <div className="flex flex-wrap gap-1.5">
            {MANAGE_CHATS_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                  filter === value
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                }`}
              >
                {value} <span className="opacity-60">{counts[value]}</span>
              </button>
            ))}
          </div>
          {!loading && !complete && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              Showing only chats active in the last 7 days. Run the list_known_chats migration to list every chat.
            </p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="px-4 py-4 text-sm text-zinc-500">Loading chats…</p>}
          {!loading && visibleRows.length === 0 && <p className="px-4 py-4 text-sm text-zinc-500">No chats found.</p>}
          {!loading &&
            visibleRows.map(({ chat, name, phone, hidden }) => {
              const preview = chat.lastMessageBody?.trim();
              return (
                <div
                  key={chat.chatId}
                  className={`flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5 ${hidden ? "bg-zinc-50" : ""}`}
                >
                  <div className={`min-w-0 flex-1 ${hidden ? "opacity-60" : ""}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-zinc-900">{name}</span>
                      {chat.isGroup && (
                        <span className="flex-shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                          Group
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-zinc-400">
                      {[phone, formatDate(chat.lastMessageAt), chat.messageCount !== null ? `${chat.messageCount} msgs` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {preview && (
                      <p className="truncate text-xs text-zinc-500">
                        {isOutbound(chat.lastDirection) ? "You: " : ""}
                        {preview}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!hidden}
                    aria-label={`${hidden ? "Show" : "Hide"} ${name} in inbox`}
                    onClick={() => onToggleHidden(chat.chatId, !hidden)}
                    className="flex flex-shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600"
                  >
                    <span className="w-6 text-right">{hidden ? "Off" : "On"}</span>
                    <span
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        hidden ? "bg-zinc-300" : color.solid
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          hidden ? "translate-x-0.5" : "translate-x-[18px]"
                        }`}
                      />
                    </span>
                  </button>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
