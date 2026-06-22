"use client";

import { Conversation, isOutbound } from "@/lib/whatsapp";
import { ReplyBox } from "./ReplyBox";

interface MessageThreadProps {
  conversation: Conversation | null;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  visible: boolean;
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

export function MessageThread({ conversation, onBack, onSend, visible }: MessageThreadProps) {
  return (
    <section className={`${visible ? "flex" : "hidden"} md:flex flex-1 flex-col bg-zinc-50`}>
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-4">
        <button onClick={onBack} className="text-sm text-emerald-700 md:hidden">
          ← Chats
        </button>
        <h2 className="truncate text-base font-semibold text-zinc-900">
          {conversation
            ? conversation.contactName || conversation.contactNumber || conversation.chatId
            : "Select a conversation"}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!conversation && (
          <p className="text-sm text-zinc-500">Select a conversation to view messages.</p>
        )}
        <div className="flex flex-col gap-2">
          {conversation?.messages.map((message) => {
            const outbound = isOutbound(message.direction);
            return (
              <div key={message.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                    outbound ? "bg-emerald-600 text-white" : "bg-white text-zinc-900"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">
                    {message.message_body || (message.media_url ? "[Media message]" : "")}
                  </p>
                  <p
                    className={`mt-1 text-right text-[10px] ${
                      outbound ? "text-emerald-100" : "text-zinc-400"
                    }`}
                  >
                    {formatTime(message.timestamp)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ReplyBox disabled={!conversation} onSend={onSend} />
    </section>
  );
}
