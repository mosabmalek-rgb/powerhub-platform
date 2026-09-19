import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const rpc = vi.fn();
  const authCreateUser = vi.fn();
  const authDeleteUser = vi.fn();
  const client = { auth: { admin: { createUser: authCreateUser, deleteUser: authDeleteUser } }, rpc };
  return { rpc, authCreateUser, authDeleteUser, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("إنشاء صاحب مولد عبر Supabase Auth وRPC ذري", () => {
  const input = { companyName: "مولدات الاختبار", ownerName: "مالك الاختبار", identityNumber: "12345678", ownerPhone: "0595000000", ownerWhatsapp: "0595000000", ownerEmail: "owner@example.test", temporaryPassword: "Temporary!2026", plan: "starter" as const };
  const caller = () => adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_owner", accountStatus: "active" } as never, req: {} as never, res: {} as never });
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-owner-provisioning";
    state.authCreateUser.mockReset().mockResolvedValue({ data: { user: { id: "new-auth-user" } }, error: null });
    state.authDeleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
    state.rpc.mockReset().mockImplementation(async (name: string) => name === "powerhub_admin_begin_generator_owner_provisioning" ? { data: [{ client_operation_id: "11111111-1111-4111-8111-111111111111", auth_user_id: null, status: "pending", replayed: false }], error: null } : { data: [{ success: true, tenant_id: 101, owner_user_id: 202, site_id: 303, subscription_id: 404, replayed: false }], error: null });
  });
  it("ينشئ Auth ثم يمرر المعاملة الذرية إلى Supabase", async () => {
    await expect(caller().createGeneratorOwnerSubscription({ ...input, clientOperationId: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ tenant_id: 101, subscription_id: 404 });
    expect(state.authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ email: input.ownerEmail, email_confirm: true, password: input.temporaryPassword }));
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_begin_generator_owner_provisioning", expect.objectContaining({ p_actor_user_id: 1, p_client_operation_id: "11111111-1111-4111-8111-111111111111", p_owner_email: input.ownerEmail }));
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_complete_generator_owner_provisioning", expect.objectContaining({ p_actor_user_id: 1, p_client_operation_id: "11111111-1111-4111-8111-111111111111", p_auth_user_id: "new-auth-user", p_owner_email: input.ownerEmail, p_plan: "starter", p_trial_duration_days: 8 }));
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });
  it("يعيد تأكيد provisioning المكتمل دون إنشاء مستخدم Auth جديد", async () => {
    state.rpc.mockImplementation(async (name: string) => name === "powerhub_admin_begin_generator_owner_provisioning"
      ? { data: [{ client_operation_id: "11111111-1111-4111-8111-111111111111", auth_user_id: "existing-auth-user", status: "completed", replayed: true }], error: null }
      : { data: [{ success: true, tenant_id: 101, owner_user_id: 202, site_id: 303, subscription_id: 404, replayed: true }], error: null });
    await expect(caller().createGeneratorOwnerSubscription({ ...input, clientOperationId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toMatchObject({ tenant_id: 101, subscription_id: 404, replayed: true });
    expect(state.authCreateUser).not.toHaveBeenCalled();
  });

  it("يمرر مدة تجربة مخصصة إلى المعاملة الذرية", async () => {
    await expect(caller().createGeneratorOwnerSubscription({ ...input, trialDurationDays: 21, clientOperationId: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ subscription_id: 404 });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_complete_generator_owner_provisioning", expect.objectContaining({ p_trial_duration_days: 21 }));
  });

  it.each([0, -1, 3651])("يرفض مدة تجربة غير صالحة server-side: %s", async (trialDurationDays) => {
    await expect(caller().createGeneratorOwnerSubscription({ ...input, trialDurationDays })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("يحافظ على حماية Platform Admin", async () => {
    const nonAdminCaller = adminRouter.createCaller({ user: { id: 2, role: "user", platformRole: null } as never, req: {} as never, res: {} as never });
    await expect(nonAdminCaller.createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("لا يحذف Auth عند فشل الإكمال، لأن نفس العملية قابلة للاستكمال", async () => {
    state.rpc.mockImplementation(async (name: string) => name === "powerhub_admin_begin_generator_owner_provisioning" ? { data: [{ client_operation_id: "11111111-1111-4111-8111-111111111111", auth_user_id: null, status: "pending", replayed: false }], error: null } : { data: null, error: { message: "فشل إدخال الاشتراك" } });
    await expect(caller().createGeneratorOwnerSubscription({ ...input, clientOperationId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });
});
