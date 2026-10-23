"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, SettingsResponse } from "@/lib/aiAgent/client";
import { AI_AGENT_PILOT_BUSINESSES } from "@/lib/aiAgent/engine";
import { fetchKnownChats, KnownChat } from "@/lib/knownChats";
import { businessLabel } from "@/lib/whatsapp";
import { ActivityPanel } from "@/components/admin/aiAgent/ActivityPanel";
import { ContactPermissions } from "@/components/admin/aiAgent/ContactPermissions";
import { ConversationsPanel } from "@/components/admin/aiAgent/ConversationsPanel";
import { EscalationsPanel } from "@/components/admin/aiAgent/EscalationsPanel";
import { KnowledgePanel } from "@/components/admin/aiAgent/KnowledgePanel";
import { ReviewPanel } from "@/components/admin/aiAgent/ReviewPanel";
import { SettingsCard } from "@/components/admin/aiAgent/SettingsCard";
import { TestConsole } from "@/components/admin/aiAgent/TestConsole";
import { inputClass, Notice } from "@/components/admin/aiAgent/ui";

const TABS = [
  { id: "setup", label: "Setup" },
  { id: "knowledge", label: "Knowledge" },
  { id: "escalations", label: "Escalations" },
  { id: "takeover", label: "Takeover" },
  { id: "review", label: "Review" },
  { id: "activity", label: "Activity" },
  { id: "test", label: "Test console" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function AiAgentPage() {
  const [businessSlug, setBusinessSlug] = useState<string>(AI_AGENT_PILOT_BUSINESSES[0]);
  const [tab, setTab] = useState<TabId>("setup");
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [chats, setChats] = useState<KnownChat[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const [settings, known] = await Promise.all([aiAgentApi.getSettings(businessSlug), fetchKnownChats(businessSlug, [])]);
      setData(settings);
      setChats(known.chats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the AI agent");
    }
  }, [businessSlug]);

  useEffect(() => {
    load();
  }, [load]);

  function onSettingsSaved(next: SettingsResponse["settings"]) {
    setData((prev) => (prev ? { ...prev, settings: next } : prev));
  }

  const s = data?.settings;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {AI_AGENT_PILOT_BUSINESSES.length > 1 ? (
          <select value={businessSlug} onChange={(e) => setBusinessSlug(e.target.value)} className={`${inputClass} w-auto`}>
            {AI_AGENT_PILOT_BUSINESSES.map((b) => (
              <option key={b} value={b}>
                {businessLabel(b)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium text-zinc-900">{businessLabel(businessSlug)}</span>
        )}
        {s && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.enabled ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-600"}`}>
            {s.enabled ? `ON · ${s.mode}` : "OFF"}
          </span>
        )}
        <span className="text-xs text-zinc-400">Pilot — every other business stays off.</span>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-zinc-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`cursor-pointer border-b-2 px-3 py-1.5 text-sm ${
              tab === t.id ? "border-emerald-600 font-medium text-emerald-700" : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {data && s && (
        <>
          {tab === "setup" && (
            <>
              <SettingsCard key={s.updated_at} businessSlug={businessSlug} data={data} chats={chats} onSaved={onSettingsSaved} />
              <ContactPermissions businessSlug={businessSlug} scope={s.contact_scope} chats={chats} onScopeSaved={onSettingsSaved} />
            </>
          )}
          {tab === "knowledge" && <KnowledgePanel businessSlug={businessSlug} />}
          {tab === "escalations" && <EscalationsPanel businessSlug={businessSlug} />}
          {tab === "takeover" && <ConversationsPanel businessSlug={businessSlug} chats={chats} />}
          {tab === "review" && <ReviewPanel businessSlug={businessSlug} />}
          {tab === "activity" && <ActivityPanel businessSlug={businessSlug} />}
          {tab === "test" && <TestConsole businessSlug={businessSlug} chats={chats} />}
        </>
      )}
    </div>
  );
}
