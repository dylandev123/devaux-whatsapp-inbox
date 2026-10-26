// Approval Pilot and WhatsApp business learning — the pure rules (no I/O), so every one of them is
// unit-testable (tests/aiAgentApprovalPilot.test.ts). The server side (lib/server/aiAgent/pilot.ts,
// teach.ts) loads data and applies these; it never decides anything here differently.
//
// Approval Pilot: the AI NEVER messages a customer by itself. It proposes a draft, staff see it in the
// staff group, and only an explicitly authorized sender's !approve / !send reaches the customer — through
// the same central send policy as Assisted mode (planCustomerSend in lib/server/aiAgent/customerSend.ts).

import { checkReplySafety, detectPromptInjection, type KnowledgeFact, type ModelProposal } from "./engine.ts";
import { extractQuestions, isCancellation, isTrivialTurn } from "./escalationUpdates.ts";
import { statesTemporaryCondition } from "./staffAnswers.ts";

// ── Commands ─────────────────────────────────────────────────────────────────

/** Commands that act on one escalation's draft. */
export const DRAFT_COMMANDS = ["approve", "edit", "reject", "moreinfo"] as const;
/** Commands about the business's knowledge (and read-only status); they need no escalation. */
export const BUSINESS_COMMANDS = ["teach", "confirm", "discard", "status"] as const;
export type PilotCommand = (typeof DRAFT_COMMANDS)[number] | (typeof BUSINESS_COMMANDS)[number];

/** "!more info" and "!more-info" are read as "!moreinfo". */
export const MORE_INFO_SPELLING = /^!more[\s-]+info\b/i;

const PILOT_COMMAND_PATTERN = new RegExp(`^!(${[...DRAFT_COMMANDS, ...BUSINESS_COMMANDS].join("|")})\\b\\s*`, "i");

/** A message that STARTS with one of the pilot commands (never one that merely mentions it). */
export function parsePilotCommand(text: string): { command: PilotCommand; body: string } | null {
  const stripped = text.replace(/\s+/g, " ").trim().replace(MORE_INFO_SPELLING, "!moreinfo");
  const m = stripped.match(PILOT_COMMAND_PATTERN);
  if (!m) return null;
  return { command: m[1].toLowerCase() as PilotCommand, body: stripped.slice(m[0].length).trim() };
}

/** `!approve`, `!approve v2`, `!approve confirm`, `!approve v2 confirm`. Anything else is refused, never guessed. */
export function parseApproveArgs(body: string): { ok: true; version: number | null; confirm: boolean } | { ok: false } {
  let version: number | null = null;
  let confirm = false;
  for (const token of body.toLowerCase().split(" ").filter(Boolean)) {
    const v = token.match(/^v?(\d{1,3})$/);
    if (v && version === null) version = Number(v[1]);
    else if (token === "confirm" && !confirm) confirm = true;
    else return { ok: false };
  }
  return { ok: true, version, confirm };
}

export type RejectVerdict = "factually_wrong" | "missing_information";

/** `!reject`, `!reject wrong <why>`, `!reject missing <what>`, `!reject <why>`. */
export function parseRejectArgs(body: string): { verdict: RejectVerdict | null; note: string | null } {
  const m = body.match(/^(wrong|incorrect|missing)\b[\s:,-]*(.*)$/i);
  if (!m) return { verdict: null, note: body.trim().slice(0, 500) || null };
  return { verdict: m[1].toLowerCase() === "missing" ? "missing_information" : "factually_wrong", note: m[2].trim().slice(0, 500) || null };
}

/** `!edit <text>` or `!edit v2 <text>` (the version the editor is looking at). */
export function parseEditArgs(body: string): { version: number | null; text: string } {
  const m = body.match(/^v(\d{1,3})\s+(.+)$/i);
  return m ? { version: Number(m[1]), text: m[2].trim() } : { version: null, text: body.trim() };
}

/**
 * Approval Pilot: does this customer turn need NO reply at all? Thanks, an acknowledgement, small talk with no question.
 * Never when the turn carries anything staff may need to act on: an order or an order change, a cancellation, a
 * complaint or other safeguard topic, or a question. Conservative: when unsure, staff get the request.
 */
export function pilotNoReplyNeeded(input: {
  trivialTurn: boolean;
  intent: string | null;
  safeguards: string[];
  hasOrderRequest: boolean;
  segments: string[];
}): boolean {
  if (input.safeguards.length > 0 || input.hasOrderRequest) return false;
  if (input.segments.some(isCancellation)) return false;
  if (input.trivialTurn || isTrivialTurn(input.segments)) return true;
  return input.intent === "smalltalk" && extractQuestions(input.segments).length === 0;
}

// ── Draft readiness: customer-ready, or needs factual confirmation ───────────

export interface DraftReadiness {
  /** True = every claim in the draft is backed by approved knowledge and nothing sensitive is involved. */
  ready: boolean;
  /** Plain-language reasons staff should check first (empty when ready). At most 4. */
  notes: string[];
}

const NOTE_TEXT: Record<string, string> = {
  unverified_answer: "No approved knowledge backs this answer",
  unverified_price: "A price in the draft is not in approved knowledge",
  unverified_link: "A link in the draft is not in approved knowledge",
  unsafe_commitment: "It promises stock, delivery, payment or a refund — check that's true",
  credential_leak: "It contains something that looks like a secret",
  reply_too_long: "It is too long for a WhatsApp reply",
  model_escalated: "The AI wasn't sure it could answer",
  model_uncertain: "The AI wasn't sure it could answer",
  low_confidence: "The AI was not confident",
  order_approval: "Stock, total and delivery for this order still need confirming",
  collecting_order_details: "The order is missing details",
  open_escalation: "Staff are already handling this customer",
  sensitive: "Sensitive request (complaint, refund, discount, payment…) — read the whole message",
  unsupported_commitment: "It promises something your reply didn't say",
  draft_needs_review: "It mentions details that weren't in your reply",
  unverified_stock: "It says something is in stock or available — approved knowledge doesn't say so",
  unverified_schedule: "It states a day or time (delivery, opening…) that approved knowledge doesn't contain",
  unverified_offer: "It mentions a discount, free delivery or similar offer that approved knowledge doesn't contain",
  knowledge_changed: "Knowledge this draft relied on was changed or has expired since it was written",
};

/**
 * Reason codes that describe the situation, not a risk in the draft. Every Approval Pilot request is "handled by staff",
 * and a draft that only asks the customer for the next missing order detail states no fact that needs checking
 * (prices, stock, times and offers are still checked on their own). The missing details are listed in the notice.
 */
export const INFORMATIONAL_CODES = new Set(["verified_answer", "open_escalation", "collecting_order_details"]);

const STOCK_CLAIM =
  /\b(in stock|out of stock|sold out|back in stock|restocked|available|availability|(?:we|i)(?:'ve| have| got| still have| carry)\b(?!\s+(?:noted|added|changed|updated|passed|recorded|made|put|written|taken|logged|set)\b)[^.!?]{0,40}\b(?:it|them|that|some|plenty|enough|left|ready)|\d+\s+(?:left|remaining|in stock)|plenty (?:of|left)|ready (?:for|to) (?:pick ?up|collect))\b/i;
const SCHEDULE_CLAIM =
  /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|this (?:morning|afternoon|evening|week)|next week|within \d+\s?(?:hours?|days?|mins?|minutes?)|same[- ]day)\b/gi;
const OFFER_CLAIM = /\b(free (?:delivery|shipping)|discount|\d+\s?% off|special offer|promo(?:tion)?|buy one get one|bogo)\b/i;

/**
 * Business facts a draft asserts that the given source texts (the knowledge the AI cited, or the staff's own
 * words) do not contain: stock/availability, a day or time, an offer. Deterministic and free. Prices and links
 * are checked separately (engine.checkReplySafety). A claim is supported only when the sources state it too.
 */
export function unsupportedClaimCodes(reply: string, sources: string[]): string[] {
  const corpus = sources.join("\n");
  const codes: string[] = [];
  if (STOCK_CLAIM.test(reply) && !STOCK_CLAIM.test(corpus)) codes.push("unverified_stock");
  const lc = corpus.toLowerCase().replace(/\s+/g, "");
  const scheduled = Array.from(reply.matchAll(SCHEDULE_CLAIM), (m) => m[0].toLowerCase().replace(/\s+/g, ""));
  if (scheduled.some((t) => !lc.includes(t))) codes.push("unverified_schedule");
  if (OFFER_CLAIM.test(reply) && !OFFER_CLAIM.test(corpus)) codes.push("unverified_offer");
  return codes;
}

/** Notes about facts that approved knowledge does not contain (a knowledge gap), as opposed to other risks. */
const GAP_NOTES = new Set(
  ["unverified_answer", "unverified_price", "unverified_link", "unverified_stock", "unverified_schedule", "unverified_offer", "knowledge_changed"].map((c) => NOTE_TEXT[c])
);

/** Splits readiness notes into "not in approved knowledge" and "other reasons to be careful". */
export function splitNotes(notes: string[]): { gaps: string[]; risks: string[] } {
  return { gaps: notes.filter((n) => GAP_NOTES.has(n)), risks: notes.filter((n) => !GAP_NOTES.has(n)) };
}

/** Staff-readable notes for reason/safety codes (unknown codes are dropped, never shown raw). */
export function noteTexts(codes: string[]): string[] {
  return Array.from(new Set(codes.map((c) => NOTE_TEXT[c]).filter((t): t is string => Boolean(t)))).slice(0, 4);
}

/**
 * Whether the AI's own draft is customer-ready. Uses only what the live pipeline already produced (the
 * proposal, the approved knowledge it saw, the engine's reason codes) — no extra model call.
 */
export function assessDraftReadiness(input: {
  reply: string;
  proposal: Pick<ModelProposal, "decision" | "knowledge_ids" | "confidence"> | null;
  activeKnowledge: KnowledgeFact[];
  safeguardCodes: string[];
  reasonCodes: string[];
  requiredConfidence: number;
}): DraftReadiness {
  const notes = new Set<string>();
  const p = input.proposal;
  if (!p || p.decision === "ESCALATE") notes.add("model_escalated");
  if (input.safeguardCodes.length > 0) notes.add("sensitive");

  const activeIds = new Set(input.activeKnowledge.map((k) => k.id));
  const cited = input.activeKnowledge.filter((k) => p?.knowledge_ids.includes(k.id));
  if (p && p.decision === "REPLY" && (p.knowledge_ids.length === 0 || p.knowledge_ids.some((id) => !activeIds.has(id)))) notes.add("unverified_answer");
  for (const code of checkReplySafety(input.reply, cited)) notes.add(code);
  for (const code of unsupportedClaimCodes(input.reply, cited.map((k) => k.content))) notes.add(code);
  if (p && Number.isFinite(input.requiredConfidence) && p.confidence < input.requiredConfidence) notes.add("low_confidence");
  for (const code of input.reasonCodes) if (code in NOTE_TEXT && !INFORMATIONAL_CODES.has(code)) notes.add(code);

  const ordered = Array.from(notes).map((c) => NOTE_TEXT[c] ?? c);
  return { ready: ordered.length === 0, notes: Array.from(new Set(ordered)).slice(0, 4) };
}

// ── Evaluation: was the AI right? ────────────────────────────────────────────

export type DraftVerdict = "correct" | "missing_information" | "factually_wrong";

const MONEY = /(?:EC\$|US\$|XCD\s?|\$)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:EC|XCD|USD|dollars?)\b/gi;
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi;

function figures(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MONEY)) out.add(`$${Number((m[1] ?? m[2]).replace(/,/g, ""))}`);
  for (const m of text.matchAll(TIME)) out.add(m[0].toLowerCase().replace(/\s/g, ""));
  return out;
}

/**
 * What the staff change says about the AI's draft, from the draft and the final text alone (deterministic,
 * free): same text → correct; a price or time in the draft that the final text dropped or changed →
 * factually wrong; a price or time the final text adds that the draft never had → missing information;
 * a wording-only change tells us nothing (null — an admin or the staff can set it).
 */
export function inferVerdict(original: string, final: string): DraftVerdict | null {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").trim();
  if (norm(original) === norm(final)) return "correct";
  const a = figures(original);
  const b = figures(final);
  if ([...a].some((x) => !b.has(x))) return "factually_wrong";
  if ([...b].some((x) => !a.has(x))) return "missing_information";
  return null;
}

// ── Staff-group wording ──────────────────────────────────────────────────────


function clip(value: string | null | undefined, max: number): string {
  const t = (value ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The commands a notice shows. The advanced ones (!send, !status, !teach, !confirm, !close) still work; they are just not repeated every time. */
export const NOTICE_COMMANDS = "!approve · !edit <text> · !reject · !moreinfo";
export const NOTICE_COMMANDS_CONFIRM = "!approve confirm · !edit <text> · !reject · !moreinfo";
export const NOTICE_COMMANDS_NO_DRAFT = "!send <text> · !moreinfo";

/** The most warnings a notice carries: only what a person must act on before approving. */
export const MAX_NOTICE_WARNINGS = 2;

/** The few warnings a notice carries: urgent flags first, then why a draft is not customer-ready. At most two, short, nothing technical. */
export function noticeWarnings(draft: { ready: boolean; notes: string[] } | null, extra: string[] = []): string[] {
  const out = [...extra];
  if (draft && !draft.ready) out.push(...draft.notes);
  return out.map((w) => clip(w, 90)).filter(Boolean).slice(0, MAX_NOTICE_WARNINGS);
}

export interface PilotNoticeInput {
  refCode: string;
  customerLabel: string;
  /** The customer's messages, oldest first. */
  messages: string[];
  draft: { version: number; body: string; ready: boolean; notes: string[] } | null;
  /** Essential, actionable warnings only. Everything else is in the dashboard and in !moreinfo. */
  warnings?: string[];
}

function commandLine(draft: PilotNoticeInput["draft"]): string {
  return !draft ? NOTICE_COMMANDS_NO_DRAFT : draft.ready ? NOTICE_COMMANDS : NOTICE_COMMANDS_CONFIRM;
}

/**
 * The primary staff message in Approval Pilot, deliberately short: who, what the customer said, the AI's exact
 * suggestion (what !approve would send, word for word), the few warnings that matter, and the commands.
 */
export function buildPilotNotice(input: PilotNoticeInput): string {
  const shown = input.messages.length > 0 ? input.messages : ["(no text)"];
  const lines = [`#${input.refCode} · ${clip(input.customerLabel, 60)}`, "", `Customer: “${clip(shown[shown.length - 1], 220)}”`, ""];
  if (input.draft) lines.push("AI suggests:", `“${clip(input.draft.body, 600)}”`);
  else lines.push("AI suggests: nothing — it needs a person to answer.");
  const warnings = noticeWarnings(input.draft, input.warnings ?? []);
  if (warnings.length > 0) lines.push("", ...warnings.map((w) => `⚠️ ${w}`));
  lines.push("", commandLine(input.draft));
  return lines.join("\n");
}

/**
 * The customer wrote again and the AI re-answered the new state of the conversation. One short replacement notice:
 * what changed, the new exact suggestion, and a plain statement that the older one can no longer be approved.
 */
export function buildPilotUpdateNotice(input: PilotNoticeInput & { changes: string[]; afterStaffReply?: boolean; urgent?: boolean }): string {
  const lines = [`#${input.refCode} · ${clip(input.customerLabel, 60)} — updated${input.urgent ? " ‼️" : ""}`];
  const latest = input.messages[input.messages.length - 1];
  if (latest) lines.push("", `Customer: “${clip(latest, 220)}”`);
  const changes = input.changes.filter(Boolean).slice(0, 3);
  if (changes.length > 0) lines.push(`Changed: ${clip(changes.join("; "), 200)}`);
  lines.push("");
  if (input.draft) lines.push("AI suggests (replaces the earlier one):", `“${clip(input.draft.body, 600)}”`);
  else lines.push("AI suggests: nothing — it needs a person to answer.", "The earlier suggestion can no longer be approved.");
  const warnings = noticeWarnings(input.draft, [...(input.afterStaffReply ? ["The customer changed this after staff replied"] : []), ...(input.warnings ?? [])]);
  if (warnings.length > 0) lines.push("", ...warnings.map((w) => `⚠️ ${w}`));
  lines.push("", `Quote this message: ${commandLine(input.draft)}`);
  return lines.join("\n");
}

// ── !moreinfo: the full picture, from stored data only ──────────────────────

export interface MoreInfoOrder {
  ref: string;
  status: string;
  /** "2 × Monello Chicken · Large · 15kg" lines. */
  items: string[];
  fulfilment: string | null;
  address: string | null;
  requestedFor: string | null;
  notes: string | null;
  missing: string[];
  /** Why a person should look (changed after confirmation, possible cancellation, staff wrote in the chat…). */
  attention: string | null;
  cancelledReason: string | null;
}

export interface MoreInfoInput {
  refCode: string;
  customerName: string | null;
  /** Verified phone digits only; null = WhatsApp reported none we can trust. */
  phone: string | null;
  priority: string;
  escalationStatus: string;
  /** The customer's messages on this request, oldest first. */
  messages: string[];
  /** The draft the quoted message showed (or the current one when nothing was quoted). */
  draft: { version: number; body: string; ready: boolean; notes: string[]; source: string; status: string } | null;
  currentVersion: number | null;
  /** The send policy's verdict on this draft right now (read-only): ok, or the plain reason it would be refused. */
  actionable: { ok: true } | { ok: false; reason: string };
  /** The customer wrote after the draft was made (it can no longer be approved). */
  customerWroteSince: boolean;
  orders: MoreInfoOrder[];
  /** The request as the escalation holds it, when no tracked order exists. */
  requestLines: string[];
  /** Recent order changes, newest first, one line each ("quantity: 2 → 3"). */
  corrections: string[];
  missing: string[];
  /** The AI's reasons to be careful (unverified price/stock/promise, sensitive, low confidence…), plain language. */
  risks: string[];
  /** Questions the customer asked that nothing in approved knowledge answers. */
  knowledgeGaps: string[];
}

export const MORE_INFO_MAX_CHARS = 3500;

/** Stale labels come first so nobody reads old information as current. */
export function buildMoreInfo(input: MoreInfoInput): string {
  const d = input.draft;
  const stale = Boolean(d && (d.status !== "current" || input.customerWroteSince));
  const who = [input.customerName ?? "Unnamed customer", input.phone ? `+${input.phone.replace(/^\+/, "")}` : "phone not verified"].join(" · ");
  const out: string[] = [`ℹ️ #${input.refCode} · ${clip(who, 80)}`, `Request: ${input.escalationStatus} · priority ${input.priority}`];

  if (stale) {
    const why = d && d.status !== "current" ? `v${d.version} was ${d.status}${input.currentVersion ? ` (current is v${input.currentVersion})` : ""}` : "the customer wrote after this draft was made";
    out.push(`⚠️ STALE — ${why}. It can't be approved. Details below are what was stored; check the latest message.`);
  }
  out.push(
    input.actionable.ok
      ? `✅ Actionable: ${d && !d.ready ? "!approve confirm" : "!approve"} would send the draft below.`
      : `⛔ Not actionable: ${clip(input.actionable.reason, 160)}.`
  );

  const msgs = input.messages.slice(-6);
  out.push("", `Customer said${input.messages.length > msgs.length ? ` (last ${msgs.length} of ${input.messages.length})` : ""}:`, ...msgs.map((m) => `• ${clip(m, 220)}`));

  out.push("", d ? `AI draft v${d.version}${d.source === "staff_edit" ? " (edited by staff)" : d.source === "staff_answer" ? " (from a staff answer)" : ""} — ${d.ready ? "customer-ready" : "needs the facts confirmed"}:` : "AI draft: none", ...(d ? [`“${clip(d.body, 700)}”`] : []));

  if (input.orders.length > 0) {
    out.push("", "Order details:");
    for (const o of input.orders.slice(0, 4)) {
      out.push(`• ${o.ref} — ${o.status.replace(/_/g, " ")}`);
      out.push(`   ${o.items.length > 0 ? o.items.map((i) => clip(i, 80)).join("; ") : "no products yet"}`);
      const how = o.fulfilment === "delivery" ? "Delivery" : o.fulfilment === "collection" ? "Collection" : "Delivery/collection not stated";
      out.push(`   ${how}${o.address ? ` — ${clip(o.address, 120)}` : ""}${o.requestedFor ? ` · wanted: ${clip(o.requestedFor, 60)}` : ""}`);
      if (o.notes) out.push(`   Note: ${clip(o.notes, 120)}`);
      if (o.missing.length > 0) out.push(`   Missing: ${o.missing.join(", ")}`);
      if (o.attention) out.push(`   ⚠ ${clip(o.attention, 120)}`);
      if (o.cancelledReason) out.push(`   Cancelled: ${clip(o.cancelledReason, 80)}`);
    }
    if (input.orders.length > 4) out.push(`• (+${input.orders.length - 4} more in the dashboard)`);
  } else if (input.requestLines.length > 0) {
    out.push("", "Request so far (not confirmed):", ...input.requestLines.slice(0, 8).map((l) => `• ${clip(l, 120)}`));
  }
  if (input.corrections.length > 0) out.push("", "Recent changes and cancellations:", ...input.corrections.slice(0, 6).map((c) => `• ${clip(c, 140)}`));
  if (input.missing.length > 0) out.push("", "Missing or uncertain:", ...input.missing.slice(0, 6).map((m) => `• ${clip(m, 120)}`));
  if (input.knowledgeGaps.length > 0) out.push("", "Not in approved knowledge:", ...input.knowledgeGaps.slice(0, 4).map((g) => `• ${clip(g, 140)}`));
  if (input.risks.length > 0) out.push("", "Why the draft may be risky:", ...input.risks.slice(0, 5).map((r) => `• ${clip(r, 140)}`));
  out.push("", "Read-only: nothing was changed or sent.");
  const text = out.join("\n");
  return text.length > MORE_INFO_MAX_CHARS ? `${text.slice(0, MORE_INFO_MAX_CHARS - 40)}…\n(shortened — see the dashboard)` : text;
}

/** Spam control: one !moreinfo answer per request every this many seconds, and at most this many per business per 10 minutes. */
export const MORE_INFO_COOLDOWN_SECONDS = 45;
export const MORE_INFO_BUSINESS_LIMIT = 12;

/** A new draft version posted in the staff group (after !edit, or drafted from a staff answer). */
export function buildPilotDraftPost(input: {
  refCode: string;
  customerLabel: string;
  version: number;
  body: string;
  ready: boolean;
  notes: string[];
  learned?: string[];
}): string {
  const lines = [
    `✍️ Draft v${input.version} for #${input.refCode} · ${clip(input.customerLabel, 60)}`,
    `“${clip(input.body, 600)}”`,
    "",
    input.ready
      ? `Needs approval — reply !approve${input.version > 1 ? ` v${input.version}` : ""} to send it, !edit <text> to change it, !reject to drop it.`
      : `⚠️ Confirm the facts first${input.notes.length ? `: ${input.notes.join("; ")}` : ""}. Then “!approve v${input.version} confirm”, or !edit <text>.`,
  ];
  if (input.learned && input.learned.length > 0) lines.push("", ...input.learned);
  return lines.join("\n");
}

export type PilotRefusal =
  | "not_authorized"
  | "no_draft"
  | "draft_replaced"
  | "draft_changed"
  | "wrong_version"
  | "needs_confirmation"
  | "already_approved"
  | "closed"
  | "bad_arguments"
  | "no_target"
  | "ambiguous_quote"
  | "not_in_pilot"
  | "loose_approval"
  | "empty_edit"
  | "unsafe_edit"
  | "duplicate_send"
  | "moreinfo_not_authorized";

export const PILOT_REFUSAL_TEXT: Record<PilotRefusal, (ref: string, extra?: string) => string> = {
  not_authorized: (ref) => `⚠️ #${ref}: you're not on this business's list of people who can approve or send customer replies — nothing was done. Ask an admin to add you.`,
  no_draft: (ref) => `ℹ️ #${ref}: there is no draft to approve. Use !edit <text> to write one, or !send <text> to send exact wording.`,
  draft_replaced: (ref, extra) => `⚠️ #${ref}: that draft was replaced${extra ? ` (the current one is ${extra})` : ""}. Nothing was sent — quote the newest draft or use its version number.`,
  draft_changed: (ref) => `⚠️ #${ref}: that draft changed while you were approving it. Nothing was sent — check the latest draft and approve again.`,
  wrong_version: (ref, extra) => `⚠️ #${ref}: ${extra ?? "that is not the current draft"}. Nothing was sent.`,
  needs_confirmation: (ref, extra) => `⚠️ #${ref}: this draft needs its facts confirmed first${extra ? ` (${extra})` : ""}. If they're right, reply “!approve confirm”; otherwise !edit <text>. Nothing was sent.`,
  already_approved: (ref) => `ℹ️ #${ref}: this draft was already approved — it won't be sent twice.`,
  closed: (ref) => `ℹ️ #${ref} is closed — nothing was sent.`,
  bad_arguments: (ref) => `⚠️ #${ref}: I didn't understand that. Use “!approve”, “!approve v2” or “!approve confirm”. Nothing was sent.`,
  no_target: () => "⚠️ Nothing done: I can't tell which request you mean. Reply to the escalation's message, or include its #E- code.",
  ambiguous_quote: (ref, extra) => `⚠️ #${ref}: ${extra ?? "that matches more than one draft"}. Nothing was sent — quote exactly one.`,
  not_in_pilot: (ref) => `ℹ️ #${ref}: this command only works in Approval Pilot mode. Use !send <text> to send exact wording.`,
  loose_approval: (ref) => `ℹ️ #${ref}: to send a draft, reply with !approve (casual replies like “send it” never send in Approval Pilot). Nothing was sent.`,
  empty_edit: (ref) => `⚠️ #${ref}: !edit needs the new wording, e.g. “!edit We open at 9am”. Nothing was changed.`,
  unsafe_edit: (ref) => `⚠️ #${ref}: that wording can't be used (it looks like it contains a secret or is too long). Nothing was changed.`,
  duplicate_send: (ref) => `ℹ️ #${ref}: this reply is already on its way — it won't be sent twice.`,
  moreinfo_not_authorized: (ref) => `⚠️ #${ref}: !moreinfo shows customer details, so it is limited to the people who can approve replies. Ask an admin to add you.`,
};

/** The sentence staff read when they ask for `!status`. */
export function buildStatusLine(input: {
  refCode: string;
  customerLabel: string;
  status: string;
  draft: { version: number; status: string; ready: boolean; source: string } | null;
  customerWroteSinceDraft: boolean;
}): string {
  const d = input.draft;
  const draft = !d
    ? "no draft"
    : `draft v${d.version} (${d.source === "ai" ? "AI" : d.source === "staff_edit" ? "edited" : "from a staff answer"}, ${d.status === "current" ? (d.ready ? "ready" : "needs confirming") : d.status})`;
  return `#${input.refCode} · ${clip(input.customerLabel, 40)} · ${input.status} · ${draft}${d?.status === "current" && input.customerWroteSinceDraft ? " · ⚠️ customer wrote since — draft is stale" : ""}`;
}

// ── Business learning: !teach, !confirm, passive extraction ──────────────────

export const MIN_FACT_CHARS = 8;
export const MAX_FACT_CHARS = 600;
/** How long a proposed fact waits for confirmation before it lapses. */
export const PROPOSAL_TTL_DAYS = 7;
export const DEFAULT_TEMPORARY_HOURS = 12;
export const MAX_TEMPORARY_HOURS = 24 * 14;

const KIND_CUES: [kind: string, pattern: RegExp][] = [
  ["hours", /\b(open|opens|opening|closed?|closes|closing|hours?|\d{1,2}(:\d{2})?\s?(am|pm))\b/i],
  ["delivery", /\b(deliver\w*|drop[- ]?off|collection|pick[- ]?up|shipping)\b/i],
  ["price", /(?:EC\$|US\$|XCD|\$)\s?\d|\b\d[\d,.]*\s?(?:EC|XCD|USD|dollars?)\b|\b(price|prices|cost|costs|per (?:kg|bag|lb))\b/i],
  ["policy", /\b(policy|refund|return|exchange|cancel\w*|deposit|minimum)\b/i],
  ["product", /\b(stock|in stock|sold out|available|ingredients?|flavou?rs?|sizes?|brand)\b/i],
];

/** A kind for a proposed fact, from keywords only (no model call). "faq" when nothing matches. */
export function suggestKind(fact: string): string {
  return KIND_CUES.find(([, p]) => p.test(fact))?.[0] ?? "faq";
}

export function suggestTitle(fact: string): string {
  const words = fact.replace(/^[^\p{L}\p{N}$]+/u, "").split(/\s+/).slice(0, 8).join(" ");
  return clip(words, 80) || "Staff-provided fact";
}

export type TeachParse =
  | { ok: true; fact: string; temporary: boolean; expiresAt: string | null }
  | { ok: false; reason: "too_short" | "too_long" | "unsafe" };

/**
 * `!teach <fact>`, `!teach for 6h <fact>`, `!teach until 2026-11-01 <fact>`. A fact that states a temporary
 * condition (stock, "today", a shortage) is always temporary: it expires (12 hours unless the staff say
 * otherwise) and never becomes a permanent rule. Customer text can never reach this: only a staff group does.
 */
export function parseTeach(body: string, now: Date = new Date()): TeachParse {
  let text = body.replace(/\s+/g, " ").trim();
  let expiresAt: Date | null = null;
  const rel = text.match(/^for (\d{1,3})\s?(h|hr|hrs|hours?|d|days?|w|weeks?)\b\s*/i);
  const abs = text.match(/^until (\d{4}-\d{2}-\d{2})\b\s*/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase()[0];
    const hours = unit === "h" ? n : unit === "d" ? n * 24 : n * 24 * 7;
    expiresAt = new Date(now.getTime() + Math.min(hours, MAX_TEMPORARY_HOURS) * 3_600_000);
    text = text.slice(rel[0].length);
  } else if (abs) {
    const t = Date.parse(`${abs[1]}T23:59:59Z`);
    if (!Number.isNaN(t) && t > now.getTime()) expiresAt = new Date(Math.min(t, now.getTime() + MAX_TEMPORARY_HOURS * 3_600_000));
    text = text.slice(abs[0].length);
  }
  text = text.trim();
  if (text.length < MIN_FACT_CHARS) return { ok: false, reason: "too_short" };
  if (text.length > MAX_FACT_CHARS) return { ok: false, reason: "too_long" };
  if (detectPromptInjection(text) || checkReplySafety(text, []).includes("credential_leak")) return { ok: false, reason: "unsafe" };
  const temporary = Boolean(expiresAt) || statesTemporaryCondition(text);
  if (temporary && !expiresAt) expiresAt = new Date(now.getTime() + DEFAULT_TEMPORARY_HOURS * 3_600_000);
  return { ok: true, fact: text, temporary, expiresAt: expiresAt ? expiresAt.toISOString() : null };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "K-" + 4 unambiguous characters. Caller supplies randomness and retries on a collision. */
export function generateKnowledgeCode(random: Uint8Array): string {
  let code = "";
  for (let i = 0; i < 4; i += 1) code += CODE_ALPHABET[(random[i] ?? 0) % CODE_ALPHABET.length];
  return `K-${code}`;
}

const CODE_PATTERN = /\bK-([A-Z0-9]{4})\b/gi;

/** `!confirm K-ABCD`, `!confirm K-ABCD replace`, `!confirm K-ABCD keep`; exactly one code or it is refused. */
export function parseConfirmArgs(body: string): { ok: true; code: string; resolution: "none" | "replace" | "keep_both" } | { ok: false; reason: "no_code" | "several_codes" | "bad_option" } {
  const codes = Array.from(new Set(Array.from(body.matchAll(CODE_PATTERN), (m) => `K-${m[1].toUpperCase()}`)));
  if (codes.length === 0) return { ok: false, reason: "no_code" };
  if (codes.length > 1) return { ok: false, reason: "several_codes" };
  const rest = body.replace(CODE_PATTERN, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (rest === "") return { ok: true, code: codes[0], resolution: "none" };
  if (rest === "replace") return { ok: true, code: codes[0], resolution: "replace" };
  if (rest === "keep" || rest === "keep both") return { ok: true, code: codes[0], resolution: "keep_both" };
  return { ok: false, reason: "bad_option" };
}

// ── Passive extraction: which staff messages are even worth a look ───────────

const FACT_CUE =
  /(?:EC\$|US\$|XCD|\$)\s?\d|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b(we (?:now )?(?:open|close|deliver|sell|stock|have|don'?t|do not|only)|opens?|closes?|closed|delivery|deliver(?:s|ed)? to|price[sd]?|costs?|per (?:kg|bag|lb)|in stock|out of stock|sold out|ran out|run out|no longer|from (?:now|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|minimum|fee)\b/i;

const QUESTION_ONLY = /\?\s*$/;

/** Cheap pre-filter before any model call: long enough, not a command, not a question, and it states something factual. */
export function passiveWorthLooking(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 20 || t.length > 800) return false;
  if (t.startsWith("!")) return false;
  if (QUESTION_ONLY.test(t)) return false;
  if (/\bE-[A-Z0-9]{4,8}\b/i.test(t)) return false; // an escalation answer: handled by the staff-answer pipeline
  if (/(AI escalation #|Draft v\d|Draft reply for #|Update on #)/.test(t)) return false;
  return FACT_CUE.test(t);
}

/** Model calls a business may spend on passive extraction per hour. */
export const PASSIVE_CALLS_PER_HOUR = 12;

export function passiveScopeAllows(scope: string | null | undefined, source: "staff_group" | "staff_chat"): boolean {
  if (scope === "staff_group_and_chats") return true;
  return scope === "staff_group" && source === "staff_group";
}
