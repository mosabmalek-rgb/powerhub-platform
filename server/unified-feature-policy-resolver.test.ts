import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("unified tenant feature policy resolver", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922113000_powerhub_feature_policy_resolver.sql"),
    "utf8",
  );

  it("resolves package policy before tenant override", () => {
    expect(migration).toContain("public.package_feature_policies");
    expect(migration).toContain("public.tenant_feature_controls");
    expect(migration).toContain("coalesce(c.status, 'inherit')");
    expect(migration).toContain("coalesce(c.limit_mode, 'inherit')");
  });

  it("does not let a manual limit make an unavailable package feature eligible", () => {
    expect(migration).toContain("coalesce(pp.policy in ('included','addon'), false) as eligible");
    expect(migration).toContain("when coalesce(pp.policy in ('included','addon'), false) = false then false");
  });

  it("keeps privileged resolver execution out of anon/authenticated roles", () => {
    expect(migration).toContain("revoke all on function public.powerhub_resolve_tenant_feature_policy(bigint,text)");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.powerhub_resolve_tenant_feature_policy(bigint,text)");
    expect(migration).toContain("to service_role");
  });
});
