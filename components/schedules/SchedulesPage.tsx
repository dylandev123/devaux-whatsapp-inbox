"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { AdminNav } from "@/components/admin/AdminNav";
import { fetchActiveBusinessesOrFallback } from "@/lib/businesses";
import { describeError } from "@/lib/errors";
import { fetchCurrentProfile } from "@/lib/profile";
import { businessColor, businessLabel, setBusinessDirectory } from "@/lib/whatsapp";
import {
  deleteSchedule,
  describeRecurrence,
  fetchRecentRuns,
  fetchRecipientGroups,
  fetchSchedules,
  formatStLucia,
  looksLikeMissingMigration,
  Recipient,
  recipientLabel,
  RecipientGroup,
  sendScheduleTest,
  TestSendOutcome,
  runStatusBadge,
  ScheduledMessage,
  ScheduleRun,
  updateSchedule,
} from "@/lib/scheduledMessages";
import { RecipientGroupsPanel } from "./RecipientGroupsPanel";
import { RunHistory } from "./RunHistory";
import { ScheduleForm } from "./ScheduleForm";

type Tab = "schedules" | "groups";

export function SchedulesPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("schedules");
  const [businessSlugs, setBusinessSlugs] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<ScheduledMessage[]>([]);
  const [groups, setGroups] = useState<RecipientGroup[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<ScheduledMessage | "new" | null>(null);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Send test: which schedule's picker is open, the chosen JID, and the result.
  const [testId, setTestId] = useState<string | null>(null);
  const [testJid, setTestJid] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ outcome: TestSendOutcome; detail: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [scheduleRows, groupRows] = await Promise.all([fetchSchedules(), fetchRecipientGroups()]);
      setSchedules(scheduleRows);
      setGroups(groupRows);
      setRuns(await fetchRecentRuns(scheduleRows.map((s) => s.id)));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchCurrentProfile()
      .then((profile) => active && setIsAdmin(profile?.role === "admin"))
      .catch(() => active && setIsAdmin(false));
    fetchActiveBusinessesOrFallback()
      .then(({ businesses }) => {
        if (!active) return;
        setBusinessDirectory(businesses);
        setBusinessSlugs(businesses.map((r) => r.business_slug));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (isAdmin) load();
    else if (isAdmin === false) setLoading(false);
  }, [isAdmin, load]);

  const runsBySchedule = useMemo(() => {
    const map = new Map<string, ScheduleRun[]>();
    for (const run of runs) {
      const list = map.get(run.schedule_id) ?? [];
      list.push(run);
      map.set(run.schedule_id, list);
    }
    return map;
  }, [runs]);

  async function toggleEnabled(schedule: ScheduledMessage) {
    setBusyId(schedule.id);
    try {
      await updateSchedule(schedule.id, { enabled: !schedule.enabled });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(schedule: ScheduledMessage) {
    if (!window.confirm(`Delete "${schedule.name}"? Its run history will be deleted too.`)) return;
    setBusyId(schedule.id);
    try {
      await deleteSchedule(schedule.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  // Direct recipients plus members of the schedule's groups, de-duplicated by
  // JID — the candidates for a test. A test only ever goes to ONE of them.
  function testCandidates(schedule: ScheduledMessage): Recipient[] {
    const byJid = new Map<string, Recipient>();
    for (const r of schedule.recipients) byJid.set(r.jid, r);
    for (const id of schedule.recipient_group_ids) {
      for (const m of groups.find((g) => g.id === id)?.members ?? []) {
        if (!byJid.has(m.jid)) byJid.set(m.jid, m);
      }
    }
    return [...byJid.values()];
  }

  function openTest(schedule: ScheduledMessage) {
    setTestId(testId === schedule.id ? null : schedule.id);
    setTestJid("");
    setTestResult(null);
  }

  async function runTest(schedule: ScheduledMessage) {
    const recipient = testCandidates(schedule).find((r) => r.jid === testJid);
    if (!recipient) return;
    const ok = window.confirm(
      `Send this message to ${recipientLabel(recipient)} (${recipient.jid}) only?\n\nIt is sent immediately. No other recipients will receive it.`
    );
    if (!ok) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(
        await sendScheduleTest({
          businessSlug: schedule.business_slug,
          to: recipient.jid,
          body: schedule.body,
          scheduleId: schedule.id,
        })
      );
      await load();
    } catch (err) {
      setTestResult({ outcome: "failed", detail: describeError(err) });
    } finally {
      setTestBusy(false);
    }
  }

  const defaultBusiness = businessSlugs[0] ?? "";
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name;

  return (
    <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Scheduled messages</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Recurring WhatsApp messages, sent automatically by the WhatsApp bridge in St. Lucia time (AST) — even
              when nobody has this site open.
            </p>
            <div className="mt-3">
              <AdminNav />
            </div>
          </div>
          <ProfileMenu />
        </div>

        {isAdmin === false ? (
          <p className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-600">
            Only admins can manage scheduled messages.{" "}
            <Link href="/" className="text-emerald-700 underline">
              Back to inbox
            </Link>
          </p>
        ) : (
          <>
            <div className="flex gap-2">
              {(["schedules", "groups"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium ${
                    tab === t ? "bg-emerald-50 text-emerald-700" : "text-zinc-500 hover:bg-zinc-100"
                  }`}
                >
                  {t === "schedules" ? "Schedules" : "Recipient groups"}
                </button>
              ))}
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {looksLikeMissingMigration(error)
                  ? "Scheduled messages tables aren't set up yet. Run supabase/migrations/20261007000000_scheduled_messages.sql in the Supabase SQL editor. "
                  : ""}
                {error}
              </div>
            )}

            {tab === "groups" ? (
              <RecipientGroupsPanel
                groups={groups}
                businessSlugs={businessSlugs}
                defaultBusinessSlug={defaultBusiness}
                onChanged={load}
              />
            ) : formTarget ? (
              <ScheduleForm
                key={formTarget === "new" ? "new" : formTarget.id}
                existing={formTarget === "new" ? null : formTarget}
                businessSlugs={businessSlugs}
                defaultBusinessSlug={defaultBusiness}
                groups={groups}
                onCancel={() => setFormTarget(null)}
                onSaved={() => {
                  setFormTarget(null);
                  load();
                }}
              />
            ) : (
              <section className="space-y-4">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setFormTarget("new")}
                    disabled={businessSlugs.length === 0}
                    className="cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    New schedule
                  </button>
                </div>

                {loading ? (
                  <p className="text-sm text-zinc-500">Loading…</p>
                ) : schedules.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500">
                    No scheduled messages yet.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {schedules.map((schedule) => {
                      const scheduleRuns = runsBySchedule.get(schedule.id) ?? [];
                      const lastRun = scheduleRuns.find((r) => r.trigger_type === "scheduled");
                      const lastBadge = lastRun ? runStatusBadge(lastRun.status) : null;
                      const color = businessColor(schedule.business_slug);
                      const names = [
                        ...schedule.recipient_group_ids.map(groupName).filter(Boolean),
                        ...schedule.recipients.map((r) => r.name || r.jid.replace(/@.*$/, "")),
                      ];
                      const open = historyOpenId === schedule.id;
                      return (
                        <li key={schedule.id} className="rounded-lg border border-zinc-200 bg-white">
                          <div className="space-y-2 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-medium text-zinc-900">{schedule.name}</p>
                                  <span className={`rounded-full px-2 py-0.5 text-xs ${color.bg} ${color.text}`}>
                                    {businessLabel(schedule.business_slug)}
                                  </span>
                                  {!schedule.enabled && (
                                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">Paused</span>
                                  )}
                                </div>
                                <p className="text-sm text-zinc-600">{describeRecurrence(schedule)}</p>
                              </div>
                              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-zinc-600">
                                <input
                                  type="checkbox"
                                  checked={schedule.enabled}
                                  disabled={busyId === schedule.id}
                                  onChange={() => toggleEnabled(schedule)}
                                />
                                {schedule.enabled ? "Active" : "Paused"}
                              </label>
                            </div>

                            <p className="line-clamp-2 whitespace-pre-wrap text-sm text-zinc-700">{schedule.body}</p>
                            <p className="text-xs text-zinc-500">To: {names.length ? names.join(", ") : "—"}</p>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                              <span>
                                Next send: {schedule.enabled ? formatStLucia(schedule.next_run_at) : "paused"}
                              </span>
                              <span className="flex items-center gap-1.5">
                                Last run:{" "}
                                {lastRun && lastBadge ? (
                                  <>
                                    {formatStLucia(lastRun.scheduled_for)}
                                    <span className={`rounded-full px-2 py-0.5 font-medium ${lastBadge.className}`}>
                                      {lastBadge.label}
                                    </span>
                                  </>
                                ) : (
                                  "never"
                                )}
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-1 pt-1">
                              <button
                                type="button"
                                onClick={() => setHistoryOpenId(open ? null : schedule.id)}
                                className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                              >
                                {open ? "Hide history" : "History"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setFormTarget(schedule)}
                                className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => openTest(schedule)}
                                className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                              >
                                Send test
                              </button>
                              <button
                                type="button"
                                onClick={() => remove(schedule)}
                                disabled={busyId === schedule.id}
                                className="cursor-pointer rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                              >
                                Delete
                              </button>
                            </div>
                            {testId === schedule.id && (
                              <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs">
                                <p className="text-zinc-600">
                                  Sends this schedule&apos;s message to one recipient right now.
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                  <select
                                    value={testJid}
                                    onChange={(e) => {
                                      setTestJid(e.target.value);
                                      setTestResult(null);
                                    }}
                                    className="rounded-md border border-zinc-300 bg-white px-2 py-1"
                                  >
                                    <option value="">Choose one recipient…</option>
                                    {testCandidates(schedule).map((r) => (
                                      <option key={r.jid} value={r.jid}>
                                        {recipientLabel(r)}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => runTest(schedule)}
                                    disabled={!testJid || testBusy}
                                    className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {testBusy ? "Sending…" : "Send test"}
                                  </button>
                                </div>
                                {testResult && (
                                  <p
                                    className={
                                      testResult.outcome === "sent"
                                        ? "text-emerald-700"
                                        : testResult.outcome === "failed"
                                          ? "text-red-700"
                                          : "text-amber-700"
                                    }
                                  >
                                    {testResult.outcome === "sent" && "Sent."}
                                    {testResult.outcome === "failed" &&
                                      `Failed — the message was not sent. ${testResult.detail ?? ""}`}
                                    {testResult.outcome === "unknown" &&
                                      `Unknown — it may or may not have been delivered. Check the chat before retrying. ${testResult.detail ?? ""}`}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          {open && (
                            <div className="border-t border-zinc-100">
                              <RunHistory runs={scheduleRuns} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
