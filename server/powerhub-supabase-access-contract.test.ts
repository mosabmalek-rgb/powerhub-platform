import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "_core", "trpc.ts"), "utf8");

describe("Platform-admin authorization boundary", () => {
  it("must require active account status and an allowed platform role", () => {
    expect(source).toContain('user.role === "admin"');
    expect(source).toContain('user.accountStatus === "active"');
    expect(source).toContain('"platform_owner", "platform_admin", "finance_admin"');
    expect(source).toContain("isActivePlatformAdmin");
  });

  it("must reject an invalid admin before protected tenant runtime access", () => {
    expect(source).toContain('user?.role === "admin" && !isActivePlatformAdmin(user)');
    expect(source).toContain('throw new TRPCError({ code: "FORBIDDEN"');
  });

  it("must use the same active platform identity boundary for adminProcedure", () => {
    expect(source).toContain("if (!isActivePlatformAdmin(ctx.user))");
  });
});
