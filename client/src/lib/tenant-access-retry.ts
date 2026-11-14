export function shouldRetryTenantAccessRecovery(
  isError: boolean,
  errorCode: string | null | undefined,
  verifiedPowerHubReachability: boolean | null,
): boolean {
  // Only a definitive subscription/access denial may use the short recovery retry.
  // Network errors, unresolved reachability, and expired sessions stay on the
  // normal bounded reconnect/refetch path instead of a 5-second request loop.
  return isError && errorCode === "FORBIDDEN" && verifiedPowerHubReachability === true;
}
