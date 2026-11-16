import {
  defaultCapabilitiesForRole, powerCapabilityLabels,
  type PowerCapability, type PowerRole,
} from "./powerhub-rbac";

// Existing staff management/messaging routes are owner-only even if their
// capability names are present. Never advertise ineffective owner-only grants.
export const nonDelegableStaffCapabilities: readonly PowerCapability[] = ["manageTeam", "manageMessaging"];

const validCapabilities = new Set(Object.keys(powerCapabilityLabels) as PowerCapability[]);
const reservedCapabilities = new Set<PowerCapability>(nonDelegableStaffCapabilities);

export function delegableCapabilitiesForOwner(ownerPermissions: readonly PowerCapability[]): PowerCapability[] {
  return [...new Set(ownerPermissions)].filter((capability) =>
    validCapabilities.has(capability) && !reservedCapabilities.has(capability));
}

export function defaultStaffPermissionSelection(
  role: Exclude<PowerRole, "owner">,
  ownerPermissions: readonly PowerCapability[],
): PowerCapability[] {
  const available = new Set(delegableCapabilitiesForOwner(ownerPermissions));
  return defaultCapabilitiesForRole(role).filter((capability) => available.has(capability));
}

export function permissionsAreDelegable(
  requested: readonly PowerCapability[],
  ownerPermissions: readonly PowerCapability[],
): boolean {
  const available = new Set(delegableCapabilitiesForOwner(ownerPermissions));
  return requested.length <= available.size &&
    requested.every((capability) => available.has(capability)) &&
    new Set(requested).size === requested.length;
}
