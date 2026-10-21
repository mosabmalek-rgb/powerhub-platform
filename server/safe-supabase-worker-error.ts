export type SafeSupabaseWorkerError = { code?: string | null; message?: string | null } | null | undefined;

export function logSafeSupabaseWorkerQueryFailure(
  component: "unified-messaging",
  operation: string,
  error: SafeSupabaseWorkerError,
): void {
  const rawCode = typeof error?.code === "string" ? error.code : "";
  const rawMessage = typeof error?.message === "string" ? error.message : "Unknown Supabase error";
  const safeMessage = rawMessage
    .replace(/(\\bbearer\\s+)[^\\s,;]+/gi, "$1[REDACTED]")
    .replace(/\\b(api[_ -]?key|secret|password|token)\\b\\s*[:=]\\s*[^\\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);

  console.error(`[${component}] ${operation} failed`, {
    code: /^[A-Z0-9_]{2,16}$/.test(rawCode) ? rawCode : "unknown",
    message: safeMessage,
  });
}
