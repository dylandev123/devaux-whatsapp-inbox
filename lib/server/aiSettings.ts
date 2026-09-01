// Server-only: reads/writes the single-row `ai_settings` table and tests an
// OpenAI key. Never imported from a client component — the raw API key must
// never reach the browser (see the migration's comment for the RLS
// rationale). Used by app/api/ai-settings/*, and by
// lib/server/analysisEngine.ts to fetch the configured model/key for
// analysis.

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { AI_MODELS, AiModel } from "@/lib/aiSettings";

export interface AiSettingsRow {
  model: AiModel;
  api_key: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string;
}

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service role is not configured (SUPABASE_SERVICE_ROLE_KEY missing)");
  }
  return createClient(url, serviceKey);
}

// The row is seeded by the migration, but tolerate it being absent (e.g. the
// migration hasn't been run yet) rather than throwing a confusing "no rows"
// error — callers get the same defaults the migration seeds.
export async function getAiSettings(): Promise<AiSettingsRow> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("ai_settings")
    .select("model, api_key, last_tested_at, last_test_ok, last_test_error, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (
    data ?? {
      model: "gpt-5.6-luna",
      api_key: null,
      last_tested_at: null,
      last_test_ok: null,
      last_test_error: null,
      updated_at: new Date().toISOString(),
    }
  );
}

export interface SaveAiSettingsInput {
  model: AiModel;
  // Omitted/undefined leaves the currently stored key untouched — the admin
  // UI only ever sends a new key when the admin actually typed one into the
  // (otherwise masked) field.
  apiKey?: string;
}

export async function saveAiSettings(input: SaveAiSettingsInput): Promise<void> {
  if (!AI_MODELS.includes(input.model)) {
    throw new Error(`Invalid model: ${input.model}`);
  }
  const supabase = supabaseAdmin();

  const patch: Record<string, unknown> = { id: 1, model: input.model };
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    patch.api_key = input.apiKey.trim();
  }

  const { error } = await supabase.from("ai_settings").upsert(patch, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

export async function recordTestResult(ok: boolean, errorMessage: string | null): Promise<void> {
  const supabase = supabaseAdmin();
  await supabase
    .from("ai_settings")
    .upsert(
      {
        id: 1,
        last_tested_at: new Date().toISOString(),
        last_test_ok: ok,
        last_test_error: errorMessage,
      },
      { onConflict: "id" }
    );
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
}

// Exercises the exact call shape lib/server/analysisEngine.ts uses (a
// minimal Responses API call), so a successful test is a real end-to-end
// verification of the same code path analysis will run — not just "is this
// string shaped like a key".
export async function testOpenAiConnection(apiKey: string, model: AiModel): Promise<ConnectionTestResult> {
  if (!apiKey.trim()) {
    return { ok: false, error: "API key is required" };
  }
  try {
    const client = new OpenAI({ apiKey: apiKey.trim() });
    const response = await client.responses.create({
      model,
      instructions: "Reply with exactly one word: OK",
      input: "Connection test.",
      max_output_tokens: 16,
    });
    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      return { ok: false, error: `${err.status ?? ""} ${err.message}`.trim() };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
