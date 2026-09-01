"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AI_MODELS,
  AiModel,
  AiSettingsView,
  fetchAiSettings,
  saveAiSettings,
  testAiSettings,
} from "@/lib/aiSettings";

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<AiModel>("gpt-5.6-luna");
  const [apiKeyInput, setApiKeyInput] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAiSettings();
      setSettings(data);
      setModel(data.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await testAiSettings(model, apiKeyInput || undefined);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    setError(null);
    try {
      const updated = await saveAiSettings(model, apiKeyInput || undefined);
      setSettings(updated);
      setApiKeyInput("");
      setSaveMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save AI settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {settings && !settings.hasKey && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No OpenAI API key configured yet — conversation analysis will fail with a clear error
          until one is saved here.
        </p>
      )}

      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">OpenAI API key</label>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={settings?.maskedKey ?? "sk-…"}
            autoComplete="off"
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
          />
          <p className="mt-1 text-xs text-zinc-400">
            {settings?.hasKey
              ? `Current key ends in ${settings.maskedKey?.replace("sk-…", "")}. Leave blank to keep it — only enter a new value to replace it.`
              : "No key saved yet."}
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Analysis model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as AiModel)}
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
          >
            {AI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || (!apiKeyInput && !settings?.hasKey)}
            className="cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {testResult && (
          <p
            className={`rounded-md px-3 py-2 text-sm ${
              testResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
            }`}
          >
            {testResult.ok ? "Connection OK." : `Connection failed: ${testResult.error}`}
          </p>
        )}
        {saveMessage && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{saveMessage}</p>}

        {settings && (
          <p className="text-xs text-zinc-400">
            Last tested: {formatDateTime(settings.lastTestedAt)}
            {settings.lastTestedAt &&
              (settings.lastTestOk ? " (OK)" : ` (failed: ${settings.lastTestError ?? "unknown error"})`)}
          </p>
        )}
      </div>
    </section>
  );
}
