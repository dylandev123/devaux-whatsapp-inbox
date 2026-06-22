"use client";

import { Conversation } from "@/lib/whatsapp";

interface ConversationListProps {
  conversations: Conversation[];
  selectedChatId: string | null;
  onSelect: (chatId: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selectedBusinessSlug: string | null;
  businessLabel: string;
  onBack: () => void;
  visible: boolean;
  hasBusiness: boolean;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ConversationList({
  conversations,
  selectedChatId,
  onSelect,
  search,
  onSearchChange,
  selectedBusinessSlug,
  businessLabel,
  onBack,
  visible,
  hasBusiness,
}: ConversationListProps) {
  return (
    <section
      data-business-slug={selectedBusinessSlug ?? undefined}
      className={`${visible ? "flex" : "hidden"} md:flex w-full md:w-80 flex-shrink-0 flex-col border-r border-zinc-200 bg-white`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-4">
        <button onClick={onBack} className="text-sm text-emerald-700 md:hidden">
          ← Businesses
        </button>
        <h2 className="truncate text-base font-semibold text-zinc-900 md:block">
          {businessLabel || "Conversations"}
        </h2>
      </div>
      <div className="border-b border-zinc-200 p-3">
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search name, phone, or message"
          className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {!hasBusiness && (
          <p className="px-4 py-6 text-sm text-zinc-500">Select a business to view conversations.</p>
        )}
        {hasBusiness && conversations.length === 0 && (
          <p className="px-4 py-6 text-sm text-zinc-500">No conversations found.</p>
        )}
        {conversations.map((conversation) => (
          <button
            key={conversation.chatId}
            onClick={() => onSelect(conversation.chatId)}
            className={`flex w-full flex-col gap-1 border-b border-zinc-100 px-4 py-3 text-left hover:bg-zinc-50 ${
              selectedChatId === conversation.chatId ? "bg-emerald-50" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-900">
                {conversation.contactName || conversation.contactNumber || conversation.chatId}
              </span>
              <span className="flex-shrink-0 text-xs text-zinc-400">
                {formatTime(conversation.lastMessage.timestamp)}
              </span>
            </div>
            <span className="truncate text-sm text-zinc-500">
              {conversation.lastMessage.message_body || "[Media message]"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
