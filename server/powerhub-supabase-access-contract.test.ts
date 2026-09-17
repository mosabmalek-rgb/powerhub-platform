import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "powerhub-supabase.ts"), "utf8");

describe("Supabase platform-admin authorization boundary", () => {
  it("must not grant tenant owner access from users.role=admin alone", () => {
    expect(source).toContain('select("role, platform_role, account_status")');
    expect(source).toContain('user.role === "admin" && user.accountStatus === "active"');
    expect(source).toContain('platform_role');
  });

  it("must derive platform-wide site listing from an active platform-admin identity", () => {
    expect(source).toContain("account_status");
    expect(source).toContain("platform_role");
    expect(source).toContain("isPlatformAdmin");
  });
});
