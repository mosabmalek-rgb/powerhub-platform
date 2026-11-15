import { describe, expect, it } from "vitest";
import { financialCloseReadinessScope } from "./financial-d9-scope";

describe("D9 close-readiness scope input", () => {
  it("accepts only a site and month; rejects forged tenant parameters", () => {
    expect(financialCloseReadinessScope.safeParse({siteId:1,period:"2026-11"}).success).toBe(true);
    expect(financialCloseReadinessScope.safeParse({
      siteId:1,period:"2026-11",tenantId:9000000000001,
    }).success).toBe(false);
    expect(financialCloseReadinessScope.safeParse({
      siteId:1,period:"2026-11",tenant_id:9000000000001,
    }).success).toBe(false);
  });
});
