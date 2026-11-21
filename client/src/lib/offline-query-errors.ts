type ErrorWithAuthCode = {
  code?: unknown;
  data?: { code?: unknown } | null;
  shape?: { data?: { code?: unknown } | null } | null;
  status?: unknown;
  response?: { status?: unknown } | null;
  cause?: unknown;
};

/**
 * A transport failure is not proof that access was revoked, so the last
 * successful scoped snapshot may remain visible for offline continuity.
 * An explicit 401/403 is different: never use that failed query's stale data
 * or a broader offline fallback to bypass a server authorization decision.
 */
export function isExplicitAuthorizationDenial(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const node = current as ErrorWithAuthCode;
    const codes = [node.data?.code, node.shape?.data?.code, node.code];
    if (codes.some((code) => code === "UNAUTHORIZED" || code === "FORBIDDEN")) return true;

    const statuses = [node.status, node.response?.status];
    if (statuses.some((status) => status === 401 || status === 403)) return true;

    current = node.cause;
  }

  return false;
}
