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
  const caller = () => adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_owner" } as never, req: {} as never, res: {} as never });
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-owner-provisioning";
    state.authCreateUser.mockReset().mockResolvedValue({ data: { user: { id: "new-auth-user" } }, error: null });
    state.authDeleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
    state.rpc.mockReset().mockResolvedValue({ data: [{ tenant_id: 101, owner_user_id: 202, site_id: 303, subscription_id: 404 }], error: null });
  });
  it("ينشئ Auth ثم يمرر المعاملة الذرية إلى Supabase", async () => {
    await expect(caller().createGeneratorOwnerSubscription(input)).resolves.toMatchObject({ tenant_id: 101, subscription_id: 404 });
    expect(state.authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ email: input.ownerEmail, email_confirm: true, password: input.temporaryPassword }));
    expect(state.rpc).toHaveBeenCalledWith("powerhub_create_generator_owner_subscription", expect.objectContaining({ p_actor_user_id: 1, p_auth_user_id: "new-auth-user", p_owner_email: input.ownerEmail, p_plan: "starter" }));
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });
  it("يحذف Auth تعويضياً إذا فشلت المعاملة", async () => {
    state.rpc.mockRejectedValueOnce(new Error("فشل إدخال الاشتراك"));
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(state.authDeleteUser).toHaveBeenCalledWith("new-auth-user");
  });
  it("يحافظ على رسالة PostgREST العربية ويحوّل تعارض التفرد إلى CONFLICT", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "رقم هاتف صاحب المولد مستخدم بالفعل.", details: null, hint: null } });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "CONFLICT", message: "رقم هاتف صاحب المولد مستخدم بالفعل." });
    expect(state.authDeleteUser).toHaveBeenCalledWith("new-auth-user");
  });
  it("يحوّل رفض صلاحية المنفذ من RPC إلى FORBIDDEN مع تعويض Auth", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "حساب المنفذ لا يملك صلاحية إنشاء صاحب مولد.", details: null, hint: null } });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.authDeleteUser).toHaveBeenCalledWith("new-auth-user");
  });
  it("لا يستدعي RPC ولا التعويض إذا فشل إنشاء Supabase Auth", async () => {
    state.authCreateUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 422, message: "User already registered" } });
    await expect(caller().createGeneratorOwnerSubscription(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.authDeleteUser).not.toHaveBeenCalled();
  });
});
