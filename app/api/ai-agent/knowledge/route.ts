import { NextResponse } from "next/server";
import { KNOWLEDGE_KINDS } from "@/lib/aiAgent/engine";
import { candidateFingerprint } from "@/lib/aiAgent/staffAnswers";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, KNOWLEDGE_ADMIN_COLUMNS, KNOWLEDGE_COLUMNS, KnowledgeRow, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { loadSources, type SourceInfo, type SourceRef } from "@/lib/server/aiAgent/learningSources";

// Admin-only. Business knowledge: the only facts the agent may state. Any edit
// to an approved entry sends it back to draft until it is re-approved.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  const { data, error } = await agentDb()
    .from("ai_agent_knowledge")
    .select(KNOWLEDGE_ADMIN_COLUMNS)
    .eq("business_slug", businessSlug)
    .order("kind")
    .order("title");
  if (error) return jsonError(error.message, 500);
  const entries = (data ?? []) as unknown as (KnowledgeRow & SourceRef)[];
  // Where each automatic fact came from. The original message is read from the inbox now, for this admin only — it is
  // never stored with the knowledge. A failed lookup only leaves the source out.
  let sources = new Map<string, SourceInfo>();
  try {
    sources = await loadSources(businessSlug, entries.filter((e) => e.source === "auto"), { withText: true });
  } catch (err) {
    console.error("[ai-agent/knowledge] source lookup", err instanceof Error ? err.message : err);
  }
  return NextResponse.json({
    entries: entries.map(({ learned_message_id: _message, learned_chat_id: _chat, ...entry }) => {
      const src = sources.get(entry.id);
      return {
        ...entry,
        source_info: src ? { chat_id: src.chatId, message_id: src.messageId, at: src.at, original: src.original, original_available: src.originalAvailable } : null,
      };
    }),
  });
}

interface Fields {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  expiresAt?: unknown;
}

function validateFields(body: Fields, partial: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (body.kind !== undefined || !partial) {
    if (!(KNOWLEDGE_KINDS as readonly unknown[]).includes(body.kind)) return "Invalid kind";
    out.kind = body.kind;
  }
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== "string" || !body.title.trim()) return "title is required";
    out.title = body.title.trim().slice(0, 200);
  }
  if (body.content !== undefined || !partial) {
    if (typeof body.content !== "string" || !body.content.trim()) return "content is required";
    if (body.content.length > 4000) return "content must be at most 4000 characters";
    out.content = body.content.trim();
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null || body.expiresAt === "") out.expires_at = null;
    else if (typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt))) {
      out.expires_at = new Date(body.expiresAt).toISOString();
    } else return "expiresAt must be an ISO date or null";
  }
  return out;
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<Fields & { businessSlug?: unknown; approve?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  const fields = validateFields(body, false);
  if (typeof fields === "string") return jsonError(fields, 400);

  const approve = body.approve === true;
  const now = new Date().toISOString();
  const { data, error } = await agentDb()
    .from("ai_agent_knowledge")
    .insert({
      ...fields,
      business_slug: businessSlug,
      source: "admin",
      status: approve ? "approved" : "draft",
      approved_by: approve ? admin.userId : null,
      approved_at: approve ? now : null,
      created_by: admin.userId,
      updated_by: admin.userId,
    })
    .select(KNOWLEDGE_COLUMNS)
    .single();
  if (error) return jsonError(error.message, 500);
  await audit(businessSlug, "admin", admin.userId, "knowledge.create", { type: "knowledge", id: data.id }, {
    status: data.status,
    title: data.title,
  });
  return NextResponse.json({ entry: data });
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<Fields & { businessSlug?: unknown; id?: unknown; action?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug || typeof body.id !== "string") return jsonError("businessSlug and id are required", 400);

  const db = agentDb();
  const { data: before, error: loadError } = await db
    .from("ai_agent_knowledge")
    .select(KNOWLEDGE_COLUMNS)
    .eq("id", body.id)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  if (loadError) return jsonError(loadError.message, 500);
  if (!before) return jsonError("Knowledge entry not found", 404);
  const prev = before as KnowledgeRow;

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  switch (body.action) {
    case "approve":
      patch = { status: "approved", approved_by: admin.userId, approved_at: now };
      break;
    case "archive":
      // Archived, never deleted. Marked "forgotten" so a repeat of the same message does not relearn it right away.
      patch = {
        status: "archived",
        archived_reason: "forgotten",
        archived_at: now,
        archived_by: admin.userId,
        fingerprint: prev.fingerprint ?? candidateFingerprint(prev.content),
      };
      break;
    case "restore":
      patch = { status: "draft", approved_by: null, approved_at: null, archived_reason: null, archived_at: null, archived_by: null };
      break;
    case "update": {
      const fields = validateFields(body, true);
      if (typeof fields === "string") return jsonError(fields, 400);
      const factsChanged = ["kind", "title", "content"].some(
        (k) => k in fields && fields[k] !== prev[k as keyof KnowledgeRow]
      );
      patch = {
        ...fields,
        version: factsChanged ? prev.version + 1 : prev.version,
        // Changed facts must be re-approved before the agent uses them again.
        ...(factsChanged ? { status: "draft", approved_by: null, approved_at: null } : {}),
      };
      break;
    }
    default:
      return jsonError('action must be "update", "approve", "archive" or "restore"', 400);
  }

  const { data, error } = await db
    .from("ai_agent_knowledge")
    .update({ ...patch, updated_by: admin.userId })
    .eq("id", prev.id)
    .eq("business_slug", businessSlug)
    .select(KNOWLEDGE_COLUMNS)
    .single();
  if (error) return jsonError(error.message, 500);
  await audit(businessSlug, "admin", admin.userId, `knowledge.${body.action}`, { type: "knowledge", id: prev.id }, {
    before: { title: prev.title, content: prev.content, status: prev.status, version: prev.version },
    after: { title: data.title, content: data.content, status: data.status, version: data.version },
  });
  return NextResponse.json({ entry: data });
}
