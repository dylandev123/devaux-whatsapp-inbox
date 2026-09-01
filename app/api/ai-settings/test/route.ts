import { NextResponse } from "next/server";
import { AI_MODELS, AiModel } from "@/lib/aiSettings";
import { getAiSettings, recordTestResult, testOpenAiConnection } from "@/lib/server/aiSettings";

// Admin-only (see middleware.ts). Stateless verification — does not save
// anything except the last-test-result fields on ai_settings (for display
// on reload), so the admin can try a key before deciding to save it.

interface TestPayload {
  model?: string;
  apiKey?: string;
}

export async function POST(request: Request) {
  let payload: TestPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const model = payload.model;
  if (!model || !AI_MODELS.includes(model as AiModel)) {
    return NextResponse.json({ error: `model must be one of: ${AI_MODELS.join(", ")}` }, { status: 400 });
  }

  // Test the key the admin just typed, or fall back to whatever is
  // currently saved (a "re-test" of the existing configuration).
  let apiKey = payload.apiKey?.trim();
  if (!apiKey) {
    const settings = await getAiSettings();
    apiKey = settings.api_key ?? undefined;
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "No API key configured yet — enter one to test." });
  }

  const result = await testOpenAiConnection(apiKey, model as AiModel);
  await recordTestResult(result.ok, result.error ?? null);
  return NextResponse.json(result);
}
