import { describe, expect, it } from "vitest";
import { adminRouterWithSupabasePlatformSetting } from "./admin-platform-setting-router";

const baseUser = {
  id: 10,
  openId: "test-user",
  name: "Test User",
  email: "test@example.com",
  loginMethod: "supabase",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

function caller(user: Record<string, unknown>) {
  return adminRouterWithSupabasePlatformSetting.createCaller({
    user: { ...baseUser, ...user } as never,
    req: {} as never,
    res: {} as never,
  });
}

describe("platform admin password reset guards", () => {
  it("rejects tenant users before any Supabase operation", async () => {
    await expect(caller({ role: "user", platformRole: null, accountStatus: "active" }).resetUserPassword({ userId: 12 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an administrator from resetting their own account through the user directory action", async () => {
    await expect(caller({ role: "admin", platformRole: "platform_admin", accountStatus: "active" }).resetUserPassword({ userId: 10 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects disabled platform administrators", async () => {
    await expect(caller({ role: "admin", platformRole: "platform_admin", accountStatus: "locked" }).resetUserPassword({ userId: 12 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
