import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isActivePlatformAdmin } from "./platform-admin";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "_core", "trpc.ts"), "utf8");
const legacyAdminSource = readFileSync(join(here, "admin-runtime.ts"), "utf8");
const powerhubRouterSource = readFileSync(join(here, "powerhub.ts"), "utf8");
const powerhubSupabaseSource = readFileSync(join(here, "powerhub-supabase.ts"), "utf8");
const inventoryRouterSource = readFileSync(join(here, "powerhub-inventory-router.ts"), "utf8");

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
    expect(powerhubRouterSource).toContain('"powerhub_pull_inventory_sync_delta"');
    expect(powerhubRouterSource).toContain('"powerhub_get_inventory_sync_snapshot"');
    expect(powerhubRouterSource).toContain('"inventory_items", "inventory_item_units", "suppliers", "inventory_warehouses", "inventory_stock_movements"');
  });

  it("checks the directory-specific view capability before pulling or rebuilding a snapshot", () => {
    expect(powerhubRouterSource).toContain('input.entityType === "suppliers" ? "viewSuppliers"');
    expect(powerhubRouterSource).toContain('? "viewInventory" : undefined');
    expect(powerhubRouterSource).toContain('["inventory_items", "inventory_item_units", "inventory_warehouses", "inventory_stock_movements"]');
  });
});

describe("Staff profile server-access boundary", () => {
  it("must reject archived profiles and suspended profiles in the base site resolver", () => {
    const start = powerhubSupabaseSource.indexOf("async function resolveSupabaseSiteAccessDetails");
    const end = powerhubSupabaseSource.indexOf("export async function resolveSupabaseSiteAccess(", start);
    const helper = powerhubSupabaseSource.slice(start, end);
    expect(helper).toContain('.is("archived_at", null)');
    expect(helper).toContain("isSuspended(new Date()");
  });

  it("must omit archived and suspended profiles from the accessible-site list", () => {
    const start = powerhubSupabaseSource.indexOf("export async function listSupabaseAccessibleSites");
    const end = powerhubSupabaseSource.indexOf("export async function listSupabaseSubscribers", start);
    const helper = powerhubSupabaseSource.slice(start, end);
    expect(helper).toContain('.is("archived_at", null)');
    expect(helper).toContain("isSuspended(new Date()");
  });
});

describe("All-branch staff authorization boundary", () => {
  it("must exclude archived and currently suspended global staff profiles", () => {
    const start = powerhubSupabaseSource.indexOf("export async function requireSupabaseAllBranchesRole");
    const end = powerhubSupabaseSource.indexOf("export async function listSupabaseAccessibleSites", start);
    const helper = powerhubSupabaseSource.slice(start, end);
    expect(helper).toContain('.is("archived_at", null)');
    expect(helper).toContain("suspension_started_at");
    expect(helper).toContain("suspension_ends_at");
    expect(helper).toContain("isSuspended(new Date()");
  });
});

describe("Platform role policy consistency for inventory reads", () => {
  it("uses policy-filtered capability resolution instead of the unfiltered site resolver", () => {
    expect(powerhubSupabaseSource).toContain("export async function resolveSupabaseSiteCapabilityAccess");
    expect(powerhubSupabaseSource).toContain("export async function requireSupabaseSiteAnyCapability");
    expect(powerhubSupabaseSource).toContain('.in("capability", grantedCapabilities)');
    expect(inventoryRouterSource).not.toContain("resolveSupabaseSiteAccess");
    expect(inventoryRouterSource).toContain("requireSupabaseSiteAnyCapability");
    expect(inventoryRouterSource).toContain("resolveSupabaseSiteCapabilityAccess");
  });

  it("fails closed when policy lookup errors and preserves the active platform-admin bypass", () => {
    const start = powerhubSupabaseSource.indexOf("export async function resolveSupabaseSiteCapabilityAccess");
    const end = powerhubSupabaseSource.indexOf("export async function requireSupabaseSiteAnyCapability", start);
    const resolver = powerhubSupabaseSource.slice(start, end);
    expect(resolver).toContain('if (error) {');
    expect(resolver).toContain('code: "INTERNAL_SERVER_ERROR"');
    expect(resolver).toContain("if (access.isPlatformAdmin) return { ...access, allowedCapabilities: capabilities }");
    expect(resolver).toContain("resolveSupabaseSiteAccessDetails(userId, siteId)");
  });

  it("uses policy-filtered capabilities for sensitive inventory and fuel projections", () => {
    expect(inventoryRouterSource).toContain('access.allowedCapabilities.includes("viewInventoryReports")');
    expect(inventoryRouterSource).toContain('access.allowedCapabilities.includes("viewPurchases")');
    expect(inventoryRouterSource).toContain('access.allowedCapabilities.includes("viewSupplierLedger")');
  });
});
