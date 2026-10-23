"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { aiAgentApi, ConversationView } from "@/lib/aiAgent/client";
import { KnownChat } from "@/lib/knownChats";
import { Badge, Card, formatWhen, inputClass, Notice, secondaryButton } from "@/components/admin/aiAgent/ui";

function isPaused(c: ConversationView): boolean {
  if (c.control !== "human") return false;
  return !c.human_until || new Date(c.human_until).getTime() > Date.now();
}

export function ConversationsPanel({ businessSlug, chats }: { businessSlug: string; chats: KnownChat[] }) {
  const [rows, setRows] = useState<ConversationView[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => new Map(chats.map((c) => [c.chatId, c.contactName || c.contactNumber])), [chats]);

  const load = useCallback(async () => {
    try {
      setRows((await aiAgentApi.listConversations(businessSlug)).conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversations");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  async function control(chatId: string, action: "takeover" | "resume") {
    setBusy(true);
    setError(null);
    try {
      await aiAgentApi.setControl(businessSlug, chatId, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Human takeover" subtitle="A paused chat gets no AI messages. Manual staff messages pause a chat automatically.">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={inputClass}>
            <option value="">Pick a customer to take over…</option>
            {chats
              .filter((c) => !c.isGroup)
              .map((c) => (
                <option key={c.chatId} value={c.chatId}>
                  {c.contactName || c.contactNumber || c.chatId}
                </option>
              ))}
          </select>
          <button type="button" disabled={busy || !pick} className={secondaryButton} onClick={() => control(pick, "takeover")}>
            Take over
          </button>
        </div>
        {rows.length === 0 ? (
          <Notice tone="info">The agent hasn&apos;t seen any conversations yet.</Notice>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {rows.map((c) => {
              const paused = isPaused(c);
              return (
                <li key={c.chat_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-900">{names.get(c.chat_id) ?? c.contact_number ?? c.chat_id}</p>
                    <p className="text-xs text-zinc-500">
                      {paused ? (
                        <span className="text-purple-700">
                          Human {c.human_until ? `until ${formatWhen(c.human_until)}` : "until resumed"} ({c.control_reason})
                        </span>
                      ) : (
                        "AI"
                      )}{" "}
                      · last <Badge value={c.last_decision} /> {formatWhen(c.last_event_at)}
                    </p>
                  </div>
                  <button type="button" disabled={busy} className={secondaryButton} onClick={() => control(c.chat_id, paused ? "resume" : "takeover")}>
                    {paused ? "Resume AI" : "Take over"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
