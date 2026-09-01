import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { analyzeConversation, listConversations } from "@/lib/server/analysisEngine";
import { getAiSettings } from "@/lib/server/aiSettings";

// Any authenticated staff member may trigger analysis (see middleware.ts —
// this path requires login but not the admin role, same as the main inbox).
// Read-only: this only ever reads whatsapp_messages/customers and writes
// conversation_analysis — never whatsapp_messages/whatsapp_sessions, and
// never anything sent back to WhatsApp.

// Bulk runs are capped per call so one request can't run indefinitely or
// blow through a serverless timeout on a business with a large backlog —
// the dashboard's "Analyze new" button reports how many are left and can
// simply be clicked again.
const BULK_BATCH_LIMIT = 15;

interface RunPayload {
  businessSlug?: string;
  chatId?: string;
}

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey);
}

export async function POST(request: Request) {
  // Checked up front (not just inside analyzeConversation) so a bulk run
  // fails clearly and immediately instead of burning through a whole batch
  // writing the same "not configured" error row for every conversation.
  const settings = await getAiSettings().catch(() => null);
  if (!settings?.api_key) {
    return NextResponse.json(
      { error: "AI analysis isn't set up yet — add an OpenAI API key on the AI Settings page." },
      { status: 400 }
    );
  }
  const supabase = supabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase service role is not configured" }, { status: 500 });
  }

  let payload: RunPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { businessSlug, chatId } = payload;
  if (!businessSlug) {
    return NextResponse.json({ error: "businessSlug is required" }, { status: 400 });
  }

  // Single conversation: manual (re-)analysis, always runs regardless of
  // staleness.
  if (chatId) {
    try {
      const result = await analyzeConversation(businessSlug, chatId);
      if (result.status === "error") {
        return NextResponse.json({ error: result.error ?? "Analysis failed" }, { status: 502 });
      }
      return NextResponse.json({ analyzed: 1, skipped: 0, failed: 0 });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Analysis failed" },
        { status: 500 }
      );
    }
  }

  // Bulk: every conversation for this business that's new or has messages
  // newer than its last stored analysis.
  try {
    const [conversations, { data: existingRows, error: existingError }] = await Promise.all([
      listConversations(businessSlug),
      supabase
        .from("conversation_analysis")
        .select("chat_id, message_count, last_message_at")
        .eq("business_slug", businessSlug),
    ]);
    if (existingError) throw new Error(existingError.message);

    const existingByChat = new Map((existingRows ?? []).map((r) => [r.chat_id, r]));
    const stale = conversations
      .filter((c) => {
        const existing = existingByChat.get(c.chatId);
        if (!existing) return true;
        if (!existing.last_message_at) return true;
        return new Date(c.lastMessageAt).getTime() > new Date(existing.last_message_at).getTime();
      })
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

    const batch = stale.slice(0, BULK_BATCH_LIMIT);
    let analyzed = 0;
    let failed = 0;
    for (const conversation of batch) {
      const result = await analyzeConversation(businessSlug, conversation.chatId);
      if (result.status === "ok") analyzed += 1;
      else failed += 1;
    }

    return NextResponse.json({
      analyzed,
      failed,
      skipped: stale.length - batch.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Analysis run failed" },
      { status: 500 }
    );
  }
}
