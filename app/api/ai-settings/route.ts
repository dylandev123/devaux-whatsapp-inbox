import { NextResponse } from "next/server";
import { AI_MODELS, AiSettingsView } from "@/lib/aiSettings";
import { getAiSettings, saveAiSettings } from "@/lib/server/aiSettings";

// Admin-only (see middleware.ts — /api/ai-settings is in ADMIN_API_PREFIXES).
// GET/POST here never return the raw api_key — only a masked preview. The
// key itself is never sent to this route's caller after being saved; it can
// only be written, not read back.

function maskKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const tail = apiKey.slice(-4);
  return `sk-…${tail}`;
}

function toView(row: {
  model: string;
  api_key: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string;
}): AiSettingsView {
  return {
    model: row.model as AiSettingsView["model"],
    hasKey: Boolean(row.api_key),
    maskedKey: maskKey(row.api_key),
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok,
    lastTestError: row.last_test_error,
    updatedAt: row.updated_at,
  };
}

export async function GET() {
  try {
    const settings = await getAiSettings();
    return NextResponse.json(toView(settings));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load AI settings" },
      { status: 500 }
    );
  }
}

interface SavePayload {
  model?: string;
  apiKey?: string;
}

export async function POST(request: Request) {
  let payload: SavePayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { model, apiKey } = payload;
  if (!model || !AI_MODELS.includes(model as (typeof AI_MODELS)[number])) {
    return NextResponse.json(
      { error: `model must be one of: ${AI_MODELS.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    await saveAiSettings({ model: model as (typeof AI_MODELS)[number], apiKey });
    const settings = await getAiSettings();
    return NextResponse.json(toView(settings));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save AI settings" },
      { status: 500 }
    );
  }
}
