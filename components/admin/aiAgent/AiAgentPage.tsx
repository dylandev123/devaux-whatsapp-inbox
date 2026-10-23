"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, AgentBusiness, SettingsResponse } from "@/lib/aiAgent/client";
import { fetchKnownChats, KnownChat } from "@/lib/knownChats";
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
  const [businesses, setBusinesses] = useState<AgentBusiness[] | null>(null);
  const [businessSlug, setBusinessSlug] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("setup");
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [chats, setChats] = useState<KnownChat[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshBusinesses = useCallback(async () => {
    try {
      const res = await aiAgentApi.getBusinesses();
      setBusinesses(res.businesses);
      // First load only: land on the first listed business. Never auto-enables anything.
      setBusinessSlug((cur) => cur ?? res.businesses[0]?.businessSlug ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load businesses");
    }
  }, []);

  useEffect(() => {
    refreshBusinesses();
  }, [refreshBusinesses]);

  useEffect(() => {
    if (!businessSlug) return;
    // Ignore a response that arrives after the admin switched to another business.
    let cancelled = false;
    setError(null);
    setData(null);
    setChats([]);
    Promise.all([aiAgentApi.getSettings(businessSlug), fetchKnownChats(businessSlug, [])])
      .then(([settings, known]) => {
        if (cancelled) return;
        setData(settings);
        setChats(known.chats);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the AI agent");
      });
    return () => {
      cancelled = true;
    };
  }, [businessSlug]);

  function onSettingsSaved(next: SettingsResponse["settings"]) {
    setData((prev) => (prev ? { ...prev, settings: next } : prev));
    refreshBusinesses();
  }

  const s = data?.settings;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {businesses?.map((b) => {
          const selected = b.businessSlug === businessSlug;
          return (
            <button
              key={b.businessSlug}
              type="button"
              onClick={() => setBusinessSlug(b.businessSlug)}
              aria-pressed={selected}
              title={`WhatsApp: ${b.connection}${b.sessionStatus ? ` (${b.sessionStatus})` : ""}`}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                selected ? "border-emerald-600 bg-emerald-50 font-medium text-emerald-800" : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${b.connection === "connected" ? "bg-emerald-500" : b.connection === "unknown" ? "bg-amber-400" : "bg-zinc-300"}`}
              />
              {b.label}
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${b.enabled ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-600"}`}>
                {b.enabled ? `ON · ${b.mode}` : "OFF"}
              </span>
            </button>
          );
        })}
        {businesses && businesses.length === 0 && <span className="text-sm text-zinc-500">No connected WhatsApp businesses found.</span>}
        {!businesses && !error && <span className="text-sm text-zinc-500">Loading businesses…</span>}
        <span className="text-xs text-zinc-400">New businesses start OFF · observe · no contacts.</span>
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

      {data && s && businessSlug && (
        <>
          {tab === "setup" && (
            <>
              <SettingsCard key={`${businessSlug}:${s.updated_at}`} businessSlug={businessSlug} data={data} onSaved={onSettingsSaved} />
              <ContactPermissions businessSlug={businessSlug} scope={s.contact_scope} onScopeSaved={onSettingsSaved} />
            </>
          )}
          {tab === "knowledge" && <KnowledgePanel businessSlug={businessSlug} />}
          {tab === "escalations" && <EscalationsPanel businessSlug={businessSlug} observe={s?.mode === "observe"} />}
          {tab === "takeover" && <ConversationsPanel businessSlug={businessSlug} chats={chats} />}
          {tab === "review" && <ReviewPanel businessSlug={businessSlug} />}
          {tab === "activity" && <ActivityPanel businessSlug={businessSlug} />}
          {tab === "test" && <TestConsole businessSlug={businessSlug} chats={chats} />}
        </>
      )}
    </div>
  );
}
