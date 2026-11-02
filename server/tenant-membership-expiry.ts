export type TenantMembershipExpiry = {
  expires_at?: string | null;
};

/**
 * An active membership with no expiry is indefinite. A malformed expiry fails
 * closed; equality with the current instant is already expired.
 */
export function isTenantMembershipUnexpired(
  membership: TenantMembershipExpiry | null | undefined,
  now: Date | number = Date.now(),
): boolean {
  if (!membership) return false;
  if (membership.expires_at == null) return true;

  const expiryMs = Date.parse(membership.expires_at);
  const nowMs = now instanceof Date ? now.getTime() : now;
  return Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs > nowMs;
}

/** PostgREST predicate matching the runtime expiry boundary above. */
export function activeTenantMembershipOrFilter(now: Date = new Date()): string {
  return `expires_at.is.null,expires_at.gt.${now.toISOString()}`;
}
