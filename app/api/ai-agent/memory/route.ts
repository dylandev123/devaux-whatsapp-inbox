import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { agentDb, audit, resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { loadIdentity } from "@/lib/server/aiAgent/identity";
import {
  addAdminFact,
  clearInferences,
  deleteFact,
  forgetCustomer,
  loadCustomerMemoryView,
  ownsKey,
  setOrderExcluded,
  updateFact,
} from "@/lib/server/aiAgent/memory";
import { primaryMemoryKey } from "@/lib/aiAgent/memory";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()). Inspect,
// correct and delete what the agent remembers about one customer of one
// business. Every lookup goes through the contact resolver, so a customer is
// only ever matched by a verified phone or their own chats — never by name or
// by lid digits. Audit entries carry ids and counts, never the remembered text.
export const dynamic = "force-dynamic";

const CHAT_JID = /^[0-9A-Za-z._:-]+@(s\.whatsapp\.net|c\.us|lid)$/;

function toChatId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (/^\d{8,15}$/.test(v)) return `${v}@s.whatsapp.net`;
  return CHAT_JID.test(v) ? v : null;
}

/** A listed memory key back to a chat the admin can open. */
function chatForKey(key: string): string {
  return key.startsWith("chat:") ? key.slice(5) : `${key}@s.whatsapp.net`;
}

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const params = new URL(request.url).searchParams;
  const businessSlug = await resolveBusinessSlug(params.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  try {
    const rawChat = params.get("chatId");
    if (!rawChat) {
      // Customers this business has remembered something about, newest first.
      const { data, error } = await agentDb()
        .from("ai_agent_customer_memory")
        .select("customer_key, updated_at")
        .eq("business_slug", businessSlug)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      const byKey = new Map<string, { customerKey: string; chatId: string; facts: number; updatedAt: string }>();
      for (const row of data ?? []) {
        const cur = byKey.get(row.customer_key);
        if (cur) cur.facts += 1;
        else byKey.set(row.customer_key, { customerKey: row.customer_key, chatId: chatForKey(row.customer_key), facts: 1, updatedAt: row.updated_at });
      }
      return NextResponse.json({ customers: [...byKey.values()].slice(0, 100) });
    }
    const chatId = toChatId(rawChat);
    if (!chatId) return jsonError("chatId must be a phone number or a customer WhatsApp id", 400);
    const identity = await loadIdentity(businessSlug, chatId, null);
    return NextResponse.json({ memory: await loadCustomerMemoryView(businessSlug, chatId, identity) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load memory", 500);
  }
}

interface Body {
  businessSlug?: unknown;
  chatId?: unknown;
  action?: unknown;
  id?: unknown;
  orderId?: unknown;
  kind?: unknown;
  content?: unknown;
  expiresAt?: unknown;
  fields?: unknown;
  includeOrders?: unknown;
  includeLogs?: unknown;
  confirm?: unknown;
}

const ADMIN_FACT_KINDS = ["preference", "delivery_preference", "note"];

async function context(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return { error: admin };
  const body = await readJson<Body>(request);
  if (!body) return { error: jsonError("Invalid JSON body", 400) };
  const businessSlug = await resolveBusinessSlug(body.businessSlug);
  if (!businessSlug) return { error: jsonError("Unknown businessSlug", 400) };
  const chatId = toChatId(body.chatId);
  if (!chatId) return { error: jsonError("chatId must be a phone number or a customer WhatsApp id", 400) };
  const identity = await loadIdentity(businessSlug, chatId, null);
  return { admin, body, businessSlug, chatId, identity };
}

/** The fact must exist in this business AND belong to this customer's identity. */
async function ownedFact(businessSlug: string, id: unknown, identity: Awaited<ReturnType<typeof loadIdentity>>) {
  if (typeof id !== "string") return null;
  const { data } = await agentDb()
    .from("ai_agent_customer_memory")
    .select("id, customer_key")
    .eq("id", id)
    .eq("business_slug", businessSlug)
    .maybeSingle();
  return data && ownsKey(identity, data.customer_key) ? data : null;
}

export async function POST(request: Request) {
  const ctx = await context(request);
  if ("error" in ctx) return ctx.error;
  const { admin, body, businessSlug, chatId, identity } = ctx;

  try {
    if (body.action === "add_fact") {
      if (!ADMIN_FACT_KINDS.includes(body.kind as string)) return jsonError("Invalid kind", 400);
      if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 300) {
        return jsonError("content is required (max 300 characters)", 400);
      }
      let expiresAt: string | null = null;
      if (typeof body.expiresAt === "string" && body.expiresAt) {
        if (Number.isNaN(Date.parse(body.expiresAt))) return jsonError("expiresAt must be an ISO date", 400);
        expiresAt = new Date(body.expiresAt).toISOString();
      }
      const fact = await addAdminFact({
        businessSlug,
        customerKey: primaryMemoryKey(chatId, identity),
        kind: body.kind as "preference" | "delivery_preference" | "note",
        content: body.content.trim(),
        chatId,
        adminId: admin.userId,
        expiresAt,
      });
      await audit(businessSlug, "admin", admin.userId, "memory.fact_add", { type: "memory", id: fact.id }, { kind: body.kind });
      return NextResponse.json({ fact });
    }

    if (body.action === "forget") {
      // Deliberately explicit: a typed confirmation, and orders / logs only on request.
      if (body.confirm !== "DELETE") return jsonError('Type DELETE to confirm deleting this customer\'s data', 400);
      const result = await forgetCustomer(businessSlug, identity, {
        includeOrders: body.includeOrders === true,
        includeLogs: body.includeLogs === true,
      });
      await audit(businessSlug, "admin", admin.userId, "memory.forget", { type: "customer", id: primaryMemoryKey(chatId, identity) }, {
        ...result,
        include_orders: body.includeOrders === true,
        include_logs: body.includeLogs === true,
      });
      return NextResponse.json({ result });
    }
    return jsonError("Unknown action", 400);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Memory action failed", 500);
  }
}

export async function PATCH(request: Request) {
  const ctx = await context(request);
  if ("error" in ctx) return ctx.error;
  const { admin, body, businessSlug, identity } = ctx;

  try {
    switch (body.action) {
      case "update_fact": {
        if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 300) {
          return jsonError("content is required (max 300 characters)", 400);
        }
        if (!(await ownedFact(businessSlug, body.id, identity))) return jsonError("Fact not found for this customer", 404);
        const fact = await updateFact(businessSlug, body.id as string, body.content.trim(), admin.userId);
        await audit(businessSlug, "admin", admin.userId, "memory.fact_update", { type: "memory", id: body.id as string });
        return NextResponse.json({ fact });
      }
      case "exclude_order":
      case "include_order": {
        if (typeof body.orderId !== "string") return jsonError("orderId is required", 400);
        const excluded = body.action === "exclude_order";
        const ok = await setOrderExcluded(businessSlug, body.orderId, identity.chatIds, identity.phone, excluded);
        if (!ok) return jsonError("Order not found for this customer", 404);
        await audit(businessSlug, "admin", admin.userId, `memory.order_${excluded ? "exclude" : "include"}`, { type: "order", id: body.orderId });
        return NextResponse.json({ ok: true });
      }
      case "clear_inference": {
        const fields = Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === "string") : [];
        const ok = await clearInferences(businessSlug, identity, fields);
        if (!ok) return jsonError("Nothing to clear (no verified phone, or unknown fields)", 400);
        await audit(businessSlug, "admin", admin.userId, "memory.inference_clear", { type: "customer" }, { fields });
        return NextResponse.json({ ok: true });
      }
      default:
        return jsonError("Unknown action", 400);
    }
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Memory action failed", 500);
  }
}

export async function DELETE(request: Request) {
  const ctx = await context(request);
  if ("error" in ctx) return ctx.error;
  const { admin, body, businessSlug, identity } = ctx;
  try {
    if (!(await ownedFact(businessSlug, body.id, identity))) return jsonError("Fact not found for this customer", 404);
    await deleteFact(businessSlug, body.id as string);
    await audit(businessSlug, "admin", admin.userId, "memory.fact_delete", { type: "memory", id: body.id as string });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Delete failed", 500);
  }
}
