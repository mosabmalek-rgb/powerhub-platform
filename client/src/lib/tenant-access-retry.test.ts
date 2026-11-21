import { describe, expect, it } from "vitest";
import { shouldRetryTenantAccessRecovery } from "./tenant-access-retry";

describe("tenant access recovery retry gate", () => {
  it("retries a confirmed FORBIDDEN response only while the PowerHub origin is reachable", () => {
    expect(shouldRetryTenantAccessRecovery(true, "FORBIDDEN", true)).toBe(true);
  });

  it("does not retry network failures or while origin reachability is unknown/offline", () => {
    expect(shouldRetryTenantAccessRecovery(true, "INTERNAL_SERVER_ERROR", true)).toBe(false);
    expect(shouldRetryTenantAccessRecovery(true, undefined, true)).toBe(false);
    expect(shouldRetryTenantAccessRecovery(true, "FORBIDDEN", null)).toBe(false);
    expect(shouldRetryTenantAccessRecovery(true, "FORBIDDEN", false)).toBe(false);
  });

  it("does not run a recovery loop before an access error exists", () => {
    expect(shouldRetryTenantAccessRecovery(false, "FORBIDDEN", true)).toBe(false);
  });
});
