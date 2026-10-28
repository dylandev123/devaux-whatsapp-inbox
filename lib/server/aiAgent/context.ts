// Server-only: assembles what the agent knows about a customer, reusing the
// existing memory tables rather than duplicating them (see
// lib/server/aiAgent/memory.ts) — verified orders, customer-stated facts and
// AI inferences arrive as ONE concise, labelled brief — plus a short slice of
// recent whatsapp_messages for conversational context (retention-limited).
// Read-only: loading context never writes anything.

import { resolveContactName } from "@/lib/contactName";
import { isOutbound, resolveRecipientNumber } from "@/lib/whatsapp";
import { OrderRequestDraft } from "@/lib/aiAgent/engine";
import { ChatIdentity } from "@/lib/aiAgent/identity";
import { MemoryBrief } from "@/lib/aiAgent/memory";
import { mediaPlaceholder, pictureNote, type MediaLine, type PictureReading, pictureWords } from "@/lib/aiAgent/orderImages";
import type { ConversationLine } from "@/lib/aiAgent/staffDelivery";
import { agentDb } from "@/lib/server/aiAgent/db";
import { loadMemoryBrief } from "@/lib/server/aiAgent/memory";
import { readPicturesForTurn } from "@/lib/server/aiAgent/orderImages";

const TRANSCRIPT_MESSAGES = 12;

export interface CustomerContext {
  customerKey: string;
  customerName: string;
  memory: MemoryBrief;
  transcript: { who: "Customer" | "Staff"; text: string; at: string }[];
}

export async function loadCustomerContext(
  businessSlug: string,
  chatId: string,
  contactNumber: string | null,
  excludeMessageIds: string[],
  identity: ChatIdentity,
  messageText: string,
  /** Simulations of a past turn: only conversation from before it (the messages the model could have seen then). */
  options: { before?: string } = {}
): Promise<CustomerContext> {
  const db = agentDb();
  // Display label only. Customer rows are matched by a VERIFIED phone, never
  // by lid digits that merely look like a number.
  const customerKey = identity.phone ?? resolveRecipientNumber(contactNumber, chatId);
  const excluded = new Set(excludeMessageIds);

  const [customer, memory, messages] = await Promise.all([
    identity.phone
      ? db
          .from("customers")
          .select("first_name, last_name, whatsapp_name, business_contact_name")
          .eq("phone_number", identity.phone)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    loadMemoryBrief(businessSlug, identity, messageText),
    (() => {
      const query = db
        .from("whatsapp_messages")
        .select("whatsapp_message_id, direction, message_body, timestamp")
        .eq("business_slug", businessSlug)
        .eq("chat_id", chatId);
      return (options.before ? query.lt("timestamp", options.before) : query)
        .order("timestamp", { ascending: false })
        .limit(TRANSCRIPT_MESSAGES + excluded.size + 1);
    })(),
  ]);

  // Missing tables / rows degrade to "nothing known", never to a failure.
  const c = customer.data;
  const customerName = resolveContactName({
    businessContactName: c?.business_contact_name,
    firstName: c?.first_name,
    lastName: c?.last_name,
    whatsappName: c?.whatsapp_name,
    phoneNumber: customerKey,
  });

  const transcript = (messages.data ?? [])
    .filter((m) => !excluded.has(m.whatsapp_message_id))
    .filter((m) => m.message_body?.trim())
    .slice(0, TRANSCRIPT_MESSAGES)
    .reverse()
    .map((m) => ({
      who: isOutbound(m.direction) ? ("Staff" as const) : ("Customer" as const),
      text: m.message_body!.trim().slice(0, 600),
      at: m.timestamp,
    }));

  return { customerKey, customerName, memory, transcript };
}

/** The customer's saved name (or their verified number / chat id when none is saved). Display only. */
export async function loadCustomerDisplayName(identity: ChatIdentity, contactNumber: string | null, chatId: string): Promise<string> {
  const customerKey = identity.phone ?? resolveRecipientNumber(contactNumber, chatId);
  const { data: c } = identity.phone
    ? await agentDb().from("customers").select("first_name, last_name, whatsapp_name, business_contact_name").eq("phone_number", identity.phone).maybeSingle()
    : { data: null };
  return resolveContactName({
    businessContactName: c?.business_contact_name,
    firstName: c?.first_name,
    lastName: c?.last_name,
    whatsappName: c?.whatsapp_name,
    phoneNumber: customerKey,
  });
}

/**
 * The WhatsApp id of the message a stored message replied to, read from the stored raw message (no extra column): a reply
 * is a quote on its text or its image. PostgREST reads the two JSON paths below; a row without a quote has neither.
 */
export const QUOTE_COLUMNS =
  "quoted_ext:raw->message->extendedTextMessage->contextInfo->>stanzaId, quoted_img:raw->message->imageMessage->contextInfo->>stanzaId";

export function quotedIdOf(row: Record<string, unknown>): string | null {
  const id = (typeof row.quoted_ext === "string" && row.quoted_ext) || (typeof row.quoted_img === "string" && row.quoted_img) || "";
  return id ? id.slice(0, 200) : null;
}

/** One stored message as order reading sees it. `text` is what the model reads; `rawText` is only what was written. */
export interface RecentLine extends ConversationLine, MediaLine {
  rawText: string;
  /** Words printed on a customer picture that was read (for checking the model's values), never the customer's own words. */
  pictureWords: string[];
}

export interface PictureOptions {
  /** The customer's words in the turn being read, and when they were written: a picture is read only if these (or its caption) point at it. */
  turnTexts: string[];
  turnAt: string;
  /** What the business sells, only to help the model spell what is printed on a label. Asked for only when a picture is read. */
  knownProducts?: () => Promise<string[]>;
}

/** Rows of whatsapp_messages as lines, newest first in → oldest first out. Media-only rows are kept (as media) when `withMedia`. */
export function linesFromRows(rows: Record<string, unknown>[], withMedia: boolean): RecentLine[] {
  const out: RecentLine[] = [];
  for (const m of rows) {
    const body = typeof m.message_body === "string" ? m.message_body.trim() : "";
    const media = typeof m.media_url === "string" && m.media_url ? String(m.message_type ?? "unknown").toLowerCase() : null;
    if (!body && !(withMedia && media)) continue;
    out.push({
      id: typeof m.whatsapp_message_id === "string" ? m.whatsapp_message_id : null,
      who: isOutbound(String(m.direction)) ? "Staff" : "Customer",
      text: body.slice(0, 400),
      rawText: body.slice(0, 400),
      at: String(m.timestamp),
      quotedId: quotedIdOf(m),
      mediaKind: withMedia ? media : null,
      mediaUrl: withMedia ? ((m.media_url as string | null) ?? null) : null,
      pictureWords: [],
    });
  }
  return out;
}

/**
 * What the model reads for a line: a photo gets the note of what it shows (or "not read"), a voice message says it was not
 * transcribed, and a reply says what it replied to. Pure.
 */
export function describeLines(lines: RecentLine[], readings: Map<string, PictureReading>): RecentLine[] {
  const byId = new Map(lines.filter((l) => l.id).map((l) => [l.id!, l]));
  return lines.map((l) => {
    const reading = l.id ? readings.get(l.id) : undefined;
    const note = l.mediaKind ? (reading ? pictureNote(reading) : mediaPlaceholder(l.mediaKind)) : null;
    const quoted = l.quotedId ? byId.get(l.quotedId) : undefined;
    const reply = quoted ? `(replying to ${quoted.who === "Staff" ? "staff" : "the customer"}: “${(quoted.rawText || (quoted.mediaKind ? mediaPlaceholder(quoted.mediaKind) : "") || "").slice(0, 120)}”) ` : "";
    const text = `${reply}${[l.rawText, note].filter(Boolean).join(" ")}`.trim();
    return { ...l, text, pictureWords: pictureWords(reading) };
  });
}

/** The last few stored messages of a chat (oldest first), labelled. Order monitoring's look at history. */
export async function loadRecentMessages(
  businessSlug: string,
  chatId: string,
  excludeMessageIds: string[],
  limit = 8,
  /** Order tracking: include photos and voice messages, and read a photo the customer's words point at. */
  pictures?: PictureOptions
): Promise<RecentLine[]> {
  const excluded = new Set(excludeMessageIds);
  const base = "whatsapp_message_id, direction, message_body, timestamp";
  const fetchRows = async (columns: string) =>
    agentDb()
      .from("whatsapp_messages")
      .select(columns)
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .order("timestamp", { ascending: false })
      .limit(limit + excluded.size + 1);
  // Media and the quote are context, never required: a database without those columns (or the stored raw message) still
  // returns its text exactly as before.
  let res = await fetchRows(`${base}, message_type, media_url, ${QUOTE_COLUMNS}`).catch(() => null);
  if (!res || res.error) res = await fetchRows(base);
  const rows = ((res.data ?? []) as unknown as Record<string, unknown>[]).filter((m) => !excluded.has(String(m.whatsapp_message_id)));
  const lines = linesFromRows(rows, Boolean(pictures)).slice(0, limit).reverse();
  const readings = pictures ? await readPicturesForTurn({ businessSlug, lines, turnTexts: pictures.turnTexts, turnAt: pictures.turnAt, knownProducts: pictures.knownProducts }) : new Map<string, PictureReading>();
  return describeLines(lines, readings);
}

export interface TurnPictures {
  /** One line per photo / voice message in the turn, to sit beside the customer's words ("[photo — label reads: …]"). null when none. */
  note: string | null;
  /** Words printed on a photo the customer's words point at. */
  pictureWords: string[];
}

/**
 * The turn's OWN photos and voice messages (the recent-lines loader leaves the turn's messages out). A photo is read only when
 * the customer's words point at it; one that cannot be read says so, so the order reader never guesses from it.
 */
export async function readTurnPictures(businessSlug: string, chatId: string, messageIds: string[], pictures: PictureOptions): Promise<TurnPictures> {
  const none: TurnPictures = { note: null, pictureWords: [] };
  if (messageIds.length === 0) return none;
  try {
    const { data, error } = await agentDb()
      .from("whatsapp_messages")
      .select("whatsapp_message_id, direction, message_body, message_type, media_url, timestamp")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .in("whatsapp_message_id", messageIds.slice(0, 20));
    if (error) return none;
    const lines = linesFromRows((data ?? []) as unknown as Record<string, unknown>[], true).filter((l) => l.who === "Customer" && l.mediaKind);
    if (lines.length === 0) return none;
    const readings = await readPicturesForTurn({ businessSlug, lines, turnTexts: pictures.turnTexts, turnAt: pictures.turnAt, knownProducts: pictures.knownProducts });
    const notes = lines
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((l) => (l.mediaKind === "image" && l.id && readings.has(l.id) ? pictureNote(readings.get(l.id)) : mediaPlaceholder(l.mediaKind)))
      .filter((n): n is string => Boolean(n));
    return { note: notes.length > 0 ? notes.join("\n") : null, pictureWords: lines.flatMap((l) => (l.id ? pictureWords(readings.get(l.id)) : [])) };
  } catch {
    return none;
  }
}

/** The id of the message the customer replied to in this turn (the last quote among the turn's own messages), or null. Best effort. */
export async function loadTurnQuote(businessSlug: string, chatId: string, messageIds: string[]): Promise<string | null> {
  if (messageIds.length === 0) return null;
  try {
    const { data, error } = await agentDb()
      .from("whatsapp_messages")
      .select(`whatsapp_message_id, timestamp, ${QUOTE_COLUMNS}`)
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .in("whatsapp_message_id", messageIds.slice(0, 20))
      .order("timestamp", { ascending: false });
    if (error) return null;
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = quotedIdOf(row);
      if (id) return id;
    }
  } catch {
    /* a quote is optional context */
  }
  return null;
}

/** Short lines naming what the business sells (knowledge entries), only to help read a photo's label. */
export function productHints(knowledge: { content: string }[]): string[] {
  return knowledge.map((k) => k.content.replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean).slice(0, 40);
}

export interface OpenOrderRequest extends OrderRequestDraft {
  id: string;
  status: "collecting" | "pending_approval";
}

export async function loadOpenOrderRequest(businessSlug: string, chatId: string): Promise<OpenOrderRequest | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_order_requests")
    .select("id, status, items, delivery_address, delivery_preference, notes")
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .in("status", ["collecting", "pending_approval"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OpenOrderRequest | null) ?? null;
}

/**
 * Newest manual staff message in this chat, i.e. an outbound whatsapp_messages
 * row that the agent itself did not send. Agent sends are recognised by the
 * WhatsApp id the bridge acked or, before the ack lands, by identical body.
 */
export async function latestManualStaffMessageAt(
  businessSlug: string,
  chatId: string,
  sinceMinutes: number
): Promise<string | null> {
  if (sinceMinutes <= 0) return null;
  const db = agentDb();
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const [outbound, agentSends] = await Promise.all([
    db
      .from("whatsapp_messages")
      .select("whatsapp_message_id, message_body, timestamp")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .ilike("direction", "%out%")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false })
      .limit(20),
    db
      .from("ai_agent_outbox")
      .select("whatsapp_message_id, body")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .gte("created_at", new Date(Date.now() - (sinceMinutes + 60) * 60_000).toISOString()),
  ]);
  if (outbound.error) throw new Error(outbound.error.message);

  const agentIds = new Set((agentSends.data ?? []).map((o) => o.whatsapp_message_id).filter(Boolean));
  const agentBodies = new Set((agentSends.data ?? []).map((o) => o.body.trim()));
  const manual = (outbound.data ?? []).find(
    (m) =>
      !(m.whatsapp_message_id && agentIds.has(m.whatsapp_message_id)) &&
      !agentBodies.has((m.message_body ?? "").trim())
  );
  return manual?.timestamp ?? null;
}
