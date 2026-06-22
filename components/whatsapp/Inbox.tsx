"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  businessLabel,
  filterCustomerMessages,
  groupConversations,
  isRealCustomerConversation,
  isSessionConnected,
  matchesSearch,
  resolveRecipientNumber,
  setBusinessDirectory,
  WhatsappMessage,
  WhatsappSession,
} from "@/lib/whatsapp";
import { fetchActiveBusinesses, WhatsappBusinessRow } from "@/lib/businesses";
import {
  fetchUnreadCounts,
  markConversationRead,
  sumUnreadByBusiness,
  unreadByChatId,
  UnreadCount,
} from "@/lib/reads";
import { Sidebar } from "@/components/whatsapp/Sidebar";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import { MessageThread } from "@/components/whatsapp/MessageThread";
import { CustomerPanel } from "@/components/customers/CustomerPanel";
import { CustomerSearch } from "@/components/customers/CustomerSearch";

const POLL_INTERVAL_MS = 5000;

export function Inbox() {
  const [businesses, setBusinesses] = useState<WhatsappBusinessRow[]>([]);
  const [sessions, setSessions] = useState<WhatsappSession[]>([]);
  const [selectedBusinessSlug, setSelectedBusinessSlug] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<UnreadCount[]>([]);
  const pendingChatIdRef = useRef<string | null>(null);

  const loadUnreadCounts = useCallback(async () => {
    try {
      setUnreadCounts(await fetchUnreadCounts());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load unread counts");
    }
  }, []);

  const loadBusinesses = useCallback(async () => {
    try {
      const rows = await fetchActiveBusinesses();
      setBusinesses(rows);
      setBusinessDirectory(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load businesses");
    }
  }, []);

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
    loadBusinesses();
    const interval = setInterval(loadBusinesses, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadBusinesses]);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadSessions]);

  useEffect(() => {
    loadUnreadCounts();
    const interval = setInterval(loadUnreadCounts, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadUnreadCounts]);

  useEffect(() => {
    if (selectedBusinessSlug || sessions.length === 0) return;
    const firstConnected = sessions.find((s) => isSessionConnected(s.status));
    if (firstConnected) {
      setSelectedBusinessSlug(firstConnected.business_slug);
    }
  }, [sessions, selectedBusinessSlug]);

  useEffect(() => {
    if (pendingChatIdRef.current) {
      setSelectedChatId(pendingChatIdRef.current);
      pendingChatIdRef.current = null;
    } else {
      setSelectedChatId(null);
    }
    setSearch("");
    setShowProfile(false);
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
    const grouped = groupConversations(filterCustomerMessages(messages)).filter(
      isRealCustomerConversation
    );
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

  // Mark the open conversation read whenever it's selected, and again any
  // time its last message changes (e.g. a new inbound message arrives while
  // it's still the active chat). Read state lives server-side in
  // conversation_reads (see lib/reads.ts), so this syncs across devices.
  useEffect(() => {
    if (!selectedBusinessSlug || !selectedConversation) return;
    const businessSlug = selectedBusinessSlug;
    const chatId = selectedConversation.chatId;
    const lastReadAt = selectedConversation.lastMessage.timestamp;

    // Optimistic: clear the badge immediately rather than waiting on the
    // next 5s poll.
    setUnreadCounts((prev) => prev.filter((c) => !(c.businessSlug === businessSlug && c.chatId === chatId)));

    markConversationRead(businessSlug, chatId, lastReadAt).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to mark conversation read");
    });
  }, [selectedBusinessSlug, selectedConversation]);

  const businessUnreadCounts = useMemo(() => sumUnreadByBusiness(unreadCounts), [unreadCounts]);
  const chatUnreadCounts = useMemo(
    () => unreadByChatId(unreadCounts, selectedBusinessSlug),
    [unreadCounts, selectedBusinessSlug]
  );

  const mobilePane: "sidebar" | "list" | "thread" = selectedChatId
    ? "thread"
    : selectedBusinessSlug
    ? "list"
    : "sidebar";

  const customerPhoneNumber = selectedConversation
    ? resolveRecipientNumber(selectedConversation.contactNumber, selectedConversation.chatId)
    : null;

  function jumpToConversation(businessSlug: string, chatId: string) {
    setShowCustomerSearch(false);
    if (businessSlug === selectedBusinessSlug) {
      setSelectedChatId(chatId);
      return;
    }
    pendingChatIdRef.current = chatId;
    setSelectedBusinessSlug(businessSlug);
  }

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
        businesses={businesses}
        sessions={sessions}
        selectedBusinessSlug={selectedBusinessSlug}
        onSelect={setSelectedBusinessSlug}
        onOpenCustomerSearch={() => setShowCustomerSearch(true)}
        unreadCounts={businessUnreadCounts}
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
        unreadCounts={chatUnreadCounts}
      />
      <MessageThread
        conversation={selectedConversation}
        businessSlug={selectedBusinessSlug}
        onBack={() => setSelectedChatId(null)}
        onSend={handleSend}
        onToggleProfile={() => setShowProfile((v) => !v)}
        showProfile={showProfile}
        visible={mobilePane === "thread"}
      />
      {showProfile && customerPhoneNumber && (
        <CustomerPanel phoneNumber={customerPhoneNumber} onClose={() => setShowProfile(false)} />
      )}
      {showCustomerSearch && (
        <CustomerSearch
          onClose={() => setShowCustomerSearch(false)}
          onSelectConversation={jumpToConversation}
        />
      )}
    </div>
  );
}
