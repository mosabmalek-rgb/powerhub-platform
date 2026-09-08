import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tenant subscription gate integration contract", () => {
  it("enforces subscription state at the central site-access resolver", () => {
    const source = readFileSync(resolve(process.cwd(), "server/powerhub-supabase.ts"), "utf8");

    expect(source).toContain('import { requireTenantSubscription } from "./subscription-access";');
    expect(source).toMatch(/resolveSupabaseSiteAccess[\\s\\S]*await requireTenantSubscription\\(site\.tenantId\)/);
  });
});
