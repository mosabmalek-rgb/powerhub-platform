import { describe, expect, it } from "vitest";
import { isFreshOnlineServerRead, resolvePayrollPayoutAccountId } from "./payroll-report-guards";

describe("payroll fresh-server-read guard", () => {
  const fresh = {
    online: true,
    data: [],
    fetchedAfterMount: true,
    fetching: false,
    error: false,
  };

  it("accepts data only after a successful settled server read in the online session", () => {
    expect(isFreshOnlineServerRead(fresh)).toBe(true);
    expect(isFreshOnlineServerRead({ ...fresh, online: false })).toBe(false);
    expect(isFreshOnlineServerRead({ ...fresh, fetchedAfterMount: false })).toBe(false);
    expect(isFreshOnlineServerRead({ ...fresh, fetching: true })).toBe(false);
    expect(isFreshOnlineServerRead({ ...fresh, error: true })).toBe(false);
    expect(isFreshOnlineServerRead({ ...fresh, data: undefined })).toBe(false);
  });

  it("does not treat cached account IDs as valid unless present in the current server result", () => {
    const currentAccounts = [{ id: 71 }, { id: "72" }];
    expect(resolvePayrollPayoutAccountId(currentAccounts, "71")).toBe(71);
    expect(resolvePayrollPayoutAccountId(currentAccounts, "72")).toBe(72);
    expect(resolvePayrollPayoutAccountId(currentAccounts, "73")).toBeNull();
    expect(resolvePayrollPayoutAccountId(undefined, "71")).toBeNull();
    expect(resolvePayrollPayoutAccountId(currentAccounts, "")).toBeNull();
    expect(resolvePayrollPayoutAccountId(currentAccounts, "0")).toBeNull();
    expect(resolvePayrollPayoutAccountId(currentAccounts, "not-an-id")).toBeNull();
  });
});
