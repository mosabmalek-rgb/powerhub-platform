import { describe, expect, it } from "vitest";
import { mapSupabaseProfile } from "./supabase-profile";

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
});
