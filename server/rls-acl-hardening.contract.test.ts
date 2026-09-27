import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260927114000_powerhub_internal_rls_acl_hardening.sql"),
  "utf8",
);

describe("internal RLS ACL hardening contract", () => {
  it("classifies all audited no-policy tables as service-role-only", () => {
    for (const tableName of [
      "feature_catalog",
      "feature_global_control_audit",
      "generator_owner_provisioning_operations",
      "package_feature_policies",
      "password_reset_intents",
      "payment_documentation_requests",
      "platform_announcement_reads",
      "platform_announcements",
      "powerhub_invoice_sequences",
      "powerhub_user_device_locks",
      "staff_password_reset_intents",
      "tenant_addon_renewal_decisions",
      "tenant_addon_requests",
      "tenant_feature_control_audit",
      "tenant_feature_controls",
      "tenant_feature_entitlements",
      "tenant_owner_alerts",
    ]) {
      expect(migration).toContain(`'${tableName}'`);
    }
    expect(migration).toContain("revoke all on table public.%I from public, anon, authenticated");
  });

  it("removes public execution from the SECURITY DEFINER addon helper", () => {
    expect(migration).toContain("powerhub_get_active_addon_delta(bigint,text,timestamptz)");
    expect(migration).toContain("revoke all on function public.powerhub_get_active_addon_delta");
    expect(migration).toContain("grant execute on function public.powerhub_get_active_addon_delta");
  });
});
