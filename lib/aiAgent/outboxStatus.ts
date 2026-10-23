// Client-safe: how the admin UI reads an ai_agent_outbox row. Pure, no I/O.
//
// The stored status stays the bridge contract's pending | dispatched | sent |
// failed (docs/ai-agent-bridge-contract.md §3.3–§4). Two distinctions the
// admin needs are derived here instead of stored:
//
//   * blocked    — acked 'failed' with a policy reason code: the bridge chose
//                  not to send (sending switched off, Observe mode, takeover,
//                  rate limit…). Provably not sent, and nothing is wrong.
//   * unresolved — still 'dispatched' with no ack after UNRESOLVED_AFTER_MS.
//                  The send may or may not have reached WhatsApp. Nothing
//                  retries it; an admin checks the chat.
//
// Any failure reason not listed below is shown as a real failure, so a new
// or unexpected bridge code is never hidden as "intentional".

export type OutboxStatus = "pending" | "dispatched" | "sent" | "failed";
export type OutboxState = "pending" | "dispatched" | "unresolved" | "sent" | "blocked" | "failed";

export const UNRESOLVED_AFTER_MS = 10 * 60_000;

/** Bridge send-check codes that mean "intentionally not sent". */
export const BLOCK_REASONS: ReadonlySet<string> = new Set([
  "agent_disabled",
  "bridge_send_disabled",
  "observe_mode",
  "human_takeover",
  "stale_reply",
  "superseded_by_newer_message",
  "held_after_unknown_send",
  "unapproved_commitment",
  "chat_rate_limited",
  "business_rate_limited",
]);

/** The reason code of an ack error: "not_sent: socket closed" → "not_sent". */
export function failureReason(error: string | null | undefined): string | null {
  const code = (error ?? "").split(":")[0].trim();
  return code || null;
}

export function outboxState(
  row: { status: string; error: string | null; dispatched_at: string | null; created_at: string },
  now: Date
): OutboxState {
  switch (row.status) {
    case "pending":
    case "sent":
      return row.status;
    case "failed": {
      const reason = failureReason(row.error);
      return reason && BLOCK_REASONS.has(reason) ? "blocked" : "failed";
    }
    case "dispatched": {
      const since = Date.parse(row.dispatched_at ?? row.created_at);
      return Number.isNaN(since) || now.getTime() - since >= UNRESOLVED_AFTER_MS ? "unresolved" : "dispatched";
    }
    default:
      // Not a contract status: treat as unconfirmed rather than guess.
      return "unresolved";
  }
}
