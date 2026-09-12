import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");
const grants = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911201000_powerhub_admin_rpc_grants.sql"), "utf8");
const reviewMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911202000_powerhub_admin_review_subscription_upgrade_request_rpc.sql"), "utf8");
const renewalMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260912100000_powerhub_admin_renew_subscription_rpc.sql"), "utf8");
const smsReviewMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260912110000_powerhub_admin_review_sms_package_request_rpc.sql"), "utf8");
const invitationMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260912130000_powerhub_platform_access_invitation_rpcs.sql"), "utf8");

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

  it("defines the subscription renewal RPC atomically with site validation and audit logging", () => {
    expect(renewalMigration).toContain("create or replace function public.powerhub_admin_renew_subscription");
    expect(renewalMigration).toContain("security definer");
    expect(renewalMigration).toContain("set search_path = public, pg_temp");
    expect(renewalMigration).toContain("SITE_NOT_FOUND");
    expect(renewalMigration).toContain("SUBSCRIPTION_NOT_FOUND");
    expect(renewalMigration).toContain("renewal_count = renewal_count + p_periods");
    expect(renewalMigration).toContain("last_renewed_at = now()");
    expect(renewalMigration).toContain("platform_admin_renew_subscription");
    expect(renewalMigration).toContain("revoke all on function public.powerhub_admin_renew_subscription");
    expect(renewalMigration).toContain("grant execute on function public.powerhub_admin_renew_subscription");
  });

  it("defines the SMS package review RPC atomically with validation, site scope, and audit logging", () => {
    expect(smsReviewMigration).toContain("create or replace function public.powerhub_admin_review_sms_package_request");
    expect(smsReviewMigration).toContain("security definer");
    expect(smsReviewMigration).toContain("set search_path = public, pg_temp");
    expect(smsReviewMigration).toContain("REQUEST_NOT_FOUND");
    expect(smsReviewMigration).toContain("REQUEST_ALREADY_PROCESSED");
    expect(smsReviewMigration).toContain("APPROVED_MESSAGES_REQUIRED");
    expect(smsReviewMigration).toContain("SITE_NOT_FOUND");
    expect(smsReviewMigration).toContain("for update");
    expect(smsReviewMigration).toContain("reviewed_by_user_id = p_actor_user_id");
    expect(smsReviewMigration).toContain("grant execute on function public.powerhub_admin_review_sms_package_request");
  });

  it("defines platform invitation creation and acceptance as service-role-only SECURITY DEFINER RPCs", () => {
    expect(invitationMigration).toContain("create or replace function public.powerhub_admin_invite_platform_access");
    expect(invitationMigration).toContain("create or replace function public.powerhub_accept_pending_platform_invitation");
    expect(invitationMigration).toContain("security definer");
    expect(invitationMigration).toContain("set search_path = public, pg_temp");
    expect(invitationMigration).toContain("INVITATION_ALREADY_PENDING");
    expect(invitationMigration).toContain("ACCOUNT_ALREADY_EXISTS");
    expect(invitationMigration).toContain("status = 'accepted'");
    expect(invitationMigration).toContain("role = 'admin'");
    expect(invitationMigration).toContain("grant execute on function public.powerhub_admin_invite_platform_access");
    expect(invitationMigration).toContain("grant execute on function public.powerhub_accept_pending_platform_invitation");
  });

  it("keeps migrated admin procedures Supabase-only while preserving guards for blocked legacy mutations", () => {
    const admin = readFileSync(resolve(process.cwd(), "server/admin.ts"), "utf8");
    const reviewStart = admin.indexOf("reviewSubscriptionUpgradeRequest:");
    const reviewEnd = admin.indexOf("quickUpgradeOwnerPlan:", reviewStart);
    const reviewBlock = admin.slice(reviewStart, reviewEnd);
    expect(reviewBlock).toContain("reviewSubscriptionUpgradeRequestSupabase");
    expect(reviewBlock).not.toContain("assertLegacyAdminWriteMigrationGuard");
    expect(reviewBlock).not.toContain("dbOrThrow");
    expect(reviewBlock).not.toContain(".transaction(");
    expect(admin).toContain("function assertLegacyAdminWriteMigrationGuard");
    expect(admin).toContain("assertLegacyAdminWriteMigrationGuard(\"إنشاء صاحب مولد\")");
    expect(admin).toContain("assertLegacyAdminWriteMigrationGuard(\"تحديث الشكوى\")");
  });

  it("keeps the SMS package review adapter Supabase-only", () => {
    const adapter = readFileSync(resolve(process.cwd(), "server/admin-supabase-writes.ts"), "utf8");
    const start = adapter.indexOf("export async function reviewSmsPackageRequest");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = adapter.slice(start);
    expect(block).toContain("powerhub_admin_review_sms_package_request");
    expect(block).not.toContain("getDb");
    expect(block).not.toContain("drizzle");
  });

  it("keeps the platform invitation runtime wired to the Supabase adapter and auth sync", () => {
    const router = readFileSync(resolve(process.cwd(), "server/admin-platform-access-router.ts"), "utf8");
    const appRouter = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");
    const profile = readFileSync(resolve(process.cwd(), "server/supabase-profile.ts"), "utf8");
    expect(router).toContain("invitePlatformAccess");
    expect(router).toContain("platform_owner");
    expect(router).toContain("invitePlatformAccessSupabase");
    expect(appRouter).toContain("adminRouterWithSupabasePlatformSetting");
    expect(profile).toContain("powerhub_accept_pending_platform_invitation");
  });
});
