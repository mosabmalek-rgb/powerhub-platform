import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");
const grants = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911201000_powerhub_admin_rpc_grants.sql"), "utf8");
const reviewMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911202000_powerhub_admin_review_subscription_upgrade_request_rpc.sql"), "utf8");

const rpcNames = [
  "powerhub_admin_set_tenant_membership_status",
  "powerhub_admin_attach_owner_user",
  "powerhub_admin_update_subscription",
];

describe("admin Supabase RPC contracts", () => {
  it("keeps the three migration RPCs SECURITY DEFINER and locked to service_role", () => {
    for (const name of rpcNames) {
      expect(migration).toContain(`create or replace function public.${name}`);
      expect(grants).toContain(`revoke all on function public.${name}`);
      expect(grants).toContain(`grant execute on function public.${name}`);
    }
    expect(migration.match(/security definer/g)?.length).toBeGreaterThanOrEqual(3);
    expect(grants.match(/to service_role/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("defines the subscription review RPC with its security contract and business transitions", () => {
    expect(reviewMigration).toContain("create or replace function public.powerhub_admin_review_subscription_upgrade_request");
    expect(reviewMigration).toContain("security definer");
    expect(reviewMigration).toContain("set search_path = public, pg_temp");
    expect(reviewMigration).toContain("revoke all on function public.powerhub_admin_review_subscription_upgrade_request");
    expect(reviewMigration).toContain("grant execute on function public.powerhub_admin_review_subscription_upgrade_request");
    expect(reviewMigration).toContain("REQUEST_ALREADY_PROCESSED");
    expect(reviewMigration).toContain("update public.subscription_upgrade_requests");
    expect(reviewMigration).toContain("update public.tenants");
    expect(reviewMigration).toContain("update public.tenant_subscriptions");
    expect(reviewMigration).toContain("platform_admin_' || p_decision || '_subscription_upgrade");
  });

  it("removes only the review procedure legacy guard while preserving other admin guards", () => {
    const admin = readFileSync(resolve(process.cwd(), "server/admin.ts"), "utf8");
    const reviewStart = admin.indexOf("reviewSubscriptionUpgradeRequest:");
    const reviewEnd = admin.indexOf("quickUpgradeOwnerPlan:", reviewStart);
    const reviewBlock = admin.slice(reviewStart, reviewEnd);
    expect(reviewBlock).toContain("reviewSubscriptionUpgradeRequestSupabase");
    expect(reviewBlock).not.toContain("assertLegacyAdminWriteMigrationGuard");
    expect(reviewBlock).not.toContain("dbOrThrow");
    expect(reviewBlock).not.toContain(".transaction(");
    expect(admin).toContain("function assertLegacyAdminWriteMigrationGuard");
    expect(admin).toContain("assertLegacyAdminWriteMigrationGuard(\"الترقية السريعة لباقة صاحب المولد\")");
  });
});
