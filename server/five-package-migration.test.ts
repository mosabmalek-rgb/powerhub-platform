import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("five-package migration contract", () => {
  const authoritySql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922150000_powerhub_five_package_subscription_authority.sql"),
    "utf8",
  );
  const cleanupSql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922151000_powerhub_remove_legacy_package_metadata.sql"),
    "utf8",
  );

  it("defines only the five commercial package codes", () => {
    for (const code of ["basic", "advanced", "professional", "business", "vip"]) {
      expect(authoritySql).toContain(code);
    }
    expect(authoritySql).not.toContain("'starter'");
    expect(authoritySql).not.toContain("'enterprise'");
  });

  it("backfills the canonical tenant package before enforcing it", () => {
    expect(authoritySql).toContain("update public.tenants t");
    expect(authoritySql).toContain("alter column package_code set not null");
    expect(authoritySql).toContain("tenants_package_code_check");
  });

  it("removes legacy compatibility metadata only after package validation", () => {
    expect(cleanupSql).toContain("drop column if exists plan");
    expect(cleanupSql).toContain("legacyPlan");
    expect(cleanupSql).toContain("legacyFallback");
    expect(cleanupSql).toContain("UNSUPPORTED_PACKAGE_CODE_REMAINS");
  });
});
