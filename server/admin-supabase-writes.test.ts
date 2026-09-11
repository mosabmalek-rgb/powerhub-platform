import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");

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

  it("maps subscription updates to the atomic Supabase RPC", async () => {
    rpc.mockResolvedValueOnce({ data: [{ success: true, subscription_id: 9, site_id: 5 }], error: null });
    const { updateSubscription } = await import("./admin-supabase-writes");
    const endsAt = new Date("2027-01-01T00:00:00.000Z");
    await expect(updateSubscription({ actorUserId: 1, tenantId: 6, plan: "professional", status: "active", billingCycle: "monthly", endsAt, autoRenew: true, notes: "qa", smsPlanId: null })).resolves.toEqual({ success: true, subscriptionId: 9, siteId: 5 });
    expect(rpc).toHaveBeenCalledWith("powerhub_admin_update_subscription", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 6, p_plan: "professional", p_status: "active", p_billing_cycle: "monthly", p_ends_at: endsAt.toISOString(), p_auto_renew: true, p_sms_plan_id: null }));
  });

  it("normalizes unexpected Supabase errors without exposing database details", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "unexpected database detail" } });
    const { setTenantMembershipStatus } = await import("./admin-supabase-writes");
    await expect(setTenantMembershipStatus({ actorUserId: 1, tenantId: 6, userId: 13, status: "active" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تنفيذ العملية في Supabase." });
  });
});
