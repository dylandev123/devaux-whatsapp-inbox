// Client-safe: types + fetch helpers for the admin AI Agent page. Every call
// goes through the admin-only /api/ai-agent/* routes; nothing here touches
// Supabase directly or decides anything (decisions live server-side in
// lib/server/aiAgent/decide.ts + lib/aiAgent/engine.ts).

import type { CustomerMode } from "@/lib/aiAgent/customerMode";
import type { EditableOrderField, OrderStatus, TrackedOrder } from "@/lib/aiAgent/orders";
import type { OutboxState, OutboxStatus } from "@/lib/aiAgent/outboxStatus";
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
  staffNoticesEnabled?: boolean;
  batchingEnabled?: boolean;
  batchQuietSeconds?: number;
  batchMaxWaitSeconds?: number;
  customerMemoryEnabled?: boolean;
  /** Phone numbers (or exact …@lid ids) allowed to send customer replies from the staff group. */
  staffAuthorizedSenders?: string[];
  /** Handling mode of every customer without their own setting. */
  defaultCustomerMode?: CustomerMode;
  /** Passive learning from authorized staff messages: off, the staff group only, or also the business's own customer chats. */
  passiveLearningScope?: NonNullable<AgentSettings["passive_learning_scope"]>;
  /** Authorized senders may confirm knowledge candidates with !confirm. */
  knowledgeConfirmViaWhatsapp?: boolean;
  /** Daily orders: extract orders from conversations into the Orders tab. */
  ordersTrackingEnabled?: boolean;
  /** Daily orders: the 8 AM summary and the !update command. */
  ordersSummaryEnabled?: boolean;
  /** null = post in the staff group. */
  ordersGroupJid?: string | null;
  ordersGroupName?: string | null;
  ordersGroupManual?: boolean;
  ordersTimezone?: string;
  ordersSummaryHour?: number;
  /** Rollout safety: false = a customer's yes is only recorded; staff verify and confirm. */
  ordersCustomerConfirms?: boolean;
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
  context: {
    order_request?: OrderRequestDraft | null;
    notes?: { at: string; text: string }[];
    /** Why the first staff notice was not posted (no_staff_group, staff_notices_disabled). */
    notice_skipped?: string;
    /** Set when a staff answer was recorded but not relayed (the agent's mode at the time). */
    answer_not_relayed?: string;
    /** Verified-history lines shown to staff in the notice (confirmed orders, customer-stated facts). */
    history?: string[];
    /** Customer messages added after the escalation opened (kept even when no second notice is posted). */
    updates?: { at: string; text: string }[];
    /** What the customer asked, verbatim, and whether they withdrew the request. */
    questions?: string[];
    cancelled?: boolean;
    /** Set when staff had already answered and the customer then changed the order. */
    reopened_at?: string;
  };
  /** How many staff notices (first notice + updates) were queued. */
  notified_seq?: number;
  staff_answer: string | null;
  answered_via: string | null;
  answered_at: string | null;
  created_at: string;
  /** Used as `basedOn` when sending: the version of the escalation the admin is looking at. */
  updated_at: string;
  /** Staff notices and relays for this escalation, newest first, with derived delivery state. */
  deliveries: EscalationDelivery[];
  /** What staff said in the group or dashboard, newest first, and what became of it. */
  answers: StaffAnswerView[];
}

export interface StaffAnswerItemView {
  category: "durable" | "temporary" | "customer_specific" | "one_off";
  disposition: "candidate" | "candidate_conflict" | "already_known" | "temporary" | "customer_memory" | "recorded_only" | "skipped";
  title: string;
  content: string;
  validUntil?: string | null;
  note?: string;
}

export interface StaffAnswerView {
  id: string;
  source: "whatsapp" | "admin_ui";
  command: "answer" | "send";
  body: string;
  staff_message_at: string | null;
  created_at: string;
  state: "processing" | "done" | "failed";
  /** Why processing failed (state = failed). */
  error: string | null;
  retry_count: number;
  draft: string | null;
  customer_action: "sent" | "withheld" | null;
  withheld_reason: string | null;
  items: StaffAnswerItemView[];
}

export interface EscalationDelivery {
  id: string;
  kind: string;
  state: OutboxState;
  error: string | null;
  created_at: string;
  sent_at: string | null;
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
  /** The customer's own handling mode; null = the business default. */
  customer_mode: CustomerMode | null;
}

/** One customer's AI state, for the Inbox conversation view. */
export interface CustomerAiState {
  agentEnabled: boolean;
  agentMode: AgentSettings["mode"];
  customerMode: CustomerMode;
  ownMode: CustomerMode | null;
  defaultMode: CustomerMode;
  control: "ai" | "human";
  humanUntil: string | null;
  openEscalation: { refCode: string; priority: EscalationPriority } | null;
}

export interface EventView {
  id: string;
  chat_id: string;
  kind: string;
  status: string;
  message_excerpt: string | null;
  /** BATCHED: the message is waiting in (or was decided with) a batch. */
  decision: AgentDecision | "BATCHED" | null;
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
  details?: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityDiagnostics {
  bridgeSecretConfigured: boolean;
  enabled: boolean;
  mode: string | null;
  contactScope: string | null;
  staffGroupConfigured: boolean;
  eventsLast24h: number;
  lastEventAt: string | null;
  bridgeFailuresLast24h: number;
  contacts: { chatId: string; name: string | null; rule: "allow" | "exclude"; isLid: boolean; phone: string | null }[];
}

export interface KnowledgeConflictView {
  id: string;
  title: string;
  content: string;
  severity: "conflict" | "related";
  reason: string;
}

export interface LearningCandidate {
  id: string;
  escalation_id: string | null;
  question: string | null;
  staff_answer: string;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  /** Where the suggestion came from; 'staff_answer' = a staff answer to an escalation. */
  source?: "staff_answer" | "whatsapp_teach" | "passive_staff_group" | "passive_staff_chat";
  /** false = from the business account's own messages: nobody can say who wrote it. */
  sender_verified?: boolean;
  /** The code staff use in WhatsApp (!confirm K-XXXX). */
  short_code?: string | null;
  /** Set for a temporary fact: the knowledge entry created from it expires then. */
  fact_expires_at?: string | null;
  proposal_expires_at?: string | null;
  /** 'durable' = a classified permanent fact; 'staff_answer' = a legacy raw answer. */
  category: string;
  suggested_kind: KnowledgeKind | null;
  suggested_title: string | null;
  /** The staff's words this was learned from, when, and the escalation reference. */
  source_message: string | null;
  source_message_at: string | null;
  ref_code: string | null;
  /** Approved entries this overlaps, recomputed against today's knowledge. */
  conflicts: KnowledgeConflictView[];
  duplicate_of?: { id: string; title: string } | null;
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

export interface MemoryOrderView {
  id: string;
  summary: string;
  status: string | null;
  at: string | null;
  products: string[];
  quantity: string | null;
  address: string | null;
  excluded: boolean;
  /** Staff-processed (Added / Completed). Everything else is an unconfirmed request. */
  verified: boolean;
}

export interface MemoryFactView {
  id: string;
  kind: "preference" | "delivery_preference" | "resolved_issue" | "note";
  source: "customer_stated" | "staff_confirmed" | "admin";
  content: string;
  evidence: string | null;
  expires_at: string | null;
  updated_at: string;
  customer_key: string;
}

export interface CustomerMemoryView {
  identity: { chatId: string; phone: string | null; chatIds: string[]; unresolvedLid: boolean };
  customerKey: string;
  orders: MemoryOrderView[];
  facts: MemoryFactView[];
  inferences: Record<string, string>;
  openOrderRequests: { id: string; status: string; items: unknown; updated_at: string }[];
}

export interface MemoryCustomerListItem {
  customerKey: string;
  chatId: string;
  facts: number;
  updatedAt: string;
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
  customerMode?: CustomerMode;
}

/** One pending request in the dashboard's approvals queue (see lib/server/aiAgent/approvals.ts). */
export interface ApprovalItemView {
  escalationId: string;
  refCode: string;
  customerName: string | null;
  contactNumber: string | null;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestMessage: string;
  messageCount: number;
  draft: { id: string; version: number; body: string; ready: boolean; notes: string[]; source: "ai" | "staff_edit" | "staff_answer"; createdAt: string } | null;
  stale: boolean;
}

export interface BackfillRunView {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  hours: number;
  chats_total: number;
  chats_done: number;
  messages_analysed: number;
  orders_touched: number;
  failures: number;
  note: string | null;
  started_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** An order plus the best name the Inbox knows (staff-entered, saved contact, then WhatsApp profile name). */
export type OrderView = TrackedOrder & { display_name?: string | null; name_source?: "staff" | "saved" | "profile" | null };
export interface OrderRunView {
  id: string;
  trigger: "scheduled" | "manual";
  local_date: string;
  status: "claimed" | "queued" | "missed" | "skipped";
  skip_reason: string | null;
  attempts: number;
  confirmed_count: number | null;
  attention_count: number | null;
  carried_count: number | null;
  created_at: string;
  delivery: OutboxState | null;
  sent_at: string | null;
}
export interface OrderEventView {
  id: string;
  kind: string;
  actor_kind: string;
  actor_id: string | null;
  changes: Record<string, { before?: unknown; after?: unknown }>;
  whatsapp_message_ids: string[];
  created_at: string;
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
  listOrders: (b: string, status: "open" | "all" | OrderStatus, query: string) =>
    api<{ orders: OrderView[]; runs: OrderRunView[]; coverage: import("@/lib/aiAgent/orders").Coverage }>(`/api/ai-agent/orders${q(b, `&status=${status}&q=${encodeURIComponent(query)}`)}`),
  orderEvents: (b: string, orderId: string) => api<{ events: OrderEventView[] }>(`/api/ai-agent/orders${q(b, `&orderId=${encodeURIComponent(orderId)}`)}`),
  updateOrder: (
    b: string,
    orderId: string,
    action: "edit" | "confirm" | "cancel" | "fulfil" | "keep",
    extra: { version: number; patch?: Partial<Record<EditableOrderField, unknown>>; conflictFields?: string[]; reason?: string }
  ) => api<{ order: OrderView }>("/api/ai-agent/orders", send("PATCH", { businessSlug: b, orderId, action, ...extra })),
  sendOrderSummary: (b: string) => api<{ ok: true }>("/api/ai-agent/orders", send("POST", { businessSlug: b })),
  listApprovals: (b: string) => api<{ mode: string; items: ApprovalItemView[] }>(`/api/ai-agent/approvals${q(b)}`),
  /** One request at a time: there is no bulk approval. `draftId` is the draft the admin was looking at. */
  actOnApproval: (
    b: string,
    escalationId: string,
    action: "approve" | "edit" | "reject" | "moreinfo",
    extra: { draftId?: string; confirm?: boolean; text?: string; reason?: string } = {}
  ) => api<{ ok: true; message: string; text?: string; draftId?: string }>("/api/ai-agent/approvals", send("POST", { businessSlug: b, escalationId, action, ...extra })),
  listBackfills: (b: string) => api<{ runs: BackfillRunView[] }>(`/api/ai-agent/orders/backfill${q(b)}`),
  startBackfill: (b: string, hours: number) => api<{ run: BackfillRunView }>("/api/ai-agent/orders/backfill", send("POST", { businessSlug: b, action: "start", hours })),
  stepBackfill: (b: string, runId: string) => api<{ run: BackfillRunView }>("/api/ai-agent/orders/backfill", send("POST", { businessSlug: b, action: "continue", runId })),
  cancelBackfill: (b: string, runId: string) => api<{ run: BackfillRunView }>("/api/ai-agent/orders/backfill", send("POST", { businessSlug: b, action: "cancel", runId })),
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
  /** `basedOn` = the escalation's updated_at as displayed; a send is refused if the customer wrote after it. */
  actOnEscalation: (b: string, id: string, action: string, body?: string, basedOn?: string) =>
    api<{ ok: true; message: string }>("/api/ai-agent/escalations", send("PATCH", { businessSlug: b, id, action, body, basedOn })),
  retryStaffAnswer: (b: string, answerId: string) =>
    api<{ ok: true; message: string; queued: number }>("/api/ai-agent/escalations/retry", send("POST", { businessSlug: b, answerId })),

  listConversations: (b: string) => api<{ conversations: ConversationView[] }>(`/api/ai-agent/conversations${q(b)}`),
  setControl: (b: string, chatId: string, action: "takeover" | "resume", minutes?: number) =>
    api<{ ok: true }>("/api/ai-agent/conversations", send("POST", { businessSlug: b, chatId, action, minutes })),
  getCustomerState: (b: string, chatId: string) =>
    api<CustomerAiState>(`/api/ai-agent/conversations${q(b, `&chatId=${encodeURIComponent(chatId)}`)}`),
  /** `mode: null` returns the customer to the business default. */
  setCustomerMode: (b: string, chatId: string, mode: CustomerMode | null) =>
    api<{ ok: true }>("/api/ai-agent/conversations", send("POST", { businessSlug: b, chatId, action: "set_mode", mode })),

  listActivity: (b: string) =>
    api<{ events: EventView[]; outbox: OutboxView[]; audit: AuditView[]; diagnostics: ActivityDiagnostics }>(`/api/ai-agent/activity${q(b)}`),

  listLearning: (b: string) => api<{ candidates: LearningCandidate[] }>(`/api/ai-agent/learning${q(b)}`),
  reviewLearning: (
    b: string,
    id: string,
    action: "approve" | "reject",
    fields: Partial<{ kind: KnowledgeKind; title: string; content: string; resolution: "replace" | "keep_both"; replaceKnowledgeId: string }> = {}
  ) => api<{ ok: true }>("/api/ai-agent/learning", send("PATCH", { businessSlug: b, id, action, ...fields })),

  listOrderRequests: (b: string) => api<{ requests: OrderRequestView[] }>(`/api/ai-agent/order-requests${q(b)}`),
  reviewOrderRequest: (b: string, id: string, action: "approve" | "reject" | "cancel") =>
    api<{ request: OrderRequestView }>("/api/ai-agent/order-requests", send("PATCH", { businessSlug: b, id, action })),

  listMemoryCustomers: (b: string) => api<{ customers: MemoryCustomerListItem[] }>(`/api/ai-agent/memory${q(b)}`),
  getMemory: (b: string, chatId: string) =>
    api<{ memory: CustomerMemoryView }>(`/api/ai-agent/memory${q(b, `&chatId=${encodeURIComponent(chatId)}`)}`),
  addMemoryFact: (b: string, chatId: string, kind: "preference" | "delivery_preference" | "note", content: string) =>
    api<{ fact: MemoryFactView }>("/api/ai-agent/memory", send("POST", { businessSlug: b, chatId, action: "add_fact", kind, content })),
  updateMemoryFact: (b: string, chatId: string, id: string, content: string) =>
    api<{ fact: MemoryFactView }>("/api/ai-agent/memory", send("PATCH", { businessSlug: b, chatId, action: "update_fact", id, content })),
  deleteMemoryFact: (b: string, chatId: string, id: string) =>
    api<{ ok: true }>("/api/ai-agent/memory", send("DELETE", { businessSlug: b, chatId, id })),
  setOrderExcluded: (b: string, chatId: string, orderId: string, excluded: boolean) =>
    api<{ ok: true }>("/api/ai-agent/memory", send("PATCH", { businessSlug: b, chatId, action: excluded ? "exclude_order" : "include_order", orderId })),
  clearInference: (b: string, chatId: string, fields: string[]) =>
    api<{ ok: true }>("/api/ai-agent/memory", send("PATCH", { businessSlug: b, chatId, action: "clear_inference", fields })),
  forgetCustomer: (b: string, chatId: string, opts: { includeOrders: boolean; includeLogs: boolean }) =>
    api<{ result: Record<string, number> }>("/api/ai-agent/memory", send("POST", { businessSlug: b, chatId, action: "forget", confirm: "DELETE", ...opts })),

  getEvaluation: (b: string, filters: { kind?: string; rating?: string } = {}) =>
    api<import("@/lib/aiAgent/evaluation").EvaluationResponse>(
      `/api/ai-agent/evaluation${q(b, `${filters.kind ? `&kind=${filters.kind}` : ""}${filters.rating ? `&rating=${filters.rating}` : ""}`)}`
    ),
  rateEvaluation: (b: string, id: string, rating: import("@/lib/aiAgent/evaluation").ShadowRating | null, feedback: string | null) =>
    api<{ ok: true }>("/api/ai-agent/evaluation", send("PATCH", { businessSlug: b, id, rating, feedback })),
  setEvaluationCapture: (b: string, enabled: boolean) =>
    api<{ ok: true; enabled: boolean }>("/api/ai-agent/evaluation", send("PUT", { businessSlug: b, enabled })),
  overridePilotVerdict: (b: string, escalationId: string, verdict: "correct" | "missing_information" | "factually_wrong", reason: string) =>
    api<{ ok: true }>("/api/ai-agent/evaluation/verdict", send("POST", { businessSlug: b, escalationId, verdict, reason })),
  testAgain: (b: string, escalationId: string) =>
    api<import("@/lib/aiAgent/evaluation").SimulationOutcome>("/api/ai-agent/evaluation/simulate", send("POST", { businessSlug: b, escalationId })),
  simulateTurn: (b: string, eventId: string) =>
    api<import("@/lib/aiAgent/evaluation").SimulationOutcome>("/api/ai-agent/evaluation/simulate", send("POST", { businessSlug: b, eventId })),

  simulate: (b: string, text: string, chatId: string | null) =>
    api<SimulationView>("/api/ai-agent/test", send("POST", { businessSlug: b, text, chatId })),
};
