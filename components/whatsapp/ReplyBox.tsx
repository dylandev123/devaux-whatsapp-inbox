"use client";

import { useState } from "react";

interface ReplyBoxProps {
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
  accentClassName?: string;
}

export function ReplyBox({ disabled, onSend, accentClassName = "bg-emerald-600" }: ReplyBoxProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-zinc-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled || sending}
          placeholder={disabled ? "Select a conversation to reply" : "Type a message"}
          rows={1}
          className="flex-1 resize-none rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 disabled:bg-zinc-100"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          disabled={disabled || sending || !text.trim()}
          className={`flex-shrink-0 cursor-pointer rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${accentClassName}`}
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </form>
  );
}
