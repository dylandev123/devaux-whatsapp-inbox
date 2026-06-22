"use client";

import { classifyMedia } from "@/lib/media";
import { isOutbound, WhatsappMessage } from "@/lib/whatsapp";
import { MediaAttachment } from "./MediaAttachment";

interface MessageBubbleProps {
  message: WhatsappMessage;
  accentClassName: string;
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

export function MessageBubble({ message, accentClassName }: MessageBubbleProps) {
  const outbound = isOutbound(message.direction);
  const mediaKind = classifyMedia(message);
  const caption = message.message_body?.trim();

  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`flex max-w-[85%] flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 text-sm shadow-sm sm:max-w-sm ${
          outbound ? `${accentClassName} text-white` : "bg-white text-zinc-900"
        }`}
      >
        {mediaKind && <MediaAttachment message={message} kind={mediaKind} outbound={outbound} />}
        {caption && <p className="whitespace-pre-wrap break-words">{caption}</p>}
        {!mediaKind && !caption && <p className="whitespace-pre-wrap break-words text-sm opacity-70">—</p>}
        <p className={`text-right text-[10px] ${outbound ? "text-white/70" : "text-zinc-400"}`}>
          {formatTime(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
