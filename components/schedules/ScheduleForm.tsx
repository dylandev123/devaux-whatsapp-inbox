"use client";

import { useState } from "react";
import { describeError } from "@/lib/errors";
import { businessLabel } from "@/lib/whatsapp";
import {
  createSchedule,
  DAY_SHORT,
  Recipient,
  RecipientGroup,
  RecurrenceType,
  ScheduledMessage,
  ScheduledMessageInput,
  SCHEDULE_TIMEZONE_LABEL,
  updateSchedule,
} from "@/lib/scheduledMessages";
import { RecipientPicker } from "./RecipientPicker";

interface Props {
  existing: ScheduledMessage | null;
  businessSlugs: string[];
  defaultBusinessSlug: string;
  groups: RecipientGroup[];
  onSaved: () => void;
  onCancel: () => void;
}

export function ScheduleForm({ existing, businessSlugs, defaultBusinessSlug, groups, onSaved, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [businessSlug, setBusinessSlug] = useState(existing?.business_slug ?? defaultBusinessSlug);
  const [body, setBody] = useState(existing?.body ?? "");
  const [recurrence, setRecurrence] = useState<RecurrenceType>(existing?.recurrence_type ?? "daily");
  const [days, setDays] = useState<number[]>(existing?.days_of_week ?? [1]);
  const [time, setTime] = useState((existing?.time_of_day ?? "17:00:00").slice(0, 5));
  const [recipients, setRecipients] = useState<Recipient[]>(existing?.recipients ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(existing?.recipient_group_ids ?? []);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const businessGroups = groups.filter((g) => g.business_slug === businessSlug);

  function changeBusiness(slug: string) {
    // Recipients/groups are tied to one business's WhatsApp session.
    setBusinessSlug(slug);
    setRecipients([]);
    setGroupIds([]);
  }

  function toggleDay(day: number) {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  function toggleGroup(id: string) {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the schedule a name.");
    if (!body.trim()) return setError("Message text is required.");
    if (body.length > 4096) return setError("Message is too long (max 4096 characters).");
    if (recurrence === "weekly" && days.length === 0) return setError("Pick at least one day.");
    if (recipients.length === 0 && groupIds.length === 0) {
      return setError("Add at least one recipient or recipient group.");
    }
    if (!/^\d{2}:\d{2}$/.test(time)) return setError("Pick a send time.");

    const input: ScheduledMessageInput = {
      business_slug: businessSlug,
      name: name.trim(),
      body,
      enabled,
      recipients,
      recipient_group_ids: groupIds.filter((id) => businessGroups.some((g) => g.id === id)),
      recurrence_type: recurrence,
      days_of_week: recurrence === "weekly" ? [...days].sort((a, b) => a - b) : [],
      time_of_day: `${time}:00`,
    };

    setSaving(true);
    setError(null);
    try {
      if (existing) await updateSchedule(existing.id, input);
      else await createSchedule(input);
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-md border border-zinc-200 px-3 py-2 text-sm";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-base font-semibold text-zinc-900">
        {existing ? "Edit schedule" : "New schedule"}
      </h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily 5 PM reminder" className={field} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Send from (business)</span>
          <select value={businessSlug} onChange={(e) => changeBusiness(e.target.value)} className={field}>
            {businessSlugs.map((slug) => (
              <option key={slug} value={slug}>
                {businessLabel(slug)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-zinc-600">Message (text only)</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className={field} />
        <span className="mt-0.5 block text-right text-xs text-zinc-400">{body.length}/4096</span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Repeats</span>
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as RecurrenceType)} className={field}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Specific days of the week</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Time ({SCHEDULE_TIMEZONE_LABEL}, America/St_Lucia)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
        </label>
      </div>

      {recurrence === "weekly" && (
        <div className="flex flex-wrap gap-1.5">
          {DAY_SHORT.map((label, day) => (
            <button
              key={label}
              type="button"
              onClick={() => toggleDay(day)}
              aria-pressed={days.includes(day)}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                days.includes(day)
                  ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                  : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div>
        <span className="mb-1 block text-sm text-zinc-600">Recipient groups</span>
        {businessGroups.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No recipient groups for this business yet — create them on the Recipient groups tab.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {businessGroups.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm">
                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                {g.name} <span className="text-xs text-zinc-400">({g.members.length})</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <span className="mb-1 block text-sm text-zinc-600">Individual contacts / WhatsApp groups</span>
        <RecipientPicker businessSlug={businessSlug} value={recipients} onChange={setRecipients} />
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <p className="text-xs text-zinc-500">
        Sent by the WhatsApp bridge, not by this website — it works with the browser closed. If an occurrence is
        more than 10 minutes late (e.g. the bridge was down) it is skipped, not sent late.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="cursor-pointer rounded-md px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {saving ? "Saving…" : existing ? "Save changes" : "Create schedule"}
        </button>
      </div>
    </form>
  );
}
