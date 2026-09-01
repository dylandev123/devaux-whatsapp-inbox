// Client-safe: types and fetch helpers for the admin AI Settings page. The
// raw API key never appears here or anywhere in the browser — every shape
// below only ever carries a masked preview. Server-only logic (the actual
// key, the DB row, the OpenAI test call) lives in lib/server/aiSettings.ts.

export const AI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = "gpt-5.6-luna";

export interface AiSettingsView {
  model: AiModel;
  hasKey: boolean;
  maskedKey: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
}

export async function fetchAiSettings(): Promise<AiSettingsView> {
  const res = await fetch("/api/ai-settings", { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to load AI settings (${res.status})`);
  }
  return data as AiSettingsView;
}

export async function saveAiSettings(model: AiModel, apiKey?: string): Promise<AiSettingsView> {
  const res = await fetch("/api/ai-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, apiKey }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to save AI settings (${res.status})`);
  }
  return data as AiSettingsView;
}

export interface TestAiSettingsResult {
  ok: boolean;
  error?: string;
}

// Tests a not-yet-saved apiKey/model when apiKey is provided; tests the
// currently saved key when it's omitted (a "re-test" of what's already
// configured).
export async function testAiSettings(model: AiModel, apiKey?: string): Promise<TestAiSettingsResult> {
  const res = await fetch("/api/ai-settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, apiKey }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: data?.error ?? `Test failed (${res.status})` };
  }
  return data as TestAiSettingsResult;
}
