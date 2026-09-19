import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");
const reviewMigration = readFileSync(join(process.cwd(), "supabase/migrations/20260911202000_powerhub_admin_review_subscription_upgrade_request_rpc.sql"), "utf8");
const retryMigration = readFileSync(join(process.cwd(), "supabase/migrations/20260919150000_harden_subscription_upgrade_review_idempotency.sql"), "utf8");

const rpc = vi.fn();
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

describe("Supabase atomic admin write RPCs", () => {
  it("defines the three atomic RPCs and their security contract", () => {
    for (const name of [
      "powerhub_admin_set_tenant_membership_status",
      "powerhub_admin_attach_owner_user",
      "powerhub_admin_update_subscription",
    ]) {
      expect(migration).toContain(name);
    }
    expect((migration.match(/security definer/g) ?? []).length).toBe(3);
    expect((migration.match(/set search_path = public, pg_temp/g) ?? []).length).toBe(3);
    expect(migration).toContain("revoke all on function public.powerhub_admin_set_tenant_membership_status");
    expect(migration).toContain("revoke all on function public.powerhub_admin_attach_owner_user");
    expect(migration).toContain("revoke all on function public.powerhub_admin_update_subscription");
  });

  it("maps membership status writes to the atomic Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, membership_id: 7, site_id: 5, status: "suspended" }], error: null });
    const { setTenantMembershipStatus } = await import("./admin-supabase-writes");
    await expect(setTenantMembershipStatus({ actorUserId: 1, tenantId: 6, userId: 13, status: "suspended" })).resolves.toMatchObject({ success: true, membershipId: 7, siteId: 5 });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_set_tenant_membership_status", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_user_id: 13, p_status: "suspended" }));
  });

  it("maps owner attachment to the atomic Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, site_id: 5 }], error: null });
    const { attachOwnerUser } = await import("./admin-supabase-writes");
    await expect(attachOwnerUser({ actorUserId: 1, tenantId: 6, userId: 13, siteId: 5 })).resolves.toEqual({ success: true, siteId: 5 });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_attach_owner_user", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_user_id: 13, p_site_id: 5 }));
  });

  it("maps quick owner upgrade to the retry-safe Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, plan: "professional", replayed: true }], error: null });
    const { quickUpgradeOwnerPlan } = await import("./admin-supabase-writes");
    await expect(quickUpgradeOwnerPlan({ actorUserId: 1, tenantId: 6, plan: "professional", note: "qa", clientOperationId: "00000000-0000-4000-8000-000000000003" })).resolves.toEqual({ success: true, plan: "professional", replayed: true });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_quick_upgrade_owner_plan_idempotent", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_plan: "professional", p_client_operation_id: "00000000-0000-4000-8000-000000000003" }));
  });

  it("maps subscription updates to the retry-safe Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, subscription_id: 9, site_id: 5, replayed: false }], error: null });
    const { updateSubscription } = await import("./admin-supabase-writes");
    const endsAt = new Date("2027-01-01T00:00:00.000Z");
    await expect(updateSubscription({ actorUserId: 1, tenantId: 6, plan: "professional", status: "active", billingCycle: "monthly", endsAt, autoRenew: true, notes: "qa", smsPlanId: null, clientOperationId: "00000000-0000-4000-8000-000000000001" })).resolves.toEqual({ success: true, subscriptionId: 9, siteId: 5, replayed: false });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_update_subscription_idempotent", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_client_operation_id: "00000000-0000-4000-8000-000000000001" }));
  });

  it("maps subscription renewal to the retry-safe Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, ends_at: "2027-02-01T00:00:00.000Z", replayed: true }], error: null });
    const { renewSubscription } = await import("./admin-supabase-writes");
    await expect(renewSubscription({ actorUserId: 1, tenantId: 6, periods: 1, clientOperationId: "00000000-0000-4000-8000-000000000002" })).resolves.toMatchObject({ success: true, replayed: true });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_renew_subscription_idempotent", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_periods: 1, p_client_operation_id: "00000000-0000-4000-8000-000000000002" }));
  });

  it("keeps the subscription retry contract explicit", () => {
    expect(retryMigration).toContain("subscription_upgrade_review");
  });

  it("rejects a false-success membership result", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: false, membership_id: 7, site_id: 5, status: "active" }], error: null });
    const { setTenantMembershipStatus } = await import("./admin-supabase-writes");
    await expect(setTenantMembershipStatus({ actorUserId: 1, tenantId: 6, userId: 13, status: "active" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects a false-success owner attachment result", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: false, site_id: 5 }], error: null });
    const { attachOwnerUser } = await import("./admin-supabase-writes");
    await expect(attachOwnerUser({ actorUserId: 1, tenantId: 6, userId: 13, siteId: 5 })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects a false-success subscription review result", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: false, plan: "professional" }], error: null });
    const { reviewSubscriptionUpgradeRequest } = await import("./admin-supabase-writes");
    await expect(reviewSubscriptionUpgradeRequest({ actorUserId: 1, requestId: 90, decision: "approved" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects a false-success SMS package review result", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: false, tenant_id: 6, site_id: 5, status: "approved", approved_messages: 1000 }], error: null });
    const { reviewSmsPackageRequest } = await import("./admin-supabase-writes");
    await expect(reviewSmsPackageRequest({ actorUserId: 1, requestId: 90, status: "approved", approvedMessages: 1000 })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("normalizes unexpected Supabase errors without exposing database details", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "unexpected database detail" } });
    const { setTenantMembershipStatus } = await import("./admin-supabase-writes");
    await expect(setTenantMembershipStatus({ actorUserId: 1, tenantId: 6, userId: 13, status: "active" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ العملية في Supabase." });
  });

  it("defines the review RPC security contract", () => {
    expect(reviewMigration).toContain("security definer");
    expect(reviewMigration).toContain("set search_path = public, pg_temp");
    expect(reviewMigration).toContain("revoke all on function public.powerhub_admin_review_subscription_upgrade_request");
    expect(reviewMigration).toContain("grant execute on function public.powerhub_admin_review_subscription_upgrade_request");
    expect(reviewMigration).toContain("to service_role");
    expect(reviewMigration).toContain("from public, anon, authenticated");
  });

  it("maps subscription-upgrade reviews to the atomic Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, plan: "professional" }], error: null });
    const { reviewSubscriptionUpgradeRequest } = await import("./admin-supabase-writes");
    await expect(reviewSubscriptionUpgradeRequest({ actorUserId: 1, requestId: 90, decision: "approved", note: "approved by qa" })).resolves.toEqual({ success: true, plan: "professional" });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_review_subscription_upgrade_request", expect.objectContaining({ p_actor_user_id: 1, p_request_id: 90, p_decision: "approved", p_note: "approved by qa" }));
  });

  it("normalizes already-processed review errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "REQUEST_ALREADY_PROCESSED" } });
    const { reviewSubscriptionUpgradeRequest } = await import("./admin-supabase-writes");
    await expect(reviewSubscriptionUpgradeRequest({ actorUserId: 1, requestId: 90, decision: "approved" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
