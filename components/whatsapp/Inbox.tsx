"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  businessLabel,
  filterCustomerMessages,
  groupConversations,
  historyWindowCutoffIso,
  isSessionConnected,
  matchesSearch,
  mergeMessages,
  resolveConversationPhone,
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
  fetchHiddenChatIds,
  InboxFilterValue,
  setConversationHidden,
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

// Shared by both the polled window (whole business, newest-first) and
// "scroll up for older messages" pagination (one conversation at a time) —
// see loadMessages()/loadOlderMessages() below. Skips the whole `raw`
// column deliberately (see the comment on loadMessages further down).
const MESSAGE_SELECT =
  "id, business_slug, chat_id, contact_name, contact_number, business_contact_name, direction, message_body, message_type, media_url, created_at, timestamp, sender_participant:raw->key->>participant, sender_participant_pn:raw->key->>participantPn, sender_push_name:raw->>pushName, sender_pn:raw->key->>senderPn, reaction_text:raw->message->reactionMessage->>text, protocol_type:raw->message->protocolMessage->>type";

// Business-wide poll cap — bounded well above what MESSAGE_HISTORY_WINDOW_DAYS
// (7 days) needs for typical traffic, while still never fetching the whole
// table. If a single business ever exceeds this many messages within 7
// days, its oldest conversations in that window fall back to being reached
// via "scroll up for older messages" (loadOlderMessages) instead of showing
// up in the list immediately — same tradeoff the old flat 500 cap already
// made, just against a much larger, date-bounded ceiling.
const MESSAGE_POLL_LIMIT = 1500;

// Page size for "scroll up for older messages" pagination, per conversation.
const OLDER_MESSAGES_PAGE_SIZE = 100;

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
  const [messagesLoading, setMessagesLoading] = useState(false);
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
  const [hiddenChatIds, setHiddenChatIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<InboxFilterValue>("Active");
  // "Scroll up for older messages" pagination state — see loadOlderMessages
  // below. Per-chat so switching conversations doesn't block pagination in
  // whichever one is currently open.
  const [olderLoadingChatId, setOlderLoadingChatId] = useState<string | null>(null);
  const [olderExhaustedChatIds, setOlderExhaustedChatIds] = useState<Set<string>>(new Set());
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

  const loadHiddenChatIds = useCallback(async (businessSlug: string) => {
    try {
      setHiddenChatIds(await fetchHiddenChatIds(businessSlug));
    } catch (err) {
      // Non-critical: if the `hidden` column hasn't been migrated yet,
      // every conversation just behaves as not-hidden (the default anyway).
      logAndDescribeError("loadHiddenChatIds", err);
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
    // Ordered newest-first so `limit(MESSAGE_POLL_LIMIT)` caps to the most
    // recent messages instead of the oldest — a business past that many
    // total messages would otherwise never see new messages appear, since
    // an ascending order+limit always returns the same oldest slice.
    // Bounded to the last MESSAGE_HISTORY_WINDOW_DAYS on top of that, so the
    // conversation list surfaces at least a week of activity rather than
    // whatever a high-traffic business's most recent N messages happen to
    // span. Reversed back to ascending afterwards since every consumer
    // (groupConversations' lastMessage tracking, MessageThread's render
    // order) assumes oldest-first. Group-sender identity, the real @lid
    // phone number, and bubble-text fallbacks (reaction/deleted-message
    // text) are all pulled as lightweight JSON-path selects rather than
    // selecting the whole `raw` column — `raw` is the full Baileys payload,
    // including inline base64 media thumbnails on some rows, and fetching
    // that on every 5s poll would badly bloat this request.
    const { data, error: fetchError } = await supabase
      .from("whatsapp_messages")
      .select(MESSAGE_SELECT)
      .eq("business_slug", businessSlug)
      .gte("timestamp", historyWindowCutoffIso())
      .order("timestamp", { ascending: false })
      .limit(MESSAGE_POLL_LIMIT);
    if (fetchError) {
      setError(logAndDescribeError("loadMessages", fetchError));
      return;
    }
    // Merge rather than replace: a plain replace here would wipe out any
    // older history "scroll up for older messages" (loadOlderMessages
    // below) had already loaded, since that history falls outside this
    // query's own window/limit. See mergeMessages' comment in lib/whatsapp.ts.
    setMessages((prev) => mergeMessages(prev, (data ?? []).slice().reverse()));
  }, []);

  // "Scroll up for older messages" pagination for the currently open
  // conversation — the poll above only ever covers the last
  // MESSAGE_HISTORY_WINDOW_DAYS/MESSAGE_POLL_LIMIT window, business-wide;
  // this fetches one older page for a single chat, further back within the
  // same 7-day floor, and merges it in (see mergeMessages). A chat that's
  // already reached the 7-day floor (or simply has no more messages) stops
  // being queried on every subsequent scroll.
  const loadOlderMessages = useCallback(async (businessSlug: string, chatId: string, before: string) => {
    setOlderLoadingChatId(chatId);
    try {
      const { data, error: fetchError } = await supabase
        .from("whatsapp_messages")
        .select(MESSAGE_SELECT)
        .eq("business_slug", businessSlug)
        .eq("chat_id", chatId)
        .lt("timestamp", before)
        .gte("timestamp", historyWindowCutoffIso())
        .order("timestamp", { ascending: false })
        .limit(OLDER_MESSAGES_PAGE_SIZE);
      if (fetchError) {
        setError(logAndDescribeError("loadOlderMessages", fetchError));
        return;
      }
      const rows = data ?? [];
      if (rows.length < OLDER_MESSAGES_PAGE_SIZE) {
        // Fewer than a full page means we've hit either the real start of
        // this conversation or the 7-day floor — either way, nothing more
        // to fetch for this chat.
        setOlderExhaustedChatIds((prev) => new Set(prev).add(chatId));
      }
      if (rows.length > 0) {
        setMessages((prev) => mergeMessages(prev, rows.slice().reverse()));
      }
    } finally {
      setOlderLoadingChatId((prev) => (prev === chatId ? null : prev));
    }
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

  useEffect(() => {
    if (!selectedBusinessSlug) {
      setHiddenChatIds(new Set());
      return;
    }
    loadHiddenChatIds(selectedBusinessSlug);
    const interval = setInterval(() => loadHiddenChatIds(selectedBusinessSlug), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedBusinessSlug, loadHiddenChatIds]);

  // One-time deep-link support for links like /?business=X&chat=Y (used by
  // the AI analysis dashboard's "Open conversation" links). Reads
  // window.location directly rather than next/navigation's useSearchParams,
  // which would require wrapping this client component in a Suspense
  // boundary — this only ever needs to run once, after mount, so a plain
  // effect is simpler. Takes priority over both localStorage and
  // auto-select-first-connected (jumpToConversation -> selectBusiness sets
  // hasAutoSelectedRef, so that effect won't override it below). Cleans the
  // query string afterward so a later refresh doesn't keep re-triggering it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const business = params.get("business");
    const chat = params.get("chat");
    if (!business || !chat) return;
    jumpToConversation(business, chat);
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Reset on every business switch (including to none) — loadMessages now
    // merges into whatever's already in `messages` (see mergeMessages) so
    // pagination survives the 5s poll, which means a stale previous
    // business's messages must be cleared explicitly here rather than
    // relying on the old plain-replace behavior to do it implicitly.
    setMessages([]);
    setOlderLoadingChatId(null);
    setOlderExhaustedChatIds(new Set());
    if (!selectedBusinessSlug) {
      setMessagesLoading(false);
      return;
    }
    setMessagesLoading(true);
    loadMessages(selectedBusinessSlug).finally(() => setMessagesLoading(false));
    const interval = setInterval(() => loadMessages(selectedBusinessSlug), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedBusinessSlug, loadMessages]);

  // Every conversation for the selected business is shown — including ones
  // with only outbound (business-initiated) messages, since those are real
  // conversations too. Read state ("Unread") and team status ("Active" /
  // "Archived" / "Spam") are separate concerns from search, so each gets its
  // own filter pass below.
  const conversations = useMemo(() => {
    return groupConversations(filterCustomerMessages(messages));
  }, [messages]);
  const businessUnreadCounts = useMemo(() => sumUnreadByBusiness(unreadCounts), [unreadCounts]);
  const chatUnreadCounts = useMemo(
    () => unreadByChatId(unreadCounts, selectedBusinessSlug),
    [unreadCounts, selectedBusinessSlug]
  );
  const filteredConversations = useMemo(
    () =>
      conversations
        .filter((c) => matchesSearch(c, search))
        .filter((c) => {
          // Hidden is independent of Active/Archived/Spam (see
          // supabase/migrations/20260902000000_conversation_hidden.sql): a
          // hidden conversation is excluded from every other filter, and the
          // "Hidden" filter shows only hidden ones, regardless of status.
          const isHidden = hiddenChatIds.has(c.chatId);
          if (statusFilter === "Hidden") return isHidden;
          if (isHidden) return false;
          if (statusFilter === "All") return true;
          if (statusFilter === "Unread") return (chatUnreadCounts[c.chatId] ?? 0) > 0;
          const status = conversationStatuses.get(c.chatId) ?? "Active";
          return status === statusFilter;
        }),
    [conversations, search, statusFilter, conversationStatuses, chatUnreadCounts, hiddenChatIds]
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

  const mobilePane: "sidebar" | "list" | "thread" = selectedChatId
    ? "thread"
    : selectedBusinessSlug
    ? "list"
    : "sidebar";

  const customerPhoneNumber = selectedConversation
    ? resolveRecipientNumber(selectedConversation.contactNumber, selectedConversation.chatId)
    : null;
  // CustomerPanel's "phone" row needs the *real* number when this contact
  // uses WhatsApp's @lid privacy mode — contact_number/chat_id alone only
  // ever carry the opaque lid id, but resolveConversationPhone recovers the
  // actual MSISDN from senderPn on the conversation's own messages when
  // one's available (customers.phone_number, used for the lookup key above,
  // is deliberately left as whatever the bridge wrote — this is display-only).
  const { phone: customerDisplayPhone, isLid: customerIsLid } = selectedConversation
    ? resolveConversationPhone(
        selectedConversation.contactNumber,
        selectedConversation.chatId,
        selectedConversation.messages
      )
    : { phone: null, isLid: false };

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

  async function handleHiddenChange(chatId: string, hidden: boolean) {
    if (!selectedBusinessSlug) return;
    // Optimistic, same pattern as handleStatusChange above.
    setHiddenChatIds((prev) => {
      const next = new Set(prev);
      if (hidden) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
    if (hidden && statusFilter !== "Hidden" && chatId === selectedChatId) {
      setSelectedChatId(null);
    }
    try {
      await setConversationHidden(selectedBusinessSlug, chatId, hidden);
    } catch (err) {
      setError(logAndDescribeError("handleHiddenChange", err));
      loadHiddenChatIds(selectedBusinessSlug);
    }
  }

  function handleLoadOlderMessages() {
    if (!selectedBusinessSlug || !selectedConversation) return;
    const chatId = selectedConversation.chatId;
    if (olderLoadingChatId || olderExhaustedChatIds.has(chatId)) return;
    const oldest = selectedConversation.messages[0]?.timestamp;
    if (!oldest) return;
    loadOlderMessages(selectedBusinessSlug, chatId, oldest);
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
        loading={messagesLoading}
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
        isHidden={selectedChatId ? hiddenChatIds.has(selectedChatId) : false}
        onToggleHidden={() =>
          selectedChatId && handleHiddenChange(selectedChatId, !hiddenChatIds.has(selectedChatId))
        }
        onLoadOlderMessages={handleLoadOlderMessages}
        loadingOlderMessages={Boolean(selectedChatId) && olderLoadingChatId === selectedChatId}
        hasMoreOlderMessages={Boolean(selectedChatId) && !olderExhaustedChatIds.has(selectedChatId ?? "")}
      />
      {showProfile && customerPhoneNumber && (
        <CustomerPanel
          phoneNumber={customerPhoneNumber}
          isLid={customerIsLid}
          displayPhone={customerDisplayPhone}
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
