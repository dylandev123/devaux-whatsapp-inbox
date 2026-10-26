import { NextResponse } from "next/server";
import { AGENT_MODES, CONTACT_SCOPES, PASSIVE_LEARNING_SCOPES, requiredConfidence } from "@/lib/aiAgent/engine";
import { isCustomerMode } from "@/lib/aiAgent/customerMode";
import { parseAuthorizedSenders } from "@/lib/aiAgent/identity";
import { validateBatchWindow } from "@/lib/aiAgent/batching";
import { isValidTimezone } from "@/lib/aiAgent/orders";
import { normalizeGroupJid } from "@/lib/aiAgent/chatDirectory";
import { loadBusinessChats } from "@/lib/server/aiAgent/chats";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, ensureSettings, loadSettings, resolveBusinessSlug, SETTINGS_COLUMNS } from "@/lib/server/aiAgent/db";
import { getAiSettings } from "@/lib/server/aiSettings";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  try {
    // First visit to a business creates its row with the safe defaults
    // (OFF / observe / no contacts); it is never enabled here.
    const [settings, ai] = await Promise.all([ensureSettings(businessSlug), getAiSettings().catch(() => null)]);
    return NextResponse.json({
      settings,
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
  staffGroupManual?: unknown;
  autoTakeoverMinutes?: unknown;
  maxAutoRepliesPerHour?: unknown;
  sendHoldingReply?: unknown;
  staffNoticesEnabled?: unknown;
  batchingEnabled?: unknown;
  batchQuietSeconds?: unknown;
  batchMaxWaitSeconds?: unknown;
  customerMemoryEnabled?: unknown;
  staffAuthorizedSenders?: unknown;
  defaultCustomerMode?: unknown;
  passiveLearningScope?: unknown;
  knowledgeConfirmViaWhatsapp?: unknown;
  ordersTrackingEnabled?: unknown;
  ordersSummaryEnabled?: unknown;
  ordersGroupJid?: unknown;
  ordersGroupName?: unknown;
  ordersGroupManual?: unknown;
  ordersTimezone?: unknown;
  ordersSummaryHour?: unknown;
  ordersCustomerConfirms?: unknown;
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<Payload>(request);
  if (!body) return jsonError("Invalid JSON body", 400);
  const businessSlug = await resolveBusinessSlug(body.businessSlug);
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

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
    } else if (typeof body.staffGroupJid === "string" && normalizeGroupJid(body.staffGroupJid)) {
      const jid = normalizeGroupJid(body.staffGroupJid)!;
      // A group must be one this business has seen, unless the admin typed
      // the JID in explicitly (staffGroupManual) for a group with no stored
      // messages yet. Keeps another business's groups out of the dropdown path.
      const current = await loadSettings(businessSlug);
      if (current?.staff_group_jid !== jid && body.staffGroupManual !== true) {
        try {
          const known = await loadBusinessChats(businessSlug);
          if (!known.groups.some((g) => g.chatId.toLowerCase() === jid)) {
            return jsonError("That group has no messages for this business — pick a discovered group or enter its JID manually", 400);
          }
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "Failed to verify the group", 500);
        }
      }
      patch.staff_group_jid = jid;
      patch.staff_group_name = typeof body.staffGroupName === "string" ? body.staffGroupName.trim().slice(0, 200) || null : null;
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
  if (body.staffNoticesEnabled !== undefined) {
    if (typeof body.staffNoticesEnabled !== "boolean") return jsonError("staffNoticesEnabled must be a boolean", 400);
    patch.staff_notices_enabled = body.staffNoticesEnabled;
  }

  if (body.batchingEnabled !== undefined) {
    if (typeof body.batchingEnabled !== "boolean") return jsonError("batchingEnabled must be a boolean", 400);
    patch.batching_enabled = body.batchingEnabled;
  }
  if (body.customerMemoryEnabled !== undefined) {
    if (typeof body.customerMemoryEnabled !== "boolean") return jsonError("customerMemoryEnabled must be a boolean", 400);
    patch.customer_memory_enabled = body.customerMemoryEnabled;
  }
  if (body.defaultCustomerMode !== undefined) {
    if (!isCustomerMode(body.defaultCustomerMode)) return jsonError("defaultCustomerMode must be auto_reply, staff_first or manual_only", 400);
    patch.default_customer_mode = body.defaultCustomerMode;
  }
  if (body.passiveLearningScope !== undefined) {
    if (!(PASSIVE_LEARNING_SCOPES as readonly unknown[]).includes(body.passiveLearningScope)) return jsonError("passiveLearningScope must be off, staff_group or staff_group_and_chats", 400);
    patch.passive_learning_scope = body.passiveLearningScope;
  }
  if (body.knowledgeConfirmViaWhatsapp !== undefined) {
    if (typeof body.knowledgeConfirmViaWhatsapp !== "boolean") return jsonError("knowledgeConfirmViaWhatsapp must be a boolean", 400);
    patch.knowledge_confirm_via_whatsapp = body.knowledgeConfirmViaWhatsapp;
  }
  if (body.ordersTrackingEnabled !== undefined) {
    if (typeof body.ordersTrackingEnabled !== "boolean") return jsonError("ordersTrackingEnabled must be a boolean", 400);
    patch.orders_tracking_enabled = body.ordersTrackingEnabled;
    // Remember when tracking (re)started: the report says earlier conversations were not analysed.
    const current = await loadSettings(businessSlug);
    if (body.ordersTrackingEnabled && current?.orders_tracking_enabled !== true) patch.orders_tracking_since = new Date().toISOString();
  }
  if (body.ordersCustomerConfirms !== undefined) {
    if (typeof body.ordersCustomerConfirms !== "boolean") return jsonError("ordersCustomerConfirms must be a boolean", 400);
    patch.orders_customer_confirms = body.ordersCustomerConfirms;
  }
  if (body.ordersSummaryEnabled !== undefined) {
    if (typeof body.ordersSummaryEnabled !== "boolean") return jsonError("ordersSummaryEnabled must be a boolean", 400);
    patch.orders_summary_enabled = body.ordersSummaryEnabled;
  }
  if (body.ordersSummaryHour !== undefined) {
    const v = intIn(body.ordersSummaryHour, 0, 23);
    if (v === null) return jsonError("ordersSummaryHour must be a whole hour 0–23", 400);
    patch.orders_summary_hour = v;
  }
  if (body.ordersTimezone !== undefined) {
    if (typeof body.ordersTimezone !== "string" || !isValidTimezone(body.ordersTimezone)) return jsonError("ordersTimezone must be a valid IANA timezone, e.g. America/St_Lucia", 400);
    patch.orders_timezone = body.ordersTimezone;
  }
  if (body.ordersGroupJid !== undefined) {
    if (body.ordersGroupJid === null || body.ordersGroupJid === "") {
      // No separate group: the summary goes to the staff group.
      patch.orders_group_jid = null;
      patch.orders_group_name = null;
    } else if (typeof body.ordersGroupJid === "string" && normalizeGroupJid(body.ordersGroupJid)) {
      const jid = normalizeGroupJid(body.ordersGroupJid)!;
      const current = await loadSettings(businessSlug);
      // Same rule as the staff group: only a group this business has seen, unless typed in explicitly.
      if (current?.orders_group_jid !== jid && body.ordersGroupManual !== true) {
        try {
          const known = await loadBusinessChats(businessSlug);
          if (!known.groups.some((g) => g.chatId.toLowerCase() === jid)) {
            return jsonError("That group has no messages for this business — pick a discovered group or enter its JID manually", 400);
          }
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "Failed to verify the group", 500);
        }
      }
      patch.orders_group_jid = jid;
      patch.orders_group_name = typeof body.ordersGroupName === "string" ? body.ordersGroupName.trim().slice(0, 200) || null : null;
    } else {
      return jsonError("ordersGroupJid must be a WhatsApp group id (…@g.us)", 400);
    }
  }
  if (body.staffAuthorizedSenders !== undefined) {
    // Verified WhatsApp identities only: phone numbers or exact …@lid ids — never names.
    const parsed = parseAuthorizedSenders(body.staffAuthorizedSenders);
    if (!parsed.ok) return jsonError(parsed.error, 400);
    patch.staff_authorized_senders = parsed.senders;
  }

  try {
    const before = await ensureSettings(businessSlug);
    // The quiet period and maximum wait are validated together, against whatever
    // the other one currently is, so the pair can never end up inconsistent.
    if (body.batchQuietSeconds !== undefined || body.batchMaxWaitSeconds !== undefined) {
      const window = validateBatchWindow({
        quiet: (body.batchQuietSeconds ?? before.batch_quiet_seconds) as number,
        maxWait: (body.batchMaxWaitSeconds ?? before.batch_max_wait_seconds) as number,
      });
      if (!window.ok) return jsonError(window.error, 400);
      patch.batch_quiet_seconds = window.quiet;
      patch.batch_max_wait_seconds = window.maxWait;
    }
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
