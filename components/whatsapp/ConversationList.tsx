"use client";

import { classifyMedia, mediaPreviewLabel } from "@/lib/media";
import { businessColor, Conversation, isOutbound } from "@/lib/whatsapp";

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
  unreadCounts: Record<string, number>;
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

function initial(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
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
  unreadCounts,
}: ConversationListProps) {
  const color = businessColor(selectedBusinessSlug ?? "");

  return (
    <section
      data-business-slug={selectedBusinessSlug ?? undefined}
      className={`${visible ? "flex" : "hidden"} md:flex w-full md:w-96 flex-shrink-0 flex-col border-r border-zinc-200 bg-white`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-4">
        <button onClick={onBack} className="cursor-pointer text-sm text-zinc-500 md:hidden">
          ← Businesses
        </button>
        <h2 className="truncate text-sm font-semibold text-zinc-900">
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
          <p className="px-5 py-6 text-sm text-zinc-500">Select a business to view conversations.</p>
        )}
        {hasBusiness && conversations.length === 0 && (
          <p className="px-5 py-6 text-sm text-zinc-500">No conversations found.</p>
        )}
        {conversations.map((conversation) => {
          const displayName =
            conversation.contactName || conversation.contactNumber || conversation.chatId;
          const unread = unreadCounts[conversation.chatId] ?? 0;
          const outboundLast = isOutbound(conversation.lastMessage.direction);
          const lastMediaKind = classifyMedia(conversation.lastMessage);
          const preview =
            conversation.lastMessage.message_body ||
            (lastMediaKind ? mediaPreviewLabel(conversation.lastMessage, lastMediaKind) : "");
          return (
            <button
              key={conversation.chatId}
              onClick={() => onSelect(conversation.chatId)}
              className={`flex w-full items-start gap-3 border-b border-zinc-100 px-5 py-3 text-left hover:bg-zinc-50 ${
                selectedChatId === conversation.chatId ? "bg-zinc-50" : ""
              }`}
            >
              <span
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${color.solid}`}
                aria-hidden
              >
                {initial(displayName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm ${unread > 0 ? "font-semibold text-zinc-900" : "font-medium text-zinc-800"}`}
                  >
                    {displayName}
                  </span>
                  <span className="flex-shrink-0 text-xs text-zinc-400">
                    {formatTime(conversation.lastMessage.timestamp)}
                  </span>
                </div>
                {conversation.contactNumber && (
                  <p className="truncate text-xs text-zinc-400">{conversation.contactNumber}</p>
                )}
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm ${unread > 0 ? "text-zinc-700" : "text-zinc-500"}`}
                  >
                    {outboundLast ? "You: " : ""}
                    {preview}
                  </span>
                  {unread > 0 && (
                    <span
                      className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white ${color.solid}`}
                    >
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
