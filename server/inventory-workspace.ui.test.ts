import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("inventory workspace UI contract", () => {
  it("registers a protected route and a capability-gated navigation entry", () => {
    const app = read("client/src/App.tsx");
    const menu = read("client/src/components/DashboardLayout.tsx");
    const preload = read("client/src/lib/route-preload.ts");
    const runtimeRouter = read("server/powerhub-runtime-router.ts");
    const canonicalRouter = read("server/powerhub.ts");
    expect(app).toContain('const InventoryWorkspacePage = lazy(() => import("./pages/InventoryWorkspacePage"));');
    expect(app).toContain('<Route path={"/inventory"}>{() => <RouteAccessGate><InventoryWorkspacePage /></RouteAccessGate>}</Route>');
    expect(menu).toContain('label: "المخزون والمشتريات والصيانة", path: "/inventory", capability: "viewInventory"');
    expect(preload).toContain('"/inventory": () => import("../pages/InventoryWorkspacePage")');
    expect(runtimeRouter).toContain("inventory: powerhubInventoryRouter");
    expect(runtimeRouter).toContain("}) as unknown as typeof powerhubRouter;");
    expect(canonicalRouter).toContain("inventory: powerhubInventoryRouter");
  });

  it("keeps the unified workspace tabs horizontal and does not treat item definition as stock receipt", () => {
    const page = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(page).toContain('TabsTrigger value="catalog"');
    expect(page).toContain('TabsTrigger value="suppliers"');
    expect(page).toContain('TabsTrigger value="warehouses"');
    expect(page).toContain("overflow-x-auto");
    expect(page).toContain('supplierAccess.data?.permissions.includes("viewSuppliers")');
    expect(page).toContain("canViewSuppliers ? <TabsTrigger value=\"suppliers\"");
    expect(page).toContain("useBranchFilter(sites.data)");
    expect(page).toContain("المخزون والمشتريات والصيانة");
    expect(page).toContain("تعريف الصنف لا يضيف كمية إلى المخزون");
    expect(page).toContain("trpc.powerhub.inventory.createItem.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createSupplier.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createWarehouse.useMutation");
  });
});
