"use client";

import { useState } from "react";
import { aiAgentApi, SettingsPatch, SettingsResponse } from "@/lib/aiAgent/client";
import { requiredConfidence } from "@/lib/aiAgent/engine";
import { StaffGroupPicker, StaffGroupValue } from "@/components/admin/aiAgent/StaffGroupPicker";
import { Card, inputClass, Notice, primaryButton } from "@/components/admin/aiAgent/ui";

interface Props {
  businessSlug: string;
  data: SettingsResponse;
  onSaved: (next: SettingsResponse["settings"]) => void;
}

export function SettingsCard({ businessSlug, data, onSaved }: Props) {
  const s = data.settings;
  const [enabled, setEnabled] = useState(s.enabled);
  const [mode, setMode] = useState(s.mode);
  const [autonomy, setAutonomy] = useState(s.autonomy);
  const [staffGroup, setStaffGroup] = useState<StaffGroupValue | null>(
    s.staff_group_jid ? { jid: s.staff_group_jid, name: s.staff_group_name, manual: false } : null
  );
  const [takeoverMinutes, setTakeoverMinutes] = useState(s.auto_takeover_minutes);
  const [maxReplies, setMaxReplies] = useState(s.max_auto_replies_per_hour);
  const [holdingReply, setHoldingReply] = useState(s.send_holding_reply);
  const [staffNotices, setStaffNotices] = useState(s.staff_notices_enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const threshold = requiredConfidence(autonomy);

  async function save(patch: SettingsPatch, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await aiAgentApi.saveSettings(businessSlug, patch);
      onSaved(res.settings);
      setEnabled(res.settings.enabled);
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function saveAll() {
    void save({
      mode,
      autonomy,
      staffGroupJid: staffGroup?.jid ?? null,
      staffGroupName: staffGroup?.name ?? null,
      staffGroupManual: staffGroup?.manual ?? false,
      autoTakeoverMinutes: takeoverMinutes,
      maxAutoRepliesPerHour: maxReplies,
      sendHoldingReply: holdingReply,
      staffNoticesEnabled: staffNotices,
    });
  }

  return (
    <Card title="Agent" subtitle="Customers are only messaged when the agent is ON and in Assisted mode. Observe mode can post escalation notices to the staff group if enabled below.">
      <div className="flex flex-col gap-4">
        {!data.aiKeyConfigured && <Notice tone="warn">No OpenAI key is saved on the AI Settings page — every message will be escalated.</Notice>}
        {!data.bridgeConfigured && (
          <Notice tone="warn">AI_AGENT_BRIDGE_SECRET is not set on this deployment — the bridge cannot reach the agent.</Notice>
        )}
        {enabled && mode === "assisted" && !s.staff_group_jid && (
          <Notice tone="warn">No staff escalation group selected — escalations will only appear on this page.</Notice>
        )}

        <div className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2">
          <div>
            <p className="text-sm font-medium text-zinc-900">Master switch</p>
            <p className="text-xs text-zinc-500">{enabled ? "ON — the agent processes forwarded messages." : "OFF — the agent ignores everything."}</p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              save(
                { enabled: !enabled },
                enabled ? undefined : `Turn the AI agent ON in ${mode === "assisted" ? "ASSISTED (it will send messages)" : "OBSERVE (no messages sent)"} mode?`
              )
            }
            className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50 ${
              enabled ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700"
            }`}
          >
            {enabled ? "ON" : "OFF"}
          </button>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Mode</label>
          <div className="flex gap-2">
            {(["observe", "assisted"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                  mode === m ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 text-zinc-600"
                }`}
              >
                {m === "observe" ? "Observe — record decisions only" : "Assisted — reply, ask & escalate"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">
            Autonomy: {autonomy} —{" "}
            {threshold === Number.POSITIVE_INFINITY
              ? "never auto-send; every message goes to staff"
              : `auto-send only at ≥ ${Math.round(threshold * 100)}% confidence`}
          </label>
          <input type="range" min={0} max={100} step={5} value={autonomy} onChange={(e) => setAutonomy(Number(e.target.value))} className="w-full" />
          <p className="mt-1 text-xs text-zinc-400">
            Complaints, discounts, refunds, payments, exceptions, order approval and unverified facts always escalate, at any autonomy.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Staff escalation WhatsApp group</label>
          <StaffGroupPicker businessSlug={businessSlug} value={staffGroup} onChange={setStaffGroup} />
          <p className="mt-1 text-xs text-zinc-400">Pick a group this business number has messages in. Staff answer escalations by replying in this group.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Pause after a manual staff message (minutes)</label>
            <input type="number" min={0} max={10080} value={takeoverMinutes} onChange={(e) => setTakeoverMinutes(Number(e.target.value))} className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Max AI replies per chat per hour</label>
            <input type="number" min={0} max={60} value={maxReplies} onChange={(e) => setMaxReplies(Number(e.target.value))} className={inputClass} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={staffNotices} onChange={(e) => setStaffNotices(e.target.checked)} />
          Observe mode: post escalation notices to the staff group (never messages customers)
        </label>
        {enabled && mode === "observe" && staffNotices && !s.staff_group_jid && (
          <Notice tone="warn">No staff group selected — escalations will be recorded on this page only.</Notice>
        )}

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={holdingReply} onChange={(e) => setHoldingReply(e.target.checked)} />
          Send the customer a short &quot;passed to our team&quot; message when escalating
        </label>

        <div className="flex items-center gap-2">
          <button type="button" onClick={saveAll} disabled={saving} className={primaryButton}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {message && <span className="text-sm text-emerald-700">{message}</span>}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
