// Supabase's PostgrestError (thrown by `.throwOnError()` / re-thrown manually
// after `if (error) throw error`) is a plain object — it does NOT extend the
// built-in Error class. Code that did `err instanceof Error ? err.message :
// "generic fallback"` was silently discarding the real message/code/hint on
// every Postgrest/RPC failure and showing a useless generic string instead.
// describeError() handles that shape (and a few others) properly.

interface PostgrestLikeError {
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
}

function isPostgrestLikeError(value: unknown): value is PostgrestLikeError {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** Human-readable message for UI, with as much real detail as the error shape gives us. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isPostgrestLikeError(err)) {
    const parts = [err.message, err.hint, err.code ? `(${err.code})` : null].filter(Boolean);
    return parts.join(" ");
  }
  if (typeof err === "string") return err;
  return "Unknown error";
}

/** Logs full structured detail to the console, then returns a UI-safe message. */
export function logAndDescribeError(context: string, err: unknown): string {
  console.error(`[${context}]`, err);
  return describeError(err);
}
