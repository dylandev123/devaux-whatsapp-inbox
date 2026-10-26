"use client";

import { useState } from "react";
import { aiAgentApi, SettingsPatch, SettingsResponse } from "@/lib/aiAgent/client";
import { requiredConfidence } from "@/lib/aiAgent/engine";
import { CUSTOMER_MODE_HINT, CUSTOMER_MODE_LABEL, CUSTOMER_MODES, effectiveCustomerMode } from "@/lib/aiAgent/customerMode";
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
  const [batching, setBatching] = useState(s.batching_enabled);
  const [quiet, setQuiet] = useState(s.batch_quiet_seconds);
  const [maxWait, setMaxWait] = useState(s.batch_max_wait_seconds);
  const [memoryCapture, setMemoryCapture] = useState(s.customer_memory_enabled);
  const [defaultCustomerMode, setDefaultCustomerMode] = useState(effectiveCustomerMode(s, null));
  const [senders, setSenders] = useState((s.staff_authorized_senders ?? []).join("\n"));
  const [passiveScope, setPassiveScope] = useState(s.passive_learning_scope ?? "off");
  const [confirmViaWhatsapp, setConfirmViaWhatsapp] = useState(s.knowledge_confirm_via_whatsapp === true);
  const [autoLearning, setAutoLearning] = useState(s.auto_learning_enabled === true);
  const [ordersTracking, setOrdersTracking] = useState(s.orders_tracking_enabled === true);
  const [ordersSummary, setOrdersSummary] = useState(s.orders_summary_enabled === true);
  const [ordersGroup, setOrdersGroup] = useState<StaffGroupValue | null>(
    s.orders_group_jid ? { jid: s.orders_group_jid, name: s.orders_group_name ?? null, manual: false } : null
  );
  const [ordersCustomerConfirms, setOrdersCustomerConfirms] = useState(s.orders_customer_confirms === true);
  const [ordersHour, setOrdersHour] = useState(s.orders_summary_hour ?? 8);
  const [ordersTimezone, setOrdersTimezone] = useState(s.orders_timezone ?? "America/St_Lucia");
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
      batchingEnabled: batching,
      batchQuietSeconds: quiet,
      batchMaxWaitSeconds: maxWait,
      customerMemoryEnabled: memoryCapture,
      defaultCustomerMode,
      staffAuthorizedSenders: senders.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
      passiveLearningScope: passiveScope,
      knowledgeConfirmViaWhatsapp: confirmViaWhatsapp,
      autoLearningEnabled: autoLearning,
      ordersTrackingEnabled: ordersTracking,
      ordersSummaryEnabled: ordersSummary,
      ordersCustomerConfirms,
      ordersGroupJid: ordersGroup?.jid ?? null,
      ordersGroupName: ordersGroup?.name ?? null,
      ordersGroupManual: ordersGroup?.manual ?? false,
      ordersSummaryHour: ordersHour,
      ordersTimezone: ordersTimezone.trim(),
    });
  }

  return (
    <Card title="Agent" subtitle="Customers are only messaged when the agent is ON and in Approval Pilot (only a staff member you authorize sends) or Assisted mode. Observe mode can post escalation notices to the staff group if enabled below.">
      <div className="flex flex-col gap-4">
        {!data.aiKeyConfigured && <Notice tone="warn">No OpenAI key is saved on the AI Settings page — every message will be escalated.</Notice>}
        {!data.bridgeConfigured && (
          <Notice tone="warn">AI_AGENT_BRIDGE_SECRET is not set on this deployment — the bridge cannot reach the agent.</Notice>
        )}
        {enabled && mode !== "observe" && !s.staff_group_jid && (
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
                enabled
                  ? undefined
                  : `Turn the AI agent ON in ${
                      mode === "assisted" ? "ASSISTED (it will send messages)" : mode === "approval_pilot" ? "APPROVAL PILOT (it only sends what an authorized staff member approves)" : "OBSERVE (no messages sent)"
                    } mode?`
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
          <div className="flex flex-wrap gap-2">
            {(["observe", "approval_pilot", "assisted"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                  mode === m ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 text-zinc-600"
                }`}
              >
                {m === "observe" ? "Observe — record decisions only" : m === "approval_pilot" ? "Approval Pilot — staff approve every reply in WhatsApp" : "Assisted — reply, ask & escalate"}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-zinc-200 p-3">
          <label className="mb-1 block text-sm font-medium text-zinc-900">Default AI handling for customers</label>
          <p className="mb-2 text-xs text-zinc-500">
            Applies to every customer who has no mode of their own. Set a single customer&apos;s mode from their conversation in the Inbox.
            It only narrows the settings above: Observe mode, contact scope, human takeover and the OFF switch always win.
          </p>
          <div className="flex flex-wrap gap-2">
            {CUSTOMER_MODES.map((m) => (
              <button
                key={m}
                type="button"
                title={CUSTOMER_MODE_HINT[m]}
                onClick={() => {
                  if (m === "auto_reply" && defaultCustomerMode !== "auto_reply" && !window.confirm("Make AI Auto-Reply the default for every customer without their own mode?")) return;
                  setDefaultCustomerMode(m);
                }}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                  defaultCustomerMode === m ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-200 text-zinc-600"
                }`}
              >
                {CUSTOMER_MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">{CUSTOMER_MODE_HINT[defaultCustomerMode]}</p>
          {defaultCustomerMode === "auto_reply" && (
            <p className="mt-1 text-xs text-amber-700">Auto-Reply is the default: every customer without their own mode can be answered by the AI.</p>
          )}
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

        <div className="rounded-md border border-zinc-200 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-zinc-900">
            <input type="checkbox" checked={batching} onChange={(e) => setBatching(e.target.checked)} />
            Message batching
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            Wait for a customer to finish typing, then handle everything they sent as ONE turn: one decision, one escalation. Manual staff replies are never
            delayed. Needs the batch scheduler (see docs/ai-agent-batching-memory.md).
          </p>
          <div className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 ${batching ? "" : "opacity-50"}`}>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Quiet period after the latest message (seconds, 0–120)</label>
              <input type="number" min={0} max={120} value={quiet} disabled={!batching} onChange={(e) => setQuiet(Number(e.target.value))} className={inputClass} />
              <p className="mt-1 text-xs text-zinc-400">Each new message restarts this wait. 0 = no waiting.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Maximum total wait (seconds, 10–600)</label>
              <input type="number" min={10} max={600} value={maxWait} disabled={!batching} onChange={(e) => setMaxWait(Number(e.target.value))} className={inputClass} />
              <p className="mt-1 text-xs text-zinc-400">A batch is handled at most this long after its first message.</p>
            </div>
          </div>
          {batching && quiet > maxWait && <p className="mt-2 text-xs text-red-600">The maximum wait cannot be shorter than the quiet period.</p>}
          {batching && quiet === 0 && <p className="mt-2 text-xs text-amber-700">A quiet period of 0 handles every message immediately (batching has no effect).</p>}
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={memoryCapture} onChange={(e) => setMemoryCapture(e.target.checked)} />
          Customer memory: remember explicit customer preferences and resolved issues (inspect or delete them on the Memory tab)
        </label>

        <div className="rounded-md border border-zinc-200 p-3">
          <label className="mb-1 block text-sm font-medium text-zinc-900">Staff who can send customer replies from WhatsApp</label>
          <p className="mb-2 text-xs text-zinc-500">
            One phone number per line (digits with country code, e.g. 17585550001). Only these people can make the agent message a customer by replying
            &quot;send&quot; or !send in the staff group; everyone else&apos;s replies stay drafts. Matched on the number WhatsApp reports, never on a display name. Empty = nobody.
            The dashboard&apos;s &quot;Send to customer&quot; button is not affected.
          </p>
          <textarea value={senders} onChange={(e) => setSenders(e.target.value)} rows={3} placeholder="17585550001" className={inputClass} />
          {enabled && mode !== "observe" && senders.trim() === "" && (
            <p className="mt-1 text-xs text-amber-700">No one is authorized: nobody can approve or send a customer reply, teach, or confirm from WhatsApp.</p>
          )}
        </div>

        <div className="rounded-md border border-zinc-200 p-3">
          <label className="mb-1 block text-sm font-medium text-zinc-900">Learning from WhatsApp</label>
          <p className="mb-2 text-xs text-zinc-500">
            Staff can teach the AI with <code>!teach &lt;fact&gt;</code>. Anything learned is only a suggestion until it is confirmed (here on the Review tab, or from WhatsApp if enabled below).
            Customer messages are never used.
          </p>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Notice facts staff mention on their own</label>
          <select value={passiveScope} onChange={(e) => setPassiveScope(e.target.value as typeof passiveScope)} className={inputClass}>
            <option value="off">Off — only !teach</option>
            <option value="staff_group">The staff group — messages from authorized senders</option>
            <option value="staff_group_and_chats">The staff group, plus the business account&apos;s own messages (unverified suggestions only)</option>
          </select>
          <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={confirmViaWhatsapp} onChange={(e) => setConfirmViaWhatsapp(e.target.checked)} />
            Authorized senders can confirm suggestions from WhatsApp (<code>!confirm K-XXXX</code>)
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-zinc-700">
            <input type="checkbox" className="mt-1" checked={autoLearning} onChange={(e) => setAutoLearning(e.target.checked)} />
            <span>
              Learn clearly stated facts automatically from the business&apos;s own human messages in customer chats (standard prices, sizes, hours, delivery). They are used by the AI right away;
              conflicting prices, unclear products, customer-specific terms and risky policies wait on the Review tab instead. The staff group gets one short digest per 10 learned facts —{" "}
              <code>!memory</code> lists them, <code>!forget K-XXXXX</code> removes one. Uses one AI call per relevant message (hourly limit). Never lets the AI message a customer.
            </span>
          </label>
        </div>

        <div className="rounded-md border border-zinc-200 p-3">
          <p className="text-sm font-medium text-zinc-900">Daily orders</p>
          <p className="mb-2 mt-1 text-xs text-zinc-500">
            Keeps a record of the orders customers place (Orders tab) and posts one summary to a WhatsApp group every morning. Staff type{" "}
            <code>!update</code> in that group for a fresh one. Neither ever messages a customer, and neither changes Approval Pilot.
          </p>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={ordersTracking} onChange={(e) => setOrdersTracking(e.target.checked)} />
            Track orders from ALL customer conversations, including customers the AI is not allowed to reply to (this never lets the AI reply; those chats use one small extra AI call per relevant message, with an hourly limit)
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={ordersCustomerConfirms} onChange={(e) => setOrdersCustomerConfirms(e.target.checked)} />
            Let a customer&apos;s clear &quot;yes&quot; finalize an order (leave OFF at first: a yes is then only recorded and staff verify it)
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={ordersSummary} onChange={(e) => setOrdersSummary(e.target.checked)} />
            Post the daily summary and answer <code>!update</code>
          </label>
          <div className={`mt-3 flex flex-col gap-3 ${ordersSummary ? "" : "opacity-60"}`}>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Orders WhatsApp group</label>
              <StaffGroupPicker businessSlug={businessSlug} value={ordersGroup} onChange={setOrdersGroup} />
              <p className="mt-1 text-xs text-zinc-400">
                Leave empty to use the staff group above. A different group also needs the bridge to forward its messages (see docs/ai-agent-daily-orders.md).
                <code> !update</code> works only here, and only for the authorized staff above.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">Send at (hour, 0–23)</label>
                <input type="number" min={0} max={23} value={ordersHour} onChange={(e) => setOrdersHour(Number(e.target.value))} className={inputClass} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">Timezone</label>
                <input value={ordersTimezone} onChange={(e) => setOrdersTimezone(e.target.value)} className={inputClass} />
              </div>
            </div>
            {ordersSummary && enabled && !ordersGroup && !s.staff_group_jid && <Notice tone="warn">No group is set — pick an orders group or a staff group.</Notice>}
            {ordersSummary && enabled && mode === "observe" && !staffNotices && (
              <Notice tone="warn">In Observe mode the summary is only posted when &quot;post escalation notices to the staff group&quot; is on.</Notice>
            )}
          </div>
        </div>

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
