import type { PowerCapability } from "../shared/powerhub-rbac";

export type PowerCapabilityPolicy = {
  capability: string;
  is_allowed: boolean;
};

/**
 * Returns requested capabilities that are both granted to the user and not
 * explicitly denied by the platform role policy. Missing policy rows retain
 * the existing default-allow behavior.
 */
export function getPolicyAllowedCapabilities(
  requestedCapabilities: readonly PowerCapability[],
  grantedCapabilities: readonly PowerCapability[],
  policies: readonly PowerCapabilityPolicy[],
): PowerCapability[] {
  const requested = Array.from(new Set(requestedCapabilities));
  const granted = new Set(grantedCapabilities);
  const denied = new Set(
    policies.filter((policy) => policy.is_allowed === false).map((policy) => policy.capability),
  );

  return requested.filter((capability) => granted.has(capability) && !denied.has(capability));
}
