"use client";

import { businessColor, businessLabel, Conversation } from "@/lib/whatsapp";
import { MessageBubble } from "./MessageBubble";
import { ReplyBox } from "./ReplyBox";

interface MessageThreadProps {
  conversation: Conversation | null;
  businessSlug: string | null;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onToggleProfile: () => void;
  showProfile: boolean;
  visible: boolean;
}

function initial(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}

export function MessageThread({
  conversation,
  businessSlug,
  onBack,
  onSend,
  onToggleProfile,
  showProfile,
  visible,
}: MessageThreadProps) {
  const color = businessColor(businessSlug ?? "");
  const businessName = businessSlug ? businessLabel(businessSlug) : null;
  const displayName = conversation
    ? conversation.contactName || conversation.contactNumber || conversation.chatId
    : "Select a conversation";

  return (
    <section className={`${visible ? "flex" : "hidden"} md:flex min-w-0 flex-1 flex-col bg-zinc-50`}>
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-3 sm:gap-3 sm:px-5">
        <button
          onClick={onBack}
          className="-ml-1 flex-shrink-0 cursor-pointer rounded-md px-2 py-2 text-sm text-zinc-500 hover:bg-zinc-100 md:hidden"
        >
          ← Chats
        </button>
        {conversation && (
          <span
            className={`hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white sm:flex ${color.solid}`}
            aria-hidden
          >
            {initial(displayName)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {businessName && (
            <p className={`truncate text-[11px] font-medium uppercase tracking-wide ${color.text}`}>
              {businessName}
            </p>
          )}
          <h2 className="truncate text-sm font-semibold text-zinc-900">{displayName}</h2>
          {conversation?.contactNumber && (
            <p className="truncate text-xs text-zinc-500">{conversation.contactNumber}</p>
          )}
        </div>
        {conversation && (
          <button
            type="button"
            onClick={onToggleProfile}
            aria-pressed={showProfile}
            className={`flex-shrink-0 cursor-pointer rounded-md px-3 py-2 text-xs font-medium ${
              showProfile ? `${color.bg} ${color.text}` : "text-zinc-500 hover:bg-zinc-100"
            }`}
          >
            Profile
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        {!conversation && (
          <p className="text-sm text-zinc-500">Select a conversation to view messages.</p>
        )}
        <div className="flex flex-col gap-2">
          {conversation?.messages.map((message) => (
            <MessageBubble key={message.id} message={message} accentClassName={color.solid} />
          ))}
        </div>
      </div>

      <ReplyBox disabled={!conversation} onSend={onSend} accentClassName={color.solid} />
    </section>
  );
}
