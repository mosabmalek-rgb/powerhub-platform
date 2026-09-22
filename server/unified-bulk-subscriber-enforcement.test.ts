import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("bulk subscriber unified enforcement", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260922130000_powerhub_unified_bulk_subscriber_enforcement.sql"),
    "utf8",
  );

  it("resolves subscriber policy inside the database", () => {
    expect(sql).toContain("powerhub_resolve_tenant_feature_policy(p_tenant_id, 'subscriber_management')");
    expect(sql).toContain("v_feature_policy.effective_limit");
  });

  it("does not use the client quota argument as the authoritative limit", () => {
    expect(sql).not.toContain(">= p_quota_limit");
  });

  it("keeps the RPC privileged", () => {
    expect(sql).toContain("revoke all on function public.powerhub_bulk_upsert_subscribers");
    expect(sql).toContain("to service_role");
  });
});
