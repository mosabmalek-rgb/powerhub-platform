import { isTenantMembershipUnexpired } from "./tenant-membership-expiry";

export type AnnouncementMembership = {
  tenant_id: number | string;
  role: string;
  is_active: boolean;
  membership_status: string;
  expires_at: string | null;
};

export type AnnouncementStaffProfile = {
  tenant_id: number | string;
  role: string;
};

export type AnnouncementActor = {
  accountStatus: string | null;
  platformRole: string | null;
  accountRole: string | null;
};

/**
 * Resolve announcement audience roles in the scope of the target tenant.
 * A role held in another tenant must never grant access to this tenant's
 * announcement. Global announcements may use the union of active tenant roles.
 */
export function canUserReceiveAnnouncement(
  announcementTenantId: number | null,
  audienceRoles: readonly string[] | null,
  actor: AnnouncementActor,
  memberships: readonly AnnouncementMembership[],
  profiles: readonly AnnouncementStaffProfile[],
): boolean {
  if (actor.accountStatus !== "active") return false;

  const activeMemberships = memberships.filter((membership) =>
    membership.is_active &&
    membership.membership_status === "active" &&
    isTenantMembershipUnexpired(membership),
  );
  const activeTenantIds = new Set(activeMemberships.map((membership) => Number(membership.tenant_id)));
  if (announcementTenantId !== null && !activeTenantIds.has(Number(announcementTenantId))) return false;

  const roles = new Set<string>(["all"]);
  for (const membership of activeMemberships) {
    if (announcementTenantId === null || Number(membership.tenant_id) === Number(announcementTenantId)) {
      roles.add(membership.role);
    }
  }
  for (const profile of profiles) {
    const tenantId = Number(profile.tenant_id);
    if (!activeTenantIds.has(tenantId)) continue;
    if (announcementTenantId !== null && tenantId !== Number(announcementTenantId)) continue;
    roles.add(profile.role);
  }
  if (announcementTenantId === null && actor.accountRole) roles.add(actor.accountRole);
  if (announcementTenantId === null && actor.platformRole) roles.add(actor.platformRole);

  const audience = audienceRoles?.length ? audienceRoles : ["all"];
  return audience.includes("all") || audience.some((role) => roles.has(role));
}
