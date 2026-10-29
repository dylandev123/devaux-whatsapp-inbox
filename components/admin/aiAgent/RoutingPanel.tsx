"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, CallEventView, SettingsResponse } from "@/lib/aiAgent/client";
import { CALL_REASON_TEXT, DEFAULT_MISSED_CALL_MESSAGE, MISSED_CALL_COOLDOWN } from "@/lib/aiAgent/missedCalls";
import { CATEGORY_LABEL, parseRoutingRules, ROUTED_CATEGORIES, type RoutedCategory } from "@/lib/aiAgent/routing";
import { StaffGroupPicker, StaffGroupValue } from "@/components/admin/aiAgent/StaffGroupPicker";
import { Card, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

interface Props {
  businessSlug: string;
  data: SettingsResponse;
  onSaved: (next: SettingsResponse["settings"]) => void;
}

const HINT: Record<RoutedCategory | "orders", string> = {
  orders: "The morning summary and the order commands (!orders, !order 2). Set on the Setup tab; this group takes order commands only.",
  complaints: "Escalations about a complaint, refund, payment claim, health or legal matter.",
  urgent: "Escalations marked urgent. Wins over Complaints.",
  approvals: "In Approval Pilot, the notices that carry the AI's draft reply for a staff member to approve.",
};

export function RoutingPanel({ businessSlug, data, onSaved }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <RoutingCard businessSlug={businessSlug} data={data} onSaved={onSaved} />
      <MissedCallCard businessSlug={businessSlug} data={data} onSaved={onSaved} />
    </div>
  );
}

function RoutingCard({ businessSlug, data, onSaved }: Props) {
  const s = data.settings;
  const stored = parseRoutingRules(s.routing_rules);
  const [rules, setRules] = useState<Record<RoutedCategory, { enabled: boolean; group: StaffGroupValue | null }>>(() => {
    const out = {} as Record<RoutedCategory, { enabled: boolean; group: StaffGroupValue | null }>;
    for (const c of ROUTED_CATEGORIES) {
      const r = stored[c];
      out[c] = { enabled: r?.enabled === true, group: r?.group_jid ? { jid: r.group_jid, name: r.group_name, manual: false } : null };
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const routingRules = Object.fromEntries(ROUTED_CATEGORIES.map((c) => [c, { enabled: rules[c].enabled, groupJid: rules[c].group?.jid ?? null, groupName: rules[c].group?.name ?? null }]));
      const routingManual = Object.fromEntries(ROUTED_CATEGORIES.map((c) => [c, rules[c].group?.manual === true]));
      const res = await aiAgentApi.saveSettings(businessSlug, { routingRules, routingManual });
      onSaved(res.settings);
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Rules & Routing" subtitle="Choose which WhatsApp group hears about what. Each notice goes to exactly one group; anything a rule does not claim goes to the staff group.">
      <div className="flex flex-col gap-4">
        {!s.staff_group_jid && <Notice tone="warn">Set the staff group on the Setup tab first: it is the fallback for everything a rule does not claim, and rules wait until it exists.</Notice>}
        <Notice tone="info">
          Every group you assign here becomes an authorized staff group for this business: escalation answers and approvals are accepted in it, still only from the authorized senders list. Order commands are refused in it. A group cannot be shared with another business.
        </Notice>

        <div className="rounded-md border border-zinc-200 p-3">
          <p className="text-sm font-medium text-zinc-900">{CATEGORY_LABEL.orders}</p>
          <p className="text-xs text-zinc-500">{HINT.orders}</p>
          <p className="mt-1 text-sm text-zinc-700">
            {s.orders_summary_enabled ? "On" : "Off"} · {s.orders_group_jid ? (s.orders_group_name ?? s.orders_group_jid) : "posts to the staff group"}
          </p>
        </div>

        {ROUTED_CATEGORIES.map((c) => (
          <div key={c} className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-zinc-900">
              <input
                type="checkbox"
                checked={rules[c].enabled}
                onChange={(e) => setRules((r) => ({ ...r, [c]: { ...r[c], enabled: e.target.checked } }))}
              />
              {CATEGORY_LABEL[c]}
            </label>
            <p className="text-xs text-zinc-500">{HINT[c]}</p>
            <StaffGroupPicker businessSlug={businessSlug} value={rules[c].group} onChange={(group) => setRules((r) => ({ ...r, [c]: { enabled: group ? r[c].enabled : false, group } }))} />
            {rules[c].enabled && !rules[c].group && <Notice tone="warn">Choose a group before saving.</Notice>}
          </div>
        ))}

        <div className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
          <span className="font-medium">Fallback:</span> {s.staff_group_jid ? (s.staff_group_name ?? s.staff_group_jid) : "— none —"} (the staff group)
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="ok">{message}</Notice>}
        <div>
          <button type="button" className={primaryButton} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save routing"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function MissedCallCard({ businessSlug, data, onSaved }: Props) {
  const s = data.settings;
  const [enabled, setEnabled] = useState(s.missed_call_enabled === true);
  const [text, setText] = useState(s.missed_call_message ?? DEFAULT_MISSED_CALL_MESSAGE);
  const [cooldown, setCooldown] = useState(s.missed_call_cooldown_minutes ?? MISSED_CALL_COOLDOWN.default);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calls, setCalls] = useState<CallEventView[] | null>(null);

  const loadCalls = useCallback(() => {
    aiAgentApi.listCalls(businessSlug).then((r) => setCalls(r.calls)).catch(() => setCalls([]));
  }, [businessSlug]);
  useEffect(loadCalls, [loadCalls]);

  async function save(patch: { missedCallEnabled?: boolean; missedCallMessage?: string; missedCallCooldownMinutes?: number }, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await aiAgentApi.saveSettings(businessSlug, patch);
      onSaved(res.settings);
      setEnabled(res.settings.missed_call_enabled === true);
      setMessage("Saved.");
      loadCalls();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const modeOk = s.mode === "assisted" || s.mode === "approval_pilot";
  return (
    <Card title="Missed calls" subtitle="Reply once to a caller whose incoming call went unanswered. Off until you turn it on. Only reliably identified missed one-to-one calls get a reply; outgoing, answered, group and uncertain calls never do.">
      <div className="flex flex-col gap-4">
        {enabled && !s.enabled && <Notice tone="warn">The AI agent master switch is OFF, so no reply will be sent.</Notice>}
        {enabled && s.enabled && !modeOk && <Notice tone="warn">Observe mode never messages customers, so no reply will be sent. Use Approval Pilot or Assisted.</Notice>}
        <Notice tone="info">
          Needs the bridge version that reports calls. The reply is the fixed text below (no AI), is not an Approval Pilot draft, and is sent to the caller only: it is skipped for excluded contacts, contacts outside your contact scope, and chats staff are handling.
        </Notice>

        <div className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2">
          <div>
            <p className="text-sm font-medium text-zinc-900">Missed-call reply</p>
            <p className="text-xs text-zinc-500">{enabled ? "ON — missed callers receive the message below." : "OFF — calls are ignored."}</p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              save(
                { missedCallEnabled: !enabled },
                enabled ? undefined : "Turn the missed-call reply ON? Customers who call and are not answered will receive an automatic WhatsApp message."
              )
            }
            className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50 ${enabled ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700"}`}
          >
            {enabled ? "ON" : "OFF"}
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          Message
          <textarea className={inputClass} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          Cooldown per caller (minutes, {MISSED_CALL_COOLDOWN.min}–{MISSED_CALL_COOLDOWN.max})
          <input type="number" className={`${inputClass} max-w-40`} min={MISSED_CALL_COOLDOWN.min} max={MISSED_CALL_COOLDOWN.max} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="ok">{message}</Notice>}
        <div className="flex gap-2">
          <button type="button" className={primaryButton} disabled={saving} onClick={() => save({ missedCallMessage: text, missedCallCooldownMinutes: cooldown })}>
            Save message & cooldown
          </button>
          <button type="button" className={secondaryButton} disabled={saving} onClick={() => setText(DEFAULT_MISSED_CALL_MESSAGE)}>
            Restore default text
          </button>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-zinc-900">Recent calls</p>
          {calls === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : calls.length === 0 ? (
            <p className="text-sm text-zinc-500">No calls recorded. Calls are only recorded while the rule is on.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 text-sm">
              {calls.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="truncate">
                    {c.caller_jid.split("@")[0]} {c.video ? "· video" : ""}
                  </span>
                  <span className={c.decision === "replied" ? "text-emerald-700" : "text-zinc-500"}>{CALL_REASON_TEXT[c.reason] ?? c.reason}</span>
                  <span className="shrink-0 text-xs text-zinc-400">{formatWhen(c.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
