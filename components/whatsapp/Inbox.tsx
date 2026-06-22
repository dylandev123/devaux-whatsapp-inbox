"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  businessLabel,
  groupConversations,
  isSessionConnected,
  matchesSearch,
  resolveRecipientNumber,
  WhatsappMessage,
  WhatsappSession,
} from "@/lib/whatsapp";
import { Sidebar } from "@/components/whatsapp/Sidebar";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import { MessageThread } from "@/components/whatsapp/MessageThread";

const POLL_INTERVAL_MS = 5000;

export function Inbox() {
  const [sessions, setSessions] = useState<WhatsappSession[]>([]);
  const [selectedBusinessSlug, setSelectedBusinessSlug] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("whatsapp_sessions")
      .select("business_slug, status, updated_at, last_connected_at")
      .order("business_slug", { ascending: true });
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setSessions(data ?? []);
  }, []);

  const loadMessages = useCallback(async (businessSlug: string) => {
    const { data, error: fetchError } = await supabase
      .from("whatsapp_messages")
      .select(
        "id, business_slug, chat_id, contact_name, contact_number, direction, message_body, message_type, media_url, created_at, timestamp"
      )
      .eq("business_slug", businessSlug)
      .order("timestamp", { ascending: true })
      .limit(500);
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    console.log("Loaded messages", businessSlug, data);
    setMessages(data ?? []);
  }, []);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadSessions]);

  useEffect(() => {
    if (selectedBusinessSlug || sessions.length === 0) return;
    const firstConnected = sessions.find((s) => isSessionConnected(s.status));
    if (firstConnected) {
      setSelectedBusinessSlug(firstConnected.business_slug);
    }
  }, [sessions, selectedBusinessSlug]);

  useEffect(() => {
    setSelectedChatId(null);
    setSearch("");
  }, [selectedBusinessSlug]);

  useEffect(() => {
    if (!selectedBusinessSlug) {
      setMessages([]);
      return;
    }
    loadMessages(selectedBusinessSlug);
    const interval = setInterval(() => loadMessages(selectedBusinessSlug), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedBusinessSlug, loadMessages]);

  const conversations = useMemo(() => {
    const grouped = groupConversations(messages);
    console.log("Grouped conversations", grouped);
    return grouped;
  }, [messages]);
  const filteredConversations = useMemo(
    () => conversations.filter((c) => matchesSearch(c, search)),
    [conversations, search]
  );
  const selectedConversation = useMemo(
    () => conversations.find((c) => c.chatId === selectedChatId) ?? null,
    [conversations, selectedChatId]
  );

  const mobilePane: "sidebar" | "list" | "thread" = selectedChatId
    ? "thread"
    : selectedBusinessSlug
    ? "list"
    : "sidebar";

  async function handleSend(text: string) {
    if (!selectedBusinessSlug || !selectedConversation) return;
    const to = resolveRecipientNumber(
      selectedConversation.contactNumber,
      selectedConversation.chatId
    );
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessSlug: selectedBusinessSlug,
        to,
        body: text,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? "Failed to send message");
    }
    await loadMessages(selectedBusinessSlug);
  }

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-zinc-50 text-zinc-900">
      {error && (
        <div className="absolute inset-x-0 top-0 z-10 bg-red-600 px-4 py-2 text-center text-sm text-white">
          {error}
        </div>
      )}
      <Sidebar
        sessions={sessions}
        selectedBusinessSlug={selectedBusinessSlug}
        onSelect={setSelectedBusinessSlug}
        visible={mobilePane === "sidebar"}
      />
      <ConversationList
        conversations={filteredConversations}
        selectedChatId={selectedChatId}
        onSelect={setSelectedChatId}
        search={search}
        onSearchChange={setSearch}
        selectedBusinessSlug={selectedBusinessSlug}
        businessLabel={selectedBusinessSlug ? businessLabel(selectedBusinessSlug) : ""}
        onBack={() => setSelectedBusinessSlug(null)}
        visible={mobilePane === "list"}
        hasBusiness={Boolean(selectedBusinessSlug)}
      />
      <MessageThread
        conversation={selectedConversation}
        onBack={() => setSelectedChatId(null)}
        onSend={handleSend}
        visible={mobilePane === "thread"}
      />
    </div>
  );
}
