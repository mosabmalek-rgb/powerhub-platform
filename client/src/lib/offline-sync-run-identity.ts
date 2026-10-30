export type OfflineSyncRunIdentitySnapshot = {
  userId: number;
  siteId: number;
  authUserId: number | null;
  isLoggingOut: boolean;
  isOnlineAuthenticated: boolean;
};

export type OfflineSyncRunIdentity = OfflineSyncRunIdentitySnapshot & {
  generation: number;
};

/**
 * Advances the generation only when an identity or authentication boundary
 * changes. Keeping the unauthenticated user as null avoids NaN-based rerender
 * churn while a session is being restored or cleared.
 */
export function advanceOfflineSyncRunIdentity(
  current: OfflineSyncRunIdentity | null,
  next: OfflineSyncRunIdentitySnapshot,
): OfflineSyncRunIdentity {
  if (!current) return { ...next, generation: 0 };

  const changed =
    current.userId !== next.userId ||
    current.siteId !== next.siteId ||
    current.authUserId !== next.authUserId ||
    current.isLoggingOut !== next.isLoggingOut ||
    current.isOnlineAuthenticated !== next.isOnlineAuthenticated;

  return changed ? { ...next, generation: current.generation + 1 } : current;
}

/** A captured run is valid only for its original user, branch and auth generation. */
export function isOfflineSyncRunCurrent(
  owner: OfflineSyncRunIdentity,
  current: OfflineSyncRunIdentity,
  requireOnlineAuth = true,
): boolean {
  return Number.isSafeInteger(owner.userId) &&
    owner.userId > 0 &&
    Number.isSafeInteger(owner.siteId) &&
    owner.siteId > 0 &&
    owner.authUserId === owner.userId &&
    current.generation === owner.generation &&
    current.userId === owner.userId &&
    current.siteId === owner.siteId &&
    current.authUserId === owner.userId &&
    !current.isLoggingOut &&
    (!requireOnlineAuth || current.isOnlineAuthenticated);
}

export function assertOfflineSyncRunCurrent(
  owner: OfflineSyncRunIdentity,
  current: OfflineSyncRunIdentity,
  requireOnlineAuth = true,
): void {
  if (!isOfflineSyncRunCurrent(owner, current, requireOnlineAuth)) {
    throw Object.assign(new Error("توقف إرسال المسودات لأن هوية الحساب أو نطاق الفرع تغيّر."), {
      name: "PowerHubOfflineSyncRunSupersededError",
    });
  }
}
