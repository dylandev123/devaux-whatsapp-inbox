import { NextResponse } from "next/server";
import { AGENT_MODES, AI_AGENT_PILOT_BUSINESSES, CONTACT_SCOPES, requiredConfidence } from "@/lib/aiAgent/engine";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, loadSettings, pilotSlug, SETTINGS_COLUMNS } from "@/lib/server/aiAgent/db";
import { getAiSettings } from "@/lib/server/aiSettings";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = pilotSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("businessSlug must be a pilot business", 400);

  try {
    const [settings, ai] = await Promise.all([loadSettings(businessSlug), getAiSettings().catch(() => null)]);
    if (!settings) return jsonError("AI agent settings row missing — apply the ai_agent migration", 404);
    return NextResponse.json({
      settings,
      pilotBusinesses: AI_AGENT_PILOT_BUSINESSES,
      requiredConfidence: requiredConfidence(settings.autonomy),
      bridgeConfigured: Boolean(process.env.AI_AGENT_BRIDGE_SECRET),
      aiKeyConfigured: Boolean(ai?.api_key),
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load settings", 500);
  }
}

interface Payload {
  businessSlug?: unknown;
  enabled?: unknown;
  mode?: unknown;
  contactScope?: unknown;
  autonomy?: unknown;
  staffGroupJid?: unknown;
  staffGroupName?: unknown;
  autoTakeoverMinutes?: unknown;
  maxAutoRepliesPerHour?: unknown;
  sendHoldingReply?: unknown;
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<Payload>(request);
  if (!body) return jsonError("Invalid JSON body", 400);
  const businessSlug = pilotSlug(body.businessSlug);
  if (!businessSlug) return jsonError("businessSlug must be a pilot business", 400);

  const patch: Record<string, unknown> = { updated_by: admin.userId };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return jsonError("enabled must be a boolean", 400);
    patch.enabled = body.enabled;
  }
  if (body.mode !== undefined) {
    if (!(AGENT_MODES as readonly unknown[]).includes(body.mode)) return jsonError("Invalid mode", 400);
    patch.mode = body.mode;
  }
  if (body.contactScope !== undefined) {
    if (!(CONTACT_SCOPES as readonly unknown[]).includes(body.contactScope)) return jsonError("Invalid contactScope", 400);
    patch.contact_scope = body.contactScope;
  }
  if (body.autonomy !== undefined) {
    const v = intIn(body.autonomy, 0, 100);
    if (v === null) return jsonError("autonomy must be an integer 0–100", 400);
    patch.autonomy = v;
  }
  if (body.staffGroupJid !== undefined) {
    if (body.staffGroupJid === null || body.staffGroupJid === "") {
      patch.staff_group_jid = null;
      patch.staff_group_name = null;
    } else if (typeof body.staffGroupJid === "string" && body.staffGroupJid.endsWith("@g.us")) {
      patch.staff_group_jid = body.staffGroupJid.trim();
      patch.staff_group_name = typeof body.staffGroupName === "string" ? body.staffGroupName.slice(0, 200) : null;
    } else {
      return jsonError("staffGroupJid must be a WhatsApp group id (…@g.us)", 400);
    }
  }
  if (body.autoTakeoverMinutes !== undefined) {
    const v = intIn(body.autoTakeoverMinutes, 0, 10080);
    if (v === null) return jsonError("autoTakeoverMinutes must be 0–10080", 400);
    patch.auto_takeover_minutes = v;
  }
  if (body.maxAutoRepliesPerHour !== undefined) {
    const v = intIn(body.maxAutoRepliesPerHour, 0, 60);
    if (v === null) return jsonError("maxAutoRepliesPerHour must be 0–60", 400);
    patch.max_auto_replies_per_hour = v;
  }
  if (body.sendHoldingReply !== undefined) {
    if (typeof body.sendHoldingReply !== "boolean") return jsonError("sendHoldingReply must be a boolean", 400);
    patch.send_holding_reply = body.sendHoldingReply;
  }

  try {
    const before = await loadSettings(businessSlug);
    const { data, error } = await agentDb()
      .from("ai_agent_settings")
      .update(patch)
      .eq("business_slug", businessSlug)
      .select(SETTINGS_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    await audit(businessSlug, "admin", admin.userId, "settings.update", { type: "settings", id: businessSlug }, {
      before,
      changes: patch,
    });
    return NextResponse.json({ settings: data, requiredConfidence: requiredConfidence(data.autonomy) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to save settings", 500);
  }
}
