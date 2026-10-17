export type OfflineAuthTransition =
  | "online-session"
  | "recover-offline-session"
  | "explicit-sign-out";

/**
 * A missing Supabase session is not itself proof that the user explicitly
 * signed out. Only the logout action initiated in this browser revokes the
 * offline lease; startup/refresh failures must attempt the local lease instead.
 */
export function resolveOfflineAuthTransition(
  event: string,
  sessionUserId: string | null,
  explicitLogoutRequested: boolean,
): OfflineAuthTransition {
  if (explicitLogoutRequested && !sessionUserId) return "explicit-sign-out";
  if (sessionUserId) return "online-session";
  return "recover-offline-session";
}

/**
 * A getSession/refreshSession snapshot may finish after a newer auth event.
 * In that case, the session updated by the event must win over the stale
 * async response, especially when that response contains null.
 */
export function selectAuthSnapshot<T>(
  snapshot: T | null,
  current: T | null,
  requestRevision: number,
  currentRevision: number,
): T | null {
  return requestRevision === currentRevision ? snapshot : current;
}
