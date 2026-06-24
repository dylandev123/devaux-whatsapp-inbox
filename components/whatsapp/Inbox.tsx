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
import { fetchActiveBusinessesOrFallback, WhatsappBusinessRow } from "@/lib/businesses";
import { fetchContactDirectory } from "@/lib/customers";
import { ContactNameInfo } from "@/lib/contactName";
import {
  ConversationStatusValue,
  fetchConversationStatuses,
  setConversationStatus,
} from "@/lib/conversationStatus";
import {
  fetchUnreadCounts,
  markConversationRead,
  sumUnreadByBusiness,
  unreadByChatId,
  UnreadCount,
} from "@/lib/reads";
import { logAndDescribeError } from "@/lib/errors";
import { Sidebar } from "@/components/whatsapp/Sidebar";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import { MessageThread } from "@/components/whatsapp/MessageThread";
import { CustomerPanel } from "@/components/customers/CustomerPanel";
import { CustomerSearch } from "@/components/customers/CustomerSearch";

const POLL_INTERVAL_MS = 5000;
const SELECTED_BUSINESS_STORAGE_KEY = "devaux:selectedBusinessSlug";

function readPersistedBusinessSlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SELECTED_BUSINESS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistBusinessSlug(slug: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (slug) {
      window.localStorage.setItem(SELECTED_BUSINESS_STORAGE_KEY, slug);
    } else {
      window.localStorage.removeItem(SELECTED_BUSINESS_STORAGE_KEY);
    }
  } catch {
    // localStorage can throw in some private-browsing modes — non-fatal, just skip persistence.
  }
}

export function Inbox() {
  const [businesses, setBusinesses] = useState<WhatsappBusinessRow[]>([]);
  const [sessions, setSessions] = useState<WhatsappSession[]>([]);
  // Seeded from localStorage so a manually selected business survives a
  // refresh instead of always re-deriving from "first connected session".
  const [selectedBusinessSlug, setSelectedBusinessSlug] = useState<string | null>(
    readPersistedBusinessSlug
  );
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<UnreadCount[]>([]);
  const [contactDirectory, setContactDirectory] = useState<Map<string, ContactNameInfo>>(new Map());
  const [conversationStatuses, setConversationStatuses] = useState<Map<string, ConversationStatusValue>>(
    new Map()
  );
  const [statusFilter, setStatusFilter] = useState<ConversationStatusValue | "All">("Active");
  const pendingChatIdRef = useRef<string | null>(null);
  // Auto-select-first-connected is only allowed to run once per session,
  // regardless of how many times `sessions` re-polls — otherwise a stale
  // closure or transient empty state could yank the user back to whichever
  // business happens to be connected, even after they deliberately picked
  // a different one.
  const hasAutoSelectedRef = useRef(false);

  const loadUnreadCounts = useCallback(async () => {
    try {
      setUnreadCounts(await fetchUnreadCounts());
    } catch (err) {
      // Non-critical: badges just stay at their last known value. Logged in
      // full so the real cause (e.g. a migration that hasn't been run yet)
      // is visible in the console without interrupting the whole inbox with
      // a banner every 5 seconds.
      logAndDescribeError("loadUnreadCounts", err);
    }
  }, []);

  const loadBusinesses = useCallback(async () => {
    const { businesses: rows } = await fetchActiveBusinessesOrFallback();
    setBusinesses(rows);
    setBusinessDirectory(rows);
  }, []);

  const loadContactDirectory = useCallback(async () => {
    try {
      setContactDirectory(await fetchContactDirectory());
    } catch (err) {
      // Non-critical: names just fall back to the raw WhatsApp push name
      // captured on the message itself.
      logAndDescribeError("loadContactDirectory", err);
    }
  }, []);

  const loadConversationStatuses = useCallback(async (businessSlug: string) => {
    try {
      setConversationStatuses(await fetchConversationStatuses(businessSlug));
    } catch (err) {
      // Non-critical: if conversation_status hasn't been migrated yet,
      // every conversation just behaves as "Active" (the default anyway).
      logAndDescribeError("loadConversationStatuses", err);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("whatsapp_sessions")
      .select("business_slug, status, updated_at, last_connected_at")
      .order("business_slug", { ascending: true });
    if (fetchError) {
      setError(logAndDescribeError("loadSessions", fetchError));
      return;
    }
    setSessions(data ?? []);
  }, []);

  const loadMessages = useCallback(async (businessSlug: string) => {
    const { data, error: fetchError } = await supabase
      .from("whatsapp_messages")
      .select(
        "id, business_slug, chat_id, contact_name, contact_number, business_contact_name, direction, message_body, message_type, media_url, created_at, timestamp"
      )
      .eq("business_slug", businessSlug)
      .order("timestamp", { ascending: true })
      .limit(500);
    if (fetchError) {
      setError(logAndDescribeError("loadMessages", fetchError));
      return;
    }
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
    loadContactDirectory();
    const interval = setInterval(loadContactDirectory, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadContactDirectory]);

  useEffect(() => {
    if (!selectedBusinessSlug) {
      setConversationStatuses(new Map());
      return;
    }
    loadConversationStatuses(selectedBusinessSlug);
    const interval = setInterval(() => loadConversationStatuses(selectedBusinessSlug), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedBusinessSlug, loadConversationStatuses]);

  // If a business was restored from localStorage but no longer exists in the
  // active business list (deactivated, or it was a stale value from a
  // different browser profile), drop it so the normal auto-select effect
  // below can take over instead of silently showing an empty conversation list.
  useEffect(() => {
    if (!selectedBusinessSlug || businesses.length === 0) return;
    const stillActive = businesses.some((b) => b.business_slug === selectedBusinessSlug);
    if (!stillActive) {
      setSelectedBusinessSlug(null);
      persistBusinessSlug(null);
    }
  }, [businesses, selectedBusinessSlug]);

  // Auto-select the first connected business, but only as a one-time initial
  // default — never overrides a business the user (or localStorage) already
  // selected, and never re-fires after it has run once.
  useEffect(() => {
    if (hasAutoSelectedRef.current) return;
    if (selectedBusinessSlug || sessions.length === 0) return;
    const firstConnected = sessions.find((s) => isSessionConnected(s.status));
    if (firstConnected) {
      hasAutoSelectedRef.current = true;
      setSelectedBusinessSlug(firstConnected.business_slug);
    }
  }, [sessions, selectedBusinessSlug]);

  useEffect(() => {
    persistBusinessSlug(selectedBusinessSlug);
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
    return groupConversations(filterCustomerMessages(messages)).filter(isRealCustomerConversation);
  }, [messages]);
  const filteredConversations = useMemo(
    () =>
      conversations
        .filter((c) => matchesSearch(c, search))
        .filter((c) => {
          if (statusFilter === "All") return true;
          const status = conversationStatuses.get(c.chatId) ?? "Active";
          return status === statusFilter;
        }),
    [conversations, search, statusFilter, conversationStatuses]
  );
  const selectedConversation = useMemo(
    () => conversations.find((c) => c.chatId === selectedChatId) ?? null,
    [conversations, selectedChatId]
  );

  // Mark the open conversation read whenever it's selected, and again any
  // time its last message actually changes (e.g. a new inbound message
  // arrives while it's still the active chat). Depending on the chat id +
  // timestamp (not the whole `selectedConversation` object) matters: that
  // object is rebuilt from scratch on every 5s message poll even when
  // nothing changed, which was causing this to re-fire — and re-call the
  // mark-read RPC — every 5 seconds instead of only when something real changed.
  const lastMessageTimestamp = selectedConversation?.lastMessage.timestamp ?? null;
  useEffect(() => {
    if (!selectedBusinessSlug || !selectedConversation || !lastMessageTimestamp) return;
    const businessSlug = selectedBusinessSlug;
    const chatId = selectedConversation.chatId;
    const lastReadAt = lastMessageTimestamp;

    // Optimistic: clear the badge immediately rather than waiting on the
    // next 5s poll.
    setUnreadCounts((prev) => prev.filter((c) => !(c.businessSlug === businessSlug && c.chatId === chatId)));

    markConversationRead(businessSlug, chatId, lastReadAt).catch((err) => {
      // Non-critical for the same reason as loadUnreadCounts above: don't
      // interrupt the conversation with a banner over a read-receipt failure.
      logAndDescribeError("markConversationRead", err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBusinessSlug, selectedConversation?.chatId, lastMessageTimestamp]);

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

  function selectBusiness(slug: string) {
    hasAutoSelectedRef.current = true;
    setSelectedBusinessSlug(slug);
  }

  async function handleStatusChange(chatId: string, status: ConversationStatusValue) {
    if (!selectedBusinessSlug) return;
    // Optimistic: update locally first so the row/header reflect the change
    // immediately rather than waiting on the next 5s poll.
    setConversationStatuses((prev) => new Map(prev).set(chatId, status));
    if (status !== "Active" && statusFilter !== "All" && statusFilter !== status && chatId === selectedChatId) {
      setSelectedChatId(null);
    }
    try {
      await setConversationStatus(selectedBusinessSlug, chatId, status);
    } catch (err) {
      setError(logAndDescribeError("handleStatusChange", err));
      loadConversationStatuses(selectedBusinessSlug);
    }
  }

  function jumpToConversation(businessSlug: string, chatId: string) {
    setShowCustomerSearch(false);
    if (businessSlug === selectedBusinessSlug) {
      setSelectedChatId(chatId);
      return;
    }
    pendingChatIdRef.current = chatId;
    selectBusiness(businessSlug);
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
        onSelect={selectBusiness}
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
        contactDirectory={contactDirectory}
        statusByChatId={conversationStatuses}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
      />
      <MessageThread
        conversation={selectedConversation}
        businessSlug={selectedBusinessSlug}
        onBack={() => setSelectedChatId(null)}
        onSend={handleSend}
        onToggleProfile={() => setShowProfile((v) => !v)}
        showProfile={showProfile}
        visible={mobilePane === "thread"}
        contactDirectory={contactDirectory}
        status={selectedChatId ? conversationStatuses.get(selectedChatId) ?? "Active" : "Active"}
        onStatusChange={(status) => selectedChatId && handleStatusChange(selectedChatId, status)}
      />
      {showProfile && customerPhoneNumber && (
        <CustomerPanel
          phoneNumber={customerPhoneNumber}
          businessSlug={selectedBusinessSlug}
          onClose={() => setShowProfile(false)}
        />
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
