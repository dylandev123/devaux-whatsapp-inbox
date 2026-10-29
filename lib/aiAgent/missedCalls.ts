// Missed-call rule: decides, from what the bridge saw of one call, whether it was RELIABLY a missed incoming one-to-one call.
// Pure (no I/O), unit-tested in tests/aiAgentMissedCalls.test.ts.
//
// What the bridge can know (Baileys 6.7 `call` events: offer, ringing, accept, reject, timeout, terminate), and what it cannot:
//   * `timeout` is a server "terminate" with reason "timeout": the call rang out. It is the one status that means "nobody
//     answered". That is the only status treated as missed.
//   * `terminate` with any other reason is fired when the caller hangs up, when somebody accepted, when it was rejected, and for
//     calls answered on another device: the event alone cannot tell them apart, so it is UNCERTAIN and never answered.
//   * `accept` / `reject` mean somebody picked up or declined: not missed.
//   * a call seen only as an offline replay (`offline`), or whose offer this bridge never saw, is UNCERTAIN.
//   * an outgoing call (the business phone dialled) and a group call are never answered.
// The bridge applies the same rules before it reports anything (src/agent/calls.ts); this re-checks them, so a bridge bug cannot
// make the Inbox message a customer.

export const DEFAULT_MISSED_CALL_MESSAGE = "Thanks for reaching out! Sorry we missed your call. We're unable to answer at the moment, but how can we help you?";
export const MISSED_CALL_COOLDOWN = { min: 5, max: 10080, default: 60 } as const;
export const MISSED_CALL_MESSAGE_MAX = 500;
/** A call that ended longer ago than this is never answered (a delayed or replayed event). */
export const MISSED_CALL_MAX_AGE_MS = 5 * 60_000;

export type CallFinalStatus = "timeout" | "terminate" | "accept" | "reject" | "offer" | "ringing";

export interface CallReport {
  callId: string;
  /** The caller's chat JID (…@s.whatsapp.net or …@lid). */
  callerJid: string;
  /** The business account itself placed the call. */
  outgoing: boolean;
  isGroup: boolean;
  isVideo: boolean | null;
  /** Delivered as an offline replay rather than live. */
  offline: boolean;
  sawOffer: boolean;
  sawAccept: boolean;
  sawReject: boolean;
  finalStatus: CallFinalStatus;
  /** ISO times: the offer, and the event that ended the call. */
  offerAt: string | null;
  endedAt: string | null;
}

export type CallVerdict = { missed: true } | { missed: false; reason: string };

const DIRECT_JID = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;
const FINAL: readonly string[] = ["timeout", "terminate", "accept", "reject"];

export function parseCallReport(raw: unknown): CallReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const callId = str(r.callId, 200);
  const callerJid = str(r.callerJid, 200);
  const finalStatus = str(r.finalStatus, 20);
  if (!callId || !callerJid || !finalStatus) return null;
  if (!["timeout", "terminate", "accept", "reject", "offer", "ringing"].includes(finalStatus)) return null;
  const time = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    callId,
    callerJid,
    // Anything the bridge did not state outright is the cautious reading: it counts against replying.
    outgoing: r.outgoing !== false,
    isGroup: r.isGroup !== false,
    isVideo: typeof r.isVideo === "boolean" ? r.isVideo : null,
    offline: r.offline !== false,
    sawOffer: r.sawOffer === true,
    sawAccept: r.sawAccept !== false,
    sawReject: r.sawReject !== false,
    finalStatus: finalStatus as CallFinalStatus,
    offerAt: time(r.offerAt),
    endedAt: time(r.endedAt),
  };
}

/** Missed only when every condition for "reliably missed" holds; otherwise the reason it was not (for the audit log). */
export function classifyCall(report: CallReport, now: Date): CallVerdict {
  if (report.outgoing) return { missed: false, reason: "outgoing" };
  if (report.isGroup) return { missed: false, reason: "group_call" };
  if (!DIRECT_JID.test(report.callerJid)) return { missed: false, reason: "invalid_caller" };
  if (report.sawAccept || report.finalStatus === "accept") return { missed: false, reason: "answered" };
  if (report.sawReject || report.finalStatus === "reject") return { missed: false, reason: "declined" };
  if (report.offline) return { missed: false, reason: "uncertain_offline" };
  if (!report.sawOffer || !report.offerAt) return { missed: false, reason: "uncertain_no_offer" };
  if (!FINAL.includes(report.finalStatus) || report.finalStatus === "terminate") return { missed: false, reason: "uncertain_ended" };
  if (report.finalStatus !== "timeout" || !report.endedAt) return { missed: false, reason: "not_missed" };
  const ended = Date.parse(report.endedAt);
  if (ended < Date.parse(report.offerAt)) return { missed: false, reason: "uncertain_times" };
  if (now.getTime() - ended > MISSED_CALL_MAX_AGE_MS || ended - now.getTime() > MISSED_CALL_MAX_AGE_MS) return { missed: false, reason: "stale" };
  return { missed: true };
}

export function validateMissedCallConfig(input: { message?: unknown; cooldownMinutes?: unknown }): { ok: true; message?: string; cooldownMinutes?: number } | { ok: false; error: string } {
  const out: { message?: string; cooldownMinutes?: number } = {};
  if (input.message !== undefined) {
    if (typeof input.message !== "string" || !input.message.trim()) return { ok: false, error: "The missed-call message cannot be empty" };
    if (input.message.trim().length > MISSED_CALL_MESSAGE_MAX) return { ok: false, error: `The missed-call message can be at most ${MISSED_CALL_MESSAGE_MAX} characters` };
    out.message = input.message.trim();
  }
  if (input.cooldownMinutes !== undefined) {
    const v = input.cooldownMinutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < MISSED_CALL_COOLDOWN.min || v > MISSED_CALL_COOLDOWN.max) {
      return { ok: false, error: `The missed-call cooldown must be ${MISSED_CALL_COOLDOWN.min}–${MISSED_CALL_COOLDOWN.max} minutes` };
    }
    out.cooldownMinutes = v;
  }
  return { ok: true, ...out };
}

/** Plain-language reason for the admin's call log. */
export const CALL_REASON_TEXT: Record<string, string> = {
  replied: "Reply sent",
  outgoing: "Outgoing call",
  group_call: "Group call",
  invalid_caller: "Caller could not be identified",
  answered: "Answered",
  declined: "Declined",
  uncertain_offline: "Uncertain: reported late (offline replay)",
  uncertain_no_offer: "Uncertain: the call start was not seen",
  uncertain_ended: "Uncertain: ended without a clear 'unanswered' signal",
  uncertain_times: "Uncertain: inconsistent timing",
  not_missed: "Not a missed call",
  stale: "Too old to answer",
  cooldown: "Already replied to this caller recently",
  rate_limited: "Hourly reply limit reached",
  duplicate: "Already handled",
  mode_not_allowed: "Not allowed in this mode",
  contact_not_permitted: "Contact not permitted for AI messages",
  contact_excluded: "Contact excluded",
  human_active: "Staff are handling this chat",
  agent_off: "AI agent off",
  disabled: "Rule off",
};
