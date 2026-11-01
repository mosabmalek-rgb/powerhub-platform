import type { PowerCapability, PowerRole } from "@shared/powerhub-rbac";

export type TenantAccessSnapshot = {
  role: PowerRole;
  permissions: PowerCapability[];
  tenantId: number;
  usesPermissionOverride: boolean;
};

const TENANT_ACCESS_CACHE_PREFIX = "powerhub.tenant-access.v1";

function isTenantRole(value: unknown): value is PowerRole {
  return ["owner", "manager", "accountant", "collector", "technician", "viewer"].includes(String(value));
}

/**
 * Session-only visual bootstrap. A cached value is never authorization:
 * callers must revalidate against the server and reject explicit 401/403.
 */
export function readCachedTenantAccess(userId: number | undefined, siteId: number): TenantAccessSnapshot | null {
  if (!userId || !siteId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(TENANT_ACCESS_CACHE_PREFIX + ":" + userId + ":" + siteId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TenantAccessSnapshot>;
    if (
      isTenantRole(parsed.role) &&
      Array.isArray(parsed.permissions) &&
      parsed.permissions.every((permission) => typeof permission === "string") &&
      Number.isSafeInteger(parsed.tenantId) && Number(parsed.tenantId) > 0 &&
      typeof parsed.usesPermissionOverride === "boolean"
    ) return parsed as TenantAccessSnapshot;
  } catch {
    // Browser storage is an optional offline enhancement.
  }
  return null;
}

export function writeCachedTenantAccess(
  userId:¶»§q«^