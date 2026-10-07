import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Config + history for scheduled WhatsApp messages. Mirrors
// supabase/migrations/20261007000000_scheduled_messages.sql.
//
// NOTHING IN THIS FILE (or anywhere in the web app) EXECUTES A SCHEDULE. The
// WhatsApp bridge claims due occurrences from Supabase and sends them; the
// browser only edits config and reads history.

export const SCHEDULE_TIMEZONE = "America/St_Lucia";
export const SCHEDULE_TIMEZONE_LABEL = "AST";
export const MISSED_SEND_GRACE_MINUTES = 10;

export type RecurrenceType = "daily" | "weekdays" | "weekly";
export type RecipientKind = "contact" | "group";

export interface Recipient {
  jid: string;
  name: string | null;
  kind: RecipientKind;
}

export interface ScheduledMessage {
  id: string;
  business_slug: string;
  name: string;
  body: string;
  enabled: boolean;
  recipients: Recipient[];
  recipient_group_ids: string[];
  recurrence_type: RecurrenceType;
  days_of_week: number[];
  time_of_day: string; // "HH:MM:SS"
  timezone: string;
  grace_minutes: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledMessageInput {
  business_slug: string;
  name: string;
  body: string;
  enabled: boolean;
  recipients: Recipient[];
  recipient_group_ids: string[];
  recurrence_type: RecurrenceType;
  days_of_week: number[];
  time_of_day: string;
}

export interface RecipientGroup {
  id: string;
  business_slug: string;
  name: string;
  created_at: string;
  members: Recipient[];
}

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped_missed"
  | "skipped_no_recipients";

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown";

export interface DeliveryRow {
  id: string;
  run_id: string;
  recipient_jid: string;
  recipient_name: string | null;
  recipient_kind: RecipientKind;
  status: DeliveryStatus;
  whatsapp_message_id: string | null;
  error: string | null;
  attempted_at: string | null;
  sent_at: string | null;
}

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  status: RunStatus;
  trigger_type: "scheduled" | "test";
  claimed_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  deliveryCounts: Record<DeliveryStatus, number>;
}

const SCHEDULE_COLUMNS =
  "id, business_slug, name, body, enabled, recipients, recipient_group_ids, recurrence_type, days_of_week, time_of_day, timezone, grace_minutes, next_run_at, last_run_at, created_at, updated_at";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Formatting ───────────────────────────────────────────────────────────────

/** Formats an instant in St. Lucia time regardless of the viewer's own timezone. */
export function formatStLucia(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${text} ${SCHEDULE_TIMEZONE_LABEL}`;
}

export function formatTimeOfDay(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function describeRecurrence(
  schedule: Pick<ScheduledMessage, "recurrence_type" | "days_of_week" | "time_of_day">
): string {
  const time = `${formatTimeOfDay(schedule.time_of_day)} ${SCHEDULE_TIMEZONE_LABEL}`;
  if (schedule.recurrence_type === "daily") return `Every day at ${time}`;
  if (schedule.recurrence_type === "weekdays") return `Weekdays at ${time}`;
  const days = [...schedule.days_of_week].sort((a, b) => a - b);
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${time}`;
  return `${days.map((d) => DAY_SHORT[d]).join(", ")} at ${time}`;
}

export function recipientLabel(recipient: Recipient): string {
  if (recipient.name?.trim()) return recipient.name.trim();
  return recipient.jid.replace(/@.*$/, "");
}

// ── Schedules ────────────────────────────────────────────────────────────────

export async function fetchSchedules(): Promise<ScheduledMessage[]> {
  const { data, error } = await supabase
    .from("scheduled_messages")
    .select(SCHEDULE_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw new Error(logAndDescribeError("fetchSchedules", error));
  return (data ?? []) as ScheduledMessage[];
}

export async function createSchedule(input: ScheduledMessageInput): Promise<ScheduledMessage> {
  const { data, error } = await supabase
    .from("scheduled_messages")
    .insert(input)
    .select(SCHEDULE_COLUMNS)
    .single();
  if (error) throw new Error(logAndDescribeError("createSchedule", error));
  return data as ScheduledMessage;
}

export async function updateSchedule(
  id: string,
  input: Partial<ScheduledMessageInput>
): Promise<ScheduledMessage> {
  const { data, error } = await supabase
    .from("scheduled_messages")
    .update(input)
    .eq("id", id)
    .select(SCHEDULE_COLUMNS)
    .single();
  if (error) throw new Error(logAndDescribeError("updateSchedule", error));
  return data as ScheduledMessage;
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from("scheduled_messages").delete().eq("id", id);
  if (error) throw new Error(logAndDescribeError("deleteSchedule", error));
}

// ── Recipient groups ─────────────────────────────────────────────────────────

interface GroupRow {
  id: string;
  business_slug: string;
  name: string;
  created_at: string;
  recipient_group_members: { jid: string; display_name: string | null; kind: RecipientKind }[];
}

export async function fetchRecipientGroups(): Promise<RecipientGroup[]> {
  const { data, error } = await supabase
    .from("recipient_groups")
    .select("id, business_slug, name, created_at, recipient_group_members(jid, display_name, kind)")
    .order("name", { ascending: true });
  if (error) throw new Error(logAndDescribeError("fetchRecipientGroups", error));
  return ((data ?? []) as unknown as GroupRow[]).map((row) => ({
    id: row.id,
    business_slug: row.business_slug,
    name: row.name,
    created_at: row.created_at,
    members: row.recipient_group_members.map((m) => ({
      jid: m.jid,
      name: m.display_name,
      kind: m.kind,
    })),
  }));
}

async function replaceGroupMembers(groupId: string, members: Recipient[]): Promise<void> {
  const { error: delError } = await supabase
    .from("recipient_group_members")
    .delete()
    .eq("group_id", groupId);
  if (delError) throw new Error(logAndDescribeError("replaceGroupMembers.delete", delError));
  if (members.length === 0) return;
  const { error } = await supabase.from("recipient_group_members").insert(
    members.map((m) => ({
      group_id: groupId,
      jid: m.jid,
      display_name: m.name,
      kind: m.kind,
    }))
  );
  if (error) throw new Error(logAndDescribeError("replaceGroupMembers.insert", error));
}

export async function saveRecipientGroup(input: {
  id?: string;
  business_slug: string;
  name: string;
  members: Recipient[];
}): Promise<void> {
  let groupId = input.id;
  if (groupId) {
    const { error } = await supabase
      .from("recipient_groups")
      .update({ name: input.name })
      .eq("id", groupId);
    if (error) throw new Error(logAndDescribeError("saveRecipientGroup.update", error));
  } else {
    const { data, error } = await supabase
      .from("recipient_groups")
      .insert({ business_slug: input.business_slug, name: input.name })
      .select("id")
      .single();
    if (error) throw new Error(logAndDescribeError("saveRecipientGroup.insert", error));
    groupId = data.id as string;
  }
  await replaceGroupMembers(groupId, input.members);
}

export async function deleteRecipientGroup(id: string): Promise<void> {
  const { error } = await supabase.from("recipient_groups").delete().eq("id", id);
  if (error) throw new Error(logAndDescribeError("deleteRecipientGroup", error));
}

// ── Run / delivery history (read-only; written by the bridge) ────────────────

function emptyCounts(): Record<DeliveryStatus, number> {
  return { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0 };
}

interface RunRow extends Omit<ScheduleRun, "deliveryCounts"> {
  scheduled_message_deliveries: { status: DeliveryStatus }[];
}

/** Most recent runs for the given schedules (newest first), with per-status delivery counts. */
export async function fetchRecentRuns(scheduleIds: string[], limit = 300): Promise<ScheduleRun[]> {
  if (scheduleIds.length === 0) return [];
  const { data, error } = await supabase
    .from("scheduled_message_runs")
    .select(
      "id, schedule_id, scheduled_for, status, trigger_type, claimed_at, started_at, finished_at, error, scheduled_message_deliveries(status)"
    )
    .in("schedule_id", scheduleIds)
    .order("scheduled_for", { ascending: false })
    .limit(limit);
  if (error) throw new Error(logAndDescribeError("fetchRecentRuns", error));
  return ((data ?? []) as unknown as RunRow[]).map(({ scheduled_message_deliveries, ...run }) => {
    const counts = emptyCounts();
    for (const d of scheduled_message_deliveries) counts[d.status] += 1;
    return { ...run, deliveryCounts: counts };
  });
}

export async function fetchDeliveries(runId: string): Promise<DeliveryRow[]> {
  const { data, error } = await supabase
    .from("scheduled_message_deliveries")
    .select(
      "id, run_id, recipient_jid, recipient_name, recipient_kind, status, whatsapp_message_id, error, attempted_at, sent_at"
    )
    .eq("run_id", runId)
    .order("recipient_name", { ascending: true, nullsFirst: false });
  if (error) throw new Error(logAndDescribeError("fetchDeliveries", error));
  return (data ?? []) as DeliveryRow[];
}

export type TestSendOutcome = "sent" | "failed" | "unknown";

/**
 * Sends the schedule's body to ONE recipient via the bridge. Maps the bridge's
 * statuses: 200 sent, 409 failed before sending, 502 unknown outcome.
 */
export async function sendScheduleTest(input: {
  businessSlug: string;
  to: string;
  body: string;
  scheduleId?: string;
}): Promise<{ outcome: TestSendOutcome; detail: string | null }> {
  const res = await fetch("/api/scheduled-messages/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => null);
  const detail: string | null = data?.error ?? null;
  if (res.ok) return { outcome: "sent", detail: null };
  if (res.status === 409) return { outcome: "failed", detail };
  if (res.status === 502) return { outcome: "unknown", detail };
  throw new Error(detail ?? `Send test failed (${res.status})`);
}

const RUN_STATUS_LABELS: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: "Queued for bridge", className: "bg-amber-50 text-amber-700" },
  running: { label: "Sending", className: "bg-blue-50 text-blue-700" },
  completed: { label: "Sent", className: "bg-emerald-50 text-emerald-700" },
  partial: { label: "Partly failed", className: "bg-amber-50 text-amber-700" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
  skipped_missed: { label: "Missed (skipped)", className: "bg-zinc-100 text-zinc-600" },
  skipped_no_recipients: { label: "No recipients", className: "bg-zinc-100 text-zinc-600" },
};

export function runStatusBadge(status: RunStatus) {
  return RUN_STATUS_LABELS[status] ?? { label: status, className: "bg-zinc-100 text-zinc-600" };
}

export const DELIVERY_STATUS_STYLES: Record<DeliveryStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  sending: "bg-blue-50 text-blue-700",
  sent: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  unknown: "bg-zinc-100 text-zinc-600",
};

/** True when a Supabase error most likely means the migration hasn't been run. */
export function looksLikeMissingMigration(message: string): boolean {
  return /PGRST20[25]|42P01|does not exist|schema cache|Could not find/i.test(message);
}
