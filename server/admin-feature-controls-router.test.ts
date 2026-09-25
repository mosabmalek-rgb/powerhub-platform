import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

describe("admin feature controls production schema contract", () => {
  it("does not depend on legacy tenant plan/package columns", async () => {
    const source = await readFile(fileURLToPath(new URL("./admin-feature-controls-router.ts", import.meta.url)), "utf8");
    expect(source).not.toContain('select("id,name,status,slug,plan,package_code")');
    expect(source).not.toContain("legacyPlan: tenant.plan");
    expect(source).toContain('select("id,name,status,slug")');
    expect(source).toContain("subscription.package_code");
  });
});
