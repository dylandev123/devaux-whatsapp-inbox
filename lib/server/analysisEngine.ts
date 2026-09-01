// Server-only: runs Phase 1 AI conversation analysis (classification +
// summary) for a single conversation and upserts the result into
// conversation_analysis. Never imported from a client component — it reads
// SUPABASE_SERVICE_ROLE_KEY directly, and the OpenAI key indirectly via
// getAiSettings(), neither of which must ever reach the browser. Called
// from app/api/analysis/run/route.ts only.
//
// Read-only by design: this only ever reads whatsapp_messages/customers and
// writes conversation_analysis. It never sends anything to WhatsApp and
// never touches whatsapp_messages/whatsapp_sessions.
//
// Model/key come from the ai_settings table (see lib/server/aiSettings.ts
// and the AI Settings admin page), not an env var — an admin can change the
// model or rotate the key without a redeploy. If no key has ever been
// saved, analysis fails with a clear setup error (see the "not configured"
// check below) rather than a confusing OpenAI 401 buried in error_message.

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { classifyMedia, mediaPreviewLabel } from "@/lib/media";
import { resolveContactName } from "@/lib/contactName";
import { getAiSettings } from "@/lib/server/aiSettings";
import {
  ANALYSIS_CATEGORIES,
  AnalysisCategory,
  AnalysisUrgency,
  ExtractedDetails,
} from "@/lib/analysis";
import {
  WhatsappMessage,
  businessLabel,
  isOutbound,
  isSystemChatId,
  resolveBubbleText,
  resolveConversationPhone,
  resolveGroupSenderName,
  resolveRecipientNumber,
} from "@/lib/whatsapp";

// Most recent N messages fed to the model per conversation. Bounds token
// spend/latency for very high-volume chats (some group chats here run into
// the thousands of messages) — same "newest slice, then re-sort to
// chronological" pattern used for the inbox's own message loading, so the
// model still sees the conversation in the order it happened.
const MAX_MESSAGES = 300;

const MESSAGE_SELECT =
  "id, business_slug, chat_id, contact_name, contact_number, business_contact_name, direction, message_body, message_type, media_url, created_at, timestamp, sender_participant:raw->key->>participant, sender_participant_pn:raw->key->>participantPn, sender_push_name:raw->>pushName, sender_pn:raw->key->>senderPn, reaction_text:raw->message->reactionMessage->>text, protocol_type:raw->message->protocolMessage->>type";

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service role is not configured (SUPABASE_SERVICE_ROLE_KEY missing)");
  }
  return createClient(url, serviceKey);
}

export interface ConversationSummary {
  chatId: string;
  messageCount: number;
  lastMessageAt: string;
}

// Lightweight enumeration of every real (non-system) conversation for a
// business, for the bulk "analyze new/updated" action. Only pulls two
// columns across however many messages the business has — cheap even for a
// business with several thousand messages, and does not select `raw`.
export async function listConversations(businessSlug: string): Promise<ConversationSummary[]> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("chat_id, timestamp")
    .eq("business_slug", businessSlug);
  if (error) throw new Error(error.message);

  const byChat = new Map<string, ConversationSummary>();
  for (const row of data ?? []) {
    if (isSystemChatId(row.chat_id)) continue;
    const existing = byChat.get(row.chat_id);
    if (!existing) {
      byChat.set(row.chat_id, { chatId: row.chat_id, messageCount: 1, lastMessageAt: row.timestamp });
    } else {
      existing.messageCount += 1;
      if (new Date(row.timestamp).getTime() > new Date(existing.lastMessageAt).getTime()) {
        existing.lastMessageAt = row.timestamp;
      }
    }
  }
  return Array.from(byChat.values());
}

interface ModelOutput {
  category: AnalysisCategory;
  summary: string;
  extracted: ExtractedDetails;
  urgency: AnalysisUrgency;
  needs_action: boolean;
  next_action: string | null;
  confidence: number | null;
}

function mediaNote(message: WhatsappMessage): string | null {
  const kind = classifyMedia(message);
  return kind ? mediaPreviewLabel(message, kind) : null;
}

function formatTranscript(businessSlug: string, messages: WhatsappMessage[]): string {
  const lines = messages.map((m) => {
    const who = isOutbound(m.direction) ? "Staff" : resolveGroupSenderName(m) ?? "Customer";
    const text = resolveBubbleText(m);
    const media = mediaNote(m);
    const body = [media, text].filter(Boolean).join(" ") || "(no text content)";
    return `[${m.timestamp}] ${who}: ${body}`;
  });
  return `Business: ${businessLabel(businessSlug)}\n\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT = `You analyze a single WhatsApp customer-service conversation for a small business using a shared WhatsApp inbox tool. Your job is strictly read-only classification and summarization — you never reply to the customer and never take any action. Base your analysis on the conversation as a whole, not just the most recent message.

Classify the conversation into exactly one of these categories:
- "Order placed": the customer has confirmed/placed an order.
- "Order inquiry": asking about a product, availability, or pricing, not yet a confirmed order.
- "Booking inquiry": asking about booking a service/appointment/tour, not yet confirmed.
- "Payment": discussing payment, deposit, invoice, or receipt.
- "Complaint/concern": expressing a problem, dissatisfaction, or concern.
- "Follow-up needed": staff owes the customer a reply or action they haven't given yet.
- "General question": a question that doesn't fit the categories above.
- "Positive feedback": a compliment or thanks with no other actionable content.
- "Cancellation/change": cancelling or changing an existing order/booking.
- "Other": none of the above fit.

Respond with ONLY a single JSON object and nothing else — no prose, no markdown code fences. Match this shape exactly:
{
  "category": "<one of the exact category strings above>",
  "summary": "<1-3 sentence summary of the whole conversation>",
  "extracted": {
    "products_services": [<strings>] or null,
    "quantity": "<string>" or null,
    "dates": [<strings>] or null,
    "address": "<string>" or null,
    "payment_info": "<string>" or null,
    "booking_info": "<string>" or null
  },
  "urgency": "low" | "medium" | "high",
  "needs_action": true or false,
  "next_action": "<short string staff should do next>" or null,
  "confidence": <number between 0 and 1>
}`;

function parseModelOutput(raw: string): ModelOutput {
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);

  if (!ANALYSIS_CATEGORIES.includes(parsed.category)) {
    throw new Error(`Model returned an invalid category: ${JSON.stringify(parsed.category)}`);
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("Model returned an empty summary");
  }
  const urgency = ["low", "medium", "high"].includes(parsed.urgency) ? parsed.urgency : "low";
  const confidence =
    typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : null;

  return {
    category: parsed.category,
    summary: parsed.summary.trim(),
    extracted: typeof parsed.extracted === "object" && parsed.extracted !== null ? parsed.extracted : {},
    urgency,
    needs_action: Boolean(parsed.needs_action),
    next_action: typeof parsed.next_action === "string" ? parsed.next_action.trim() || null : null,
    confidence,
  };
}

export interface AnalyzeResult {
  chatId: string;
  status: "ok" | "error";
  error?: string;
}

export async function analyzeConversation(
  businessSlug: string,
  chatId: string
): Promise<AnalyzeResult> {
  if (isSystemChatId(chatId)) {
    throw new Error("Refusing to analyze a system/broadcast chat");
  }

  const supabase = supabaseAdmin();
  const { data: rows, error: fetchError } = await supabase
    .from("whatsapp_messages")
    .select(MESSAGE_SELECT)
    .eq("business_slug", businessSlug)
    .eq("chat_id", chatId)
    .order("timestamp", { ascending: false })
    .limit(MAX_MESSAGES);
  if (fetchError) throw new Error(fetchError.message);

  const messages = ((rows ?? []) as WhatsappMessage[]).slice().reverse();
  if (messages.length === 0) {
    throw new Error("No messages found for this conversation");
  }

  const last = messages[messages.length - 1];
  const contactNumber = messages.find((m) => m.contact_number)?.contact_number ?? null;
  const contactName = messages.slice().reverse().find((m) => m.contact_name)?.contact_name ?? null;
  const businessContactName =
    messages.slice().reverse().find((m) => m.business_contact_name)?.business_contact_name ?? null;

  const customerKey = resolveRecipientNumber(contactNumber, chatId);
  const { data: customerRow } = await supabase
    .from("customers")
    .select("first_name, last_name, whatsapp_name, business_contact_name")
    .eq("phone_number", customerKey)
    .maybeSingle();

  const customerName = resolveContactName({
    businessContactName: customerRow?.business_contact_name ?? businessContactName,
    firstName: customerRow?.first_name,
    lastName: customerRow?.last_name,
    whatsappName: customerRow?.whatsapp_name ?? contactName,
    phoneNumber: customerKey,
  });
  const { phone: phoneDisplay } = resolveConversationPhone(contactNumber, chatId, messages);

  const baseRow = {
    business_slug: businessSlug,
    chat_id: chatId,
    customer_name: customerName,
    phone_display: phoneDisplay,
    contact_number: contactNumber,
    message_count: messages.length,
    last_message_at: last.timestamp,
    analyzed_at: new Date().toISOString(),
  };

  const settings = await getAiSettings();
  const model = settings.model;
  try {
    if (!settings.api_key) {
      throw new Error(
        "AI analysis isn't set up yet — an admin needs to add an OpenAI API key on the AI Settings page."
      );
    }

    const client = new OpenAI({ apiKey: settings.api_key });
    const response = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: formatTranscript(businessSlug, messages),
      max_output_tokens: 1024,
    });

    if (response.error) {
      throw new Error(`OpenAI error: ${response.error.message}`);
    }
    if (!response.output_text?.trim()) {
      throw new Error("Model returned no text content");
    }

    const parsed = parseModelOutput(response.output_text);

    const { error: upsertError } = await supabase.from("conversation_analysis").upsert(
      {
        ...baseRow,
        ...parsed,
        model,
        status: "ok",
        error_message: null,
      },
      { onConflict: "business_slug,chat_id" }
    );
    if (upsertError) throw new Error(upsertError.message);

    return { chatId, status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabase.from("conversation_analysis").upsert(
      {
        ...baseRow,
        category: "Other" as AnalysisCategory,
        summary: "Analysis failed — see error_message.",
        extracted: {},
        urgency: "low" as AnalysisUrgency,
        needs_action: false,
        next_action: null,
        confidence: null,
        model,
        status: "error",
        error_message: message,
      },
      { onConflict: "business_slug,chat_id" }
    );
    return { chatId, status: "error", error: message };
  }
}
