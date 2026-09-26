import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dashboardMigration = readFileSync(resolve(root, "supabase/migrations/20260926123000_powerhub_advanced_dashboard_synchronization.sql"), "utf8");
const dashboardPage = readFileSync(resolve(root, "client/src/pages/AdminAdvancedWorkspace.tsx"), "utf8");
const adminConsole = readFileSync(resolve(root, "client/src/pages/AdminConsolePage.tsx"), "utf8");
const runtimeReads = readFileSync(resolve(root, "server/admin-runtime-reads.ts"), "utf8");

describe("platform-owner dashboard synchronization contract", () => {
  it("keeps the dashboard read model complete and bounded to trustworthy records", () => {
    expect(dashboardMigration).toContain("generate_series");
    expect(dashboardMigration).toContain("interval '1 month'");
    expect(dashboardMigration).toContain("payments.status='completed'");
    expect(dashboardMigration).toContain("generatorId");
    expect(dashboardMigration).toContain("subscriptions.ends_at>=now()");
    expect(dashboardMigration).toContain("subscriptions.archived_at is null");
  });

  it("keeps manual and automatic refresh paths synchronized", () => {
    expect(adminConsole).toContain("utils.admin.advancedDashboard.invalidate()");
    expect(adminConsole).toContain("utils.admin.operationalMonitoring.invalidate()");
    expect(adminConsole).toContain("utils.admin.listTenantBranchSettings.invalidate()");
    expect(adminConsole).toContain("utils.admin.platformConfiguration.invalidate()");
    expect(dashboardPage).toContain("refetchInterval: DASHBOARD_REFRESH_MS");
    expect(dashboardPage).toContain("const DASHBOARD_REFRESH_MS = 30_000;");
  });

  it("keeps operational health aligned with the four rendered domains", () => {
    expect(runtimeReads).toContain('key: "database"');
    expect(runtimeReads).toContain('key: "messaging"');
    expect(runtimeReads).toContain('key: "sync"');
    expect(runtimeReads).toContain('key: "security"');
    expect(runtimeReads).toContain('target: "field_sync"');
  });
});
