export type PlatformIdentity = {
  role?: string | null;
  platformRole?: string | null;
  accountStatus?: string | null;
};

const PLATFORM_ROLES = new Set(["platform_owner", "platform_admin", "finance_admin"]);

export function isActivePlatformAdmin(user: PlatformIdentity | null | undefined): boolean {
  return Boolean(
    user?.role === "admin" &&
    user.accountStatus === "active" &&
    user.platformRole &&
    PLATFORM_ROLES.has(user.platformRole),
  );
}

export function isPlatformRole(user: PlatformIdentity | null | undefined, roles: readonly string[]): boolean {
  return isActivePlatformAdmin(user) && Boolean(user?.platformRole && roles.includes(user.platformRole));
}
