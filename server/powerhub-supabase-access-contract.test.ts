import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isActivePlatformAdmin } from "./platform-admin";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "_core", "trpc.ts"), "utf8");
const legacyAdminSource = readFileSync(join(here, "admin-runtime.ts"), "utf8");
const powerhubRouterSource = readFileSync(join(here, "powerhub.ts"), "utf8");

describe("Platform-admin authorization boundary", () => {
  it("must require active account status and an allowed platform role", () => {
    expect(source).toContain("isActivePlatformAdmin");
    expect(isActivePlatformAdmin({ role: "admin", accountStatus: "active", platformRole: "platform_owner" })).toBe(true);
    expect(isActivePlatformAdmin({ role: "admin", accountStatus: "locked", platformRole: "platform_owner" })).toBe(false);
    expect(isActivePlatformAdmin({ role: "admin", accountStatus: "active", platformRole: null })).toBe(false);
  });

  it("must reject an invalid admin before protected tenant runtime access", () => {
    expect(source).toContain("!isActivePlatformIdentity(user)");
    expect(source).toContain('throw new TRPCError({ code: "FORBIDDEN"');
  });

  it("must use the same active platform identity boundary for adminProcedure", () => {
    expect(source).toContain("if (!isActivePlatformAdmin(ctx.user))");
  });

  it("must not default a missing platform role to platform_admin in legacy admin procedures", () => {
    expect(legacyAdminSource).not.toContain('ctx.user.platformRole ?? "platform_admin"');
    expect(legacyAdminSource).toContain("!role || !allowedRoles.includes(role as PlatformRole)");
  });
});

describe("Inventory catalog Delta authorization boundary", () => {
  it("routes catalog snapshots through the dedicated server-only RPCs", () => {
    expect(powerhubRouterSource).toContain('"powerhub_pull_inventory_catalog_sync_delta"');
    expect(powerhubRouterSource).toContain('"powerhub_get_inventory_catalog_sync_snapshot"');
    expect(powerhubRouterSource).toContain('"inventory_items", "inventory_item_units", "suppliers", "inventory_warehouses"');
  });

  it("checks the directory-specific view capability before pulling or rebuilding a snapshot", () => {
    expect(powerhubRouterSource).toContain('input.entityType === "suppliers" ? "viewSuppliers"');
    expect(powerhubRouterSource).toContain('? "viewInventory" : undefined');
    expect(powerhubRouterSource).toContain('["inventory_items", "inventory_item_units", "inventory_warehouses"]');
  });
});
