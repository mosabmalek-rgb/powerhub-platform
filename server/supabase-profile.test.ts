import { describe, expect, it, vi } from "vitest";
import { mapSupabaseProfile, syncSupabaseProfile } from "./supabase-profile";

const state = vi.hoisted(() => ({
  upsert: vi.fn(),
  update: vi.fn(),
  lookup: vi.fn(async () => ({ data: null, error: null })),
  rpc: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: state.lookup }) }),
      upsert: state.upsert,
      update: state.update,
    }),
    rpc: state.rpc,
  }),
}));

describe("ملف مستخدم Supabase", () => {
  it("يحوّل أسماء أعمدة Supabase إلى عقد المستخدم الذي يستهلكه الخادم", () => {
    const user = mapSupabaseProfile({
      id: "7",
      auth_user_id: "ea9b9451-9e4a-45b5-be19-688c7ab7ccc7",
      name: "مالك المنصة",
      email: "owner@example.com",
      login_method: "supabase",
      role: "admin",
      platform_role: "platform_owner",
      account_status: "active",
      must_change_password: false,
      temporary_password_issued_at: null,
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:01:00.000Z",
      last_signed_in: "2026-08-25T00:02:00.000Z",
    });
    expect(user).toMatchObject({ id: 7, openId: "ea9b9451-9e4a-45b5-be19-688c7ab7ccc7", role: "admin", platformRole: "platform_owner" });
    expect(user.lastSignedIn).toBeInstanceOf(Date);
  });

  it("does not block authentication when optional invitation RPCs are missing", async () => {
    const profile = {
      id: 42,
      auth_user_id: "auth-user-42",
      name: "User",
      email: "user@example.com",
      login_method: "supabase",
      role: "user" as const,
      platform_role: null,
      account_status: "active" as const,
      must_change_password: false,
      temporary_password_issued_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_signed_in: "2026-01-01T00:00:00.000Z",
    };
    state.lookup.mockResolvedValue({ data: null, error: null });
    state.upsert.mockReturnValue({ select: () => ({ single: async () => ({ data: profile, error: null }) }) });
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the public.powerhub_accept_pending_platform_invitation() function in the schema cache" } });

    await expect(syncSupabaseProfile({ id: "auth-user-42", email: "USER@example.com", name: "User" })).resolves.toMatchObject({
      id: 42,
      openId: "auth-user-42",
      accountStatus: "active",
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps PostgreSQL undefined-function compatibility as a supported missing-RPC condition", async () => {
    const profile = {
      id: 43,
      auth_user_id: "auth-user-43",
      name: "User",
      email: "user43@example.com",
      login_method: "supabase",
      role: "user" as const,
      platform_role: null,
      account_status: "active" as const,
      must_change_password: false,
      temporary_password_issued_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_signed_in: "2026-01-01T00:00:00.000Z",
    };
    state.upsert.mockReturnValue({ select: () => ({ single: async () => ({ data: profile, error: null }) }) });
    state.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });

    await expect(syncSupabaseProfile({ id: "auth-user-43", email: "user43@example.com", name: "User" })).resolves.toMatchObject({ id: 43 });
  });

  it("still surfaces invitation RPC failures other than missing-function compatibility gaps", async () => {
    const profile = {
      id: 42,
      auth_user_id: "auth-user-42",
      name: "User",
      email: "user@example.com",
      login_method: "supabase",
      role: "user" as const,
      platform_role: null,
      account_status: "active" as const,
      must_change_password: false,
      temporary_password_issued_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      last_signed_in: "2026-01-01T00:00:00.000Z",
    };
    state.upsert.mockReturnValue({ select: () => ({ single: async () => ({ data: profile, error: null }) }) });
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });

    await expect(syncSupabaseProfile({ id: "auth-user-42", email: "user@example.com", name: "User" })).rejects.toThrow("permission denied");
  });
});
