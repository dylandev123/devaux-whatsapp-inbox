// Message batching — pure functions, no I/O, no path-alias imports (so they run
// under `npm test`). The durable part (deadlines, claiming, leases) lives in
// Postgres: supabase/migrations/20261025000000_ai_agent_batching_memory.sql.
// This file only holds the settings maths and how a batch of stored messages
// becomes ONE coherent customer turn.

export const BATCH_QUIET_DEFAULT_SECONDS = 45;
export const BATCH_QUIET_MAX_SECONDS = 120;
export const BATCH_MAX_WAIT_DEFAULT_SECONDS = 180;
export const BATCH_MAX_WAIT_MIN_SECONDS = 10;
export const BATCH_MAX_WAIT_MAX_SECONDS = 600;

export interface BatchSettings {
  batching_enabled: boolean;
  batch_quiet_seconds: number;
  batch_max_wait_seconds: number;
}

/** Batching is on only when enabled AND there is a quiet period to wait out (0 = process immediately). */
export function batchingActive(settings: Pick<BatchSettings, "batching_enabled" | "batch_quiet_seconds"> | null): boolean {
  return Boolean(settings?.batching_enabled) && (settings?.batch_quiet_seconds ?? 0) > 0;
}

/**
 * Validates an admin's batching input. Returns the normalized values or an
 * error message. The database enforces the same bounds with check constraints.
 */
export function validateBatchWindow(input: {
  quiet: number;
  maxWait: number;
}): { ok: true; quiet: number; maxWait: number } | { ok: false; error: string } {
  const { quiet, maxWait } = input;
  if (!Number.isInteger(quiet) || quiet < 0 || quiet > BATCH_QUIET_MAX_SECONDS) {
    return { ok: false, error: `Quiet period must be a whole number of seconds from 0 to ${BATCH_QUIET_MAX_SECONDS}` };
  }
  if (!Number.isInteger(maxWait) || maxWait < BATCH_MAX_WAIT_MIN_SECONDS || maxWait > BATCH_MAX_WAIT_MAX_SECONDS) {
    return {
      ok: false,
      error: `Maximum wait must be a whole number of seconds from ${BATCH_MAX_WAIT_MIN_SECONDS} to ${BATCH_MAX_WAIT_MAX_SECONDS}`,
    };
  }
  if (maxWait < quiet) return { ok: false, error: "Maximum wait cannot be shorter than the quiet period" };
  return { ok: true, quiet, maxWait };
}

/**
 * Mirror of the deadline rule in enqueue_ai_agent_batch_message(): each new
 * message pushes the deadline to now + quiet, never beyond first message + max.
 */
export function nextDueAt(input: { now: Date; firstMessageAt: Date; quietSeconds: number; maxWaitSeconds: number }): Date {
  const ceiling = input.firstMessageAt.getTime() + input.maxWaitSeconds * 1000;
  return new Date(Math.min(input.now.getTime() + input.quietSeconds * 1000, ceiling));
}

// ── Batch → one turn ─────────────────────────────────────────────────────────

export interface StoredBatchMessage {
  id: string;
  whatsappMessageId: string;
  eventId: string | null;
  text: string;
  hasMedia: boolean;
  /** Original WhatsApp timestamp (ISO), or null when the bridge sent none. */
  messageAt: string | null;
  /** When this app received it (ISO). */
  receivedAt: string;
  /** Arrival order from the database; the final tie-breaker. */
  position: number;
}

export const MEDIA_ONLY_PLACEHOLDER = "(media message without text)";

export interface CustomerTurn {
  /** Messages in conversation order, duplicates removed. */
  messages: StoredBatchMessage[];
  /** The customer's words only, one message per line. Empty when every message was media-only. */
  text: string;
  /** Each message as shown to staff (media-only → placeholder), oldest first. */
  segments: string[];
  /** The model-facing rendering: one line per message with its original timestamp. */
  transcript: string;
  hasMedia: boolean;
  firstAt: string;
  lastAt: string;
  /** Event of the newest message: the turn's primary event. */
  primaryEventId: string | null;
  eventIds: string[];
  whatsappMessageIds: string[];
}

/**
 * Oldest first by original timestamp, arrival order breaking ties. A message
 * with no (or an unparseable) timestamp takes the time of the message that
 * arrived just before it, so it keeps its arrival slot instead of jumping
 * ahead of — or behind — stamped messages. Duplicates are dropped.
 */
export function orderBatchMessages(messages: StoredBatchMessage[]): StoredBatchMessage[] {
  const seen = new Set<string>();
  const byArrival = messages
    .filter((m) => {
      if (seen.has(m.whatsappMessageId)) return false;
      seen.add(m.whatsappMessageId);
      return true;
    })
    .sort((a, b) => a.position - b.position);

  let carried = Number.NEGATIVE_INFINITY;
  const keyed = byArrival.map((m, index) => {
    const stamped = Date.parse(m.messageAt ?? "");
    if (Number.isFinite(stamped)) carried = stamped;
    else if (carried === Number.NEGATIVE_INFINITY) {
      const received = Date.parse(m.receivedAt);
      carried = Number.isFinite(received) ? received : 0;
    }
    return { m, key: carried, index };
  });
  return keyed.sort((a, b) => a.key - b.key || a.index - b.index).map((k) => k.m);
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toISOString().slice(11, 19);
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function buildCustomerTurn(messages: StoredBatchMessage[]): CustomerTurn {
  const ordered = orderBatchMessages(messages);
  const stamp = (m: StoredBatchMessage) => m.messageAt ?? m.receivedAt;
  const multiDay = new Set(ordered.map((m) => dayOf(stamp(m)))).size > 1;

  const lines: string[] = [];
  const segments: string[] = [];
  const spoken: string[] = [];
  for (const m of ordered) {
    const body = m.text.replace(/\s+\n/g, "\n").trim();
    const shown = body || (m.hasMedia ? MEDIA_ONLY_PLACEHOLDER : "");
    if (!shown) continue;
    segments.push(shown);
    if (body) spoken.push(body);
    const when = multiDay ? `${dayOf(stamp(m))} ${clock(stamp(m))}` : clock(stamp(m));
    const note = body ? body : "(sent a photo/file/voice note with no text)";
    lines.push(`[${when}] ${note}${body && m.hasMedia ? " (with an attachment)" : ""}`);
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    messages: ordered,
    text: spoken.join("\n"),
    segments,
    transcript: lines.join("\n"),
    hasMedia: ordered.some((m) => m.hasMedia),
    firstAt: first ? stamp(first) : "",
    lastAt: last ? stamp(last) : "",
    primaryEventId: last?.eventId ?? null,
    eventIds: ordered.map((m) => m.eventId).filter((id): id is string => Boolean(id)),
    whatsappMessageIds: ordered.map((m) => m.whatsappMessageId),
  };
}

/** A single live message as a degenerate one-message turn (batching off, or quiet period 0). */
export function singleMessageTurn(input: {
  whatsappMessageId: string;
  eventId: string | null;
  text: string;
  hasMedia: boolean;
  timestamp: string | null;
}): CustomerTurn {
  const now = new Date().toISOString();
  return buildCustomerTurn([
    {
      id: input.whatsappMessageId,
      whatsappMessageId: input.whatsappMessageId,
      eventId: input.eventId,
      text: input.text,
      hasMedia: input.hasMedia,
      messageAt: input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) ? input.timestamp : null,
      receivedAt: now,
      position: 0,
    },
  ]);
}

/** Wire value for an event whose message is waiting in a batch. */
export const BATCHED_DECISION = "BATCHED" as const;

/** Reasons returned to the bridge for a message that was queued, never an error. */
export const BATCHED_REASON = "batched";
