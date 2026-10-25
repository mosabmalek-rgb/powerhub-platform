import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const rpc = vi.fn();
  const authCreateUser = vi.fn();
  const authDeleteUser = vi.fn();
  const authListUsers = vi.fn();
  const client = { auth: { admin: { createUser: authCreateUser, deleteUser: authDeleteUser, listUsers: authListUsers } }, rpc };
  return { rpc, authCreateUser, authDeleteUser, authListUsers, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("إنشاء صاحب مولد عبر دورة provisioning قابلة لإعادة المحاولة", () => {
  const input = {
    clientOperationId: "a6d2ad77-3dee-4ba8-9c0c-9480d8741a36",
    companyName: "مولدات الاختبار", ownerName: "مالك الاختبار", identityNumber: "12345678",
    ownerPhone: "0595000000", ownerWhatsapp: "0595000000", ownerEmail: "owner@example.test",
    temporaryPassword: "Temporary!2026", packageCode: "basic" as const,
  };
  const caller = () => adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_owner", accountStatus: "active" } as never, req: {} as never, res: {} as never });
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-owner-provisioning";
    state.authCreateUser.mockReset().mockResolvedValue({ data: { user: { id: "new-auth-user" } }, error: null });
    state.authDeleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
    state.authListUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
    state.rpc.mockReset().mockImplementation(async (name: string) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, tenant_id: null,
        owner_user_id: null, site_id: null, subscription_id: null, replayed: false,
        can_create_auth: true, needs_reconciliation: false,
      }], error: null };
      if (name === "powerhub_admin_attach_generator_owner_provisioning_auth") return { data: [{ attached: true, auth_user_id: "new-auth-user" }], error: null };
      if (name === "powerhub_admin_complete_generator_owner_provisioning") return { data: [{
        success: true, tenant_id: 101, owner_user_id: 202, site_id: 303, subscription_id: 404, replayed: false,
      }], error: null };
      if (name === "powerhub_admin_cancel_generator_owner_provisioning") return { data: [{ cancelled: true }], error: null };
      return { data: null, error: { message: "Unexpected RPC", code: "42883" } };
    });
  });

  it("يرفض المصالحة إذا لم يوجد حساب يحمل علامة العملية الدقيقة ولا ينشئ حسابًا جديدًا", async () => {
    state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, replayed: false,
        can_create_auth: false, needs_reconciliation: true,
      }], error: null };
      if (name === "powerhub_admin_get_generator_owner_provisioning_reconciliation") return { data: [{
        operation_status: "pending", owner_email: input.ownerEmail, auth_creation_started_at: "2026-10-25T12:00:00Z",
        auth_user_id: null, request_fingerprint: args.p_request_fingerprint,
      }], error: null };
      return { data: null, error: { message: "Unexpected RPC", code: "42883" } };
    });
    state.authListUsers.mockResolvedValue({ data: { users: [{
      id: "unrelated-auth-user", email: input.ownerEmail,
      app_metadata: { unrelated: true },
    }] }, error: null });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("powerhub_admin_attach_generator_owner_provisioning_auth", expect.anything());
  });

  it("يستعيد حساب Auth الذي أنشأته العملية نفسها بعد انقطاع الاستجابة دون إنشاء حساب ثانٍ", async () => {
    let expectedFingerprint = "";
    state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") {
        expectedFingerprint = String(args.p_request_fingerprint);
      }
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, tenant_id: null,
        owner_user_id: null, site_id: null, subscription_id: null, replayed: false,
        can_create_auth: false, needs_reconciliation: true,
      }], error: null };
      if (name === "powerhub_admin_get_generator_owner_provisioning_reconciliation") return { data: [{
        operation_status: "pending", owner_email: input.ownerEmail, auth_creation_started_at: "2026-10-25T12:00:00Z",
        auth_user_id: null, request_fingerprint: expectedFingerprint,
      }], error: null };
      if (name === "powerhub_admin_attach_generator_owner_provisioning_auth") return { data: [{ attached: true, auth_user_id: "recovered-auth-user" }], error: null };
      if (name === "powerhub_admin_complete_generator_owner_provisioning") return { data: [{
        success: true, tenant_id: 101, owner_user_id: 202, site_id: 303, subscription_id: 404, replayed: false,
      }], error: null };
      return { data: null, error: { message: "Unexpected RPC", code: "42883" } };
    });
    state.authListUsers.mockImplementation(async () => ({ data: { users: [{
      id: "recovered-auth-user", email: input.ownerEmail,
      app_metadata: {
        powerhub_owner_provisioning_operation_id: input.clientOperationId,
        powerhub_owner_provisioning_fingerprint: expectedFingerprint,
      },
    }] }, error: null }));
    await expect(caller().createGeneratorOwnerSubscription(input)).resolves.toMatchObject({ tenant_id: 101, subscription_id: 404 });
    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.authListUsers).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_attach_generator_owner_provisioning_auth", expect.objectContaining({
      p_client_operation_id: input.clientOperationId, p_auth_user_id: "recovered-auth-user",
    }));
  });

  it("يحجز العملية ثم ينشئ Auth ويربطه ويكمل معاملة قاعدة البيانات", async () => {
    await expect(caller().createGeneratorOwnerSubscription(input)).resolves.toMatchObject({ tenant_id: 101, subscription_id: 404 });
    expect(state.rpc).toHaveBeenNthCalledWith(1, "powerhub_admin_begin_generator_owner_provisioning", expect.objectContaining({
      p_actor_user_id: 1, p_client_operation_id: input.clientOperationId, p_owner_email: input.ownerEmail,
      p_request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(state.authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ email: input.ownerEmail, email_confirm: true, password: input.temporaryPassword }));
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_attach_generator_owner_provisioning_auth", expect.objectContaining({ p_auth_user_id: "new-auth-user" }));
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_complete_generator_owner_provisioning", expect.objectContaining({
      p_actor_user_id: 1, p_auth_user_id: "new-auth-user", p_package_code: "basic",
    }));
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });

  it("يمرر مدة تجربة مخصصة إلى المعاملة الذرية", async () => {
    await expect(caller().createGeneratorOwnerSubscription({ ...input, trialEnabled: true, trialDurationDays: 21 })).resolves.toMatchObject({ subscription_id: 404 });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_complete_generator_owner_provisioning", expect.objectContaining({
      p_trial_duration_days: 21, p_subscription_status: "trial",
    }));
  });

  it.each([0, -1, 3651])("يرفض مدة تجربة غير صالحة server-side: %s", async (trialDurationDays) => {
    await expect(caller().createGeneratorOwnerSubscription({ ...input, trialEnabled: true, trialDurationDays })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("يحافظ على حماية Platform Admin", async () => {
    const nonAdminCaller = adminRouter.createCaller({ user: { id: 2, role: "user", platformRole: null } as never, req: {} as never, res: {} as never });
    await expect(nonAdminCaller.createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يعيد نتيجة مكتملة من سجل العملية دون إنشاء حساب جديد", async () => {
    state.rpc.mockImplementationOnce(async () => ({ data: [{
      operation_status: "completed", auth_user_id: "existing-auth-user", success: true,
      tenant_id: 111, owner_user_id: 222, site_id: 333, subscription_id: 444,
      replayed: true, can_create_auth: false, needs_reconciliation: false,
    }], error: null }));
    await expect(caller().createGeneratorOwnerSubscription(input)).resolves.toMatchObject({ tenant_id: 111, subscription_id: 444, replayed: true });
    expect(state.authCreateUser).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("يرفض إعادة المحاولة الآلية إذا كانت نتيجة إنشاء Auth غير محسومة", async () => {
    state.rpc.mockImplementationOnce(async () => ({ data: [{
      operation_status: "pending", auth_user_id: null, success: false, tenant_id: null,
      owner_user_id: null, site_id: null, subscription_id: null, replayed: false,
      can_create_auth: false, needs_reconciliation: true,
    }], error: null }));
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.authCreateUser).not.toHaveBeenCalled();
  });

  it("يعوّض حساب Auth عند رفض SQL مؤكد ويحرر سجل العملية بعد نجاح التعويض", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, can_create_auth: true, needs_reconciliation: false,
      }], error: null };
      if (name === "powerhub_admin_attach_generator_owner_provisioning_auth") return { data: [{ attached: true }], error: null };
      if (name === "powerhub_admin_complete_generator_owner_provisioning") return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (name === "powerhub_admin_cancel_generator_owner_provisioning") return { data: [{ cancelled: true }], error: null };
      return { data: null, error: null };
    });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_cancel_generator_owner_provisioning", expect.objectContaining({ p_auth_user_id: "new-auth-user" }));
    expect(state.authDeleteUser).toHaveBeenCalledWith("new-auth-user");
    expect(state.rpc.mock.invocationCallOrder[3]).toBeLessThan(state.authDeleteUser.mock.invocationCallOrder[0]);
  });

  it("لا يبلغ عن تعارض البريد إذا لم يتأكد إلغاء العملية بعد رفض Auth", async () => {
    state.authCreateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, message: "already registered" } });
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, can_create_auth: true, needs_reconciliation: false,
      }], error: null };
      if (name === "powerhub_admin_cancel_generator_owner_provisioning") return { data: [{ cancelled: false }], error: null };
      return { data: null, error: null };
    });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.authCreateUser).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_cancel_generator_owner_provisioning", expect.objectContaining({
      p_client_operation_id: input.clientOperationId, p_auth_user_id: null,
    }));
  });

  it("لا يحذف Auth إذا فشل إغلاق سجل العملية بعد رفض SQL", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, can_create_auth: true, needs_reconciliation: false,
      }], error: null };
      if (name === "powerhub_admin_attach_generator_owner_provisioning_auth") return { data: [{ attached: true }], error: null };
      if (name === "powerhub_admin_complete_generator_owner_provisioning") return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (name === "powerhub_admin_cancel_generator_owner_provisioning") return { data: [{ cancelled: false }], error: null };
      return { data: null, error: null };
    });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });

  it("لا يحذف Auth عند غموض نتيجة RPC لأن المعاملة قد تكون اكتملت", async () => {
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "powerhub_admin_begin_generator_owner_provisioning") return { data: [{
        operation_status: "pending", auth_user_id: null, success: false, can_create_auth: true, needs_reconciliation: false,
      }], error: null };
      if (name === "powerhub_admin_attach_generator_owner_provisioning_auth") return { data: [{ attached: true }], error: null };
      if (name === "powerhub_admin_complete_generator_owner_provisioning") throw new Error("socket hang up");
      return { data: null, error: null };
    });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });
});
