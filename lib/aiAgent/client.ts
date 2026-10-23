// Client-safe: types + fetch helpers for the admin AI Agent page. Every call
// goes through the admin-only /api/ai-agent/* routes; nothing here touches
// Supabase directly or decides anything (decisions live server-side in
// lib/server/aiAgent/decide.ts + lib/aiAgent/engine.ts).

import type { OutboxStatus } from "@/lib/aiAgent/outboxStatus";
import type {
  AgentDecision,
  AgentSettings,
  EscalationPriority,
  KnowledgeKind,
  OrderItem,
  OrderRequestDraft,
} from "@/lib/aiAgent/engine";

export type { AgentBusiness } from "@/lib/aiAgent/businessList";

export interface SettingsResponse {
  settings: AgentSettings & { updated_at: string };
  requiredConfidence: number | null;
  bridgeConfigured: boolean;
  aiKeyConfigured: boolean;
}

export interface SettingsPatch {
  enabled?: boolean;
  mode?: AgentSettings["mode"];
  contactScope?: AgentSettings["contact_scope"];
  autonomy?: number;
  staffGroupJid?: string | null;
  staffGroupName?: string | null;
  /** true when the JID was typed in rather than picked from discovered groups. */
  staffGroupManual?: boolean;
  autoTakeoverMinutes?: number;
  maxAutoRepliesPerHour?: number;
  sendHoldingReply?: boolean;
}

export interface ContactSearchResult {
  chatId: string;
  name: string | null;
  number: string | null;
  isLid: boolean;
  lastMessageAt: string | null;
  rule: "allow" | "exclude" | null;
}
export interface ContactSearchResponse {
  results: ContactSearchResult[];
  total: number;
  manual: { chatId: string; rule: "allow" | "exclude" | null } | null;
  rpcAvailable: boolean;
}
export interface GroupSearchResult {
  chatId: string;
  name: string | null;
  label: string;
  lastSender: string | null;
  lastMessageAt: string | null;
  memberCount: number | null;
}
export interface GroupSearchResponse {
  results: GroupSearchResult[];
  total: number;
  rpcAvailable: boolean;
}

export interface ContactRuleView {
  id: string;
  chat_id: string;
  display_name: string | null;
  rule: "allow" | "exclude";
  created_at: string;
}

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  status: "draft" | "approved" | "archived";
  source: "admin" | "staff_correction" | "import";
  source_ref: string | null;
  expires_at: string | null;
  version: number;
  approved_at: string | null;
  updated_at: string;
}

export interface EscalationView {
  id: string;
  ref_code: string;
  chat_id: string;
  contact_number: string | null;
  customer_name: string | null;
  priority: EscalationPriority;
  status: "open" | "notified" | "answered" | "resolved" | "cancelled";
  reason: string;
  reason_codes: string[];
  customer_message: string | null;
  ai_summary: string | null;
  proposed_reply: string | null;
  context: { order_request?: OrderRequestDraft | null; notes?: { at: string; text: string }[] };
  staff_answer: string | null;
  answered_via: string | null;
  answered_at: string | null;
  created_at: string;
}

export interface ConversationView {
  chat_id: string;
  contact_number: string | null;
  control: "ai" | "human";
  human_until: string | null;
  control_reason: string | null;
  control_changed_at: string | null;
  last_decision: AgentDecision | null;
  last_event_at: string | null;
}

export interface EventView {
  id: string;
  chat_id: string;
  kind: string;
  status: string;
  message_excerpt: string | null;
  decision: AgentDecision | null;
  reason_codes: string[];
  confidence: number | null;
  proposed_reply: string | null;
  mode: string | null;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface OutboxView {
  id: string;
  business_slug: string;
  chat_id: string;
  kind: string;
  to_jid: string;
  body: string;
  status: OutboxStatus;
  event_id: string | null;
  escalation_id: string | null;
  whatsapp_message_id: string | null;
  error: string | null;
  dispatched_at: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface AuditView {
  id: string;
  actor_kind: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
}

export interface LearningCandidate {
  id: string;
  escalation_id: string | null;
  question: string | null;
  staff_answer: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export interface OrderRequestView {
  id: string;
  chat_id: string;
  contact_number: string | null;
  items: OrderItem[];
  delivery_address: string | null;
  delivery_preference: string | null;
  notes: string | null;
  status: "collecting" | "pending_approval" | "approved" | "rejected" | "cancelled";
  updated_at: string;
}

export interface SimulationView {
  gate: { pass: boolean; decision: AgentDecision | null; reasons: string[] };
  decision: AgentDecision;
  reasons: string[];
  reply: string | null;
  draftReply: string | null;
  confidence: number | null;
  requiredConfidence: number | null;
  safeguards: string[];
  knowledgeUsed: { id: string; title: string }[];
  orderRequest: OrderRequestDraft | null;
  orderComplete: boolean;
  wouldSendToCustomer: boolean;
  wouldNotifyStaff: boolean;
  modelError: string | null;
  mode: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const q = (businessSlug: string, extra = "") => `?businessSlug=${encodeURIComponent(businessSlug)}${extra}`;
const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const aiAgentApi = {
  getBusinesses: () =>
    api<{ businesses: import("@/lib/aiAgent/businessList").AgentBusiness[]; sessionsKnown: boolean }>("/api/ai-agent/businesses"),
  getSettings: (b: string) => api<SettingsResponse>(`/api/ai-agent/settings${q(b)}`),
  saveSettings: (b: string, patch: SettingsPatch) =>
    api<{ settings: SettingsResponse["settings"]; requiredConfidence: number | null }>(
      "/api/ai-agent/settings",
      send("PUT", { businessSlug: b, ...patch })
    ),

  listContacts: (b: string) => api<{ rules: ContactRuleView[] }>(`/api/ai-agent/contacts${q(b)}`),
  setContact: (b: string, chatId: string, displayName: string | null, rule: "allow" | "exclude") =>
    api<{ rule: ContactRuleView }>("/api/ai-agent/contacts", send("POST", { businessSlug: b, chatId, displayName, rule })),
  addContactByNumber: (b: string, number: string, rule: "allow" | "exclude") =>
    api<{ rule: ContactRuleView; rules: ContactRuleView[] }>("/api/ai-agent/contacts", send("POST", { businessSlug: b, number, rule })),
  searchContacts: (b: string, query: string) =>
    api<ContactSearchResponse>(`/api/ai-agent/chats${q(b, `&kind=contact&q=${encodeURIComponent(query)}`)}`),
  searchGroups: (b: string, query: string) =>
    api<GroupSearchResponse>(`/api/ai-agent/chats${q(b, `&kind=group&q=${encodeURIComponent(query)}`)}`),
  removeContact: (b: string, chatId: string) =>
    api<{ ok: true }>(`/api/ai-agent/contacts${q(b, `&chatId=${encodeURIComponent(chatId)}`)}`, { method: "DELETE" }),

  listKnowledge: (b: string) => api<{ entries: KnowledgeEntry[] }>(`/api/ai-agent/knowledge${q(b)}`),
  createKnowledge: (
    b: string,
    entry: { kind: KnowledgeKind; title: string; content: string; expiresAt: string | null; approve: boolean }
  ) => api<{ entry: KnowledgeEntry }>("/api/ai-agent/knowledge", send("POST", { businessSlug: b, ...entry })),
  updateKnowledge: (
    b: string,
    id: string,
    action: "update" | "approve" | "archive" | "restore",
    fields: Partial<{ kind: KnowledgeKind; title: string; content: string; expiresAt: string | null }> = {}
  ) => api<{ entry: KnowledgeEntry }>("/api/ai-agent/knowledge", send("PATCH", { businessSlug: b, id, action, ...fields })),

  listEscalations: (b: string, openOnly: boolean) =>
    api<{ escalations: EscalationView[] }>(`/api/ai-agent/escalations${q(b, openOnly ? "&status=open" : "")}`),
  actOnEscalation: (b: string, id: string, action: string, body?: string) =>
    api<{ ok: true; message: string }>("/api/ai-agent/escalations", send("PATCH", { businessSlug: b, id, action, body })),

  listConversations: (b: string) => api<{ conversations: ConversationView[] }>(`/api/ai-agent/conversations${q(b)}`),
  setControl: (b: string, chatId: string, action: "takeover" | "resume", minutes?: number) =>
    api<{ ok: true }>("/api/ai-agent/conversations", send("POST", { businessSlug: b, chatId, action, minutes })),

  listActivity: (b: string) =>
    api<{ events: EventView[]; outbox: OutboxView[]; audit: AuditView[] }>(`/api/ai-agent/activity${q(b)}`),

  listLearning: (b: string) => api<{ candidates: LearningCandidate[] }>(`/api/ai-agent/learning${q(b)}`),
  reviewLearning: (
    b: string,
    id: string,
    action: "approve" | "reject",
    fields: Partial<{ kind: KnowledgeKind; title: string; content: string }> = {}
  ) => api<{ ok: true }>("/api/ai-agent/learning", send("PATCH", { businessSlug: b, id, action, ...fields })),

  listOrderRequests: (b: string) => api<{ requests: OrderRequestView[] }>(`/api/ai-agent/order-requests${q(b)}`),
  reviewOrderRequest: (b: string, id: string, action: "approve" | "reject" | "cancel") =>
    api<{ request: OrderRequestView }>("/api/ai-agent/order-requests", send("PATCH", { businessSlug: b, id, action })),

  simulate: (b: string, text: string, chatId: string | null) =>
    api<SimulationView>("/api/ai-agent/test", send("POST", { businessSlug: b, text, chatId })),
};
