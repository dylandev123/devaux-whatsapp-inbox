"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, CustomerAiState } from "@/lib/aiAgent/client";
import { CUSTOMER_MODE_HINT, CUSTOMER_MODE_LABEL, CUSTOMER_MODES, CustomerMode } from "@/lib/aiAgent/customerMode";

// The AI handling mode of ONE customer, shown in the conversation view. The mode only narrows what the
// business-wide settings allow: this bar says so whenever something else is stopping the AI (agent off,
// Observe mode, a human takeover), so the label never promises more than will happen.

const TONE: Record<CustomerMode, { on: string; dot: string }> = {
  auto_reply: { on: "border-emerald-500 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" },
  staff_first: { on: "border-sky-500 bg-sky-50 text-sky-800", dot: "bg-sky-500" },
  manual_only: { on: "border-zinc-400 bg-zinc-100 text-zinc-700", dot: "bg-zinc-400" },
};

export function CustomerAiMode({ businessSlug, chatId }: { businessSlug: string; chatId: string }) {
  const [state, setState] = useState<CustomerAiState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await aiAgentApi.getCustomerState(businessSlug, chatId));
      setHidden(false);
    } catch (err) {
      // The AI endpoints are admin-only: other staff simply do not see the control.
      const message = err instanceof Error ? err.message : "";
      if (/admin access|authentication/i.test(message)) setHidden(true);
      else setError(message || "Could not load AI settings");
    }
  }, [businessSlug, chatId]);

  useEffect(() => {
    setState(null);
    setError(null);
    void load();
  }, [load]);

  async function choose(mode: CustomerMode | null) {
    if (
      mode === "auto_reply" &&
      !window.confirm("Let the AI answer this customer by itself? It will reply only from approved business knowledge and hand everything else to staff.")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await aiAgentApi.setCustomerMode(businessSlug, chatId, mode);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the AI mode");
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!state) return error ? <p className="border-b border-zinc-200 bg-white px-5 py-1.5 text-xs text-red-600">{error}</p> : null;

  const paused = state.control === "human" && (!state.humanUntil || new Date(state.humanUntil).getTime() > Date.now());
  // What actually stops the AI regardless of the customer's mode, most restrictive first.
  const override = !state.agentEnabled
    ? "The AI agent is switched off for this business."
    : state.agentMode === "observe"
      ? "Business is in Observe mode: the AI never messages customers."
      : paused
        ? "A human has taken over this chat: the AI is paused."
        : null;

  return (
    <div className="flex flex-col gap-1 border-b border-zinc-200 bg-white px-3 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">AI</span>
        <div role="radiogroup" aria-label="AI handling mode" className="flex flex-wrap gap-1">
          {CUSTOMER_MODES.map((mode) => {
            const active = state.customerMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                title={CUSTOMER_MODE_HINT[mode]}
                onClick={() => !active && void choose(mode)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium disabled:cursor-default disabled:opacity-60 ${
                  active ? TONE[mode].on : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                {active && <span className={`h-1.5 w-1.5 rounded-full ${TONE[mode].dot}`} aria-hidden />}
                {CUSTOMER_MODE_LABEL[mode]}
              </button>
            );
          })}
        </div>
        {state.ownMode ? (
          <button type="button" disabled={busy} onClick={() => void choose(null)} className="cursor-pointer text-xs text-zinc-500 underline hover:text-zinc-700">
            Use business default ({CUSTOMER_MODE_LABEL[state.defaultMode]})
          </button>
        ) : (
          <span className="text-xs text-zinc-400">business default</span>
        )}
        {state.openEscalation && (
          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800" title="Open escalation: the AI is not replying on its own while staff handle it">
            Staff handling #{state.openEscalation.refCode}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500">{CUSTOMER_MODE_HINT[state.customerMode]}</p>
      {override && <p className="text-xs text-amber-700">{override}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
