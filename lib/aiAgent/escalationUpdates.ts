// Smart escalation updates — pure, no I/O. One open escalation per unresolved issue keeps a
// structured picture of what the customer currently wants (RequestSnapshot). Each customer turn
// moves the picture forward (nextSnapshot) and staff are told only about what MATERIALLY changed
// since the last notice they were sent (diffSnapshots). The server layer
// (lib/server/aiAgent/decide.ts) persists the snapshot and posts the notice atomically.
//
// Nothing here invents anything. Items, quantities and addresses can only come from the customer's
// own words (groundOrderDraft checks the model's order draft against them); questions and
// unstructured messages are kept verbatim. Acknowledgements, repeats and duplicates change nothing.

import type { EscalationPriority, OrderItem, OrderRequestDraft } from "./engine.ts";

// ── Text helpers ─────────────────────────────────────────────────────────────

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Lower-case words and digits only, single-spaced: the comparison form of any customer text. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/([a-z])(\d)|(\d)([a-z])/g, "$1$3 $2$4").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => normalizeText(a ?? "") === normalizeText(b ?? "");

// ── Trivial messages ─────────────────────────────────────────────────────────

// Words that, on their own, add nothing for staff. Deliberately excludes "yes", "no" and "sure":
// those can answer a question and must reach staff.
const ACK_WORDS = new Set(
  (
    "thanks thank thankyou thx ty tysm you so very much a lot appreciate appreciated it that cheers " +
    "ok okay okey k kk cool great perfect nice good awesome noted alright all right got will do np welcome " +
    "hi hii hey heyy hello helo hola bonjour morning afternoon evening night day bye goodbye later please pls"
  ).split(" ")
);

/** "thanks", "ok", "hello", "👍" and the like: nothing for staff to act on. Media is never trivial (decided by the caller). */
export function isTrivialMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = normalizeText(t).replace(/\bno problem\b/g, "np").split(" ").filter(Boolean);
  if (words.length === 0) return true; // punctuation / emoji only
  return words.length <= 8 && words.every((w) => ACK_WORDS.has(w));
}

export function isTrivialTurn(segments: string[]): boolean {
  const real = segments.filter((s) => s.trim());
  return real.length > 0 && real.every(isTrivialMessage);
}

const CANCELLATION =
  /\b(cancel\w*|call (it|that|the order) off|never ?mind|forget (it|about (it|the order)|the order)|(don'?t|do not|no longer) (want|need) (it|that|this|the order|them)( any ?more)?)\b/i;

/** The customer is withdrawing the request. */
export function isCancellation(text: string): boolean {
  return CANCELLATION.test(text);
}

const QUESTION_START =
  /^(what|which|who|whom|whose|when|where|why|how|do you|does|did|can|could|would|will|is|are|am|have you|has|any|got|may i|should)\b/i;

/** The customer's own question sentences, verbatim (clipped), in order. Nothing is paraphrased. */
export function extractQuestions(segments: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    for (const sentence of segment.split(/(?<=[.!?])\s+|\n+/)) {
      const s = sentence.replace(/\s+/g, " ").trim();
      if (!s || isTrivialMessage(s)) continue;
      if (!(s.includes("?") || QUESTION_START.test(s))) continue;
      const key = normalizeText(s);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(clip(s, 160));
    }
  }
  return out;
}

// ── The structured picture of the request ────────────────────────────────────

export interface RequestSnapshot {
  items: OrderItem[];
  delivery_address: string | null;
  delivery_preference: string | null;
  notes: string | null;
  /** Customer questions, verbatim, oldest first. */
  questions: string[];
  /** Customer messages that matter but could not be structured (verbatim). */
  other: string[];
  cancelled: boolean;
}

export const EMPTY_SNAPSHOT: RequestSnapshot = {
  items: [],
  delivery_address: null,
  delivery_preference: null,
  notes: null,
  questions: [],
  other: [],
  cancelled: false,
};

const MAX_QUESTIONS = 6;
const MAX_OTHER = 4;

const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const strList = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(-max) : [];

/** Reads a stored snapshot (escalation.notified_snapshot) defensively: unknown shapes become empty fields. */
export function parseSnapshot(value: unknown): RequestSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return {
    items: Array.isArray(v.items)
      ? v.items
          .map((i) => ({ product: strOrNull((i as OrderItem)?.product) ?? "", quantity: strOrNull((i as OrderItem)?.quantity) }))
          .filter((i) => i.product)
      : [],
    delivery_address: strOrNull(v.delivery_address),
    delivery_preference: strOrNull(v.delivery_preference),
    notes: strOrNull(v.notes),
    questions: strList(v.questions, MAX_QUESTIONS),
    other: strList(v.other, MAX_OTHER),
    cancelled: v.cancelled === true,
  };
}

/** The picture an escalation's `context` currently holds (order_request, questions, other_messages, cancelled). */
export function snapshotFromContext(context: Record<string, unknown> | null | undefined): RequestSnapshot {
  const c = context ?? {};
  const order = (c.order_request ?? null) as Partial<OrderRequestDraft> | null;
  return (
    parseSnapshot({
      items: order?.items ?? [],
      delivery_address: order?.delivery_address,
      delivery_preference: order?.delivery_preference,
      notes: order?.notes,
      questions: c.questions,
      other: c.other_messages,
      cancelled: c.cancelled,
    }) ?? EMPTY_SNAPSHOT
  );
}

/** The context fields that carry a snapshot (merged into escalation.context by the server layer). */
export function contextFromSnapshot(s: RequestSnapshot): Record<string, unknown> {
  return {
    order_request:
      s.items.length > 0 || s.delivery_address || s.delivery_preference || s.notes
        ? { items: s.items, delivery_address: s.delivery_address, delivery_preference: s.delivery_preference, notes: s.notes }
        : null,
    questions: s.questions,
    other_messages: s.other,
    cancelled: s.cancelled,
  };
}

function mergeUnique(existing: string[], added: string[], max: number): string[] {
  const out = [...existing];
  const seen = new Set(existing.map(normalizeText));
  for (const a of added) {
    const key = normalizeText(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(-max);
}

export interface TurnFacts {
  /** The individual customer messages of this turn (a batch is several). */
  segments: string[];
  /** The cumulative, grounded order request after this turn, if there is one. */
  orderRequest: OrderRequestDraft | null;
  /** A cancellation safeguard fired for this turn. */
  cancellation: boolean;
  /** The model's reading of the turn, when it ran and produced one. */
  modelIntent: "question" | "order" | "complaint" | "smalltalk" | "other" | null;
}

const MEDIA_PLACEHOLDER = "(media message without text)";

/** Moves the picture forward by one customer turn. Trivial messages, repeats and duplicates change nothing. */
export function nextSnapshot(prev: RequestSnapshot, facts: TurnFacts): RequestSnapshot {
  const substantive = facts.segments
    .map((s) => (s === MEDIA_PLACEHOLDER ? "📎 Sent a photo, file or voice note" : s))
    .filter((s) => s.trim() && !isTrivialMessage(s));
  const order = facts.orderRequest;
  const structured: Pick<RequestSnapshot, "items" | "delivery_address" | "delivery_preference" | "notes"> = order
    ? {
        items: order.items.length > 0 ? order.items : prev.items,
        delivery_address: order.delivery_address ?? prev.delivery_address,
        delivery_preference: order.delivery_preference ?? prev.delivery_preference,
        notes: order.notes ?? prev.notes,
      }
    : { items: prev.items, delivery_address: prev.delivery_address, delivery_preference: prev.delivery_preference, notes: prev.notes };

  const questions = mergeUnique(prev.questions, extractQuestions(substantive), MAX_QUESTIONS);
  const cancelled = prev.cancelled || facts.cancellation || substantive.some(isCancellation);
  const next: RequestSnapshot = { ...structured, questions, other: prev.other, cancelled };

  // A message that changed nothing structured still matters unless the model read it as small
  // talk: staff see it verbatim rather than the agent guessing what it meant.
  const orderChanged = diffSnapshots(prev, next).some((c) => ORDER_CHANGE_KINDS.includes(c.kind) || c.kind === "note_changed");
  if (!orderChanged && facts.modelIntent !== "smalltalk") {
    // Anything already reflected in the picture (a repeat of "3 chickens" the order already says) is not news.
    const vocab = new Set(
      [
        ...next.items.flatMap((i) => [i.product, i.quantity ?? ""]),
        next.delivery_address ?? "",
        next.delivery_preference ?? "",
        next.notes ?? "",
        ...next.questions,
        ...prev.other,
      ].flatMap(significant)
    );
    const unstructured = substantive.filter(
      (s) => !isCancellation(s) && extractQuestions([s]).length === 0 && !(significant(s).length > 0 && coverage(s, vocab) >= 0.8)
    );
    next.other = mergeUnique(prev.other, unstructured.map((s) => clip(s, 160)), MAX_OTHER);
  }
  return next;
}

// ── What changed ─────────────────────────────────────────────────────────────

export type ChangeKind =
  | "cancelled"
  | "item_added"
  | "item_removed"
  | "quantity_changed"
  | "address_changed"
  | "delivery_changed"
  | "note_changed"
  | "question_added"
  | "message_added";

export interface Change {
  kind: ChangeKind;
  text: string;
}

/** Changes that alter the ORDER itself (as opposed to a new question or message). */
export const ORDER_CHANGE_KINDS: readonly ChangeKind[] = [
  "cancelled",
  "item_added",
  "item_removed",
  "quantity_changed",
  "address_changed",
  "delivery_changed",
];

export const productKey = (p: string) =>
  normalizeText(p)
    .split(" ")
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w))
    .join(" ");

/** Everything in `next` that staff have not been told yet, given the picture they last saw. Empty = nothing to say. */
export function diffSnapshots(prev: RequestSnapshot, next: RequestSnapshot): Change[] {
  const changes: Change[] = [];
  if (!prev.cancelled && next.cancelled) changes.push({ kind: "cancelled", text: "Customer wants to CANCEL" });

  const before = new Map(prev.items.map((i) => [productKey(i.product), i]));
  const after = new Map(next.items.map((i) => [productKey(i.product), i]));
  for (const [key, item] of after) {
    const old = before.get(key);
    if (!old) changes.push({ kind: "item_added", text: `Added: ${item.quantity ? `${clip(item.quantity, 30)} × ` : ""}${clip(item.product, 100)}${item.quantity ? "" : " (qty not given)"}` });
    else if (!sameText(old.quantity, item.quantity) && item.quantity) {
      changes.push({
        kind: "quantity_changed",
        text: `Quantity changed: ${clip(item.product, 100)} ${old.quantity ? clip(old.quantity, 30) : "?"} → ${clip(item.quantity, 30)}`,
      });
    }
  }
  for (const [key, item] of before) if (!after.has(key) && next.items.length > 0) changes.push({ kind: "item_removed", text: `Removed: ${clip(item.product, 100)}` });

  if (next.delivery_address && !sameText(prev.delivery_address, next.delivery_address)) {
    changes.push({ kind: "address_changed", text: `Delivery address ${prev.delivery_address ? "changed to" : "given"}: ${clip(next.delivery_address, 150)}` });
  }
  if (next.delivery_preference && !sameText(prev.delivery_preference, next.delivery_preference)) {
    changes.push({ kind: "delivery_changed", text: `Delivery ${prev.delivery_preference ? "changed to" : "requested"}: ${clip(next.delivery_preference, 100)}` });
  }
  if (next.notes && !sameText(prev.notes, next.notes)) changes.push({ kind: "note_changed", text: `Note: ${clip(next.notes, 150)}` });

  const knownQuestions = new Set(prev.questions.map(normalizeText));
  for (const q of next.questions) if (!knownQuestions.has(normalizeText(q))) changes.push({ kind: "question_added", text: `New question: “${q}”` });
  const knownOther = new Set(prev.other.map(normalizeText));
  for (const o of next.other) if (!knownOther.has(normalizeText(o))) changes.push({ kind: "message_added", text: `New message: “${o}”` });
  return changes;
}

/** A cancellation may skip the batching quiet period: staff should stop work as early as possible. */
export const isUrgentChange = (changes: Change[]) => changes.some((c) => c.kind === "cancelled");

// ── Keeping the model honest ─────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", dozen: "12", fifteen: "15", twenty: "20", a: "1", an: "1", single: "1", half: "0.5",
};
const STOP = new Set("the and for with from that this have you your our can please would like want need get some any are was were has had not but".split(" "));

const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);
const wordsOf = (text: string) => normalizeText(text).split(" ").filter(Boolean);

function significant(text: string): string[] {
  return wordsOf(text).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)).map(stem);
}

/** Share (0..1) of the text's significant words that the customer actually wrote. */
function coverage(text: string, corpus: Set<string>): number {
  const sig = significant(text);
  if (sig.length === 0) return 0;
  return sig.filter((w) => corpus.has(w)).length / sig.length;
}

function quantityGrounded(quantity: string, corpus: Set<string>, corpusDigits: Set<string>): boolean {
  const words = wordsOf(quantity);
  const numeric = words.filter((w) => /^\d+(\.\d+)?$/.test(w) || w in NUMBER_WORDS).map((w) => NUMBER_WORDS[w] ?? w);
  if (numeric.length > 0) return numeric.every((n) => corpusDigits.has(n));
  return words.map(stem).every((w) => corpus.has(w));
}

/**
 * Drops from the model's order draft anything the customer never said: a product none of whose
 * words appear in their messages, a quantity they did not state, an address or delivery time
 * they did not give. Where the draft disagrees with `prior`, an ungrounded value falls back to
 * the prior one (or null). `customerTexts` is the customer's own words only — never staff or AI text.
 */
export function groundOrderDraft(
  draft: OrderRequestDraft | null,
  prior: OrderRequestDraft | null,
  customerTexts: string[]
): OrderRequestDraft | null {
  if (!draft) return null;
  const corpusWords = customerTexts.flatMap(wordsOf);
  const corpus = new Set(corpusWords.map(stem));
  const corpusDigits = new Set(corpusWords.map((w) => NUMBER_WORDS[w] ?? w).filter((w) => /^\d+(\.\d+)?$/.test(w)));
  const priorItems = new Map((prior?.items ?? []).map((i) => [productKey(i.product), i]));

  const items: OrderItem[] = [];
  for (const item of draft.items) {
    const known = priorItems.get(productKey(item.product));
    if (!known && coverage(item.product, corpus) < 0.5) continue; // never said: not an order line
    let quantity = item.quantity;
    if (quantity && !(known && sameText(known.quantity, quantity)) && !quantityGrounded(quantity, corpus, corpusDigits)) {
      quantity = known?.quantity ?? null;
    }
    // Variant and size (daily order tracking) are kept only when the customer wrote them.
    const detail = (value: string | null | undefined, was: string | null | undefined) =>
      value && (sameText(value, was) || coverage(value, corpus) >= 0.5) ? value : (was ?? null);
    const variant = detail(item.variant, known?.variant);
    const size = detail(item.size, known?.size);
    items.push({ product: item.product, quantity, ...(variant ? { variant } : {}), ...(size ? { size } : {}) });
  }
  const text = (value: string | null, was: string | null) => {
    if (!value || sameText(value, was)) return value ?? was;
    return coverage(value, corpus) >= 0.5 ? value : was;
  };
  const requestedFor = text(draft.requested_for ?? null, prior?.requested_for ?? null);
  return {
    items,
    delivery_address: text(draft.delivery_address, prior?.delivery_address ?? null),
    delivery_preference: text(draft.delivery_preference, prior?.delivery_preference ?? null),
    notes: text(draft.notes, prior?.notes ?? null),
    ...(requestedFor ? { requested_for: requestedFor } : {}),
  };
}

// ── The staff-group update message ───────────────────────────────────────────

export interface StaffUpdateInput {
  refCode: string;
  priority: EscalationPriority;
  customerLabel: string;
  /** The picture as it is NOW (complete, not just the delta). */
  current: RequestSnapshot;
  changes: Change[];
  /** Staff already replied to this escalation before this change. */
  afterStaffReply: boolean;
  /** Observe mode: nothing reaches the customer. */
  observeOnly?: boolean;
  /** Approval Pilot: nothing is sent until an authorized person sends; the earlier AI suggestion may be out of date. */
  pilot?: boolean;
  /** Approval Pilot: the AI's fresh suggestion for the customer's latest message (the draft staff can now approve). */
  draft?: { version: number; body: string; ready: boolean; notes: string[] } | null;
  /** The customer's latest message, shown with a suggestion so staff see what is being answered. */
  latestMessage?: string | null;
}

const MAX_SHOWN_CHANGES = 6;
const MAX_SHOWN_LINES = 12;

/** The lines of "Current request": the complete picture, structured first, then the customer's own words. */
export function currentRequestLines(s: RequestSnapshot): string[] {
  const lines: string[] = [];
  for (const item of s.items.slice(0, 8)) lines.push(`${clip(item.product, 100)} — ${item.quantity ? `qty ${clip(item.quantity, 30)}` : "qty not given"}`);
  if (s.delivery_address) lines.push(`Address: ${clip(s.delivery_address, 150)}`);
  if (s.delivery_preference) lines.push(`Delivery: ${clip(s.delivery_preference, 100)}`);
  if (s.notes) lines.push(`Note: ${clip(s.notes, 150)}`);
  for (const q of s.questions.slice(-4)) lines.push(`Asks: “${q}”`);
  for (const o of s.other.slice(-3)) lines.push(`Said: “${o}”`);
  if (s.cancelled) lines.push("⚠️ Customer wants to CANCEL");
  return lines.length > 0 ? lines.slice(0, MAX_SHOWN_LINES) : ["(no details captured — see the dashboard)"];
}

function updateActions(changes: Change[], current: RequestSnapshot, afterStaffReply: boolean): string[] {
  const kinds = new Set(changes.map((c) => c.kind));
  const actions: string[] = [];
  if (kinds.has("cancelled")) actions.push("Confirm the cancellation with the customer and stop any preparation or delivery");
  else {
    if (ORDER_CHANGE_KINDS.some((k) => kinds.has(k))) actions.push("Check availability and price for the updated order, then confirm it with the customer");
    if (kinds.has("question_added")) actions.push("Answer the customer's new question(s)");
    if (kinds.has("message_added") || kinds.has("note_changed")) actions.push("Read the customer's new message and respond");
  }
  if (afterStaffReply) actions.push("Review your earlier reply — it may no longer apply (any unsent draft is out of date)");
  if (actions.length === 0 && current.items.length > 0) actions.push("Review the updated request");
  return actions.length > 0 ? actions : ["Review and respond to the customer"];
}

/**
 * Approval Pilot: the customer wrote again before staff acted. The AI has answered the NEW state of the conversation,
 * so the update carries that suggestion; approving it (quote this message, or include the code) sends exactly that text.
 */
function buildPilotUpdateWithDraft(input: StaffUpdateInput, draft: NonNullable<StaffUpdateInput["draft"]>): string {
  const lines = [`🔁 Update on #${input.refCode} · ${input.priority.toUpperCase()} · ${clip(input.customerLabel, 60)}`];
  if (input.latestMessage) lines.push(`Customer: “${clip(input.latestMessage, 220)}”`);
  if (input.afterStaffReply) lines.push("⚠️ Customer changed this AFTER staff replied");
  const shown = input.changes.slice(0, 4);
  lines.push("", "*What changed*", ...shown.map((c) => `• ${c.text}`));
  if (input.changes.length > shown.length) lines.push(`• (+${input.changes.length - shown.length} more in the dashboard)`);
  lines.push("", "*Request so far* (NOT confirmed)", ...currentRequestLines(input.current).slice(0, 6).map((l) => `• ${l}`));
  lines.push(
    "",
    draft.ready ? `🤖 New AI suggestion v${draft.version} — ✅ customer-ready` : `🤖 New AI suggestion v${draft.version} — ⚠️ confirm the facts before sending`,
    `“${clip(draft.body, 500)}”`
  );
  if (!draft.ready) for (const n of draft.notes) lines.push(`• ${n}`);
  lines.push(
    "",
    `Reply to this message (or include #${input.refCode}): !approve · !edit <text> · !send <text> · !reject · !status · !teach <fact> · !close`,
    draft.ready ? "The earlier suggestion is out of date. Nothing is sent until an authorized person sends." : "The earlier suggestion is out of date. Unconfirmed drafts need “!approve confirm”. Nothing is sent until an authorized person sends."
  );
  return lines.join("\n");
}

/** Concise update for the staff group: reference, who, what changed, the complete current request, what to do. */
export function buildStaffUpdate(input: StaffUpdateInput): string {
  if (input.pilot && input.draft) return buildPilotUpdateWithDraft(input, input.draft);
  const shown = input.changes.slice(0, MAX_SHOWN_CHANGES);
  const more = input.changes.length - shown.length;
  const lines = [`🔁 Update on #${input.refCode} · ${input.priority.toUpperCase()}`, `👤 ${clip(input.customerLabel, 80)}`];
  if (input.afterStaffReply) lines.push("⚠️ Customer changed this AFTER staff replied");
  lines.push("", "*What changed*", ...shown.map((c) => `• ${c.text}`));
  if (more > 0) lines.push(`• (+${more} more in the dashboard)`);
  lines.push("", "*Current request* (NOT confirmed)", ...currentRequestLines(input.current).map((l) => `• ${l}`));
  lines.push("", "*Action needed*", ...updateActions(input.changes, input.current, input.afterStaffReply).map((a) => `• ${a}`));
  if (input.pilot) {
    lines.push(
      "",
      `↩️ Reply to this message (or include #${input.refCode}). Any earlier AI draft is out of date and can't be approved — write a new one with !edit <text>.`,
      "Commands: !edit <text> · !send <text> · !status · !teach <fact> · !note <text> · !close"
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    input.observeOnly
      ? `👀 Observe mode: nothing is sent to the customer. Reply to this message (or include #${input.refCode}) with your answer — I'll record it and post a draft reply you can copy.`
      : `↩️ Reply to this message (or include #${input.refCode}). Nothing goes to the customer unless you reply "send".`,
    "Commands: !note <text> · !send <text> · !close · !takeover · !resume"
  );
  return lines.join("\n");
}
