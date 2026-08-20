import { describe, expect, it } from "vitest";
import { authenticatedHomePath } from "./role-routing";

describe("authenticatedHomePath", () => {
  it("routes a platform owner and platform admin to the full admin center", () => {
    expect(authenticatedHomePath({ role: "admin", platformRole: "platform_owner" })).toBe("/admin");
    expect(authenticatedHomePath({ role: "admin", platformRole: "platform_admin" })).toBe("/admin");
    expect(authenticatedHomePath({ role: "admin", platformRole: null })).toBe("/admin");
  });

  it("routes a finance admin to the limited finance center and generator users to their workspace", () => {
    expect(authenticatedHomePath({ role: "admin", platformRole: "finance_admin" })).toBe("/finance-admin");
    expect(authenticatedHomePath({ role: "user" })).toBe("/workspace");
  });
});
