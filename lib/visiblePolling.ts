// Drop-in replacement for `setInterval(poll, intervalMs)` inside a useEffect
// that only polls while the browser tab is visible. Hidden/backgrounded tabs
// stop hitting Supabase every few seconds; the moment the tab becomes
// visible again, `poll` runs immediately and the interval restarts, so the
// user never sees stale data on return. This is purely a client-side
// refresh throttle — the WhatsApp bridge and message storage keep running
// server-side regardless of whether anyone has the inbox open.
//
// Returns a cleanup function, so an effect can just `return startVisiblePolling(...)`.
// Callers still do their own initial load (same as before), so a tab that's
// opened in the background still loads once.
export function startVisiblePolling(poll: () => void, intervalMs: number): () => void {
  if (typeof document === "undefined") return () => {};

  let interval: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (interval === null) interval = setInterval(poll, intervalMs);
  };
  const stop = () => {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      poll();
      start();
    } else {
      stop();
    }
  };

  if (document.visibilityState === "visible") start();
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    stop();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
