export type AdminSubscriptionStatus = "trial" | "active" | "overdue" | "suspended" | "cancelled" | "expired" | "archived";

export function getEffectiveAdminSubscriptionStatus(
  status: string | null | undefined,
  endsAt: string | Date | null | undefined,
  archivedAt: string | Date | null | undefined,
  now = new Date(),
): AdminSubscriptionStatus | null {
  if (!status) return null;
  if (archivedAt) return "archived";
  if ((status === "trial" || status === "active") && endsAt) {
    const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
    if (!Number.isNaN(end.getTime()) && end <= now) return "expired";
  }
  return status as AdminSubscriptionStatus;
}

export function isEffectivelyActiveAdminSubscription(
  status: string | null | undefined,
  endsAt: string | Date | null | undefined,
  archivedAt: string | Date | null | undefined,
  now = new Date(),
) {
  const effective = getEffectiveAdminSubscriptionStatus(status, endsAt, archivedAt, now);
  return effective === "trial" || effective === "active";
}

export function getNextRenewalEndDate(
  currentEndsAt: string | Date | null | undefined,
  billingCycle: string | null | undefined,
  now = new Date(),
) {
  const current = currentEndsAt ? (currentEndsAt instanceof Date ? currentEndsAt : new Date(currentEndsAt)) : null;
  const base = current && !Number.isNaN(current.getTime()) && current > now ? current : now;
  const next = new Date(base);
  next.setMonth(next.getMonth() + (billingCycle === "yearly" ? 12 : 1));
  return next;
}
