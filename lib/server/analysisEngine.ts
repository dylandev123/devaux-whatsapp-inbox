// Server-only: runs AI conversation analysis (classification + summary +
// customer memory) for a single conversation and upserts the result into
// conversation_analysis (and customer_ai_profile). Never imported from a
// client component — it reads SUPABASE_SERVICE_ROLE_KEY directly, and the
// OpenAI key indirectly via getAiSettings(), neither of which must ever
// reach the browser. Called from app/api/analysis/run/route.ts only.
//
// Read-only by design: this only ever reads whatsapp_messages/customers and
// writes conversation_analysis/customer_ai_profile. It never sends anything
// to WhatsApp and never touches whatsapp_messages/whatsapp_sessions, and it
// never writes to `customers` — see customer_ai_profile's migration comment
// for why that separation is what keeps AI guesses from ever overwriting a
// verified customer field.
//
// Every run only looks at messages within the caller-supplied date range
// (see AnalysisRange) rather than "however many recent messages fit" — the
// model doesn't need the full history every time because it's also given
// the conversation's last stored summary and the customer's AI profile as
// context, both carried forward from prior runs. A run whose range contains
// no messages is a no-op (status "skipped") rather than overwriting a
// perfectly good cached result with a hollow "nothing to say" analysis.
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
  AnalysisRange,
  AnalysisUrgency,
  ExtractedDetails,
  OrderStatus,
  WorkflowStatus,
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

// Even within a date range, cap how many messages get sent in one call —
// bounds token spend/latency for a wide custom range on a high-volume chat.
// Same "newest slice within the bound, then re-sort to chronological"
// pattern used for the inbox's own message loading.
const MAX_MESSAGES = 500;

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
// business that has at least one message in `range`, for the bulk "analyze
// new/updated" action. Only pulls two columns — cheap even for a business
// with several thousand messages, and does not select `raw`.
export async function listConversations(
  businessSlug: string,
  range: AnalysisRange
): Promise<ConversationSummary[]> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("chat_id, timestamp")
    .eq("business_slug", businessSlug)
    .gte("timestamp", range.since)
    .lte("timestamp", range.until);
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

// All soft/inferred, all optional — never merged into `customers`. See
// customer_ai_profile's migration comment.
export interface CustomerProfileFacts {
  preferences: string | null;
  common_orders: string | null;
  addresses: string | null;
  payment_habits: string | null;
  important_notes: string | null;
  last_known_intent: string | null;
}

interface ModelOutput {
  category: AnalysisCategory;
  summary: string;
  extracted: ExtractedDetails;
  urgency: AnalysisUrgency;
  needs_action: boolean;
  next_action: string | null;
  confidence: number | null;
  customer_profile: CustomerProfileFacts;
}

function mediaNote(message: WhatsappMessage): string | null {
  const kind = classifyMedia(message);
  return kind ? mediaPreviewLabel(message, kind) : null;
}

function formatTranscript(messages: WhatsappMessage[]): string {
  return messages
    .map((m) => {
      const who = isOutbound(m.direction) ? "Staff" : resolveGroupSenderName(m) ?? "Customer";
      const text = resolveBubbleText(m);
      const media = mediaNote(m);
      const body = [media, text].filter(Boolean).join(" ") || "(no text content)";
      return `[${m.timestamp}] ${who}: ${body}`;
    })
    .join("\n");
}

function formatPriorContext(
  businessSlug: string,
  priorAnalysis: { category: string; summary: string } | null,
  priorProfile: CustomerProfileFacts | null
): string {
  const parts: string[] = [`Business: ${businessLabel(businessSlug)}`];

  if (priorAnalysis) {
    parts.push(
      `Prior analysis of this conversation (from before the new messages below — treat as background, not ground truth if the new messages contradict it):\nCategory: ${priorAnalysis.category}\nSummary: ${priorAnalysis.summary}`
    );
  } else {
    parts.push("This conversation has not been analyzed before.");
  }

  const profileLines = priorProfile
    ? Object.entries(priorProfile)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
    : [];
  parts.push(
    profileLines.length > 0
      ? `Known facts about this customer from past conversations (may be from other conversations with this same business, not just this one — carry forward whatever still holds true):\n${profileLines.join(
          "\n"
        )}`
      : "No prior facts are known about this customer yet."
  );

  return parts.join("\n\n");
}

const SYSTEM_PROMPT = `You analyze a single WhatsApp customer-service conversation for a small business using a shared WhatsApp inbox tool. Your job is strictly read-only classification, summarization, and light customer-memory maintenance — you never reply to the customer and never take any action.

You are given two things: (1) background context — the conversation's prior analysis (if any) and known facts about this customer (if any) — and (2) a transcript of NEW messages since that context was last updated. Base your classification and summary on the conversation as a whole (background + new messages together), but treat the background as potentially stale: if the new messages contradict it, the new messages win.

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

You also maintain a lightweight, ongoing memory of stable facts about this customer — preferences, the kinds of things they typically order/book, addresses they've given, how they usually pay, anything important staff should remember, and their most recent apparent intent. This is a soft, evolving summary, never verified data — carry forward facts from the background that still hold, add anything new and durable the new messages reveal, and drop anything the new messages explicitly contradict. Do not invent facts that aren't actually stated or clearly implied. Leave a field null if nothing is known for it.

Respond with ONLY a single JSON object and nothing else — no prose, no markdown code fences. Match this shape exactly:
{
  "category": "<one of the exact category strings above>",
  "summary": "<1-3 sentence summary of the whole conversation, including relevant background>",
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
  "confidence": <number between 0 and 1>,
  "customer_profile": {
    "preferences": "<string>" or null,
    "common_orders": "<string>" or null,
    "addresses": "<string>" or null,
    "payment_habits": "<string>" or null,
    "important_notes": "<string>" or null,
    "last_known_intent": "<string>" or null
  }
}`;

function cleanProfileField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

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

  const rawProfile = typeof parsed.customer_profile === "object" && parsed.customer_profile !== null
    ? parsed.customer_profile
    : {};

  return {
    category: parsed.category,
    summary: parsed.summary.trim(),
    extracted: typeof parsed.extracted === "object" && parsed.extracted !== null ? parsed.extracted : {},
    urgency,
    needs_action: Boolean(parsed.needs_action),
    next_action: typeof parsed.next_action === "string" ? parsed.next_action.trim() || null : null,
    confidence,
    customer_profile: {
      preferences: cleanProfileField(rawProfile.preferences),
      common_orders: cleanProfileField(rawProfile.common_orders),
      addresses: cleanProfileField(rawProfile.addresses),
      payment_habits: cleanProfileField(rawProfile.payment_habits),
      important_notes: cleanProfileField(rawProfile.important_notes),
      last_known_intent: cleanProfileField(rawProfile.last_known_intent),
    },
  };
}

export interface AnalyzeResult {
  chatId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
}

export async function analyzeConversation(
  businessSlug: string,
  chatId: string,
  range: AnalysisRange
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
    .gte("timestamp", range.since)
    .lte("timestamp", range.until)
    .order("timestamp", { ascending: false })
    .limit(MAX_MESSAGES);
  if (fetchError) throw new Error(fetchError.message);

  const messages = ((rows ?? []) as WhatsappMessage[]).slice().reverse();
  if (messages.length === 0) {
    // Not a failure — the selected range just has nothing new for this
    // conversation. Leave any existing cached analysis exactly as it is
    // rather than overwriting it with a hollow "nothing to say" result.
    return { chatId, status: "skipped", error: "No messages in the selected range" };
  }

  const last = messages[messages.length - 1];
  const contactNumber = messages.find((m) => m.contact_number)?.contact_number ?? null;
  const contactName = messages.slice().reverse().find((m) => m.contact_name)?.contact_name ?? null;
  const businessContactName =
    messages.slice().reverse().find((m) => m.business_contact_name)?.business_contact_name ?? null;

  const customerKey = resolveRecipientNumber(contactNumber, chatId);
  const [{ data: customerRow }, { data: priorAnalysisRow }, { data: priorProfileRow }] = await Promise.all([
    supabase
      .from("customers")
      .select("first_name, last_name, whatsapp_name, business_contact_name")
      .eq("phone_number", customerKey)
      .maybeSingle(),
    supabase
      .from("conversation_analysis")
      .select("category, summary, order_status, workflow_status, last_message_at")
      .eq("business_slug", businessSlug)
      .eq("chat_id", chatId)
      .maybeSingle(),
    supabase
      .from("customer_ai_profile")
      .select("preferences, common_orders, addresses, payment_habits, important_notes, last_known_intent")
      .eq("business_slug", businessSlug)
      .eq("contact_number", customerKey)
      .maybeSingle(),
  ]);

  const customerName = resolveContactName({
    businessContactName: customerRow?.business_contact_name ?? businessContactName,
    firstName: customerRow?.first_name,
    lastName: customerRow?.last_name,
    whatsappName: customerRow?.whatsapp_name ?? contactName,
    phoneNumber: customerKey,
  });
  const { phone: phoneDisplay } = resolveConversationPhone(contactNumber, chatId, messages);

  // Manual workflow status (see order_status's migration comment) — never
  // set or changed by this function once it exists. It's only ever
  // initialized the first time a conversation becomes "Order placed" with
  // no status yet; a later re-analysis (even one that changes the category
  // away from "Order placed") keeps whatever staff already set it to.
  const existingOrderStatus = (priorAnalysisRow?.order_status as OrderStatus | null | undefined) ?? null;

  // Done/Active workflow status (see
  // supabase/migrations/20260902010000_conversation_workflow_status.sql).
  // Auto-resurface, authoritative version: resurfaceDoneWithNewActivity()
  // (lib/analysis.ts) does the same thing client-side by comparing against
  // *live* whatsapp_messages, but that signal disappears the moment this
  // function updates last_message_at — so a Done conversation that gets
  // caught by a bulk "Analyze new/updated" run before anyone reopens the
  // dashboard needs this function to flip it back to Active itself, or it
  // would stay hidden forever despite genuinely new messages having just
  // been incorporated. Only flips when this run's messages actually extend
  // past what the last analysis already reflected — re-analyzing a Done
  // conversation over a wide/overlapping range that contains no messages
  // newer than last time must not silently reopen it.
  const existingWorkflowStatus = (priorAnalysisRow?.workflow_status as WorkflowStatus | null | undefined) ?? "Active";
  const priorLastMessageAt = priorAnalysisRow?.last_message_at ?? null;
  const hasNewMessagesSincePriorAnalysis =
    !priorLastMessageAt || new Date(last.timestamp).getTime() > new Date(priorLastMessageAt).getTime();
  const workflowStatus: WorkflowStatus =
    existingWorkflowStatus === "Done" && hasNewMessagesSincePriorAnalysis ? "Active" : existingWorkflowStatus;

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

    const priorContext = formatPriorContext(
      businessSlug,
      priorAnalysisRow ?? null,
      (priorProfileRow as CustomerProfileFacts | null) ?? null
    );
    const input = `${priorContext}\n\nNew messages (${range.since} to ${range.until}):\n${formatTranscript(messages)}`;

    const client = new OpenAI({ apiKey: settings.api_key });
    const response = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input,
      max_output_tokens: 1536,
    });

    if (response.error) {
      throw new Error(`OpenAI error: ${response.error.message}`);
    }
    if (!response.output_text?.trim()) {
      throw new Error("Model returned no text content");
    }

    const parsed = parseModelOutput(response.output_text);
    const { customer_profile: profile, ...analysisFields } = parsed;

    // Initialize the order workflow status the first time this conversation
    // becomes an order; otherwise leave whatever staff already set.
    const orderStatus: OrderStatus | null =
      existingOrderStatus ?? (analysisFields.category === "Order placed" ? "Needs adding" : null);

    const { error: upsertError } = await supabase.from("conversation_analysis").upsert(
      {
        ...baseRow,
        ...analysisFields,
        order_status: orderStatus,
        workflow_status: workflowStatus,
        model,
        status: "ok",
        error_message: null,
      },
      { onConflict: "business_slug,chat_id" }
    );
    if (upsertError) throw new Error(upsertError.message);

    // Never writes to `customers` — this is the AI-inferred memory table
    // only (see its migration comment). A full replace, not a field merge:
    // the model already saw the prior profile as context above and is
    // instructed to carry forward what still holds, so the row it returns
    // is the intended new state, not a delta.
    const { error: profileError } = await supabase.from("customer_ai_profile").upsert(
      {
        business_slug: businessSlug,
        contact_number: customerKey,
        ...profile,
      },
      { onConflict: "business_slug,contact_number" }
    );
    if (profileError) throw new Error(profileError.message);

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
        order_status: existingOrderStatus,
        workflow_status: workflowStatus,
        model,
        status: "error",
        error_message: message,
      },
      { onConflict: "business_slug,chat_id" }
    );
    return { chatId, status: "error", error: message };
  }
}
