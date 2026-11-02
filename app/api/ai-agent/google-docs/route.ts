import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import {
  AdminError,
  disconnectGoogle,
  getDashboard,
  importCommit,
  importPreview,
  resolveLine,
  retryNow,
  saveConfig,
  setDocument,
  setEnabled,
  testStoredDocument,
  type Resolution,
} from "@/lib/server/aiAgent/googleDocs/admin";
import { runSync } from "@/lib/server/aiAgent/googleDocs/sync";

// Admin-only (middleware.ts ADMIN_API_PREFIXES + requireAdmin()), like every /api/ai-agent route. Every action is scoped to
// one business slug and uses that business's own stored document. Nothing here can message a customer. Only sync_now,
// retry_all, import_commit and resolve (again) ever write to the Google Doc — one new line at the top — and only when sync is
// enabled. The access test (set_document / test_access) reads Drive metadata only and never downloads the document.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESOLUTIONS: Resolution[] = ["present", "again", "skip"];

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const businessSlug = await resolveBusinessSlug(new URL(request.url).searchParams.get("businessSlug"));
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);
  try {
    return NextResponse.json(await getDashboard(businessSlug));
  } catch (err) {
    console.error("[google-docs GET]", err);
    return jsonError("Failed to load Google Docs sync", 500);
  }
}

interface Body {
  businessSlug?: string;
  action?: string;
  input?: unknown;
  enabled?: unknown;
  orderIds?: unknown;
  confirm?: unknown;
  lineId?: unknown;
  resolution?: unknown;
  config?: Record<string, unknown>;
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<Body>(request);
  if (!body || typeof body.action !== "string") return jsonError("Invalid request", 400);
  const businessSlug = await resolveBusinessSlug(body.businessSlug);
  if (!businessSlug) return jsonError("Unknown businessSlug", 400);

  try {
    switch (body.action) {
      case "set_document":
        return NextResponse.json({ access: await setDocument(businessSlug, String(body.input ?? ""), admin.userId) });
      case "test_access":
        return NextResponse.json({ access: await testStoredDocument(businessSlug) });
      case "save_config":
        await saveConfig(businessSlug, body.config ?? {}, admin.userId);
        return NextResponse.json({ ok: true });
      case "set_enabled":
        if (typeof body.enabled !== "boolean") return jsonError("enabled must be true or false", 400);
        await setEnabled(businessSlug, body.enabled, admin.userId);
        return NextResponse.json({ ok: true });
      case "sync_now": {
        const result = await runSync(businessSlug, { manual: true });
        if (result.status === "disabled") return jsonError("Turn sync on first.", 409);
        return NextResponse.json({ result });
      }
      case "import_preview":
        return NextResponse.json({ preview: await importPreview(businessSlug) });
      case "import_commit": {
        // Importing existing orders is a deliberate, explicit act: the browser must send confirm: true with the chosen ids.
        if (body.confirm !== true || !Array.isArray(body.orderIds)) return jsonError("Confirm the import and choose the orders to add.", 400);
        const ids = body.orderIds.filter((v): v is string => typeof v === "string").slice(0, 200);
        return NextResponse.json({ result: await importCommit(businessSlug, ids, admin.userId) });
      }
      case "resolve": {
        if (typeof body.lineId !== "string" || !RESOLUTIONS.includes(body.resolution as Resolution)) return jsonError("Invalid resolution", 400);
        return NextResponse.json({ result: await resolveLine(businessSlug, body.lineId, body.resolution as Resolution, admin.userId) });
      }
      case "retry_all":
        return NextResponse.json({ result: await retryNow(businessSlug) });
      case "disconnect":
        await disconnectGoogle(businessSlug, admin.userId);
        return NextResponse.json({ ok: true });
      default:
        return jsonError("Unknown action", 400);
    }
  } catch (err) {
    if (err instanceof AdminError) return jsonError(err.message, err.status);
    console.error("[google-docs POST]", body.action, err instanceof Error ? err.message : err);
    return jsonError("Google Docs action failed", 500);
  }
}
